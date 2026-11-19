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

test('a prefetch that failed on the network is tried again — and a 4xx is not', async () => {
  store.playerQueue = tracks(6);
  store.playerIndex = 0;
  const realFetch = globalThis.fetch;
  const saved = [...P.RETRY_DELAYS_MS];
  P.RETRY_DELAYS_MS.splice(0, 3, 80, 80, 80);
  const calls = { t1: 0, t2: 0, t3: 0 };
  globalThis.fetch = async (url, opts) => {
    const name = new URL(String(url), 'http://x').searchParams.get('name');
    if (name in calls) calls[name]++;
    if (name === 't1' && calls.t1 === 1) throw new TypeError('network changed');      // link dropped
    if (name === 't2' && calls.t2 <= 2) return { ok: false, status: 502, headers: { get: () => null } };
    if (name === 't3') return { ok: false, status: 404, headers: { get: () => null } };
    return realFetch(url, opts);
  };
  try {
    P.pausePrefetch(); P.clearAll(); P.resumePrefetch();   // window = t1, t2, t3
    await settle();
    assert.equal(P.getStatus('t1', 'a'), null, 'failed, nothing cached yet');
    await new Promise(r => setTimeout(r, 450));
    await settle();
    assert.equal(P.getStatus('t1', 'a')?.state, 'ready', 'the dropped download was retried');
    assert.equal(calls.t1, 2);
    assert.equal(P.getStatus('t2', 'a')?.state, 'ready', 'a 5xx is retried until it answers');
    assert.equal(calls.t2, 3);
    assert.equal(calls.t3, 1, 'a 404 is an answer: asked once');
  } finally {
    globalThis.fetch = realFetch;
    P.RETRY_DELAYS_MS.splice(0, 3, ...saved);
    P.clearAll();
  }
});

test('a failed prefetch is not retried for a track that left the queue, and gives up in the end', async () => {
  const realFetch = globalThis.fetch;
  const saved = [...P.RETRY_DELAYS_MS];
  P.RETRY_DELAYS_MS.splice(0, 3, 80, 80, 80);
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError('offline'); };
  try {
    store.playerQueue = tracks(2);
    store.playerIndex = 0;
    P.pausePrefetch(); P.clearAll(); P.resumePrefetch();
    await settle();
    assert.equal(n, 1);
    store.playerQueue = [];                    // the user cleared the queue meanwhile
    await new Promise(r => setTimeout(r, 250));
    assert.equal(n, 1, 'gone from the queue → no retry');

    n = 0;
    store.playerQueue = tracks(2);
    P.pausePrefetch(); P.clearAll(); P.resumePrefetch();
    await new Promise(r => setTimeout(r, 700));
    assert.equal(n, 4, 'first try + three retries, then it stops');
  } finally {
    globalThis.fetch = realFetch;
    P.RETRY_DELAYS_MS.splice(0, 3, ...saved);
    P.clearAll();
  }
});

test('a failed prefetch is not retried once the user has skipped past the track', async () => {
  const realFetch = globalThis.fetch;
  const saved = [...P.RETRY_DELAYS_MS];
  P.RETRY_DELAYS_MS.splice(0, 3, 80, 80, 80);
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(new URL(String(url), 'http://x').searchParams.get('name')); throw new TypeError('offline'); };
  try {
    store.playerQueue = tracks(40);
    store.playerIndex = 0;
    P.pausePrefetch(); P.clearAll(); P.resumePrefetch();      // asks for t1–t3, all fail
    await settle();
    assert.deepEqual(asked.sort(), ['t1', 't2', 't3']);
    // Skipped far ahead; t1 is still IN the queue, but behind us.
    store.playerIndex = 20;
    await new Promise(r => setTimeout(r, 400));
    assert.equal(asked.length, 3, 'out of the upcoming window → not downloaded again');

    // Same, through the engine's own abort on an advance.
    asked.length = 0;
    store.playerIndex = 0;
    P.pausePrefetch(); P.clearAll(); P.resumePrefetch();
    await settle();
    P.abortStale([P.keyFor('t9', 'a')]);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(asked.length, 3, 'abortStale drops the pending retries');
  } finally {
    globalThis.fetch = realFetch;
    P.RETRY_DELAYS_MS.splice(0, 3, ...saved);
    P.clearAll();
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

test('usableEnergy: a version-1 (loudness) energy is unknown to Smart Queue', async () => {
  const { usableEnergy } = await import('../../static/js/djmix.js');
  assert.equal(usableEnergy({ energy: 0.4, feature_version: 3 }), 0.4);
  assert.ok(Number.isNaN(usableEnergy({ energy: 0.6, feature_version: 2 })));
  assert.ok(Number.isNaN(usableEnergy({ energy: null, feature_version: 3 })));   // analysed, not measurable
  assert.ok(Number.isNaN(usableEnergy({ feature_version: 3 })));
  assert.ok(Number.isNaN(usableEnergy(null)));
});

// ── Energy direction ──
test('energyTarget / wrongWay: one step from the playing track, and the wrong side costs', async () => {
  const { energyTarget, wrongWay } = await import('../../static/js/djmix.js');
  assert.ok(Math.abs(energyTarget(0.5, 'up', 0.12) - 0.62) < 1e-9);
  assert.ok(Math.abs(energyTarget(0.5, 'down', 0.12) - 0.38) < 1e-9);
  assert.equal(energyTarget(0.5, 'hold'), 0.5);
  assert.equal(energyTarget(0.95, 'up'), 1);                 // nothing above the top: stays there
  assert.equal(energyTarget(0.05, 'down'), 0);
  assert.equal(wrongWay(0.5, 0.6, 'up'), 0);
  assert.ok(wrongWay(0.5, 0.3, 'up') > 0.15);
  assert.equal(wrongWay(0.5, 0.48, 'up'), 0);                // within the slack: not "down"
  assert.ok(wrongWay(0.5, 0.7, 'down') > 0.15);
  assert.equal(wrongWay(0.5, 0.9, 'hold'), 0);
});

test('Smart Queue follows the chosen energy direction from the playing track', async () => {
  const dj = await import('../../static/js/djmix.js');
  const { primeBpmCache } = await import('../../static/js/bpm.js');
  const T = (name, energy, extra = {}) => ({ name, artist: 'A' + name, bpm: 84, confidence: 1, camelot: '8A',
    energy, feature_version: 3, beat_grid: [0.5], outro_start: 200, ...extra });
  const tracks = [T('Now', 0.5), T('Calm', 0.2), T('Bit calmer', 0.4), T('Same', 0.5), T('Bit hotter', 0.62), T('Hot', 0.95)];
  primeBpmCache(tracks);
  const queue = tracks.map(t => ({ name: t.name, artist: t.artist, type: 'track' }));
  const store = {};
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  try {
    const pick = (dir) => {
      store.ms_dj_energy_dir = dir;
      dj.resetSmartQueuePlayed();
      dj.markPlayed(queue[0]);
      const i = dj.pickSmartNext(queue, 0, tracks[0], 'bpm', false);
      return i == null ? null : queue[i].name;
    };
    assert.equal(pick('up'), 'Bit hotter');     // one step up, not straight to the hottest
    assert.equal(pick('down'), 'Bit calmer');
    assert.equal(pick('hold'), 'Same');
    // A version-2 energy is unknown: it neither attracts nor repels, so steering ignores it.
    primeBpmCache([T('Bit hotter', 0.62, { feature_version: 2 })]);
    assert.notEqual(pick('up'), 'Calm');
    primeBpmCache([T('Bit hotter', 0.62)]);
    // Without the playing track's energy the direction cannot be applied: no crash, a pick is made.
    store.ms_dj_energy_dir = 'up';
    dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
    assert.notEqual(dj.pickSmartNext(queue, 0, { ...tracks[0], energy: null }, 'bpm', false), null);
  } finally { globalThis.localStorage = saved; }
});

test('steering outranks the key bonus, a small tempo gap and the tie-break', async () => {
  const dj = await import('../../static/js/djmix.js');
  const { primeBpmCache } = await import('../../static/js/bpm.js');
  const T = (name, energy, extra = {}) => ({ name, artist: 'K' + name, bpm: 84, confidence: 1, camelot: '8A',
    energy, feature_version: 3, beat_grid: [0.5], outro_start: 200, ...extra });
  // The only calmer tracks clash in key and sit 3 BPM away; a hotter one matches both.
  const tracks = [T('Now', 0.5), T('Hot match', 0.68), T('Calm clash', 0.38, { camelot: '2B', bpm: 87 }),
                  T('Calmer clash', 0.2, { camelot: '2B', bpm: 87 }), T('Far calm', 0.3, { bpm: 118 })];
  primeBpmCache(tracks);
  const queue = tracks.map(t => ({ name: t.name, artist: t.artist, type: 'track' }));
  const store = { ms_dj_energy_dir: 'down' };
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  try {
    for (let run = 0; run < 25; run++) {                      // a new set each time: another jitter salt
      dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
      const i = dj.pickSmartNext(queue, 0, tracks[0], 'bpm_key', false);
      assert.equal(queue[i].name, 'Calm clash', `run ${run}`);
    }
    // Nothing reachable on the asked side → no dead end, the filter steps aside.
    store.ms_dj_energy_dir = 'up';
    primeBpmCache([T('Hot match', 0.45)]);
    dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
    assert.notEqual(dj.pickSmartNext(queue, 0, tracks[0], 'bpm_key', false), null);
    // A candidate on the right side but a tempo jump away does not switch the filter on by itself.
    store.ms_dj_energy_dir = 'down';
    primeBpmCache([T('Calm clash', 0.6, { camelot: '2B', bpm: 87 }), T('Calmer clash', 0.7, { camelot: '2B', bpm: 87 })]);
    dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
    assert.notEqual(queue[dj.pickSmartNext(queue, 0, tracks[0], 'bpm_key', false)].name, 'Far calm');
  } finally { globalThis.localStorage = saved; }
});

test('onSide: where the listener asked to go; unknown energy never qualifies', async () => {
  const { onSide } = await import('../../static/js/djmix.js');
  assert.equal(onSide(0.5, 0.6, 'up'), true);
  assert.equal(onSide(0.5, 0.5, 'up'), false);                // the same level is not "up"
  assert.equal(onSide(0.5, 0.4, 'down'), true);
  assert.equal(onSide(0.5, 0.52, 'down'), false);
  assert.equal(onSide(0.5, 0.6, 'hold'), true);
  assert.equal(onSide(0.5, 0.9, 'hold'), false);
  assert.equal(onSide(0.5, NaN, 'up'), false);
});

test('the Tempo preference goes by the felt tempo, like the badge', async () => {
  const dj = await import('../../static/js/djmix.js');
  const { primeBpmCache } = await import('../../static/js/bpm.js');
  const T = (name, bpm, tempo_feel) => ({ name, artist: 'F' + name, bpm, tempo_feel, confidence: 1, camelot: '8A',
    energy: 0.5, feature_version: 3, beat_grid: [0.5], outro_start: 200 });
  const tracks = [T('Now', 62, 124), T('Remix stored 62', 62, 124), T('Ballad 64', 64, 64)];
  primeBpmCache(tracks);
  const queue = tracks.map(t => ({ name: t.name, artist: t.artist, type: 'track' }));
  const store = { ms_dj_tempo_pref: 'fast' };
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} };
  try {
    dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
    assert.equal(queue[dj.pickSmartNext(queue, 0, tracks[0], 'bpm', false)].name, 'Remix stored 62');
    store.ms_dj_tempo_pref = 'slow';
    dj.resetSmartQueuePlayed(); dj.markPlayed(queue[0]);
    assert.equal(queue[dj.pickSmartNext(queue, 0, tracks[0], 'bpm', false)].name, 'Ballad 64');
  } finally { globalThis.localStorage = saved; }
});
