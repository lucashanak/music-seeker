// A mix found in search plays from its own URL, never from a title lookup.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let api, store;

before(async () => {
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  globalThis.window = { addEventListener() {}, location: { href: '', origin: 'http://x' } };
  process.on('unhandledRejection', () => {});
  ({ store } = await import('../../static/js/store.js'));
  api = await import('../../static/js/api.js');
  store.streamToken = 'tok';
});

test('an item with mix_url gets the dedicated, progressive stream URL carrying the exact link', () => {
  const url = 'https://www.mixcloud.com/dj/set-one/';
  const u = api.mixPlayUrl({ name: 'Set one', artist: 'DJ', mix_url: url });
  assert.ok(u.startsWith('/api/player/mix-stream?'));
  const q = new URL(u, 'http://x').searchParams;
  assert.equal(q.get('url'), url);
  assert.equal(q.get('token'), 'tok');
  assert.equal(q.get('progressive'), '1');
  assert.ok(!u.includes('name='), 'no title lookup parameters');
});

test('an ordinary or downloaded track has none', () => {
  assert.equal(api.mixPlayUrl({ name: 'A song', artist: 'X' }), '');
  assert.equal(api.mixPlayUrl(null), '');
  assert.equal(api.mixPlayUrl({ name: 'A', mix_url: '' }), '');
});

test('Play on a mix result while casting leaves the queue and the current track alone (guard before playTracks)', async () => {
  const toasts = [];
  globalThis.document.createElement = () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} }, set textContent(v) { toasts.push(v); } });
  globalThis.document.body = { appendChild() {} };
  const mixes = await import('../../static/js/mixes.js');
  const before = [{ name: 'Playing now', artist: 'X' }];
  store.playerQueue = before;
  store.playerIndex = 0;
  store.castDevice = { id: 'uuid:x', name: 'Onkyo' };
  store.deviceOutputMode = 'default';
  mixes.playResult({ title: 'Set', uploader: 'DJ', url: 'https://www.mixcloud.com/dj/set/', duration: 3600, in_library: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.playerQueue, before, 'the queue array is untouched');
  assert.equal(store.playerIndex, 0);
  store.castDevice = null;
});

test('a streamed mix keeps its declared length until the server says the file is finished', async () => {
  globalThis.location = { href: 'http://x/' };
  const ms = await import('../../static/js/mixstream.js');
  const src = 'http://x/api/player/mix-stream?url=https%3A%2F%2Fm.example%2Fa&token=t&progressive=1&dur=1479';
  assert.equal(ms.mixKnownDuration(src), 1479, 'the element is never asked: it says 7 s at second 7, and ~90 % near a real-time fetch');
  assert.equal(ms.mixKnownDuration('http://x/api/player/mix-stream?url=u&token=t&dur=1479'), 0, 'the finished file we loaded: the element knows');
  assert.equal(ms.mixKnownDuration('http://x/api/player/stream?name=a&progressive=1&dur=9'), 0, 'not a mix stream');
  // the server's answer for a finished file: its real length replaces the hint
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, cached: true, building: false, duration: 1470.2 }) });
  await ms.mixStatus(src);
  assert.equal(ms.mixKnownDuration(src), 1470.2);
});

test('bufferedTo tells whether a seek target is already fetched', async () => {
  const ms = await import('../../static/js/mixstream.js');
  const el = { buffered: { length: 1, start: () => 0, end: () => 120 } };
  assert.equal(ms.bufferedTo(el, 60), true);
  assert.equal(ms.bufferedTo(el, 900), false);
});

test('a refused stream is explained with the server\'s reason, not a bare "Stream error"', async () => {
  const ms = await import('../../static/js/mixstream.js');
  const toasts = [];
  const els = {};
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = (s) => els[s] || null;
  globalThis.document.createElement = () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} }, set textContent(v) { toasts.push(v); }, get textContent() { return toasts[toasts.length - 1] || ''; } });
  globalThis.fetch = async (url) => ({ ok: true, json: async () => ({ ok: false, status: 429, message: 'Too many mixes are being prepared — wait a moment' }) });
  await ms.explainMixFailure({ name: 'x', mix_url: 'https://www.mixcloud.com/dj/set/' }, 'Stream error, skipping...');
  assert.ok(toasts.some((t) => /Too many mixes/.test(t)), JSON.stringify(toasts));
  toasts.length = 0;
  globalThis.fetch = async () => { throw new Error('offline'); };
  await ms.explainMixFailure({ name: 'x', mix_url: 'https://www.mixcloud.com/dj/set/' }, 'Stream error, skipping...');
  assert.ok(toasts.some((t) => /Stream error, skipping/.test(t)), 'falls back to the generic text');
});

test('isPrematureMixEnd: more than 20 s short of the known length is not an end', async () => {
  globalThis.location = { href: 'http://x/' };
  const ms = await import('../../static/js/mixstream.js');
  const src = 'http://x/api/player/mix-stream?url=u&token=t&dur=3600';
  const item = { mix_url: 'u', duration_ms: 3600000 };
  assert.equal(ms.isPrematureMixEnd({ src, currentTime: 300 }, item), true);
  assert.equal(ms.isPrematureMixEnd({ src, currentTime: 3590 }, item), false);
  assert.equal(ms.isPrematureMixEnd({ src: 'http://x/api/player/stream?name=a', currentTime: 300 }, item), false, 'not a mix stream');
  assert.equal(ms.isPrematureMixEnd({ src, currentTime: 300 }, { duration_ms: 3600000 }), false, 'not a streamed mix item');
  assert.equal(ms.isPrematureMixEnd({ src, currentTime: 30 }, { mix_url: 'u', duration_ms: 40000 }), false, 'a short claim is not trusted');
});
