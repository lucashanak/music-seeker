// energyview.js — sorting a playlist by energy and summing up its energy and tempo.
//
// Pure functions, no DOM and no imports, so node tests can load the module as is.
// The caller looks each track's BPM cache entry up (bpm.js getDjData) and its
// shown tempo (bpm.js displayBpm) and passes them in, aligned with the tracks.
//
// Sorting is a VIEW. Nothing here changes the playlist order: the functions answer
// a permutation (indices into the caller's array) and leave the array alone.

// Same as bpm.js ENERGY_MIN_VERSION: a version-1/2 energy measured loudness and is
// not comparable with the current one, so it counts as unmeasured.
export const ENERGY_MIN_VERSION = 3;

/** The energy of a cache entry as a number in 0..1, or null when it is not measured. */
export function energyOf(entry, minVersion = ENERGY_MIN_VERSION) {
  if (!entry || !(entry.feature_version >= minVersion)) return null;
  if (entry.energy == null || entry.energy === '') return null;
  const e = Number(entry.energy);
  return Number.isFinite(e) ? e : null;
}

/** 1..5, the same five steps as the meter on a row (bpm.js energyLevel). */
export function levelOf(energy) {
  if (energy == null || !Number.isFinite(energy)) return null;
  return Math.max(1, Math.min(5, Math.floor(energy * 5) + 1));
}

/**
 * The order to show the tracks in, as indices into `entries`.
 * dir: 'asc' (calmest first) or 'desc' (most energetic first); anything else
 * returns the playlist order. Tracks without a measured energy go to the end in
 * their playlist order whichever the direction — never in the middle as 0.5.
 * Equal energies keep their playlist order.
 */
export function energySortOrder(entries, dir, minVersion = ENERGY_MIN_VERSION) {
  const n = Array.isArray(entries) ? entries.length : 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (dir !== 'asc' && dir !== 'desc') return idx;
  const known = [], unknown = [];
  for (const i of idx) {
    const e = energyOf(entries[i], minVersion);
    if (e == null) unknown.push(i); else known.push({ i, e });
  }
  const sign = dir === 'asc' ? 1 : -1;
  known.sort((a, b) => (a.e - b.e) * sign || a.i - b.i);
  return known.map(k => k.i).concat(unknown);
}

/** Median of a list of finite numbers, or null for an empty list. */
export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Energy of a whole playlist: how many tracks sit on each of the five levels,
 * the median energy (0..1) and its level, and how many have none.
 */
export function energySummary(entries, minVersion = ENERGY_MIN_VERSION) {
  const list = Array.isArray(entries) ? entries : [];
  const levels = [0, 0, 0, 0, 0];
  const values = [];
  for (const entry of list) {
    const e = energyOf(entry, minVersion);
    if (e == null) continue;
    values.push(e);
    levels[levelOf(e) - 1]++;
  }
  const med = median(values);
  return {
    total: list.length,
    measured: values.length,
    missing: list.length - values.length,
    levels,
    median: med,
    medianLevel: levelOf(med),
  };
}

/**
 * Tempo of a whole playlist from the tempo each row SHOWS (displayBpm — the felt
 * tempo where there is one). Null, zero or non-numbers count as missing.
 */
export function tempoSummary(bpms) {
  const list = Array.isArray(bpms) ? bpms : [];
  const values = [];
  for (const b of list) {
    const x = b == null ? NaN : Number(b);
    if (Number.isFinite(x) && x > 0) values.push(x);
  }
  return {
    total: list.length,
    measured: values.length,
    missing: list.length - values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    median: median(values),
  };
}
