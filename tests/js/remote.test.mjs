// Remote control (device → device): what a CONTROLLER must never do, and what a
// TARGET does with a command. Run: node --test tests/js/remote.test.mjs
//
// The binding protocol is notes/impl/remote-opravy-kontrakt.md; the defects pinned
// here (B1, B2, B5, B6, B11, B12, B18, B20) are described in
// notes/impl/remote-review-2026-11-19.md. In short:
//
//  * A controller is a remote, not a player: no sound from its decks, no change to
//    its saved queue, no write into a Navidrome playlist. Every intent leaves as ONE
//    command to the target.
//  * A target applies a command with its own functions — and a device that is itself
//    controlling stops controlling first, or two devices relay to each other forever.
//
// The real remote.js, player_v3.js, player.js, queue.js, upnext.js and djmix.js run
// here; only the browser (DOM, <audio>, fetch, EventSource) is faked.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

// ── A browser just big enough for the modules to load and run ────────────────
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

class FakeEl extends EventTarget {
  constructor(tag = 'div', id = '') {
    super();
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
    this.dataset = {};
    this.classList = new FakeClassList();
    this.children = [];
    this.attrs = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10 }; }
  focus() {} blur() {} click() {} scrollTo() {} scrollIntoView() {}
}

// An <audio> element that remembers what was done to it.
class FakeAudio extends FakeEl {
  constructor() {
    super('audio');
    this._src = '';
    this.paused = true;
    this.currentTime = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.volume = 1;
    this.error = null;
    this.networkState = 0;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this.preload = 'auto';
    this.log = [];
  }
  get src() { return this._src; }
  set src(v) { this._src = v ? new URL(v, 'http://test.local/').href : ''; this.log.push(['src', this._src]); }
  play() { this.log.push(['play']); this.paused = false; return Promise.resolve(); }
  pause() { this.log.push(['pause']); this.paused = true; }
  load() { this.log.push(['load']); }
  removeAttribute(k) { if (k === 'src') this._src = ''; super.removeAttribute(k); }
}

// Web Audio: any node, any param, any method — enough for the graph to be built.
function anyNode() {
  const own = {};
  return new Proxy(function () {}, {
    get(_, k) {
      if (k === 'then' || typeof k === 'symbol') return undefined;
      if (k in own) return own[k];
      if (k === 'value') return 0;
      return (own[k] = anyNode());
    },
    set(_, k, v) { own[k] = v; return true; },
    apply() { return anyNode(); },
  });
}
class FakeAudioContext {
  constructor() {
    const base = { state: 'running', currentTime: 0, sampleRate: 48000, resume: () => Promise.resolve(), suspend: () => Promise.resolve(), close: () => Promise.resolve() };
    const rest = anyNode();
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : rest[k]), set: (t, k, v) => { t[k] = v; return true; } });
  }
}

const els = new Map();
function elFor(sel) {
  if (!els.has(sel)) els.set(sel, sel === '#audioElement' ? new FakeAudio() : new FakeEl('div', sel.slice(1)));
  return els.get(sel);
}

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

// fetch: every request is recorded; answers come from `serverQueue` and a counter.
const calls = [];
let cmdSeq = 100;
let serverQueue = null;   // what GET /api/player/queue answers
let failCommands = 0;     // the next N POST /api/remote/command answer 404 "Device offline"
let queueCommands = false; // POST /api/remote/command answers 202 {queued: true} (target reconnecting)
function route(url, method) {
  if (url.startsWith('/api/player/stream-token')) return { token: 'st' };
  if (url.startsWith('/api/remote/token')) return { token: 'rt', expires_in: 3600 };
  if (url.startsWith('/api/remote/command')) return queueCommands ? { id: ++cmdSeq, queued: true } : { id: ++cmdSeq };
  if (url.startsWith('/api/player/queue') && method === 'GET') return serverQueue || {};
  if (url.startsWith('/api/remote/queue')) return { queue: [], current_index: -1 };
  return {};
}

// EventSource: tests push `devices` / `command` events through the live instance.
const sources = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

// DOM events the engines dispatch to remote.js (`remote:*`).
const events = [];
const intervals = [];
const timeouts = [];

let store, V3, CL, Q, U, D, R;
let v3Android, classicAndroid;
const deck = () => elFor('#audioElement');

before(async () => {
  globalThis.window = globalThis;
  // The engines start watchdog intervals once a track loads; they must not keep the
  // test process alive after the last test.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const h = realSetInterval(...a); intervals.push(h); return h; };
  // Retries (stream-duration polls, reconnects, skip-lock expiry) are cleared at the end too.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...a) => { const h = realSetTimeout(...a); timeouts.push(h); return h; };
  // Node has a real BroadcastChannel; remote.js's tab-id channel would hold the process open.
  globalThis.BroadcastChannel = undefined;
  const win = new EventTarget();
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  globalThis.dispatchEvent = win.dispatchEvent.bind(win);
  globalThis.location = { href: 'http://test.local/', origin: 'http://test.local', protocol: 'http:', host: 'test.local', pathname: '/' };
  globalThis.localStorage = memStorage({ ms_player_engine: 'dj', ms_device_id: 'dev-self' });
  globalThis.sessionStorage = memStorage({ ms_tab_id: 'tabself' });
  const doc = new EventTarget();
  doc.body = new FakeEl('body');
  doc.documentElement = new FakeEl('html');
  doc.getElementById = (id) => elFor('#' + id);
  doc.querySelector = (sel) => (/^#[\w-]+$/.test(sel) ? elFor(sel) : null);
  doc.querySelectorAll = () => [];
  doc.createElement = (tag) => (String(tag).toLowerCase() === 'audio' ? new FakeAudio() : new FakeEl(tag));
  doc.visibilityState = 'visible';
  doc.hidden = false;
  globalThis.document = doc;
  for (const t of ['remote:play', 'remote:enqueue', 'remote:cmd', 'remote:report', 'remote:queue-saved']) {
    doc.addEventListener(t, (e) => events.push({ type: t, detail: e.detail }));
  }
  globalThis.innerWidth = 400;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.history = { pushState() {}, replaceState() {}, back() {}, state: null };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.EventSource = FakeEventSource;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
    calls.push({ url: String(url), method, body });
    if (String(url).startsWith('/api/remote/command') && failCommands > 0) {
      failCommands--;
      const detail = { detail: 'Device offline' };
      return {
        ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null },
        json: async () => detail, text: async () => JSON.stringify(detail),
      };
    }
    const resp = route(String(url), method);
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      json: async () => resp, text: async () => JSON.stringify(resp), blob: async () => new Blob([]),
    };
  };
  // Lazy imports (recommendations.js, router.js …) may reject here; not under test.
  process.on('unhandledRejection', () => {});

  ({ store } = await import('../../static/js/store.js'));
  store.authToken = 'session';
  store.currentUser = { username: 'claude_test' };

  // Both engines set window._androidMediaAction at import; keep each one's.
  CL = await import('../../static/js/player.js');
  classicAndroid = window._androidMediaAction;
  V3 = await import('../../static/js/player_v3.js');
  v3Android = window._androidMediaAction;
  Q = await import('../../static/js/queue.js');
  U = await import('../../static/js/upnext.js');
  D = await import('../../static/js/djmix.js');
  R = await import('../../static/js/remote.js');
});

after(() => {
  try { R.stopRemote(); } catch {}
  clearTimeout(store.playerSaveTimer);
  for (const h of intervals) clearInterval(h);
  for (const h of timeouts) clearTimeout(h);
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(0); };
const tracks = (...names) => names.map(n => ({ name: n, artist: `${n}-artist`, album: 'Alb', image: '', duration_ms: 200000 }));
const nowS = () => Date.now() / 1000;
const es = () => sources[sources.length - 1];
const remoteCmds = () => calls.filter(c => c.url.startsWith('/api/remote/command'));
const libraryWrites = () => calls.filter(c => c.url.startsWith('/api/library/'));
const queuePuts = () => calls.filter(c => c.url.startsWith('/api/player/queue') && c.method === 'PUT');

function targetDev(extra = {}) {
  return {
    name: 'Target', online: true, playing: true, position_seconds: 30, duration: 200,
    volume: 0.8, muted: false, shuffle: false, repeat: 'off', index: 0, queue_len: 3,
    queue_rev: 1, track: { name: 'Remote song', artist: 'R', album: '', image: '', duration_ms: 200000, id: 'r1' },
    next: null, engine: 'v3', dj: null, ack: 0, updated_at: nowS(), ...extra,
  };
}

function devicesEvent(target = targetDev()) {
  return { server_time: nowS(), devices: { 'dev-self': { name: 'Me', online: true, updated_at: nowS() }, 'dev-tgt': target } };
}

function resetWorld() {
  calls.length = 0;
  events.length = 0;
  clearTimeout(store.playerSaveTimer);
  store.remoteTarget = null;
  store.remoteQueue = null;
  store.playlistMode = null;
  store.radioMode = false;
  store.shuffleEnabled = false;
  store.castDevice = null;
  store.playerVolume = 1;
  store.playerQueue = tracks('L1', 'L2', 'L3');
  store.playerIndex = 0;
  Q.resetShuffleOrder();
  const a = deck();
  a.log.length = 0;
  a.paused = true;
  a._src = 'http://test.local/api/player/stream?name=L1&artist=L1-artist&quality=mp3';
  a.currentTime = 12;
  a.duration = 200;
  a.readyState = 4;
  a.volume = 0.7;
}

/** remote.js running as a plain device (a possible TARGET), fresh state. */
async function startAsTarget() {
  R.stopRemote();
  sessionStorage.removeItem('ms_remote_target');
  R.initRemote();
  await settle();
  es().emit('devices', devicesEvent());
  await settle();
  calls.length = 0; events.length = 0;
}

/** remote.js controlling `dev-tgt`, entered the way a reload restores it. */
async function startControlling(target = targetDev()) {
  R.stopRemote();
  sessionStorage.setItem('ms_remote_target', 'dev-tgt');
  R.initRemote();
  await settle();
  es().emit('devices', devicesEvent(target));
  await settle();
  assert.equal(store.remoteTarget, 'dev-tgt', 'fixture: remote.js entered remote mode');
  calls.length = 0; events.length = 0;
  deck().log.length = 0;
}

beforeEach(() => { resetWorld(); });

test('M3: the event stream connects with the device-bound remote token, never the stream token', async () => {
  await startAsTarget();
  const url = es().url;
  assert.match(url, /^\/api\/remote\/events\?/);
  assert.match(url, /[?&]token=rt(&|$)/, `remote token in the URL: ${url}`);
  assert.doesNotMatch(url, /[?&]token=st(&|$)/, 'stream token must not be used when the remote token is available');
  assert.match(url, /[?&]tab_id=/, 'tab id on the URL');
});

// ═════════════════════════════════════════════════════════════════════════════
// B5 — adding to the queue on a controller
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, engine] of [['v3', () => V3], ['classic', () => CL]]) {
  test(`B5 ${label}: addToQueue under remote changes no local queue and sends exactly one enqueue`, async () => {
    await startControlling();
    const before = store.playerQueue;
    const snapshot = before.map(t => t.name);
    const items = tracks('A', 'B');
    engine().addToQueue(items);
    await settle();
    assert.equal(store.playerQueue, before, 'same array');
    assert.deepEqual(store.playerQueue.map(t => t.name), snapshot, 'no row added locally');
    const enq = events.filter(e => e.type === 'remote:enqueue');
    assert.equal(enq.length, 1, 'one remote:enqueue');
    assert.deepEqual(enq[0].detail.map(t => t.name), ['A', 'B']);
    assert.equal(events.filter(e => e.type === 'remote:cmd').length, 0, 'no play_now');
    assert.equal(libraryWrites().length, 0, 'no Navidrome mirror');
    const cmds = remoteCmds();
    assert.equal(cmds.length, 1, 'one command on the wire');
    assert.equal(cmds[0].body.action, 'enqueue');
    assert.equal(cmds[0].body.target_device_id, 'dev-tgt');
    assert.deepEqual(cmds[0].body.value.map(t => t.name), ['A', 'B']);
  });

  test(`B5 ${label}: addToQueue(items, true) under remote is one queue_op play_now, nothing else`, async () => {
    await startControlling();
    engine().addToQueue(tracks('A'), true);
    await settle();
    assert.equal(events.filter(e => e.type === 'remote:enqueue').length, 0);
    const cmds = remoteCmds();
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].body.action, 'queue_op');
    assert.equal(cmds[0].body.value.op, 'play_now');
    assert.deepEqual(cmds[0].body.value.items.map(t => t.name), ['A']);
    assert.equal(events.filter(e => e.type === 'remote:play').length, 0, 'no transfer of the workspace');
    assert.equal(libraryWrites().length, 0);
  });

  test(`B5 ${label}: outside remote addToQueue pushes into the same array and mirrors once`, async () => {
    store.playlistMode = { id: 'pl1', name: 'Up Next' };
    const before = store.playerQueue;
    engine().addToQueue(tracks('A'));
    await settle();
    assert.equal(store.playerQueue, before, 'push, never concat (search.js top-up relies on identity)');
    assert.deepEqual(store.playerQueue.map(t => t.name), ['L1', 'L2', 'L3', 'A']);
    assert.equal(events.filter(e => e.type === 'remote:enqueue').length, 0);
    assert.equal(libraryWrites().filter(c => c.url.includes('/playlist/pl1/add-and-download-batch')).length, 1);
    clearTimeout(store.playerSaveTimer);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// B1 — the Android notification / headset keys on a controller
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, android] of [['v3', () => v3Android], ['classic', () => classicAndroid]]) {
  for (const action of ['play', 'pause', 'next', 'prev']) {
    test(`B1 ${label}: _androidMediaAction('${action}') under remote drives the target, not the local deck`, async () => {
      await startControlling();
      const src = deck().src;
      const idx = store.playerIndex;
      android()(action);
      await settle();
      const cmd = events.filter(e => e.type === 'remote:cmd');
      assert.equal(cmd.length, 1);
      assert.equal(cmd[0].detail.action, action);
      assert.deepEqual(deck().log.filter(l => l[0] === 'play' || l[0] === 'src' || l[0] === 'load'), [], 'deck untouched');
      assert.equal(deck().src, src);
      assert.equal(store.playerIndex, idx, 'local queue did not advance');
      const sent = remoteCmds().map(c => c.body.action);
      assert.deepEqual(sent, [action], 'one command to the target');
    });
  }
}

test('B1 v3 control: without remote, _androidMediaAction(play) plays the local deck', async () => {
  v3Android('play');
  await settle();
  assert.ok(deck().log.some(l => l[0] === 'play'), 'positive control: the local deck plays');
  assert.equal(events.filter(e => e.type === 'remote:cmd').length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// B2 — a device that is itself controlling never relays a command
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, engine] of [['v3', () => V3], ['classic', () => CL]]) {
  test(`B2 ${label}: applyRemoteCommand('transfer') on a controlling device loads nothing and relays nothing`, async () => {
    store.remoteTarget = 'dev-tgt';
    serverQueue = { queue: tracks('X', 'Y'), current_index: 1, position_seconds: 50, volume: 0.1 };
    const before = store.playerQueue;
    engine().applyRemoteCommand('transfer');
    await settle();
    assert.equal(events.filter(e => e.type === 'remote:play').length, 0, 'no remote:play (would transfer back)');
    assert.equal(calls.filter(c => c.url.startsWith('/api/player/queue')).length, 0, 'the queue file is not read');
    assert.equal(store.playerQueue, before);
    assert.deepEqual(deck().log, []);
    store.remoteTarget = null;
  });
}

test('B2 remote.js: an inbound command while controlling first leaves remote mode, then applies', async () => {
  await startControlling();
  assert.ok(document.body.classList.contains('remote-active'));
  es().emit('command', { id: 7, action: 'volume', value: 0.3, ts: nowS(), from: 'dev-tgt' });
  await settle();
  assert.equal(store.remoteTarget, null, 'no longer controlling');
  assert.ok(!document.body.classList.contains('remote-active'));
  assert.equal(store.playerVolume, 0.3, 'applied locally after leaving');
  await tick(200);
  const st = calls.filter(c => c.url === '/api/remote/state').pop();
  assert.ok(st, 'state reported');
  assert.equal(st.body.controlling, null);
  assert.equal(st.body.ack, 7);
});

// ═════════════════════════════════════════════════════════════════════════════
// B11 / B18 — a transfer into a target
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, engine] of [['v3', () => V3], ['classic', () => CL]]) {
  test(`B11 ${label}: loadQueueState({touchDeck:false}) takes the queue and leaves the deck and volume`, async () => {
    serverQueue = { queue: tracks('X', 'Y', 'Z'), current_index: 2, position_seconds: 80, volume: 0.1, playlist_mode: { id: 'named', name: 'MyZouk' } };
    store.playerVolume = 0.9;
    const a = deck();
    const src = a.src;
    const data = await engine().loadQueueState({ touchDeck: false });
    assert.ok(data, 'resolves to the saved state');
    assert.deepEqual(store.playerQueue.map(t => t.name), ['X', 'Y', 'Z']);
    assert.equal(store.playerIndex, 2);
    assert.equal(a.src, src, 'active deck src untouched');
    assert.equal(a.volume, 0.7, 'deck volume untouched');
    assert.equal(store.playerVolume, 0.9, 'the controller’s volume never reaches the target');
    assert.deepEqual(a.log.filter(l => l[0] !== 'pause'), []);
  });
}

test('B11 v3 control: loadQueueState() (a page start) does set the deck source and volume', async () => {
  serverQueue = { queue: tracks('X'), current_index: 0, position_seconds: 0, volume: 0.1 };
  await V3.loadQueueState();
  assert.equal(store.playerVolume, 0.1);
  assert.ok(deck().src.includes('name=X'), 'positive control for the test above');
});

test('B18 v3: a transfer re-anchors the Smart Queue set (resetSmartQueuePlayed)', async () => {
  // Probe of djmix's played set: with both candidates marked played there is no pick.
  const probe = tracks('cur', 'p', 'q');
  D.markPlayed(probe[1]); D.markPlayed(probe[2]);
  assert.equal(D.pickSmartNext(probe, 0, { bpm: 80 }), null, 'probe: played tracks are excluded');
  serverQueue = { queue: tracks('X', 'Y'), current_index: 0, position_seconds: 0 };
  V3.applyRemoteCommand('transfer');
  await settle(); await tick(20);
  assert.notEqual(D.pickSmartNext(probe, 0, { bpm: 80 }), null, 'played set cleared by the transfer');
});

test('B11 v3: a transfer keeps the target’s volume (applyRemoteCommand)', async () => {
  serverQueue = { queue: tracks('X', 'Y'), current_index: 0, position_seconds: 0, volume: 0.05 };
  store.playerVolume = 0.6;
  V3.applyRemoteCommand('transfer');
  await settle(); await tick(20);
  assert.deepEqual(store.playerQueue.map(t => t.name), ['X', 'Y']);
  assert.equal(store.playerVolume, 0.6);
});

// ═════════════════════════════════════════════════════════════════════════════
// B6 — seek
// ═════════════════════════════════════════════════════════════════════════════
test('B6 controller: seek with unknown duration sends nothing', async () => {
  await startControlling(targetDev({ duration: 0, track: { name: 'Mix', artist: 'DJ', duration_ms: 0 } }));
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'seek_pct', value: 0.5 } }));
  await settle();
  assert.equal(remoteCmds().length, 0, 'a 60-min set must not restart at 0');
  assert.equal(elFor('#toastMsg').textContent, "Can't seek: track length unknown");
});

test('B6 controller: seek uses the duration the target reported', async () => {
  await startControlling(targetDev({ duration: 3600, track: { name: 'Mix', artist: 'DJ', duration_ms: 0 } }));
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'seek_pct', value: 0.5 } }));
  await settle();
  const c = remoteCmds();
  assert.equal(c.length, 1);
  assert.equal(c[0].body.action, 'seek');
  assert.equal(c[0].body.value, 1800);
});

test('B6 v3 target: seek on a progressive stream reloads the finished file (seekLocal)', async () => {
  const a = deck();
  a._src = 'http://test.local/api/player/stream?name=L1&artist=x&progressive=1';
  a.duration = Infinity;
  V3.applyRemoteCommand('seek', 42);
  assert.ok(!a.src.includes('progressive=1'), `reloaded without progressive: ${a.src}`);
  assert.ok(a.log.some(l => l[0] === 'load'));
  a.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(a.currentTime, 42);
});

test('B6 v3 target: seek on an ordinary deck sets the position', async () => {
  V3.applyRemoteCommand('seek', 42);
  assert.equal(deck().currentTime, 42);
  assert.ok(!deck().log.some(l => l[0] === 'src'));
});

// ═════════════════════════════════════════════════════════════════════════════
// B20 — command age and duplicates on the target
// ═════════════════════════════════════════════════════════════════════════════
test('B20: a command older than 5 s (server clock) is dropped', async () => {
  await startAsTarget();
  es().emit('command', { id: 1, action: 'volume', value: 0.2, ts: nowS() - 6, from: 'dev-x' });
  await settle();
  assert.equal(store.playerVolume, 1);
});

test('B20: a fresh command is applied and acknowledged', async () => {
  await startAsTarget();
  es().emit('command', { id: 2, action: 'volume', value: 0.2, ts: nowS() - 1, from: 'dev-x' });
  await settle(); await tick(200);
  assert.equal(store.playerVolume, 0.2);
  const st = calls.filter(c => c.url === '/api/remote/state').pop();
  assert.equal(st.body.ack, 2);
});

test('B20: the age is measured on the server clock, not this device’s', async () => {
  R.stopRemote();
  sessionStorage.removeItem('ms_remote_target');
  R.initRemote();
  await settle();
  // This device's clock runs 60 s behind the server.
  const skew = 60;
  es().emit('devices', { ...devicesEvent(), server_time: nowS() + skew });
  await settle();
  es().emit('command', { id: 3, action: 'volume', value: 0.25, ts: nowS() + skew - 1, from: 'dev-x' });
  await settle();
  assert.equal(store.playerVolume, 0.25, 'fresh on the server clock');
  es().emit('command', { id: 4, action: 'volume', value: 0.5, ts: nowS() - 1, from: 'dev-x' });
  await settle();
  assert.equal(store.playerVolume, 0.25, '61 s old on the server clock');
});

test('B20: the same command delivered twice is applied once', async () => {
  await startAsTarget();
  const c = { id: 9, action: 'volume', value: 0.4, ts: nowS(), from: 'dev-x' };
  es().emit('command', c);
  await settle();
  assert.equal(store.playerVolume, 0.4);
  store.playerVolume = 1;
  es().emit('command', c);
  await settle();
  assert.equal(store.playerVolume, 1, 'duplicate ignored');
});

// ═════════════════════════════════════════════════════════════════════════════
// B12 — toggle and the Next lock on the controller
// ═════════════════════════════════════════════════════════════════════════════
test('B12: the play/pause button sends toggle and lets the target decide', async () => {
  await startControlling(targetDev({ playing: false }));
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
  await settle();
  assert.deepEqual(remoteCmds().map(c => c.body.action), ['toggle']);
});

test('B12: a second Next within 2 s is ignored until the target moved', async () => {
  await startControlling();
  const next = () => document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
  next(); await settle();
  next(); await settle();
  assert.equal(remoteCmds().length, 1, 'second press swallowed');
  // The target reports the next track: the lock opens.
  es().emit('devices', devicesEvent(targetDev({ index: 1, track: { name: 'Second', artist: 'R', duration_ms: 1000 } })));
  await settle();
  next(); await settle();
  assert.equal(remoteCmds().length, 2, 'released by the index change');
});

test('B12: the Next lock also opens on the acknowledgement of the command', async () => {
  await startControlling();
  const next = () => document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
  next(); await settle();
  const id = cmdSeq;   // the id the server gave that command
  es().emit('devices', devicesEvent(targetDev({ ack: id })));
  await settle();
  next(); await settle();
  assert.equal(remoteCmds().length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// The controller never saves its queue, never mirrors into Navidrome
// ═════════════════════════════════════════════════════════════════════════════
for (const [label, engine] of [['v3', () => V3], ['classic', () => CL]]) {
  test(`${label}: flushQueue under remote makes no PUT`, async () => {
    store.remoteTarget = 'dev-tgt';
    await engine().flushQueue();
    assert.equal(queuePuts().length, 0);
    store.remoteTarget = null;
  });

  test(`${label} control: flushQueue outside remote saves the queue`, async () => {
    await engine().flushQueue();
    assert.equal(queuePuts().length, 1);
  });
}

test('upnext.playTracks under remote: no mirror, playlistMode kept, one transfer of the new list', async () => {
  await startControlling();
  // A temp playlist in the workspace context is exactly the one playTracks would mirror into.
  const upNext = { id: 'up', name: 'Up Next' };
  store.playlistMode = upNext;
  await U.playTracks(tracks('N1', 'N2'), 1);
  await settle();
  assert.equal(libraryWrites().length, 0, 'no replace-by-name into a playlist');
  assert.equal(store.playlistMode, upNext, 'playlistMode not moved');
  const t = remoteCmds().filter(c => c.body.action === 'transfer');
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].body.value.queue.map(x => x.name), ['N1', 'N2']);
  assert.equal(t[0].body.value.current_index, 1);
  assert.deepEqual(deck().log.filter(l => l[0] === 'play' || l[0] === 'src'), [], 'controller stays silent');
});

test('upnext.mirrorAdd under remote writes nothing', async () => {
  store.remoteTarget = 'dev-tgt';
  store.playlistMode = { id: 'up', name: 'Up Next' };
  U.mirrorAdd(tracks('A'));
  await settle();
  assert.equal(libraryWrites().length, 0);
  store.remoteTarget = null;
});

test('upnext.mirrorAdd control: outside remote it mirrors into Up Next', async () => {
  store.playlistMode = { id: 'up', name: 'Up Next' };
  U.mirrorAdd(tracks('A'));
  await settle();
  assert.equal(libraryWrites().length, 1);
});

test('upnext.clearActiveQueue under remote clears the target, not this device', async () => {
  await startControlling();
  const before = store.playerQueue.slice();
  await U.clearActiveQueue();
  await settle();
  assert.deepEqual(store.playerQueue, before);
  const c = remoteCmds();
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].body.value, { op: 'clear' });
  assert.equal(libraryWrites().length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Queue ops on the target (queue.applyQueueOp)
// ═════════════════════════════════════════════════════════════════════════════
const loads = [];
function targetQueue() {
  store.playerQueue = tracks('A', 'B', 'C', 'D');
  store.playerIndex = 0;
  loads.length = 0;
  Q.setPlayerRefs({
    loadAndPlay: () => loads.push(store.playerIndex),
    hidePlayerBar() {}, saveQueueDebounced() {}, audio: null, getAudio: () => null,
  });
}

test('queue_op remove: a stale index finds the row by name and artist', async () => {
  targetQueue();
  const ok = await Q.applyQueueOp({ op: 'remove', index: 1, name: 'C', artist: 'C-artist' });
  assert.equal(ok, true);
  assert.deepEqual(store.playerQueue.map(t => t.name), ['A', 'B', 'D'], 'C removed, not B');
});

test('queue_op remove: a track no longer in the queue removes nothing', async () => {
  targetQueue();
  const ok = await Q.applyQueueOp({ op: 'remove', index: 2, name: 'Gone', artist: 'Nobody' });
  assert.equal(ok, false);
  assert.deepEqual(store.playerQueue.map(t => t.name), ['A', 'B', 'C', 'D']);
});

test('queue_op jump: plays the row', async () => {
  targetQueue();
  const ok = await Q.applyQueueOp({ op: 'jump', index: 2, name: 'C', artist: 'C-artist' });
  assert.equal(ok, true);
  assert.equal(store.playerIndex, 2);
  assert.deepEqual(loads, [2]);
});

test('queue_op clear: empties the queue', async () => {
  targetQueue();
  const ok = await Q.applyQueueOp({ op: 'clear' });
  assert.equal(ok, true);
  assert.deepEqual(store.playerQueue, []);
  assert.equal(store.playerIndex, -1);
});

// ═════════════════════════════════════════════════════════════════════════════
// Leaving remote mode gives the controller its own queue back
// ═════════════════════════════════════════════════════════════════════════════
test('exit remote mode restores the controller’s queue, index and playlist', async () => {
  R.stopRemote();
  store.playerQueue = tracks('Mine1', 'Mine2');
  store.playerIndex = 1;
  store.playlistMode = { id: 'myzouk', name: 'MyZouk' };
  await startControlling();
  assert.equal(store.playlistMode, null, 'the workspace starts without this device’s playlist');
  // The workspace is used for something else meanwhile.
  store.playerQueue = tracks('Other');
  store.playerIndex = 0;
  // Being controlled ends controlling (B2) — and returns this device's own state.
  es().emit('command', { id: 50, action: 'volume', value: 0.5, ts: nowS(), from: 'dev-tgt' });
  await settle();
  assert.equal(store.remoteTarget, null);
  assert.deepEqual(store.playerQueue.map(t => t.name), ['Mine1', 'Mine2']);
  assert.equal(store.playerIndex, 1);
  assert.deepEqual(store.playlistMode, { id: 'myzouk', name: 'MyZouk' });
});

// ═════════════════════════════════════════════════════════════════════════════
// Mute / shuffle / repeat on the controller: a second press before the target's
// report caught up must still send the NEXT state (production, 2026-11-20: unmute
// 0.8 s after mute re-sent mute:true — the snapshot that arrived in between was the
// target's report from before it applied the first press).
// ═════════════════════════════════════════════════════════════════════════════
let FP = null;
const fpMod = async () => (FP ||= await import('../../static/js/fullplayer.js'));
const sentValues = (action) => remoteCmds().filter(c => c.body.action === action).map(c => c.body.value);
/** A devices snapshot carrying the target's state from BEFORE it applied the press. */
const staleReport = async (extra = {}) => { es().emit('devices', devicesEvent(targetDev(extra))); await settle(); };
/** Start controlling the way the app does after an earlier session ended: resetWorld()
 *  nulls store.remoteTarget without exitRemoteMode, whose repaint is where the app
 *  drops a press still waiting for its confirmation. */
async function controlFresh(fp, target) {
  store.remoteTarget = null;
  fp.syncShuffleRepeatUI(); fp.syncMuteUI();
  await startControlling(target);
}

for (const [label, between] of [['no report in between', null], ['a stale report in between', staleReport]]) {
  test(`mute: two presses under remote send true, then false (${label})`, async () => {
    const fp = await fpMod();
    await controlFresh(fp, targetDev({ muted: false }));
    fp.toggleMute(); await settle();
    if (between) await between({ muted: false });
    fp.toggleMute(); await settle();
    assert.deepEqual(sentValues('mute'), [true, false]);
    assert.equal(store.playerVolume, 1, 'the controller’s own volume is untouched');
  });

  test(`shuffle: two presses under remote send true, then false (${label})`, async () => {
    const fp = await fpMod();
    await controlFresh(fp, targetDev({ shuffle: false }));
    fp.toggleShuffle(); await settle();
    if (between) await between({ shuffle: false });
    fp.toggleShuffle(); await settle();
    assert.deepEqual(sentValues('shuffle'), [true, false]);
    assert.equal(store.shuffleEnabled, false, 'the controller’s own shuffle is untouched');
  });

  test(`repeat: two presses under remote send all, then one (${label})`, async () => {
    const fp = await fpMod();
    await controlFresh(fp, targetDev({ repeat: 'off' }));
    fp.toggleRepeat(); await settle();
    if (between) await between({ repeat: 'off' });
    fp.toggleRepeat(); await settle();
    assert.deepEqual(sentValues('repeat'), ['all', 'one']);
  });
}

test('mute overlay: the target’s confirming report ends it, a later change by the target shows', async () => {
  const fp = await fpMod();
  await controlFresh(fp, targetDev({ muted: false }));
  fp.toggleMute(); await settle();
  await staleReport({ muted: true });           // the target confirms
  await staleReport({ muted: false });          // then someone unmutes it on the target itself
  fp.toggleMute(); await settle();
  assert.deepEqual(sentValues('mute'), [true, true], 'the second press acts on the reported false');
});

test('mute overlay: leaving remote mode drops it', async () => {
  const fp = await fpMod();
  await controlFresh(fp, targetDev({ muted: false }));
  fp.toggleMute(); await settle();
  store.remoteTarget = null;
  fp.syncMuteUI();
  await startControlling(targetDev({ muted: false }));
  fp.toggleMute(); await settle();
  assert.deepEqual(sentValues('mute'), [true], 'a fresh session starts from the report');
});

test('mute overlay: after 4 s without a confirmation the reported value shows again', async () => {
  const fp = await fpMod();
  await controlFresh(fp, targetDev({ muted: false }));
  fp.toggleMute(); await settle();
  await staleReport({ muted: false });          // the target never applied it
  const realNow = Date.now;
  Date.now = () => realNow() + 4100;
  try {
    fp.toggleMute(); await settle();
  } finally { Date.now = realNow; }
  assert.deepEqual(sentValues('mute'), [true, true], 'the expired press no longer decides the next one');
});

test('mute overlay: switching control to another device drops it', async () => {
  const fp = await fpMod();
  await controlFresh(fp, targetDev({ muted: false }));
  fp.toggleMute(); await settle();
  // Both devices report unmuted; control moves to the second one.
  const ev = devicesEvent(targetDev({ muted: false }));
  ev.devices['dev-two'] = targetDev({ name: 'Second', muted: false });
  es().emit('devices', ev); await settle();
  store.remoteTarget = 'dev-two';
  fp.toggleMute(); await settle();
  const last = remoteCmds().filter(c => c.body.action === 'mute').at(-1);
  assert.equal(last.body.target_device_id, 'dev-two');
  assert.equal(last.body.value, true, 'the press on dev-tgt does not decide dev-two’s mute');
});

// ═════════════════════════════════════════════════════════════════════════════
// Short gaps: a dropped stream comes back fast, a 404 in the gap is retried once
// ═════════════════════════════════════════════════════════════════════════════
/** Run `fn` with this device's clock `ms` ahead. */
function withClockAhead(ms, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return fn(); } finally { Date.now = realNow; }
}

test('reconnect: a stream that had worked comes back after ~1 s, not after 5 s', async () => {
  failCommands = 0;
  await startAsTarget();          // its first `devices` arrived: the stream worked
  const before = sources.length;
  // …for over 30 s, then a network change on this device drops it.
  withClockAhead(31000, () => es().onerror());
  await tick(1300); await settle();
  assert.equal(sources.length, before + 1, 'a new EventSource within 1.3 s');
  assert.match(es().url, /token=rt&device_id=dev-self&tab_id=/);
});

test('reconnect: a stream that drops again right after the fast retry backs off', async () => {
  failCommands = 0;
  await startAsTarget();
  es().onerror();
  await tick(1300); await settle();
  const before = sources.length;
  es().emit('devices', devicesEvent()); await settle();   // the fast retry worked…
  es().onerror();                                          // …and dropped at once
  await tick(1300); await settle();
  assert.equal(sources.length, before, 'no second 1 s retry within 30 s');
});

test('a 404 on a command is retried once after 1.5 s while the target looks reachable', async () => {
  await startControlling();
  failCommands = 1;
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
  await settle();
  assert.equal(remoteCmds().length, 1, 'the first attempt');
  await tick(1700); await settle();
  assert.deepEqual(remoteCmds().map(c => c.body.action), ['next', 'next'], 'exactly one retry');
  await tick(1700); await settle();
  assert.equal(remoteCmds().length, 2, 'no further retries');
});

test('a 404 is not retried when the target is gone from the device list', async () => {
  await startControlling();
  failCommands = 1;
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
  await settle();
  const ev = devicesEvent(); delete ev.devices['dev-tgt'];
  es().emit('devices', ev); await settle();
  await tick(1700); await settle();
  assert.equal(remoteCmds().length, 1);
});

test('a 404 on a transfer is not retried', async () => {
  await startControlling();
  failCommands = 1;
  document.dispatchEvent(new Event('remote:play'));
  await tick(1700); await settle();
  assert.equal(remoteCmds().filter(c => c.body.action === 'transfer').length, 1);
  failCommands = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
// R2 of the reconnect-gap delta
// ═════════════════════════════════════════════════════════════════════════════
test('m5: a stream that delivers and drops at once backs off instead of reconnecting fast', async () => {
  failCommands = 0;
  await startAsTarget();          // delivered its first event…
  const before = sources.length;
  es().onerror();                 // …and dropped right away
  await tick(1300); await settle();
  assert.equal(sources.length, before, 'no reconnect within 1.3 s');
});

test('m1: a command the server held across this tab’s reconnect is applied though older than 5 s', async () => {
  await startAsTarget();
  es().emit('command', { id: 31, action: 'volume', value: 0.33, ts: nowS() - 8, queued: true, from: 'dev-x' });
  await settle();
  assert.equal(store.playerVolume, 0.33);
  es().emit('command', { id: 32, action: 'volume', value: 0.66, ts: nowS() - 8, from: 'dev-x' });
  await settle();
  assert.equal(store.playerVolume, 0.33, 'an unheld 8 s old command is still dropped');
});

test('m2: a 404 retry is skipped when a newer command to the target was accepted meanwhile', async () => {
  await startControlling();
  failCommands = 1;
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
  await settle();
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
  await settle();
  await tick(1700); await settle();
  assert.deepEqual(remoteCmds().map(c => c.body.action), ['next', 'toggle'], 'the old next is not retried after the newer press');
});

test('M2: a queued Next holds the lock beyond 2 s until the target acknowledges it', async () => {
  await startControlling();
  queueCommands = true;
  try {
    const next = () => document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
    next(); await settle();
    await tick(2300); await settle();
    next(); await settle();
    assert.equal(remoteCmds().length, 1, 'still locked while the command waits in the server queue');
    es().emit('devices', devicesEvent(targetDev({ ack: cmdSeq })));
    await settle();
    next(); await settle();
    assert.equal(remoteCmds().length, 2, 'the ack opens it');
  } finally { queueCommands = false; }
});

test('M2: play/pause sends an explicit pause, not toggle, while the target is reconnecting', async () => {
  await startControlling(targetDev({ playing: true }));
  es().emit('devices', devicesEvent(targetDev({ playing: true, online: false })));
  await settle();
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
  await settle();
  assert.deepEqual(remoteCmds().map(c => c.body.action), ['pause']);
});

test('M2: a queued command shows "Waiting for …" until its ack', async () => {
  await startControlling();
  queueCommands = true;
  try {
    document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
    await settle();
    assert.equal(R.remoteStatusText(), 'Waiting for Target…');
    es().emit('devices', devicesEvent(targetDev({ ack: cmdSeq })));
    await settle();
    assert.equal(R.remoteStatusText(), 'Controlling Target');
  } finally { queueCommands = false; }
});

test('M2: a queued command without an ack for 11 s ends in "<device> didn’t respond"', async () => {
  await startControlling();
  queueCommands = true;
  elFor('#toastMsg').textContent = '';
  try {
    document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } }));
    await settle();
    assert.equal(R.remoteStatusText(), 'Waiting for Target…');
    const realNow = Date.now;
    Date.now = () => realNow() + 11500;
    try { await tick(1200); await settle(); } finally { Date.now = realNow; }
    assert.equal(elFor('#toastMsg').textContent, "Target didn't respond");
    assert.notEqual(R.remoteStatusText(), 'Waiting for Target…');
  } finally { queueCommands = false; }
});

test('F1a: an accepted (not queued) Next stays locked until its ack, and "Waiting for …" shows after 3 s', async () => {
  await startControlling();
  const next = () => document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } }));
  next(); await settle();
  assert.equal(R.remoteStatusText(), 'Controlling Target', 'no warning in the first seconds');
  await tick(3300); await settle();
  next(); await settle();
  assert.equal(remoteCmds().length, 1, 'still locked: a half-open stream may be holding the command');
  assert.equal(R.remoteStatusText(), 'Waiting for Target…');
  es().emit('devices', devicesEvent(targetDev({ ack: cmdSeq })));
  await settle();
  assert.equal(R.remoteStatusText(), 'Controlling Target', 'the ack clears it');
  next(); await settle();
  assert.equal(remoteCmds().length, 2, 'and opens the lock');
});

