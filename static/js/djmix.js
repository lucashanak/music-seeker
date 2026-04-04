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

  const now = ctx.currentTime;
  const outBpm = outData?.bpm || 85;
  const inBpm = inData?.bpm || outBpm;
  const outCurrentTime = outDeck.element.currentTime;

  /* ---- 1. Tempo match ---- */
  const tempoRatio = outBpm / inBpm;
  const clampedRatio = tempoRange > 0
    ? Math.max(1 - tempoRange, Math.min(1 + tempoRange, tempoRatio))
    : 1.0;
  inDeck.element.preservesPitch = true;
  inDeck.element.playbackRate = clampedRatio;

  /* ---- 2. Crossfade duration ---- */
  const beatPeriod = 60 / outBpm;
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
    const outBeatPeriod = 60 / outBpm;
    const inBeatPeriod = 60 / (inBpm * clampedRatio); // adjusted for tempo match
    // Find where we are in the outgoing beat cycle (0..1)
    const outPhase = (outCurrentTime % outBeatPeriod) / outBeatPeriod;
    // Find a start position in the incoming track where the beat phase matches
    const firstInBeat = inData.intro_end || inData.beat_grid[0] || 0;
    // Start from firstInBeat, then offset by the phase difference
    const phaseOffset = outPhase * inBeatPeriod;
    inStartTime = Math.max(inStartTime, firstInBeat - phaseOffset);
    if (inStartTime < 0) inStartTime += inBeatPeriod; // wrap around
  }
  // Seek incoming deck
  if (inStartTime > 0) {
    inDeck.element.currentTime = inStartTime;
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
    const quickDur = Math.min(2 * beatPeriod, duration);
    outDeck.gain.gain.setValueAtTime(1, startCtxTime);
    outDeck.gain.gain.linearRampToValueAtTime(0, startCtxTime + quickDur);
    inDeck.gain.gain.setValueAtTime(0, startCtxTime);
    inDeck.gain.gain.linearRampToValueAtTime(1, startCtxTime + quickDur);
  }

  return { crossfadeStartTime: startCtxTime, duration, tempoRatio: clampedRatio, style };
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
export function pickSmartNext(queue, currentIndex, currentDjData, mode = 'bpm') {
  if (!currentDjData || !currentDjData.bpm) return null;

  const curBpm = currentDjData.bpm;
  const curCamelot = currentDjData.camelot;
  let bestIdx = null;
  let bestScore = Infinity;

  for (let i = currentIndex + 1; i < queue.length; i++) {
    const item = queue[i];
    const data = getDjData(item.name, item.artist);
    if (!data || !data.bpm) continue; // not analyzed yet, skip

    // BPM distance (lower is better)
    let score = Math.abs(data.bpm - curBpm);

    // Key compatibility bonus (only in bpm_key mode)
    if (mode === 'bpm_key' && curCamelot && data.camelot) {
      const style = getTransitionStyle(curCamelot, data.camelot);
      if (style === 'blend') score -= 3;      // harmonically perfect
      else if (style === 'bass_swap') score -= 1; // close enough
      // 'cut' = no bonus (clashing keys)
    }

    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
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
