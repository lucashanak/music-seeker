// deskmath.js — pure computations for the DJ desk (djdesk.js). No DOM, no engine.
// Unit-tested in tests/js/desk_math.test.mjs (run by file path).
//
// Times are TRACK seconds (the element's currentTime) unless a name says "wall":
// a deck playing at rate r covers r track seconds per wall second.

const fin = (n) => typeof n === 'number' && Number.isFinite(n);

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ───────────────────────── time formatting ─────────────────────────

/** "m:ss" (or "m:ss.t" with tenths). Anything that is not a finite number ≥ 0 reads 0:00. */
export function formatTime(sec, { tenths = false } = {}) {
  let s = fin(sec) && sec > 0 ? sec : 0;
  if (tenths) {
    const t = Math.floor(s * 10 + 1e-6);   // truncate, never round up to the next second
    const m = Math.floor(t / 600);
    const r = t - m * 600;
    return `${m}:${String(Math.floor(r / 10)).padStart(2, '0')}.${r % 10}`;
  }
  s = Math.floor(s + 1e-6);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Wall-clock time left on a deck, as "-m:ss". Unknown length → "-0:00". */
export function formatRemaining(pos, dur, rate = 1) {
  if (!fin(dur) || dur <= 0) return '-0:00';
  const r = fin(rate) && rate > 0 ? rate : 1;
  return '-' + formatTime(Math.max(0, dur - (fin(pos) ? pos : 0)) / r);
}

// ───────────────────────── pitch ─────────────────────────

/** playbackRate → percent, e.g. 1.025 → 2.5. */
export function rateToPct(rate) {
  if (!fin(rate) || rate <= 0) return 0;
  return Math.round((rate - 1) * 1000) / 10;
}

export function pctToRate(pct) {
  return 1 + (fin(pct) ? pct : 0) / 100;
}

/** "+2.5%", "-0.8%", "0.0%". */
export function formatPitch(rate) {
  const p = rateToPct(rate);
  if (p === 0) return '0.0%';
  return (p > 0 ? '+' : '') + p.toFixed(1) + '%';
}

// ───────────────────────── beat grid ─────────────────────────

/** Seconds per beat: the median spacing of the grid, else 60/bpm, else null. */
export function beatPeriod(grid, bpm) {
  if (Array.isArray(grid) && grid.length >= 2) {
    const d = [];
    for (let i = 1; i < grid.length; i++) {
      const x = grid[i] - grid[i - 1];
      if (fin(x) && x > 0) d.push(x);
    }
    if (d.length) {
      d.sort((a, b) => a - b);
      return d[Math.floor(d.length / 2)];
    }
  }
  return fin(bpm) && bpm > 0 ? 60 / bpm : null;
}

/** The beats either side of t: {prev, next, period}. Extrapolates past both ends of
 *  the grid with its period, so a position before the first analysed beat still has
 *  a phase. Without a grid it counts from 0 with 60/bpm. null when nothing is known. */
export function beatAround(grid, t, bpm) {
  const period = beatPeriod(grid, bpm);
  if (!period || !fin(t)) return null;
  const g = Array.isArray(grid) && grid.length ? grid : [0];
  const first = g[0], last = g[g.length - 1];
  let prev;
  if (t < first) {
    prev = first - Math.ceil((first - t) / period - 1e-9) * period;
  } else if (t >= last) {
    prev = last + Math.floor((t - last) / period + 1e-9) * period;
  } else {
    let lo = 0, hi = g.length - 1;           // largest index with g[i] <= t
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (g[mid] <= t) lo = mid; else hi = mid - 1;
    }
    prev = g[lo];
    const nxt = g[lo + 1];
    return { prev, next: nxt, period };
  }
  return { prev, next: prev + period, period };
}

/** `times` (a regular grid with spacing `period`) carried on to cover [from, to]:
 *  steps of `period` are added before its first and after its last entry. The analysis
 *  often starts its grid mid-track (a downbeat window in the middle of the song), and a
 *  grid that stops there would leave the intro without beats, bars or phrases. */
export function extendGrid(times, period, from, to) {
  if (!Array.isArray(times) || !times.length || !(period > 0) || !fin(from) || !fin(to)) return [];
  const first = times[0], last = times[times.length - 1];
  const out = [];
  const nBefore = Math.max(0, Math.floor((first - from) / period + 1e-9));
  for (let k = nBefore; k >= 1; k--) out.push(Math.round((first - k * period) * 1e4) / 1e4);
  for (const t of times) if (fin(t)) out.push(t);
  const nAfter = Math.max(0, Math.floor((to - last) / period + 1e-9));
  for (let k = 1; k <= nAfter; k++) out.push(Math.round((last + k * period) * 1e4) / 1e4);
  return out;
}

/** Beat times over [from, to]: the analysed grid extended both ways; without a grid,
 *  60/bpm from 0. Empty when no tempo is known. */
export function beatTimes(grid, bpm, from, to) {
  const period = beatPeriod(grid, bpm);
  if (!period) return [];
  return extendGrid(Array.isArray(grid) && grid.length ? grid : [0], period, from, to);
}

/** Bar start times over [from, to]: the analysed downbeats when there are at least two,
 *  else every `beatsPerBar`-th beat of the grid, else bars of 60/bpm × beatsPerBar from 0
 *  — each extended both ways with its own period. */
export function barTimes(downbeats, grid, bpm, from, to, beatsPerBar = 4) {
  if (Array.isArray(downbeats) && downbeats.length >= 2) {
    const db = downbeats.filter(fin);
    return extendGrid(db, beatPeriod(db, null), from, to);
  }
  const period = beatPeriod(grid, bpm);
  if (!period) return [];
  let base = [0];
  if (Array.isArray(grid) && grid.length) {
    base = [];
    for (let i = 0; i < grid.length; i += beatsPerBar) base.push(grid[i]);
  }
  return extendGrid(base, period * beatsPerBar, from, to);
}

/**
 * When to press "mix" so the incoming track starts on the next phrase of the live one.
 * A phrase is `barsPerPhrase` bars counted from the first bar of the track (the bar grid
 * carried back to 0); the trigger is `leadBeats` beats before the boundary. Returns
 * {boundary, at, bars} in track seconds (bars = whole bars from `pos` to the boundary),
 * or null when no grid or tempo is known. A trigger closer than `minLead` seconds (track
 * time) is skipped for the phrase after.
 */
export function nextPhrase(pos, { downbeats, beatGrid, bpm } = {}, { barsPerPhrase = 8, leadBeats = 1, minLead = 0.25, beatsPerBar = 4 } = {}) {
  if (!fin(pos)) return null;
  const period = beatPeriod(beatGrid, bpm);
  if (!period) return null;
  const roughBar = period * beatsPerBar;
  const bars = barTimes(downbeats, beatGrid, bpm, 0, Math.max(0, pos) + roughBar * barsPerPhrase * 3, beatsPerBar);
  if (!bars.length) return null;
  const barLen = beatPeriod(bars, null) || roughBar;
  const lead = leadBeats * period;
  for (let i = 0; i < bars.length; i += barsPerPhrase) {
    const b = bars[i];
    if (b - lead >= pos + minLead) return { boundary: b, at: b - lead, bars: Math.round((b - pos) / barLen) };
  }
  return null;
}

// ───────────────────────── sync ─────────────────────────

/** Distance between two tempos allowing for double/half time, in BPM. */
export function foldedBpmDistance(a, b) {
  if (!fin(a) || !fin(b) || a <= 0 || b <= 0) return Infinity;
  return Math.min(Math.abs(a - b), Math.abs(a - 2 * b), Math.abs(a - b / 2));
}

/**
 * Rate for the slave deck so its tempo meets the master's: master BPM × master rate
 * over slave BPM, folded by ×2 / ÷2 to whichever lands nearest to 1.
 * Returns {rate, factor} (factor = how the slave's beat maps: 1, 2 or 0.5), or null.
 */
export function syncRate(masterBpm, masterRate, slaveBpm) {
  const mr = fin(masterRate) && masterRate > 0 ? masterRate : 1;
  if (!fin(masterBpm) || !fin(slaveBpm) || masterBpm <= 0 || slaveBpm <= 0) return null;
  const target = masterBpm * mr;
  let best = null;
  for (const factor of [1, 2, 0.5]) {
    const rate = (target * factor) / slaveBpm;
    if (!best || Math.abs(rate - 1) < Math.abs(best.rate - 1)) best = { rate, factor };
  }
  return best;
}

/**
 * How far to move the slave deck (track seconds, + = forward) so its beats land on
 * the master's. Works on wall time: the next beat of each deck arrives in
 * (nextBeat - pos) / rate seconds; the shift is that difference, folded into the
 * shorter of the two wall beat periods and wrapped to ±half of it, so the jump is
 * never more than half a beat. null when either deck has no tempo.
 */
export function phaseShift(master, slave) {
  const m = beatAround(master && master.grid, master && master.pos, master && master.bpm);
  const s = beatAround(slave && slave.grid, slave && slave.pos, slave && slave.bpm);
  if (!m || !s) return null;
  const mRate = fin(master.rate) && master.rate > 0 ? master.rate : 1;
  const sRate = fin(slave.rate) && slave.rate > 0 ? slave.rate : 1;
  const mIn = (m.next - master.pos) / mRate;
  const sIn = (s.next - slave.pos) / sRate;
  const unit = Math.min(m.period / mRate, s.period / sRate);
  if (!(unit > 0)) return null;
  let d = (sIn - mIn) % unit;
  if (d > unit / 2) d -= unit;
  if (d <= -unit / 2) d += unit;
  return d * sRate;
}

// ───────────────────────── crossfader ─────────────────────────

/** Equal-power gains for a mix position t (0 = only outgoing, 1 = only incoming). */
export function faderGains(t) {
  const x = clamp(fin(t) ? t : 0, 0, 1);
  return { out: Math.cos(x * Math.PI / 2), in: Math.sin(x * Math.PI / 2) };
}

/** Physical fader position (0 = deck A, 1 = deck B) of a deck's side. */
export function sideOf(key) {
  return key === 'B' ? 1 : 0;
}

/** Mix amount t for a fader position x when mixing away from deck `fromKey`. */
export function mixAmount(x, fromKey) {
  const v = clamp(fin(x) ? x : 0, 0, 1);
  return fromKey === 'B' ? 1 - v : v;
}

// ───────────────────────── harmony ─────────────────────────

/** "8A" → {n: 8, l: 'A'} or null. */
export function parseCamelot(code) {
  const m = /^(\d{1,2})([AB])$/i.exec(String(code || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 12) return null;
  return { n, l: m[2].toUpperCase() };
}

/** How two keys relate on the Camelot wheel:
 *  'same' | 'relative' (same number, other letter) | 'adjacent' (±1, same letter)
 *  | 'energy' (±2, same letter) | 'clash' — or null when either key is unknown. */
export function camelotRelation(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return null;
  if (x.n === y.n) return x.l === y.l ? 'same' : 'relative';
  if (x.l !== y.l) return 'clash';
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (d === 1) return 'adjacent';
  if (d === 2) return 'energy';
  return 'clash';
}

/** Mixes harmonically without a cut: same key, relative, or a step round the wheel. */
export function camelotCompatible(a, b) {
  const r = camelotRelation(a, b);
  return r === 'same' || r === 'relative' || r === 'adjacent';
}

// ───────────────────────── suggestions ─────────────────────────

const KEY_COST = { same: 0, relative: 1, adjacent: 1.5, energy: 4, clash: 8 };

/**
 * Rank queue candidates against the live track. Lower score = better match.
 * live: {bpm, camelot, energy}; candidates: [{idx, data}] where data may be null.
 * Score (BPM-equivalent units): folded BPM distance + key cost + 10 × energy gap.
 * A candidate without data, or without a BPM, sorts after every scored one, in
 * the order given. Returns a new array [{idx, score, bpmDist, relation}].
 */
export function rankSuggestions(live, candidates, { limit = 8 } = {}) {
  const scored = [], unscored = [];
  for (const c of candidates || []) {
    const d = c && c.data;
    if (!d || !fin(d.bpm) || !live || !fin(live.bpm)) { unscored.push({ idx: c && c.idx, score: Infinity, bpmDist: null, relation: null }); continue; }
    const bpmDist = foldedBpmDistance(live.bpm, d.bpm);
    const relation = camelotRelation(live.camelot, d.camelot);
    const keyCost = relation == null ? 3 : KEY_COST[relation];
    const eGap = fin(live.energy) && fin(d.energy) ? Math.abs(live.energy - d.energy) : 0.2;
    scored.push({ idx: c.idx, score: bpmDist + keyCost + 10 * eGap, bpmDist, relation });
  }
  scored.sort((p, q) => p.score - q.score);
  return scored.concat(unscored).slice(0, Math.max(0, limit));
}
