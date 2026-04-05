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
  outDeck.element.playbackRate = outRate;
  inDeck.element.playbackRate = inRate;

  /* ---- 2. Crossfade duration ---- */
  const matchedBpm = outBpm * outRate; // effective BPM during crossfade
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
    // Find a start position in the incoming track where the beat phase matches
    const firstInBeat = inData.intro_end || inData.beat_grid[0] || 0;
    // Start from firstInBeat, then offset by the phase difference
    const phaseOffset = outPhase * inBeatPeriod;
    inStartTime = Math.max(inStartTime, firstInBeat - phaseOffset);
    if (inStartTime < 0) inStartTime += inBeatPeriod; // wrap around
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
// Track which indices have already been played by Smart Queue
const _playedIndices = new Set();

/** Reset played tracking (call when queue changes or playback restarts) */
export function resetSmartQueuePlayed() { _playedIndices.clear(); }

/** Mark current index as played */
export function markPlayed(idx) { _playedIndices.add(idx); }

export function pickSmartNext(queue, currentIndex, currentDjData, mode = 'bpm', repeatAll = false) {
  if (!currentDjData || !currentDjData.bpm) return null;

  // Mark current as played
  _playedIndices.add(currentIndex);

  const curBpm = currentDjData.bpm;
  const curCamelot = currentDjData.camelot;
  let bestIdx = null;
  let bestScore = Infinity;

  for (let i = 0; i < queue.length; i++) {
    if (i === currentIndex) continue;
    // Skip already-played tracks (unless repeat=all AND all have been played)
    if (_playedIndices.has(i) && !repeatAll) continue;
    if (_playedIndices.has(i) && repeatAll && _playedIndices.size < queue.length) continue;

    const item = queue[i];
    const data = getDjData(item.name, item.artist);
    if (!data || !data.bpm) continue;

    let score = Math.abs(data.bpm - curBpm);

    if (mode === 'bpm_key' && curCamelot && data.camelot) {
      const style = getTransitionStyle(curCamelot, data.camelot);
      if (style === 'blend') score -= 3;
      else if (style === 'bass_swap') score -= 1;
    }

    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // If nothing found (all played, repeat=off), return null → queue ends
  // If repeat=all and all played, clear history and try again
  if (bestIdx == null && repeatAll && _playedIndices.size >= queue.length) {
    _playedIndices.clear();
    _playedIndices.add(currentIndex);
    return pickSmartNext(queue, currentIndex, currentDjData, mode, repeatAll);
  }
  return bestIdx;
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

  const now = ctx.currentTime;
  const outBpm = outData?.bpm || 85;
  const inBpm = inData?.bpm || outBpm;
  const outCurrentTime = outDeck.element.currentTime;

  /* ---- 1. Dual tempo match ---- */
  const midBpm = (outBpm + inBpm) / 2;
  let outRate = tempoRange > 0 ? Math.max(1 - tempoRange, Math.min(1 + tempoRange, midBpm / outBpm)) : 1;
  let inRate = tempoRange > 0 ? Math.max(1 - tempoRange, Math.min(1 + tempoRange, midBpm / inBpm)) : 1;
  outDeck.element.preservesPitch = true;
  inDeck.element.preservesPitch = true;
  outDeck.element.playbackRate = outRate;
  inDeck.element.playbackRate = inRate;

  /* ---- 2. Duration ---- */
  const matchedBpm = outBpm * outRate;
  const beatPeriod = 60 / matchedBpm;
  const fallbackSec = opts.fallbackSec || 5;
  const duration = outData?.bpm ? numBeats * beatPeriod : fallbackSec;

  /* ---- 3. Beat-aligned scheduling ---- */
  const startCtxTime = now;
  const endTime = startCtxTime + duration;

  /* ---- 4. Incoming track start position (phase-locked) ---- */
  let inStartTime = 0;
  if (introSkip === 'auto' && inData?.intro_end != null) {
    inStartTime = inData.intro_end;
  } else if (introSkip !== '0' && introSkip !== 'auto') {
    inStartTime = parseInt(introSkip) || 0;
  }
  if (outData?.bpm && inData?.beat_grid && inData.beat_grid.length > 0) {
    const outBeatPeriod = 60 / (outBpm * outRate);
    const inBeatPeriod = 60 / (inBpm * inRate);
    const outPhase = (outCurrentTime % outBeatPeriod) / outBeatPeriod;
    const firstInBeat = inData.intro_end || inData.beat_grid[0] || 0;
    const phaseOffset = outPhase * inBeatPeriod;
    inStartTime = Math.max(inStartTime, firstInBeat - phaseOffset);
    if (inStartTime < 0) inStartTime += inBeatPeriod;
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
      const compat = getTransitionStyle(outData.camelot, inData.camelot);
      if (compat === 'blend') style = 'eq_swap';
      else if (compat === 'bass_swap') style = 'filter_sweep';
      else style = 'drop_cut';
    }
  }

  /* ---- 6. Schedule automation per style ---- */

  if (style === 'eq_swap') {
    const killDb = -(opts.eqKillDepth || 36);
    const swapFrac = opts.bassSwapPoint || 0.5;
    const swapBeats = Math.round(numBeats * swapFrac);
    const swapTime = startCtxTime + swapBeats * beatPeriod;

    // Cancel all previous scheduled values
    for (const d of [outDeck, inDeck]) {
      d.gain.gain.cancelScheduledValues(startCtxTime);
      d.lowFilter.gain.cancelScheduledValues(startCtxTime);
      d.midFilter.gain.cancelScheduledValues(startCtxTime);
      d.highFilter.gain.cancelScheduledValues(startCtxTime);
    }

    // INCOMING: starts with EQ killed, gain at 0
    inDeck.gain.gain.setValueAtTime(0, startCtxTime);
    inDeck.lowFilter.gain.setValueAtTime(killDb, startCtxTime);
    inDeck.midFilter.gain.setValueAtTime(killDb * 0.6, startCtxTime);
    inDeck.highFilter.gain.setValueAtTime(killDb * 0.5, startCtxTime);

    // Phase 1 (0 to swap): bring in highs, then mids, raise volume
    inDeck.highFilter.gain.linearRampToValueAtTime(0, startCtxTime + duration * 0.3);
    inDeck.midFilter.gain.linearRampToValueAtTime(0, swapTime);
    inDeck.gain.gain.linearRampToValueAtTime(0.85, swapTime);

    // Phase 2: HARD BASS SWAP at swapTime (instant, one beat)
    outDeck.lowFilter.gain.setValueAtTime(0, swapTime - 0.005);
    outDeck.lowFilter.gain.setValueAtTime(killDb, swapTime);
    inDeck.lowFilter.gain.setValueAtTime(killDb, swapTime - 0.005);
    inDeck.lowFilter.gain.setValueAtTime(0, swapTime);

    // Phase 3 (swap to end): fade out outgoing
    outDeck.midFilter.gain.setValueAtTime(0, swapTime);
    outDeck.midFilter.gain.linearRampToValueAtTime(killDb * 0.6, endTime);
    outDeck.highFilter.gain.setValueAtTime(0, swapTime);
    outDeck.highFilter.gain.linearRampToValueAtTime(killDb * 0.5, endTime);
    outDeck.gain.gain.setValueAtTime(1, startCtxTime);
    outDeck.gain.gain.linearRampToValueAtTime(0, endTime);

    // Incoming full by end
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
    const introDur = Math.max(2, Math.min(4 * beatPeriod, 4));
    const cutTime = startCtxTime + introDur;

    inDeck.sweepFilter.type = 'highpass';
    inDeck.sweepFilter.frequency.setValueAtTime(2000, startCtxTime);
    inDeck.sweepFilter.frequency.exponentialRampToValueAtTime(20, cutTime);
    inDeck.gain.gain.setValueAtTime(0.4, startCtxTime);
    inDeck.gain.gain.setValueAtTime(1, cutTime);

    outDeck.gain.gain.setValueAtTime(1, startCtxTime);
    outDeck.gain.gain.setValueAtTime(0, cutTime);

  } else {
    // 'blend': simple equal-power (fallback)
    const curves = makeEqualPowerCurves(256);
    outDeck.gain.gain.cancelScheduledValues(startCtxTime);
    inDeck.gain.gain.cancelScheduledValues(startCtxTime);
    outDeck.gain.gain.setValueCurveAtTime(curves.fadeOut, startCtxTime, duration);
    inDeck.gain.gain.setValueCurveAtTime(curves.fadeIn, startCtxTime, duration);
  }

  return { crossfadeStartTime: startCtxTime, duration, outRate, inRate, style };
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
 * Keeps two decks beat-phase-locked during crossfade overlap.
 *
 * Uses a PI controller (phase-locked loop) that compares the beat-cycle
 * phase of both decks each animation frame and applies micro playbackRate
 * corrections (±0.5%) to the incoming deck. Inaudible with preservesPitch.
 *
 * Usage:
 *   const sync = new CrossfadeBeatSync(outEl, inEl, outBpm, inBpm, tempoRatio);
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
