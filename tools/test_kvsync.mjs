/* Unit tests for the per-record state split (state-kv.js).
   Run: node tools/test_kvsync.mjs
   Pure logic only — no Supabase, no DOM. */

import { stateToKV, kvToState, applyKVChange, diffKV } from '../state-kv.js';

let failed = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function ok(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failed++;
}
function eqTest(name, a, b) {
  const good = eq(a, b);
  if (!good) console.log('  expected', JSON.stringify(b), '\n  got     ', JSON.stringify(a));
  ok(name, good);
}

const sampleState = () => ({
  players: [
    { id: 'pA', name: 'Anna', color: '#2d6a4f' },
    { id: 'pB', name: 'Ben', color: '#c0392b' },
  ],
  courses: [
    { id: 'c1', name: 'Bahn 1', par: 3, startPos: { x: 1, y: 2, z: 3 }, endPos: { x: 4, y: 5, z: 6 },
      obstacles: [{ id: 'o1', type: 'baum', text: 'Fichte', pos: { x: 2, y: 2, z: 2 } }] },
  ],
  rounds: [
    { id: 'r1', name: 'Runde 1', startedAt: 111, endedAt: null,
      playerIds: ['pA', 'pB'], courseIds: ['c1'],
      scores: { c1: { pA: 3, pB: 5 } } },
  ],
  activeRoundId: 'r1', activeCourseId: null, tab: 'play', playSub: 'route',
});

/* --- round-trip preserves the shared state --- */
{
  const s = sampleState();
  const kv = stateToKV(s);
  const back = kvToState(kv);
  eqTest('roundtrip players', back.players, s.players);
  eqTest('roundtrip courses', back.courses, s.courses);
  eqTest('roundtrip rounds', back.rounds, s.rounds);
}

/* --- score cells become individual keys --- */
{
  const kv = stateToKV(sampleState());
  ok('score key pA', kv['score:r1:c1:pA'] === 3);
  ok('score key pB', kv['score:r1:c1:pB'] === 5);
  ok('round key has no scores', kv['round:r1'] && !('scores' in kv['round:r1']));
  ok('no zero-score keys', !Object.keys(kv).some(k => k.startsWith('score:') && !kv[k]));
}

/* --- diff isolates a single changed score --- */
{
  const a = sampleState();
  const b = sampleState();
  b.rounds[0].scores.c1.pB = 4;             // only Ben's score on c1 changes
  const delta = diffKV(stateToKV(a), stateToKV(b));
  eqTest('diff puts one key', Object.keys(delta.puts), ['score:r1:c1:pB']);
  ok('diff value', delta.puts['score:r1:c1:pB'] === 4);
  ok('diff no dels', delta.dels.length === 0);
}

/* --- setting a score to 0 deletes its key --- */
{
  const a = sampleState();
  const b = sampleState();
  b.rounds[0].scores.c1.pB = 0;
  const delta = diffKV(stateToKV(a), stateToKV(b));
  eqTest('zero score deletes key', delta.dels, ['score:r1:c1:pB']);
}

/* --- applying a remote score change, in place --- */
{
  const s = sampleState();
  applyKVChange(s, 'score:r1:c1:pA', 2);
  ok('remote score applied', s.rounds[0].scores.c1.pA === 2);
  applyKVChange(s, 'score:r1:c1:pB', null);
  ok('remote score deleted', !('pB' in s.rounds[0].scores.c1));
}

/* --- two independent edits do not clobber each other --- */
{
  // Shared baseline in the "cloud".
  const cloud = stateToKV(sampleState());

  // Device 1 edits Anna's score; Device 2 edits Ben's score.
  const d1 = sampleState(); d1.rounds[0].scores.c1.pA = 1;
  const d2 = sampleState(); d2.rounds[0].scores.c1.pB = 9;

  const delta1 = diffKV(cloud, stateToKV(d1));
  const delta2 = diffKV(cloud, stateToKV(d2));

  // Apply both deltas onto a fresh copy of the cloud state (any order).
  const merged = sampleState();
  for (const k of Object.keys(delta1.puts)) applyKVChange(merged, k, delta1.puts[k]);
  for (const k of delta1.dels) applyKVChange(merged, k, null);
  for (const k of Object.keys(delta2.puts)) applyKVChange(merged, k, delta2.puts[k]);
  for (const k of delta2.dels) applyKVChange(merged, k, null);

  ok('device1 edit survived', merged.rounds[0].scores.c1.pA === 1);
  ok('device2 edit survived', merged.rounds[0].scores.c1.pB === 9);
}

/* --- adding a new course only pushes that course key --- */
{
  const a = sampleState();
  const b = sampleState();
  b.courses.push({ id: 'c2', name: 'Bahn 2', par: 4, startPos: null, endPos: null, obstacles: [] });
  const delta = diffKV(stateToKV(a), stateToKV(b));
  eqTest('new course single key', Object.keys(delta.puts), ['course:c2']);
}

/* --- deleting a player removes exactly its key --- */
{
  const a = sampleState();
  const b = sampleState();
  b.players = b.players.filter(p => p.id !== 'pB');
  const delta = diffKV(stateToKV(a), stateToKV(b));
  eqTest('deleted player key', delta.dels, ['player:pB']);
}

/* --- applying a round upsert preserves that round's scores --- */
{
  const s = sampleState();
  applyKVChange(s, 'round:r1', { id: 'r1', name: 'Umbenannt', startedAt: 111, endedAt: 222, playerIds: ['pA', 'pB'], courseIds: ['c1'] });
  ok('round meta updated', s.rounds[0].name === 'Umbenannt' && s.rounds[0].endedAt === 222);
  ok('round scores preserved', s.rounds[0].scores.c1.pA === 3);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
