// The Mixes page filters search results in the browser: the server returns every
// result with its bit rate, the default filter (≥ 128 kbps, ≥ 20 min) hides the
// rest and the page says how many it hid. Run by file path:
//   node --test tests/js/mix_filter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMixFilters, normalizeFilters, qualityBand, qualityClass, fmtMixDuration, DEFAULT_MIX_FILTERS,
  bestEnabledCopy,
} from '../../static/js/mixfilter.js';

const it = (title, source, kbps, minutes, relevance) => ({ title, source, kbps, duration: minutes * 60, relevance });

const RESULTS = [
  it('mc-sq', 'mixcloud', 64, 60, 0),
  it('sc', 'soundcloud', 160, 50, 1),
  it('yt', 'youtube', 128, 90, 2),
  it('ht-short', 'hearthis', 192, 10, 3),
  it('mc-hq', 'mixcloud', 192, 60, 4),
  it('mc-sq-short', 'mixcloud', 64, 5, 5),
];

test('the default filter hides low quality and short sets, and counts them', () => {
  const r = applyMixFilters(RESULTS, DEFAULT_MIX_FILTERS);
  assert.deepEqual(r.shown.map((x) => x.title), ['mc-hq', 'sc', 'yt']);
  assert.equal(r.hiddenQuality, 2);   // mc-sq and mc-sq-short (both reasons → quality)
  assert.equal(r.hiddenLength, 1);    // ht-short
  assert.equal(r.hiddenSource, 0);
});

test('turning the filters off shows everything', () => {
  const r = applyMixFilters(RESULTS, { ...DEFAULT_MIX_FILTERS, minKbps: 0, minMinutes: 0 });
  assert.equal(r.shown.length, RESULTS.length);
  assert.equal(r.hiddenQuality + r.hiddenLength, 0);
});

test('quality order keeps relevance inside a band; relevance order is the server order', () => {
  const all = { ...DEFAULT_MIX_FILTERS, minKbps: 0, minMinutes: 0 };
  assert.deepEqual(applyMixFilters(RESULTS, all).shown.map((x) => x.title),
    ['ht-short', 'mc-hq', 'sc', 'yt', 'mc-sq', 'mc-sq-short']);
  assert.deepEqual(applyMixFilters(RESULTS, { ...all, sort: 'relevance' }).shown.map((x) => x.title),
    ['mc-sq', 'sc', 'yt', 'ht-short', 'mc-hq', 'mc-sq-short']);
});

test('a switched-off source is hidden and counted apart', () => {
  const r = applyMixFilters(RESULTS, { ...DEFAULT_MIX_FILTERS, minKbps: 0, minMinutes: 0, sources: ['soundcloud'] });
  assert.deepEqual(r.shown.map((x) => x.title), ['sc']);
  assert.equal(r.hiddenSource, 5);
});

test('a stored filter is cleaned up, never trusted', () => {
  assert.deepEqual(normalizeFilters(null), { ...DEFAULT_MIX_FILTERS, sources: [...DEFAULT_MIX_FILTERS.sources] });
  const f = normalizeFilters({ minKbps: 999, minMinutes: '45', sort: 'evil', sources: ['youtube', 'x'] });
  assert.equal(f.minKbps, 128);
  assert.equal(f.minMinutes, 45);
  assert.equal(f.sort, 'quality');
  assert.deepEqual(f.sources, ['youtube']);
  assert.deepEqual(normalizeFilters({ sources: [] }).sources, DEFAULT_MIX_FILTERS.sources);
});

test('bands and labels', () => {
  assert.deepEqual([320, 192, 191, 160, 128, 127, 0, undefined].map(qualityBand), [0, 0, 1, 1, 2, 3, 3, 3]);
  assert.equal(qualityClass(64), 'mix-q--low');
  assert.equal(qualityClass(192), 'mix-q--hi');
  assert.equal(fmtMixDuration(3721), '1 h 2 min');
  assert.equal(fmtMixDuration(2700), '45 min');
  assert.equal(fmtMixDuration(0), '');
});

test('a set whose best copy is on a switched-off site shows its best copy from a site that is on', () => {
  const set = {
    ...it('Zouk set', 'soundcloud', 160, 60, 0), url: 'sc', uploader: 'DJ',
    also: [
      { ...it('Zouk set', 'mixcloud', 64, 60), url: 'mc' },
      { ...it('Zouk set', 'hearthis', 128, 60), url: 'ht', quality_known: false },
      { ...it('Zouk set', 'youtube', 128, 60), url: 'yt', quality_known: true },
    ],
  };
  const f = { ...DEFAULT_MIX_FILTERS, sources: ['mixcloud', 'hearthis', 'youtube'] };
  const r = applyMixFilters([set], f);
  assert.equal(r.shown.length, 1);
  assert.equal(r.hiddenSource, 0);
  const shown = r.shown[0];
  assert.equal(shown.url, 'yt');                       // 128 measured beats 128 typical, beats 64
  assert.equal(shown.relevance, 0);
  assert.deepEqual(shown.also.map((c) => c.url).sort(), ['ht', 'mc', 'sc']);
  // Only Mixcloud on: its AAC 64 copy is shown — and the quality filter then hides it.
  const mcOnly = applyMixFilters([set], { ...f, sources: ['mixcloud'] });
  assert.equal(mcOnly.shown.length, 0);
  assert.equal(mcOnly.hiddenQuality, 1);
  // No copy on any site that is on: hidden as a source.
  assert.equal(bestEnabledCopy(set, ['audiomack']), null);
  // Its own site on: itself, untouched.
  assert.equal(bestEnabledCopy(set, ['soundcloud']), set);
});
