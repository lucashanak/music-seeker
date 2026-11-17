// A song must be heard to its end, and the track that follows must be the one the
// engine got ready. Run: node --test tests/js/dj_transition.test.mjs
//
// Three things are pinned here, all found in the 2026-11-17 review of DJ mode:
//
//  1. A drop cut (clashing keys — 59 % of random pairs in the analysed library)
//     started a full 16-beat fade before the end and silenced the outgoing track
//     after 4 beats: the last ~8 s of the song were never heard.
//  2. Under shuffle the engine prefetched queue[index + 1], which is never the
//     track shuffle plays next, so every transition ran off the live stream.
//  3. prefetch.cleanup() evicted the blob of the track bound as next whenever it
//     sat outside the index window — always, for shuffle and Smart Queue.
//
// The real djmix.js / queue.js / prefetch.js run here; only the browser is faked.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let D, Q, P, store;
const revoked = [];
let blobSeq = 0;

before(async () => {
  const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, insertBefore() {}, querySelector: () => null,
    setAttribute() {},
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, dispatchEvent() {}, createElement: el, body: el(),
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.history = { pushState() {}, back() {} };
  globalThis.requestAnimationFrame = () => 0;   // the glide loop is not under test
  globalThis.cancelAnimationFrame = () => {};
  globalThis.URL.createObjectURL = () => `blob:test/${++blobSeq}`;
  globalThis.URL.revokeObjectURL = (u) => { revoked.push(u); };
  // Every stream request answers with a complete 20 kB "track".
  globalThis.fetch = async () => {
    const body = new Uint8Array(20480);
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
      blob: async () => new Blob([body]), body: null,
      json: async () => ({}), text: async () => '',
    };
  };
  process.on('unhandledRejection', () => {});

  D = await import('../../static/js/djmix.js');
  Q = await import('../../static/js/queue.js');
  P = await import('../../static/js/prefetch.js');
  ({ store } = await import('../../static/js/store.js'));
  Q.setPlayerRefs({ loadAndPlay() {}, hidePlayerBar() {}, saveQueueDebounced() {}, audio: null, getAudio: () => null });
});

// ── A fake AudioParam that records its automation timeline ──────────────────
function param(value = 0) {
  const ev = [];
  return {
    value, ev,
    cancelScheduledValues() { ev.length = 0; },
    setValueAtTime(v, t) { ev.push({ k: 'set', v, t }); },
    linearRampToValueAtTime(v, t) { ev.push({ k: 'lin', v, t }); },
    exponentialRampToValueAtTime(v, t) { ev.push({ k: 'exp', v, t }); },
    setValueCurveAtTime(curve, t, d) { ev.push({ k: 'curve', v: curve[curve.length - 1], t, d }); },
  };
}
function deck(gain, currentTime = 0) {
  const filt = () => ({ gain: param(0), frequency: param(20), Q: param(0.7), type: 'highpass' });
  return {
    element: { currentTime, playbackRate: 1, preservesPitch: true, readyState: 4, addEventListener() {} },
    gain: { gain: param(gain) },
    lowFilter: filt(), midFilter: filt(), highFilter: filt(), sweepFilter: filt(),
  };
}
/** Context time at which the outgoing deck's gain reaches 0. */
function silentAt(out) {
  const ev = out.gain.gain.ev;
  const curve = ev.find(e => e.k === 'curve');
  if (curve) return curve.t + curve.d;
  const zero = ev.find(e => e.k === 'lin' && e.v === 0);
  return zero ? zero.t : null;
}

const NOW = 100;
const ctx = { currentTime: NOW };
// 82 BPM, the library's zouk prior: 16 beats = 11.7 s, 4 beats = 2.9 s.
const OUT = { bpm: 82, camelot: '8A', beat_grid: null };
const CLASH = { bpm: 82, camelot: '3B' };   // different number and letter → 'cut'
const MATCH = { bpm: 82, camelot: '8A' };
const run = (inData, opts) => {
  const o = deck(1, 200), i = deck(0, 0);
  const r = D.scheduleDjTransitionV3(ctx, o, i, OUT, inData, { numBeats: 16, tempoRange: 8, ...opts });
  return { r, o, i };
};

test('style is decided in one place: clash → drop_cut, match or unknown → blend', () => {
  assert.equal(D.resolveTransitionStyle('auto', OUT, CLASH), 'drop_cut');
  assert.equal(D.resolveTransitionStyle('auto', OUT, MATCH), 'blend');
  assert.equal(D.resolveTransitionStyle('auto', OUT, null), 'blend');
  assert.equal(D.resolveTransitionStyle('auto', { bpm: 82 }, CLASH), 'blend');
  assert.equal(D.resolveTransitionStyle('eq_swap', OUT, CLASH), 'eq_swap');
});

test('drop-cut lead is 4 beats, held between 2 and 4 seconds', () => {
  assert.ok(Math.abs(D.dropCutLead(82) - 4 * 60 / 82) < 1e-9);
  assert.equal(D.dropCutLead(200), 2);
  assert.equal(D.dropCutLead(40), 4);
  assert.ok(D.dropCutLead(undefined) > 2 && D.dropCutLead(undefined) <= 4);
});

test('planned drop cut (short lead): the outgoing track is audible until its end', () => {
  // The engine triggered with dropCutLead + margin → ~3.2 s of the track remain.
  const remaining = 3.2;
  const { r, o } = run(CLASH, { fadeCapSec: remaining });
  assert.equal(r.style, 'drop_cut');
  const lost = (NOW + remaining) - silentAt(o);
  // Tight on purpose: the old scheduler cut 4 beats in (2.93 s), 0.27 s early.
  assert.ok(Math.abs(lost) < 0.05, `outgoing went silent ${lost.toFixed(2)} s before its end`);
  // And it stays at full level until that cut.
  const hold = o.gain.gain.ev.filter(e => e.k === 'set');
  assert.ok(hold.every(e => e.v === 1), 'outgoing gain is held at 1 up to the cut');
});

test('clash that could not be planned (full 16-beat lead): blend, nothing is cut', () => {
  // Incoming audio was not cached at trigger time, so the long lead was kept.
  const remaining = 11.5;
  const { r, o } = run(CLASH, { fadeCapSec: remaining });
  assert.equal(r.style, 'blend', 'an early drop cut here would swallow ~8 s of the ending');
  const lost = (NOW + remaining) - silentAt(o);
  assert.ok(Math.abs(lost) < 0.3, `outgoing went silent ${lost.toFixed(2)} s before its end`);
});

test('a forced drop_cut near the end still cuts ON the end, not 4 beats in', () => {
  const remaining = 11.5;
  const { r, o } = run(CLASH, { fadeCapSec: remaining, transitionStyle: 'drop_cut' });
  assert.equal(r.style, 'drop_cut');
  const lost = (NOW + remaining) - silentAt(o);
  assert.ok(Math.abs(lost) < 0.3, `outgoing went silent ${lost.toFixed(2)} s before its end`);
});

test('manual skip mid-track keeps the quick drop cut', () => {
  // 150 s of the track remain — the user asked to leave it; no reason to wait.
  const { r, o } = run(CLASH, { fadeCapSec: 150 });
  assert.equal(r.style, 'drop_cut');
  const cutAfter = silentAt(o) - NOW;
  assert.ok(cutAfter >= 2 && cutAfter <= 4, `cut after ${cutAfter.toFixed(2)} s`);
});

test('compatible keys are untouched: a 16-beat blend that ends on the track end', () => {
  const { r, o } = run(MATCH, { fadeCapSec: 11.5 });
  assert.equal(r.style, 'blend');
  assert.ok(Math.abs((NOW + 11.5) - silentAt(o)) < 0.3);
});

// ── "16 beats" must not mean 16 seconds ──────────────────────────────────────
test('a fade is bounded in time: half-time grids lose whole bars, normal tempos keep 16', () => {
  assert.equal(D.fadeBeatsFor(82, 16), 16);
  assert.equal(D.fadeBeatsFor(104, 16), 16);
  assert.equal(D.fadeBeatsFor(75, 16), 16);            // 12.8 s — inside the tolerance
  assert.equal(D.fadeBeatsFor(62, 16), 12);            // was 15.5 s, now 11.6 s
  assert.equal(D.fadeBeatsFor(58, 16), 12);
  assert.equal(D.fadeBeatsFor(62, 32), 24);            // the user's longer setting scales too
  assert.equal(D.fadeBeatsFor(undefined, 16), 16);
  for (const bpm of [58, 60, 62, 66, 70, 74, 78, 82, 96, 115]) {
    const sec = D.fadeBeatsFor(bpm, 16) * 60 / bpm;
    assert.ok(sec <= 13.3 && D.fadeBeatsFor(bpm, 16) % 4 === 0, `${bpm} BPM → ${sec.toFixed(1)} s`);
  }
});

test('the scheduler fades over the bounded count', () => {
  const o = deck(1, 200), i = deck(0, 0);
  const r = D.scheduleDjTransitionV3(ctx, o, i, { bpm: 62, camelot: '8A' }, { bpm: 62, camelot: '8A' }, { numBeats: 16, tempoRange: 8 });
  assert.ok(Math.abs(r.duration - 12 * 60 / 62) < 0.01, `fade is ${r.duration.toFixed(1)} s`);
});

// ── The other ways a song lost its start or its end ─────────────────────────
test('floor is 1 s: with 1.5 s left the fade ends with the track, not 1.5 s after it', () => {
  const { r, o } = run(MATCH, { fadeCapSec: 1.5 });
  assert.ok(Math.abs(r.duration - 1.5) < 0.2, `fade is ${r.duration}s`);
  assert.ok(Math.abs((NOW + 1.5) - silentAt(o)) < 0.2);
});

test('quickIn: nothing left to blend with → the next track is in within half a second', () => {
  const o = deck(1, 200), i = deck(0, 0);
  const IN = { bpm: 96, camelot: '8A', intro_end: 12, beat_grid: [0.4, 1.0], downbeats: [90.2], time_signature: 4 };
  const r = D.scheduleDjTransitionV3(ctx, o, i, OUT, IN, { numBeats: 32, tempoRange: 8, introSkip: 'auto', quickIn: true });
  assert.ok(r.duration <= 0.5, `fade-in takes ${r.duration}s (was a full ${(32 * 60 / 82).toFixed(1)}s beat fade)`);
  const up = i.gain.gain.ev.find(e => e.k === 'lin' && e.v === 1);
  assert.ok(up && up.t - NOW <= 0.5);
  assert.equal(i.element.playbackRate, 1, 'no tempo shift toward a track that is not playing');
  assert.equal(i.element.currentTime, 0, 'starts at its first sample');
  assert.ok(!r.tempoMatched);
});

test('WebKit helper: without a BPM the trigger lead IS the fallback fade length', () => {
  assert.equal(D.webkitCrossfadeDuration(undefined, 16, 5), 5);   // was 10 → 5 s cut
  assert.equal(D.webkitCrossfadeDuration(undefined, 16, 2), 3);
  assert.equal(D.webkitCrossfadeDuration(undefined, 16, 20), 10);
  assert.ok(Math.abs(D.webkitCrossfadeDuration(120, 16, 5) - 8) < 1e-9);
});

test('auto intro-skip is capped even after a track with no BPM', () => {
  // Outgoing has no analysis (a YouTube track): the downbeat branch never runs.
  const o = deck(1, 200), i = deck(0, 0);
  const IN = { bpm: 96, camelot: '8A', intro_end: 22.5, beat_grid: [22.5, 23.1], downbeats: [90.2], time_signature: 4 };
  D.scheduleDjTransitionV3(ctx, o, i, null, IN, { introSkip: 'auto', fadeCapSec: 5 });
  assert.ok(i.element.currentTime <= 6, `incoming started ${i.element.currentTime}s in`);
});

test('a number typed into intro-skip is honoured as given', () => {
  const o = deck(1, 200), i = deck(0, 0);
  D.scheduleDjTransitionV3(ctx, o, i, OUT, { bpm: 82, camelot: '8A', beat_grid: [0.1, 0.83], downbeats: [88.0], time_signature: 4 },
    { introSkip: '30', fadeCapSec: 11 });
  assert.equal(i.element.currentTime, 30);
});

test('a seek still waiting for metadata does not land on the next track loaded on that deck', () => {
  const listeners = [];
  const o = deck(1, 200), i = deck(0, 0);
  i.element.readyState = 0; // metadata not there yet → the seek is deferred
  i.element.addEventListener = (ev, fn) => { listeners.push(fn); };
  i.element.removeEventListener = (ev, fn) => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); };
  D.scheduleDjTransitionV3(ctx, o, i, OUT, { bpm: 82, camelot: '8A', intro_end: 4 }, { introSkip: 'auto', fadeCapSec: 11 });
  assert.equal(listeners.length, 1, 'the deferred seek is registered');
  D.clearPendingSeek(i.element);     // what the engine does before a cold load
  assert.equal(listeners.length, 0);
  assert.equal(i.element.currentTime, 0);
});

test('a skip in the middle of a fade starts the fade-out from where the deck is, not from full', () => {
  const o = deck(0.3, 12), i = deck(0, 0); // caught 30 % of the way up its own fade-in
  const captured = [];
  const orig = o.gain.gain.setValueCurveAtTime;
  o.gain.gain.setValueCurveAtTime = (curve, t, d) => { captured.push(curve[0]); orig(curve, t, d); };
  D.scheduleDjTransitionV3(ctx, o, i, OUT, MATCH, { fadeCapSec: 150 });
  assert.ok(Math.abs(captured[0] - 0.3) < 1e-6, `fade-out starts at gain ${captured[0]}`);
});

test('a skip when the outgoing deck is barely audible does not crawl in over a full fade', () => {
  const o = deck(0.05, 3), i = deck(0, 0);
  const r = D.scheduleDjTransitionV3(ctx, o, i, OUT, MATCH, { fadeCapSec: 150 });
  assert.ok(r.duration <= 2, `fade is ${r.duration}s`);
});

// ── Shuffle: the engine can see what plays next without consuming it ────────
const tracks = (n) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, artist: 'a' }));

beforeEach(() => {
  Q.resetShuffleOrder();
  P.clearAll();
  P.setUpcomingProvider(null);
  revoked.length = 0;
  store.shuffleEnabled = false;
  store.castDevice = null;
  store.playerQueue = [];
  store.playerIndex = -1;
});

test('peekShuffleNext names the track shuffleNext then returns, and consumes nothing', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(30);
  store.playerIndex = 0;
  const peek = Q.peekShuffleNext();
  assert.equal(Q.peekShuffleNext(), peek, 'peeking twice gives the same answer');
  assert.equal(Q.shuffleNext(), peek);
  store.playerIndex = peek;
  assert.notEqual(Q.peekShuffleNext(), peek, 'after the advance the peek moves on');
});

test('peekShuffleNext is null once the order is exhausted', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(2);
  store.playerIndex = 0;
  store.playerIndex = Q.shuffleNext();
  assert.equal(Q.peekShuffleNext(), null);
});

// ── Prefetch follows the real running order ─────────────────────────────────
const settle = () => new Promise(r => setTimeout(r, 30));
const provider = () => (count) => {
  const order = Q.playOrder();
  const pos = order.indexOf(store.playerIndex);
  return order.slice(pos + 1, pos + 1 + count);
};

test('with shuffle, the look-ahead window downloads the tracks shuffle will play', async () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(40);
  store.playerIndex = 0;
  P.setUpcomingProvider(provider());
  const next = Q.peekShuffleNext();
  P.resumePrefetch();
  await settle();
  const st = P.getStatus(`t${next}`, 'a');
  assert.ok(st && st.state === 'ready', 'the shuffle-next track is cached');
});

test('without a provider the window is still index + 1 … (no change for plain order)', async () => {
  store.playerQueue = tracks(10);
  store.playerIndex = 2;
  P.resumePrefetch();
  await settle();
  for (const i of [3, 4, 5]) assert.equal(P.getStatus(`t${i}`, 'a')?.state, 'ready');
  assert.equal(P.getStatus('t7', 'a'), null);
});

test('cleanup spares the track bound as next, wherever it sits in the queue', async () => {
  store.playerQueue = tracks(60);
  store.playerIndex = 5;
  // Smart Queue picked index 50 and the engine prefetched it.
  P.resumePrefetch();
  P.prefetchTrack('t50', 'a');
  await settle();
  assert.equal(P.getStatus('t50', 'a')?.state, 'ready');

  P.cleanup(store.playerQueue, store.playerIndex, [P.keyFor('t50', 'a')]);
  assert.equal(P.getStatus('t50', 'a')?.state, 'ready', 'kept: it is about to be played');
  assert.ok(P.getCachedUrl('t50', 'a'));

  // Without the hint it goes — that is what used to happen at the end of every fade.
  P.cleanup(store.playerQueue, store.playerIndex);
  assert.equal(P.getStatus('t50', 'a'), null);
  assert.equal(revoked.length, 1);
});

test('an expired stream token is renewed and retried — never treated as a dead session', async () => {
  store.playerQueue = tracks(4);
  store.playerIndex = 0;
  store.authToken = 'session';
  store.streamToken = 'old';
  let logout = 0;
  const realDispatch = document.dispatchEvent;
  document.dispatchEvent = (e) => { if (e && e.type === 'auth:logout') logout++; };
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/api/player/stream-token')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ token: 'fresh' }) };
    }
    if (u.includes('token=old')) return { ok: false, status: 401, headers: { get: () => null } };
    return realFetch(url, opts);
  };
  try {
    P.resumePrefetch();
    P.prefetchTrack('t1', 'a');
    await settle();
    assert.equal(logout, 0, 'no auth:logout — the session is fine, only the stream token aged');
    assert.ok(seen.some(u => u.includes('/api/player/stream-token')), 'a new stream token was requested');
    assert.equal(P.getStatus('t1', 'a')?.state, 'ready', 'and the download went through with it');
  } finally {
    globalThis.fetch = realFetch;
    document.dispatchEvent = realDispatch;
    store.streamToken = null; store.authToken = null;
  }
});

test('cleanup under shuffle keeps the upcoming permutation, not the storage neighbours', async () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(60);
  store.playerIndex = 0;
  P.setUpcomingProvider(provider());
  P.resumePrefetch();
  await settle();
  const upcoming = provider()(3);
  P.cleanup(store.playerQueue, store.playerIndex);
  for (const i of upcoming) {
    assert.equal(P.getStatus(`t${i}`, 'a')?.state, 'ready', `t${i} is next in the shuffle order`);
  }
});
