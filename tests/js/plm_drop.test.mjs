// The playlist manager's drop arithmetic (static/js/plmdrop.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropIndex } from '../../static/js/plmdrop.js';

// Apply a same-playlist drop the way the server does: remove, then insert.
function reorder(list, fromIdx, at) {
  const rest = list.filter((_, i) => i !== fromIdx);
  rest.splice(at == null ? rest.length : at, 0, list[fromIdx]);
  return rest;
}
const L = ['a', 'b', 'c', 'd', 'e'];
const same = (fromIdx, beforeIdx) => dropIndex({ same: true, fromIdx, beforeIdx, fromLen: L.length, toLen: L.length });

test('dropping a row before another row puts it right there', () => {
  assert.deepEqual(reorder(L, 0, same(0, 3)), ['b', 'c', 'a', 'd', 'e']);  // before d
  assert.deepEqual(reorder(L, 4, same(4, 1)), ['a', 'e', 'b', 'c', 'd']);  // before b
  assert.deepEqual(reorder(L, 3, same(3, 0)), ['d', 'a', 'b', 'c', 'e']);  // to the top
});

test('dropping after the last row moves it to the end', () => {
  assert.equal(same(1, null), null);
  assert.equal(same(1, 5), null);
  assert.deepEqual(reorder(L, 1, same(1, null)), ['a', 'c', 'd', 'e', 'b']);
});

test('dropping a row onto itself does nothing', () => {
  for (let i = 0; i < L.length; i++) {
    assert.equal(same(i, i), undefined, `before itself ${i}`);
    assert.equal(same(i, i + 1), undefined, `after itself ${i}`);
  }
  assert.equal(same(4, null), undefined);
});

test('with a filter on, "after row R" means directly after R, not before the next visible row', () => {
  // Visible rows 1 and 4 of a-e; drop row 1 ("b") onto row 1's lower half → index 2.
  // The bug placed it before row 4 (beforeIdx 4), past the hidden c and d.
  assert.equal(same(1, 1 + 1), undefined);
  // Drop "e" after visible row 1 ("b"): beforeIdx = 2 → e goes between b and c.
  assert.deepEqual(reorder(L, 4, same(4, 2)), ['a', 'b', 'e', 'c', 'd']);
});

test('into another playlist: the drop position, or the end', () => {
  const other = (beforeIdx) => dropIndex({ same: false, fromIdx: 2, beforeIdx, fromLen: 5, toLen: 3 });
  assert.equal(other(0), 0);
  assert.equal(other(2), 2);
  assert.equal(other(3), null);
  assert.equal(other(null), null);
  // An empty target.
  assert.equal(dropIndex({ same: false, fromIdx: 0, beforeIdx: null, fromLen: 1, toLen: 0 }), null);
});
