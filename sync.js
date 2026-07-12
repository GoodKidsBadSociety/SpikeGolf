/* ============================================================
   Spikegolf sync layer — Supabase realtime, per-record + outbox
   ------------------------------------------------------------
   • Reads config.js which exports SUPABASE_URL + SUPABASE_ANON_KEY.
     If either is empty the sync layer stays disabled and the app
     runs local-only (identical to the pre-cloud experience).
   • Uses anonymous auth so no one has to sign up.
   • State is stored as many small rows in table `app_kv`
     (k text primary key, v jsonb, updated_at timestamptz) instead
     of one giant blob. Each device writes only the keys it changed
     and subscribes to per-row changes, so simultaneous edits to
     different records no longer clobber each other. Conflict
     resolution is last-writer-wins PER KEY (much finer than before).
   • Durability: every change lands first in a persistent OUTBOX
     (localStorage). Flushes are idempotent upserts/deletes; on
     failure the outbox is kept and retried with backoff, and again
     whenever the network comes back ('online'). Offline scores are
     no longer lost.
   • Requires the `app_kv` table + realtime (see SUPABASE_SETUP.md).
     If the table is missing the layer degrades to local-only.
   • For a one-time migration it also reads the old single-row
     `app_state` table and hands its blob back as `legacy`.
   ============================================================ */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const TABLE = 'app_kv';
const LEGACY_TABLE = 'app_state';
const LEGACY_ROW_ID = 'main';
const WRITE_DEBOUNCE_MS = 400;
const RETRY_MAX_MS = 30000;
const ECHO_TTL_MS = 6000;
const OUTBOX_KEY = 'spikegolf.outbox';

let client = null;
let onChange = null;
let ready = false;

// Persistent outbox: the source of truth for "what still needs to
// reach the cloud". Survives reloads/crashes so nothing is lost.
let outbox = { puts: {}, dels: [] }; // puts: {key:value}, dels: [key]
let flushTimer = null;
let retryDelay = 0;
loadOutbox();

// Echo guard: keys we just wrote, so realtime doesn't feed our own
// writes back into the app as if they were remote.
const recentWrites = new Map(); // key -> { json, at }

export function syncEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
export function isReady() { return ready; }

/**
 * Initialise the sync layer.
 * @param {(key:string, value:any|null)=>void} applyChange
 *        called for every remote per-record change (null = deleted).
 * @returns {Promise<{enabled:boolean, rows:Object|null, legacy:Object|null}>}
 *          rows = full KV snapshot from the DB (null if unreachable),
 *          legacy = old single-blob state if present and rows empty.
 */
export async function initSync({ applyChange }) {
  if (!syncEnabled()) return { enabled: false, rows: null, legacy: null };
  onChange = applyChange;

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: window.localStorage,
      storageKey: 'spikegolf.auth',
    },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  // Reuse existing session or sign in anonymously.
  try {
    const { data: { session: existing } } = await client.auth.getSession();
    if (!existing) {
      const { error } = await client.auth.signInAnonymously();
      if (error) { console.warn('sync auth failed', error); return { enabled: false, rows: null, legacy: null }; }
    }
  } catch (e) {
    console.warn('sync auth threw', e);
    return { enabled: false, rows: null, legacy: null };
  }

  // Fetch the full KV snapshot. A missing table (undefined_table) ⇒
  // degrade to local-only rather than crash.
  let rows = {};
  try {
    const { data, error } = await client.from(TABLE).select('k, v');
    if (error) {
      console.warn('sync initial fetch failed', error);
      return { enabled: false, rows: null, legacy: null };
    }
    (data || []).forEach(r => { rows[r.k] = r.v; });
  } catch (e) {
    console.warn('sync initial fetch threw', e);
    return { enabled: false, rows: null, legacy: null };
  }

  // One-time migration hook: if the new table is empty, offer the old blob.
  let legacy = null;
  if (!Object.keys(rows).length) {
    try {
      const { data } = await client.from(LEGACY_TABLE)
        .select('data').eq('id', LEGACY_ROW_ID).maybeSingle();
      if (data && data.data) legacy = data.data;
    } catch (_) { /* legacy table may not exist — fine */ }
  }

  // Subscribe to per-row realtime changes. On (re)subscribe, drain the
  // outbox — this doubles as reconnect-replay.
  client
    .channel('app_kv:all')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: TABLE },
      (payload) => {
        const type = payload.eventType;
        if (type === 'DELETE') {
          const k = payload.old && payload.old.k;
          if (k && !isEcho(k, null)) onChange && onChange(k, null);
        } else {
          const row = payload.new;
          if (row && row.k && !isEcho(row.k, row.v)) onChange && onChange(row.k, row.v);
        }
      })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') scheduleFlush(0);
    });

  ready = true;

  // Retry pending writes when the network returns, and try now for
  // anything left over from a previous session / pre-init edits.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => scheduleFlush(0));
  }
  scheduleFlush(0);

  return { enabled: true, rows, legacy };
}

/**
 * Queue per-record changes into the durable outbox.
 * @param {{puts:Object, dels:string[]}} delta
 */
export function pushChanges(delta) {
  if (!delta) return;
  const { puts = {}, dels = [] } = delta;
  for (const k of Object.keys(puts)) {
    outbox.puts[k] = puts[k];
    removeFrom(outbox.dels, k);
  }
  for (const k of dels) {
    delete outbox.puts[k];
    if (!outbox.dels.includes(k)) outbox.dels.push(k);
  }
  persistOutbox();
  scheduleFlush(WRITE_DEBOUNCE_MS);
}

/**
 * Flush the outbox to Supabase. Idempotent: safe to call any time.
 * Stays buffered (and retries) until it succeeds, so offline edits
 * survive. Exported so the app can force a flush on suspend/unload.
 */
export async function flushChanges() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!ready || !client) return; // stay buffered until sync is up

  const putKeys = Object.keys(outbox.puts);
  const dels = outbox.dels.slice();
  if (!putKeys.length && !dels.length) return;

  // Snapshot exactly what we attempt, so edits that arrive mid-flight
  // aren't dropped when we prune on success.
  const sentPuts = {};
  putKeys.forEach(k => { sentPuts[k] = outbox.puts[k]; });

  const stamp = isoNow();
  let ok = true;
  try {
    if (putKeys.length) {
      const records = putKeys.map(k => { markWrite(k, sentPuts[k]); return { k, v: sentPuts[k], updated_at: stamp }; });
      const { error } = await client.from(TABLE).upsert(records, { onConflict: 'k' });
      if (error) { ok = false; console.warn('sync upsert failed', error); }
    }
    if (ok && dels.length) {
      dels.forEach(k => markWrite(k, null));
      const { error } = await client.from(TABLE).delete().in('k', dels);
      if (error) { ok = false; console.warn('sync delete failed', error); }
    }
  } catch (e) {
    ok = false;
    console.warn('sync flush threw', e);
  }

  if (ok) {
    // Prune only what we actually sent and that hasn't changed since.
    for (const k of putKeys) {
      if (jeq(outbox.puts[k], sentPuts[k])) delete outbox.puts[k];
    }
    outbox.dels = outbox.dels.filter(k => !dels.includes(k));
    persistOutbox();
    retryDelay = 0;
    if (Object.keys(outbox.puts).length || outbox.dels.length) scheduleFlush(WRITE_DEBOUNCE_MS);
  } else {
    // Keep everything; back off and retry (also retried on 'online').
    persistOutbox();
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 2000, RETRY_MAX_MS);
    scheduleFlush(retryDelay);
  }
}

/* ---------------- outbox persistence ---------------- */

function loadOutbox() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(OUTBOX_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      outbox = { puts: (o && o.puts) || {}, dels: (o && Array.isArray(o.dels)) ? o.dels : [] };
    }
  } catch (_) { /* corrupt outbox — start clean */ }
}
function persistOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (_) {}
}
function scheduleFlush(delayMs) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushChanges, delayMs != null ? delayMs : WRITE_DEBOUNCE_MS);
}
function removeFrom(arr, k) { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); }

/* ---------------- echo guard ---------------- */

function markWrite(key, value) {
  recentWrites.set(key, { json: JSON.stringify(value ?? null), at: nowMs() });
}
function isEcho(key, value) {
  const rec = recentWrites.get(key);
  if (!rec) return false;
  if (nowMs() - rec.at > ECHO_TTL_MS) { recentWrites.delete(key); return false; }
  if (rec.json === JSON.stringify(value ?? null)) { recentWrites.delete(key); return true; }
  return false;
}
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.timeOrigin + performance.now()
    : 0;
}
function isoNow() {
  try { return new Date().toISOString(); } catch (_) { return null; }
}
function jeq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
