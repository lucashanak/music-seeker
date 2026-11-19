// The DJ desk's hooks inside the DJ engine (player_v3.js). Run by file path:
//   node --test tests/js/desk_engine.test.mjs
//
// The real player_v3.js / djmix.js / queue.js / prefetch.js run here; only the browser
// is faked (DOM, <audio>, Web Audio, fetch, timers). Contract: notes/impl/dj-pult-rozhrani.md,
// section "Engine — exporty". The tests drive the engine through its exports and the
// events its decks listen to, never through its internals.

import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The desk UI (djdesk.js) is reached by the engine's import graph only through
// router.js (player_v3 → fullplayer → djpanel → router → djdesk). It is not under test,
// so it is replaced by a stub with its contract's exports (notes/impl/dj-pult-rozhrani.md):
// these tests then depend on the engine alone. The engine itself never imports it.
register('data:text/javascript,' + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith('/static/js/djdesk.js')) {
      return { format: 'module', shortCircuit: true, source:
        'export function init() {} export function openDesk() {} export function closeDesk() {} export function isDeskOpen() { return false; }' };
    }
    return next(url, ctx);
  }
`));

// ── A fake browser ──────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.children = [];
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.hidden = false;
    this._l = new Map();
  }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    const once = typeof opts === 'object' && opts && opts.once;
    if (!this._l.has(type)) this._l.set(type, []);
    this._l.get(type).push({ fn, once });
  }
  removeEventListener(type, fn) {
    const list = this._l.get(type);
    if (!list) return;
    const i = list.findIndex(e => e.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev) {
    const list = [...(this._l.get(ev.type) || [])];
    for (const e of list) {
      if (e.once) this.removeEventListener(ev.type, e.fn);
      try { e.fn.call(this, ev); } catch (err) { errors.push(err); allErrors.push(err); }
    }
    return true;
  }
  appendChild(c) { this.children.push(c); return c; }
  prepend() {} append() {} insertBefore(c) { return c; } removeChild(c) { return c; } remove() {}
  replaceChildren() {} insertAdjacentHTML() {} insertAdjacentElement() {}
  setAttribute() {} getAttribute() { return null; } removeAttribute() {} hasAttribute() { return false; }
  toggleAttribute() {}
  querySelector() { return null; } querySelectorAll() { return []; } closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10 }; }
  focus() {} blur() {} click() {} scrollIntoView() {}
}

const BASE = 'http://test/';
/** An <audio> element with just enough of the media element model for the engine. */
class FakeMedia extends FakeEl {
  constructor(id = '') {
    super('audio', id);
    this._src = '';
    this.currentTime = 0;
    this.paused = true;
    this.volume = 1;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.preservesPitch = true;
    this.readyState = 0;
    this.networkState = 0;
    this.error = null;
    this.ended = false;
    this.duration = NaN;
    this.seeking = false;
    this.preload = 'auto';
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.loads = 0;
  }
  get src() { return this._src; }
  set src(v) { this._src = v ? new URL(String(v), BASE).href : ''; this._reset(); }
  _reset() {
    // The media element load algorithm: nothing known, back at 0, paused, rate reset.
    this.readyState = 0; this.error = null; this.ended = false; this.duration = NaN;
    this.currentTime = 0; this.paused = true; this.playbackRate = this.defaultPlaybackRate;
  }
  load() { this.loads++; this._reset(); }
  play() {
    if (this.paused) { this.paused = false; this.dispatchEvent(new Event('play')); }
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }
}
/** The deck has its metadata and can play: duration known, `loadedmetadata` + `canplay`. */
function ready(el, dur = 200) {
  el.readyState = 4;
  el.duration = dur;
  el.dispatchEvent(new Event('loadedmetadata'));
  el.dispatchEvent(new Event('loadeddata'));
  el.dispatchEvent(new Event('canplay'));
}

// An AudioParam whose value follows its last scheduled target at once (enough to read
// "where it ends up"), and which records every automation call.
function param(value = 0) {
  return {
    value, ev: [],
    cancelScheduledValues(t) { this.ev.push({ k: 'cancel', t }); },
    cancelAndHoldAtTime(t) { this.ev.push({ k: 'cancel', t }); },
    setValueAtTime(v, t) { this.ev.push({ k: 'set', v, t }); this.value = v; },
    linearRampToValueAtTime(v, t) { this.ev.push({ k: 'lin', v, t }); this.value = v; },
    exponentialRampToValueAtTime(v, t) { this.ev.push({ k: 'exp', v, t }); this.value = v; },
    setTargetAtTime(v, t, tc) { this.ev.push({ k: 'target', v, t, tc }); this.value = v; },
    setValueCurveAtTime(c, t, d) { this.ev.push({ k: 'curve', v: c[c.length - 1], t, d }); this.value = c[c.length - 1]; },
  };
}
const node = (extra = {}) => ({ connect(t) { return t; }, disconnect() {}, ...extra });
class FakeAudioContext {
  constructor() { this.currentTime = 100; this.state = 'running'; this.sampleRate = 48000; this.destination = node(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  createGain() { return node({ gain: param(1) }); }
  createBiquadFilter() { return node({ type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0) }); }
  createDynamicsCompressor() {
    return node({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
  }
  createMediaElementSource(el) { return node({ mediaElement: el }); }
  createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData() {}, getByteTimeDomainData() {} }); }
}

const errors = [];
const allErrors = [];
const realSetTimeout = globalThis.setTimeout; // captured before mock.timers replaces it
const byId = new Map();
const elById = (id) => {
  if (!byId.has(id)) byId.set(id, id === 'audioElement' ? new FakeMedia(id) : new FakeEl('div', id));
  return byId.get(id);
};
const deskEvents = [];
let cachedNames = new Set(); // stream requests for these track names answer with audio
const streamFetches = [];    // names of every /api/player/stream fetch (prefetch downloads)
const heldNames = new Map(); // name → release(): such a download stays in flight until released

let P, Q, store, prefetch;
let G = null; // deskGraph(): the per-deck nodes, captured once the context exists
let deckA, deckB;

before(async () => {
  const doc = new FakeEl('document');
  doc.getElementById = elById;
  doc.querySelector = (s) => (/^#[\w-]+$/.test(s) ? elById(s.slice(1)) : null);
  doc.querySelectorAll = () => [];
  doc.createElement = (tag) => (String(tag).toLowerCase() === 'audio' ? new FakeMedia() : new FakeEl(tag));
  doc.body = new FakeEl('body');
  doc.documentElement = new FakeEl('html');
  doc.activeElement = doc.body;
  doc.visibilityState = 'visible';
  doc.hidden = false;
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.location = { href: BASE, origin: 'http://test', pathname: '/', search: '', hash: '', reload() {} };
  globalThis.history = { pushState() {}, replaceState() {}, back() {}, state: null };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0; // the tempo glide is not under test
  globalThis.cancelAnimationFrame = () => {};
  globalThis.AudioContext = FakeAudioContext;
  globalThis.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };
  let blobSeq = 0;
  globalThis.URL.createObjectURL = () => `blob:${BASE}${++blobSeq}`;
  globalThis.URL.revokeObjectURL = () => {};
  const ls = new Map([
    ['ms_player_engine', 'dj'],
    ['ms_dj_crossfade_sec', '5'],
    ['ms_dj_smart_queue', 'off'],
    ['ms_dj_intro_skip', '0'],
    ['ms_dj_outro_skip_migr', '1'],
  ]);
  globalThis.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: (k) => { ls.delete(k); },
  };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url), BASE);
    if (u.pathname === '/api/player/stream') streamFetches.push(u.searchParams.get('name'));
    if (u.pathname === '/api/player/stream' && heldNames.has(u.searchParams.get('name'))) {
      const name = u.searchParams.get('name');
      await new Promise(res => heldNames.set(name, res));
      heldNames.delete(name);
    }
    if (u.pathname === '/api/player/stream' && cachedNames.has(u.searchParams.get('name'))) {
      const body = new Uint8Array(20480);
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        blob: async () => new Blob([body]), body: null, json: async () => ({}), text: async () => '',
      };
    }
    return {
      ok: false, status: 404, headers: { get: () => 'application/json' },
      json: async () => ({ detail: 'not found' }), text: async () => '{}', blob: async () => new Blob([]), body: null,
    };
  };
  process.on('unhandledRejection', () => {});

  // Timers are ours: the stall watchdog (2 s interval), the crossfade completion timer
  // and every backoff run only when a test advances the clock.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });

  ({ store } = await import('../../static/js/store.js'));
  prefetch = await import('../../static/js/prefetch.js');
  await import('../../static/js/recommendations.js'); // nextTrack imports it dynamically
  P = await import('../../static/js/player_v3.js');
  P.init();
  deckA = elById('audioElement');
  deckB = doc.body.children.find(c => c instanceof FakeMedia);
  Q = await import('../../static/js/queue.js');
  // As app.js wires them: the queue panel reaches the engine through these refs.
  Q.setPlayerRefs({ loadAndPlay: P.loadAndPlay, hidePlayerBar: P.hidePlayerBar,
    saveQueueDebounced: P.saveQueueDebounced, audio: P.audio, getAudio: P.getAudio });
  document.addEventListener('desk:engine', (e) => deskEvents.push({ ...e.detail, at: snapshot() }));
});


// ── Helpers ─────────────────────────────────────────────────────────────────
/** Let promise chains and dynamic imports settle. setImmediate and the real setTimeout
 *  are not mocked; real time is needed because with a module hook registered every
 *  dynamic import() (nextTrack and loadAndPlay make one) is resolved on the hooks thread. */
async function flush(rounds = 3) {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 10; i++) await new Promise(res => setImmediate(res));
    await new Promise(res => realSetTimeout(res, 3));
  }
}
const el = (k) => (k === 'A' ? deckA : deckB);
const other = (k) => (k === 'A' ? 'B' : 'A');
const gainOf = (k) => G.nodes[k].gain.gain;
/** The state of both decks at a moment (taken inside desk:engine listeners too). */
function snapshot() {
  const s = {};
  for (const k of ['A', 'B']) {
    const d = el(k);
    s[k] = { paused: d.paused, src: d.src, volume: d.volume, gain: G ? gainOf(k).value : null,
             level: G ? G.nodes[k].levelGain.gain.value : null, currentTime: d.currentTime };
  }
  return s;
}
let seq = 0;
const tracks = (n) => { const tag = `s${++seq}-`; return Array.from({ length: n }, (_, i) => ({ name: `${tag}${i}`, artist: 'a' })); };
const lastEvent = (type) => [...deskEvents].reverse().find(e => e.type === type) || null;

/** A known starting point: queue of n, queue[idx] playing on the active deck from a
 *  cold start, 30 s in, desk untouched. Drives the engine only through its exports. */
async function fresh({ n = 5, idx = 0, dur = 200, volume = 0.6 } = {}) {
  // Let any load a previous test left waiting finish (canplay / cache waits / their
  // timeouts), so it cannot hold the decks (_loadsPending) into this test.
  for (const d of [deckA, deckB]) if (d.src && d.readyState === 0) ready(d, dur);
  for (const h of heldNames.values()) if (typeof h === 'function') h();
  heldNames.clear();
  await flush(1);
  mock.timers.tick(4100);
  await flush(1);
  P.deskRelease();
  P.deskSetManual(false);
  P.deskSetNext(null);
  Object.assign(store, { castDevice: null, remoteTarget: null, shuffleEnabled: false, repeatMode: 'off', radioMode: false });
  Q.resetShuffleOrder();
  deckA.pause(); deckB.pause(); // a paused active deck → the next load is a cold start
  store.playerQueue = tracks(n);
  store.playerIndex = idx;
  await P.loadAndPlay();
  await flush();
  G = G || P.deskGraph();
  const a = el(P.deskInfo().active);
  ready(a, dur);
  a.currentTime = 30;
  P.setVolume(volume);
  mock.timers.tick(600); // clear nextTrack's 500 ms user-skip throttle
  await flush();
  deskEvents.length = 0;
  prefetch.resumePrefetch();
  return a;
}
/** Make queue[i] a cached blob, as prefetch would have it by the time it plays. */
async function cache(i) {
  const it = store.playerQueue[i];
  cachedNames.add(it.name);
  prefetch.resumePrefetch();
  prefetch.prefetchTrack(it.name, it.artist, it.id);
  for (let k = 0; k < 50 && !prefetch.getCachedUrl(it.name, it.artist, it.id); k++) await flush(2);
  assert.ok(prefetch.getCachedUrl(it.name, it.artist, it.id), `queue[${i}] is cached`);
}
/** Lend the inactive deck and load queue[i] onto it, playing. Returns its key. */
async function lendAndLoad(i, { dur = 180 } = {}) {
  const key = P.deskLend();
  assert.ok(key, 'deskLend lends a deck');
  const p = P.deskLoad(store.playerQueue[i], { index: i });
  ready(el(key), dur);
  assert.equal(await p, true, 'deskLoad resolves true');
  return key;
}
/** The track name the ACTIVE deck element is really loaded with ('' for a blob). Not
 *  deskInfo().items, which is derived from store.playerIndex and cannot tell. */
function activeSrcName() {
  const src = el(P.deskInfo().active).src;
  try { return new URL(src).searchParams.get('name') || ''; } catch { return ''; }
}
/** Let an engine load that waits on the incoming deck finish. */
async function finishLoad(key, dur = 200) { await flush(); if (el(key).src && el(key).readyState === 0) ready(el(key), dur); await flush(); }
/** Put the active deck `secLeft` seconds before its end and fire its timeupdate. */
function nearEnd(deck, secLeft = 3) {
  deck.currentTime = deck.duration - secLeft;
  deck.dispatchEvent(new Event('timeupdate'));
}

beforeEach(() => { errors.length = 0; });

// ── 1. Isolation: a lent deck is silent in the master and out of the fader's reach ──
test('lend + load: the lent deck stays at crossfade gain 0 and element volume 1', async () => {
  const active = await fresh();
  const lentKey = other(P.deskInfo().active);
  // A fade torn down mid-ramp can leave the inactive deck's gain anywhere.
  gainOf(lentKey).value = 0.5;
  const key = await lendAndLoad(2);
  assert.equal(key, lentKey, 'the INACTIVE deck is lent');
  assert.equal(gainOf(key).value, 0, 'nothing of the lent deck reaches the master');
  assert.ok(gainOf(key).ev.slice(-20).every(e => !(e.v > 0)), 'no automation raises the lent gain');
  assert.equal(el(key).volume, 1);
  assert.equal(el(key).paused, false, 'the lent deck plays (into the cue bus)');
  assert.notEqual(el(key), active);
});

test('lend + load: the active deck keeps its gain, volume, position and source', async () => {
  const active = await fresh();
  const k = P.deskInfo().active;
  active.currentTime = 77;
  const before = { gain: gainOf(k).value, volume: active.volume, t: active.currentTime, src: active.src, paused: active.paused };
  await lendAndLoad(3);
  assert.deepEqual(
    { gain: gainOf(k).value, volume: active.volume, t: active.currentTime, src: active.src, paused: active.paused },
    before);
  assert.equal(P.deskInfo().active, k);
  assert.equal(store.playerIndex, 0);
});

test('setVolume during a loan changes the active deck only', async () => {
  const active = await fresh();
  const key = await lendAndLoad(2);
  P.setVolume(0.3);
  assert.equal(active.volume, 0.3);
  assert.equal(el(key).volume, 1, 'the master fader does not reach the lent deck');
});

test('the lent deck cannot drive the engine: its ended / error / timeupdate are ignored', async () => {
  const active = await fresh();
  const key = await lendAndLoad(2);
  const d = el(key);
  d.currentTime = 178; d.dispatchEvent(new Event('timeupdate'));
  d.ended = true; d.paused = true; d.dispatchEvent(new Event('ended'));
  d.error = { code: 4 }; d.dispatchEvent(new Event('error'));
  assert.equal(P.deskInfo().busy, false, 'no advance, no error backoff');
  await flush();
  assert.equal(store.playerIndex, 0);
  assert.equal(P.deskInfo().active, other(key));
  assert.equal(active.paused, false);
});

test('deskLoad({startAt}) seeks the lent deck once its metadata is known', async () => {
  await fresh();
  const key = P.deskLend();
  const p = P.deskLoad(store.playerQueue[2], { startAt: 61.25, index: 2 });
  ready(el(key), 180);
  assert.equal(await p, true);
  assert.equal(el(key).currentTime, 61.25);
  assert.equal(P.deskInfo().loanIndex, 2);
});

test('a second deskLoad supersedes the first: the first one\'s cue point is dropped', async () => {
  await fresh();
  const key = P.deskLend();
  const p1 = P.deskLoad(store.playerQueue[2], { startAt: 61.25 });
  const p2 = P.deskLoad(store.playerQueue[3], { startAt: 0 });
  ready(el(key), 180);
  assert.equal(await p1, false, 'the superseded load reports false');
  assert.equal(await p2, true);
  assert.equal(el(key).currentTime, 0);
  assert.equal(P.deskInfo().items[key], store.playerQueue[3]);
});

test('setVolume skips the lent deck whichever physical deck it is (A lent, B live)', async () => {
  await fresh();
  // Make B the live deck: a manual mix into it, committed.
  await lendAndLoad(2);
  assert.equal(P.deskBeginMix(), true);
  assert.equal(P.deskEndMix(true), true);
  assert.equal(P.deskInfo().active, 'B', 'precondition');
  const key = await lendAndLoad(3);
  assert.equal(key, 'A');
  P.setVolume(0.35);
  assert.equal(deckB.volume, 0.35);
  assert.equal(deckA.volume, 1);
});

// ── 2. Any load takes the deck back ──
test('nextTrack takes the lent deck back: revoked/advance, paused, emptied, master volume, gain 0', async () => {
  await fresh({ volume: 0.6 });
  const key = await lendAndLoad(3);
  P.nextTrack({ reason: 'user' });
  await flush();
  const ev = lastEvent('revoked');
  assert.ok(ev, 'desk:engine revoked fired');
  assert.equal(ev.reason, 'advance');
  assert.equal(ev.key, key);
  assert.equal(ev.at[key].paused, true, 'the lent deck is paused');
  assert.equal(ev.at[key].src, '', 'its source is cleared');
  assert.equal(ev.at[key].volume, 0.6, 'it carries the master volume again');
  assert.equal(ev.at[key].gain, 0, 'its crossfade gain is 0');
  assert.equal(P.deskInfo().loan, null);
  await finishLoad(key);
  assert.equal(store.playerIndex, 1, 'the advance itself went ahead');
});

test('a direct loadAndPlay (a queue row) takes the lent deck back too', async () => {
  await fresh();
  const key = await lendAndLoad(2);
  store.playerIndex = 4;
  const p = P.loadAndPlay();
  const ev = lastEvent('revoked');
  assert.ok(ev && ev.reason === 'advance' && ev.key === key, 'revoked synchronously at the start of the load');
  assert.equal(P.deskInfo().loan, null);
  await flush(); await finishLoad(key); await p;
});

test('playRecTrack takes the lent deck back', async () => {
  await fresh();
  const key = await lendAndLoad(2);
  P.playRecTrack({ name: 'rec-x', artist: 'r' });
  const ev = lastEvent('revoked');
  assert.ok(ev && ev.reason === 'advance' && ev.key === key);
  assert.equal(P.deskInfo().loan, null);
  await flush();
});

// ── 3. When the engine needs the deck, it is not lent ──
test('deskLend is refused while an advance is in flight (mid nextTrack)', async () => {
  const active = await fresh();
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await flush(); // the load now waits for the incoming deck to be able to play
  assert.equal(P.deskInfo().busy, true, 'precondition: the advance holds the latch');
  assert.equal(P.deskLend(), null);
  await finishLoad(inKey);
  assert.ok(active);
});

test('deskLend is refused while the engine crossfades', async () => {
  await fresh();
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey);
  const info = P.deskInfo();
  assert.equal(info.crossfading, true, 'precondition: a transition is running');
  assert.equal(info.busy, false, 'precondition: the advance latch is released');
  assert.equal(P.deskLend(), null);
});

test('deskLend is refused while casting and while controlling another device', async () => {
  await fresh();
  store.castDevice = { id: 'dlna-1', name: 'Onkyo' };
  assert.equal(P.deskLend(), null, 'cast');
  store.castDevice = null;
  store.remoteTarget = { id: 'phone' };
  assert.equal(P.deskLend(), null, 'remote');
  store.remoteTarget = null;
  assert.ok(P.deskLend(), 'lends again once neither is set');
});

test('deskLend is refused while a recommendation plays outside the queue', async () => {
  await fresh();
  P.playRecTrack({ name: 'rec-y', artist: 'r' });
  await flush();
  assert.equal(P.deskInfo().blocked, 'rec');
  assert.equal(P.deskLend(), null);
});

test('the stall watchdog revokes an existing loan once casting starts', async () => {
  await fresh();
  const key = await lendAndLoad(2);
  store.castDevice = { id: 'dlna-1', name: 'Onkyo' };
  try {
    mock.timers.tick(2000); // the watchdog's interval
    const ev = lastEvent('revoked');
    assert.ok(ev, 'revoked fired');
    assert.equal(ev.reason, 'cast');
    assert.equal(ev.key, key);
    assert.equal(P.deskInfo().loan, null);
  } finally { store.castDevice = null; }
});

// ── 4. Manual mode ──
test('manual mode: a timeupdate near the end does not start the transition', async () => {
  const active = await fresh();
  P.deskSetManual(true);
  nearEnd(active, 3);
  assert.equal(P.deskInfo().busy, false, 'no advance was started');
  await flush();
  assert.equal(store.playerIndex, 0);
});

test('auto mode, same setup: a timeupdate near the end starts the transition', async () => {
  const active = await fresh();
  const inKey = other(P.deskInfo().active);
  nearEnd(active, 3);
  assert.equal(P.deskInfo().busy, true, 'the auto-trigger asked for the next track');
  await finishLoad(inKey);
  assert.equal(store.playerIndex, 1);
});

test('manual mode: an `ended` on the active deck still advances (the music never stops)', async () => {
  const active = await fresh();
  P.deskSetManual(true);
  active.currentTime = active.duration; active.ended = true; active.paused = true;
  active.dispatchEvent(new Event('ended'));
  assert.equal(P.deskInfo().busy, true, 'the ended path asked for the next track');
  await flush();
  await finishLoad(other(P.deskInfo().active));
  assert.equal(store.playerIndex, 1);
});

// ── 5. A next track picked by hand ──
test('deskSetNext(i) becomes the one answer for "what plays next"', async () => {
  await fresh({ n: 6 });
  assert.equal(P.deskSetNext(4), true);
  const info = P.deskInfo();
  assert.equal(info.next, 4);
  assert.equal(info.deskNext, 4);
});

test('the commit plays the hand-picked track, then the override is consumed', async () => {
  await fresh({ n: 6 });
  P.deskSetNext(4);
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey);
  assert.equal(store.playerIndex, 4);
  const info = P.deskInfo();
  assert.equal(info.deskNext, null, 'consumed');
  assert.equal(info.next, 5, 'back to the ordinary successor');
  // ...and it stays consumed once the picked track is over.
  mock.timers.tick(600);
  const inKey2 = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey2);
  assert.equal(store.playerIndex, 5);
  assert.equal(P.deskInfo().deskNext, null);
  assert.equal(P.deskInfo().next, null, 'end of the queue, not back to queue[4]');
});

test('deskSetNext under shuffle moves the track to the head of the shuffle order', async () => {
  await fresh({ n: 8 });
  store.shuffleEnabled = true;
  Q.resetShuffleOrder();
  const order = Q.playOrder();
  const pick = order[order.length - 1]; // the track the permutation plays last
  assert.notEqual(Q.peekShuffleNext(), pick, 'precondition');
  assert.equal(P.deskSetNext(pick), true);
  assert.equal(Q.peekShuffleNext(), pick);
  assert.equal(P.deskInfo().deskNext, null, 'no override: the permutation carries it');
  assert.equal(P.deskInfo().next, pick);
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey);
  assert.equal(store.playerIndex, pick);
});

test('a hand-picked next track is re-found by identity after a queue edit', async () => {
  await fresh({ n: 6 });
  const picked = store.playerQueue[4];
  P.deskSetNext(4);
  store.playerQueue.splice(2, 1); // a row above it is removed
  assert.equal(P.deskInfo().next, 3);
  assert.equal(store.playerQueue[P.deskInfo().next], picked);
});

// ── 6. The manual crossfader ──
async function beginMix(k = 2) {
  const active = await fresh({ n: 5 });
  const oldKey = P.deskInfo().active;
  const key = await lendAndLoad(k);
  assert.equal(P.deskBeginMix(), true);
  return { active, oldKey, key };
}

test('deskBeginMix: the lent deck is live at once, as a transition in progress', async () => {
  const { oldKey, key } = await beginMix(2);
  const info = P.deskInfo();
  assert.equal(info.active, key);
  assert.equal(info.fading, oldKey);
  assert.equal(store.playerIndex, 2);
  assert.equal(info.crossfading, true);
  assert.equal(info.mixing, true);
  assert.equal(info.loan, null);
  assert.equal(el(key).volume, el(oldKey).volume, 'the master volume applies to the new live deck');
});

test('deskMixLevel(t) schedules equal-power targets on both crossfade gains', async () => {
  const { oldKey, key } = await beginMix(2);
  assert.equal(P.deskMixLevel(0.25), true);
  const last = (k) => [...gainOf(k).ev].reverse().find(e => e.k === 'target');
  assert.ok(Math.abs(last(key).v - Math.sin(0.25 * Math.PI / 2)) < 1e-9, `incoming ${last(key).v}`);
  assert.ok(Math.abs(last(oldKey).v - Math.cos(0.25 * Math.PI / 2)) < 1e-9, `outgoing ${last(oldKey).v}`);
  assert.equal(P.deskInfo().mixLevel, 0.25);
});

test('deskEndMix(true): the old deck stops, the new one stays at full gain', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.6);
  assert.equal(P.deskEndMix(true), true);
  assert.equal(el(oldKey).paused, true);
  assert.equal(el(oldKey).src, '');
  assert.equal(gainOf(oldKey).value, 0);
  assert.equal(gainOf(key).value, 1);
  assert.equal(el(key).paused, false);
  const info = P.deskInfo();
  assert.equal(info.crossfading, false);
  assert.equal(info.mixing, false);
  assert.equal(info.active, key);
  assert.equal(store.playerIndex, 2);
  assert.equal(lastEvent('mixend').commit, true);
});

test('deskEndMix(false): the previous track is live again and the new deck is lent again', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.6);
  assert.equal(P.deskEndMix(false), true);
  const info = P.deskInfo();
  assert.equal(info.active, oldKey);
  assert.equal(store.playerIndex, 0);
  assert.equal(info.loan, key);
  assert.equal(info.crossfading, false);
  assert.equal(info.mixing, false);
  assert.equal(gainOf(oldKey).value, 1);
  assert.equal(gainOf(key).value, 0, 'the lent deck is silent in the master again');
  assert.equal(el(key).volume, 1);
  assert.equal(el(key).paused, false, 'still playing in the headphones');
  assert.equal(lastEvent('mixend').commit, false);
});

test('pausing during a manual mix past half the fader ends it as a commit (_finalizeCrossfadeOnPause)', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.7);
  elById('playerPlayPause').dispatchEvent(new Event('click'));
  const ev = lastEvent('mixend'); // read BEFORE deskInfo(), which would notice a stale mix itself
  assert.ok(ev, 'the desk hears at once that the mix ended');
  assert.equal(ev.commit, true);
  assert.equal(ev.superseded, undefined, 'ended by the pause, not discovered later');
  const info = P.deskInfo();
  assert.equal(info.mixing, false);
  assert.equal(info.crossfading, false);
  assert.equal(info.active, key);
  assert.equal(el(oldKey).src, '', 'the old deck is stopped');
  assert.equal(el(key).paused, true, 'and the live one paused');
});

test('pausing during a manual mix before half the fader takes it back: the old track stays, paused', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.2);
  elById('playerPlayPause').dispatchEvent(new Event('click'));
  const ev = lastEvent('mixend');
  assert.ok(ev && ev.commit === false, 'settled by the fader: taken back');
  const info = P.deskInfo();
  assert.equal(info.mixing, false);
  assert.equal(info.active, oldKey, 'the track the audience mostly heard is live again');
  assert.equal(el(oldKey).paused, true, 'and paused');
  assert.equal(info.loan, key, 'the new deck is back on the desk');
});

test('the OUTGOING deck ending mid-mix commits the mix (a take-back would be silence)', async () => {
  const { oldKey, key } = await beginMix(2);
  const o = el(oldKey);
  o.ended = true; o.paused = true;
  o.dispatchEvent(new Event('ended'));
  assert.equal(P.deskInfo().mixing, false);
  assert.equal(P.deskInfo().active, key);
  assert.equal(lastEvent('mixend').commit, true);
});

test('taking a mix back onto a deck that already ended commits instead', async () => {
  const { oldKey, key } = await beginMix(2);
  el(oldKey).ended = true;
  P.deskEndMix(false);
  assert.equal(P.deskInfo().active, key);
  assert.equal(lastEvent('mixend').commit, true);
});

test('the new track ending mid-mix ends the mix and advances', async () => {
  const { key } = await beginMix(2);
  const d = el(key);
  d.currentTime = d.duration; d.ended = true; d.paused = true;
  d.dispatchEvent(new Event('ended'));
  assert.equal(P.deskInfo().mixing, false);
  assert.equal(lastEvent('mixend').commit, true);
  assert.equal(P.deskInfo().busy, true, 'the next track was asked for');
  await flush();
  await finishLoad(other(P.deskInfo().active));
  assert.equal(store.playerIndex, 3);
});

// ── 7. deskMixNow and its start position ──
test('deskMixNow({startAt}) with a cached next track starts it at the cue point', async () => {
  await fresh({ n: 5 });
  await cache(1);
  const inKey = other(P.deskInfo().active);
  assert.equal(P.deskMixNow({ startAt: 42.5 }), true);
  await flush();
  assert.equal(store.playerIndex, 1);
  assert.equal(P.deskInfo().active, inKey, 'the engine transition swapped decks');
  assert.ok(el(inKey).src.startsWith('blob:'), 'precondition: the incoming deck plays the cached blob');
  ready(el(inKey), 200); // its metadata arrives: the transition's pending seek lands
  assert.equal(el(inKey).currentTime, 42.5);
});

test('deskMixNow\'s start position is not used by a later, unrelated transition', async () => {
  await fresh({ n: 5 });
  await cache(1);
  await cache(2);
  P.deskMixNow({ startAt: 42.5 });
  await flush();
  ready(el(P.deskInfo().active), 200);
  mock.timers.tick(600);
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await flush();
  assert.equal(store.playerIndex, 2);
  ready(el(inKey), 200);
  assert.equal(el(inKey).currentTime, 0, 'intro skip setting "0" — no cue point');
});

test('deskMixNow\'s start position dies with its load: a load that supersedes it does not inherit it', async () => {
  await fresh({ n: 5 });
  await cache(3);
  const inKey = other(P.deskInfo().active);
  assert.equal(P.deskMixNow({ startAt: 42.5 }), true); // queue[1] is NOT cached: the load waits
  await flush();
  assert.equal(P.deskInfo().busy, true, 'precondition: the desk\'s load is waiting');
  store.playerIndex = 3; // the user starts another row meanwhile (no latch for that)
  const p = P.loadAndPlay();
  await flush();
  ready(el(inKey), 200);
  await flush(); await p;
  assert.equal(store.playerIndex, 3);
  assert.equal(P.deskInfo().active, inKey);
  assert.equal(el(inKey).currentTime, 0, 'not 42.5');
});

test('deskMixNow takes a lent deck back first (reason "mixnow")', async () => {
  await fresh({ n: 5 });
  const key = await lendAndLoad(3);
  assert.equal(P.deskMixNow(), true);
  const ev = deskEvents.find(e => e.type === 'revoked');
  assert.ok(ev, 'revoked fired');
  assert.equal(ev.reason, 'mixnow');
  assert.equal(ev.key, key);
  await flush();
  await finishLoad(key);
  assert.equal(store.playerIndex, 1);
});

test('deskMixNow is refused when nothing is playing or nothing comes next', async () => {
  const active = await fresh({ n: 2, idx: 1 });
  assert.equal(P.deskMixNow({ startAt: 10 }), false, 'last track, repeat off');
  store.repeatMode = 'all';
  active.pause();
  assert.equal(P.deskMixNow({ startAt: 10 }), false, 'paused');
  store.repeatMode = 'off';
});

// ── 8. Untouched desk = old behaviour ──
test('with no loan, setVolume writes both decks', async () => {
  await fresh();
  P.setVolume(0.42);
  assert.equal(deckA.volume, 0.42);
  assert.equal(deckB.volume, 0.42);
});

test('deskRelease gives the deck back with the master volume', async () => {
  await fresh({ volume: 0.7 });
  const key = await lendAndLoad(2);
  P.deskRelease();
  const ev = lastEvent('revoked');
  assert.equal(ev.reason, 'release');
  assert.equal(el(key).paused, true);
  assert.equal(el(key).src, '');
  assert.equal(el(key).volume, 0.7);
  assert.equal(P.deskInfo().loan, null);
});

// ── Found by these tests and fixed (2026-11-19): direct volume writes, a served pick ──
// setVolume() honours the loan, but four other places in player_v3.js write the master
// volume straight onto BOTH elements and so onto the lent deck as well: the player-bar
// slider (#playerVolume `input`), the ArrowUp/ArrowDown shortcuts, applyRemoteCommand
// ('volume') and loadQueueState. The cue level then follows the master fader.
test('the player-bar volume slider does not reach the lent deck', async () => {
  const active = await fresh();
  const key = await lendAndLoad(2);
  elById('playerVolume').dispatchEvent({ type: 'input', target: { value: '30' } });
  assert.equal(active.volume, 0.3);
  assert.equal(el(key).volume, 1);
});

test('the ArrowDown volume shortcut does not reach the lent deck', async () => {
  const active = await fresh();
  const key = await lendAndLoad(2);
  store.playerVolume = 0.6;
  document.dispatchEvent({ type: 'keydown', code: 'ArrowDown', preventDefault() {} });
  assert.ok(Math.abs(active.volume - 0.55) < 1e-9, `active ${active.volume}`);
  assert.equal(el(key).volume, 1);
});

test('a remote volume command does not reach the lent deck', async () => {
  const active = await fresh();
  const key = await lendAndLoad(2);
  P.applyRemoteCommand('volume', 0.25);
  assert.equal(active.volume, 0.25);
  assert.equal(el(key).volume, 1);
});

test('a hand-picked next track that was then played by hand is not played a second time', async () => {
  await fresh({ n: 6 });
  P.deskSetNext(3);
  const settle = async (p) => {
    let done = false; p.then(() => { done = true; });
    for (let i = 0; i < 30 && !done; i++) {
      await flush(1);
      for (const d of [deckA, deckB]) if (d.src && d.readyState === 0) ready(d, 200);
      mock.timers.tick(200); // cache waits poll on a timer
    }
    assert.ok(done, 'the load finished');
  };
  store.playerIndex = 3; await settle(P.loadAndPlay()); // the DJ taps row 3 instead
  store.playerIndex = 5; await settle(P.loadAndPlay()); // ...then row 5
  assert.equal(P.deskInfo().deskNext, null, 'the override was fulfilled when queue[3] played');
  assert.notEqual(P.deskInfo().next, 3);
});

// ── Review follow-ups (2026-11-19, second round) ──
// 1. A load that is not an advance (a queue row) holds no latch, yet it has the
//    inactive deck loaded while it waits: that deck is not the desk's to borrow.
test('deskLend is refused while a queue-row load waits for its (uncached) track', async () => {
  await fresh();
  const inKey = other(P.deskInfo().active);
  store.playerIndex = 3;
  const p = P.loadAndPlay();
  await flush();
  assert.equal(P.deskInfo().busy, false, 'precondition: a row load takes no advance latch');
  assert.ok(el(inKey).src.includes('name=' + encodeURIComponent(store.playerQueue[3].name)), 'precondition: the incoming deck is loaded and waiting');
  assert.equal(P.deskLend(), null);
  ready(el(inKey), 200);
  await flush(); await p;
  assert.equal(P.deskInfo().active, inKey);
  assert.equal(el(inKey).paused, false, 'the row\'s track plays');
});

test('a row load waiting on a download in flight: no loan meanwhile, the track arrives as a blob, setVolume reaches it', async () => {
  await fresh();
  const it = store.playerQueue[3];
  cachedNames.add(it.name);
  heldNames.set(it.name, null);
  prefetch.resumePrefetch();
  prefetch.prefetchTrack(it.name, it.artist, it.id);
  await flush();
  const inKey = other(P.deskInfo().active);
  store.playerIndex = 3;
  const p = P.loadAndPlay(); // waits in waitForCache (polled on the mocked clock)
  await flush();
  const k = P.deskLend();
  assert.equal(k, null, 'nothing is lent while the load waits');
  heldNames.get(it.name)?.();
  for (let i = 0; i < 10 && P.deskInfo().active !== inKey; i++) { await flush(1); mock.timers.tick(200); }
  await flush(); await p;
  assert.equal(P.deskInfo().active, inKey);
  assert.ok(el(inKey).src.startsWith('blob:'), 'the incoming deck plays the downloaded blob');
  assert.equal(P.deskInfo().loan, null);
  P.setVolume(0.4);
  assert.equal(el(inKey).volume, 0.4, 'the live deck follows the master fader');
});

// The two safety nets (_startCrossfade, _setDeckSrc revoke a loan on the deck they load)
// cannot be reached while deskLend refuses during a pending load; these pin what they
// must do if a loan exists anyway. With the deskLend guard in place `k` is null and only
// the outcome is checked; the mutation report runs them with that guard removed.
async function loanDuringPendingLoad({ cachedWait }) {
  await fresh();
  const it = store.playerQueue[3];
  if (cachedWait) {
    cachedNames.add(it.name);
    heldNames.set(it.name, null);
    prefetch.resumePrefetch();
    prefetch.prefetchTrack(it.name, it.artist, it.id);
    await flush();
  }
  const inKey = other(P.deskInfo().active);
  store.playerIndex = 3;
  const p = P.loadAndPlay();
  await flush();
  const k = P.deskLend();
  if (k) { const lp = P.deskLoad({ name: `cue-${++seq}`, artist: 'c' }, { warm: false }); ready(el(k), 100); await lp; }
  if (cachedWait) heldNames.get(it.name)?.();
  for (let i = 0; i < 15 && P.deskInfo().active !== inKey; i++) {
    await flush(1);
    if (!cachedWait && el(inKey).src && el(inKey).readyState === 0) ready(el(inKey), 200);
    mock.timers.tick(200);
  }
  await flush(); await p;
  return { k, inKey };
}
for (const cachedWait of [true, false]) {
  test(`if a loan exists when a ${cachedWait ? 'cached' : 'live-stream'} load reaches its deck, it is revoked first and the track still plays`, async () => {
    const { k, inKey } = await loanDuringPendingLoad({ cachedWait });
    if (k) {
      const ev = deskEvents.find(e => e.type === 'revoked' && e.key === k);
      assert.ok(ev && ev.reason === 'advance', 'revoked (advance) before the engine used the deck');
    }
    assert.equal(P.deskInfo().active, inKey);
    assert.equal(P.deskInfo().loan, null);
    assert.ok(el(inKey).src.includes(cachedWait ? 'blob:' : 'name=' + encodeURIComponent(store.playerQueue[3].name)), `the live deck holds queue[3]: ${el(inKey).src}`);
    assert.equal(el(inKey).paused, false, 'and plays');
    P.setVolume(0.4);
    assert.equal(el(inKey).volume, 0.4, 'the live deck follows the master fader');
  });
}

// 2. An engine load during a hand mix settles the mix by the fader first.
test('nextTrack during a hand mix with the fader below half: taken back first (commit false)', async () => {
  const { oldKey } = await beginMix(2);
  P.deskMixLevel(0.3);
  mock.timers.tick(600);
  P.nextTrack({ reason: 'user' });
  await flush();
  const ev = deskEvents.find(e => e.type === 'mixend');
  assert.ok(ev, 'mixend fired');
  assert.equal(ev.commit, false, 'the track the audience mostly heard was live when the load started');
  assert.equal(P.deskInfo().mixing, false);
  await finishLoad('A'); await finishLoad('B');
});

test('nextTrack during a hand mix with the fader below half then moves on from the old track', async () => {
  await beginMix(2);
  P.deskMixLevel(0.3);
  mock.timers.tick(600);
  P.nextTrack({ reason: 'user' });
  await flush();
  await finishLoad('A'); await finishLoad('B');
  assert.equal(store.playerIndex, 3, 'next after the track the index named when Next was pressed');
  assert.equal(activeSrcName(), store.playerQueue[3].name, 'the live deck element really holds queue[3]');
  assert.equal(el(P.deskInfo().active).paused, false, 'and plays');
  assert.equal(P.deskInfo().busy, false, 'the load finished');
});

test('nextTrack during a hand mix with the fader at half or more: committed', async () => {
  const { key } = await beginMix(2);
  P.deskMixLevel(0.5);
  mock.timers.tick(600);
  P.nextTrack({ reason: 'user' });
  await flush();
  const ev = deskEvents.find(e => e.type === 'mixend');
  assert.ok(ev, 'mixend fired');
  assert.equal(ev.commit, true);
  await finishLoad(other(P.deskInfo().active)); await finishLoad(key);
  assert.equal(store.playerIndex, 3, 'next after the mixed-in track');
});

test('a queue row picked during a hand mix (fader below half) plays THAT row', async () => {
  await beginMix(2);
  P.deskMixLevel(0.2);
  store.playerIndex = 4;
  const p = P.loadAndPlay();
  await flush();
  await finishLoad('A'); await finishLoad('B'); await p;
  assert.equal(store.playerIndex, 4, 'the take-back must not rewrite the index the caller chose');
  assert.equal(activeSrcName(), store.playerQueue[4].name, 'the live deck element really holds queue[4]');
  assert.equal(el(P.deskInfo().active).paused, false, 'and plays');
});

// 3. A deck failing during a hand mix.
test('the NEW deck failing during a hand mix: the old track stays live, the loan is revoked (error), no skip', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.6);
  el(key).error = { code: 4 };
  el(key).dispatchEvent(new Event('error'));
  const info = P.deskInfo();
  assert.equal(info.active, oldKey);
  assert.equal(store.playerIndex, 0);
  assert.equal(info.mixing, false);
  assert.equal(info.loan, null);
  const rv = lastEvent('revoked');
  assert.ok(rv && rv.reason === 'error' && rv.key === key, 'revoked with reason error');
  assert.equal(info.busy, false, 'no skip, no error backoff');
  assert.equal(el(oldKey).paused, false, 'the old track keeps playing');
  assert.equal(gainOf(oldKey).value, 1);
});

test('the OLD deck failing during a hand mix commits to the new one, no skip', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.2);
  el(oldKey).error = { code: 2 };
  el(oldKey).dispatchEvent(new Event('error'));
  const info = P.deskInfo();
  assert.equal(info.active, key);
  assert.equal(store.playerIndex, 2);
  assert.equal(info.mixing, false);
  assert.equal(lastEvent('mixend').commit, true);
  assert.equal(info.busy, false);
  assert.equal(gainOf(key).value, 1);
});

test('double failure: the new deck errors while the old one already ended — committed, and the skip starts', async () => {
  const { oldKey, key } = await beginMix(2);
  P.deskMixLevel(0.3);
  const o = el(oldKey); o.ended = true; o.paused = true; // ended; its `ended` event already handled or lost
  el(key).error = { code: 4 };
  el(key).dispatchEvent(new Event('error'));
  // This test's own listener errors are reported here, not by the file-wide check below.
  const thrown = errors.map(e => String(e && e.message || e));
  for (const e of errors) allErrors.splice(allErrors.indexOf(e), 1);
  assert.deepEqual(thrown, [], 'the error handler did not throw');
  const info = P.deskInfo();
  assert.equal(info.active, key, 'nothing to go back to: the failing deck is the live one');
  assert.equal(info.mixing, false);
  assert.equal(info.loan, null);
  assert.equal(lastEvent('mixend').commit, true);
  assert.equal(info.busy, true, 'the error skip/backoff started (_skipAfterError)');
});

test('a take-back leaves the cue deck\'s levelGain at 1 (as deskLend leaves it)', async () => {
  const { key } = await beginMix(2);
  G.nodes[key].levelGain.gain.value = 0.5; // a level match applied while it was live
  P.deskMixLevel(0.3);
  assert.equal(P.deskEndMix(false), true);
  assert.equal(P.deskInfo().loan, key);
  assert.equal(G.nodes[key].levelGain.gain.value, 1);
});

// 4. Shuffle: a jump made by hand is recorded in the shuffle history.
async function shuffled(n = 8) {
  await fresh({ n });
  store.shuffleEnabled = true;
  Q.resetShuffleOrder();
  Q.playOrder(); // deal
}
test('shuffle: deskBeginMix records the jump — the left track is history, not upcoming', async () => {
  await shuffled();
  const order = Q.playOrder();
  const target = order[order.length - 1];
  await lendAndLoad(target);
  assert.equal(P.deskBeginMix(), true);
  const s = Q.serializeShuffleOrder();
  assert.ok(s.played.includes(0), 'the left track is in the played history');
  assert.ok(!s.tail.includes(0), 'and is not dealt again');
  assert.ok(!s.tail.includes(target), 'the jumped-to track left the tail');
  assert.equal(Q.shufflePrev(), 0, 'Previous goes back to it');
});

test('shuffle: deskEndMix(false) undoes the recorded jump', async () => {
  await shuffled();
  const order = Q.playOrder();
  const target = order[order.length - 1];
  await lendAndLoad(target);
  P.deskBeginMix();
  P.deskEndMix(false);
  const s = Q.serializeShuffleOrder();
  assert.equal(store.playerIndex, 0);
  assert.ok(!s.played.includes(0), 'the current track is not in its own history');
  assert.ok(s.tail.includes(target), 'the track taken back is upcoming again');
  assert.equal(s.played.length + s.tail.length + 1, 8, 'still a whole permutation');
});

test('shuffle: a forced next to an already-played track records the jump', async () => {
  await shuffled(6);
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey);
  const left = store.playerIndex; // the track playing now, 0 is history
  assert.notEqual(left, 0);
  mock.timers.tick(600);
  assert.equal(P.deskSetNext(0), true);
  assert.equal(P.deskInfo().deskNext, 0, 'an already-played track is an override, not a move');
  const in2 = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(in2);
  assert.equal(store.playerIndex, 0);
  const s = Q.serializeShuffleOrder();
  assert.ok(s.played.includes(left), 'the left track is history');
  assert.ok(!s.tail.includes(left), 'and is not dealt again');
  assert.equal(Q.shufflePrev(), left, 'Previous goes back to it');
});

test('shuffle: taking back a hand mix INTO an already-played track does not deal that track next', async () => {
  await shuffled(6);
  const inKey = other(P.deskInfo().active);
  P.nextTrack({ reason: 'user' });
  await finishLoad(inKey);
  const cur = store.playerIndex;
  assert.notEqual(cur, 0, 'precondition: queue[0] is history now');
  mock.timers.tick(6000); // the engine's crossfade completes
  await flush();
  assert.equal(P.deskInfo().crossfading, false, 'precondition: transition over');
  await lendAndLoad(0); // mix back into the track already played
  assert.equal(P.deskBeginMix(), true);
  P.deskMixLevel(0.2);
  assert.equal(P.deskEndMix(false), true);
  assert.equal(store.playerIndex, cur);
  const s = Q.serializeShuffleOrder();
  assert.ok(!s.tail.includes(0), `queue[0] was never in the tail and is not put there: tail ${s.tail}`);
  assert.notEqual(Q.peekShuffleNext(), 0);
  assert.ok(s.played.includes(0), 'it stays history');
  assert.ok(!s.played.includes(cur), 'the current track is not in its own history');
});

test('shuffle: a take-back restores the shuffle order exactly, also when the current track already topped the history', async () => {
  await shuffled(6);
  // The state a forced jump into an already-played track leaves: the current track is
  // also the last entry of the played history.
  Q.restoreShuffleOrder({ played: [1, 0], tail: [2, 3, 4, 5] });
  const before = Q.serializeShuffleOrder();
  await lendAndLoad(3);
  assert.equal(P.deskBeginMix(), true);
  P.deskMixLevel(0.2);
  assert.equal(P.deskEndMix(false), true);
  const after = Q.serializeShuffleOrder();
  assert.deepEqual(after.played, before.played, 'the history is as it was: undo pops only what the jump pushed');
  assert.deepEqual([...after.tail].sort(), [...before.tail].sort(), 'the same tracks are still to come');
  // Not asserted: the taken-back track returns at the HEAD of the tail (unshift), not at
  // its old place — a reorder the take-back introduces (see the report).
});

// 5. A cue point belongs to the desk's own load only.
test('deskMixNow refused: nothing is armed, the next row load starts at 0', async () => {
  const active = await fresh({ n: 5 });
  await cache(3);
  active.pause();
  assert.equal(P.deskMixNow({ startAt: 42.5 }), false);
  active.play();
  const inKey = other(P.deskInfo().active);
  store.playerIndex = 3;
  const p = P.loadAndPlay();
  await flush(); await p;
  ready(el(inKey), 200);
  assert.equal(el(inKey).currentTime, 0);
});

test('a queue-row load started before deskMixNow\'s own load does not take its cue point', async () => {
  await fresh({ n: 5 });
  await cache(1);
  await cache(3);
  const inKey = other(P.deskInfo().active);
  assert.equal(P.deskMixNow({ startAt: 42.5 }), true); // its nextTrack resolves an import first
  store.playerIndex = 3;                                // a row tapped in that same moment
  const p = P.loadAndPlay();
  ready(el(inKey), 200);
  assert.equal(store.playerQueue[3].name, P.deskInfo().items[P.deskInfo().active]?.name, 'precondition: the row load ran first');
  assert.equal(el(inKey).currentTime, 0, 'the row\'s track starts at 0, not at the desk\'s cue point');
  await flush(); await finishLoad('A'); await finishLoad('B'); await p;
});

test('playRecTrack disarms a pending desk cue point', async () => {
  await fresh({ n: 5 });
  await cache(1);
  assert.equal(P.deskMixNow({ startAt: 42.5 }), true); // armed for queue[1]; its load waits on an import()
  P.playRecTrack({ name: `rec-${++seq}`, artist: 'r' }); // a recommendation is started at that moment
  await flush();
  for (const d of [deckA, deckB]) if (d.src && d.readyState === 0) ready(d, 200);
  await flush();
  mock.timers.tick(600);
  const inKey = other(P.deskInfo().active);
  store.playerIndex = 1; // later the user plays queue[1] from its row
  const p = P.loadAndPlay();
  await flush();
  assert.ok(el(inKey).src.startsWith('blob:'), 'precondition: a cached transition, where a cue point would apply');
  ready(el(inKey), 200);
  await flush(); await p;
  assert.equal(el(inKey).currentTime, 0, 'not the desk\'s 42.5');
});

// 6. A quick listen does not download.
test('deskLoad(item, {warm:false}) starts no prefetch download of that track', async () => {
  await fresh();
  assert.ok(P.deskLend(), 'precondition: a deck is lent');
  const item = { name: `free-${++seq}`, artist: 'z' };
  streamFetches.length = 0;
  const p = P.deskLoad(item, { warm: false });
  // Asked for = queued or in flight at once (download slots may all be busy, so the
  // fetch itself can come later); not asked for = neither, now or after settling.
  assert.equal(prefetch.getStatus(item.name, item.artist), null, 'not handed to prefetch');
  await flush();
  ready(el(P.deskInfo().loan), 120); await p;
  assert.ok(!streamFetches.includes(item.name), `fetched: ${streamFetches.join(', ')}`);
});

test('deskLoad(item) warms by default: a prefetch download of that track starts', async () => {
  await fresh();
  assert.ok(P.deskLend(), 'precondition: a deck is lent');
  const item = { name: `free-${++seq}`, artist: 'z' };
  streamFetches.length = 0;
  const p = P.deskLoad(item);
  const asked = prefetch.getStatus(item.name, item.artist) != null;
  await flush();
  ready(el(P.deskInfo().loan), 120); await p;
  assert.ok(asked || streamFetches.includes(item.name), 'handed to prefetch');
});

// 7. The loan's queue position follows the queue.
test('deskInfo().loanIndex follows the lent track after a queue insert above it', async () => {
  await fresh();
  const item = store.playerQueue[3];
  await lendAndLoad(3);
  store.playerQueue.splice(1, 0, { name: `ins-${++seq}`, artist: 'a' });
  assert.equal(P.deskInfo().loanIndex, 4);
  assert.equal(store.playerQueue[P.deskInfo().loanIndex], item);
});

test('no engine event listener threw during this file', () => {
  assert.deepEqual(allErrors.map(e => String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')), []);
});
