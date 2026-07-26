// player_v3.js — DJ Player with 3-band EQ transitions
// Drop-in replacement for player.js — same exports, same API.

import { store } from './store.js';
import { $, $$, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderQueue } from './queue.js';
import { syncFullPlayer } from './fullplayer.js';
import { getCachedUrl, waitForCache, getStatus as getPrefetchStatus, prefetchTrack, cleanup as prefetchCleanup, pausePrefetch, abortStale, keyFor as prefetchKey, resumePrefetch, streamQuality } from './prefetch.js';
import { fetchDjData, scheduleDjTransitionV3, resetDeckAfterTransitionV3, scheduleDjTransition, resetDeckAfterTransition, findCrossfadeStartBeat, findCrossfadeStartDownbeat, pickSmartNext, markPlayed, resetSmartQueuePlayed, CrossfadeBeatSyncV3, IS_WEBKIT, webkitCrossfadeDuration } from './djmix.js';
import { getDjData } from './bpm.js';
import * as cast from './cast.js';

// ── Dual-deck Web Audio API crossfade engine with DJ mixing ──

const _deckA = $('#audioElement');
const _deckB = document.createElement('audio');
_deckB.preload = 'none';
document.body.appendChild(_deckB);

let _ctx = null;
let _nodesA = null, _nodesB = null;
let _sourceA = null, _sourceB = null;
let _master = null; // master safety limiter on the summed deck bus (prevents crossfade clipping)
let _activeDeck = 'A';
let _crossfading = false;
let _crossfadeTimer = null;
let _fadingOutDeck = null;
let _rateReturnTimer = null;
let _tempoRamp = null; // dual-deck tempo glide handle (cancellable on rapid skip)
let _beatSyncStartTimer = null; // delayed PLL start (fires once the glide completes)
function _cancelTempoRamp() {
  if (_tempoRamp) {
    _tempoRamp.cancelled = true;
    if (_tempoRamp.id) cancelAnimationFrame(_tempoRamp.id);
    _tempoRamp = null;
  }
}

// Central crossfade teardown — every abort path must clear ALL transition timers and
// the beat-sync PLL, or an orphaned timer keeps writing playbackRate on a reused deck
// (causes tempo drift / glitches). Call before starting a fresh load/crossfade.
function _teardownCrossfade() {
  clearTimeout(_crossfadeTimer);
  clearInterval(_rateReturnTimer);
  clearTimeout(_beatSyncStartTimer);
  _beatSyncStartTimer = null;
  _cancelTempoRamp();
  if (_beatSync) { _beatSync.stop(); _beatSync = null; }
}
let _beatSync = null;

// DJ data for current and next track (fetched asynchronously)
let _outDjData = null;
let _inDjData = null;

// Track expected src per deck — only handle errors from the current source
let _expectedSrcA = '';
let _expectedSrcB = '';
let _crossfadeTriggered = false;

// Fix 4 safety net: set by the `ended` handler when a track ended WITHOUT the auto trigger
// having fired and no crossfade in progress. Forces _loadAndPlayImpl down its crossfade
// branch (instead of the cold-start hard swap a paused/ended deck would otherwise take) so
// the next track eases in with a short blend rather than a bare silent cut. One-shot:
// consumed (cleared) at the top of _loadAndPlayImpl.
let _endedBlend = false;

// Single in-flight latch for ALL advance entrypoints (auto/ended/error/user/nextTrack).
// loadAndPlay→deck-swap is async while timeupdate/ended keep firing, so without this a
// SECOND advance can fire before the first swaps the active deck → double advance /
// overlapping crossfades. Set synchronously at the START of every advance entrypoint,
// cleared inside loadAndPlay on ALL exit paths (success, early return, error) so the
// player can never get permanently stuck. Additional to (not a replacement for) the
// existing reason==='user' time throttle.
let _advanceInFlight = false;

// Smart Queue prediction binding: _preAnalyzeUpcoming predicts the next index and
// prefetches it; _nextTrackInQueue reuses that prediction at commit (if still valid)
// instead of recomputing pickSmartNext, so the prefetched track is the one we play.
let _predictedNextIdx = null;
let _predictedNextKey = null;

// Generation counter for _preAnalyzeUpcoming — bumped each invocation so a stale async
// run (rapid skip) can detect it was superseded after each await and bail before it
// clobbers _inDjData / _predictedNextIdx / prefetch.
let _analyzeGen = 0;

// DJ settings from localStorage (read fresh each call)
function _djSetting(key, def) { return localStorage.getItem(`ms_dj_${key}`) || def; }
function _crossfadeDur() { return parseInt(_djSetting('crossfade_sec', '5')) || 5; }

// One-time migration (2026-07): outro_skip default changed 'auto' → '0' (auto outro
// skip cut track endings 5-13s early — now opt-in). A stored 'auto' almost certainly
// came from the old default being persisted by settings-save, not a deliberate choice,
// so reset it once; the marker lets a user who explicitly re-picks 'auto' keep it.
try {
  // Marker is set UNCONDITIONALLY on first post-deploy load — not just when 'auto'
  // was found — otherwise a user who later deliberately picks 'auto' would get it
  // silently reset on their next reload (marker would still be missing).
  if (!localStorage.getItem('ms_dj_outro_skip_migr')) {
    if (localStorage.getItem('ms_dj_outro_skip') === 'auto') {
      localStorage.setItem('ms_dj_outro_skip', '0');
    }
    localStorage.setItem('ms_dj_outro_skip_migr', '1');
  }
} catch {}

function _createDeckNodes() {
  const low = _ctx.createBiquadFilter();
  low.type = 'lowshelf'; low.frequency.value = 250; low.gain.value = 0;
  const mid = _ctx.createBiquadFilter();
  mid.type = 'peaking'; mid.frequency.value = 1200; mid.Q.value = 0.7; mid.gain.value = 0;
  const high = _ctx.createBiquadFilter();
  high.type = 'highshelf'; high.frequency.value = 3500; high.gain.value = 0;
  const sweep = _ctx.createBiquadFilter();
  sweep.type = 'highpass'; sweep.frequency.value = 20; sweep.Q.value = 0.7;
  // Per-deck LUFS level-match gain. SEPARATE from the crossfade `gain` (which is
  // overwritten by setValueCurveAtTime/ramps every transition) so level-matching is
  // never wiped or double-applied. Set as a plain value once per track load.
  const levelGain = _ctx.createGain();
  const gain = _ctx.createGain();
  return { low, mid, high, sweep, levelGain, gain };
}

/**
 * LUFS level-match gain — OFF by default (the library is already fairly consistent
 * and the user didn't want volume lowered). Opt in by setting ms_dj_level_target to a
 * LUFS target (e.g. -12); then it ATTENUATES loud tracks toward that target (cap 1.0 —
 * never boosts, so it can't clip the limiter). Absent setting or lufs → 1 (no change).
 */
function _levelGainFor(lufs) {
  const target = parseFloat(_djSetting('level_target', ''));
  if (!Number.isFinite(target) || !Number.isFinite(lufs)) return 1;
  const g = Math.pow(10, (target - lufs) / 20);
  return Math.min(1, g);
}

/**
 * Live-apply settings that affect already-playing audio. Only the active deck's
 * LUFS level gain — so a `ms_dj_level_target` change is audible immediately.
 * Selection knobs (tempo/key/energy/etc.) are read fresh on the next advance, so
 * they need no action here. No-op safe when no AudioContext/deck exists yet.
 */
export function applyDjSettings() {
  if (!_ctx || !_activeLevel()) return;
  _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
}

function _ensureAudioContext() {
  if (_ctx) return;
  const _AC = window.AudioContext || window.webkitAudioContext;
  try {
    // Match the library's dominant sample rate (~48 kHz) so MediaElementSource does NOT
    // resample inside the graph (the FLAC/MP3 library is overwhelmingly 48 kHz). On a
    // 48 kHz output device this is fully transparent; on a 44.1 kHz device the single
    // unavoidable resample happens once at the OS output instead of twice.
    _ctx = new _AC({ sampleRate: 48000, latencyHint: 'playback' });
  } catch (e) {
    _ctx = new _AC(); // device can't honor 48 kHz → fall back to default
  }
  _nodesA = _createDeckNodes();
  _nodesB = _createDeckNodes();

  _sourceA = _ctx.createMediaElementSource(_deckA);
  _sourceB = _ctx.createMediaElementSource(_deckB);

  // Master safety limiter on the summed bus. A full equal-power BLEND sums two correlated
  // basslines (0.707 + 0.707 ≈ 1.41 > 1.0) which would hard-clip the destination → audible
  // crackle/pops during transitions. A brickwall limiter just below 0 dBFS catches that
  // transient overshoot; normal single-track playback sits ≤ 0 dBFS (below threshold) so it
  // passes through transparently. Both decks share it → equal latency, no beat misalignment.
  _master = _ctx.createDynamicsCompressor();
  _master.threshold.value = -0.5; // dBFS — only catches the cross-fade sum overshoot
  _master.knee.value = 0;         // hard knee = brickwall limiting, transparent below thresh
  _master.ratio.value = 20;
  _master.attack.value = 0.002;
  _master.release.value = 0.06;
  _master.connect(_ctx.destination);

  // Chain: source → low → mid → high → sweep → levelGain → gain → master(limiter) → destination
  // levelGain (LUFS level-match) sits BEFORE the crossfade gain so the two never interact.
  _sourceA.connect(_nodesA.low).connect(_nodesA.mid).connect(_nodesA.high).connect(_nodesA.sweep).connect(_nodesA.levelGain).connect(_nodesA.gain).connect(_master);
  _sourceB.connect(_nodesB.low).connect(_nodesB.mid).connect(_nodesB.high).connect(_nodesB.sweep).connect(_nodesB.levelGain).connect(_nodesB.gain).connect(_master);

  _nodesA.gain.gain.value = 1;
  _nodesB.gain.gain.value = 0;
}

function _setDeckSrc(deck, src) {
  if (deck === _deckA) _expectedSrcA = src;
  else _expectedSrcB = src;
  deck.src = src;
  deck.load();
}
function _isExpectedSrc(deck) {
  const expected = deck === _deckA ? _expectedSrcA : _expectedSrcB;
  return expected && deck.src && deck.src === expected;
}
function _activeDeckEl() { return _activeDeck === 'A' ? _deckA : _deckB; }
function _inactiveDeckEl() { return _activeDeck === 'A' ? _deckB : _deckA; }
function _activeNodes() { return _activeDeck === 'A' ? _nodesA : _nodesB; }
function _inactiveNodes() { return _activeDeck === 'A' ? _nodesB : _nodesA; }
function _activeGain() { return _activeNodes().gain; }
function _activeLevel() { return _activeNodes().levelGain; }
function _inactiveLevel() { return _inactiveNodes().levelGain; }
function _inactiveGain() { return _inactiveNodes().gain; }

/** Build deck descriptor object for djmix.js */
function _deckDesc(deckEl) {
  const isA = deckEl === _deckA;
  const nodes = isA ? _nodesA : _nodesB;
  return {
    element: deckEl,
    gain: nodes.gain,
    lowFilter: nodes.low,
    midFilter: nodes.mid,
    highFilter: nodes.high,
    sweepFilter: nodes.sweep,
  };
}

// Pause mid-fade: the fade timers (setTimeout, wall-clock) and WebAudio gain ramps
// (ctx.currentTime) keep advancing while paused, so on resume the gains/rates are wrong
// (jarring). Rather than snapshot/reschedule, finalize the crossfade NOW to a clean
// single-deck state — the swapped-in (active) deck becomes the sole deck at full gain.
// Returns the active deck so the caller can pause it. Safe to call when not crossfading.
function _finalizeCrossfadeOnPause() {
  if (!_crossfading) return _activeDeckEl();
  _teardownCrossfade();
  // The active deck was already swapped to the incoming track in _startCrossfade.
  if (_fadingOutDeck) {
    resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
    _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
  }
  _crossfading = false;
  const active = _activeDeckEl();
  active.playbackRate = 1.0;
  const g = _activeGain();
  if (g) { g.gain.cancelScheduledValues(0); g.gain.value = 1; }
  // The surviving deck went through scheduleDjTransitionV3, which ramps its EQ bands
  // and sweep filter; teardown froze them mid-transition. Neutralize them (gain stays 1)
  // so the resumed track isn't left with a bass cut / active highpass sweep.
  const n = _activeNodes();
  for (const f of [n.low, n.mid, n.high]) {
    if (f) { f.gain.cancelScheduledValues(0); f.gain.value = 0; }
  }
  if (n.sweep) {
    n.sweep.frequency.cancelScheduledValues(0);
    n.sweep.type = 'highpass';
    n.sweep.frequency.value = 20; // fully open
    n.sweep.Q.value = 0.7;
  }
  return active;
}

function _startCrossfade(seekable = true) {
  if (!_ctx) return;

  // Bug #4: a still-running rate-return from the PREVIOUS fade would otherwise keep
  // writing to the now-outgoing (audible) deck for up to 500ms into this new fade,
  // snapping its tempo back toward 1.0 mid-blend. Clear unconditionally, not just on
  // the completion path — a fade can start again well before the last one settled.
  clearInterval(_rateReturnTimer);

  // If already crossfading, kill the fading-out deck immediately
  if (_crossfading && _fadingOutDeck) {
    resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
    _fadingOutDeck.pause();
    _fadingOutDeck.src = '';
    _teardownCrossfade();
    _crossfading = false;
  }

  _fadingOutDeck = _activeDeckEl();
  const outDesc = _deckDesc(_fadingOutDeck);
  const inDesc = _deckDesc(_inactiveDeckEl());

  // Swap active deck NOW
  _activeDeck = _activeDeck === 'A' ? 'B' : 'A';
  _crossfading = true;

  // Save DJ data refs for transition BEFORE swapping
  const transOutData = _outDjData;
  const transInData = _inDjData;
  // Swap DJ data so timeupdate uses new track's data for the NEXT crossfade
  _outDjData = _inDjData;
  _inDjData = null;

  // LUFS level-match the INCOMING deck (now the active deck post-swap) BEFORE the fade.
  // Plain value, never a ramp, so it can't interact with the crossfade gain curve.
  // Attenuate-only (cap 1.0); 1.0 when lufs absent → identical to today.
  if (_activeLevel()) _activeLevel().gain.value = _levelGainFor(transInData?.lufs);

  // Read DJ settings
  const numBeats = parseInt(_djSetting('crossfade_beats', '16')) || 16;
  const tr = _djSetting('tempo_range', '8');
  const tempoRange = tr === '0' ? 0 : (parseInt(tr) || 8);
  const transStyle = _djSetting('transition_style', 'auto');
  const introSkip = _djSetting('intro_skip', 'auto');

  // Use seekable flag passed from loadAndPlay (cached blob = seekable)
  const inSeekable = seekable;

  // Fade-length cap: the grid-derived trigger lead is often ~1 bar SHORTER than the
  // full numBeats fade (downbeat alignment picks a bar START <numBeats before the
  // end), and loadAndPlay adds latency on top — so a fixed 16-beat fade routinely
  // overran the outgoing file's end and the deck died via `ended` at ~20% gain
  // (audible clip of the track's last seconds; measured on 82/145 library tracks).
  // Cap the fade so the outgoing gain reaches 0 AT its effective end. Mirrors the
  // timeupdate trigger's outro logic (outro_skip default '0' — see migration above).
  let fadeCapSec = 0;
  {
    const oDur = _fadingOutDeck.duration;
    if (oDur && isFinite(oDur) && oDur > 0) {
      let eff = oDur;
      const oSkip = _djSetting('outro_skip', '0');
      if (oSkip === 'auto' && transOutData?.outro_start
          && transOutData.outro_start > oDur * 0.85 && transOutData.outro_start < oDur) {
        eff = transOutData.outro_start;
      } else if (oSkip !== '0' && oSkip !== 'auto') {
        eff = oDur - (parseInt(oSkip) || 0);
      }
      const remaining = eff - _fadingOutDeck.currentTime;
      // ≤0.5s remaining = the ended-blend/edge path — leave uncapped so the existing
      // "ease the next track in over a full fade" behavior is preserved.
      if (remaining > 0.5) fadeCapSec = remaining;
    }
  }

  // Use DJ mix engine for beat-synced, key-aware transition
  const result = scheduleDjTransitionV3(_ctx, outDesc, inDesc, transOutData, transInData, {
    numBeats, tempoRange, transitionStyle: transStyle,
    introSkip: inSeekable ? introSkip : '0',  // no seek on non-cached streams
    seekable: inSeekable,
    fallbackSec: _crossfadeDur(),
    fadeCapSec,
    bassSwapPoint: parseInt(_djSetting('bass_swap_point', '50')) / 100,
    eqKillDepth: parseInt(_djSetting('eq_kill_depth', '36')),
    filterResonance: parseFloat(_djSetting('filter_resonance', '2')),
  });
  const dur = result.duration || _crossfadeDur();
  // Cancel any previous ramp, then adopt the new transition's cancellable handle
  _cancelTempoRamp();
  _tempoRamp = result._tempoRamp || null;
  const beatDelay = (result.crossfadeStartTime - _ctx.currentTime) * 1000;
  const timerDur = dur * 1000 + Math.max(0, beatDelay) + 200;

  // Real-time beat drift correction (PLL) starts only AFTER the tempo glide finishes.
  // Starting it immediately (old behavior) meant it registered its target phase and
  // began writing playbackRate every frame WHILE the glide's own rAF loop was also
  // writing it every frame — whichever ran later in a given frame won, silently
  // turning the glide into dead code. Delaying the PLL until the glide's `done` flag
  // (via this timer) removes that fight. Only worth starting when an actual tempo
  // match happened (result.tempoMatched) and both bpms exist — WebKit never stretches
  // tempo, so it has nothing to phase-lock either.
  if (_beatSync) { _beatSync.stop(); _beatSync = null; }
  clearTimeout(_beatSyncStartTimer);
  _beatSyncStartTimer = null;
  const glideMs = (result.glideDur || 0) * 1000;
  const pllOutDeck = _fadingOutDeck;
  const pllInDeck = _activeDeckEl();
  if (!IS_WEBKIT && result.tempoMatched && transOutData?.bpm && transInData?.bpm) {
    _beatSyncStartTimer = setTimeout(() => {
      _beatSyncStartTimer = null;
      // Guard: a rapid skip could have torn this crossfade down (or started a new
      // one on these same decks) before the glide finished — only start if this
      // exact transition is still the one in progress.
      if (!_crossfading || pllOutDeck !== _fadingOutDeck || pllInDeck !== _activeDeckEl()) return;
      _beatSync = new CrossfadeBeatSyncV3(
        pllOutDeck, pllInDeck,
        transOutData.bpm, result.inBpmFolded,
        transOutData.beat_grid || null, transInData.beat_grid || null,
        result.outRate, result.inRate, result._tempoRamp
      );
      _beatSync.start();
    }, glideMs + 50);
  }

  // After crossfade completes, clean up old deck
  clearTimeout(_crossfadeTimer);
  const deckToStop = _fadingOutDeck;
  const outroFade = _djSetting('outro_fade', '1') === '1';
  // outro_fade=off: quick 20ms fade to avoid pop, then stop
  if (!outroFade) {
    const desc = _deckDesc(deckToStop);
    // Clear the outgoing fade scheduleDjTransitionV3 already scheduled before laying
    // down our 20ms kill ramp — AudioParam events stack, so without this the two curves
    // fight/yank the gain. cancelScheduledValues lets the 20ms ramp REPLACE the transition
    // outgoing curve cleanly.
    desc.gain.gain.cancelScheduledValues(_ctx.currentTime);
    desc.gain.gain.setValueAtTime(desc.gain.gain.value, _ctx.currentTime);
    desc.gain.gain.linearRampToValueAtTime(0, _ctx.currentTime + 0.02);
    setTimeout(() => { deckToStop.pause(); deckToStop.src = ''; }, 25);
  }
  _crossfadeTimer = setTimeout(() => {
    if (outroFade) { deckToStop.pause(); deckToStop.src = ''; }
    resetDeckAfterTransitionV3(_deckDesc(deckToStop));
    if (_beatSync) { _beatSync.stop(); _beatSync = null; }
    // Now safe to cleanup old blob URLs
    prefetchCleanup(store.playerQueue, store.playerIndex);
    _fadingOutDeck = null;
    _crossfading = false;
    resumePrefetch();
    // Gradually return new deck playbackRate to 1.0 over ~10 seconds.
    // WebKit path never stretched tempo (rate stays 1) — nothing to return, skip.
    clearInterval(_rateReturnTimer); // Bug #4: clear previous
    const newDeck = _activeDeckEl();
    if (!IS_WEBKIT && newDeck.playbackRate !== 1.0) {
      const startRate = newDeck.playbackRate;
      const diff = Math.abs(startRate - 1.0);
      // Gradually return the new deck to 1.0x. A SLOW return is intentional — a fast snap
      // is audible as a tempo jump. Default 15s floor / 400 s-per-unit (≈30s for ±8%).
      // Tunable: ms_dj_rate_return_min (floor seconds), ms_dj_rate_return_scale (s/unit).
      const _rrMin = parseFloat(_djSetting('rate_return_min', '15'));
      const _rrScale = parseFloat(_djSetting('rate_return_scale', '400'));
      const returnSec = Math.max(
        Number.isFinite(_rrMin) ? _rrMin : 15,
        Math.round(diff * (Number.isFinite(_rrScale) ? _rrScale : 400))
      );
      const steps = Math.round(returnSec * 2); // 2 steps/sec
      let step = 0;
      _rateReturnTimer = setInterval(() => {
        step++;
        if (newDeck !== _activeDeckEl()) {
          // A new transition already swapped the active deck out from under this
          // return — that transition owns this deck's rate now. Just stop; do NOT
          // snap it to 1.0, or we'd yank it out of whatever tempo the new fade
          // (glide or PLL) just placed it at.
          clearInterval(_rateReturnTimer);
        } else if (step >= steps) {
          newDeck.playbackRate = 1.0;
          clearInterval(_rateReturnTimer);
        } else {
          // Ease-out curve: fast at first, slowing down as approaching 1.0
          const t = step / steps;
          const eased = 1 - (1 - t) * (1 - t); // quadratic ease-out
          newDeck.playbackRate = startRate + (1.0 - startRate) * eased;
        }
      }, 500);
    }
  }, timerDur);

  return result;
}

/** Pre-analyze upcoming tracks, predict Smart Queue pick, prefetch it.
 *  1. Ensure current track DJ data is loaded (needed for smart queue + crossfade)
 *  2. Fetch next track DJ data immediately (needed for crossfade timing)
 *  3. Predict Smart Queue pick and prefetch it
 *  4. Analyze remaining tracks in background */
async function _preAnalyzeUpcoming() {
  const PRE_ANALYZE = parseInt(_djSetting('pre_analyze', '10')) || 10;
  const smartMode = _djSetting('smart_queue', 'off');
  // Generation token: a rapid skip bumps _analyzeGen, so a stale invocation can detect
  // it was superseded after each await and bail before clobbering _inDjData /
  // _predictedNextIdx / prefetch with data for the wrong (already-skipped) track.
  const gen = ++_analyzeGen;

  // Step 1: Ensure _outDjData is loaded (block until ready — needed for everything)
  if (!_outDjData) {
    const cur = store.playerQueue[store.playerIndex];
    if (cur) {
      const d = await fetchDjData(_decodeEntities(cur.name || ''), _decodeEntities(cur.artist || '')).catch(() => null);
      if (gen !== _analyzeGen) return; // superseded by a newer run
      if (d) _outDjData = d;
    }
  }

  // Step 2: Immediately fetch DJ data for sequential next track (crossfade fallback)
  const seqNext = store.playerQueue[store.playerIndex + 1];
  if (seqNext) {
    const name = _decodeEntities(seqNext.name || '');
    const artist = _decodeEntities(seqNext.artist || '');
    if (!getDjData(name, artist)) { await fetchDjData(name, artist).catch(() => null); if (gen !== _analyzeGen) return; }
    // Set _inDjData early so crossfade has data even if smart queue changes it later
    if (!_inDjData) _inDjData = getDjData(name, artist);
    resumePrefetch();             // C5: clear _paused so prefetchTrack isn't a no-op in smart mode
    prefetchTrack(name, artist, seqNext.id);
  }

  // Step 2.5: PRIORITIZE the predicted-next track — it becomes _outDjData at the next swap.
  // Analyze it FIRST and ALONE (before the broad warming pool, which competes at low
  // concurrency) so its beat grid is ready for a beat-matched crossfade. Reuses the
  // already-bound _predictedNextIdx (no pickSmartNext call) → determinism intact.
  if (smartMode !== 'off' && !store.shuffleEnabled
      && _predictedNextIdx != null
      && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length
      && _predictedNextIdx !== store.playerIndex) {
    const pItem = store.playerQueue[_predictedNextIdx];
    const pName = _decodeEntities(pItem.name || '');
    const pArtist = _decodeEntities(pItem.artist || '');
    if (!getDjData(pName, pArtist)) {
      await fetchDjData(pName, pArtist).catch(() => null);
      if (gen !== _analyzeGen) return; // superseded by a newer run
    }
    if (!_inDjData) _inDjData = getDjData(pName, pArtist);
    resumePrefetch();
    prefetchTrack(pName, pArtist, pItem.id);
  }

  // Step 3: Analyze remaining forward (and, for Smart Queue, backward) tracks for the
  // candidate pool. Collect the target indices, then fetch in concurrency-4 chunks
  // (mirrors the batch pattern in bpm.js addScanButton) instead of one-at-a-time.
  const toAnalyze = [];
  for (let i = 2; i <= PRE_ANALYZE; i++) {
    const idx = store.playerIndex + i;
    if (idx >= store.playerQueue.length) break;
    toAnalyze.push(idx);
  }
  // Backward: previous tracks (when Smart Queue searches whole playlist). Symptom A (#6):
  // these analysis downloads compete with prefetch, so cut the BACKWARD span to a small
  // window instead of the full PRE_ANALYZE depth. Forward analysis stays at full depth so
  // pickSmartNext still has its forward candidate pool (determinism preserved); the smaller
  // backward window keeps the whole-playlist fallback viable without starving prefetch.
  if (smartMode !== 'off') {
    const BACKWARD = Math.min(3, PRE_ANALYZE);
    for (let i = store.playerIndex - 1; i >= Math.max(0, store.playerIndex - BACKWARD); i--) {
      toAnalyze.push(i);
    }
  }
  const analyzeOne = async (idx) => {
    const item = store.playerQueue[idx];
    const name = _decodeEntities(item.name || '');
    const artist = _decodeEntities(item.artist || '');
    if (getDjData(name, artist)) return;
    await fetchDjData(name, artist).catch(() => null);
  };
  // Symptom A (#6): lower analyze concurrency (4 → 2) so the BPM-warming downloads don't
  // serialize/starve the next-track prefetch that's already in flight. Prefetch is NOT
  // blocked by this loop — it runs independently on its own queue/MAX_CONCURRENT.
  // Adaptive: keep concurrency low (2) while the immediate-next prefetch is in flight so
  // warming doesn't starve it; raise to 4 once that blob is cached (no bandwidth contention)
  // to restore warming depth deeper into a session.
  const _immNext = store.playerQueue[store.playerIndex + 1];
  const _immReady = _immNext
    ? (getPrefetchStatus(_decodeEntities(_immNext.name || ''), _decodeEntities(_immNext.artist || ''), _immNext.id)?.state === 'ready')
    : true;
  const CONCURRENT = _immReady ? 4 : 2;
  for (let i = 0; i < toAnalyze.length; i += CONCURRENT) {
    const batch = toAnalyze.slice(i, i + CONCURRENT);
    await Promise.all(batch.map(analyzeOne));
    if (gen !== _analyzeGen) return; // superseded mid-scan — don't predict/prefetch
  }

  // Step 4: Predict Smart Queue pick, store the prediction (so commit reuses it),
  // update _inDjData + prefetch.
  if (smartMode !== 'off' && !store.shuffleEnabled && _outDjData) {
    // Guard: if the `playing` handler already ran pickSmartNext early (FIX 2 — sync DJ
    // data cache hit) and bound _predictedNextIdx for THIS position, do NOT re-run
    // pickSmartNext here. Step 3 just analyzed more forward tracks, so candidate scores
    // may have shifted → a re-pick could choose a DIFFERENT index than the one we already
    // prefetched → prediction≠prefetch≠commit → non-gapless hard cut. The early binding
    // is authoritative; skip the re-pick and only ensure _inDjData + prefetch are current.
    const _alreadyBound = _predictedNextIdx != null
      && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length
      && _predictedNextIdx !== store.playerIndex;
    if (_alreadyBound) {
      // Prediction already set — just wire _inDjData and confirm the prefetch (idempotent).
      const item = store.playerQueue[_predictedNextIdx];
      const name = _decodeEntities(item.name || '');
      const artist = _decodeEntities(item.artist || '');
      _inDjData = getDjData(name, artist);
      resumePrefetch();           // C5: ensure prefetch isn't paused in smart mode
      prefetchTrack(name, artist, item.id);
    } else {
      const smartIdx = pickSmartNext(store.playerQueue, store.playerIndex, _outDjData, smartMode, store.repeatMode === 'all');
      if (gen !== _analyzeGen) return; // superseded — don't bind a stale prediction
      if (smartIdx != null) {
        const item = store.playerQueue[smartIdx];
        const name = _decodeEntities(item.name || '');
        const artist = _decodeEntities(item.artist || '');
        // C1: record what we predicted+prefetched so _nextTrackInQueue reuses this exact
        // index at commit instead of recomputing (and possibly diverging → non-gapless).
        _predictedNextIdx = smartIdx;
        _predictedNextKey = _smartKey(item);
        _inDjData = getDjData(name, artist);
        resumePrefetch();         // C5: ensure prefetch isn't paused in smart mode
        prefetchTrack(name, artist, item.id);
      }
    }
  }
}

// Expose active deck as `audio` for backward compatibility
const audio = _deckA;
export function getAudio() { return _activeDeckEl(); }

function _ab() { return window.AndroidBridge || null; }

/** Wait until audio element has buffered enough (30s ahead or full track).
 *  Resolves immediately for blob URLs (fully loaded). Polls every 500ms, max 15s wait. */
function _waitForBuffer(deck) {
  return new Promise(resolve => {
    // Blob URLs are fully loaded — no need to wait
    if (deck.src && deck.src.startsWith('blob:')) { resolve(); return; }
    let checks = 0;
    const maxChecks = 30; // 30 × 500ms = 15s max wait
    const check = () => {
      checks++;
      if (checks >= maxChecks || deck.paused || deck !== _activeDeckEl()) { resolve(); return; }
      // Check how far ahead we've buffered
      if (deck.buffered.length > 0) {
        const bufferedEnd = deck.buffered.end(deck.buffered.length - 1);
        const aheadSec = bufferedEnd - deck.currentTime;
        const trackDur = deck.duration || 0;
        if (aheadSec >= 15 || (trackDur > 0 && bufferedEnd >= trackDur * 0.8)) {
          resolve(); return; // 15s buffered ahead or 80%+ of track
        }
      }
      setTimeout(check, 500);
    };
    setTimeout(check, 500); // first check after 500ms
  });
}

/** Resolve once the deck can begin playback (readyState >= HAVE_CURRENT_DATA) or after
 *  timeoutMs — whichever first. Used to gate the fade-in on an uncached live stream so
 *  the fade doesn't play silence at readyState 0. Never stalls: always resolves. */
function _waitForCanPlay(deck, timeoutMs = 2500) {
  return new Promise(resolve => {
    if (deck.readyState >= 2) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      deck.removeEventListener('canplay', finish);
      deck.removeEventListener('loadeddata', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    deck.addEventListener('canplay', finish, { once: true });
    deck.addEventListener('loadeddata', finish, { once: true });
  });
}

let _lastAbUpdate = 0;

// Android native media action callback (notification buttons → WebView)
window._androidMediaAction = function(action) {
  switch (action) {
    case 'play': _activeDeckEl().play().catch(() => {}); break;
    case 'pause': _activeDeckEl().pause(); break;
    case 'next': nextTrack(); break;
    case 'prev': prevTrack(); break;
  }
};

// Remote control: apply a command from a controlling device to LOCAL playback
// (this device is the target). Mirrors window._androidMediaAction above.
// Prepare the Web Audio graph for an inbound remote play on THIS (target) device:
// resume a suspended context and force the active deck's crossfade gain to 1 (inactive
// to 0), mirroring _loadAndPlayImpl's cold-start path. Without this an idle target whose
// context is suspended or whose active gain is 0 plays silently.
// NOTE: browser autoplay policy may still keep the context suspended without a prior
// user gesture on the target — that's an inherent limitation we can't work around here.
function _prepareRemotePlayback() {
  _ensureAudioContext();
  if (_ctx && _ctx.state === 'suspended') _ctx.resume();
  if (_activeGain()) { _activeGain().gain.cancelScheduledValues(0); _activeGain().gain.value = 1; }
  if (_inactiveGain()) { _inactiveGain().gain.cancelScheduledValues(0); _inactiveGain().gain.value = 0; }
}

export function applyRemoteCommand(action, value) {
  const a = getAudio();
  switch (action) {
    case 'play':  _prepareRemotePlayback(); a.play().catch(() => {}); updatePlayPauseIcon(true); break;
    case 'pause': a.pause(); updatePlayPauseIcon(false); break;
    case 'next':  nextTrack(); break;
    case 'prev':  prevTrack(); break;
    case 'seek':  try { a.currentTime = Number(value) || 0; } catch {} break;
    case 'volume': {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      store.playerVolume = v;
      const el = document.getElementById('playerVolume'); if (el) el.value = Math.round(v * 100);
      const fp = document.getElementById('fpVolume'); if (fp) fp.value = Math.round(v * 100);
      // DJ engine sets volume on BOTH decks (matches the #playerVolume handler).
      _deckA.volume = v;
      _deckB.volume = v;
      break;
    }
    case 'enqueue': addToQueue(Array.isArray(value) ? value : [value], false); break;
    case 'transfer':
      // Play through the full engine path (loadAndPlay → _loadAndPlayImpl) so DJ
      // smart-queue + auto-mix/crossfade are armed for a transfer (clicking a track
      // in a playlist), matching what `next`/`prev` already get. A raw deck.play()
      // here bypassed the DJ setup, so transferred tracks didn't DJ-mix. loadAndPlay
      // handles the audio context + deck gain itself.
      loadQueueState().then(() => { loadAndPlay(); });
      break;
  }
}

// Called by native side when bridge is injected (may be after playback started)
window._androidBridgeReady = function() {
  if (!_activeDeckEl().paused && _ab()) {
    const item = store.playerQueue[store.playerIndex];
    if (item) _ab().onPlay(item.name || '', item.artist || '');
  }
};

// ── Helper: get duration with Safari fallback ──
function _getDuration() {
  const item = store.playerQueue[store.playerIndex] || _currentRecItem;
  const metaSec = item && item.duration_ms > 0 ? item.duration_ms / 1000 : 0;
  const deck = _activeDeckEl();
  const dur = deck.duration;
  const deckOk = dur && isFinite(dur) && dur > 0;
  // WebKit/WKWebView (notably AVFoundation on macOS) can report a streamed track's
  // audio.duration as a small value that TRACKS the playhead (duration ≈ currentTime),
  // or otherwise materially wrong, instead of the true file length. That bogus-but-
  // positive value passes a naive isFinite/>0 guard, so progress (currentTime/dur) and
  // the auto-crossfade trigger (which share this value) peg at the wrong point — the
  // track gets cut at its real midpoint. ONLY on WebKit, and only when authoritative
  // Spotify metadata exists, distrust a deck duration that tracks the playhead
  // (dur ≈ currentTime) or disagrees materially (>15%) and use duration_ms instead.
  // Other platforms keep trusting the deck: its value is correct there and IS the true
  // length even when it differs from Spotify metadata (e.g. yt-dlp/Soulseek edits).
  if (IS_WEBKIT && metaSec > 0 && deckOk) {
    const tracksPlayhead = dur <= (deck.currentTime || 0) + 1;
    const disagrees = Math.abs(dur - metaSec) > metaSec * 0.15;
    return (tracksPlayhead || disagrees) ? metaSec : dur;
  }
  if (deckOk) return dur;
  if (metaSec > 0) return metaSec;
  return null;
}

// ── Play Track ──
export function playTrack(item) {
  store.radioMode = false;
  store.playerQueue = [item];
  store.playerIndex = 0;
  resetSmartQueuePlayed();
  loadAndPlay();
}

// ── Add to Queue ──
export function addToQueue(items, playNow = false) {
  const startIdx = store.playerQueue.length;
  store.playerQueue = store.playerQueue.concat(items);
  if (playNow || store.playerIndex < 0) {
    store.playerIndex = startIdx;
    loadAndPlay();
  }
  renderQueue();
  saveQueueDebounced();
  showToast(`Added ${items.length} track${items.length > 1 ? 's' : ''} to playlist`);
  // Playlist mode: add tracks to Navidrome playlist (one batch call)
  if (store.playlistMode) {
    apiJson(`/api/library/playlist/${store.playlistMode.id}/add-and-download-batch`, {
      method: 'POST',
      // Queue mirror only — never download missing tracks just for queueing.
      body: { tracks: items.map(it => ({ name: it.name || '', artist: it.artist || '', album: it.album || '' })), download: false },
    }).then(data => {
      if (data.added) showToast(`${data.added} added → ${store.playlistMode.name}`);
    }).catch(() => {});
  }
  if (store.remoteTarget && !playNow && store.playerIndex >= 0) {
    document.dispatchEvent(new CustomEvent('remote:enqueue', { detail: items }));
  }
}

// ── Load and Play Current Track ──
// Thin guard: guarantees the advance latch is released on EVERY exit of the impl —
// including a synchronous throw — so an exception can never permanently wedge
// _advanceInFlight (which would silently block all future track advances).
export async function loadAndPlay() {
  try {
    return await _loadAndPlayImpl();
  } finally {
    _advanceInFlight = false;
  }
}

async function _loadAndPlayImpl() {
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) {
    return;
  }
  if (store.remoteTarget) { try { getAudio().currentTime = 0; } catch {} document.dispatchEvent(new Event('remote:play')); return; }
  // Symptom A (#4) — on advance, abort/evict only NOW-STALE prefetch entries (tracks no
  // longer near the new playerIndex) instead of aborting ALL downloads. Keep the track(s)
  // about to be needed (the new current track's blob if still downloading, plus the next
  // track and the bound prediction) flowing so the crossfade still gets a full blob and
  // the Next dot reaches green — without waiting for the late crossfade-complete resume.
  const _keep = new Set();
  const _kAdd = (it) => { if (it) _keep.add(prefetchKey(_decodeEntities(it.name || ''), _decodeEntities(it.artist || ''), it.id)); };
  _kAdd(store.playerQueue[store.playerIndex]);       // new current track (may still be downloading)
  _kAdd(store.playerQueue[store.playerIndex + 1]);   // sequential next — needed for next crossfade
  if (_predictedNextIdx != null && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length) {
    _kAdd(store.playerQueue[_predictedNextIdx]);      // Smart Queue predicted next
  }
  abortStale(_keep);
  _crossfadeTriggered = false;
  const endedBlend = _endedBlend; // Fix 4: consume the one-shot blend-on-ended request
  _endedBlend = false;
  // Stop any virtual rec playback — we're back in the real queue
  import('./recommendations.js').then(m => m.stopRecPlayback());
  _currentRecItem = null; // clear stale rec so "Add to playlist" targets the queue track
  const item = store.playerQueue[store.playerIndex];
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  const mode = store.deviceOutputMode || 'default';
  // DLNA Only mode: auto-connect to renderer on play
  if (mode === 'dlna_only' && !store.castDevice) {
    cast.autoCastAndPlay(item, cleanName, cleanArtist);
  // Cast mode: send to DLNA renderer (unless local-only)
  } else if (store.castDevice && mode !== 'local') {
    // If a local crossfade/playback is in progress, tear it down and silence BOTH
    // local decks first — otherwise they keep playing alongside the cast renderer
    // (double audio). _teardownCrossfade clears all fade timers/ramps/beat-sync.
    if (_crossfading || !_activeDeckEl().paused) {
      _teardownCrossfade();
      _deckA.pause();
      _deckB.pause();
      _fadingOutDeck = null;
      _crossfading = false;
    }
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    const castBody = {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    };
    apiJson('/api/dlna/cast', { method: 'POST', body: castBody })
      .then(() => { /* cast started */ })
      .catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    _ensureAudioContext();
    if (_ctx.state === 'suspended') _ctx.resume();
    const streamUrl = `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) })}&quality=${streamQuality()}`;

    const currentDeck = _activeDeckEl();
    // Fix 4: a track that ended WITHOUT firing the auto trigger leaves currentDeck paused
    // (ended → paused), which would normally take the cold-start hard-swap branch. Honor
    // _endedBlend to route through the crossfade branch instead so the next track eases in
    // with a (brief, since the outgoing already ended) blend rather than a silent cut.
    if ((!currentDeck.paused || endedBlend) && currentDeck.src) {
      // Crossfade: use cache if ready, brief wait if almost done, else stream
      let cached = getCachedUrl(cleanName, cleanArtist, item.id);
      if (!cached) { const w = await waitForCache(cleanName, cleanArtist, 2000, item.id); if (w) cached = w; }
      const src = cached || streamUrl;
      pausePrefetch();
      // Resolve the incoming track's DJ data SYNCHRONOUSLY from the cache so the beat
      // grid is available at fade time. _startCrossfade does _outDjData=_inDjData;
      // _inDjData=null synchronously, so an async fetchDjData().then() would not have
      // resolved yet → beat-sync silently disabled. Keep the async fetch as cache warmup.
      // M2: ALWAYS clear-then-set from the track being loaded so a stale _inDjData from a
      // previously-predicted (different) track can't survive and feed the PLL the wrong
      // beat grid (Android beat drift). The sync cache is the source of truth; the async
      // fetch is only a warmup for a cache miss (and only fills if still unset).
      _inDjData = getDjData(cleanName, cleanArtist) || null;
      if (!_inDjData) {
        fetchDjData(cleanName, cleanArtist).then(d => { if (!_inDjData) _inDjData = d; }).catch(() => {});
      }
      if (cached && IS_WEBKIT) {
        // Prefetch-HIGH (WebKit only): the incoming gain ramp must NOT start before the
        // deck can render, or the fade-in plays silence (large FLAC decode on WebKit).
        // Mirror the uncached structure: finalize any prior crossfade, load src on the
        // INACTIVE deck, play(), bounded wait for canplay (blobs resolve near-instantly),
        // THEN start the ramp. Android keeps its proven order in the branch below.
        if (_crossfading && _fadingOutDeck) {
          resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
          _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
          _teardownCrossfade(); _crossfading = false;
        }
        const nextDeck = _inactiveDeckEl();
        _setDeckSrc(nextDeck, src);
        nextDeck.play().catch(() => {});
        await _waitForCanPlay(nextDeck, 1500);
        _startCrossfade(true); // cached blob = seekable — also swaps _activeDeck
      } else if (cached) {
        // IMPORTANT: call _startCrossfade BEFORE setting src on the next deck.
        // _startCrossfade's rapid-skip handler clears _fadingOutDeck.src, and during
        // a rapid skip _fadingOutDeck IS the inactive deck we're about to load.
        // If we set src first, the rapid-skip handler would clear it, causing silence.
        const xfResult = _startCrossfade(true); // cached blob = seekable — also swaps _activeDeck
        const nextDeck = _activeDeckEl(); // after swap, the NEW active deck is the one to load
        _setDeckSrc(nextDeck, src);
        // _setDeckSrc() calls load(), which resets playbackRate to 1 — that clobbers the
        // glide rate scheduleDjTransitionV3 just set on this (silent, gain-0) deck. Reapply
        // it once here; the glide's own rAF loop (if tempo-matched) overwrites it again next
        // frame anyway, so this only matters for the instant between load() and that tick.
        // Guarded to a finite value: the bail-out/webkit case has inBase===1 (a no-op).
        if (Number.isFinite(xfResult?._tempoRamp?.inBase)) nextDeck.playbackRate = xfResult._tempoRamp.inBase;
        nextDeck.play().catch(() => {});
      } else {
        // Uncached live stream: load on the inactive deck and wait for it to buffer a
        // little BEFORE fading in, or the fade-in plays silence (readyState 0). Bounded
        // wait — proceed anyway on timeout so playback never stalls.
        // Finalize any prior crossfade FIRST: _startCrossfade's rapid-skip handler would
        // otherwise clear this inactive deck's src after we've loaded it (silence).
        if (_crossfading && _fadingOutDeck) {
          resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
          _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
          _teardownCrossfade(); _crossfading = false;
        }
        const nextDeck = _inactiveDeckEl();
        _setDeckSrc(nextDeck, src);
        nextDeck.play().catch(() => {});
        await _waitForCanPlay(nextDeck, 2500);
        _startCrossfade(false); // non-seekable live stream — also swaps _activeDeck
      }
      // Symptom A (#4) — the swap is done; resume prefetch PROMPTLY instead of waiting for
      // the crossfade-complete timer (~line 333). pausePrefetch() above freed bandwidth for
      // the incoming track's brief load; now re-issue the next track's prefetch so it's a
      // full blob before the NEXT crossfade. In Smart Queue, prefer the bound prediction
      // (same track the next crossfade will consume → no divergence); else sequential next.
      // ONLY on the cached-blob path: the incoming deck is fully loaded locally and needs
      // no network — safe to spin up concurrent downloads immediately. On the UNCACHED path
      // the incoming deck is still buffering from the stream; starting up to MAX_CONCURRENT=3
      // downloads concurrently would starve it → audible stutter during the fade. Leave
      // prefetch paused and rely on the existing crossfade-complete resume (~line 333).
      if (cached) {
        resumePrefetch();
        const _afterIdx = store.playerIndex;
        let _afterNext = null;
        if (_djSetting('smart_queue', 'off') !== 'off' && _predictedNextIdx != null
            && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length) {
          _afterNext = store.playerQueue[_predictedNextIdx];
        } else {
          _afterNext = store.playerQueue[_afterIdx + 1];
        }
        if (_afterNext) {
          prefetchTrack(_decodeEntities(_afterNext.name || ''), _decodeEntities(_afterNext.artist || ''), _afterNext.id);
        }
      }
    } else {
      // Cold start — play immediately, no cache wait
      if (_crossfading && _fadingOutDeck) {
        resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
        _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
        _teardownCrossfade(); _crossfading = false;
      }
      const deck = currentDeck;
      _setDeckSrc(deck, getCachedUrl(cleanName, cleanArtist, item.id) || streamUrl);
      deck.play().catch(() => {});
      if (_activeGain()) {
        const g = _activeGain().gain;
        // Start silent and fade in. CRITICAL for Safari/Mac: the AudioContext starts
        // suspended and resume() is async, so scheduling the ramp against the still-frozen
        // currentTime (0) makes it complete instantly on resume → an audible snap/stutter
        // at the start of every track. Schedule the ramp only once the clock is live.
        g.cancelScheduledValues(0);
        g.value = 0;
        const _rampIn = () => {
          const t0 = _ctx.currentTime;
          g.cancelScheduledValues(t0);
          g.setValueAtTime(0, t0);
          g.linearRampToValueAtTime(1, t0 + 0.05);
        };
        if (_ctx.state === 'suspended') _ctx.resume().then(_rampIn).catch(_rampIn);
        else _rampIn();
      }
      // DJ data for current track (needed for crossfade timing). Resolve SYNCHRONOUSLY
      // from the bpm cache first so the very first timeupdate trigger computes triggerAt
      // from the real beat-grid lead (~11-16s) instead of falling back to _crossfadeDur()
      // (~5s) → end-of-track hard cut. _preAnalyzeUpcoming/playing already warm the cache,
      // so this is usually a hit; the async fetchDjData below is the cache-miss fallback.
      _outDjData = getDjData(cleanName, cleanArtist) || null;
      if (!_outDjData) {
        // Same identity-guard as the `playing` refill: a cache-miss fetch for this track
        // can resolve AFTER an auto-advance and would otherwise bind a neighbour's data
        // (→ midpoint-cut). Only bind if still empty AND the active track is unchanged.
        const _want = _smartKey(item);
        fetchDjData(cleanName, cleanArtist).then(d => {
          const cur = store.playerQueue[store.playerIndex];
          if (d && !_outDjData && cur && _smartKey(cur) === _want) _outDjData = d;
          // Late level-match once data arrives (set plain value, never a ramp).
          if (_activeLevel()) _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
        }).catch(() => {});
      }
      // LUFS level-match on the active deck (attenuate-only, cap 1.0; 1.0 when absent).
      if (_activeLevel()) _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
      // Cleanup old blob URLs (safe — no crossfade in progress)
      prefetchCleanup(store.playerQueue, store.playerIndex);
    }
  }
  // Deck swap (or cast POST) issued. The advance latch is released by the loadAndPlay
  // wrapper's finally on every exit (success, early-return, throw) — see _loadAndPlayImpl.
  showPlayerBar();
  updatePlayPauseIcon(true);
  syncFullPlayer();
  updateDownloadButtons(item);
  renderQueue();
  saveQueueDebounced();
  updateMediaSession();
  resolveSource(item);
  updatePlaylistBadge();
}

function _decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

// Stable identity key for a queue item — MUST match djmix.js _trackKey so the
// predicted-next binding (C1) compares like-for-like across predict/commit.
function _smartKey(item) {
  return item.id != null
    ? String(item.id)
    : ((item.artist || '') + ':' + (item.name || '')).toLowerCase();
}

function resolveSource(item) {
  const badge = $('#playerSourceBadge');
  const fpBadge = $('#fpSourceBadge');
  if (badge) { badge.textContent = ''; badge.className = 'source-badge'; }
  if (fpBadge) { fpBadge.textContent = ''; fpBadge.className = 'source-badge'; }
  const params = new URLSearchParams({ name: _decodeEntities(item.name || ''), artist: _decodeEntities(item.artist || '') });
  apiJson(`/api/player/resolve-source?${params}`).then(data => {
    const src = data.source || 'youtube';
    const labels = { local: 'LOCAL', navidrome: 'FLAC', youtube: 'YT' };
    const label = labels[src] || src.toUpperCase();
    if (badge) { badge.textContent = label; badge.className = `source-badge source-${src}`; }
    if (fpBadge) { fpBadge.textContent = label; fpBadge.className = `source-badge source-${src}`; }
  }).catch(() => {});
}

function updateDownloadButtons(item) {
  const inLib = !!item.inLibrary;
  const miniBtn = $('#playerDownloadBtn');
  const fpBtn = $('#fpDownload');
  if (miniBtn) {
    miniBtn.disabled = inLib;
    miniBtn.style.opacity = inLib ? '0.3' : '';
    miniBtn.title = inLib ? 'Already in library' : 'Download current track';
  }
  if (fpBtn) {
    fpBtn.disabled = inLib;
    fpBtn.style.opacity = inLib ? '0.3' : '';
    fpBtn.title = inLib ? 'Already in library' : 'Download';
  }
}

export function updatePlaylistBadge() {
  const badge = $('#fpPlaylistBadge');
  if (badge) {
    if (store.playlistMode) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    else badge.style.display = 'none';
  }
  // Show/hide remove-from-playlist buttons
  const show = store.playlistMode ? '' : 'none';
  const rm1 = $('#playerRemoveFromPlaylist');
  const rm2 = $('#fpRemoveFromPlaylist');
  if (rm1) rm1.style.display = show;
  if (rm2) rm2.style.display = show;
}

export function showPlayerBar() {
  $('#playerBar').classList.add('active');
  document.body.classList.add('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = '';
  // Hide cast button in local-only mode
  const mode = store.deviceOutputMode || 'default';
  const castBtn = $('#playerCastBtn');
  const fpCastBtn = $('#fpCastBtn');
  if (mode === 'local') {
    if (castBtn) castBtn.style.display = 'none';
    if (fpCastBtn) fpCastBtn.style.display = 'none';
  } else {
    if (castBtn) castBtn.style.display = '';
    if (fpCastBtn) fpCastBtn.style.display = '';
  }
}

export function hidePlayerBar() {
  $('#playerBar').classList.remove('active');
  document.body.classList.remove('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = 'none';
  // Stop Android foreground service when player is hidden
  if (_ab()) _ab().onStop();
}


// ── Next / Prev ──
let _lastNextTime = 0;
export function nextTrack(opts = {}) {
  const reason = opts.reason || 'user';
  // In-flight latch: block a concurrent advance while a previous one is still resolving
  // its async loadAndPlay (deck swap not yet done). nextTrack→loadAndPlay is async and
  // timeupdate/ended keep firing, so without this a second advance fires mid-flight →
  // double advance / overlapping crossfades. Cleared inside loadAndPlay after the swap.
  if (_advanceInFlight) {
    // The advance was swallowed — another advance owns the in-flight slot, so NO advance
    // started here. The auto trigger sets _crossfadeTriggered=true BEFORE calling us; if we
    // leave it latched, a subsequent timeupdate tick can't retry while `remaining` is still
    // positive → the outgoing track reaches its real `ended` and hard-cuts. Re-arm the latch
    // ONLY on the swallowed auto path so the next tick can re-attempt the trigger. Safe from
    // double-advance: the existing _advanceInFlight guard still blocks the retry until the
    // current advance releases the slot (loadAndPlay's finally), by which point the new track
    // is active and `remaining` has reset, so the retry naturally no-ops.
    if (reason === 'auto') _crossfadeTriggered = false;
    // The ended-blend intent is moot — another advance already owns the transition.
    // Clear it so it can't linger and force a stray crossfade branch on a later load.
    if (reason === 'ended') _endedBlend = false;
    return;
  }
  // Throttle only rapid USER skips — never drop ended/auto/error advances (an auto
  // crossfade or ended event must always advance, or the track stalls/never transitions).
  const now = Date.now();
  if (reason === 'user') {
    if (now - _lastNextTime < 500) return;
    _lastNextTime = now;
  }
  _advanceInFlight = true; // set synchronously before any async hop

  // ── Record skip/accept for recommendation feedback (only on user-initiated skips) ──
  if (reason === 'user' || reason === 'ended') {
    try {
      const cur = store.playerQueue[store.playerIndex];
      if (cur && cur.name) {
        const deck = _activeDeckEl();
        const dur = deck && deck.duration ? deck.duration : 0;
        const pos = deck && deck.currentTime ? deck.currentTime : 0;
        const ratio = dur > 0 ? pos / dur : 0;
        import('./recommendations.js').then(m => {
          if (reason === 'ended') m.recordAccept(cur);
          else if (dur > 0 && ratio < 0.5 && pos < 30) m.recordSkip(cur);
          else if (ratio > 0.7) m.recordAccept(cur);
        });
      }
    } catch {}
  }

  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, advance to next rec (both local and cast)
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      // Rec advance does not go through loadAndPlay — release the latch here.
      _advanceInFlight = false;
      m.playNextRec().then(filled => {
        if (!filled) { _activeDeckEl().pause(); updatePlayPauseIcon(false); }
      });
      return;
    }
    _nextTrackInQueue();
  }).catch(() => {
    // M4: released the latch without any advance (loadAndPlay never ran). Re-arm the
    // auto-crossfade trigger or the current track would hard-cut at its end.
    _advanceInFlight = false;
    _crossfadeTriggered = false;
  });
}

function _nextTrackInQueue() {
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * store.playerQueue.length); } while (next === store.playerIndex);
    store.playerIndex = next;
    loadAndPlay();
  } else if (_djSetting('smart_queue', 'off') !== 'off' || store.playerIndex < store.playerQueue.length - 1) {
    // HIGH-1: enter smart mode regardless of position when smart_queue is on, so the LAST
    // index isn't a dead-end (pickSmartNext has a whole-queue/backward fallback to unplayed
    // earlier tracks). When smart is off this guard reduces to the original forward check.
    // Smart Queue: pick best next track by BPM/key instead of sequential
    const smartMode = _djSetting('smart_queue', 'off');
    // Try cache if _outDjData wasn't set yet (async fetch didn't complete)
    if (smartMode !== 'off' && !_outDjData) {
      const cur = store.playerQueue[store.playerIndex];
      if (cur) {
        _outDjData = getDjData(_decodeEntities(cur.name || ''), _decodeEntities(cur.artist || ''));
      }
    }
    if (smartMode !== 'off' && _outDjData) {
      // Reuse the index _preAnalyzeUpcoming predicted+prefetched if it's still valid
      // (in range, not already played, same track) — avoids re-running pickSmartNext at
      // commit and picking a DIFFERENT track than the one we prefetched (non-gapless).
      let smartIdx = null;
      const prevPredictedIdx = _predictedNextIdx; // capture before consume (Fix 3 comparison)
      if (_predictedNextIdx != null
          && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length
          && _predictedNextIdx !== store.playerIndex) {
        const cand = store.playerQueue[_predictedNextIdx];
        if (cand && _smartKey(cand) === _predictedNextKey) smartIdx = _predictedNextIdx;
      }
      if (smartIdx == null) {
        // Prediction rejected → recompute. Any _inDjData warmed for the predicted (now
        // discarded) track is stale; clear it so loadAndPlay's fresh sync resolve from the
        // ACTUALLY-chosen track is the sole source of truth (M2 — prevents beat drift).
        _inDjData = null;
        smartIdx = pickSmartNext(store.playerQueue, store.playerIndex, _outDjData, smartMode, store.repeatMode === 'all');
      }
      const wasPredicted = (smartIdx === prevPredictedIdx);
      _predictedNextIdx = null; _predictedNextKey = null; // consume the prediction
      if (smartIdx != null) {
        // Fix 3: when pickSmartNext recomputed a DIFFERENT index than the one
        // _preAnalyzeUpcoming prefetched, warm the COMMITTED track's cache now so
        // loadAndPlay's crossfade takes the fast cached branch instead of the slow
        // uncached _waitForCanPlay path (during which the outgoing track ends → hard cut).
        if (!wasPredicted) {
          const committed = store.playerQueue[smartIdx];
          if (committed) {
            resumePrefetch(); // ensure prefetch isn't paused in smart mode
            prefetchTrack(_decodeEntities(committed.name || ''), _decodeEntities(committed.artist || ''), committed.id);
          }
        }
        markPlayed(store.playerQueue[store.playerIndex]); // pickSmartNext is side-effect-free; mark outgoing item on real advance
        store.playerIndex = smartIdx;
        loadAndPlay();
        return;
      }
    }
    // Smart returned null (or smart is off). If a forward track exists, advance
    // sequentially as before. Otherwise (last index) fall through to the same
    // repeat-all / radio / rec terminal handling the non-smart path uses.
    if (store.playerIndex < store.playerQueue.length - 1) {
      // M(#12): in smart mode, mark the outgoing track played even on the SEQUENTIAL
      // fallback (pickSmartNext returned null) — otherwise the energy-arc clock stalls
      // and an already-heard track can be re-selected later. Don't mark when smart is off.
      if (smartMode !== 'off') markPlayed(store.playerQueue[store.playerIndex]);
      store.playerIndex++;
      loadAndPlay();
      return;
    }
    _nextTrackTerminal();
  } else {
    _nextTrackTerminal();
  }
}

// Terminal advance handling when no forward/smart in-queue track is available:
// repeat-all wrap, radio auto-fill, or virtual recommendations. Extracted so both the
// non-smart last-index path and the smart-returned-null last-index path share it.
function _nextTrackTerminal() {
  if (store.repeatMode === 'all') {
    store.playerIndex = 0;
    loadAndPlay();
  } else if (store.radioMode && !store.radioLoading) {
    // Auto-fill queue with more radio tracks
    store.radioLoading = true;
    const seed = store.playerQueue[store.playerQueue.length - 1] || store.radioSeedTrack;
    if (seed) {
      showToast('Loading more similar tracks...');
      const params = new URLSearchParams({ track: seed.name || '', artist: seed.artist || '', artist_id: seed.id || store.currentArtistId || '' });
      apiJson(`/api/radio?${params}`).then(data => {
        const newTracks = (data.tracks || []).filter(t => {
          const key = (t.name || '').toLowerCase() + '|' + (t.artist || '').toLowerCase();
          return !store.playerQueue.some(q => (q.name || '').toLowerCase() + '|' + (q.artist || '').toLowerCase() === key);
        });
        if (newTracks.length) {
          store.playerQueue = store.playerQueue.concat(newTracks);
          store.playerIndex++;
          loadAndPlay();
          renderQueue();
          saveQueueDebounced();
          // Mirror auto-fill tracks into Radio playlist when active
          import('./upnext.js').then(u => u.mirrorAdd(newTracks));
        } else {
          showToast('No more similar tracks found');
          _activeDeckEl().pause();
          updatePlayPauseIcon(false);
          _advanceInFlight = false; // terminal, no loadAndPlay — release latch
          _crossfadeTriggered = false; // M4: no advance occurred — re-arm trigger
        }
      }).catch(() => {
        showToast('Failed to load more tracks');
        _activeDeckEl().pause();
        updatePlayPauseIcon(false);
        _advanceInFlight = false; // terminal, no loadAndPlay — release latch
        _crossfadeTriggered = false; // M4: no advance occurred — re-arm trigger
      }).finally(() => { store.radioLoading = false; });
    } else {
      _advanceInFlight = false; // no seed to fetch radio from — release latch
      _crossfadeTriggered = false; // M4: no advance occurred — re-arm trigger
    }
  } else {
    // Queue ended — continue with virtual recommendations
    _advanceInFlight = false; // rec advance does not go through loadAndPlay
    import('./recommendations.js').then(m => {
      m.playNextRec().then(filled => {
        if (!filled) {
          _activeDeckEl().pause();
          updatePlayPauseIcon(false);
        }
      });
    });
  }
}

// ── Play a track from recommendations (virtual, not in queue) ──
let _currentRecItem = null;
export async function playRecTrack(item) {
  if (store.remoteTarget) {
    store.playerQueue = store.playerQueue.concat([item]);
    store.playerIndex = store.playerQueue.length - 1;
    try { getAudio().currentTime = 0; } catch {}
    document.dispatchEvent(new Event('remote:play'));
    return;
  }
  _currentRecItem = item;
  _crossfadeTriggered = false; // fresh track — re-arm the auto-crossfade trigger
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const fpFill = $('#fpProgressFill');
  if (fpFill) fpFill.style.width = '0%';
  const fpCur = $('#fpTimeCurrent');
  if (fpCur) fpCur.textContent = '0:00';
  const fpTot = $('#fpTimeTotal');
  if (fpTot) fpTot.textContent = '0:00';
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  // Cast mode: send to DLNA renderer
  if (store.castDevice) {
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }}).catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    _ensureAudioContext();
    if (_ctx.state === 'suspended') _ctx.resume();
    const streamUrl = `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) })}&quality=${streamQuality()}`;
    const cached = getCachedUrl(cleanName, cleanArtist, item.id);
    const src = cached || streamUrl;
    const curDeck = _activeDeckEl();
    if (!curDeck.paused && curDeck.src && cached) {
      pausePrefetch();
      _inDjData = null; // rec track has no analyzed DJ data — fall back to fixed-duration timing
      _startCrossfade();
      const nextDeck = _activeDeckEl(); // after swap
      _setDeckSrc(nextDeck, src);
      nextDeck.play().catch(() => {});
    } else {
      if (_crossfading && _fadingOutDeck) {
        resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
        _fadingOutDeck.pause(); _fadingOutDeck.src = ''; _fadingOutDeck = null;
        _teardownCrossfade(); _crossfading = false;
      }
      _setDeckSrc(curDeck, src);
      curDeck.play().catch(() => {});
      if (_activeGain()) {
        _activeGain().gain.cancelScheduledValues(0);
        _activeGain().gain.value = 1;
      }
      // Rec track has no analyzed LUFS → reset level-match to unity (no carryover).
      if (_activeLevel()) _activeLevel().gain.value = 1;
    }
  }
  showPlayerBar();
  updatePlayPauseIcon(true);
  // Sync full player directly
  const fpImg = $('#fpImg');
  if (fpImg) fpImg.src = item.image || '';
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = item.name || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = item.artist || '';
  updateDownloadButtons(item);
  updateMediaSessionWith(item);
  resolveSource(item);
}

function updateMediaSessionWith(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _activeDeckEl().play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _activeDeckEl().pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

export function prevTrack() {
  // #13: respect the single-flight advance latch. Without this, pressing Previous during
  // an in-flight auto-advance runs a concurrent loadAndPlay() and clears the latch out
  // from under nextTrack → overlapping crossfades. Claim it synchronously at entry; it is
  // released by loadAndPlay's finally on paths that load, and explicitly here otherwise.
  if (_advanceInFlight) return;
  _advanceInFlight = true;
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, go to previous rec or back to queue
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      const went = m.playPrevRec();
      if (!went && store.playerIndex >= 0) {
        // Back to last track in queue — loadAndPlay's finally releases the latch.
        loadAndPlay();
      } else {
        // playPrevRec advanced without loadAndPlay (or nothing to do) — release the latch.
        _advanceInFlight = false;
      }
      return;
    }
    // Normal queue navigation
    if (!store.castDevice && _activeDeckEl().currentTime > 3) {
      _activeDeckEl().currentTime = 0;
      _advanceInFlight = false; // seek-to-start, no loadAndPlay — release latch
    } else if (store.playerIndex > 0) {
      store.playerIndex--;
      loadAndPlay(); // finally releases the latch
    } else {
      _advanceInFlight = false; // at first track, nothing advanced — release latch
    }
  }).catch(() => {
    // Import failed — loadAndPlay never ran; release the latch so future advances aren't wedged.
    _advanceInFlight = false;
  });
}

// ── Play/Pause Icon ──
export function updatePlayPauseIcon(playing) {
  store.playerPlaying = playing;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  $('#playPauseIcon').innerHTML = playing ? pausePath : playPath;
  const fpIcon = $('#fpPlayPauseIcon');
  if (fpIcon) fpIcon.innerHTML = playing ? pausePath : playPath;
}

export function pauseLocal() { try { _deckA.pause(); _deckB.pause(); } catch {} updatePlayPauseIcon(false); }

// ── Resolve Item Tracks (album/artist → track list) ──
// Album/artist ids are provider-scoped; the backend otherwise assumes the
// configured provider, which is wrong for items the search fallback served.
const _provQs = (p) => (p ? `?provider=${encodeURIComponent(p)}` : '');

export async function resolveItemTracks(item) {
  const type = item.type || 'track';
  if (type === 'album' && item.id) {
    const data = await apiJson(`/api/album/${item.id}/tracks${_provQs(item.provider)}`);
    return (data.tracks || []).map(t => ({ ...t, type: 'track' }));
  }
  if (type === 'artist' && item.id) {
    const data = await apiJson(`/api/artist/${item.id}/albums${_provQs(item.provider)}`);
    const albums = data.albums || [];
    const allTracks = [];
    for (const album of albums.slice(0, 10)) {
      try {
        // Albums from that response aren't stamped — inherit the artist's.
        const ad = await apiJson(`/api/album/${album.id}/tracks${_provQs(album.provider || item.provider)}`);
        (ad.tracks || []).forEach(t => allTracks.push({ ...t, type: 'track' }));
      } catch {}
    }
    return allTracks;
  }
  return [item];
}

// ── Queue Persistence ──
export function saveQueueDebounced() {
  clearTimeout(store.playerSaveTimer);
  store.playerSaveTimer = setTimeout(saveQueueNow, 2000);
  // Trigger recommendations refresh
  import('./recommendations.js').then(m => m.onQueueChanged());
}

async function saveQueueNow() {
  if (!store.currentUser) return;
  try {
    return await apiJson('/api/player/queue', {
      method: 'PUT',
      body: {
        queue: store.playerQueue,
        current_index: store.playerIndex,
        position_seconds: _activeDeckEl().currentTime || 0,
        volume: store.playerVolume,
        playlist_mode: store.playlistMode,
      },
    });
  } catch {}
}

// Synchronous (awaitable) flush of the pending queue save — cancels the debounce
// timer and performs the PUT immediately. Used before engine-switch reloads so
// recent queue/position changes are persisted to the server before unload.
export async function flushQueue() {
  clearTimeout(store.playerSaveTimer);
  return saveQueueNow();
}

export async function loadQueueState() {
  try {
    const data = await apiJson('/api/player/queue');
    if (data.queue && data.queue.length) {
      store.playerQueue = data.queue;
      store.playerIndex = data.current_index >= 0 ? data.current_index : 0;
      store.playerVolume = data.volume ?? 1.0;
      _deckA.volume = store.playerVolume;
      _deckB.volume = store.playerVolume;
      $('#playerVolume').value = Math.round(store.playerVolume * 100);
      const item = store.playerQueue[store.playerIndex];
      if (item) {
        $('#playerImg').src = item.image || '';
        $('#playerTitle').textContent = item.name || '';
        $('#playerArtist').textContent = item.artist || '';
        const deck = _activeDeckEl();
        const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: (store.streamToken || store.authToken) });
        const restoreSrc = `/api/player/stream?${params}&quality=${streamQuality()}`;
        if (deck === _deckA) _expectedSrcA = restoreSrc;
        else _expectedSrcB = restoreSrc;
        deck.src = restoreSrc;
        deck.preload = 'none';
        if (data.position_seconds > 0) {
          deck.addEventListener('loadedmetadata', () => { deck.currentTime = data.position_seconds; }, { once: true });
        }
        syncFullPlayer();
        updateDownloadButtons(item);
        showPlayerBar();
      }
      // Restore playlist mode
      if (data.playlist_mode) {
        store.playlistMode = data.playlist_mode;
        updatePlaylistBadge();
      }
      import('./queue.js').then(m => m.updateSaveButton());
    }
  } catch {}
}

// ── Media Session API ──
function updateMediaSession() {
  if (!('mediaSession' in navigator) || store.playerIndex < 0) return;
  const item = store.playerQueue[store.playerIndex];
  if (!item) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _activeDeckEl().play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _activeDeckEl().pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

// ── Audio Element Reference (exported for other modules) ──
// Export deckA as `audio` for backward compat — other modules use it for
// paused state checks and currentTime. During crossfade both decks play
// but UI modules only need the active one.
export { _deckA as audio };

// ── Init ──
export function init() {
  // Audio events
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('play', () => {
      if (deck !== _activeDeckEl() && !_crossfading) return;
      updatePlayPauseIcon(true);
      if (_ab()) {
        const item = store.playerQueue[store.playerIndex];
        if (item) _ab().onPlay(item.name || '', item.artist || '');
      }
    });
    deck.addEventListener('playing', () => {
      if (deck !== _activeDeckEl()) return;
      // Fetch DJ data for current track (lightweight API call, doesn't compete)
      if (!_outDjData) {
        const item = store.playerQueue[store.playerIndex];
        if (item) {
          // Identity-guard the async write: a fetch started for track N can resolve AFTER
          // an auto-advance to N+1 and would otherwise overwrite _outDjData with a NEIGHBOUR
          // track's grid/outro_start → the auto-crossfade trigger then fires off the wrong
          // track's data (floor at 0.5·dur → tracks cut at their midpoint, accumulating over
          // a session). Only bind if nothing is bound AND the active track is still the one
          // we fetched for. Mirrors the _analyzeGen/identity discipline used elsewhere.
          const want = _smartKey(item);
          fetchDjData(_decodeEntities(item.name || ''), _decodeEntities(item.artist || ''))
            .then(d => {
              const cur = store.playerQueue[store.playerIndex];
              if (d && !_outDjData && cur && _smartKey(cur) === want) _outDjData = d;
            }).catch(() => {});
        }
      }
      // Symptom A — kick off the next-track prefetch IMMEDIATELY, NOT gated behind
      // _waitForBuffer or the BPM pre-analysis. The crossfade needs a fully-downloaded
      // blob; starting now makes the Next dot green in time.
      resumePrefetch(); // clear _paused so prefetchTrack isn't a no-op
      const sm = _djSetting('smart_queue', 'off');
      let immediate = null;
      if (sm !== 'off' && _predictedNextIdx != null
          && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length) {
        // Prediction already bound (e.g. a previous playing event or pre-analysis already
        // ran) — reuse it: same track dot/crossfade/prefetch all target → no divergence.
        immediate = store.playerQueue[_predictedNextIdx];
      } else if (sm !== 'off' && !store.shuffleEnabled) {
        // FIX 2: _predictedNextIdx is null because it was consumed at the prior advance
        // (nulled before loadAndPlay). In smart mode the DJ data for the current track is
        // usually already cached from the prior _preAnalyzeUpcoming run; if so, compute the
        // prediction NOW (sync, fast) and bind _predictedNextIdx immediately — the same
        // one dot/crossfade/_preAnalyzeUpcoming all reuse → prediction==prefetch==commit.
        // If _outDjData isn't cached yet, fall through to sequential for the early kickoff;
        // _preAnalyzeUpcoming (in _waitForBuffer callback) will bind + prefetch the real
        // prediction once data is available. That path is unchanged/no regression.
        const curItem = store.playerQueue[store.playerIndex];
        const cachedDj = curItem
          ? getDjData(_decodeEntities(curItem.name || ''), _decodeEntities(curItem.artist || ''))
          : null;
        if (cachedDj) {
          // Sync path: DJ data is in the bpm cache — pick immediately, no await.
          const earlyIdx = pickSmartNext(store.playerQueue, store.playerIndex, cachedDj, sm, store.repeatMode === 'all');
          if (earlyIdx != null) {
            const earlyItem = store.playerQueue[earlyIdx];
            _predictedNextIdx = earlyIdx;
            _predictedNextKey = _smartKey(earlyItem);
            // _inDjData will be resolved (sync or async) by _preAnalyzeUpcoming as usual.
            immediate = earlyItem;
          }
        }
        if (!immediate) immediate = store.playerQueue[store.playerIndex + 1]; // DJ data miss → sequential fallback
      } else {
        immediate = store.playerQueue[store.playerIndex + 1];
      }
      if (immediate) {
        prefetchTrack(_decodeEntities(immediate.name || ''), _decodeEntities(immediate.artist || ''), immediate.id);
      }
      // BPM pre-analysis (bulk warming + smart prediction refinement if not yet bound) run
      // in the BACKGROUND after buffering so they don't steal bandwidth from the current
      // track's initial network fill. The prefetch above is already in flight.
      _waitForBuffer(deck).then(() => {
        if (deck !== _activeDeckEl() || deck.paused) return;
        _preAnalyzeUpcoming();
      });
    });
    deck.addEventListener('pause', () => {
      if (deck !== _activeDeckEl()) return;
      updatePlayPauseIcon(false);
      pausePrefetch();
      if (_ab()) _ab().onPause();
    });
  });
  // Both decks need ended/error handlers
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('ended', () => {
      // Existing double-advance guard: an in-progress crossfade (_crossfading) or an
      // already-fired auto trigger (_crossfadeTriggered) is ALREADY handling the advance —
      // don't fire a second one. _advanceInFlight is covered by nextTrack's own latch.
      if (deck !== _activeDeckEl() || _crossfading || _crossfadeTriggered || !deck.src) return;
      if (store.repeatMode === 'one') {
        deck.currentTime = 0;
        deck.play().catch(() => {});
      } else {
        // Fix 4 safety net: this `ended` slipped through WITHOUT the auto crossfade having
        // fired (the trigger missed — e.g. _outDjData was null at the trigger window, or the
        // advance was swallowed). A bare nextTrack here would hard-cut. Request a blend so the
        // next track eases in instead of a silent cut. Only when a real next track can be
        // produced and we're not casting (cast has its own advance path).
        const hasNext = store.playerIndex < store.playerQueue.length - 1
          || store.repeatMode === 'all'
          || store.radioMode
          || _djSetting('smart_queue', 'off') !== 'off';
        if (hasNext && !store.castDevice) _endedBlend = true;
        nextTrack({ reason: 'ended' });
      }
    });
    deck.addEventListener('error', () => {
      if (!_isExpectedSrc(deck)) return; // ignore deferred errors from previous sources
      if (deck !== _activeDeckEl() && !_crossfading) return;
      if (_advanceInFlight) return; // an advance is already resolving — don't double-fire
      // #14: a benign error on the FADING-OUT (outgoing) deck must NOT abort the
      // transition or skip the good incoming track. The incoming deck is now the
      // active deck (_startCrossfade swapped it), so let it keep playing — just stop
      // and reset the erroring outgoing deck. Only the active/incoming deck erroring
      // is a real failure that warrants teardown + skip.
      if (_crossfading && deck === _fadingOutDeck && deck !== _activeDeckEl()) {
        deck.pause(); deck.src = '';
        resetDeckAfterTransitionV3(_deckDesc(deck));
        return; // incoming (active) deck continues the crossfade
      }
      if (_crossfading) {
        // Error on incoming (active) deck during crossfade — abort crossfade, skip track.
        // Use _teardownCrossfade() so the tempo ramp (_cancelTempoRamp) is cancelled too;
        // the old inline cleanup left the rAF tempo ramp writing playbackRate on the deck
        // error-recovery reuses → tempo drift/glitch (the bug _teardownCrossfade prevents).
        if (_fadingOutDeck) {
          _fadingOutDeck.pause(); _fadingOutDeck.src = '';
          resetDeckAfterTransitionV3(_deckDesc(_fadingOutDeck));
          _fadingOutDeck = null;
        }
        _teardownCrossfade();
        _crossfading = false;
      }
      _advanceInFlight = true; // claim the advance synchronously before the deferred skip
      showToast('Stream error, skipping...');
      setTimeout(() => { _advanceInFlight = false; nextTrack({ reason: 'error' }); }, 1000);
    });
  });

  // Timeupdate on both decks, but only UI-update from active deck
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('timeupdate', () => {
      if (deck !== _activeDeckEl()) return;
      const dur = _getDuration();
      if (!dur) return;
      const pct = (deck.currentTime / dur) * 100;
      $('#playerProgressFill').style.width = pct + '%';
      $('#playerTimeCurrent').textContent = fmtTime(deck.currentTime);
      $('#playerTimeTotal').textContent = fmtTime(dur);
      document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
      const fpFill = $('#fpProgressFill');
      if (fpFill) fpFill.style.width = pct + '%';
      const fpCur = $('#fpTimeCurrent');
      if (fpCur) fpCur.textContent = fmtTime(deck.currentTime);
      const fpTot = $('#fpTimeTotal');
      if (fpTot) fpTot.textContent = fmtTime(dur);
      // Update prefetch status indicator (~2/sec)
      if (!window._pfLastUpdate || Date.now() - window._pfLastUpdate > 500) {
        window._pfLastUpdate = Date.now();
        const curItem = store.playerQueue[store.playerIndex];
        // Next: in Smart Queue the PREFETCHED track is the predicted index, NOT the
        // sequential successor. Query the track we actually prefetched so the dot reflects
        // reality (else the lookup misses → dot never green). Fall back to playerIndex+1.
        let nextItem;
        if (_djSetting('smart_queue', 'off') !== 'off'
            && _predictedNextIdx != null
            && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length) {
          nextItem = store.playerQueue[_predictedNextIdx];
        } else {
          nextItem = store.playerQueue[store.playerIndex + 1];
        }
        // Now: green when the current track is actually playing/ready — i.e. the active
        // deck has HAVE_FUTURE_DATA and isn't errored — OR it's a cached blob OR prefetch
        // still reports 'ready'. A live-streamed (or already-consumed-blob) current track
        // would otherwise never show green even while audibly playing.
        const nowCached = deck.src && deck.src.startsWith('blob:');
        const nowSt = curItem ? getPrefetchStatus(_decodeEntities(curItem.name || ''), _decodeEntities(curItem.artist || ''), curItem.id) : null;
        const nowPlaying = deck.readyState >= 3 && !deck.error;
        const nowReady = nowPlaying || nowCached || (nowSt && nowSt.state === 'ready');
        // Next: prefetch progress
        const nextSt = nextItem ? getPrefetchStatus(_decodeEntities(nextItem.name || ''), _decodeEntities(nextItem.artist || ''), nextItem.id) : null;
        const nextPct = nextSt ? nextSt.progress : -1;
        let html = '';
        // Source badge for the CURRENT track: is the active deck playing from device
        // memory (a cached blob: URL, link-safe) or the live /api/player/stream URL
        // (at-risk on a flaky venue link)? Lets the DJ SEE the source at a glance.
        const deckEl = _activeDeckEl();
        const fromDevice = !!(deckEl && deckEl.src && deckEl.src.startsWith('blob:'));
        html += fromDevice
          ? `<span class="src-badge device" title="Playing from device memory">📥 Device</span>`
          : `<span class="src-badge live" title="Playing from live stream">☁ MP3</span>`;
        // Now dot
        html += `<span class="prefetch-dot ${nowReady ? 'ready' : 'loading'}" title="Now"></span>`;
        // Next dot + progress
        if (nextItem) {
          html += `<span class="prefetch-dot ${nextPct >= 100 ? 'ready' : nextPct >= 0 ? 'loading' : ''}" title="Next"></span>`;
          if (nextPct >= 0 && nextPct < 100) html += `${nextPct}%`;
        }
        for (const id of ['prefetchStatus', 'fpPrefetchStatus']) {
          const el = $(`#${id}`);
          if (el) el.innerHTML = html;
        }
      }
      if (_ab() && Math.abs(deck.currentTime - (_lastAbUpdate || 0)) >= 1) {
        _lastAbUpdate = deck.currentTime;
        _ab().onProgress(Math.floor(deck.currentTime * 1000), Math.floor(dur * 1000));
      }
      // ── Auto-crossfade: trigger nextTrack when approaching end ──
      // Wait for DJ data before calculating trigger (avoids a premature fallback crossfade)
      if (!_outDjData && deck.currentTime < dur - _crossfadeDur() - 5) {
        // DJ data not loaded yet and we're far from end — skip the check this tick
      } else {
        // Outro skip: use detected outro_start or manual setting as effective end.
        // Default is '0' (OFF, 2026-07): with 'auto' every ~7th library track lost
        // 5-13s of its ending (outro_start trims up to 15% via the 0.85 gate) and
        // the blend started 15-22s before the real end — heard as "the transition
        // happens before the song is over". Auto outro skip is now strictly opt-in.
        let effectiveEnd = dur;
        const outroSkip = _djSetting('outro_skip', '0');
        if (outroSkip === 'auto' && _outDjData && _outDjData.outro_start
            && _outDjData.outro_start > dur * 0.85
            && _outDjData.outro_start < dur) { // must be deep in the last ~15% of THIS track
          // Conservative guard: the backend outro heuristic can false-positive on a
          // beat-detection dropout in the last minute. The 0.85 gate ensures outro_start
          // is already deep enough that auto outro-skip can shave at most ~15% off the end.
          effectiveEnd = _outDjData.outro_start;
        } else if (outroSkip !== '0' && outroSkip !== 'auto') {
          effectiveEnd = dur - (parseInt(outroSkip) || 0);
        }

        const remaining = effectiveEnd - deck.currentTime;
        // Calculate trigger point: use beat grid or fallback to fixed duration
        let triggerAt = _crossfadeDur();
        if (IS_WEBKIT) {
          // WebKit runs the simple crossfade whose length == webkitCrossfadeDuration.
          // Lead time MUST equal that fade length, or the fade overruns/undershoots the
          // track boundary (the beat-grid lead of ~11s but ≤10s fade caused a gap).
          const numBeats = parseInt(_djSetting('crossfade_beats', '16')) || 16;
          triggerAt = webkitCrossfadeDuration(_outDjData?.bpm, numBeats);
          // #36: mirror the beat-grid clamp — on short tracks a long beat-derived fade
          // would trigger too early. Never trigger earlier than 25% from end, max 30s.
          if (triggerAt > dur * 0.25 || triggerAt > 30) triggerAt = _crossfadeDur();
        } else if (_outDjData && _outDjData.beat_grid && _outDjData.bpm) {
          const numBeats = parseInt(_djSetting('crossfade_beats', '16')) || 16;
          // Prefer bar/phrase-aligned start when downbeat data exists so the fade STARTS
          // on a bar boundary; fall back to the beat grid (identical to today) otherwise.
          let startBeat = null;
          if (_outDjData.downbeats && _outDjData.downbeats.length > 0) {
            const numBars = Math.max(1, Math.round(numBeats / 4));
            startBeat = findCrossfadeStartDownbeat(_outDjData.downbeats, effectiveEnd, numBars);
          }
          if (startBeat == null) {
            startBeat = findCrossfadeStartBeat(_outDjData.beat_grid, effectiveEnd, numBeats);
          }
          triggerAt = effectiveEnd - startBeat;
          // Clamp: never trigger earlier than 25% from end, max 30s
          if (triggerAt > dur * 0.25 || triggerAt > 30) triggerAt = _crossfadeDur();
        }
        if (remaining <= triggerAt && remaining > -5 && !_crossfadeTriggered
            && !_advanceInFlight && store.repeatMode !== 'one' && !store.castDevice
            && deck.currentTime > 10) { // don't trigger in first 10s
          const hasNext = store.playerIndex < store.playerQueue.length - 1 || store.repeatMode === 'all'
            || _djSetting('smart_queue', 'off') !== 'off'; // smart mode can pick an unplayed earlier track
          if (hasNext) {
            if (localStorage.getItem('ms_dj_debug') === '1') {
              const _cur = store.playerQueue[store.playerIndex];
              const _gridUsed = !IS_WEBKIT && !!(_outDjData && _outDjData.beat_grid && _outDjData.bpm);
              const _msg = `[DJ auto] ratio=${(deck.currentTime / dur).toFixed(3)} ct=${deck.currentTime.toFixed(1)} dur=${dur.toFixed(1)} effEnd=${effectiveEnd.toFixed(1)} triggerAt=${triggerAt.toFixed(1)} rem=${remaining.toFixed(1)} grid=${_gridUsed ? 'beat' : 'fallback'} play=${_cur ? _smartKey(_cur) : '?'} outBpm=${_outDjData?.bpm ?? 'null'} outroStart=${_outDjData?.outro_start ?? 'null'}`;
              console.log(_msg);
              window._djLastTrigger = _msg;
            }
            _crossfadeTriggered = true;
            nextTrack({ reason: 'auto' });
          }
        }
        if (remaining > triggerAt + 1) {
          _crossfadeTriggered = false;
        }
      }
    });
  });
  // (error handlers registered in the deck loop above)

  // Controls
  $('#playerPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
      else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
    } else {
      _ensureAudioContext();
      if (_ctx.state === 'suspended') _ctx.resume();
      const deck = _activeDeckEl();
      if (deck.paused) {
        deck.play().catch(() => {});
      } else if (_crossfading) {
        // Finalize the fade to a clean single deck, then pause it (avoids timers/ramps
        // running in wall-clock while paused → wrong gain/rate on resume).
        _finalizeCrossfadeOnPause().pause();
      } else {
        deck.pause();
      }
    }
  });
  $('#playerNext').addEventListener('click', nextTrack);
  $('#playerPrev').addEventListener('click', prevTrack);
  $('#playerVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      _deckA.volume = store.playerVolume;
      _deckB.volume = store.playerVolume;
    }
  });
  async function _seekFromEvent(bar, e) {
    const dur = _getDuration();
    if (!dur) return;
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      try { _activeDeckEl().currentTime = pct * dur; } catch {}
    }
  }
  const miniBar = $('#playerProgressBar');
  miniBar.addEventListener('click', (e) => _seekFromEvent(miniBar, e));
  miniBar.addEventListener('touchstart', (e) => { e.preventDefault(); _seekFromEvent(miniBar, e); }, { passive: false });

  // Add to playlist
  async function _addToPlaylist() {
    // Prefer the currently displayed track (recommended item if rec is playing)
    const item = (typeof _currentRecItem !== 'undefined' && _currentRecItem)
      ? _currentRecItem
      : (store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null);
    if (!item) return;
    try {
      const data = await apiJson('/api/library/playlists');
      // No early bail on an empty list — the picker's "+ New playlist" row lets
      // a user with zero playlists create one right here.
      const playlists = data.playlists || [];
      const { showPlaylistPicker } = await import('./utils.js');
      const picked = await showPlaylistPicker(playlists, { multi: false });
      if (!picked) return;
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${picked.id}/add-and-download`, {
        method: 'POST',
        body: { name: cleanName, artist: cleanArtist, album: item.album || '' },
      });
      showToast(`Added to ${picked.name}`);
      // If adding to the currently playing playlist, append to local queue too
      if (store.playlistMode && store.playlistMode.id === picked.id) {
        const key = (cleanName + '|' + cleanArtist).toLowerCase();
        const exists = store.playerQueue.some(t =>
          (_decodeEntities(t.name || '').toLowerCase() + '|' + _decodeEntities(t.artist || '').toLowerCase()) === key);
        if (!exists) {
          store.playerQueue.push({ ...item, name: cleanName, artist: cleanArtist });
          renderQueue();
          saveQueueDebounced();
        }
      }
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerAddToPlaylist').addEventListener('click', _addToPlaylist);
  if ($('#fpAddToPlaylist')) $('#fpAddToPlaylist').addEventListener('click', _addToPlaylist);

  // Remove from current playlist
  async function _removeFromPlaylist() {
    const item = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
    if (!item || !store.playlistMode) return;
    try {
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
        method: 'POST',
        body: { name: cleanName, artist: cleanArtist },
      });
      showToast(`Removed from ${store.playlistMode.name}`);
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);
  if ($('#fpRemoveFromPlaylist')) $('#fpRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);

  // Download current track
  $('#playerDownloadBtn').addEventListener('click', async () => {
    const item = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
    if (!item) return;
    const btn = $('#playerDownloadBtn');
    btn.style.color = 'var(--accent)';
    try {
      await apiJson('/api/download', { method: 'POST', body: {
        url: item.url || '', title: `${item.artist || ''} - ${item.name || ''}`,
        method: store.appSettings.default_method || 'yt-dlp', format: store.appSettings.default_format || 'flac',
        type: item.type || 'track',
      }});
      showToast('Download started');
    } catch (e) { showToast('Download failed: ' + e.message); }
    finally { setTimeout(() => { btn.style.color = ''; }, 1000); }
  });

  // ── Cast (DLNA) — shared module (cast.js) ──
  cast.initCast({ getAudioEl: getAudio, nextTrack });
  cast.wireControls();

  // Play button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-play-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    const tracks = await resolveItemTracks(item);
    if (tracks.length) {
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    }
  });

  // Download button on cards (event delegation)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-dl-btn');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    // Artist detail album cards use data-album-idx
    if (card.dataset.albumIdx !== undefined) return; // handled locally
    const item = JSON.parse(card.dataset.item);
    openModal(item);
    if (!item.inLibrary) setTimeout(() => $('#modalDownload').click(), 100);
  });

  // Keyboard controls (when not in input)
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (!store.playerQueue.length && !_activeDeckEl().src) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } })); return; }
        if (store.castDevice) {
          if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
          else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
        } else {
          _ensureAudioContext();
          if (_ctx.state === 'suspended') _ctx.resume();
          const deck = _activeDeckEl();
          if (deck.paused) {
            deck.play().catch(() => {});
          } else if (_crossfading) {
            _finalizeCrossfadeOnPause().pause();
          } else {
            deck.pause();
          }
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        nextTrack();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        prevTrack();
        break;
      case 'ArrowUp':
        e.preventDefault();
        store.playerVolume = Math.min(1, store.playerVolume + 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else { _deckA.volume = store.playerVolume; _deckB.volume = store.playerVolume; }
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else { _deckA.volume = store.playerVolume; _deckB.volume = store.playerVolume; }
        break;
    }
  });

  // Periodic save while playing
  setInterval(() => { if (store.playerPlaying && store.currentUser) saveQueueNow(); }, 30000);

  // Save on page unload (sync XHR since sendBeacon can't set auth headers)
  window.addEventListener('beforeunload', () => {
    if (store.playerQueue.length && store.currentUser) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/player/queue', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        const token = store.authToken;
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(JSON.stringify({
          queue: store.playerQueue, current_index: store.playerIndex,
          position_seconds: _activeDeckEl().currentTime || 0, volume: store.playerVolume,
          playlist_mode: store.playlistMode,
        }));
      } catch {}
    }
  });

  // ── Swipe up on mini player to open full player ──
  const playerBar = document.getElementById('playerBar');
  if (playerBar) {
    let sy = 0, tracking = false;
    playerBar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sy = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    playerBar.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dy = sy - e.touches[0].clientY;
      if (dy > 40) {
        tracking = false;
        import('./fullplayer.js').then(m => m.openFullPlayer());
      }
    }, { passive: true });
    playerBar.addEventListener('touchend', () => { tracking = false; }, { passive: true });
    playerBar.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  }
}
