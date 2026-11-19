// Sorting a playlist by energy is only a VIEW: energyview.js answers a permutation
// of indices and never touches the playlist. Unmeasured tracks go last, never as 0.5.
// Run by file path:
//   node --test tests/js/energy_view.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  energyOf, levelOf, energySortOrder, energySummary, tempoSummary, median,
} from '../../static/js/energyview.js';

const m = (energy, v = 3) => ({ energy, feature_version: v });

test('energySortOrder asc puts the calmest first', () => {
  const e = [m(0.9), m(0.1), m(0.5)];
  assert.deepEqual(energySortOrder(e, 'asc'), [1, 2, 0]);
});

test('energySortOrder desc puts the most energetic first', () => {
  const e = [m(0.9), m(0.1), m(0.5)];
  assert.deepEqual(energySortOrder(e, 'desc'), [0, 2, 1]);
});

test('energySortOrder does not mutate the entries', () => {
  const e = [m(0.9), m(0.1), m(0.5)];
  const snapshot = JSON.stringify(e);
  energySortOrder(e, 'asc');
  energySortOrder(e, 'desc');
  assert.equal(JSON.stringify(e), snapshot);
  assert.equal(e.length, 3);
});

test('energySortOrder returns the identity for any other direction', () => {
  const e = [m(0.9), m(0.1), m(0.5)];
  for (const dir of [null, undefined, 'none', '', 'ASC']) {
    assert.deepEqual(energySortOrder(e, dir), [0, 1, 2], String(dir));
  }
});

test('energySortOrder puts unmeasured tracks last in original order when ascending', () => {
  const e = [m(null), m(0.8), m(0.2), null, m(undefined)];
  assert.deepEqual(energySortOrder(e, 'asc'), [2, 1, 0, 3, 4]);
});

test('energySortOrder puts unmeasured tracks last in original order when descending', () => {
  const e = [m(null), m(0.8), m(0.2), null, m(undefined)];
  assert.deepEqual(energySortOrder(e, 'desc'), [1, 2, 0, 3, 4]);
});

test('energySortOrder does not place an unmeasured track in the middle as 0.5', () => {
  const e = [m(0.9), m(null), m(0.1)];
  assert.deepEqual(energySortOrder(e, 'asc'), [2, 0, 1]);
  assert.deepEqual(energySortOrder(e, 'desc'), [0, 2, 1]);
});

test('energySortOrder treats non-numeric energy as unmeasured', () => {
  const e = [m('loud'), m(0.3), m(NaN), m('')];
  assert.deepEqual(energySortOrder(e, 'asc'), [1, 0, 2, 3]);
});

test('energySortOrder treats an old feature_version as unmeasured', () => {
  const e = [m(0.1, 2), m(0.9), m(0.5, 1), { energy: 0.4 }];
  assert.deepEqual(energySortOrder(e, 'asc'), [1, 0, 2, 3]);
  assert.deepEqual(energySortOrder(e, 'desc'), [1, 0, 2, 3]);
});

test('energySortOrder counts an energy of 0 as measured', () => {
  const e = [m(null), m(0), m(0.4)];
  assert.deepEqual(energySortOrder(e, 'asc'), [1, 2, 0]);
  assert.deepEqual(energySortOrder(e, 'desc'), [2, 1, 0]);
});

test('energySortOrder keeps the original order for equal energies in both directions', () => {
  const e = [m(0.5), m(0.2), m(0.5), m(0.5), m(0.2)];
  assert.deepEqual(energySortOrder(e, 'asc'), [1, 4, 0, 2, 3]);
  assert.deepEqual(energySortOrder(e, 'desc'), [0, 2, 3, 1, 4]);
});

test('energySortOrder is a permutation of all indices', () => {
  const e = [m(0.3), null, m(0.3), m(0.9, 2), m(0)];
  for (const dir of ['asc', 'desc', null]) {
    assert.deepEqual([...energySortOrder(e, dir)].sort(), [0, 1, 2, 3, 4]);
  }
});

test('energySortOrder answers an empty order for a missing list', () => {
  assert.deepEqual(energySortOrder(null, 'asc'), []);
  assert.deepEqual(energySortOrder([], 'desc'), []);
});

test('levelOf maps 0 to 1, 0.2 to 2, 0.99 to 5 and 1.0 to 5', () => {
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(0.2), 2);
  assert.equal(levelOf(0.99), 5);
  assert.equal(levelOf(1.0), 5);
});

test('levelOf clamps values outside 0..1', () => {
  assert.equal(levelOf(1.7), 5);
  assert.equal(levelOf(-0.4), 1);
});

test('levelOf answers null for a missing energy', () => {
  assert.equal(levelOf(null), null);
  assert.equal(levelOf(undefined), null);
  assert.equal(levelOf(NaN), null);
});

test('energyOf answers null when the feature_version is below the minimum', () => {
  assert.equal(energyOf({ energy: 0.5, feature_version: 2 }), null);
  assert.equal(energyOf({ energy: 0.5, feature_version: 3 }), 0.5);
});

test('energySummary counts levels, measured and missing', () => {
  const s = energySummary([m(0), m(0.2), m(1.0), m(0.5), m(null), null, m(0.9, 2)]);
  assert.equal(s.total, 7);
  assert.equal(s.measured, 4);
  assert.equal(s.missing, 3);
  assert.deepEqual(s.levels, [1, 1, 1, 0, 1]);
});

test('energySummary median of an odd count is the middle value', () => {
  const s = energySummary([m(0.9), m(0.1), m(0.4)]);
  assert.equal(s.median, 0.4);
  assert.equal(s.medianLevel, 3);
});

test('energySummary median of an even count is the mean of the two middle values', () => {
  const s = energySummary([m(0.8), m(0.2), m(0.4), m(0.6)]);
  assert.ok(Math.abs(s.median - 0.5) < 1e-12);
  assert.equal(s.medianLevel, 3);
});

test('energySummary median of two values is their mean, not the upper one', () => {
  const s = energySummary([m(0.1), m(0.5)]);
  assert.ok(Math.abs(s.median - 0.3) < 1e-12);
});

test('energySummary of an empty list has a null median and level', () => {
  const s = energySummary([]);
  assert.deepEqual(s, { total: 0, measured: 0, missing: 0, levels: [0, 0, 0, 0, 0], median: null, medianLevel: null });
});

test('energySummary of only unmeasured tracks has a null median and level', () => {
  const s = energySummary([null, m(null), m(0.5, 2)]);
  assert.equal(s.total, 3);
  assert.equal(s.measured, 0);
  assert.equal(s.missing, 3);
  assert.equal(s.median, null);
  assert.equal(s.medianLevel, null);
});

test('energySummary puts an energy of 1.0 on level 5, not past it', () => {
  const s = energySummary([m(1.0)]);
  assert.deepEqual(s.levels, [0, 0, 0, 0, 1]);
});

test('tempoSummary reports min, max, median and counts', () => {
  const t = tempoSummary([100, 80, 120, 90]);
  assert.deepEqual(t, { total: 4, measured: 4, missing: 0, min: 80, max: 120, median: 95 });
});

test('tempoSummary counts null, 0, negative and NaN as missing', () => {
  const t = tempoSummary([null, 0, -5, NaN, undefined, 100, 60]);
  assert.equal(t.total, 7);
  assert.equal(t.measured, 2);
  assert.equal(t.missing, 5);
  assert.equal(t.min, 60);
  assert.equal(t.max, 100);
  assert.equal(t.median, 80);
});

test('tempoSummary of nothing measured has null min, max and median', () => {
  const t = tempoSummary([null, 0]);
  assert.deepEqual(t, { total: 2, measured: 0, missing: 2, min: null, max: null, median: null });
  assert.deepEqual(tempoSummary(undefined), { total: 0, measured: 0, missing: 0, min: null, max: null, median: null });
});

test('median ignores non-finite values', () => {
  assert.equal(median([NaN, 3, 1, Infinity]), 2);
  assert.equal(median([]), null);
});
