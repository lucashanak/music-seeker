// The pure logic of the clip editor (static/js/mixcut.js). The DOM is stubbed only
// far enough for the module's imports to load.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let M;
before(async () => {
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, querySelector: () => null });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() };
  globalThis.window = { addEventListener() {}, innerWidth: 400, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  globalThis.history = { pushState() {}, back() {} };
  M = await import('../../static/js/mixcut.js');
});

const b64 = (arr) => Buffer.from(Uint8Array.from(arr)).toString('base64');

test('peaks decode from base64', () => {
  const p = M.decodePeaks(b64([0, 1, 128, 255]));
  assert.deepEqual([...p], [0, 1, 128, 255]);
  assert.equal(M.decodePeaks('').length, 0);
  assert.equal(M.decodePeaks('***not base64***').length, 0);
});

test('barsFor takes the max per bar', () => {
  const peaks = Uint8Array.from([10, 255, 0, 0, 51, 20, 0, 0]);   // 8 samples at 10/s = 0.8 s
  const b = M.barsFor(peaks, 10, 0, 0.8, 2);
  assert.equal(b.length, 2);
  assert.equal(b[0], 1);                    // max(10,255,0,0)
  assert.ok(Math.abs(b[1] - 51 / 255) < 1e-6);
});

test('barsFor handles ranges past either end and never yields NaN', () => {
  const peaks = Uint8Array.from([255, 255, 255, 255]);   // 0.4 s
  const b = M.barsFor(peaks, 10, -1, 1.4, 6);
  assert.ok([...b].every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  assert.equal(b[0], 0);                    // before the start
  assert.equal(b[5], 0);                    // after the end
  assert.ok(b.some((v) => v === 1));
  assert.ok([...M.barsFor(peaks, 10, 5, 9, 4)].every((v) => v === 0));
  assert.equal(M.barsFor(new Uint8Array(0), 10, 0, 10, 3).length, 3);
  assert.ok([...M.barsFor(peaks, NaN, NaN, NaN, 3)].every((v) => v === 0));
});

test('barsFor zoomed in finer than one sample still reads the sample', () => {
  const peaks = Uint8Array.from([0, 255, 0]);
  const b = M.barsFor(peaks, 10, 0.1, 0.2, 5);   // 5 bars inside sample 1
  assert.ok([...b].every((v) => v === 1));
});

test('time <-> x round trips on both canvases', () => {
  assert.equal(M.timeToX(50, 0, 100, 200), 100);
  assert.equal(M.xToTime(100, 0, 100, 200), 50);
  assert.equal(M.timeToX(30, 20, 60, 400), 100);          // detail window 20..60
  assert.equal(M.xToTime(100, 20, 60, 400), 30);
  assert.equal(M.xToTime(M.timeToX(37.3, 20, 60, 400), 20, 60, 400), 37.3);
  assert.equal(M.timeToX(5, 10, 10, 400), 0);             // zero span does not divide by zero
});

test('snapToBeat snaps within tolerance only', () => {
  const beats = [10, 10.5, 11];
  assert.equal(M.snapToBeat(10.6, beats, 0.35), 10.5);
  assert.equal(M.snapToBeat(10.74, beats, 0.35), 10.5);
  assert.equal(M.snapToBeat(12, beats, 0.35), 12);        // nothing near
  assert.equal(M.snapToBeat(5, [], 0.35), 5);
  assert.equal(M.snapToBeat(10.86, beats, 0.35), 11);
});

test('nextBeat steps one beat either way', () => {
  const beats = [1, 2, 3];
  assert.equal(M.nextBeat(2, beats, 1), 3);
  assert.equal(M.nextBeat(2, beats, -1), 1);
  assert.equal(M.nextBeat(3, beats, 1), null);
  assert.equal(M.nextBeat(2.2, beats, -1), 2);
});

test('clampSelection and the length rule', () => {
  assert.deepEqual(M.clampSelection(-5, 50, 100), { start: 0, end: 50 });
  assert.deepEqual(M.clampSelection(90, 200, 100), { start: 90, end: 100 });
  assert.deepEqual(M.clampSelection(60, 20, 100), { start: 20, end: 60 });
  assert.deepEqual(M.clampSelection(NaN, NaN, 100), { start: 0, end: 0 });
  assert.equal(M.lengthProblem(9.9), 'short');
  assert.equal(M.lengthProblem(10), null);
  assert.equal(M.lengthProblem(1200), null);
  assert.equal(M.lengthProblem(1200.5), 'long');
  assert.equal(M.lengthProblem(NaN), 'short');
});

test('moveEdge never lets the edges cross or leave the set', () => {
  const sel = { start: 20, end: 40 };
  assert.deepEqual(M.moveEdge(sel, 'start', 30, 100), { start: 30, end: 40 });
  const crossed = M.moveEdge(sel, 'start', 70, 100);
  assert.ok(crossed.start < crossed.end);
  assert.ok(M.moveEdge(sel, 'end', 5, 100).end > 20);
  assert.equal(M.moveEdge(sel, 'end', 500, 100).end, 100);
  assert.equal(M.moveEdge(sel, 'start', -3, 100).start, 0);
});

test('fmt', () => {
  assert.equal(M.fmt(0), '0:00');
  assert.equal(M.fmt(65), '1:05');
  assert.equal(M.fmt(1738), '28:58');
  assert.equal(M.fmt(3600 + 61), '1:01:01');
  assert.equal(M.fmt(61.26, true), '1:01.2');
  assert.equal(M.fmt(NaN), '0:00');
  assert.equal(M.fmt(-4), '0:00');
});

test('default title keeps the range suffix and never equals the mix title', () => {
  const t = M.defaultTitle('Sunday Set', 65, 130);
  assert.equal(t, 'Sunday Set (1:05–2:10)');
  assert.notEqual(t, 'Sunday Set');
});

test('hitEdge picks the edge in reach, the nearer when both are', () => {
  assert.equal(M.hitEdge(100, 100, 300, 12), 'start');
  assert.equal(M.hitEdge(290, 100, 300, 12), 'end');
  assert.equal(M.hitEdge(200, 100, 300, 12), null);
  assert.equal(M.hitEdge(104, 100, 108, 12), 'end');      // overlapping reach: nearer wins
  assert.equal(M.hitEdge(50, null, null, 12), null);
});

test('clamp span and grouping of clips', () => {
  assert.equal(M.clampSpan(1), 10);
  assert.equal(M.clampSpan(9999), 300);
  assert.equal(M.clampSpan(NaN), 40);
  const g = M.groupClips([
    { title: 'b', source_title: 'S', source_artist: 'A', start: 200 },
    { title: 'a', source_title: 'S', source_artist: 'A', start: 10 },
    { title: 'c', source_title: 'T', source_artist: 'A', start: 5 },
  ]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].clips.map((c) => c.title), ['a', 'b']);   // DJ order
  const mine = M.clipsOfSet([{ source_title: 'S', source_artist: 'A', start: 1 }, { source_title: 'S', source_artist: 'X', start: 2 }], { title: 'S', artist: 'A' });
  assert.equal(mine.length, 1);
});

test('stream url is the set file itself, token in the query, everything encoded', () => {
  const u = M.mixStreamUrl({ dj: 'DJ A&B', file: 'Set #1 [live].m4a' }, 'tok/+=');
  assert.ok(u.startsWith('/api/clips/audio?'));
  const q = new URL(u, 'http://x').searchParams;
  assert.equal(q.get('dj'), 'DJ A&B');
  assert.equal(q.get('file'), 'Set #1 [live].m4a');
  assert.equal(q.get('token'), 'tok/+=');
  assert.ok(!u.includes('#') && !u.includes(' ') && [...u.matchAll(/&/g)].length === 2);
});

test('a clip belongs to a set by dj + file; the title is only the fallback for old clips', () => {
  const mix = { dj: 'DJ A', file: 'Set.m4a', title: 'Sunday', artist: 'DJ A' };
  const clips = [
    { title: 'same file', source_dj: 'DJ A', source_file: 'Set.m4a', source_title: 'Other tag', source_artist: 'x', start: 30 },
    { title: 'same title other set', source_dj: 'DJ B', source_file: 'Set.m4a', source_title: 'Sunday', source_artist: 'DJ A', start: 5 },
    { title: 'same title other file', source_dj: 'DJ A', source_file: 'Other.m4a', source_title: 'Sunday', source_artist: 'DJ A', start: 6 },
    { title: 'old', source_dj: '', source_file: '', source_title: 'Sunday', source_artist: 'DJ A', start: 10 },
    { title: 'old other', source_dj: '', source_file: '', source_title: 'Monday', source_artist: 'DJ A', start: 1 },
  ];
  assert.deepEqual(M.clipsOfSet(clips, mix).map((c) => c.title), ['old', 'same file']);
  assert.equal(M.isClipOfSet(clips[1], mix), false);
});

test('groups split two sets that share a title when the file is known', () => {
  const g = M.groupClips([
    { title: 'a', source_dj: 'A', source_file: '1.m4a', source_title: 'S', source_artist: 'A', start: 1 },
    { title: 'b', source_dj: 'A', source_file: '2.m4a', source_title: 'S', source_artist: 'A', start: 2 },
    { title: 'c', source_dj: 'A', source_file: '1.m4a', source_title: 'S', source_artist: 'A', start: 0 },
    { title: 'o', source_title: 'S', source_artist: 'A', start: 3 },
  ]);
  assert.equal(g.length, 3);
  assert.deepEqual(g[0].clips.map((c) => c.title), ['c', 'a']);
});

test('placeEdge: a start at or past the end carries the end along, length kept', () => {
  const sel = { start: 20, end: 50 };
  assert.deepEqual(M.placeEdge(sel, 'start', 70, 200), { start: 70, end: 100 });
  assert.deepEqual(M.placeEdge(sel, 'start', 50, 200), { start: 50, end: 80 });
  assert.deepEqual(M.placeEdge(sel, 'start', 190, 200), { start: 190, end: 200 });   // clamped to the set
  const atEnd = M.placeEdge(sel, 'start', 200, 200);
  assert.ok(atEnd.start < atEnd.end && atEnd.end === 200);                          // never empty
  assert.deepEqual(M.placeEdge(sel, 'start', 30, 200), { start: 30, end: 50 });     // inside: plain move
});

test('placeEdge: an end at or before the start carries the start back', () => {
  const sel = { start: 100, end: 130 };
  assert.deepEqual(M.placeEdge(sel, 'end', 60, 200), { start: 30, end: 60 });
  assert.deepEqual(M.placeEdge(sel, 'end', 100, 200), { start: 70, end: 100 });
  assert.deepEqual(M.placeEdge(sel, 'end', 10, 200), { start: 0, end: 10 });        // clamped at 0
  const atZero = M.placeEdge(sel, 'end', 0, 200);
  assert.ok(atZero.start < atZero.end && atZero.start === 0);
  assert.deepEqual(M.placeEdge(sel, 'end', 120, 200), { start: 100, end: 120 });
});

test('typed times: m:ss, h:mm:ss, decimals and bare seconds — and nothing else', async () => {
  const { parseTime } = await import('../../static/js/mixcut.js');
  assert.equal(parseTime('17:45'), 1065);
  assert.equal(parseTime('22:45'), 1365);
  assert.equal(parseTime('1:02:03.5'), 3723.5);
  assert.equal(parseTime('95'), 95);
  assert.equal(parseTime(' 0:07,5 '), 7.5);
  for (const bad of ['', 'abc', '1:75', '1:2:3:4', '-5', '1:', ':30', '12:3a']) assert.equal(parseTime(bad), null, bad);
});
