// The shuffle order has to survive a restart. Before this, it lived only in the
// page: every reload dealt a new permutation, so the queue panel showed a
// different running order than the one playing and already-played tracks came
// round again.
//
// The second half guards the drag. The rows are drawn in the shuffled order but
// carry their queue index, so a drag used to move whatever track happened to sit
// at that index — and in a named playlist that rewrite is mirrored to Navidrome.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let Q, store;

before(async () => {
  // queue.js reaches for the document through its helpers at import time. Give it
  // just enough of a browser to load; no assertion below touches the DOM.
  const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, insertBefore() {}, querySelector: () => null,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: el, body: el(),
  };
  globalThis.window = { addEventListener() {}, innerWidth: 400, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  globalThis.history = { pushState() {}, back() {} };
  // renderQueue() lazy-imports recommendations.js, which has no business loading here.
  process.on('unhandledRejection', () => {});

  Q = await import('../../static/js/queue.js');
  ({ store } = await import('../../static/js/store.js'));
  Q.setPlayerRefs({ loadAndPlay() {}, hidePlayerBar() {}, saveQueueDebounced() {}, audio: null, getAudio: () => null });
});

const tracks = (n) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, artist: 'a' }));

beforeEach(() => {
  Q.resetShuffleOrder();
  store.shuffleEnabled = false;
  store.playerQueue = [];
  store.playerIndex = -1;
});

test('nothing is saved while shuffle is off', () => {
  store.playerQueue = tracks(5);
  store.playerIndex = 0;
  assert.equal(Q.serializeShuffleOrder(), null);
});

test('the running order comes back after a restart', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(6);
  store.playerIndex = 0;
  const dealt = Q.playOrder();
  const saved = Q.serializeShuffleOrder();
  assert.ok(saved && saved.tail.length === 5);

  // The restart: the queue arrives from the server as fresh objects and the
  // in-page order is gone.
  store.playerQueue = JSON.parse(JSON.stringify(store.playerQueue));
  Q.resetShuffleOrder();
  Q.restoreShuffleOrder(saved);

  assert.deepEqual(Q.playOrder(), dealt);
});

test('a restart does not replay what was already played', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(5);
  store.playerIndex = 2;
  Q.restoreShuffleOrder({ played: [0, 4], tail: [1, 3] });
  const saved = Q.serializeShuffleOrder();

  store.playerQueue = JSON.parse(JSON.stringify(store.playerQueue));
  Q.resetShuffleOrder();
  Q.restoreShuffleOrder(saved);

  assert.deepEqual(Q.playOrder(), [0, 4, 2, 1, 3]);
  assert.equal(Q.shuffleNext(), 1, 'the tail resumes instead of being dealt again');
});

test('a saved order that no longer fits the queue is dropped, not trusted', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(4);
  store.playerIndex = 0;
  Q.restoreShuffleOrder({ played: [0, 0, 99, -1, 'x', null], tail: [3, 3, 1] });
  const out = Q.serializeShuffleOrder();
  assert.deepEqual(out.played, [0], 'repeats and out-of-range positions are gone');
  // What was readable keeps its place; track 2, which the saved order never
  // mentioned, is dealt in rather than left without one.
  assert.deepEqual(out.tail, [3, 1, 2]);
});

test('dragging a row with shuffle on moves the running order, not the queue', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(6);
  store.playerIndex = 0;
  Q.restoreShuffleOrder({ played: [], tail: [1, 2, 3, 4, 5] });
  const untouched = store.playerQueue.slice();

  Q.moveInPlayOrder(1, 3);

  assert.deepEqual(store.playerQueue, untouched, 'the queue — and the playlist mirrored from it — stays as it was');
  assert.deepEqual(Q.playOrder(), [0, 2, 3, 1, 4, 5]);
});

test('dragging a row with shuffle off still moves the queue itself', () => {
  store.playerQueue = tracks(5);
  store.playerIndex = 0;
  Q.moveInPlayOrder(1, 3);
  assert.deepEqual(store.playerQueue.map(t => t.name), ['t0', 't2', 't3', 't1', 't4']);
});

// The server's cast follower played the next shuffled track while the page slept;
// the page adopts it. The order must then read as if the page had advanced itself:
// the old track in the history, the adopted one out of the tail, the rest unchanged.
test('adopting the track the cast server moved on to keeps the order', () => {
  store.shuffleEnabled = true;
  store.playerQueue = tracks(6);
  store.playerIndex = 0;
  const before = Q.serializeShuffleOrder();
  const next = before.tail[0];
  Q.adoptShuffleIndex(next);
  store.playerIndex = next;
  const after = Q.serializeShuffleOrder();
  assert.deepEqual(after.played, [0]);
  assert.deepEqual(after.tail, before.tail.slice(1));
  assert.equal(Q.shufflePrev(), 0, 'Previous goes back to the track that played before');
});
