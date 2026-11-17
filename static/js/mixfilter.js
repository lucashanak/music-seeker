// mixfilter.js — filtering and ordering mix search results in the browser.
//
// The server returns EVERY result with its bit rate; the page filters here so a
// change of filter is instant and the page can say how many results it hid.
// Pure: no DOM, no imports, so node can test it (tests/js/mix_filter.test.mjs).

export const MIX_SOURCES = ['soundcloud', 'youtube', 'mixcloud', 'hearthis'];

export const DEFAULT_MIX_FILTERS = Object.freeze({
  minKbps: 128,
  minMinutes: 20,
  sort: 'quality',
  sources: MIX_SOURCES,
});

/** 0 = ≥192, 1 = ≥160, 2 = ≥128, 3 = below. Same bands as the server. */
export function qualityBand(kbps) {
  const k = Number(kbps) || 0;
  if (k >= 192) return 0;
  if (k >= 160) return 1;
  if (k >= 128) return 2;
  return 3;
}

/** CSS modifier for a quality badge. */
export function qualityClass(kbps) {
  return ['mix-q--hi', 'mix-q--good', 'mix-q--ok', 'mix-q--low'][qualityBand(kbps)];
}

/** A stored filter object made safe: unknown values fall back to the defaults. */
export function normalizeFilters(raw) {
  const f = { ...DEFAULT_MIX_FILTERS };
  if (!raw || typeof raw !== 'object') return { ...f, sources: [...f.sources] };
  if ([0, 128, 160, 192].includes(Number(raw.minKbps))) f.minKbps = Number(raw.minKbps);
  if ([0, 20, 45].includes(Number(raw.minMinutes))) f.minMinutes = Number(raw.minMinutes);
  if (raw.sort === 'relevance' || raw.sort === 'quality') f.sort = raw.sort;
  const src = Array.isArray(raw.sources) ? MIX_SOURCES.filter((s) => raw.sources.includes(s)) : null;
  f.sources = src && src.length ? src : [...MIX_SOURCES];
  return f;
}

/**
 * The copy to show when some sites are switched off: the result itself when its
 * site is on (the server already put the best copy first), else the best copy
 * from a site that is on, with every other copy under `also`. null when no copy
 * is from a site that is on.
 */
export function bestEnabledCopy(it, sources) {
  const on = new Set(sources || MIX_SOURCES);
  if (on.has(it.source)) return it;
  const copies = (it.also || []).filter((c) => on.has(c.source));
  if (!copies.length) return null;
  const best = copies.reduce((a, b) =>
    ((Number(b.kbps) || 0) > (Number(a.kbps) || 0)
      || ((Number(b.kbps) || 0) === (Number(a.kbps) || 0) && b.quality_known && !a.quality_known)) ? b : a);
  const { also: _drop, relevance: _rel, ...primary } = it;
  const others = [primary, ...(it.also || []).filter((c) => c !== best)];
  return { ...best, relevance: it.relevance, also: others };
}

/**
 * { shown, hiddenQuality, hiddenLength, hiddenSource } for `items` under `f`.
 * A result failing both quality and length counts once, under quality.
 * Sort 'quality' = bands, relevance inside a band; 'relevance' = the server's
 * round-robin order across sites.
 */
export function applyMixFilters(items, f) {
  const shown = [];
  let hiddenQuality = 0, hiddenLength = 0, hiddenSource = 0;
  const minSec = (Number(f.minMinutes) || 0) * 60;
  for (const raw of items || []) {
    const it = bestEnabledCopy(raw, f.sources);
    if (!it) { hiddenSource++; continue; }
    if ((Number(it.kbps) || 0) < (Number(f.minKbps) || 0)) { hiddenQuality++; continue; }
    if ((Number(it.duration) || 0) < minSec) { hiddenLength++; continue; }
    shown.push(it);
  }
  const rel = (it) => (Number.isFinite(it.relevance) ? it.relevance : 0);
  if (f.sort === 'relevance') shown.sort((a, b) => rel(a) - rel(b));
  else shown.sort((a, b) => qualityBand(a.kbps) - qualityBand(b.kbps) || rel(a) - rel(b));
  return { shown, hiddenQuality, hiddenLength, hiddenSource };
}

/** "1 h 2 min" / "45 min" / "" */
export function fmtMixDuration(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
