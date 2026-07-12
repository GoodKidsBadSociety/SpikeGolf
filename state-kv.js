/* ============================================================
   Spikegolf state ⇄ key/value split
   ------------------------------------------------------------
   The whole app state used to travel as ONE blob. That meant
   the last device to write clobbered everyone else. Here we
   cut the state into small independent records so a sync layer
   can push only the bits that actually changed:

     player:<id>                       → { id, name, color }
     course:<id>                       → { id, name, par, startPos, endPos, obstacles }
     round:<id>                        → { id, name, startedAt, endedAt, playerIds, courseIds }
     score:<roundId>:<courseId>:<pid>  → number   (omitted when 0)

   Two people entering different scores now touch different
   keys and never overwrite each other.

   Pure functions only — no DOM, no Three.js — so this module is
   unit-testable under plain Node (see tools/test_kvsync.mjs).
   `_ord` carries array order across the wire; it is stripped
   from live objects so it never leaks into the rest of the app.
   ============================================================ */

const PLAYER = 'player:';
const COURSE = 'course:';
const ROUND = 'round:';
const SCORE = 'score:';

const scoreKey = (roundId, courseId, playerId) => `${SCORE}${roundId}:${courseId}:${playerId}`;

/**
 * Flatten a full app state into a { key: value } map of small records.
 * Only the shared/persistent parts are emitted — UI position
 * (tab, active*, playSub) stays local to each device.
 */
export function stateToKV(state) {
  const kv = {};
  (state.players || []).forEach((p, i) => {
    kv[PLAYER + p.id] = { ...stripOrd(p), _ord: i };
  });
  (state.courses || []).forEach((c, i) => {
    kv[COURSE + c.id] = { ...stripOrd(c), _ord: i };
  });
  (state.rounds || []).forEach((r, i) => {
    const { scores, ...meta } = r;
    kv[ROUND + r.id] = { ...stripOrd(meta), _ord: i };
    const sc = scores || {};
    Object.keys(sc).forEach(courseId => {
      const row = sc[courseId] || {};
      Object.keys(row).forEach(playerId => {
        const n = Number(row[playerId]) || 0;
        if (n > 0) kv[scoreKey(r.id, courseId, playerId)] = n;
      });
    });
  });
  return kv;
}

/**
 * Rebuild the shared portion of a state object from a full KV map.
 * Returns { players, courses, rounds } — callers layer their local
 * UI fields on top.
 */
export function kvToState(kv) {
  const players = [];
  const courses = [];
  const rounds = [];
  const roundById = {};

  for (const key of Object.keys(kv)) {
    const v = kv[key];
    if (key.startsWith(PLAYER)) players.push(v);
    else if (key.startsWith(COURSE)) courses.push(v);
    else if (key.startsWith(ROUND)) {
      const r = { ...v };
      if (!r.scores) r.scores = {};
      rounds.push(r);
      roundById[r.id] = r;
    }
  }
  // Scores need their rounds to exist first.
  for (const key of Object.keys(kv)) {
    if (!key.startsWith(SCORE)) continue;
    const { roundId, courseId, playerId } = parseScoreKey(key);
    const r = roundById[roundId];
    if (!r) continue;
    if (!r.scores[courseId]) r.scores[courseId] = {};
    r.scores[courseId][playerId] = Number(kv[key]) || 0;
  }

  bySavedOrder(players);
  bySavedOrder(courses);
  bySavedOrder(rounds);
  players.forEach(stripOrdInPlace);
  courses.forEach(stripOrdInPlace);
  rounds.forEach(stripOrdInPlace);

  return { players, courses, rounds };
}

/**
 * Apply a single remote record change to a live state object,
 * in place. `value === null` (or a 0 score) means the record was
 * deleted. Returns the same state object for convenience.
 */
export function applyKVChange(state, key, value) {
  if (!state) return state;
  if (key.startsWith(PLAYER)) {
    upsertList(state.players || (state.players = []), key.slice(PLAYER.length), value);
  } else if (key.startsWith(COURSE)) {
    upsertList(state.courses || (state.courses = []), key.slice(COURSE.length), value);
  } else if (key.startsWith(ROUND)) {
    const list = state.rounds || (state.rounds = []);
    const id = key.slice(ROUND.length);
    if (value == null) {
      const i = list.findIndex(x => x.id === id);
      if (i >= 0) list.splice(i, 1);
    } else {
      const existing = list.find(x => x.id === id);
      const scores = existing ? existing.scores : {};
      const next = { ...value, scores: scores || {} };
      if (existing) Object.assign(existing, next);
      else list.push(next);
      bySavedOrder(list);
      list.forEach(stripOrdInPlace);
    }
  } else if (key.startsWith(SCORE)) {
    const { roundId, courseId, playerId } = parseScoreKey(key);
    const r = (state.rounds || []).find(x => x.id === roundId);
    if (!r) return state; // its round record will arrive and seed scores:{}
    if (!r.scores) r.scores = {};
    const n = Number(value) || 0;
    if (n > 0) {
      if (!r.scores[courseId]) r.scores[courseId] = {};
      r.scores[courseId][playerId] = n;
    } else if (r.scores[courseId]) {
      delete r.scores[courseId][playerId];
      if (!Object.keys(r.scores[courseId]).length) delete r.scores[courseId];
    }
  }
  return state;
}

/**
 * Compare two KV maps and return only what changed:
 *   { puts: { key: value }, dels: [key, ...] }
 */
export function diffKV(prev, next) {
  const puts = {};
  const dels = [];
  for (const k of Object.keys(next)) {
    if (!(k in prev) || !eq(prev[k], next[k])) puts[k] = next[k];
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) dels.push(k);
  }
  return { puts, dels };
}

/* ---------------- internals ---------------- */

function upsertList(list, id, value) {
  if (value == null) {
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return;
  }
  const existing = list.find(x => x.id === id);
  if (existing) Object.assign(existing, value);
  else list.push({ ...value });
  bySavedOrder(list);
  list.forEach(stripOrdInPlace);
}

function parseScoreKey(key) {
  // score:<roundId>:<courseId>:<playerId> — ids never contain ':'.
  const rest = key.slice(SCORE.length).split(':');
  return { roundId: rest[0], courseId: rest[1], playerId: rest[2] };
}

function bySavedOrder(list) {
  list.sort((a, b) => (ord(a) - ord(b)));
}
function ord(x) { return typeof x._ord === 'number' ? x._ord : 1e9; }

function stripOrd(o) { const { _ord, ...rest } = o; return rest; }
function stripOrdInPlace(o) { if (o && '_ord' in o) delete o._ord; }

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
