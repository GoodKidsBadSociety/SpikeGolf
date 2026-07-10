/* ============================================================
   Spikegolf sync layer — Supabase realtime
   ------------------------------------------------------------
   • Reads config.js which exports SUPABASE_URL + SUPABASE_ANON_KEY.
     If either is empty the sync layer stays disabled and the app
     runs local-only (identical to the pre-cloud experience).
   • Uses anonymous auth so no one has to sign up.
   • The whole app state lives in a single row of `app_state`
     (id = 'main'). Every device merges its local snapshot into
     that row and subscribes to changes.
   • Last-writer-wins per field is fine for family-scale use.
   ============================================================ */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const REMOTE_ROW_ID = 'main';
const WRITE_DEBOUNCE_MS = 600;

let client = null;
let session = null;
let writeTimer = null;
let suppressRemote = false; // true when we're applying a remote update (avoid echo)
let onRemoteApply = null;
let ready = false;

export function syncEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function isReady() { return ready; }

/**
 * Initialise the sync layer. Returns:
 *   { enabled:false } if no config → caller stays local-only.
 *   { enabled:true, initialData: <remote or null> } once auth + first fetch done.
 * `applyRemote` is called whenever a remote change arrives.
 */
export async function initSync({ applyRemote }) {
  if (!syncEnabled()) return { enabled: false, initialData: null };

  onRemoteApply = applyRemote;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: window.localStorage,
      storageKey: 'spikegolf.auth',
    },
    realtime: { params: { eventsPerSecond: 5 } },
  });

  // Reuse existing session or sign in anonymously.
  const { data: { session: existing } } = await client.auth.getSession();
  if (existing) {
    session = existing;
  } else {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) { console.warn('sync auth failed', error); return { enabled: false, initialData: null }; }
    session = data.session;
  }

  // Fetch the current row.
  let initialData = null;
  try {
    const { data, error } = await client.from('app_state')
      .select('data, updated_at')
      .eq('id', REMOTE_ROW_ID)
      .maybeSingle();
    if (error) console.warn('sync initial fetch failed', error);
    initialData = data ? data.data : null;
  } catch (e) { console.warn('sync initial fetch threw', e); }

  // Subscribe to realtime changes.
  client
    .channel('app_state:main')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'app_state', filter: `id=eq.${REMOTE_ROW_ID}` },
      (payload) => {
        if (suppressRemote) return;
        const next = payload.new && payload.new.data;
        if (next && onRemoteApply) onRemoteApply(next);
      })
    .subscribe();

  ready = true;
  return { enabled: true, initialData };
}

/**
 * Push a snapshot to the remote row. Debounced — call as often as
 * you like; only the last one within the debounce window ships.
 */
export function pushState(snapshot) {
  if (!ready) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      suppressRemote = true;
      const { error } = await client.from('app_state').update({
        data: snapshot,
        updated_at: new Date().toISOString(),
      }).eq('id', REMOTE_ROW_ID);
      if (error) console.warn('sync push failed', error);
    } catch (e) {
      console.warn('sync push threw', e);
    } finally {
      // Give realtime a beat to echo back before we re-arm.
      setTimeout(() => { suppressRemote = false; }, 200);
    }
  }, WRITE_DEBOUNCE_MS);
}

/** Optional: force an immediate push (used on visibility change / unload). */
export async function flushState(snapshot) {
  if (!ready) return;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  try {
    suppressRemote = true;
    await client.from('app_state').update({
      data: snapshot,
      updated_at: new Date().toISOString(),
    }).eq('id', REMOTE_ROW_ID);
  } catch (e) { console.warn('flush push failed', e); }
  setTimeout(() => { suppressRemote = false; }, 200);
}
