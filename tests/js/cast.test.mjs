// The cast client (static/js/cast.js) against a fake /api/dlna/* and a mocked clock.
// What it pins (notes/impl/cast-review-2026-11-19.md):
//   1  a page that slept through the end of a track still advances (fallback), and with
//      a following server it never advances on its own but adopts the server's track
//   2  a cast that outlived the page is taken up again on load
//   3  the position travels to the receiver and back
//   4  seeking uses the receiver's duration
//   6  at most one status request on its way
//   8  the stall clock counts only time the page watched
//   9  play/pause follows the receiver; the Android shell hears "playing"
//   11 failed polls back off and never end the session on the page alone
//   19 volume null leaves the slider alone
import test from 'node:test';
import assert from 'node:assert/strict';

// ── A browser just big enough for cast.js, utils.js, store.js and api.js ──
class El {
  constructor(id = '') {
    this.id = id; this.textContent = ''; this.innerHTML = ''; this.value = '';
    this.style = { setProperty() {} }; this.dataset = {};
  }
  matches() { return false; }
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  appendChild(el) { if (el && el.id) els['#' + el.id] = el; }
}
const els = {};
for (const id of ['playerProgressFill', 'playerBar', 'fpProgressFill', 'playerTimeCurrent', 'playerTimeTotal',
  'fpTimeCurrent', 'fpTimeTotal', 'fpCastVolume', 'fpCastVolLabel', 'playerCastBtn', 'fpCastBtn', 'fpCastVol']) {
  els['#' + id] = new El(id);
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis;
const body = new El('body');
globalThis.document = {
  hidden: false,
  body,
  querySelector: (s) => els[s] || null,
  querySelectorAll: () => [],
  getElementById: (id) => els['#' + id] || null,
  createElement: () => new El(),
  addEventListener() {},
};

// ── A fake server ──
const server = {
  calls: [],          // [method, url, body]
  status: () => ({ active: false }),
  statusDelay: 0,     // ms before a status answer arrives (mocked clock)
  statusFail: false,
  castSeq: 0,
  castFail: null,     // {status, body} → POST /cast answers that
  sessionId: undefined, // session_id in the /cast answer
  savedQueue: null,   // GET /api/player/queue answer
  hintStatus: 200,
  outstanding: 0,
  maxOutstanding: 0,
};
function reply(status, body) {
  return { ok: status < 400, status, statusText: '', headers: { get: () => null }, json: async () => body };
}
globalThis.fetch = async (url, opts = {}) => {
  const method = (opts.method || 'GET').toUpperCase();
  const reqBody = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push([method, String(url), reqBody]);
  if (url === '/api/dlna/status') {
    server.outstanding++;
    server.maxOutstanding = Math.max(server.maxOutstanding, server.outstanding);
    try {
      if (server.statusHang) {
        // Never answers — only an abort ends it, as with a real fetch.
        await new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('AbortError'))));
      }
      // The answer describes the receiver when the request was made, not when it lands.
      const body = server.status();
      const fail = server.statusFail;
      if (server.statusDelay) await new Promise((r) => setTimeout(r, server.statusDelay));
      if (fail) throw new TypeError('Failed to fetch');
      return reply(200, body);
    } finally { server.outstanding--; }
  }
  if (url === '/api/dlna/cast') {
    if (server.castFail) return reply(server.castFail.status, server.castFail.body);
    return reply(200, { status: 'casting', cast_seq: ++server.castSeq, session_id: server.sessionId });
  }
  if (url === '/api/player/queue' && method === 'GET') {
    const body = server.savedQueue || {};
    if (server.queueDelay) await new Promise((r) => setTimeout(r, server.queueDelay));
    return reply(200, body);
  }
  if (url === '/api/player/recommendations') {
    if (server.recsFail) return reply(500, { detail: 'boom' });
    return reply(200, { tracks: (server.recTracks || []).map((r) => ({ ...r })) });
  }
  if (url === '/api/dlna/next-hint') return reply(server.hintStatus, server.hintStatus === 200 ? { ok: true } : { detail: { stale: true } });
  return reply(200, { ok: true });
};

// queue.js (the real shuffle order, for the shuffle probe) wants a little more browser.
globalThis.addEventListener = () => {};
globalThis.innerWidth = 400;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.history = { pushState() {}, back() {} };
process.on('unhandledRejection', () => {}); // renderQueue() lazy-imports recommendations.js

const { store } = await import('../../static/js/store.js');
const cast = await import('../../static/js/cast.js');
const Q = await import('../../static/js/queue.js');
Q.setPlayerRefs({ loadAndPlay() {}, hidePlayerBar() {}, saveQueueDebounced() {}, audio: null, getAudio: () => null });
const { _internals: ab } = await import('../../static/js/androidbridge.js');

const A = { name: 'Set One', artist: 'DJ A', duration_ms: 300000 };
const B = { name: 'Set Two', artist: 'DJ B', duration_ms: 600000 };
const C = { name: 'Set Three', artist: 'DJ C', duration_ms: 0 };

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function run(t, ms, step = 250) {
  for (let done = 0; done < ms; done += step) { t.mock.timers.tick(step); await flush(); }
}
const calls = (method, url) => server.calls.filter(([m, u]) => m === method && u === url);

// Fresh module state, a fresh fake server and recording engine hooks.
function setup(t, { follow = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  cast._internals.reset();
  Object.assign(server, { calls: [], statusDelay: 0, statusFail: false, statusHang: false, castSeq: 0, castFail: null, sessionId: undefined, savedQueue: null, queueDelay: 0, hintStatus: 200, recTracks: [], recsFail: false,
    outstanding: 0, maxOutstanding: 0, status: () => ({ active: false }) });
  store.playerQueue = [A, B, C];
  store.playerIndex = 0;
  store.castDevice = { id: 'uuid:onkyo', name: 'Onkyo' };
  store.deviceOutputMode = 'default';
  store.repeatMode = 'off';
  store.shuffleEnabled = false;
  store.playerPlaying = false;
  globalThis.AndroidBridge = undefined;
  const eng = { next: 0, nextOpts: [], adopted: [], saved: [], flushes: 0, paused: 0, resumed: 0, primed: [], icon: [], upcoming: { index: 1, item: B } };
  store.playerSavePending = false;
  cast.initCast({
    getAudioEl: () => null,
    nextTrack: (o) => { eng.next++; eng.nextOpts.push(o); },
    getUpcoming: () => eng.upcoming,
    adoptTrack: (idx, track, saved) => { eng.adopted.push([idx, track.name]); eng.saved.push(saved); if (idx >= 0) store.playerIndex = idx; },
    flushQueue: async () => { eng.flushes++; server.calls.push(['PUT', '/api/player/queue', null]); store.playerSavePending = false; },
    pauseLocal: () => { eng.paused++; },
    resumeLocal: () => { eng.resumed++; },
    onCastPlaying: (p) => { store.playerPlaying = p; eng.icon.push(p); },
    localPosition: () => 2700,
    primeLocal: (idx, pos) => { eng.primed.push([idx, pos]); },
  });
  t.after(() => { cast._internals.reset(); store.castDevice = null; });
  void follow;
  return eng;
}
const playing = (pos, dur, extra = {}) => () => ({ active: true, device_id: 'uuid:onkyo', device: 'Onkyo', state: 'PLAYING',
  position_seconds: pos, duration_seconds: dur, volume: 40, ...extra });
const stopped = (extra = {}) => () => ({ active: true, device_id: 'uuid:onkyo', device: 'Onkyo', state: 'STOPPED',
  position_seconds: 0, duration_seconds: 300, volume: 40, ...extra });

// ── Finding 1, fallback (no `follow`): the page slept through the end ──
test('fallback: PLAYING 70/300, the page sleeps 240 s, STOPPED → exactly one nextTrack', async (t) => {
  const eng = setup(t);
  server.status = playing(70, 300);
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(calls('GET', '/api/dlna/status').length, 1);

  server.status = stopped();
  t.mock.timers.setTime(Date.now() + 240_000); // asleep: the clock moves, no timer runs
  await run(t, 2000);
  assert.equal(eng.next, 1, 'the woken page sees the track ended and advances');
  await run(t, 10_000);
  assert.equal(eng.next, 1, 'and only once');
});

test('fallback: a hand stop mid-track does not advance', async (t) => {
  const eng = setup(t);
  server.status = playing(70, 300);
  cast.startCastPoll();
  await run(t, 2000);
  server.status = stopped();
  await run(t, 6000);
  assert.equal(eng.next, 0);
  assert.equal(store.playerPlaying, false, 'the icon follows the stopped receiver');
});

// ── Finding 6: one status request at a time ──
test('a status answer that takes 5 s never has a second request beside it', async (t) => {
  setup(t);
  server.status = playing(10, 300);
  server.statusDelay = 5000;
  cast.startCastPoll();
  await run(t, 20_000);
  assert.equal(server.maxOutstanding, 1);
  assert.ok(calls('GET', '/api/dlna/status').length >= 2, 'the chain carries on after each answer');
  // A direct call while one is pending (e.g. the page coming back on screen) adds none.
  const before = calls('GET', '/api/dlna/status').length;
  const p1 = cast.pollCastOnce();
  const p2 = cast.pollCastOnce();
  await flush();
  assert.equal(calls('GET', '/api/dlna/status').length - before <= 1, true);
  await run(t, 6000);
  await Promise.all([p1, p2]);
  assert.equal(server.maxOutstanding, 1);
});

// ── Finding 8: the stall clock after a gap ──
test('a cast the page slept through is not re-cast or skipped on wake', async (t) => {
  const eng = setup(t);
  server.status = stopped({ duration_seconds: 0 });
  cast.markCastTransition();
  cast.startCastPoll();
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 60_000); // asleep for a minute before any PLAYING
  await run(t, 4000);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0, 'no re-cast straight after waking');
  assert.equal(eng.next, 0, 'no skip straight after waking');
  // Watched time does count: after 15 s of live polls it re-issues once.
  await run(t, 16_000);
  assert.equal(calls('POST', '/api/dlna/cast').length, 1);
});

test('a receiver that reports a position is never re-cast', async (t) => {
  const eng = setup(t);
  server.status = () => ({ active: true, device_id: 'uuid:onkyo', state: 'TRANSITIONING', position_seconds: 5, duration_seconds: 300 });
  cast.markCastTransition(60_000);
  cast.startCastPoll();
  await run(t, 40_000);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
  assert.equal(eng.next, 0);
});

// ── Finding 1, server follows ──
test('follow: STOPPED after the end never calls nextTrack', async (t) => {
  const eng = setup(t);
  const track = { queue_index: 0, name: A.name, artist: A.artist, by: 'client' };
  server.status = playing(70, 300, { follow: true, cast_seq: 1, track });
  cast.startCastPoll();
  await run(t, 2000);
  server.status = stopped({ follow: true, cast_seq: 1, track });
  t.mock.timers.setTime(Date.now() + 240_000);
  await run(t, 10_000);
  assert.equal(eng.next, 0);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
});

test('follow: a newer cast_seq with another track is adopted once, never re-cast', async (t) => {
  const eng = setup(t);
  server.status = playing(70, 300, { follow: true, cast_seq: 1, track: { queue_index: 0, name: A.name, artist: A.artist } });
  cast.startCastPoll();
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [], 'cast_seq 1 is new, but it is the current track');
  server.status = playing(3, 600, { follow: true, cast_seq: 2, track: { queue_index: 1, name: B.name, artist: B.artist, by: 'server' } });
  await run(t, 10_000);
  assert.deepEqual(eng.adopted, [[1, B.name]]);
  assert.equal(store.playerIndex, 1);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
  assert.equal(eng.next, 0);
});

test('follow: the index is checked against the song (a queue edited meanwhile)', async (t) => {
  const eng = setup(t);
  server.status = playing(3, 600, { follow: true, cast_seq: 5, track: { queue_index: 2, name: B.name, artist: B.artist } });
  cast.startCastPoll();
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[1, B.name]], 'row 2 is another song; B sits at row 1');
});

test('follow: no adoption while our own cast is on its way', async (t) => {
  const eng = setup(t);
  store.playerIndex = 2; // the user pressed Next twice; the cast of C is in flight
  let release;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/dlna/cast') { await new Promise((r) => { release = r; }); }
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  server.status = playing(3, 600, { follow: true, cast_seq: 7, track: { queue_index: 1, name: B.name, artist: B.artist, by: 'server' } });
  const p = cast.castTrack(C);
  cast.startCastPoll();
  await run(t, 4000);
  assert.deepEqual(eng.adopted, [], 'the server\'s older advance must not override the user\'s Next');
  release();
  await p;
  server.status = playing(1, 0, { follow: true, cast_seq: server.castSeq, track: { queue_index: 2, name: C.name, artist: C.artist } });
  await run(t, 4000);
  assert.deepEqual(eng.adopted, []);
  assert.equal(store.playerIndex, 2);
});

// ── Next hint ──
test('next-hint goes out once per change of "what plays next"', async (t) => {
  const eng = setup(t);
  const track = { queue_index: 0, name: A.name, artist: A.artist };
  server.status = playing(10, 300, { follow: true, cast_seq: 1, track });
  cast.startCastPoll();
  await run(t, 10_000);
  let hints = calls('POST', '/api/dlna/next-hint');
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0][2], { queue_index: 0, next: { queue_index: 1, name: B.name, artist: B.artist, album: '', image: '', duration_ms: 600000 }, repeat: 'off', shuffle: false });
  eng.upcoming = { index: 2, item: C }; // queue edited / Smart Queue picked another
  await run(t, 10_000);
  hints = calls('POST', '/api/dlna/next-hint');
  assert.equal(hints.length, 2);
  assert.equal(hints[1][2].next.queue_index, 2);
  store.repeatMode = 'all';
  await run(t, 6000);
  assert.equal(calls('POST', '/api/dlna/next-hint').length, 3, 'repeat is part of the hint');
});

test('next-hint: a 409 stale is not retried every tick', async (t) => {
  setup(t);
  server.hintStatus = 409;
  server.status = playing(10, 300, { follow: true, cast_seq: 1, track: { queue_index: 0, name: A.name, artist: A.artist } });
  cast.startCastPoll();
  await run(t, 12_000);
  assert.equal(calls('POST', '/api/dlna/next-hint').length, 1);
});

test('next-hint is not sent while the server plays a track other than ours', async (t) => {
  setup(t);
  store.playerIndex = 2; // not adopted (old seq), server's current is row 0
  cast._internals.reset();
  server.status = playing(10, 300, { follow: true, cast_seq: -5, track: { queue_index: 0, name: A.name, artist: A.artist } });
  cast.startCastPoll();
  await run(t, 8000);
  assert.equal(calls('POST', '/api/dlna/next-hint').length, 0);
});

// ── The one cast POST, finding 3 (position there and back) ──
test('castToDevice sends position, queue context and records cast_seq; stop hands the position back', async (t) => {
  const eng = setup(t);
  store.playerQueue[0] = { ...A, duration_ms: 3_600_000 }; // a one-hour mix
  store.castDevice = null;
  store.shuffleEnabled = true;
  server.castSeq = 41;
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' });
  const posts = calls('POST', '/api/dlna/cast');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0][2], {
    device_id: 'uuid:onkyo', name: A.name, artist: A.artist, album: '', image: '', duration_ms: 3_600_000,
    start_seconds: 2700, queue_index: 0,
    next: { queue_index: 1, name: B.name, artist: B.artist, album: '', image: '', duration_ms: 600000 },
    repeat: 'off', shuffle: true,
  });
  assert.equal(cast._internals.state().castSeq, 42);
  assert.equal(store.castDevice.id, 'uuid:onkyo');
  assert.equal(eng.paused, 1, 'both local decks are paused through the engine');
  assert.equal(store.playerPlaying, true);

  // The receiver plays from 2700 s on; 30 s after the last poll the user stops casting.
  server.status = playing(2710, 0);
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 30_000);
  await cast.stopCast();
  assert.equal(calls('POST', '/api/dlna/stop').length, 1);
  assert.equal(store.castDevice, null);
  assert.equal(eng.primed.length, 1);
  assert.equal(eng.primed[0][0], 0);
  assert.ok(Math.abs(eng.primed[0][1] - 2740) < 1, `continues at the receiver's position, got ${eng.primed[0][1]}`);
  assert.equal(store.playerPlaying, false);
});

// ── Finding 4 ──
test('castDuration: the receiver\'s duration, else the item\'s, never the local deck\'s', async (t) => {
  setup(t);
  assert.equal(cast.castDuration(), 300, 'from duration_ms before any status');
  server.status = playing(10, 312.5);
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(cast.castDuration(), 312.5);
  store.playerIndex = 2; // a mix whose length nobody knows
  await cast.castTrack(C);
  assert.equal(cast.castDuration(), 0);
});

// ── Finding 2 ──
test('restoreCast takes up a session that outlived the page', async (t) => {
  const eng = setup(t);
  store.castDevice = null;
  server.status = playing(100, 600, { follow: true, cast_seq: 9, location: 'http://192.168.1.45:8080/desc.xml',
    track: { queue_index: 1, name: B.name, artist: B.artist, by: 'server' } });
  const ok = await cast.restoreCast();
  assert.equal(ok, true);
  assert.deepEqual(store.castDevice, { id: 'uuid:onkyo', name: 'Onkyo', location: 'http://192.168.1.45:8080/desc.xml' });
  assert.deepEqual(eng.adopted, [[1, B.name]], 'the page shows what the receiver plays');
  assert.equal(eng.paused, 1);
  assert.equal(store.playerPlaying, true);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0, 'and does not cast it again');
  const n = calls('GET', '/api/dlna/status').length;
  await run(t, 2000);
  assert.equal(calls('GET', '/api/dlna/status').length, n + 1, 'the poll runs');
  assert.deepEqual(eng.adopted, [[1, B.name]], 'cast_seq 9 is known now — no second adoption');
});

test('restoreCast does nothing without a session', async (t) => {
  setup(t);
  store.castDevice = null;
  server.status = () => ({ active: false });
  assert.equal(await cast.restoreCast(), false);
  assert.equal(store.castDevice, null);
  await run(t, 6000);
  assert.equal(calls('GET', '/api/dlna/status').length, 1);
});

// ── abandoned, failures (finding 11), volume null (19) ──
test('abandoned: the message is shown and the session ends on the page', async (t) => {
  const eng = setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  server.status = () => ({ active: false, abandoned: 'Onkyo neodpovídá — cast ukončen' });
  await run(t, 2000);
  assert.equal(store.castDevice, null);
  assert.equal(els['#toastMsg'].textContent, 'Onkyo neodpovídá — cast ukončen');
  assert.equal(eng.primed.length, 1, 'the position is handed back');
  const n = calls('GET', '/api/dlna/status').length;
  await run(t, 10_000);
  assert.equal(calls('GET', '/api/dlna/status').length, n, 'the poll has stopped');
});

test('failed polls back off and never end the session on the page alone', async (t) => {
  setup(t);
  server.statusFail = true;
  cast.startCastPoll();
  await run(t, 120_000, 1000);
  assert.ok(store.castDevice, 'still casting');
  assert.equal(calls('POST', '/api/dlna/stop').length, 0);
  const polls = calls('GET', '/api/dlna/status').length;
  assert.ok(polls < 15, `backed off: ${polls} polls in 2 minutes (60 without back-off)`);
  server.statusFail = false;
  server.status = playing(10, 300);
  await run(t, 31_000, 1000);
  assert.equal(store.playerPlaying, true, 'recovers when the server answers again');
});

test('volume null leaves the slider where it is', async (t) => {
  setup(t);
  els['#fpCastVolume'].value = 35;
  server.status = playing(10, 300, { volume: null });
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(els['#fpCastVolume'].value, 35);
  server.status = playing(12, 300, { volume: 50 });
  await run(t, 2000);
  assert.equal(els['#fpCastVolume'].value, 50);
});

test('the local output mode ends the cast and stops the receiver', async (t) => {
  setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  store.deviceOutputMode = 'local';
  await run(t, 2000);
  assert.equal(store.castDevice, null);
  assert.equal(calls('POST', '/api/dlna/stop').length, 1);
});

// ── Finding 9 + Android half of finding 1 ──
test('play/pause icon and the Android shell follow the receiver', async (t) => {
  setup(t);
  const bridge = [];
  globalThis.AndroidBridge = {
    onPlay: (ti, ar) => bridge.push(['play', ti, ar]),
    onPause: () => bridge.push(['pause']),
    onStop: () => bridge.push(['stop']),
    onProgress: (p, d) => bridge.push(['progress', p, d]),
  };
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 6000);
  assert.equal(store.playerPlaying, true);
  assert.equal(bridge.filter((c) => c[0] === 'play').length, 1, 'onPlay once, not every poll');
  assert.deepEqual(bridge.find((c) => c[0] === 'play'), ['play', A.name, A.artist]);
  assert.ok(bridge.filter((c) => c[0] === 'progress').length >= 2, 'progress keeps the wake lock armed');
  server.status = () => ({ ...playing(12, 300)(), state: 'PAUSED_PLAYBACK' });
  await run(t, 2000 + ab.PAUSE_GRACE_MS + 500);
  assert.equal(store.playerPlaying, false);
  assert.equal(bridge.filter((c) => c[0] === 'pause').length, 1);
});

test('castPlay / castPause talk to the receiver', async (t) => {
  setup(t);
  await cast.castToggle(); // playerPlaying false → play
  assert.equal(calls('POST', '/api/dlna/play').length, 1);
  assert.equal(store.playerPlaying, true);
  await cast.castToggle();
  assert.equal(calls('POST', '/api/dlna/pause').length, 1);
  assert.equal(store.playerPlaying, false);
});

test('castStateFresh: a woken page does not save over the server\'s index', async (t) => {
  setup(t);
  server.status = playing(10, 300, { follow: true, cast_seq: 1, track: { queue_index: 0, name: A.name, artist: A.artist } });
  assert.equal(cast.castStateFresh(), false, 'no status seen yet');
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(cast.castStateFresh(), true);
  t.mock.timers.setTime(Date.now() + 300_000);
  assert.equal(cast.castStateFresh(), false, 'after a sleep, until the next status');
});

// ── Server deviations from the contract (cast-opravy, after the server landed) ──
const connecting = () => ({ active: true, device: 'transitioning', device_id: null, location: null, volume: null,
  track: null, follow: false, cast_seq: 0, state: 'TRANSITIONING', position_seconds: 0, duration_seconds: 0 });

test('connecting window: the fallback never re-casts or advances on it', async (t) => {
  const eng = setup(t);
  server.status = connecting;
  cast.markCastTransition(60_000);
  cast.startCastPoll();
  await run(t, 40_000);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
  assert.equal(eng.next, 0);
  assert.ok(store.castDevice, 'and the session is not torn down');
});

test('restore during the connecting window: no null device, it asks again', async (t) => {
  setup(t);
  store.castDevice = null;
  server.status = connecting;
  assert.equal(await cast.restoreCast(), false);
  assert.equal(store.castDevice, null);
  server.status = playing(5, 300, { follow: true, cast_seq: 1, track: { queue_index: 0, name: A.name, artist: A.artist } });
  await run(t, 3500);
  assert.deepEqual(store.castDevice, { id: 'uuid:onkyo', name: 'Onkyo', location: '' });
});

test('a seek re-cast of the same track only records the seq', async (t) => {
  const eng = setup(t);
  const track = { queue_index: 0, name: A.name, artist: A.artist, by: 'client' };
  server.status = playing(70, 300, { follow: true, cast_seq: 1, track });
  cast.startCastPoll();
  await run(t, 2000);
  server.status = playing(200, 300, { follow: true, cast_seq: 2, track: { ...track, by: 'server' } });
  await run(t, 4000);
  assert.deepEqual(eng.adopted, []);
  assert.equal(cast._internals.state().castSeq, 2);
  assert.equal(cast._internals.state().lastPos, 200, 'no reset of the position either');
  server.status = playing(3, 600, { follow: true, cast_seq: 3, track: { queue_index: 1, name: B.name, artist: B.artist, by: 'server' } });
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[1, B.name]], 'a real advance after it is still adopted');
});

for (const msg of ['Onkyo is now playing from another device', 'Onkyo is now playing something else — casting ended']) {
  test(`abandoned "${msg}" ends the cast the same way`, async (t) => {
    const eng = setup(t);
    server.status = playing(10, 300);
    cast.startCastPoll();
    await run(t, 2000);
    server.status = () => ({ active: false, abandoned: msg });
    await run(t, 2000);
    assert.equal(store.castDevice, null);
    assert.equal(els['#toastMsg'].textContent, msg);
    assert.equal(calls('POST', '/api/dlna/stop').length, 0);
    assert.equal(eng.primed.length, 1);
  });
}

test('track null and transport_status: nothing adopted, no hint, no error', async (t) => {
  const eng = setup(t);
  server.status = playing(10, 300, { follow: true, cast_seq: 4, track: null, transport_status: 'OK' });
  cast.startCastPoll();
  await run(t, 6000);
  assert.deepEqual(eng.adopted, []);
  assert.equal(calls('POST', '/api/dlna/next-hint').length, 0);
  assert.equal(store.playerPlaying, true);
});

test('every queue cast carries a queue_index >= 0 (the server follows only those)', async (t) => {
  setup(t);
  store.playerIndex = 1;
  await cast.castTrack(store.playerQueue[1]);          // loadAndPlay
  store.castDevice = null;
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' }); // Cast button
  const idx = calls('POST', '/api/dlna/cast').map(([, , b]) => b.queue_index);
  assert.deepEqual(idx, [1, 1]);
});

// ── Client review round (cast-opravy) ──
const follow = (state, pos, dur, seq, track, extra = {}) => () => ({ active: true, device_id: 'uuid:onkyo', device: 'Onkyo',
  state, position_seconds: pos, duration_seconds: dur, volume: 40, follow: true, cast_seq: seq, track, ...extra });
const trA = { queue_index: 0, name: A.name, artist: A.artist, by: 'client' };

test('follow: STOPPED mid-track for two polls → paused, and Play is a plain Play', async (t) => {
  setup(t);
  const bridge = [];
  globalThis.AndroidBridge = { onPlay: () => bridge.push('play'), onPause: () => bridge.push('pause'), onStop() {}, onProgress() {} };
  server.status = follow('PLAYING', 70, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(store.playerPlaying, true);
  server.status = follow('STOPPED', 0, 300, 1, trA);
  await run(t, 2000);
  assert.equal(store.playerPlaying, true, 'one STOPPED poll may be the server between tracks');
  await run(t, 2000 + ab.PAUSE_GRACE_MS + 500);
  assert.equal(store.playerPlaying, false);
  assert.ok(bridge.includes('pause'), 'the Android shell hears the pause');
  await cast.castToggle();
  // The server re-casts the stopped track at its last position on Play (server side).
  assert.equal(calls('POST', '/api/dlna/play').length, 1);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
  assert.equal(store.playerPlaying, true);
});

test('follow: STOPPED at the end of a track leaves the icon alone (the server is moving on)', async (t) => {
  setup(t);
  server.status = follow('PLAYING', 290, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 2000);
  server.status = follow('STOPPED', 0, 300, 1, trA);
  await run(t, 8000);
  assert.equal(store.playerPlaying, true);
});

test('hint after the indices drifted apart: sent, with the server\'s index', async (t) => {
  setup(t);
  store.playerIndex = 1; // B; the server still counts it as row 3 (a row was removed above it)
  server.status = follow('PLAYING', 10, 600, 1, { queue_index: 3, name: B.name, artist: B.artist });
  cast.startCastPoll();
  await run(t, 6000);
  const hints = calls('POST', '/api/dlna/next-hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0][2].queue_index, 3);
});

test('follow: queue_ended hands the end to the engine once per cast (radio / autoplay)', async (t) => {
  const eng = setup(t);
  store.radioMode = true;
  t.after(() => { store.radioMode = false; });
  server.status = follow('STOPPED', 0, 300, 5, trA, { queue_ended: true, queue_ended_ago: 1 });
  cast.startCastPoll();
  await run(t, 8000);
  assert.equal(eng.next, 1);
  assert.deepEqual(eng.nextOpts[0], { reason: 'ended' });
  assert.equal(store.playerPlaying, false);
  server.status = follow('STOPPED', 0, 300, 6, trA, { queue_ended: true, queue_ended_ago: 3 });
  await run(t, 6000);
  assert.equal(eng.next, 2, 'a later cast that ends the queue again is handed over again');
});

test('{active:false} while the server is resuming sessions does not end the cast; one bare one neither', async (t) => {
  setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  server.status = () => ({ active: false, resuming: true });
  await run(t, 10_000);
  assert.ok(store.castDevice, 'resuming');
  server.status = () => ({ active: false });
  await run(t, 2000);
  assert.ok(store.castDevice, 'one bare inactive answer');
  await run(t, 2000);
  assert.equal(store.castDevice, null, 'the second in a row ends it');
});

test('a status asked for before our own cast is dropped when it lands after it', async (t) => {
  const eng = setup(t);
  // Fallback mode. The old track is near its end when the poll goes out (slow answer)…
  server.status = playing(290, 300);
  server.statusDelay = 3000;
  cast.startCastPoll();
  await run(t, 2500);                 // request on its way
  store.playerIndex = 1;
  await cast.castTrack(B);            // …the user presses Next meanwhile
  server.statusDelay = 0;
  server.status = stopped({ duration_seconds: 600 }); // B loading: STOPPED
  await run(t, 6000);
  assert.equal(eng.next, 0, 'the late PLAYING 290/300 must not make B\'s loading STOPPED look like an end');
});

test('a hook that throws does not kill the poll chain', async (t) => {
  setup(t);
  t.mock.method(console, 'warn', () => {});
  // _call() shields the hooks; a throw from the engine's Next is not shielded.
  cast.initCast({ nextTrack: () => { throw new Error('boom'); } });
  server.status = follow('STOPPED', 0, 300, 9, trA, { queue_ended: true });
  cast.startCastPoll();
  await run(t, 10_000);
  assert.ok(calls('GET', '/api/dlna/status').length >= 4, 'still polling');
});

test('a superseded cast (409 without cause) is silent and keeps the latches', async (t) => {
  setup(t);
  els['#toastMsg'] && (els['#toastMsg'].textContent = '');
  server.castFail = { status: 409, body: { superseded: true } };
  const res = await cast.castTrack(B);
  assert.equal(res, null);
  assert.equal(els['#toastMsg'] ? els['#toastMsg'].textContent : '', '');
  assert.equal(cast.castState.transitioning, true);
  assert.equal(cast.castState.skipAutoAdvance, true);
  server.castFail = { status: 409, body: { detail: { message: 'Onkyo refused the track', cause: 'device' } } };
  await cast.castTrack(B);
  assert.equal(els['#toastMsg'].textContent, 'Cast failed: Onkyo refused the track', 'a refusal still says so');
});

test('stopping twice hands the position back once', async (t) => {
  const eng = setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  await Promise.all([cast.stopCast(), cast.stopCast()]);
  assert.equal(eng.primed.length, 1);
});

test('castToDevice silences the local decks before the POST and brings them back if it fails', async (t) => {
  const eng = setup(t);
  store.castDevice = null;
  store.playerPlaying = true;
  let pausedAtPost = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (url === '/api/dlna/cast') pausedAtPost = eng.paused; return realFetch(url, opts); };
  t.after(() => { globalThis.fetch = realFetch; });
  server.castFail = { status: 502, body: { detail: { message: 'Cast failed', cause: 'unknown' } } };
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' });
  assert.equal(pausedAtPost, 1, 'paused before the POST went out');
  assert.equal(eng.resumed, 1);
  assert.equal(store.castDevice, null);
});

test('restoreCast on a local-only device stops the leftover session', async (t) => {
  setup(t);
  store.castDevice = null;
  store.deviceOutputMode = 'local';
  server.status = playing(10, 300);
  assert.equal(await cast.restoreCast(), false);
  assert.equal(store.castDevice, null);
  await flush();
  assert.equal(calls('POST', '/api/dlna/stop').length, 1);
});

test('Next on a woken page polls (and adopts) first, then steps from there', async (t) => {
  const eng = setup(t);
  server.status = follow('PLAYING', 70, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 600_000); // asleep; the server moved on to B
  server.status = follow('PLAYING', 30, 600, 2, { queue_index: 1, name: B.name, artist: B.artist, by: 'server' });
  const seen = [];
  const next = () => { if (cast.deferUntilFresh(next)) return; seen.push(store.playerIndex); };
  next();
  assert.deepEqual(seen, [], 'nothing moves before the status is in');
  await flush();
  assert.deepEqual(eng.adopted, [[1, B.name]]);
  assert.deepEqual(seen, [1], 'Next acts from the adopted track');
  next();
  assert.deepEqual(seen, [1, 1], 'a fresh page does not wait');
});

test('adoption: a track in no row is not adopted', async (t) => {
  const eng = setup(t);
  const warn = t.mock.method(console, 'warn', () => {});
  server.status = follow('PLAYING', 3, 600, 4, { queue_index: 7, name: 'Elsewhere', artist: 'Nobody', by: 'server' });
  cast.startCastPoll();
  await run(t, 2000);
  assert.deepEqual(eng.adopted, []);
  assert.equal(store.playerIndex, 0);
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('not in this queue')));
});

test('hand-back: never past the item\'s length; with no length, not minutes past the last report', async (t) => {
  setup(t);
  store.playerQueue[0] = { ...A, duration_ms: 300_000 };
  server.status = playing(100, 0); // a receiver that reports no length
  cast.startCastPoll();
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 120_000);
  assert.ok(Math.abs(cast.castPosition() - 220) < 1, `extrapolated inside the item: ${cast.castPosition()}`);
  t.mock.timers.setTime(Date.now() + 600_000);
  assert.equal(cast.castPosition(), 0, 'past the item\'s end = played out');
  // No length anywhere.
  store.playerQueue[0] = { name: A.name, artist: A.artist };
  assert.equal(cast.castPosition(), 100, 'ten minutes of guessing → the last reported position');
});

// ── Engine glue, through the exported pieces the engines call ──
test('adoptQueueIndex: Smart Queue marks the outgoing track, shuffle books it before the index moves', (t) => {
  setup(t);
  store.shuffleEnabled = true;
  const log = [];
  const item = cast.adoptQueueIndex(2, {
    played: (it) => log.push(['played', it.name]),
    shuffle: (idx) => log.push(['shuffle', idx, store.playerIndex]),
  });
  assert.equal(item, C);
  assert.equal(store.playerIndex, 2);
  assert.deepEqual(log, [['played', A.name], ['shuffle', 2, 0]]);
  assert.equal(cast.adoptQueueIndex(-1, {}), null);
  assert.equal(cast.adoptQueueIndex(9, {}), null);
  assert.equal(store.playerIndex, 2);
});

test('castSeekDuration / castOwnsLocalPause: what the engines\' seek bar and pause listener ask', (t) => {
  setup(t);
  const local = () => 123;
  assert.equal(cast.castSeekDuration(local), 300, 'casting: the item\'s length, not the local deck\'s');
  assert.equal(cast.castOwnsLocalPause(), true);
  store.castDevice = null;
  assert.equal(cast.castSeekDuration(local), 123);
  assert.equal(cast.castOwnsLocalPause(), false);
});

// ── Verification round ──
test('follow: a hand stop at 55:00 of a 60-minute mix is mid-track, as the server sees it', async (t) => {
  setup(t);
  store.playerQueue[0] = { ...A, duration_ms: 3_600_000 };
  const tr = { queue_index: 0, name: A.name, artist: A.artist };
  server.status = follow('PLAYING', 3298, 3600, 1, tr);
  cast.startCastPoll();
  await run(t, 2000);
  server.status = follow('STOPPED', 0, 3600, 1, tr);
  await run(t, 4000);
  assert.ok(Math.abs(cast._internals.state().lastPos - 3300) < 1);
  assert.equal(store.playerPlaying, false, 'the server will not move on: the icon says paused');
  assert.equal(cast.serverNearEnd(3300, 3600), false);
  assert.equal(cast.serverNearEnd(3545, 3600), true, '60 s window for a long track');
  assert.equal(cast.serverNearEnd(256, 300), true, '15 % of a short track');
  assert.equal(cast.serverNearEnd(254, 300), false);
  assert.equal(cast.serverNearEnd(60, 70), true, 'never less than 12 s');
});

for (const which of ['castToDevice', 'autoCastAndPlay']) {
  test(`${which}: a superseded cast is silent and brings no local audio back`, async (t) => {
    const eng = setup(t);
    store.playerPlaying = true;
    if (els['#toastMsg']) els['#toastMsg'].textContent = '';
    server.castFail = { status: 409, body: { superseded: true } };
    const dev = { id: 'uuid:onkyo', name: 'Onkyo' };
    if (which === 'castToDevice') {
      store.castDevice = null;
      await cast.castToDevice(dev);
    } else {
      store.deviceOutputMode = 'dlna_only';
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => (url === '/api/dlna/devices'
        ? reply(200, { devices: [dev] }) : realFetch(url, opts));
      t.after(() => { globalThis.fetch = realFetch; });
      store.castDevice = null;
      await cast.autoCastAndPlay(A, A.name, A.artist);
      assert.ok(store.castDevice, 'the device stays: the later cast owns it');
    }
    assert.equal(eng.resumed, 0);
    assert.equal(els['#toastMsg'] ? els['#toastMsg'].textContent : '', '');
  });
}

test('a status request that never answers is cut off: Next still acts, polling goes on', async (t) => {
  setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 600_000); // woken page
  server.statusHang = true;
  const seen = [];
  const next = () => { if (cast.deferUntilFresh(next)) return; seen.push('next'); };
  next();
  await run(t, 5000);
  assert.deepEqual(seen, [], 'still waiting inside the timeout');
  await run(t, 5000);
  assert.deepEqual(seen, ['next'], 'the cut-off request releases the press');
  server.statusHang = false;
  const n = calls('GET', '/api/dlna/status').length;
  await run(t, 20_000, 500);
  assert.ok(calls('GET', '/api/dlna/status').length > n, 'the chain carries on');
  assert.equal(server.maxOutstanding, 1);
});

// ── Adversarial round ──
test('queue end: handed to the engine only while fresh', async (t) => {
  const eng = setup(t);
  // (a) the server says it ended an hour ago
  server.status = follow('STOPPED', 0, 300, 5, trA, { queue_ended: true, queue_ended_ago: 3600 });
  cast.startCastPoll();
  await run(t, 6000);
  assert.equal(eng.next, 0, 'an old end starts no autoplay');
  // (b) no age given, and this page never saw that cast play
  server.status = follow('STOPPED', 0, 300, 6, trA, { queue_ended: true });
  await run(t, 6000);
  assert.equal(eng.next, 0);
  // (c) no age given, but this page watched cast 7 play to its end
  server.status = follow('PLAYING', 295, 300, 7, trA);
  await run(t, 2000);
  server.status = follow('STOPPED', 0, 300, 7, trA, { queue_ended: true });
  await run(t, 4000);
  assert.equal(eng.next, 1);
});

test('restoreCast ignores a session whose queue ended long ago (and sends no stop)', async (t) => {
  setup(t);
  store.castDevice = null;
  server.status = follow('STOPPED', 0, 300, 4, trA, { queue_ended: true, queue_ended_ago: 7200 });
  assert.equal(await cast.restoreCast(), false);
  assert.equal(store.castDevice, null);
  await flush();
  assert.equal(calls('POST', '/api/dlna/stop').length, 0);
});

test('a new session counts from 0 again: adoption works after Stop + a new cast', async (t) => {
  const eng = setup(t);
  store.castDevice = null;
  server.castSeq = 14;
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' }); // seq 15
  server.status = follow('PLAYING', 10, 300, 15, trA);
  await run(t, 2000);
  await cast.stopCast();
  server.castSeq = 0; // the server's next session
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' }); // seq 1
  server.status = follow('PLAYING', 3, 600, 2, { queue_index: 1, name: B.name, artist: B.artist, by: 'client' });
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[1, B.name]]);
});

test('a new session_id resets the seq without a Stop on this page', async (t) => {
  const eng = setup(t);
  server.status = follow('PLAYING', 10, 300, 15, trA, { session_id: 's1' });
  cast.startCastPoll();
  await run(t, 2000);
  server.status = follow('PLAYING', 3, 600, 2, { queue_index: 1, name: B.name, artist: B.artist, by: 'client' }, { session_id: 's2' });
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[1, B.name]]);
});

test('a server advance under shuffle takes the server\'s saved order before hinting', async (t) => {
  const eng = setup(t);
  store.shuffleEnabled = true;
  server.savedQueue = { queue: [A, B, C].map((x) => ({ ...x })), current_index: 2, shuffle_order: { played: [0, 1], tail: [] } };
  server.status = follow('PLAYING', 10, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 2000);
  server.calls.length = 0;
  server.status = follow('PLAYING', 3, 0, 4, { queue_index: 2, name: C.name, artist: C.artist, by: 'server' });
  await run(t, 4000);
  assert.deepEqual(eng.adopted, [[2, C.name]]);
  assert.deepEqual(eng.saved[0], { shuffle_order: { played: [0, 1], tail: [] }, current_index: 2 });
  const order = server.calls.map(([m, u]) => `${m} ${u}`).filter((c) => !c.includes('/status'));
  const qi = order.indexOf('GET /api/player/queue'), hi = order.indexOf('POST /api/dlna/next-hint');
  assert.ok(qi >= 0 && (hi < 0 || hi > qi), `the hint waits for the saved queue: ${order}`);
});

test('a saved queue that is not ours is not taken', async (t) => {
  const eng = setup(t);
  store.shuffleEnabled = true;
  server.savedQueue = { queue: [A, C, B], current_index: 1, shuffle_order: { played: [0], tail: [2] } };
  server.status = follow('PLAYING', 3, 0, 4, { queue_index: 2, name: C.name, artist: C.artist, by: 'server' });
  cast.startCastPoll();
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[2, C.name]]);
  assert.equal(eng.saved[0], null);
});

test('adoptQueueIndex with the server\'s order: restored after the index moves, its played list marked', (t) => {
  setup(t);
  const D = { name: 'Four', artist: 'X' };
  store.playerQueue = [A, B, C, D];
  store.shuffleEnabled = true;
  const log = [];
  cast.adoptQueueIndex(3, {
    saved: { shuffle_order: { played: [0, 2, 1], tail: [] } },
    played: (it) => log.push(['played', it.name]),
    shuffle: () => log.push(['shuffle']),
    restoreOrder: (o) => log.push(['restore', store.playerIndex, o.played.length]),
  });
  assert.deepEqual(log, [['played', A.name], ['played', C.name], ['played', B.name], ['restore', 3, 3]]);
});

test('adoptQueueIndex without shuffle marks every row the server stepped over', (t) => {
  setup(t);
  const D = { name: 'Four', artist: 'X' };
  store.playerQueue = [A, B, C, D];
  const marked = [];
  cast.adoptQueueIndex(3, { played: (it) => marked.push(it.name) });
  assert.deepEqual(marked, [A.name, B.name, C.name]);
});

test('a cast after a queue change saves the queue first', async (t) => {
  const eng = setup(t);
  const p = cast.castTrack(B);
  store.playerSavePending = true; // the engine's saveQueueDebounced right after starting the cast
  await p;
  const order = server.calls.map(([m, u]) => `${m} ${u}`);
  assert.deepEqual(order, ['PUT /api/player/queue', 'POST /api/dlna/cast']);
  assert.equal(eng.flushes, 1);
  await cast.castTrack(C);
  assert.equal(eng.flushes, 1, 'nothing pending, nothing flushed');
});

test('repeat one: next is the current item', async (t) => {
  setup(t);
  store.repeatMode = 'one';
  await cast.castTrack(A);
  const b = calls('POST', '/api/dlna/cast')[0][2];
  assert.equal(b.next.queue_index, 0);
  assert.equal(b.next.name, A.name);
  assert.equal(b.repeat, 'one');
});

test('presses on a waking page are queued, not merged', async (t) => {
  setup(t);
  server.status = playing(10, 300);
  cast.startCastPoll();
  await run(t, 2000);
  t.mock.timers.setTime(Date.now() + 600_000);
  const seen = [];
  const press = (k) => { const f = () => { if (cast.deferUntilFresh(f)) return; seen.push(k); }; f(); };
  press('next'); press('next'); press('next'); press('prev');
  assert.deepEqual(seen, []);
  await flush();
  assert.deepEqual(seen, ['next', 'next', 'next', 'prev']);
});

test('a status without a volume key leaves the slider alone', async (t) => {
  setup(t);
  els['#fpCastVolume'].value = 35;
  server.status = () => { const st = playing(10, 300)(); delete st.volume; return st; };
  cast.startCastPoll();
  await run(t, 2000);
  assert.equal(els['#fpCastVolume'].value, 35);
});

// ── The reviewer's probes (scratchpad/ct/{seq,ended,shuf}.test.mjs), as assertions ──
test('probe seq: after Stop and a new cast, a server advance is adopted and hinted', async (t) => {
  const eng = setup(t);
  store.castDevice = null;
  server.castSeq = 14;
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' });
  assert.equal(cast._internals.state().castSeq, 15);
  await cast.stopCast();
  server.castSeq = 0; // the server popped the session: the next one starts at 0
  store.playerIndex = 0;
  await cast.castToDevice({ id: 'uuid:onkyo', name: 'Onkyo' });
  assert.equal(cast._internals.state().castSeq, 1);
  server.status = playing(3, 600, { follow: true, cast_seq: 2, track: { queue_index: 1, name: B.name, artist: B.artist, by: 'server' } });
  await run(t, 10_000);
  assert.deepEqual(eng.adopted, [[1, B.name]]);
  assert.equal(store.playerIndex, 1);
  assert.ok(calls('POST', '/api/dlna/next-hint').length >= 1, 'hints flow again for the new session');
});

test('probe ended: a page loaded days after the queue ended starts no autoplay (no queue_ended_ago)', async (t) => {
  // Without queue_ended_ago (older server): the session is taken up, but this page
  // never saw cast 7 play, so its end is not handed to the engine.
  const eng = setup(t);
  store.castDevice = null;
  store.playerIndex = 2;
  server.status = stopped({ follow: true, cast_seq: 7, queue_ended: true,
    track: { queue_index: 2, name: C.name, artist: C.artist, by: 'server' } });
  await cast.restoreCast();
  await run(t, 4000);
  assert.deepEqual(eng.nextOpts, [], 'no autoplay from a stale end');
});

test('probe ended: with queue_ended_ago, a stale ended session is not taken up at all', async (t) => {
  const eng = setup(t);
  store.castDevice = null;
  store.playerIndex = 2;
  server.status = stopped({ follow: true, cast_seq: 7, queue_ended: true, queue_ended_ago: 86_400,
    track: { queue_index: 2, name: C.name, artist: C.artist, by: 'server' } });
  assert.equal(await cast.restoreCast(), false);
  await run(t, 4000);
  assert.equal(store.castDevice, null);
  assert.equal(eng.paused, 0, 'local playback left alone');
  assert.deepEqual(eng.nextOpts, []);
  assert.equal(calls('POST', '/api/dlna/stop').length, 0);
});

test('probe shuf: three tracks the server played while the page slept leave the tail', async (t) => {
  const eng = setup(t);
  const q = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, artist: 'a' }));
  store.playerQueue = q;
  store.playerIndex = 0;
  store.shuffleEnabled = true;
  Q.resetShuffleOrder();
  const before = Q.serializeShuffleOrder();
  const played = before.tail.slice(0, 3);   // the server played these…
  const now = before.tail[3];                // …and plays this one now
  server.savedQueue = { queue: q.map((x) => ({ ...x })), current_index: now,
    shuffle_order: { played: [0, ...played], tail: before.tail.slice(4) } };
  // The engine's adoptTrack, as player_v3 wires it (minus the DOM).
  cast.initCast({ adoptTrack: (idx, track, saved) => {
    eng.adopted.push([idx, track.name]);
    cast.adoptQueueIndex(idx, { shuffle: Q.adoptShuffleIndex, restoreOrder: Q.restoreShuffleOrder, saved });
  } });
  server.status = follow('PLAYING', 5, 0, 9, { queue_index: now, name: q[now].name, artist: 'a', by: 'server' });
  cast.startCastPoll();
  await run(t, 2000);
  assert.deepEqual(eng.adopted, [[now, q[now].name]]);
  assert.equal(store.playerIndex, now);
  const after = Q.serializeShuffleOrder();
  assert.deepEqual(after.tail, before.tail.slice(4), 'the tail is the server\'s');
  for (const i of played) assert.ok(!after.tail.includes(i), `t${i} already played`);
  assert.ok(!played.includes(Q.peekShuffleNext()), 'what plays next is not a track already played');
});

// ── Last verification round ──
for (const how of ['row removed (same array)', 'new playlist (new array)', 'rows reordered']) {
  test(`adoption: a queue changed during the saved-queue read is not booked with the server's order — ${how}`, async (t) => {
    const eng = setup(t);
    store.shuffleEnabled = true;
    server.savedQueue = { queue: [A, B, C].map((x) => ({ ...x })), current_index: 2, shuffle_order: { played: [0, 1], tail: [] } };
    server.queueDelay = 3000;
    server.status = follow('PLAYING', 3, 0, 4, { queue_index: 2, name: C.name, artist: C.artist, by: 'server' });
    cast.startCastPoll();
    await run(t, 2500); // the poll applied, the GET is out
    if (how.startsWith('row')) store.playerQueue.splice(0, 1);          // [B, C]
    else if (how.startsWith('new')) store.playerQueue = [B, C, A];
    else { const q = store.playerQueue; [q[0], q[1]] = [q[1], q[0]]; }  // [B, A, C]
    await run(t, 4000);
    const want = store.playerQueue.indexOf(C);
    assert.deepEqual(eng.adopted, [[want, C.name]], 'the index is found again in the queue as it is now');
    assert.equal(eng.saved[0], null, 'the server\'s order is not used');
  });
}

test('a queue save that hangs holds the cast at most 3 s', async (t) => {
  const eng = setup(t);
  cast.initCast({ flushQueue: () => new Promise(() => {}) }); // never answers
  store.playerSavePending = true;
  const p = cast.castTrack(B);
  await run(t, 2500);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0, 'still waiting for the save');
  await run(t, 1000);
  assert.equal(calls('POST', '/api/dlna/cast').length, 1, 'the cast goes out anyway');
  await p;
  void eng;
});

// ── castState for the remote-control state report (remote-opravy) ──
test('castState carries the receiver\'s position, sample time, duration and play state', async (t) => {
  setup(t);
  server.status = playing(70, 300);
  cast.startCastPoll();
  await run(t, 2000);
  const at = Date.now();
  assert.deepEqual(
    { position: cast.castState.position, positionAt: cast.castState.positionAt, duration: cast.castState.duration, playing: cast.castState.playing },
    { position: 70, positionAt: at, duration: 300, playing: true });
  await cast.castPause();
  assert.equal(cast.castState.playing, false);
  await cast.castPlay();
  assert.equal(cast.castState.playing, true);
  server.status = () => ({ ...playing(95, 300)(), state: 'PAUSED_PLAYBACK' });
  await run(t, 2000);
  assert.equal(cast.castState.position, 95);
  assert.equal(cast.castState.playing, false);
  server.status = stopped(); // a stop freezes where it was; position stays the last one
  await run(t, 2000);
  assert.equal(cast.castState.playing, false);
  assert.equal(cast.castState.position, 95);
  await cast.stopCast();
  assert.deepEqual(
    { position: cast.castState.position, duration: cast.castState.duration, playing: cast.castState.playing },
    { position: 0, duration: 0, playing: false });
  assert.equal(cast.castState.positionAt, Date.now());
});

// ── Autoplay past the end of the queue (2026-11-21) ──
// Production: the phone's screen off, the cast on the queue's last row (174 of 175),
// hint next null → the server ended the queue. The recommender lives in the page; the
// page now hands its next picks to the server at the end of the queue, and adopts the
// rows the server appended from them.
const R = await import('../../static/js/recommendations.js');
const R1 = { id: 'sp-r1', name: 'Rec One', artist: 'Reco A', album: 'LP', image: 'http://img/r1', duration_ms: 180000.4, bpm: 90 };
const R2 = { name: 'Rec Two', artist: 'Reco B', duration_ms: 190000 };
const R3 = { name: 'Rec Three', artist: 'Reco C' };
const wire = (r) => r.map((x) => ({ name: x.name, artist: x.artist, album: x.album || '', image: x.image || '',
  duration_ms: Math.round(x.duration_ms || 0), ...(x.id ? { id: x.id } : {}) }));
const trC = { queue_index: 2, name: C.name, artist: C.artist, by: 'client' };
const trR = (r, qi) => ({ queue_index: qi, name: r.name, artist: r.artist, album: r.album || '', image: r.image || '',
  duration_ms: Math.round(r.duration_ms || 0), by: 'server', autoplay: true });

// The engine's side as player_v3 / player wire it: the real recommender and queue.js.
function setupAutoplay(t, { recs = [R1, R2, R3], atEnd = true } = {}) {
  const eng = setup(t);
  R._internals.reset();
  Q.setAutoplayStartIndex(-1);
  server.recTracks = recs;
  store.radioMode = false;
  store.remoteTarget = null;
  eng.peeks = 0;
  if (atEnd) { store.playerIndex = 2; eng.upcoming = null; }
  cast.initCast({
    peekAutoplay: (n) => { eng.peeks++; return R.peekNextRecs(n); },
    appendAutoplayRows: (rows, at) => { Q.appendAutoplayRows(rows, at); R.markRecsPlayed(rows); },
  });
  t.after(() => { cast.initCast({ peekAutoplay: null, appendAutoplayRows: null }); R._internals.reset(); Q.setAutoplayStartIndex(-1); store.radioMode = false; store.remoteTarget = null; });
  return eng;
}
const hintBodies = () => calls('POST', '/api/dlna/next-hint').map((c) => c[2]);
const recLoads = () => calls('POST', '/api/player/recommendations').length;

test('autoplay: a row the server appended is pushed into the same queue array, marked, never re-cast', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
  // The page sleeps; C ends; the server appends Rec One to the saved queue and casts it.
  const rowR1 = wire([R1])[0];
  server.savedQueue = { queue: [A, B, C, rowR1], current_index: 3, shuffle_order: null };
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3), { autoplay_left: 2 });
  t.mock.timers.setTime(Date.now() + 600_000);
  await run(t, 4000);
  assert.equal(store.playerQueue, q, 'the SAME array (search.js tests its identity)');
  assert.deepEqual(q.map((x) => x.name), [A.name, B.name, C.name, R1.name]);
  assert.equal(q[3].id, 'sp-r1');
  assert.equal(Q.autoplayStart(), 3, 'the "Autoplay" divider sits at the first appended row');
  assert.deepEqual(eng.adopted, [[3, R1.name]]);
  assert.equal(store.playerIndex, 3);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0, 'adopted, not cast');
  assert.equal(eng.next, 0, 'and the engine did not advance on its own');
  // The recommender moved past it, so the next hint offers what comes after.
  assert.equal(R._internals.state().cursor, 0);
  assert.deepEqual(R._internals.state().played.map((x) => x.name), [R1.name]);
  await run(t, 4000);
  const last = hintBodies().at(-1);
  assert.equal(last.queue_index, 3);
  assert.deepEqual(last.autoplay, wire([R2, R3]));
});

test('autoplay: several rows appended while the page slept all arrive; the divider stays at the first', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  const rows = wire([R1, R2]);
  server.savedQueue = { queue: [A, B, C, ...rows], current_index: 4, shuffle_order: null };
  server.status = follow('PLAYING', 5, 190, 3, trR(R2, 4));
  t.mock.timers.setTime(Date.now() + 900_000);
  await run(t, 4000);
  assert.equal(store.playerQueue, q);
  assert.deepEqual(q.map((x) => x.name), [A.name, B.name, C.name, R1.name, R2.name]);
  assert.equal(Q.autoplayStart(), 3);
  assert.deepEqual(eng.adopted, [[4, R2.name]]);
  assert.equal(R._internals.state().cursor, 1, 'both picks count as played');
  // The next one the server appends joins the same tail.
  server.savedQueue = { queue: [A, B, C, ...rows, ...wire([R3])], current_index: 5, shuffle_order: null };
  server.status = follow('PLAYING', 5, 0, 4, trR(R3, 5));
  await run(t, 4000);
  assert.equal(q.length, 6);
  assert.equal(Q.autoplayStart(), 3);
  assert.equal(store.playerIndex, 5);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
});

test('autoplay: with the saved queue unreadable, the row comes from the status', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  server.savedQueue = { queue: [B, A], current_index: 0 }; // not ours + rows: unusable
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3));
  await run(t, 4000);
  assert.equal(store.playerQueue, q);
  assert.deepEqual(q.map((x) => x.name), [A.name, B.name, C.name, R1.name]);
  assert.equal(Q.autoplayStart(), 3);
  assert.deepEqual(eng.adopted, [[3, R1.name]]);
  assert.equal(eng.saved.at(-1), null, 'no server order is taken from a queue that is not ours');
});

test('autoplay: a server track in no row WITHOUT the autoplay mark is still not adopted', async (t) => {
  const eng = setupAutoplay(t);
  t.mock.method(console, 'warn', () => {});
  server.savedQueue = { queue: [A, B, C, wire([R1])[0]], current_index: 3 };
  server.status = follow('PLAYING', 5, 180, 2, { ...trR(R1, 3), autoplay: undefined });
  cast.startCastPoll();
  await run(t, 4000);
  assert.deepEqual(eng.adopted, []);
  assert.equal(store.playerQueue.length, 3);
});

test('autoplay: an awake page does not advance beside the server (no double append)', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 290, 300, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  assert.ok(hintBodies().at(-1).autoplay, 'the server holds the list');
  // The track ends. The server is appending and casting: STOPPED, but NOT queue_ended.
  server.status = follow('STOPPED', 0, 300, 1, trC, { queue_ended: false, autoplay_left: 3 });
  await run(t, 8000);
  assert.equal(eng.next, 0, 'the page leaves the end of the queue to the server');
  assert.equal(q.length, 3);
  server.savedQueue = { queue: [A, B, C, wire([R1])[0]], current_index: 3 };
  server.status = follow('PLAYING', 2, 180, 2, trR(R1, 3), { autoplay_left: 2 });
  await run(t, 8000);
  assert.equal(eng.next, 0);
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
  assert.deepEqual(q.map((x) => x.name), [A.name, B.name, C.name, R1.name], 'exactly one new row');
  assert.deepEqual(eng.adopted, [[3, R1.name]]);
});

test('autoplay: when the server has no list, the end of the queue is still handed to the engine', async (t) => {
  const eng = setupAutoplay(t, { recs: [] });
  server.status = follow('PLAYING', 290, 300, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  server.status = follow('STOPPED', 0, 300, 1, trC, { queue_ended: true, queue_ended_ago: 1 });
  await run(t, 6000);
  assert.equal(eng.next, 1);
  assert.deepEqual(eng.nextOpts[0], { reason: 'ended' });
});

// ── Review round 2 (2026-11-21): the list travels with EVERY cast and hint ──
// M2: a phone locked for the whole queue reaches the last row by the server's own
// advances — no page is awake to hand the list over then. M1: a body WITHOUT `autoplay`
// means "not known" (the server keeps its list); only [] means "nothing".
test('autoplay: every hint carries the picks, wherever in the queue the cast is; nothing is consumed', async (t) => {
  setupAutoplay(t, { atEnd: false });
  server.status = follow('PLAYING', 10, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 10_000);
  const bodies = hintBodies();
  assert.ok(bodies.length >= 1);
  assert.ok(bodies.every((b) => !Array.isArray(b.autoplay) || b.autoplay.length > 0),
    'while the recommender loads, the hint says nothing about autoplay — never an emptying []');
  assert.deepEqual(bodies.at(-1), { queue_index: 0, next: { queue_index: 1, name: B.name, artist: B.artist, album: '', image: '', duration_ms: 600000 },
    repeat: 'off', shuffle: false, autoplay: wire([R1, R2, R3]) }, 'row 0 of 3, and the list is there');
  assert.equal(recLoads(), 1, 'the picks are loaded once');
  assert.equal(R._internals.state().cursor, -1, 'peeking consumed nothing');
  assert.deepEqual(R._internals.state().played, []);
  const sent = hintBodies().length;
  await run(t, 30_000);
  assert.equal(hintBodies().length, sent, 'an unchanged list is not sent again');
  assert.equal(recLoads(), 1);
});

test('autoplay: repeat and radio say [] (nothing follows), a controller says nothing; a changed list is sent again', async (t) => {
  setupAutoplay(t);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 8000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
  store.repeatMode = 'all';
  await run(t, 4000);
  assert.deepEqual(hintBodies().at(-1).autoplay, [], 'repeat all wraps: no autoplay');
  assert.equal(hintBodies().at(-1).repeat, 'all');
  store.repeatMode = 'off';
  await run(t, 4000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
  store.radioMode = true;
  await run(t, 4000);
  assert.deepEqual(hintBodies().at(-1).autoplay, [], 'radio refills itself');
  store.radioMode = false;
  await run(t, 4000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
  const n = hintBodies().length;
  store.remoteTarget = 'other-device';
  cast._internals.reset(); cast.startCastPoll(); // forget what was sent: a hint goes out again
  await run(t, 4000);
  assert.equal(hintBodies().length, n + 1);
  assert.equal('autoplay' in hintBodies().at(-1), false, 'a controller has no say: the field is absent');
  store.remoteTarget = null;
  await run(t, 4000);
  // The user dismisses the first pick in the panel: the list changed.
  R.dismissRec(0);
  await run(t, 4000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R2, R3]));
});

test('autoplay: a cast before the recommender knows has NO autoplay field; later casts carry the list, mid-queue too', async (t) => {
  const eng = setupAutoplay(t, { atEnd: false });
  // App just reopened: nothing cached. The cast must not say "none" (M1).
  await cast.castItem(A);
  let body = calls('POST', '/api/dlna/cast').at(-1)[2];
  assert.equal('autoplay' in body, false);
  await flush(); // the load the peek started has answered
  await cast.castItem(A);
  body = calls('POST', '/api/dlna/cast').at(-1)[2];
  assert.deepEqual(body.autoplay, wire([R1, R2, R3]), 'row 0 of 3');
  assert.equal(body.next.name, B.name);
  // The current track itself is never offered as its own continuation.
  store.playerIndex = 2; eng.upcoming = null;
  server.recTracks = [{ name: C.name.toUpperCase(), artist: C.artist }, R2];
  R._internals.reset();
  R.peekNextRecs(20);
  await flush();
  await cast.castItem(C);
  assert.deepEqual(calls('POST', '/api/dlna/cast').at(-1)[2].autoplay, wire([R2]));
  assert.equal(recLoads(), 2);
});

test('autoplay: up to 20 picks are sent', async (t) => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `Pick ${i}`, artist: 'Reco' }));
  setupAutoplay(t, { recs: many });
  R.peekNextRecs(20);
  await flush();
  await cast.castItem(C);
  assert.equal(calls('POST', '/api/dlna/cast').at(-1)[2].autoplay.length, 20);
});

test('recommender: peek is null while unknown, the list once loaded, [] when it has nothing — and moves nothing', async (t) => {
  setup(t);
  R._internals.reset();
  t.after(() => R._internals.reset());
  server.recTracks = [R1, R2, R3];
  assert.equal(R.peekNextRecs(10), null, 'nothing cached yet — a load starts, the answer is "not known"');
  assert.equal(R.peekNextRecs(10), null);
  await flush();
  assert.equal(recLoads(), 1, 'one load for both calls');
  assert.deepEqual(R.peekNextRecs(2).map((x) => x.name), [R1.name, R2.name]);
  assert.deepEqual(R._internals.state().cursor, -1);
  assert.deepEqual(R._internals.state().played, []);
  // Rows played on the page's behalf move the cursor; unknown rows change nothing.
  assert.equal(R.markRecsPlayed([{ name: 'Nobody', artist: 'X' }]), false);
  assert.equal(R.markRecsPlayed([{ name: R2.name.toUpperCase(), artist: R2.artist }]), true);
  assert.equal(R._internals.state().cursor, 1);
  assert.deepEqual(R.peekNextRecs(10).map((x) => x.name), [R3.name]);
  assert.equal(R.markRecsPlayed([R1]), true);
  assert.equal(R._internals.state().cursor, 1, 'never backwards');
  // Nothing at all comes back: [] — but only after the answer, and a failure stays null.
  R._internals.reset();
  server.recTracks = [];
  assert.equal(R.peekNextRecs(10), null);
  await flush();
  assert.deepEqual(R.peekNextRecs(10), []);
  R._internals.reset();
  server.recsFail = true;
  assert.equal(R.peekNextRecs(10), null);
  await flush();
  assert.equal(R.peekNextRecs(10), null, 'a failed load is not "nothing"');
});

// H1: the user starts another playlist while the adoption's GET is out and the new
// cast's POST has not answered — the old autoplay row must not land in the new queue.
test('autoplay: a new playlist started during the adoption keeps the old autoplay row out', async (t) => {
  const eng = setupAutoplay(t);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  server.savedQueue = { queue: [A, B, C, wire([R1])[0]], current_index: 3 };
  server.queueDelay = 3000;
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3));
  await run(t, 2500); // the poll saw seq 2; GET /api/player/queue is out
  assert.equal(calls('GET', '/api/player/queue').length, 1);
  // The user taps another playlist: a new queue array, and its cast is on its way.
  const X = { name: 'New One', artist: 'Other' }, Y = { name: 'New Two', artist: 'Other' };
  const fresh = [X, Y];
  store.playerQueue = fresh; store.playerIndex = 0; eng.upcoming = { index: 1, item: Y };
  let release;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/dlna/cast') await new Promise((r) => { release = r; });
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const p = cast.castTrack(X);
  await run(t, 4000); // the GET answers while the POST is still out
  assert.equal(store.playerQueue, fresh);
  assert.deepEqual(fresh.map((x) => x.name), ['New One', 'New Two'], 'nothing of the old queue was added');
  assert.equal(store.playerIndex, 0);
  assert.deepEqual(eng.adopted, []);
  release();
  await p;
});

// M3: the user queued a track on the last row; the server had already moved on to a pick.
test('autoplay: the pick the server played goes right after the row it followed — a track queued meanwhile stays ahead', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  const N = { name: 'Queued By Hand', artist: 'User' };
  q.push(N); eng.upcoming = { index: 3, item: N };
  // The page's save replaced the file after the server appended: the pick is in no file.
  server.savedQueue = { queue: [A, B, C, N], current_index: 2 };
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3));
  await run(t, 4000);
  assert.equal(store.playerQueue, q);
  assert.deepEqual(q.map((x) => x.name), [A.name, B.name, C.name, R1.name, N.name]);
  assert.deepEqual(eng.adopted, [[3, R1.name]]);
  assert.equal(store.playerIndex, 3, 'the pick is current, the queued track is the next row');
  assert.equal(Q.autoplayStart(), -1, 'no "Autoplay" divider above a track the user queued');
  assert.equal(calls('POST', '/api/dlna/cast').length, 0);
});

test('a queue change while casting saves and hints at once (not at the next poll)', async (t) => {
  const eng = setupAutoplay(t);
  const q = store.playerQueue;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  const before = hintBodies().length;
  assert.equal(hintBodies().at(-1).next, null);
  // The user queues a track on the last row (the engine: push, saveQueueDebounced).
  const N = { name: 'Queued By Hand', artist: 'User', duration_ms: 1000 };
  q.push(N); eng.upcoming = { index: 3, item: N };
  store.playerSavePending = true;
  server.calls.length = 0;
  cast.noteQueueChanged();
  cast.noteQueueChanged(); // the engine saves more than once per edit
  await flush(); // no timer runs: this is not the poll
  const order = server.calls.map(([m, u]) => `${m} ${u}`);
  assert.deepEqual(order, ['PUT /api/player/queue', 'POST /api/dlna/next-hint'], 'the save first — the hint names a row the file must hold');
  assert.equal(server.calls[1][2].next.name, N.name);
  assert.equal(server.calls[1][2].next.queue_index, 3);
  assert.equal(hintBodies().length, 1);
  void before;
  // Nothing changed: nothing is sent.
  cast.noteQueueChanged();
  await flush();
  assert.equal(server.calls.length, 2);
});

// H2, page side: the page is about to be frozen with a queue save still in its debounce.
test('hiding the page while casting flushes a pending queue save; a stale page does not', async (t) => {
  const eng = setupAutoplay(t);
  const handlers = {};
  const realAdd = document.addEventListener;
  document.addEventListener = (ev, fn) => { handlers[ev] = fn; };
  t.after(() => { document.addEventListener = realAdd; document.hidden = false; });
  cast.wireControls();
  assert.equal(typeof handlers.visibilitychange, 'function');
  globalThis.__onVisibility = handlers.visibilitychange; // wired once per module: kept for the next test
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  store.playerSavePending = true;
  document.hidden = true;
  handlers.visibilitychange();
  await flush();
  assert.equal(eng.flushes, 1);
  // Woken long after, hidden again before any status: what it holds is old.
  document.hidden = false;
  store.playerSavePending = true;
  t.mock.timers.setTime(Date.now() + 600_000);
  document.hidden = true;
  handlers.visibilitychange();
  await flush();
  assert.equal(eng.flushes, 1);
});

// ── Review round 3 (2026-11-21) ──
// N2: an empty recommender used to flip [] → null → [] at every reload (two hints and a
// recommendations POST a minute for the whole cast).
test('autoplay: an empty recommender says [] once, keeps saying it through reloads, and is asked ever more rarely', async (t) => {
  setupAutoplay(t, { recs: [] });
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 30_000);
  assert.equal(recLoads(), 1, 'fifteen polls, one load');
  assert.deepEqual(hintBodies().at(-1).autoplay, [], 'asked, and it has nothing');
  const h = hintBodies().length;
  await run(t, 120_000); // t = 150 s: one reload, a minute after the first answer
  assert.equal(recLoads(), 2);
  await run(t, 80_000);  // t = 230 s: the next one came two minutes later, not one
  assert.equal(recLoads(), 3);
  assert.equal(hintBodies().length, h, 'no hint was re-sent while the answer stayed "nothing"');
  // A reload that FAILS is not an answer: the previous one stands.
  server.recsFail = true;
  await run(t, 230_000); // t = 460 s: the reload due four minutes after the third
  assert.equal(recLoads(), 4);
  assert.equal(hintBodies().length, h);
  assert.deepEqual(R.peekNextRecs(20), []);
  // Picks at last: sent, and the back-off is over.
  server.recsFail = false;
  server.recTracks = [R1];
  await run(t, 70_000);
  assert.equal(recLoads(), 5, 'a failure is retried after a minute');
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1]));
  await run(t, 300_000);
  assert.equal(recLoads(), 5, 'a list in hand is not loaded again');
});

test('autoplay: a failed first load says nothing (the field is absent), and is retried a minute later', async (t) => {
  setupAutoplay(t);
  server.recsFail = true;
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 30_000);
  assert.equal(recLoads(), 1);
  assert.ok(hintBodies().every((b) => !('autoplay' in b)), '"not known": the server keeps what it has');
  server.recsFail = false;
  await run(t, 40_000);
  assert.equal(recLoads(), 2);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
});

// N4: picks made for the queue the user left are not the new queue's.
test('autoplay: a new queue array makes the cached picks "not known" until they are loaded for it', async (t) => {
  const eng = setupAutoplay(t);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  assert.deepEqual(hintBodies().at(-1).autoplay, wire([R1, R2, R3]));
  assert.equal(recLoads(), 1);
  // Another playlist: a fresh array (upnext.playTracks), and its own picks.
  const X = { name: 'New One', artist: 'Other' }, Y = { name: 'New Two', artist: 'Other' };
  store.playerQueue = [X, Y]; store.playerIndex = 0; eng.upcoming = { index: 1, item: Y };
  const N1 = { name: 'For The New Queue', artist: 'Reco' };
  server.recTracks = [N1];
  assert.equal(R.peekNextRecs(20), null, 'the old picks are not offered for the new queue');
  assert.equal(recLoads(), 2, 'a load for it starts at once, whatever the retry clock says');
  assert.equal(R.peekNextRecs(20), null);
  await cast.castItem(X);
  assert.equal('autoplay' in calls('POST', '/api/dlna/cast').at(-1)[2], false, 'the cast of the new queue says "not known", not the old picks');
  await flush();
  assert.equal(recLoads(), 2);
  assert.deepEqual(R.peekNextRecs(20).map((x) => x.name), [N1.name]);
  await cast.castItem(X);
  assert.deepEqual(calls('POST', '/api/dlna/cast').at(-1)[2].autoplay, wire([N1]));
});

// N1: the engine holds a debounced save while the view is stale. The hold must end with
// the EVENT that makes the view fresh, not with a timer that happens to look in time.
test('a held queue save is released by the poll itself: after the status is applied (and any adoption done)', async (t) => {
  const eng = setupAutoplay(t);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  cast._internals.reset(); // no poll chain: only what the test asks for
  store.castDevice = { id: 'uuid:onkyo', name: 'Onkyo' };
  // A hidden desktop tab: timers batched once a minute. The last status is a minute old.
  t.mock.timers.setTime(Date.now() + 60_000);
  store.playerSavePending = true; // an edit the engine is holding
  assert.equal(cast.castStateFresh(), false);
  assert.equal(cast.castMaySaveOnUnload(), true, 'an edit that waits is not dropped when the tab closes');
  server.statusDelay = 500;
  const p = cast.pollCastOnce();
  await flush();
  assert.equal(eng.flushes, 0, 'not before the status is in');
  await run(t, 1000);
  await p;
  assert.equal(eng.flushes, 1, 'the poll released it');
  assert.equal(store.playerSavePending, false);
  // … and the minute after: the status has aged again, the next edit goes the same way.
  t.mock.timers.setTime(Date.now() + 60_000);
  store.playerSavePending = true;
  const p2 = cast.pollCastOnce();
  await run(t, 1000);
  await p2;
  assert.equal(eng.flushes, 2);
});

test('a held save is not released into an adoption that is still reading the server\'s queue', async (t) => {
  const eng = setupAutoplay(t);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  cast._internals.reset();
  store.castDevice = { id: 'uuid:onkyo', name: 'Onkyo' };
  t.mock.timers.setTime(Date.now() + 600_000);
  store.playerSavePending = true;
  server.savedQueue = { queue: [A, B, C, wire([R1])[0]], current_index: 3 };
  server.queueDelay = 2000;
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3));
  const p = cast.pollCastOnce();
  await run(t, 1000);
  assert.equal(calls('GET', '/api/player/queue').length, 1);
  assert.equal(eng.flushes, 0, 'the page\'s old queue must not be written under the adoption');
  assert.equal(cast.castMaySaveOnUnload(), false, 'nor by the unload save');
  await run(t, 3000);
  await p;
  assert.deepEqual(eng.adopted, [[3, R1.name]]);
  assert.equal(store.playerQueue.length, 4);
  assert.equal(eng.flushes, 1, 'saved once the appended row is in');
});

test('the unload save: allowed when fresh or when an edit waits; refused for a page that merely woke up', async (t) => {
  setupAutoplay(t);
  store.castDevice = null;
  assert.equal(cast.castMaySaveOnUnload(), true, 'not casting');
  store.castDevice = { id: 'uuid:onkyo', name: 'Onkyo' };
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  assert.equal(cast.castMaySaveOnUnload(), true, 'fresh');
  cast._internals.reset();
  store.castDevice = { id: 'uuid:onkyo', name: 'Onkyo' };
  t.mock.timers.setTime(Date.now() + 600_000);
  store.playerSavePending = false;
  assert.equal(cast.castMaySaveOnUnload(), false, 'woke up, nothing of its own to save: the file is the server\'s');
  store.playerSavePending = true;
  assert.equal(cast.castMaySaveOnUnload(), true);
});

test('noteQueueChanged: nothing without a followed cast; on a stale page it polls first, then saves and hints', async (t) => {
  const eng = setupAutoplay(t);
  store.playerSavePending = true;
  cast.noteQueueChanged(); // no status seen yet
  await flush();
  assert.equal(eng.flushes, 0);
  assert.equal(calls('GET', '/api/dlna/status').length, 0);
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  // A hidden tab gets a remote command: a row is inserted. Its last status is old.
  const q = store.playerQueue;
  const N = { name: 'Queued By Remote', artist: 'User' };
  q.push(N); eng.upcoming = { index: 3, item: N };
  t.mock.timers.setTime(Date.now() + 60_000);
  store.playerSavePending = true;
  server.calls.length = 0;
  cast.noteQueueChanged();
  await flush(); // no timer runs
  assert.deepEqual(server.calls.map(([m, u]) => `${m} ${u}`),
    ['GET /api/dlna/status', 'PUT /api/player/queue', 'POST /api/dlna/next-hint'],
    'look, then save, then tell — never the page\'s queue written blind');
  assert.equal(server.calls[2][2].next.name, N.name);
});

// N5: the two guards of H1, each on its own.
test('adoption: a cast POST on its way stops an adoption even when the track is in the new queue', async (t) => {
  const eng = setup(t);
  server.status = follow('PLAYING', 10, 300, 1, trA);
  cast.startCastPoll();
  await run(t, 4000);
  server.savedQueue = { queue: [A, B, C], current_index: 1 };
  server.queueDelay = 3000;
  server.status = follow('PLAYING', 5, 600, 2, { queue_index: 1, name: B.name, artist: B.artist, by: 'server' });
  await run(t, 2500); // GET /api/player/queue is out
  // A new playlist that happens to hold B too; its first track is being cast.
  const X = { name: 'New One', artist: 'Other' };
  store.playerQueue = [X, { ...B }]; store.playerIndex = 0; eng.upcoming = { index: 1, item: store.playerQueue[1] };
  let release;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/dlna/cast') await new Promise((r) => { release = r; });
    return realFetch(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const p = cast.castTrack(X);
  await run(t, 4000);
  assert.deepEqual(eng.adopted, [], 'the user\'s own cast owns the page now');
  assert.equal(store.playerIndex, 0);
  release();
  await p;
});

test('adoption: an autoplay row is not added to a queue that was replaced meanwhile (no cast in flight)', async (t) => {
  const eng = setupAutoplay(t);
  t.mock.method(console, 'warn', () => {});
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 6000);
  server.savedQueue = { queue: [A, B, C, wire([R1])[0]], current_index: 3 };
  server.queueDelay = 3000;
  server.status = follow('PLAYING', 5, 180, 2, trR(R1, 3));
  await run(t, 2500);
  // The queue is replaced without anything being cast (a playlist loaded paused, a transfer).
  const fresh = [{ name: 'New One', artist: 'Other' }, { name: 'New Two', artist: 'Other' }];
  store.playerQueue = fresh; store.playerIndex = 0; eng.upcoming = { index: 1, item: fresh[1] };
  await run(t, 4000);
  assert.deepEqual(fresh.map((x) => x.name), ['New One', 'New Two']);
  assert.deepEqual(eng.adopted, []);
});

// N6: the save on hide asks for keepalive.
test('hiding the page asks the engine for a keepalive save', async (t) => {
  const eng = setupAutoplay(t);
  const handlers = { visibilitychange: globalThis.__onVisibility };
  t.after(() => { document.hidden = false; });
  let got = null;
  cast.initCast({ flushQueue: async (o) => { got = o; store.playerSavePending = false; } });
  server.status = follow('PLAYING', 10, 0, 1, trC);
  cast.startCastPoll();
  await run(t, 4000);
  store.playerSavePending = true;
  document.hidden = true;
  handlers.visibilitychange();
  await flush();
  assert.deepEqual(got, { keepalive: true });
  void eng;
});
