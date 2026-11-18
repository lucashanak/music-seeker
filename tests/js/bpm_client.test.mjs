// Client half of the BPM ownership rule. Run: node --test tests/js/bpm_client.test.mjs
// Real bpm.js / api.js / queue.js run against a stubbed fetch; nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
let reply = () => ({ status: 200, body: { owned: false } });
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const r = reply(String(url));
  return {
    ok: r.status < 400, status: r.status,
    headers: { get: () => null },
    json: async () => r.body, text: async () => JSON.stringify(r.body),
  };
};
globalThis.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }), dispatchEvent() {}, getElementById: () => null, addEventListener() {}, querySelector: () => null };
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const bpm = await import('../../static/js/bpm.js');
const { store } = await import('../../static/js/store.js');

const trackCalls = () => calls.filter(u => u.includes('/api/bpm/track'));

test('owned:false is asked once, then remembered without a request', async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { owned: false } });
  assert.equal(await bpm.fetchTrackBpm('Nope', 'Nobody'), null);
  assert.equal(bpm.isBpmUnavailable('Nope', 'Nobody'), true);
  assert.equal(await bpm.fetchTrackBpm('Nope', 'Nobody'), null);
  assert.equal(trackCalls().length, 1);
});

test('a track with BPM is returned and cached', async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { name: 'A', artist: 'B', bpm: 128 } });
  const d = await bpm.fetchTrackBpm('A', 'B');
  assert.equal(d.bpm, 128);
  await bpm.fetchTrackBpm('A', 'B');
  assert.equal(trackCalls().length, 1);
  assert.equal(bpm.isBpmUnavailable('A', 'B'), false);
});

test('an error is not remembered as "not owned" (a later ask still goes out)', async () => {
  calls.length = 0;
  reply = () => ({ status: 404, body: { detail: 'audio not available' } });
  assert.equal(await bpm.fetchTrackBpm('E', 'F'), null);
  assert.equal(bpm.isBpmUnavailable('E', 'F'), false);
  await bpm.fetchTrackBpm('E', 'F');
  assert.equal(trackCalls().length, 2);
});

test('the client does not gate on any ownership flag: an item without one is still asked', async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { name: 'U', artist: 'V', bpm: 100 } });
  // shape of an Up Next item built before the server sent `owned`
  const item = { id: '1', name: 'U', artist: 'V', type: 'track' };
  const d = await bpm.fetchTrackBpm(item.name, item.artist);
  assert.equal(d.bpm, 100);
  assert.equal(trackCalls().length, 1);
});

test('queue render shows a "no BPM" badge for a remembered not-owned track and nothing for an unknown one', async () => {
  reply = () => ({ status: 200, body: { owned: false } });
  await bpm.fetchTrackBpm('Gone', 'Artist');
  let q;
  try { q = await import('../../static/js/queue.js'); } catch (e) { assert.fail('queue.js import: ' + e.message); }
  const el = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  store.playerQueue = [
    { name: 'Gone', artist: 'Artist' },
    { name: 'Unknown', artist: 'Artist' },
  ];
  store.playerIndex = 0;
  q.renderQueueInto(el);
  const html = el.innerHTML;
  assert.equal((html.match(/qi-nobpm/g) || []).length, 1);
  const [first, second] = html.split('data-qi="1"');
  assert.ok(first.includes('qi-nobpm') && !second.includes('qi-nobpm'));
});

// ── review round 2 ──

test('the client forgets "not owned" after the 10 minute TTL', async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { owned: false } });
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    await bpm.fetchTrackBpm('Ttl', 'Art');
    t += 10 * 60 * 1000 - 1000;
    assert.equal(bpm.isBpmUnavailable('Ttl', 'Art'), true);
    t += 2000;
    assert.equal(bpm.isBpmUnavailable('Ttl', 'Art'), false);
  } finally { Date.now = realNow; }
});

test('forgetBpmUnavailable lets a downloaded track be asked again', async () => {
  calls.length = 0;
  reply = () => ({ status: 200, body: { owned: false } });
  await bpm.fetchTrackBpm('Dl', 'Art');
  assert.equal(bpm.isBpmUnavailable('Dl', 'Art'), true);
  bpm.forgetBpmUnavailable();
  assert.equal(bpm.isBpmUnavailable('Dl', 'Art'), false);
});

test('a download job going running -> done clears the "not owned" memory', async () => {
  reply = () => ({ status: 200, body: { owned: false } });
  await bpm.fetchTrackBpm('Job', 'Art');
  assert.equal(bpm.isBpmUnavailable('Job', 'Art'), true);
  const { checkJobCompletions } = await import('../../static/js/downloads.js');
  store.notificationsEnabled = false;
  checkJobCompletions([{ id: 'j1', status: 'running' }]);
  assert.equal(bpm.isBpmUnavailable('Job', 'Art'), true);
  checkJobCompletions([{ id: 'j1', status: 'done' }]);
  assert.equal(bpm.isBpmUnavailable('Job', 'Art'), false);
});

function fakePanel(inserted) {
  const qi = {
    querySelector: (sel) => sel === '.qi-remove' ? { insertAdjacentHTML: (_w, html) => inserted.push(html), before() {} } : null,
  };
  return {
    innerHTML: '', querySelectorAll: () => [], addEventListener() {},
    querySelector: (sel) => /^\[data-qi="\d+"\]$/.test(sel) ? qi : null,
  };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('lazy path: a track the server answers owned:false gets the "no BPM" badge', async () => {
  reply = () => ({ status: 200, body: { owned: false } });
  const q = await import('../../static/js/queue.js');
  store.playerQueue = [{ name: 'Lazy', artist: 'One' }];
  store.playerIndex = 0;
  const inserted = [];
  q.renderQueueInto(fakePanel(inserted));
  await sleep(1500);
  assert.equal(inserted.length, 1);
  assert.ok(inserted[0].includes('qi-nobpm'));
});

test('lazy path: a panel re-rendered while the request is in flight gets no stale badge', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    await gate;
    return prevFetch(url);
  };
  reply = () => ({ status: 200, body: { owned: false } });
  const q = await import('../../static/js/queue.js');
  store.playerQueue = [{ name: 'Race', artist: 'Two' }];
  store.playerIndex = 0;
  const inserted = [];
  const panel = fakePanel(inserted);
  try {
    q.renderQueueInto(panel);
    await sleep(1200);          // timer fired, fetch is parked on the gate
    q.renderQueueInto(panel);   // re-render aborts the first run
    release();
    await sleep(300);
    assert.equal(inserted.length, 0);
  } finally { globalThis.fetch = prevFetch; }
});

test('energyLevel: five steps over 0–1, and nothing for the old loudness-based version', async () => {
  const { energyLevel } = await import('../../static/js/bpm.js');
  assert.equal(energyLevel({ energy: 0, feature_version: 2 }), 1);
  assert.equal(energyLevel({ energy: 0.19, feature_version: 2 }), 1);
  assert.equal(energyLevel({ energy: 0.5, feature_version: 2 }), 3);
  assert.equal(energyLevel({ energy: 1, feature_version: 2 }), 5);
  assert.equal(energyLevel({ energy: 0.9, feature_version: 1 }), null);   // version 1 followed mastering loudness
  assert.equal(energyLevel({ energy: 0.9 }), null);
  assert.equal(energyLevel({ feature_version: 2 }), null);
  assert.equal(energyLevel(null), null);
});
