// The DJ desk's pure computations: phrase boundary, tempo sync with ×2/÷2 folding,
// beat-phase shift, equal-power fader, Camelot relations, suggestion ranking, time
// and pitch formatting. Run by file path:
//   node --test tests/js/desk_math.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, formatTime, formatRemaining, rateToPct, pctToRate, formatPitch,
  beatPeriod, beatAround, extendGrid, beatTimes, barTimes, nextPhrase,
  foldedBpmDistance, syncRate, phaseShift,
  faderGains, sideOf, mixAmount,
  parseCamelot, camelotRelation, camelotCompatible, rankSuggestions,
} from '../../static/js/deskmath.js';

const close = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≉ ${b}`);
const grid = (start, period, n) => Array.from({ length: n }, (_, i) => +(start + i * period).toFixed(6));

test('clamp', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
});

test('formatTime: minutes and seconds, tenths truncate, junk reads 0:00', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(59.99), '0:59');
  assert.equal(formatTime(61), '1:01');
  assert.equal(formatTime(3600), '60:00');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(-3), '0:00');
  assert.equal(formatTime(83.47, { tenths: true }), '1:23.4');
  assert.equal(formatTime(59.99, { tenths: true }), '0:59.9');
});

test('formatRemaining: wall time left at the deck rate', () => {
  assert.equal(formatRemaining(60, 180), '-2:00');
  assert.equal(formatRemaining(60, 180, 2), '-1:00');
  assert.equal(formatRemaining(200, 180), '-0:00');
  assert.equal(formatRemaining(10, 0), '-0:00');
  assert.equal(formatRemaining(10, Infinity), '-0:00');
});

test('pitch: rate ↔ percent and its label', () => {
  assert.equal(rateToPct(1.025), 2.5);
  assert.equal(rateToPct(0.92), -8);
  assert.equal(rateToPct(1), 0);
  close(pctToRate(-8), 0.92);
  assert.equal(pctToRate(NaN), 1);
  assert.equal(formatPitch(1), '0.0%');
  assert.equal(formatPitch(1.025), '+2.5%');
  assert.equal(formatPitch(0.992), '-0.8%');
});

test('beatPeriod: median spacing, else 60/bpm, else null', () => {
  close(beatPeriod([0, 0.5, 1.0, 1.6, 2.0], null), 0.5);
  close(beatPeriod([], 120), 0.5);
  close(beatPeriod(null, 100), 0.6);
  assert.equal(beatPeriod(null, null), null);
});

test('beatAround: inside the grid, before it and after it', () => {
  const g = grid(1, 0.5, 10);              // 1.0 … 5.5
  assert.deepEqual(beatAround(g, 2.2, null), { prev: 2, next: 2.5, period: 0.5 });
  assert.deepEqual(beatAround(g, 2, null), { prev: 2, next: 2.5, period: 0.5 });
  const before = beatAround(g, 0.3, null);
  close(before.prev, 0); close(before.next, 0.5);
  const after = beatAround(g, 7.1, null);
  close(after.prev, 7); close(after.next, 7.5);
  // no grid: counts from 0 at 60/bpm
  const bare = beatAround(null, 1.3, 120);
  close(bare.prev, 1.0); close(bare.next, 1.5);
  assert.equal(beatAround(null, 1, null), null);
});

test('extendGrid: carries a grid back to `from` and on to `to`', () => {
  assert.deepEqual(extendGrid([5, 6, 7], 1, 2.5, 9.2), [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(extendGrid([5, 6], 1, 5, 6), [5, 6]);
  assert.deepEqual(extendGrid([], 1, 0, 10), []);
  assert.deepEqual(extendGrid([1], 0, 0, 10), []);
});

test('beatTimes / barTimes: from the analysis, extended over the track', () => {
  assert.deepEqual(beatTimes([2, 2.5, 3], null, 0, 4), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  assert.deepEqual(beatTimes(null, 120, 0, 1.5), [0, 0.5, 1, 1.5]);
  assert.deepEqual(beatTimes(null, null, 0, 10), []);
  // downbeats only mid-track (as the analysis gives them) → bars from the top
  assert.deepEqual(barTimes([10, 12, 14], grid(0, 0.5, 40), 120, 0, 20), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  // no downbeats: every 4th beat of the grid
  assert.deepEqual(barTimes([], grid(1, 0.5, 9), null, 0, 6), [1, 3, 5]);
  assert.deepEqual(barTimes(null, null, 100, 0, 2.4), [0, 2.4]);
  assert.deepEqual(barTimes(null, null, null, 0, 10), []);
});

test('nextPhrase: the next 8-bar boundary minus one beat', () => {
  // 120 BPM: beat 0.5 s, bar 2 s, phrase 16 s, first downbeat at 1 s.
  const beatGrid = grid(1, 0.5, 400);
  const downbeats = grid(1, 2, 100);
  const p = nextPhrase(5, { downbeats, beatGrid, bpm: 120 });
  assert.equal(p.boundary, 17);
  close(p.at, 16.5);
  assert.equal(p.bars, 6);
  // just past a trigger point → the phrase after
  const q = nextPhrase(16.6, { downbeats, beatGrid, bpm: 120 });
  assert.equal(q.boundary, 33);
  // too close to the trigger (minLead) → the phrase after as well
  const r = nextPhrase(16.4, { downbeats, beatGrid, bpm: 120 });
  assert.equal(r.boundary, 33);
  // before the first downbeat: phrase 0 starts at the first downbeat
  const s = nextPhrase(0, { downbeats, beatGrid, bpm: 120 });
  assert.equal(s.boundary, 1);
});

test('nextPhrase: downbeats analysed only mid-track still give phrases from the top', () => {
  // As /api/bpm/track answers for "Get Lucky": beats from 25.6 s, downbeats from 118.1 s.
  const beatGrid = grid(25.561, 1.0345, 216);
  const downbeats = grid(118.114, 4.138, 32);
  const p = nextPhrase(8.8, { downbeats, beatGrid, bpm: 58 });
  const firstBar = 118.114 - 28 * 4.138;                 // 2.25 s
  close(p.boundary, firstBar + 8 * 4.138, 1e-3);         // 35.35 s, not 118 s
  close(p.at, p.boundary - 1.0345, 1e-3);
});

test('nextPhrase: extrapolates past the analysed bars, and works from beats or bpm alone', () => {
  const downbeats = grid(0, 2, 10);        // analysis ends at 18 s
  const p = nextPhrase(40, { downbeats, beatGrid: grid(0, 0.5, 40), bpm: 120 });
  assert.equal(p.boundary, 48);
  const fromBeats = nextPhrase(3, { beatGrid: grid(0, 0.5, 200) });
  assert.equal(fromBeats.boundary, 16);
  const fromBpm = nextPhrase(3, { bpm: 120 });
  assert.equal(fromBpm.boundary, 16);
  assert.equal(nextPhrase(3, {}), null);
  assert.equal(nextPhrase(NaN, { bpm: 120 }), null);
});

test('foldedBpmDistance: double and half time count as near', () => {
  assert.equal(foldedBpmDistance(120, 118), 2);
  assert.equal(foldedBpmDistance(120, 61), 2);
  assert.equal(foldedBpmDistance(60, 121), 0.5);
  assert.equal(foldedBpmDistance(null, 100), Infinity);
});

test('syncRate: matches the master tempo, folding to the nearest octave', () => {
  const a = syncRate(120, 1, 118);
  close(a.rate, 120 / 118); assert.equal(a.factor, 1);
  const b = syncRate(120, 1.02, 61);       // master runs at 122.4 → slave 61 is half time
  close(b.rate, 122.4 / 2 / 61 * 1, 1e-9); // 0.5 × 122.4 / 61
  assert.equal(b.factor, 0.5);
  const c = syncRate(62, 1, 120);          // slave is double time
  close(c.rate, 124 / 120); assert.equal(c.factor, 2);
  assert.equal(syncRate(0, 1, 120), null);
  assert.equal(syncRate(120, 1, undefined), null);
});

test('phaseShift: moves the slave so its next beat lands with the master’s', () => {
  const g = grid(0, 0.5, 2000);
  // master 0.1 s past a beat, slave 0.3 s past a beat: slave must go back 0.2 s
  close(phaseShift({ grid: g, pos: 10.1, rate: 1 }, { grid: g, pos: 20.3, rate: 1 }), -0.2);
  // slave 0.05 s behind → forward 0.05 s
  close(phaseShift({ grid: g, pos: 10.1, rate: 1 }, { grid: g, pos: 20.05, rate: 1 }), 0.05);
  // already aligned
  close(phaseShift({ grid: g, pos: 10.25, rate: 1 }, { grid: g, pos: 3.25, rate: 1 }), 0);
  // never more than half a beat
  const d = phaseShift({ grid: g, pos: 10.0, rate: 1 }, { grid: g, pos: 20.26, rate: 1 });
  assert.ok(Math.abs(d) <= 0.25 + 1e-9, String(d));
  // applying the shift really aligns the wall-clock arrival of the next beats
  const m = { grid: g, pos: 33.37, rate: 1.03 };
  const s = { grid: grid(0.11, 0.515, 2000), pos: 50.02, rate: 1.0 };
  const shift = phaseShift(m, s);
  const mb = beatAround(m.grid, m.pos); const sb = beatAround(s.grid, s.pos + shift);
  const mIn = (mb.next - m.pos) / m.rate; const sIn = (sb.next - (s.pos + shift)) / s.rate;
  const unit = Math.min(mb.period / m.rate, sb.period / s.rate);
  const r = ((sIn - mIn) % unit + unit) % unit;
  assert.ok(r < 1e-6 || unit - r < 1e-6, `residual ${r}`);
  assert.equal(phaseShift({ grid: null, pos: 1 }, { grid: g, pos: 1 }), null);
});

test('faderGains: equal power, clamped', () => {
  const mid = faderGains(0.5);
  close(mid.out, Math.SQRT1_2); close(mid.in, Math.SQRT1_2);
  close(mid.out ** 2 + mid.in ** 2, 1);
  close(faderGains(0).out, 1); close(faderGains(0).in, 0);
  close(faderGains(1).out, 0, 1e-9); close(faderGains(1).in, 1);
  close(faderGains(7).in, 1); close(faderGains(NaN).out, 1);
});

test('fader sides and mix amount follow the physical layout', () => {
  assert.equal(sideOf('A'), 0);
  assert.equal(sideOf('B'), 1);
  assert.equal(mixAmount(0.3, 'A'), 0.3);
  close(mixAmount(0.3, 'B'), 0.7);
  assert.equal(mixAmount(2, 'A'), 1);
});

test('Camelot: parse and relations round the wheel', () => {
  assert.deepEqual(parseCamelot('8a'), { n: 8, l: 'A' });
  assert.equal(parseCamelot('13A'), null);
  assert.equal(parseCamelot(null), null);
  assert.equal(camelotRelation('8A', '8A'), 'same');
  assert.equal(camelotRelation('8A', '8B'), 'relative');
  assert.equal(camelotRelation('8A', '9A'), 'adjacent');
  assert.equal(camelotRelation('12B', '1B'), 'adjacent');
  assert.equal(camelotRelation('1A', '11A'), 'energy');
  assert.equal(camelotRelation('8A', '3A'), 'clash');
  assert.equal(camelotRelation('8A', '9B'), 'clash');
  assert.equal(camelotRelation('8A', ''), null);
  assert.equal(camelotCompatible('8A', '7A'), true);
  assert.equal(camelotCompatible('8A', '10A'), false);
});

test('rankSuggestions: tempo, key and energy decide; unknown tracks go last', () => {
  const live = { bpm: 90, camelot: '8A', energy: 0.5 };
  const ranked = rankSuggestions(live, [
    { idx: 1, data: { bpm: 110, camelot: '8A', energy: 0.5 } },   // 20 BPM away
    { idx: 2, data: null },
    { idx: 3, data: { bpm: 91, camelot: '9A', energy: 0.55 } },   // close, adjacent key
    { idx: 4, data: { bpm: 45, camelot: '8A', energy: 0.5 } },    // half time, same key
    { idx: 5, data: { bpm: 90, camelot: '2B', energy: 0.5 } },    // key clash
  ]);
  assert.deepEqual(ranked.map(r => r.idx), [4, 3, 5, 1, 2]);
  assert.equal(ranked[0].relation, 'same');
  assert.equal(ranked[4].score, Infinity);
  assert.equal(rankSuggestions(live, [{ idx: 1, data: { bpm: 90 } }, { idx: 2, data: { bpm: 91 } }], { limit: 1 }).length, 1);
  // no live tempo → nothing can be scored, order kept
  assert.deepEqual(rankSuggestions({}, [{ idx: 7, data: { bpm: 90 } }, { idx: 8, data: null }]).map(r => r.idx), [7, 8]);
});
