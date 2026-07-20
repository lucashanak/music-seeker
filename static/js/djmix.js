/**
 * djmix.js — DJ mixing module for beat-matched crossfade transitions.
 *
 * Used exclusively by player_v2.js. Provides:
 *   - BPM/key data fetching and caching
 *   - Camelot wheel harmonic compatibility analysis
 *   - Equal-power crossfade curves
 *   - Beat grid utilities (snap, phase alignment)
 *   - Full DJ transition scheduler with three styles:
 *       blend (harmonic match), bass_swap (nearby key), cut (clashing keys)
 */

// Single source of truth for BPM/DJ data: bpm.js cache
// No separate _djCache — getDjData reads from bpm._cache, fetchTrackBpm populates it
import { getDjData, fetchTrackBpm } from './bpm.js';

/** Re-export fetchTrackBpm as fetchDjData for player_v2.js compatibility */
export { fetchTrackBpm as fetchDjData };

/**
 * WebKit (macOS Safari / WKWebView / Tauri) detection.
 * WebKit snaps multi-segment AudioParam ramps to the end value and re-buffers
 * <audio> on frequent playbackRate writes, so the rich DJ transition breaks there.
 * WKWebView/Safari report a Safari-like UA without "Chrome"; Android WebView/Chrome
 * include "Chrome"/"Android" and are excluded (they keep the rich path).
 */
export const IS_WEBKIT = typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Android/.test(navigator.userAgent);

/* ------------------------------------------------------------------ */
/*  Camelot Wheel                                                      */
/* ------------------------------------------------------------------ */

/**
 * Full mapping from musical key notation to Camelot wheel codes.
 * Covers all 12 minor (A) and 12 major (B) positions.
 */
const KEY_TO_CAMELOT = {
  // Minor keys (column A)
  'Ab minor': '1A',  'G# minor': '1A',
  'Eb minor': '2A',  'D# minor': '2A',
  'Bb minor': '3A',  'A# minor': '3A',
  'F minor':  '4A',
  'C minor':  '5A',
  'G minor':  '6A',
  'D minor':  '7A',
  'A minor':  '8A',
  'E minor':  '9A',
  'B minor':  '10A',
  'F# minor': '11A', 'Gb minor': '11A',
  'Db minor': '12A', 'C# minor': '12A',

  // Major keys (column B)
  'B major':  '1B',  'Cb major': '1B',
  'F# major': '2B',  'Gb major': '2B',
  'Db major': '3B',  'C# major': '3B',
  'Ab major': '4B',  'G# major': '4B',
  'Eb major': '5B',  'D# major': '5B',
  'Bb major': '6B',  'A# major': '6B',
  'F major':  '7B',
  'C major':  '8B',
  'G major':  '9B',
  'D major':  '10B',
  'A major':  '11B',
  'E major':  '12B',
};

/**
 * Parse a Camelot code (e.g. "8A") into { number, letter }.
 * Returns null for invalid codes.
 * @param {string} code
 * @returns {{ number: number, letter: string } | null}
 */
function parseCamelot(code) {
  if (!code || typeof code !== 'string') return null;
  const m = code.match(/^(\d{1,2})([AB])$/i);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  return { number: num, letter: m[2].toUpperCase() };
}

/**
 * Determine transition style based on harmonic compatibility on the Camelot wheel.
 *
 * Rules:
 *   - Same position or relative major/minor (same number, different letter) → 'blend'
 *   - ±1 step on the wheel (same letter)                                   → 'bass_swap'
 *   - ±2 steps on the wheel (same letter)                                  → 'bass_swap'
 *   - Anything further apart                                               → 'cut'
 *
 * @param {string} outCamelot - Camelot code of outgoing track (e.g. "8A")
 * @param {string} inCamelot  - Camelot code of incoming track
 * @returns {'blend'|'bass_swap'|'cut'}
 */
/**
 * WebKit simple-crossfade duration (seconds). Beat-based at rate=1, clamped to an
 * audible range. Shared so player_v3's auto-crossfade trigger lead time matches the
 * actual WebKit fade length (otherwise the fade starts ~11s early but lasts ≤10s).
 * @param {number} outBpm - outgoing track BPM (defaults to 85 if falsy)
 * @param {number} [numBeats=16] - beats to fade over
 * @returns {number}
 */
export function webkitCrossfadeDuration(outBpm, numBeats = 16) {
  return Math.max(3, Math.min(10, numBeats * (60 / (outBpm || 85))));
}

export function getTransitionStyle(outCamelot, inCamelot) {
  const a = parseCamelot(outCamelot);
  const b = parseCamelot(inCamelot);
  if (!a || !b) return 'blend'; // unknown → safe default

  // Same key
  if (a.number === b.number && a.letter === b.letter) return 'blend';

  // Relative major/minor (same number, opposite letter)
  if (a.number === b.number && a.letter !== b.letter) return 'blend';

  // Distance on the wheel (circular, 1-12)
  if (a.letter === b.letter) {
    const diff = Math.abs(a.number - b.number);
    const dist = Math.min(diff, 12 - diff);
    if (dist <= 2) return 'bass_swap';
  }

  return 'cut';
}

/* ------------------------------------------------------------------ */
/*  Equal-power crossfade curves                                       */
/* ------------------------------------------------------------------ */

/**
 * Generate equal-power (cos/sin) fade curves suitable for
 * AudioParam.setValueCurveAtTime().
 *
 * @param {number} length - Number of samples in the curve (default 256)
 * @returns {{ fadeIn: Float32Array, fadeOut: Float32Array }}
 */
export function makeEqualPowerCurves(length = 256) {
  const fadeIn = new Float32Array(length);
  const fadeOut = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const p = i / (length - 1);
    fadeIn[i] = Math.sin(p * Math.PI / 2);
    fadeOut[i] = Math.cos(p * Math.PI / 2);
  }
  return { fadeIn, fadeOut };
}

/* ------------------------------------------------------------------ */
/*  Beat grid utilities                                                */
/* ------------------------------------------------------------------ */

/**
 * Find the beat time nearest to targetTime via binary search.
 * @param {number[]} beatGrid   - Sorted array of beat times (seconds)
 * @param {number}   targetTime - Time to snap to
 * @returns {number} Nearest beat time, or targetTime if grid is empty
 */
export function findNearestBeat(beatGrid, targetTime) {
  if (!beatGrid || beatGrid.length === 0) return targetTime;

  let lo = 0;
  let hi = beatGrid.length - 1;

  // Edge cases
  if (targetTime <= beatGrid[lo]) return beatGrid[lo];
  if (targetTime >= beatGrid[hi]) return beatGrid[hi];

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beatGrid[mid] <= targetTime) lo = mid;
    else hi = mid;
  }

  // Return whichever of the two neighbours is closer
  return (targetTime - beatGrid[lo] <= beatGrid[hi] - targetTime)
    ? beatGrid[lo]
    : beatGrid[hi];
}

/**
 * Find the Nth beat BEFORE a given time.
 * Useful for starting a crossfade N beats before the track ends.
 *
 * @param {number[]} beatGrid   - Sorted array of beat times (seconds)
 * @param {number}   beforeTime - Reference point (e.g. track duration)
 * @param {number}   numBeats   - How many beats before (default 16 = 4 bars in 4/4)
 * @returns {number} Beat time at which to start the crossfade
 */
export function findCrossfadeStartBeat(beatGrid, beforeTime, numBeats = 16) {
  if (!beatGrid || beatGrid.length === 0) return 0;

  const beatsBeforeEnd = beatGrid.filter(b => b < beforeTime);
  const idx = beatsBeforeEnd.length - numBeats;
  return idx >= 0 ? beatsBeforeEnd[idx] : beatsBeforeEnd[0] || 0;
}

/**
 * Find the bar/phrase-aligned downbeat ~numBars bars before a reference point.
 * Same shape as findCrossfadeStartBeat but operates over absolute downbeat
 * (bar-start) times so the crossfade STARTS on a bar/phrase boundary.
 *
 * @param {number[]} downbeats  - Sorted array of bar-start times (seconds)
 * @param {number}   beforeTime - Reference point (e.g. effective end of track)
 * @param {number}   numBars    - How many bars before (default 4 = one phrase in 4/4)
 * @returns {number|null} Downbeat time at which to start the crossfade, or null
 *                        when no downbeat data is available (caller falls back).
 */
export function findCrossfadeStartDownbeat(downbeats, beforeTime, numBars = 4) {
  if (!downbeats || downbeats.length === 0) return null;

  const barsBeforeEnd = downbeats.filter(b => b < beforeTime);
  const idx = barsBeforeEnd.length - numBars;
  return idx >= 0 ? barsBeforeEnd[idx] : barsBeforeEnd[0] || 0;
}

/**
 * Binary-search a periodic beat grid for the last beat AT OR BEFORE `t`.
 * Unlike findNearestBeat (nearest neighbour, may be after `t`), this always
 * returns a beat <= t, extrapolating one period earlier when `t` precedes the
 * grid's first entry (grids are periodic, so that's a safe assumption).
 *
 * @param {number[]} beatGrid - Sorted array of beat times (seconds, FILE time)
 * @param {number}   t        - Reference time (seconds, FILE time)
 * @param {number}   period   - Beat period (seconds) to extrapolate with when
 *                              `t` falls outside the grid's covered range.
 * @returns {number} Beat time <= t
 */
function _lastBeatAtOrBefore(beatGrid, t, period) {
  if (!beatGrid || beatGrid.length === 0) return t - (t % period);
  if (t < beatGrid[0]) return beatGrid[0] - period;

  let lo = 0;
  let hi = beatGrid.length - 1;
  if (t >= beatGrid[hi]) return beatGrid[hi];

  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beatGrid[mid] <= t) lo = mid;
    else hi = mid;
  }
  return beatGrid[lo];
}

/**
 * Calculate the start offset for the incoming track so its first beat
 * aligns with the outgoing track's beat grid during crossfade.
 *
 * @param {number[]} outBeatGrid       - Outgoing track beat grid
 * @param {number[]} inBeatGrid        - Incoming track beat grid
 * @param {number}   crossfadeStartTime - When crossfade starts in the outgoing track
 * @returns {number} currentTime to set on the incoming deck
 */
export function calculatePhaseOffset(outBeatGrid, inBeatGrid, crossfadeStartTime) {
  if (!outBeatGrid || !inBeatGrid || !inBeatGrid.length) return 0;

  // Find the next beat in the outgoing track at or after crossfade start
  const nextOutBeat = outBeatGrid.find(b => b >= crossfadeStartTime);
  if (nextOutBeat == null) return 0;

  // Time from crossfade start until that beat hits
  const timeUntilBeat = nextOutBeat - crossfadeStartTime;

  // Incoming track should reach its first beat at that exact moment
  const firstInBeat = inBeatGrid[0] || 0;
  const offset = firstInBeat - timeUntilBeat;

  return Math.max(0, offset);
}

/* ------------------------------------------------------------------ */
/*  Main DJ transition scheduler                                       */
/* ------------------------------------------------------------------ */

/**
 * Schedule a DJ-quality transition between two decks.
 * This is the main entry point called by player_v2.js.
 *
 * Three transition styles are supported:
 *   - blend:     smooth equal-power crossfade (harmonically compatible keys)
 *   - bass_swap: EQ-assisted transition — kill outgoing bass at midpoint,
 *                bring incoming bass in gradually (nearby keys on Camelot wheel)
 *   - cut:       quick 2-beat hard swap (clashing keys, avoid harmonic mess)
 *
 * @param {AudioContext} ctx
 * @param {object} outDeck - { element, gain, lowFilter, midFilter, highFilter }
 * @param {object} inDeck  - { element, gain, lowFilter, midFilter, highFilter }
 * @param {object|null} outData - DJ data for outgoing track { bpm, beat_grid, key, camelot }
 * @param {object|null} inData  - DJ data for incoming track { bpm, beat_grid, key, camelot }
 * @param {number} numBeats - Crossfade length in beats (default 16 = 4 bars)
 * @returns {{ crossfadeStartTime: number, duration: number, tempoRatio: number, style: string }}
 */
export function scheduleDjTransition(ctx, outDeck, inDeck, outData, inData, opts = {}) {
  const numBeats = opts.numBeats || 16;
  const tempoRange = (opts.tempoRange ?? 8) / 100;
  const forceStyle = opts.transitionStyle || 'auto';
  const introSkip = opts.introSkip || '0';
  const seekable = opts.seekable !== false; // default true

  const now = ctx.currentTime;
  const outBpm = outData?.bpm || 85;
  const inBpm = inData?.bpm || outBpm;
  const outCurrentTime = outDeck.element.currentTime;

  /* ---- 1. Dual tempo match ---- */
  // Both decks shift toward mid BPM — each changes by half the difference.
  // This doubles effective range (±8% each = ±16% total) while staying inaudible.
  const midBpm = (outBpm + inBpm) / 2;
  let outRate = 1.0, inRate = 1.0;
  if (tempoRange > 0 && outBpm !== inBpm) {
    outRate = Math.max(1 - tempoRange, Math.min(1 + tempoRange, midBpm / outBpm));
    inRate = Math.max(1 - tempoRange, Math.min(1 + tempoRange, midBpm / inBpm));
  }
  outDeck.element.preservesPitch = true;
  inDeck.element.preservesPitch = true;
  inDeck.element.playbackRate = inRate;
  // Outgoing ramps gradually via requestAnimationFrame
  if (outRate !== 1.0 && outDeck.element.playbackRate !== outRate) {
    const curRate = outDeck.element.playbackRate;
    const rampStart = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - rampStart) / 2000);
      outDeck.element.playbackRate = curRate + (outRate - curRate) * t;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    outDeck.element.playbackRate = outRate;
  }

  /* ---- 2. Crossfade duration ---- */
  const matchedBpm = outBpm * outRate;
  const beatPeriod = 60 / matchedBpm;
  const fallbackSec = opts.fallbackSec || 5;
  const duration = outData?.bpm ? numBeats * beatPeriod : fallbackSec;

  /* ---- 3. Beat-aligned scheduling ---- */
  // The crossfade starts NOW — no delay to next beat.
  // Instead, we align the INCOMING track's beat to the outgoing track's beat grid.
  const startCtxTime = now;

  /* ---- 4. Incoming track start position (phase-locked to outgoing beats) ---- */
  let inStartTime = 0;
  // Intro skip: determine earliest valid start position
  if (introSkip === 'auto' && inData?.intro_end != null) {
    inStartTime = inData.intro_end;
  } else if (introSkip !== '0' && introSkip !== 'auto') {
    inStartTime = parseInt(introSkip) || 0;
  }
  // Phase alignment: find the incoming track position where its beat
  // will coincide with the outgoing track's CURRENT beat position.
  if (outData?.bpm && inData?.beat_grid && inData.beat_grid.length > 0) {
    const outBeatPeriod = 60 / (outBpm * outRate);
    const inBeatPeriod = 60 / (inBpm * inRate);
    // Find where we are in the outgoing beat cycle (0..1)
    const outPhase = (outCurrentTime % outBeatPeriod) / outBeatPeriod;
    // Find a start position in the incoming track where the beat phase matches.
    // Bar/phrase-align on the first incoming DOWNBEAT when available; else fall
    // back to intro_end / first beat (unchanged behavior).
    //
    // NOTE: backend anchors downbeats[0] to the MID analysis window (~0.47-0.5x
    // duration), so it is NOT the first downbeat of the track. The downbeat grid
    // is periodic at the bar period, so reduce downbeats[0] to its phase-equivalent
    // downbeat near the START of the track: keeps the SAME beat/bar phase (beat-match
    // intact) but starts near 0 instead of mid-track.
    const haveDownbeats = inData.downbeats && inData.downbeats.length > 0;
    const inBpmValid = Number.isFinite(inBpm) && inBpm > 0;
    let firstInBeat;
    if (haveDownbeats && inBpmValid) {
      const beatsPerBar = inData.time_signature || 4;
      const barPeriod = inBeatPeriod * beatsPerBar;
      // First-bar downbeat with the same phase as the grid, in [0, barPeriod).
      const firstBarStart = inData.downbeats[0] - Math.floor(inData.downbeats[0] / barPeriod) * barPeriod;
      firstInBeat = firstBarStart;
      // Start from firstInBeat, then offset by the phase difference
      const phaseOffset = outPhase * inBeatPeriod;
      inStartTime = Math.max(inStartTime, firstInBeat - phaseOffset);
      if (inStartTime < 0) inStartTime += inBeatPeriod; // wrap around
      inStartTime = Math.max(inStartTime, 0);
      // SAFETY CLAMP: never seek past the first two bars (inStartTime < barPeriod
      // already after the mod reduction, so this only guards against edge cases).
      inStartTime = Math.min(inStartTime, barPeriod * 2);
    } else {
      // Downbeats missing or BPM invalid: preserve any intro-skip already set,
      // but never allow a garbage negative seek.
      inStartTime = Math.max(inStartTime, 0);
    }
  }
  // Seek incoming deck — only if source is seekable (cached blob)
  if (inStartTime > 0 && seekable) {
    if (inDeck.element.readyState >= 1) {
      try { inDeck.element.currentTime = inStartTime; } catch {}
    } else {
      inDeck.element.addEventListener('loadedmetadata', () => {
        try { inDeck.element.currentTime = inStartTime; } catch {}
      }, { once: true });
    }
  }

  /* ---- 5. Determine transition style ---- */
  let style;
  if (forceStyle !== 'auto') {
    style = forceStyle;
  } else {
    style = (outData?.camelot && inData?.camelot)
      ? getTransitionStyle(outData.camelot, inData.camelot)
      : 'blend';
  }

  /* ---- 6. Schedule gain automation on beat boundary ---- */
  // Keep incoming deck silent until the beat-aligned start
  inDeck.gain.gain.cancelScheduledValues(now);
  inDeck.gain.gain.setValueAtTime(0, now); // silent from now
  outDeck.gain.gain.cancelScheduledValues(now);
  outDeck.gain.gain.setValueAtTime(outDeck.gain.gain.value, now); // hold current

  const curves = makeEqualPowerCurves(256);

  if (style === 'blend' || !outDeck.lowFilter) {
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, duration);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, duration);

  } else if (style === 'bass_swap') {
    const midTime = startCtxTime + duration * 0.4;
    inDeck.lowFilter.gain.setValueAtTime(-30, startCtxTime);
    inDeck.lowFilter.gain.linearRampToValueAtTime(0, midTime);
    outDeck.lowFilter.gain.setValueAtTime(0, startCtxTime);
    outDeck.lowFilter.gain.linearRampToValueAtTime(-30, midTime);
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, duration);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, duration);

  } else {
    // 'cut': shorter crossfade for clashing keys, but still audible (min 4s)
    const cutDur = Math.max(4, Math.min(8 * beatPeriod, duration));
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, cutDur);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, cutDur);
  }

  return { crossfadeStartTime: startCtxTime, duration, outRate, inRate, style };
}

/* ------------------------------------------------------------------ */
/*  Post-transition cleanup                                            */
/* ------------------------------------------------------------------ */

/**
 * Reset tempo and EQ filters after a crossfade completes.
 * Call this once the old deck is stopped and the new deck is the sole output.
 *
 * @param {object} deck - { element, gain, lowFilter, midFilter, highFilter }
 */
/**
 * Pick the best next track index from the queue based on BPM/key similarity.
 * Only considers tracks that have cached DJ data.
 *
 * @param {object[]} queue - Player queue array
 * @param {number} currentIndex - Current track index
 * @param {object} currentDjData - DJ data for current track { bpm, camelot }
 * @param {string} mode - 'bpm' or 'bpm_key'
 * @returns {number|null} - Best index, or null if no analyzed candidates
 */
// Track which tracks have already been played by Smart Queue.
// Keyed by track IDENTITY (id, or artist:name) — NOT array index — so the played
// set stays correct when the queue is reordered or edited mid-set.
const _playedKeys = new Set();

// ── Per-set selection state ──
// All WRITTEN only in markPlayed()/resetSmartQueuePlayed() (real advances / set start),
// and READ (never mutated) in pickSmartNext(). This keeps pickSmartNext side-effect-free
// and keeps every value stable between a prediction call and its matching commit call.
let _setStartBpm = null;      // BPM of the first track marked in the current smart set
let _setStartEnergy = null;   // energy (0..1) of the first track marked in the current smart set (energy-arc anchor)
let _playedCount = 0;         // number of real advances in the current set (tempo-arc clock)
let _setSalt = 0;             // per-set jitter salt: constant within a set, varies across sets
const _recentArtists = [];    // ring buffer of last N distinct artists (recency diversity)

/**
 * Stable identity key for a queue item.
 * Prefers a track id; falls back to a lowercased artist:name pair
 * (mirrors the name+artist keying bpm.js uses for its DJ-data cache).
 * @param {object} item - Queue item { id?, name?, artist? }
 * @returns {string}
 */
function _trackKey(item) {
  return item.id != null
    ? String(item.id)
    : ((item.artist || '') + ':' + (item.name || '')).toLowerCase();
}

/**
 * Decode HTML entities the same way bpm.js's internal _dec does (textarea-based,
 * short-circuiting when there's no '&'). bpm.js does NOT export its decoder, so this
 * mirror keeps getDjData lookups in pickSmartNext aligned with how bpm.js's _key
 * normalizes cache keys (decode → lowercase → trim). Falls back to the raw string
 * when no DOM is available (e.g. non-browser test).
 */
function _djDecode(s) {
  if (!s || !s.includes('&')) return s;
  if (typeof document === 'undefined') return s;
  const e = document.createElement('textarea');
  e.innerHTML = s;
  return e.value;
}

/** Stable non-negative hash of a string (djb2) — used for deterministic per-track jitter. */
function _keyHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Read a DJ setting the same way player_v3's _djSetting does (localStorage, `ms_dj_`
 * prefix), returning `def` when unset or when no DOM/localStorage is available (tests).
 * Numeric callers parse the result themselves.
 */
function _djSetting(key, def) {
  try {
    if (typeof localStorage === 'undefined') return def;
    const v = localStorage.getItem('ms_dj_' + key);
    return v == null ? def : v;
  } catch { return def; }
}

/** Normalized artist for the recency ring (lowercased/trimmed, entity-decoded). */
function _artistKey(item) {
  return _djDecode((item && item.artist) || '').toLowerCase().trim();
}

/** Reset played + per-set selection state (call when queue changes or playback restarts) */
export function resetSmartQueuePlayed() {
  _playedKeys.clear();
  _setStartBpm = null;
  _setStartEnergy = null;
  _playedCount = 0;
  // Vary the jitter salt per set so each set explores a different deterministic ordering,
  // while staying CONSTANT within a set (predict==commit). resetSmartQueuePlayed runs once
  // per set, so capturing a varying value here is safe.
  _setSalt = (_setSalt | 0) + 1;
  _recentArtists.length = 0;
}

/**
 * Mark a queue item as played (pass the item, not an index). Called once per REAL advance
 * with the OUTGOING track — this is where all per-set selection state is written.
 */
export function markPlayed(item) {
  if (!item) return;
  _playedKeys.add(_trackKey(item));

  // Capture the set's starting BPM + energy from the first marked track's DJ data (anchors
  // the tempo + energy arcs). One shared cache lookup. Falls back silently when uncached.
  if (_setStartBpm == null || _setStartEnergy == null) {
    const d = getDjData(_djDecode(item.name), _djDecode(item.artist));
    if (d) {
      if (_setStartBpm == null && d.bpm) _setStartBpm = d.bpm;
      if (_setStartEnergy == null && Number.isFinite(d.energy)) _setStartEnergy = d.energy;
    }
  }
  _playedCount++;

  // Maintain a ring of the last N DISTINCT artists for recency diversity.
  const a = _artistKey(item);
  if (a) {
    const existing = _recentArtists.indexOf(a);
    if (existing !== -1) _recentArtists.splice(existing, 1);
    _recentArtists.push(a);
    const win = Math.max(0, parseInt(_djSetting('dj_artist_window', '3'), 10) || 0);
    while (_recentArtists.length > win) _recentArtists.shift();
  }
}

// NOTE: side-effect-free — does NOT mutate _playedKeys, so it is safe to call for
// prediction (prefetch) and again at commit without desyncing played-state. The caller
// marks the outgoing track via markPlayed() only on a real advance.
export function pickSmartNext(queue, currentIndex, currentDjData, mode = 'bpm', repeatAll = false) {
  if (!currentDjData || !currentDjData.bpm) return null;

  // ---- Scoring tunables (BPM-equivalent units) ----
  // Confidence-weighted unified scoring: every eligible unplayed track is a first-class
  // candidate. BPM distance is weighted by the track's confidence, so tempo only "leads"
  // for confident tracks; for the low-confidence majority (a zouk library where ~64% of
  // tracks carry conf 0.3) energy + harmony — the reliable axes — decide the pick.
  const TRUST_FLOOR = 0.5;   // at/above this confidence, a track is "trusted" (BPM reliable)
  const BAND = parseFloat(_djSetting('dj_tempo_band', '8')) || 8; // preferred tempo window
  const JITTER = 1.5;       // small deterministic tie-break (BPM-equiv) so the set has variety

  // NaN-safe numeric setting parse (mirrors the dj_key_weight / dj_tempo_* guards below).
  const num = (raw, def) => { const v = parseFloat(raw); return Number.isFinite(v) ? v : def; };
  // Floor added to conf when weighting BPM distance, so even low-conf BPM keeps a tiny
  // minimum weight. Default 0 = pure confidence weighting (low-conf BPM barely counts).
  const BPM_CONF_FLOOR = Math.max(0, Math.min(1, num(_djSetting('dj_bpm_conf_floor', '0'), 0)));
  // Tempo-CONTINUITY penalty (BPM-equiv per BPM beyond the band), applied to ALL candidates
  // REGARDLESS of confidence. This is the hard "no slow↔fast jump" guard a dance floor needs:
  // for a dancer, tempo continuity outranks energy/harmony, so even a low-confidence track
  // whose (octave-folded) BPM is far from the current tempo gets heavily penalized — energy/key
  // then choose only AMONG tempo-compatible tracks. (BPM-less tracks get bpmDist=BAND → 0 penalty.)
  const OOB_PENALTY = num(_djSetting('dj_tempo_oob_penalty', '3'), 3);
  // In-band bonus (BPM-equiv) for TRUSTED in-band candidates only: confident tempo matches
  // are still preferred among the confident, WITHOUT hard-filtering to in-band (that starved
  // the untrusted majority). Untrusted tracks ignore the band entirely.
  const INBAND_BONUS = num(_djSetting('dj_inband_bonus', '2'), 2);

  // Tunable enhancement weights (default ON with musical values).
  const RAMP_PER_TRACK = parseFloat(_djSetting('dj_tempo_ramp', '1')); // BPM/track; 0 = flat
  const MAX_RAMP_UP    = parseFloat(_djSetting('dj_tempo_peak', '12')); // max BPM above start
  const _kw = parseFloat(_djSetting('dj_key_weight', '6'));
  const KEY_WEIGHT     = Number.isFinite(_kw) ? _kw : 6;  // blend bonus (bpm_key); NaN-safe
  const _ad = parseFloat(_djSetting('dj_artist_diversity', '6'));
  const ARTIST_DIVERSITY = Number.isFinite(_ad) ? _ad : 6; // 0 disables; NaN→default

  const E_RAMP   = num(_djSetting('dj_energy_ramp','0.0375'), 0.0375); // energy/track during warm-up (peak/peak_at → apex at E_PEAKAT)
  const E_PEAK   = num(_djSetting('dj_energy_peak','0.30'), 0.30);    // max above start
  const E_PEAKAT = parseInt(_djSetting('dj_energy_peak_at','8'),10) || 8; // track # of apex
  const E_COOL   = num(_djSetting('dj_energy_cooldown','0.02'), 0.02);// decline/track after peak
  // BPM-equiv weight of energy distance. Raised from 6→10: energy dist is 0..1, so ×10 makes
  // it comparable to a ~10-BPM tempo gap, letting energy meaningfully drive the low-conf
  // majority whose BPM barely counts under confidence weighting.
  const E_WEIGHT = num(_djSetting('dj_energy_weight','10'), 10);      // BPM-equiv weight of energy distance

  const curBpm = currentDjData.bpm;
  const curCamelot = currentDjData.camelot;

  // E. Per-set jitter salt. _setSalt is fixed for the whole set (set in resetSmartQueuePlayed),
  // so jitter is identical across predict/commit WITHIN a set, but each new set reshuffles
  // the tie-break ordering. XOR-mixing a well-distributed hash of the salt (rather than string-
  // concatenating it) makes the salt actually move which near-tied track wins, even for short
  // keys. _saltHash is a pure function of _setSalt → deterministic.
  const _saltHash = _keyHash('s:' + (_setSalt | 0));
  const _jitterFor = (key) => (Math.abs(_keyHash(key) ^ _saltHash) % 1000) / 1000 * JITTER;

  // ---- A. Tempo energy arc (warm-up → plateau) ----
  // target = setStart + min(playedCount * ramp, peak). Builds over the first ~N tracks,
  // then holds near the peak (NOT a runaway monotonic speed-up). Both _setStartBpm and
  // _playedCount are written ONLY in markPlayed (real advance), so they are identical
  // between a prediction call and its matching commit call → predict==commit holds.
  const ramp = Number.isFinite(RAMP_PER_TRACK) ? RAMP_PER_TRACK : 1;
  const peak = Number.isFinite(MAX_RAMP_UP) ? MAX_RAMP_UP : 12;
  // ramp=0 → flat arc anchored at the set's start BPM (NOT curBpm — that would re-anchor
  // to every track and lose the "stay near where we started" intent).
  const target = (_setStartBpm != null)
    ? _setStartBpm + Math.min(_playedCount * ramp, peak)
    : curBpm;

  // ---- A2. Energy arc (warm-up → peak → cooldown) ----
  // Mirrors the tempo arc: read-only, driven by _setStartEnergy + _playedCount (both written
  // ONLY in markPlayed). Ramps up to E_PEAK above the set's start energy by track E_PEAKAT,
  // then declines by E_COOL/track. Absent start energy → neutral 0.5 anchor. Clamped to 0..1.
  const startE = (_setStartEnergy != null) ? _setStartEnergy : 0.5;
  let targetEnergy = (_playedCount <= E_PEAKAT)
    ? startE + Math.min(_playedCount * E_RAMP, E_PEAK)
    : startE + Math.max(0, E_PEAK - (_playedCount - E_PEAKAT) * E_COOL);
  targetEnergy = Math.max(0, Math.min(1, targetEnergy));

  // Distinct number of track keys in the queue (duplicates collapse).
  const distinctKeys = new Set(queue.map(_trackKey));
  const allPlayed = _playedKeys.size >= distinctKeys.size;

  /**
   * Harmonic key bonus (subtracted from score) for bpm_key mode. blend = full weight,
   * bass_swap = half. Returns 0 outside bpm_key or when camelot data is missing.
   */
  const keyBonus = (data) => {
    if (mode === 'bpm_key' && curCamelot && data.camelot) {
      // Scale harmonic pull by the WEAKER of the two key confidences: an uncertain key on
      // either side earns less pull. Absent confidence → 1.0 (full pull) so behavior is
      // unchanged before the lazy backfill fills key_confidence; a KNOWN-low confidence then
      // reduces the pull. Pure function of cached data.* (determinism preserved).
      const kc = Number.isFinite(data.key_confidence) ? data.key_confidence : 1.0;
      const curKc = Number.isFinite(currentDjData.key_confidence) ? currentDjData.key_confidence : 1.0;
      const trust = Math.min(kc, curKc);
      const style = getTransitionStyle(curCamelot, data.camelot);
      if (style === 'blend')     return KEY_WEIGHT * trust;
      if (style === 'bass_swap') return (KEY_WEIGHT / 2) * trust;
    }
    return 0;
  };

  // C. Recent-artist diversity: soft penalty for candidates whose artist is in the ring.
  // _recentArtists is only mutated in markPlayed, so it's stable across predict/commit.
  const artistPenalty = (item) => {
    if (!ARTIST_DIVERSITY) return 0;
    const a = _artistKey(item);
    return (a && _recentArtists.indexOf(a) !== -1) ? ARTIST_DIVERSITY : 0;
  };

  // ---- Live Tempo preference: restrict candidates to a BPM band ----
  // `ms_dj_tempo_pref`: auto (no constraint) | slow (<90) | mid (90–110) | fast (>110).
  // Bands match bpm.js presets exactly (Slow <90, Mid 90-110, Fast 110+). The filter is a
  // PURE, DETERMINISTIC function of the band + each candidate's cached bpm — no state writes,
  // no randomness — so predict==commit is preserved. We test against getDjData().bpm, the
  // SAME value the scoring below uses for tempo distance (Math.abs(data.bpm - target)), so the
  // control is consistent with the engine's own tempo logic. Tracks with no bpm (or no DJ data)
  // are EXCLUDED when a band is active (can't confirm they match). If the band leaves ZERO
  // eligible candidates, we silently fall back to the unconstrained set (never stall playback).
  const tempoPref = _djSetting('tempo_pref', 'auto');
  const _bandOk = (bpm) => {
    if (!Number.isFinite(bpm)) return false;
    if (tempoPref === 'slow') return bpm < 90;
    if (tempoPref === 'mid')  return bpm >= 90 && bpm <= 110;
    if (tempoPref === 'fast') return bpm > 110;
    return true; // 'auto' or unknown value → no constraint
  };
  // When a band is active, decide once (deterministically) whether ANY unplayed candidate is
  // in-band; if none, the band is disabled for this call so we don't dead-end.
  let _bandActive = tempoPref === 'slow' || tempoPref === 'mid' || tempoPref === 'fast';
  if (_bandActive) {
    let anyInBand = false;
    for (let i = 0; i < queue.length; i++) {
      if (i === currentIndex) continue;
      const item = queue[i];
      const key = _trackKey(item);
      if (_playedKeys.has(key) && !(repeatAll && allPlayed)) continue;
      const d = getDjData(_djDecode(item.name), _djDecode(item.artist));
      if (d && _bandOk(d.bpm)) { anyInBand = true; break; }
    }
    if (!anyInBand) _bandActive = false; // empty band → graceful unconstrained fallback (silent)
  }

  // ---- Unified, confidence-weighted scoring over ALL eligible unplayed candidates ----
  // Single pass: no trusted-pool / fallback split. Every unplayed, non-current track competes
  // on the SAME score. BPM distance is weighted by confidence so it leads only for confident
  // tracks; energy + harmony carry the low-conf majority. `firstUnplayedIdx` is retained as a
  // last-resort target so we never dead-end while unplayed tracks remain (whole-queue coverage).
  let firstUnplayedIdx = null;
  let anyEligible = false;     // any eligible candidate at all (played-set / repeat-all aware)
  let bestIdx = null;
  let bestScore = Infinity;

  for (let i = 0; i < queue.length; i++) {
    if (i === currentIndex) continue;
    const item = queue[i];
    const key = _trackKey(item);
    // Skip already-played tracks, unless repeat=all and EVERYTHING has been played.
    if (_playedKeys.has(key) && !(repeatAll && allPlayed)) continue;
    anyEligible = true;
    if (firstUnplayedIdx == null) firstUnplayedIdx = i;

    // Decode entities before lookup so a title/artist with an HTML entity resolves
    // its DJ data (bpm.js keys the cache under entity-decoded values via _key).
    const data = getDjData(_djDecode(item.name), _djDecode(item.artist)) || {};

    // Live Tempo preference filter: when a band is active (and non-empty), only tracks whose
    // cached bpm is in the band compete for selection. Pure deterministic skip — no state
    // writes — so prediction==commit holds. BPM-less tracks fail _bandOk → excluded.
    if (_bandActive && !_bandOk(data.bpm)) continue;

    // conf drives BPM weighting: high-conf → BPM matters fully; low-conf → BPM barely counts.
    const conf = Number.isFinite(data.confidence) ? data.confidence : 0.3;
    // BPM distance: absent BPM → BAND (a neutral, in-band-edge gap) so missing BPM neither
    // attracts nor strongly repels — energy/key then decide. No NaN can enter.
    const bpmDist = Number.isFinite(data.bpm) ? Math.abs(data.bpm - target) : BAND;
    // KEY CHANGE: weight BPM distance by (confidence + floor, capped at 1). Low-conf BPM is
    // discounted (×~0.3) so tempo no longer dominates the 64% low-conf majority.
    const bpmTerm = bpmDist * Math.min(1, conf + BPM_CONF_FLOOR);
    // Tempo-continuity: hard-ish penalty for tempo OUTSIDE the band, applied to EVERY track
    // (not confidence-scaled) so the set never jumps slow↔fast — even low-conf tracks must
    // stay near the current (octave-folded) tempo. Zero inside the band, so energy/harmony
    // freely decide among tempo-compatible candidates.
    const tempoContinuity = Math.max(0, bpmDist - BAND) * OOB_PENALTY;

    const eDist = Number.isFinite(data.energy) ? Math.abs(data.energy - targetEnergy) * E_WEIGHT : 0;

    // In-band bonus applies ONLY to TRUSTED candidates with a real BPM: keep confident tempo
    // matches preferred among the confident, without hard-filtering (which starved the
    // untrusted majority). Untrusted / BPM-less tracks ignore the band.
    const inBandBonus = (conf >= TRUST_FLOOR && Number.isFinite(data.bpm) && bpmDist <= BAND)
      ? INBAND_BONUS : 0;

    // Deterministic per-track jitter (NOT Math.random): pickSmartNext runs once at
    // prediction time (to prefetch) and again at commit; a re-rolled random term would
    // let the two diverge → wrong track prefetched / stale _inDjData. A stable hash of
    // the track key (salted per-set so each set differs) gives variety while staying
    // identical across calls WITHIN a set (the salt is fixed for the set).
    const jitter = _jitterFor(key);

    // keyBonus + artistPenalty are pure functions of cached data.* / stable per-set state
    // (both NaN-safe: keyBonus returns 0 without camelot, artistPenalty returns 0/ARTIST_DIVERSITY).
    const score = bpmTerm
      + tempoContinuity
      + eDist
      - keyBonus(data)
      + artistPenalty(item)
      - inBandBonus
      + jitter;

    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }

  if (bestIdx != null) return bestIdx;

  // ---- No eligible candidate scored. ----
  // If repeat=all and everything has been played, clear history and retry (recursion-guarded).
  if (repeatAll && allPlayed && !anyEligible) {
    // Guard against infinite recursion when there is nothing to cycle to (e.g. queue
    // edited down to a single already-played track). Without this, clearing + re-adding
    // the current key leaves allPlayed true with zero candidates → unbounded recursion.
    if (distinctKeys.size <= 1) return null;
    _playedKeys.clear();
    const cur = queue[currentIndex];
    if (cur) _playedKeys.add(_trackKey(cur));
    return pickSmartNext(queue, currentIndex, currentDjData, mode, repeatAll);
  }

  // Whole-queue coverage: never dead-end while an unplayed track remains. bestIdx is only
  // null here if the (single) eligible candidate produced no finite score, which cannot
  // happen (score is always finite), but firstUnplayedIdx is a defensive last resort.
  return firstUnplayedIdx;
}

/**
 * Schedule a professional DJ transition with 3-band EQ, bass swap, and filter sweep.
 *
 * @param {AudioContext} ctx
 * @param {object} outDeck - { element, gain, lowFilter, midFilter, highFilter, sweepFilter }
 * @param {object} inDeck  - { element, gain, lowFilter, midFilter, highFilter, sweepFilter }
 * @param {object|null} outData - DJ data { bpm, beat_grid, key, camelot }
 * @param {object|null} inData  - DJ data
 * @param {object} opts - { numBeats, tempoRange, transitionStyle, introSkip, seekable, fallbackSec, bassSwapPoint, eqKillDepth, filterResonance }
 */
export function scheduleDjTransitionV3(ctx, outDeck, inDeck, outData, inData, opts = {}) {
  const numBeats = opts.numBeats || 16;
  const tempoRange = (opts.tempoRange ?? 8) / 100;
  const forceStyle = opts.transitionStyle || 'auto';
  const introSkip = opts.introSkip || '0';
  const seekable = opts.seekable !== false;
  // Fade cap (seconds until the outgoing track's effective end, computed by the
  // caller): the fade must not OVERRUN the outgoing file — the deck would die via
  // `ended` mid-fade at ~20% gain (audible clip). Floor 3s keeps a minimal blend;
  // 0/absent = uncapped (ended-blend path, or caller had no duration).
  const fadeCap = (Number.isFinite(opts.fadeCapSec) && opts.fadeCapSec > 0)
    ? Math.max(3, opts.fadeCapSec) : Infinity;

  const now = ctx.currentTime;
  // Raw BPMs, no made-up fallback — matching against a fabricated 85 BPM (the old
  // `|| 85` default) pointlessly rate-shifted tracks against a number nobody chose.
  // Downstream tempo-matching (step 1) treats a missing bpm as "don't match at all".
  const outBpmRaw = outData?.bpm;
  const inBpmRaw = inData?.bpm;
  const outCurrentTime = outDeck.element.currentTime;

  /* ---- WebKit-only simple crossfade path ----
   * WebKit snaps multi-segment AudioParam ramps and stutters on playbackRate
   * changes, so the rich transition below produces a hard cut + stutter. On
   * WebKit we run a minimal, reliable gain crossfade (no tempo stretch, no EQ
   * automation, no filter sweep, no PLL) and return early with the same shape. */
  if (IS_WEBKIT) {
    // No tempo stretch — force rate 1 on both decks (no rAF ramp, no PLL).
    outDeck.element.playbackRate = 1;
    inDeck.element.playbackRate = 1;
    outDeck.element.preservesPitch = true;
    inDeck.element.preservesPitch = true;

    // Beat-based duration at rate=1, else fallback; clamp to an audible range.
    // Uses the shared webkitCrossfadeDuration helper so player_v3's trigger lead
    // time matches this fade length exactly.
    const wkFallbackSec = opts.fallbackSec || 5;
    const wkDuration = Math.min(fadeCap, outData?.bpm
      ? webkitCrossfadeDuration(outBpmRaw, numBeats)
      : Math.max(3, Math.min(10, wkFallbackSec)));

    // Neutralize EQ + sweep on both decks so leftover kills don't color the sound.
    for (const d of [outDeck, inDeck]) {
      for (const f of [d.lowFilter, d.midFilter, d.highFilter]) {
        if (f) { f.gain.cancelScheduledValues(now); f.gain.value = 0; }
      }
      if (d.sweepFilter) {
        d.sweepFilter.frequency.cancelScheduledValues(now);
        d.sweepFilter.Q.cancelScheduledValues(now);
        d.sweepFilter.type = 'highpass';
        d.sweepFilter.frequency.value = 20;
        d.sweepFilter.Q.value = 0.7;
      }
    }

    // Single-ramp linear gain crossfade (2 events per param — WebKit-reliable).
    const t = now;
    inDeck.gain.gain.cancelScheduledValues(t);
    inDeck.gain.gain.setValueAtTime(0.0001, t);
    inDeck.gain.gain.linearRampToValueAtTime(1, t + wkDuration);
    outDeck.gain.gain.cancelScheduledValues(t);
    outDeck.gain.gain.setValueAtTime(Math.max(0.0001, outDeck.gain.gain.value), t);
    outDeck.gain.gain.linearRampToValueAtTime(0, t + wkDuration);

    return {
      crossfadeStartTime: t,
      duration: wkDuration,
      outRate: 1,
      inRate: 1,
      style: 'webkit-simple',
      _tempoRamp: { id: null, cancelled: true },
    };
  }

  /* ---- 1. Octave folding + bail-out tempo match ----
   * No tempo match at all when either bpm is missing (no fabricated default —
   * see the outBpmRaw/inBpmRaw comment above). Octave folding treats a 2:1 tempo
   * relationship as a legitimate beat match (e.g. house at 128 vs half-time hip-hop
   * at 64) — folded ONLY for matching purposes; inBpmRaw itself is never mutated,
   * so downstream duration/beat-grid math still uses the real bpm. If even the
   * folded ratio can't fit inside +/-tempoRange, the clamp would truncate and the
   * tempos would never actually meet — bail out entirely rather than half-match:
   * a partial shift is pure harm (beats mismatched for the whole blend, plus a
   * long post-fade rate-return drift with nothing gained). */
  let outRate = 1, inRate = 1, tempoMatched = false;
  let inBpmFolded = inBpmRaw;
  const outBpm = outBpmRaw; // convenience alias used throughout below (raw, no fallback)
  const inBpm = inBpmRaw;
  if (tempoRange > 0 && Number.isFinite(outBpm) && Number.isFinite(inBpm) && outBpm > 0 && inBpm > 0) {
    const ratio = inBpm / outBpm;
    if (ratio > 1.5) inBpmFolded = inBpm / 2;
    else if (ratio < 1 / 1.5) inBpmFolded = inBpm * 2;
    else inBpmFolded = inBpm;

    const midBpm = (outBpm + inBpmFolded) / 2;
    const outRatio = midBpm / outBpm;
    const inRatio = midBpm / inBpmFolded;
    const lo = 1 - tempoRange, hi = 1 + tempoRange;
    if (outRatio >= lo && outRatio <= hi && inRatio >= lo && inRatio <= hi) {
      outRate = outRatio;
      inRate = inRatio;
      tempoMatched = true;
    }
  }

  /* ---- 2. Duration (based on the outgoing track's own tempo, independent of
   *         whether a tempo match happened — the transition still needs a beat
   *         count to structure its EQ/filter automation around). ---- */
  // beatPeriod must stay FINITE even when the outgoing bpm is missing: it structures
  // the eq_swap/drop_cut automation times (swapTime/introDur), and a NaN there makes
  // AudioParam.setValueAtTime throw mid-transition (deck already swapped → stuck
  // player). Tempo MATCHING never uses this default (bail-out above); 85 is only the
  // automation-structure fallback the old code used.
  const matchedBpm = (Number.isFinite(outBpm) && outBpm > 0 ? outBpm : 85) * outRate;
  const beatPeriod = 60 / matchedBpm;
  const fallbackSec = opts.fallbackSec || 5;
  // fadeCap: never fade longer than the outgoing track has left (see top of function).
  const duration = Math.min(fadeCap, outData?.bpm ? numBeats * beatPeriod : fallbackSec);

  /* ---- 3. Locked dual-deck tempo glide ----
   * The OUTGOING deck is audible at fade start — snapping it straight to outRate
   * (the old behavior) is what produced the tempo jump at the START of the blend.
   * Instead it glides from its CURRENT rate. The incoming deck starts silent
   * (gain 0) tempo-matched to the outgoing's CURRENT tempo (r_in0), then both
   * glide linearly and simultaneously to their target rates over glideDur seconds.
   * Because both endpoints satisfy outBpm*rOut == inBpmFolded*rIn (by construction)
   * and both rates move linearly in t, the two tracks' shared tempo is locked at
   * every point in between — not just the two ends — which removes the jump at
   * BOTH the start (outgoing deck) and the end (once the outgoing deck's gain
   * reaches 0, its tempo already matches, so nothing audibly changes at the
   * handoff either).
   *
   * This replaces the old 2-second rAF ramp that only moved the OUTGOING deck:
   * that ramp was dead code whenever both BPMs were known, because the PLL
   * (registered afterward, see CrossfadeBeatSyncV3 below) wrote playbackRate every
   * frame too and always won (later registration = last writer each frame).
   *
   * The glide loop is the ONLY writer of playbackRate while it runs. player_v3
   * now delays starting the PLL until after the glide completes (glideDur), so
   * the two never fight over the same AudioElement.playbackRate.
   */
  outDeck.element.preservesPitch = true;
  inDeck.element.preservesPitch = true;

  const startOutRate = outDeck.element.playbackRate || 1;
  let inRate0 = inRate;
  if (tempoMatched) {
    // Tempo-matched to the outgoing's CURRENT (not yet ramped) tempo. The clamp is
    // DERIVED from tempoRange, not hardcoded: tempoMatched guarantees
    // outBpm/inBpmFolded = inRate/outRate ∈ [(1-r)/(1+r), (1+r)/(1-r)], so these
    // bounds (scaled by startOutRate) are a provable no-op for ANY tempoRange —
    // a pure safety net that cannot break the t=0 tempo-lock equality the glide
    // relies on. Absolute [0.7, 1.4] cap guards against garbage inputs only.
    const devLo = (1 - tempoRange) / (1 + tempoRange);
    const devHi = (1 + tempoRange) / (1 - tempoRange);
    inRate0 = Math.max(Math.max(0.7, startOutRate * devLo),
      Math.min(Math.min(1.4, startOutRate * devHi), (outBpm * startOutRate) / inBpmFolded));
  }
  inDeck.element.playbackRate = inRate0; // silent (gain 0) — no audible jump

  // Cancellable HANDLE (same shape player_v3 already expects): the tick
  // self-reschedules, so a raw rAF id goes stale after one frame and the caller
  // could never cancel the loop. `cancelled` lets a stale loop self-terminate on
  // rapid skip. `outBase`/`inBase` are the LIVE current rates (updated each
  // frame) so CrossfadeBeatSyncV3 can apply its corrections on top of a moving
  // target instead of fighting it; `done` flags glide completion.
  const _tempoRamp = { id: null, cancelled: false, outBase: startOutRate, inBase: inRate0, done: !tempoMatched };
  let glideDur = 0;
  if (tempoMatched) {
    glideDur = Math.max(1, Math.min(4, duration * 0.4));
    const rampStart = performance.now();
    const tick = () => {
      if (_tempoRamp.cancelled) return;
      const elapsed = (performance.now() - rampStart) / 1000;
      const t = Math.min(1, elapsed / glideDur);
      const curOut = startOutRate + (outRate - startOutRate) * t;
      const curIn = inRate0 + (inRate - inRate0) * t;
      outDeck.element.playbackRate = curOut;
      inDeck.element.playbackRate = curIn;
      _tempoRamp.outBase = curOut;
      _tempoRamp.inBase = curIn;
      if (t < 1) { _tempoRamp.id = requestAnimationFrame(tick); }
      else { _tempoRamp.id = null; _tempoRamp.done = true; }
    };
    _tempoRamp.id = requestAnimationFrame(tick);
  } else {
    // No tempo match (bail-out or missing bpm): force rate 1 on both decks —
    // nothing to glide, no PLL will be started (see player_v3).
    outDeck.element.playbackRate = 1;
    inDeck.element.playbackRate = 1;
    _tempoRamp.outBase = 1;
    _tempoRamp.inBase = 1;
  }

  /* ---- 4. Beat-aligned scheduling ---- */
  const startCtxTime = now;
  const endTime = startCtxTime + duration;

  /* ---- 5. Incoming track start position (phase-locked) ----
   * FILE-time periods throughout: currentTime and beat_grid entries are both
   * FILE time (not wall-clock), so periods must NOT be rate-scaled — that was
   * the dimensional bug (periods computed as 60/(bpm*rate), a wall-clock-scaled
   * quantity, then combined with raw file-time currentTime). */
  let inStartTime = 0;
  if (introSkip === 'auto' && inData?.intro_end != null) {
    inStartTime = inData.intro_end;
  } else if (introSkip !== '0' && introSkip !== 'auto') {
    inStartTime = parseInt(introSkip) || 0;
  }
  if (Number.isFinite(outBpm) && outBpm > 0 && inData?.beat_grid && inData.beat_grid.length > 0) {
    const P_out = 60 / outBpm;
    const inBpmFoldedValid = Number.isFinite(inBpmFolded) && inBpmFolded > 0;
    const P_in = inBpmFoldedValid ? 60 / inBpmFolded : P_out;

    // Outgoing beat phase from the ACTUAL grid (not an assumed beat-at-t=0):
    // last grid beat <= outCurrentTime, then the next beat is one period later.
    const outGrid = outData?.beat_grid;
    const lastOutBeat = (outGrid && outGrid.length > 0)
      ? _lastBeatAtOrBefore(outGrid, outCurrentTime, P_out)
      : outCurrentTime - (outCurrentTime % P_out); // no grid: fall back to beat-at-t=0
    const timeToNextOutBeatFile = (lastOutBeat + P_out) - outCurrentTime;
    // Convert to wall-clock via the outgoing deck's CURRENT rate at fade start
    // (the glide hasn't moved it yet — using the eventual target rate here would
    // be wrong for the very interval the seek is computed over).
    const timeToNextOutBeatWall = timeToNextOutBeatFile / startOutRate;
    // The incoming deck must reach ITS next beat in that same wall-clock
    // interval, traveling at its own (glide-start) rate r_in0.
    const timeToNextInBeatFile = timeToNextOutBeatWall * inRate0;

    // Bar/phrase-align the incoming deck: when downbeat data exists, anchor on the
    // first incoming DOWNBEAT so the new track's bar 1 lands on the outgoing bar.
    //
    // NOTE: backend anchors downbeats[0] to the MID analysis window (~0.47-0.5x
    // duration), so it is NOT the first downbeat of the track. The downbeat grid
    // is periodic at the bar period, so reduce downbeats[0] to its phase-equivalent
    // downbeat near the START of the track: keeps the SAME beat/bar phase (beat-match
    // intact) but starts near 0 instead of mid-track.
    const haveDownbeats = inData.downbeats && inData.downbeats.length > 0;
    if (haveDownbeats && inBpmFoldedValid) {
      const beatsPerBar = inData.time_signature || 4;
      // FILE bar period — no rate scaling (P_in is already file-time).
      const barPeriod = P_in * beatsPerBar;
      // First-bar downbeat with the same phase as the grid, in [0, barPeriod).
      const firstBarStart = inData.downbeats[0] - Math.floor(inData.downbeats[0] / barPeriod) * barPeriod;
      // Land the incoming deck's NEXT beat (timeToNextInBeatFile away, in its own
      // file time) on firstBarStart.
      inStartTime = Math.max(inStartTime, firstBarStart - timeToNextInBeatFile);
      if (inStartTime < 0) inStartTime += P_in;
      inStartTime = Math.max(inStartTime, 0);
      // SAFETY CLAMP: never seek past the first two bars (inStartTime < barPeriod
      // already after the mod reduction, so this only guards against edge cases).
      inStartTime = Math.min(inStartTime, barPeriod * 2);
    } else {
      // Downbeats missing or folded BPM invalid: preserve any intro-skip already
      // set, but never allow a garbage negative seek.
      inStartTime = Math.max(inStartTime, 0);
    }
  }
  if (inStartTime > 0 && seekable) {
    if (inDeck.element.readyState >= 1) {
      try { inDeck.element.currentTime = inStartTime; } catch {}
    } else {
      inDeck.element.addEventListener('loadedmetadata', () => {
        try { inDeck.element.currentTime = inStartTime; } catch {}
      }, { once: true });
    }
  }

  /* ---- 5. Style auto-selection ---- */
  let style = forceStyle;
  if (forceStyle === 'auto') {
    if (!outData?.camelot || !inData?.camelot) style = 'blend';
    else {
      // Compatible keys → full equal-power, beat-matched BLEND (both decks play full,
      // beats locked together). The old eq_swap/filter_sweep spectrally SUPPRESS each
      // deck (kill the incoming bass/mids until a mid-point swap), which sounds thin/
      // "both muted until the switch" rather than a real blend. Only clashing keys fall
      // back to a quick cut. Force a specific technique via ms_dj_transition_style
      // (auto | blend | eq_swap | filter_sweep | drop_cut).
      const compat = getTransitionStyle(outData.camelot, inData.camelot);
      style = (compat === 'cut') ? 'drop_cut' : 'blend';
    }
  }

  /* ---- 6. Schedule automation per style ---- */

  // Cancel ALL scheduled values on ALL filters for BOTH decks (fixes interrupted transitions)
  for (const d of [outDeck, inDeck]) {
    d.gain.gain.cancelScheduledValues(0);
    if (d.lowFilter) d.lowFilter.gain.cancelScheduledValues(0);
    if (d.midFilter) d.midFilter.gain.cancelScheduledValues(0);
    if (d.highFilter) d.highFilter.gain.cancelScheduledValues(0);
    if (d.sweepFilter) {
      d.sweepFilter.frequency.cancelScheduledValues(0);
      d.sweepFilter.Q.cancelScheduledValues(0);
    }
  }

  if (style === 'eq_swap') {
    const killDb = -(opts.eqKillDepth || 36);
    const swapFrac = opts.bassSwapPoint || 0.5;
    const swapBeats = Math.round(numBeats * swapFrac);
    // Clamp to the (possibly fadeCap-shortened) duration — an uncapped swapBeats
    // time could land PAST endTime, leaving the incoming bass/mids killed after
    // the blend completed and making the gain timeline non-monotonic.
    const swapTime = startCtxTime + Math.min(swapBeats * beatPeriod, duration * 0.6);

    // OUTGOING: hold current state, explicit initial values (#5 fix: use actual gain, not assumed 1.0)
    const outGainNow = outDeck.gain.gain.value;
    outDeck.gain.gain.setValueAtTime(outGainNow, startCtxTime);
    outDeck.lowFilter.gain.setValueAtTime(0, startCtxTime);
    outDeck.midFilter.gain.setValueAtTime(0, startCtxTime);
    outDeck.highFilter.gain.setValueAtTime(0, startCtxTime);

    // INCOMING: bass killed, but highs + mids partially open with gain rising early (#7 fix)
    inDeck.gain.gain.setValueAtTime(0.0001, startCtxTime);
    inDeck.lowFilter.gain.setValueAtTime(killDb, startCtxTime);
    inDeck.midFilter.gain.setValueAtTime(killDb * 0.5, startCtxTime);
    inDeck.highFilter.gain.setValueAtTime(-6, startCtxTime); // highs nearly open from start

    // Phase 1 (0 to 25%): incoming highs open fully, gain rises, becoming audible
    const phase1End = startCtxTime + duration * 0.25;
    inDeck.highFilter.gain.linearRampToValueAtTime(0, phase1End);
    inDeck.gain.gain.linearRampToValueAtTime(0.6, phase1End);

    // Phase 2 (25% to swap): incoming mids open, gain continues rising
    inDeck.midFilter.gain.linearRampToValueAtTime(0, swapTime);
    inDeck.gain.gain.linearRampToValueAtTime(0.9, swapTime);

    // Bass swap: snappy 15ms micro-ramp (eliminates click, still sounds instant)
    outDeck.lowFilter.gain.setValueAtTime(0, swapTime - 0.015);
    outDeck.lowFilter.gain.linearRampToValueAtTime(killDb, swapTime);
    inDeck.lowFilter.gain.setValueAtTime(killDb, swapTime - 0.015);
    inDeck.lowFilter.gain.linearRampToValueAtTime(0, swapTime);

    // Phase 3 (swap to end): outgoing fades out (EQ + volume)
    outDeck.midFilter.gain.linearRampToValueAtTime(killDb * 0.5, endTime);
    outDeck.highFilter.gain.linearRampToValueAtTime(killDb * 0.4, endTime);
    outDeck.gain.gain.linearRampToValueAtTime(0, endTime);

    // Incoming reaches full
    inDeck.gain.gain.linearRampToValueAtTime(1, endTime);

  } else if (style === 'filter_sweep') {
    const res = opts.filterResonance || 2.0;

    // Incoming: HPF opens up (reveals track from highs to lows)
    inDeck.sweepFilter.type = 'highpass';
    inDeck.sweepFilter.Q.setValueAtTime(res, startCtxTime);
    inDeck.sweepFilter.frequency.setValueAtTime(4000, startCtxTime);
    inDeck.sweepFilter.frequency.exponentialRampToValueAtTime(20, endTime);

    // Outgoing: LPF closes (removes from highs to lows)
    outDeck.sweepFilter.type = 'lowpass';
    outDeck.sweepFilter.Q.setValueAtTime(res, startCtxTime);
    outDeck.sweepFilter.frequency.setValueAtTime(20000, startCtxTime);
    outDeck.sweepFilter.frequency.exponentialRampToValueAtTime(200, endTime);

    // Gain: equal-power crossfade underneath
    const curves = makeEqualPowerCurves(256);
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, duration);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, duration);

  } else if (style === 'drop_cut') {
    // Also clamped to the capped duration: player_v3's completion timer fires at
    // ~duration+0.2s, so a cutTime beyond that would get truncated mid-ramp (click).
    const introDur = Math.max(2, Math.min(4 * beatPeriod, 4, duration));
    const cutTime = startCtxTime + introDur;

    inDeck.sweepFilter.type = 'highpass';
    inDeck.sweepFilter.frequency.setValueAtTime(2000, startCtxTime);
    inDeck.sweepFilter.frequency.exponentialRampToValueAtTime(20, cutTime);
    // Sharp "drop" at cutTime, but ramp over the last 10ms to avoid a gain click/pop.
    inDeck.gain.gain.setValueAtTime(0.4, startCtxTime);
    inDeck.gain.gain.setValueAtTime(0.4, cutTime - 0.01);
    inDeck.gain.gain.linearRampToValueAtTime(1, cutTime);

    outDeck.gain.gain.setValueAtTime(1, startCtxTime);
    outDeck.gain.gain.setValueAtTime(1, cutTime - 0.01);
    outDeck.gain.gain.linearRampToValueAtTime(0, cutTime);

  } else {
    // 'blend': simple equal-power (fallback)
    const curves = makeEqualPowerCurves(256);
    outDeck.gain.gain.cancelScheduledValues(startCtxTime);
    inDeck.gain.gain.cancelScheduledValues(startCtxTime);
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, duration);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, duration);
  }

  return {
    crossfadeStartTime: startCtxTime, duration, outRate, inRate, style, _tempoRamp,
    // Additive fields for the PLL (started later, post-glide, by player_v3):
    inBpmFolded, glideDur, tempoMatched,
  };
}

/**
 * Reset ALL EQ filters + sweep + gain + playbackRate after a V3 transition.
 *
 * @param {object} deck - { element, gain, lowFilter, midFilter, highFilter, sweepFilter }
 */
export function resetDeckAfterTransitionV3(deck) {
  deck.element.playbackRate = 1.0;
  for (const filter of [deck.lowFilter, deck.midFilter, deck.highFilter]) {
    if (filter) {
      filter.gain.cancelScheduledValues(0);
      filter.gain.value = 0;
    }
  }
  if (deck.sweepFilter) {
    deck.sweepFilter.frequency.cancelScheduledValues(0);
    deck.sweepFilter.type = 'highpass';
    deck.sweepFilter.frequency.value = 20; // fully open
    deck.sweepFilter.Q.value = 0.7;
  }
  if (deck.gain) {
    deck.gain.gain.cancelScheduledValues(0);
    deck.gain.gain.value = 0;
  }
}

export function resetDeckAfterTransition(deck) {
  deck.element.playbackRate = 1.0;

  if (deck.lowFilter) {
    deck.lowFilter.gain.cancelScheduledValues(0);
    deck.lowFilter.gain.value = 0;
  }
  if (deck.midFilter) {
    deck.midFilter.gain.cancelScheduledValues(0);
    deck.midFilter.gain.value = 0;
  }
  if (deck.highFilter) {
    deck.highFilter.gain.cancelScheduledValues(0);
    deck.highFilter.gain.value = 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Real-time beat drift correction (PLL)                              */
/* ------------------------------------------------------------------ */

/**
 * Keeps two decks beat-phase-locked during crossfade overlap. Used by player_v2.js.
 *
 * Uses a PI controller (phase-locked loop) that compares the beat-cycle
 * phase of both decks each animation frame and applies micro playbackRate
 * corrections (±0.5%) to the incoming deck. Inaudible with preservesPitch.
 *
 * NOTE: phase here is `currentTime % (60/(bpm*rate))` — a wall-clock-scaled
 * period compared against FILE-time currentTime, and it assumes a beat sits
 * at t=0 on both decks (ignores the real beat_grid offset). This is a known
 * dimensional inaccuracy, kept as-is because player_v2.js is out of scope for
 * this fix; see CrossfadeBeatSyncV3 below for the corrected FILE-time,
 * grid-anchored version used by player_v3.js.
 *
 * Usage:
 *   const sync = new CrossfadeBeatSync(outEl, inEl, outBpm, inBpm, outRate, inRate);
 *   sync.start();
 *   // ... later, when crossfade completes:
 *   sync.stop();
 */
export class CrossfadeBeatSync {
  constructor(outElement, inElement, outBpm, inBpm, outRate, inRate) {
    this.out = outElement;
    this.in = inElement;
    // Beat periods at matched tempo
    this.outPeriod = 60 / (outBpm * outRate);
    this.inPeriod = 60 / (inBpm * inRate);
    this.outBaseRate = outRate;
    this.inBaseRate = inRate;
    this.active = false;
    this._raf = null;

    // PI controller
    this.kp = 0.003;
    this.ki = 0.0002;
    this.integral = 0;
    this.maxCorr = 0.003; // max ±0.3% (split between both decks)

    this.targetDiff = this._outPhase() - this._inPhase();
  }

  _outPhase() {
    return (this.out.currentTime % this.outPeriod) / this.outPeriod;
  }

  _inPhase() {
    return (this.in.currentTime % this.inPeriod) / this.inPeriod;
  }

  start() {
    this.active = true;
    this._tick();
  }

  stop() {
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    // Restore base rates
    this.in.playbackRate = this.inBaseRate;
    this.out.playbackRate = this.outBaseRate;
  }

  _tick() {
    if (!this.active) return;

    // Current phase error (how far incoming has drifted from target alignment)
    let error = (this._outPhase() - this._inPhase()) - this.targetDiff;
    // Wrap to [-0.5, 0.5]
    while (error > 0.5) error -= 1;
    while (error < -0.5) error += 1;

    // PI controller — split correction between both decks
    this.integral += error;
    this.integral = Math.max(-20, Math.min(20, this.integral));
    let corr = this.kp * error + this.ki * this.integral;
    corr = Math.max(-this.maxCorr, Math.min(this.maxCorr, corr));

    // Incoming speeds up, outgoing slows down (or vice versa) — half each
    this.in.playbackRate = this.inBaseRate + corr * 0.5;
    this.out.playbackRate = this.outBaseRate - corr * 0.5;

    this._raf = requestAnimationFrame(() => this._tick());
  }
}

/**
 * Keeps two decks beat-phase-locked during crossfade overlap. Used by player_v3.js.
 *
 * Uses a PI controller (phase-locked loop) that compares the beat-cycle
 * phase of both decks each animation frame and applies micro playbackRate
 * corrections (±0.5%) to the incoming deck. Inaudible with preservesPitch.
 *
 * Phase is computed in FILE time, anchored to an actual beat_grid entry
 * (grids are periodic, so any entry works as the anchor — grid[0] is used).
 * Periods are FILE-time periods (60/bpm, NOT rate-scaled) since currentTime
 * and beat_grid are both file time; scaling by rate here was the old
 * dimensional bug. Corrections are applied on top of the CURRENT glide base
 * rates (read live from `tempoRamp` while it's still running, else the final
 * target rates) so the PLL never fights scheduleDjTransitionV3's tempo glide —
 * callers should only start this AFTER the glide completes.
 *
 * A separate class from CrossfadeBeatSync (not a signature change to it):
 * player_v2.js also instantiates CrossfadeBeatSync with the old 6-arg shape,
 * and changing that constructor in place would silently misinterpret V2's
 * positional args (grids/tempoRamp landing where rates used to be) — this
 * keeps player_v2.js byte-for-byte unaffected.
 *
 * Usage:
 *   const sync = new CrossfadeBeatSyncV3(outEl, inEl, outBpm, inBpmFolded,
 *                                         outGrid, inGrid, outRate, inRate, tempoRamp);
 *   sync.start();
 *   // ... later, when crossfade completes:
 *   sync.stop();
 */
export class CrossfadeBeatSyncV3 {
  /**
   * @param {HTMLMediaElement} outElement
   * @param {HTMLMediaElement} inElement
   * @param {number} outBpm       - raw outgoing BPM (FILE time)
   * @param {number} inBpmFolded  - octave-folded incoming BPM (FILE time), matched to outBpm
   * @param {number[]|null} outGrid - outgoing beat_grid (FILE-time positions), or null
   * @param {number[]|null} inGrid  - incoming beat_grid (FILE-time positions), or null
   * @param {number} outRate - target (post-glide) outgoing playbackRate
   * @param {number} inRate  - target (post-glide) incoming playbackRate
   * @param {object|null} tempoRamp - the glide handle from scheduleDjTransitionV3;
   *   while `!tempoRamp.done`, corrections ride its live outBase/inBase instead
   *   of the final target rates.
   */
  constructor(outElement, inElement, outBpm, inBpmFolded, outGrid, inGrid, outRate, inRate, tempoRamp = null) {
    this.out = outElement;
    this.in = inElement;
    // FILE-time beat periods (no rate scaling — see class doc comment).
    this.outPeriod = 60 / outBpm;
    this.inPeriod = 60 / inBpmFolded;
    // Grid anchors: any grid beat works since grids are periodic at the period
    // above. Fall back to 0 (assumes a beat at t=0) when no grid is available.
    this.outAnchor = (outGrid && outGrid.length > 0) ? outGrid[0] : 0;
    this.inAnchor = (inGrid && inGrid.length > 0) ? inGrid[0] : 0;
    this.targetOutRate = outRate;
    this.targetInRate = inRate;
    this.tempoRamp = tempoRamp;
    this.active = false;
    this._raf = null;

    // PI controller
    this.kp = 0.003;
    this.ki = 0.0002;
    this.integral = 0;
    this.maxCorr = 0.003; // max ±0.3% (split between both decks)

    this.targetDiff = this._outPhase() - this._inPhase();
  }

  _outPhase() {
    const p = ((this.out.currentTime - this.outAnchor) % this.outPeriod + this.outPeriod) % this.outPeriod;
    return p / this.outPeriod;
  }

  _inPhase() {
    const p = ((this.in.currentTime - this.inAnchor) % this.inPeriod + this.inPeriod) % this.inPeriod;
    return p / this.inPeriod;
  }

  // Current base rates: while the glide handle is still running, ride its live
  // values so corrections stack on a moving target instead of fighting it.
  _baseRates() {
    if (this.tempoRamp && !this.tempoRamp.done) {
      return { out: this.tempoRamp.outBase, in: this.tempoRamp.inBase };
    }
    return { out: this.targetOutRate, in: this.targetInRate };
  }

  start() {
    this.active = true;
    this._tick();
  }

  stop() {
    this.active = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    // Restore base rates (matters only if the glide had somehow already
    // finished and this PLL was the sole rate writer).
    const base = this._baseRates();
    this.out.playbackRate = base.out;
    this.in.playbackRate = base.in;
  }

  _tick() {
    if (!this.active) return;

    // Current phase error (how far incoming has drifted from target alignment)
    let error = (this._outPhase() - this._inPhase()) - this.targetDiff;
    // Wrap to [-0.5, 0.5]
    while (error > 0.5) error -= 1;
    while (error < -0.5) error += 1;

    // PI controller — split correction between both decks
    this.integral += error;
    this.integral = Math.max(-20, Math.min(20, this.integral));
    let corr = this.kp * error + this.ki * this.integral;
    corr = Math.max(-this.maxCorr, Math.min(this.maxCorr, corr));

    // Incoming speeds up, outgoing slows down (or vice versa) — half each,
    // relative to the CURRENT base rates (live glide values or final targets).
    const base = this._baseRates();
    this.in.playbackRate = base.in + corr * 0.5;
    this.out.playbackRate = base.out - corr * 0.5;

    this._raf = requestAnimationFrame(() => this._tick());
  }
}
