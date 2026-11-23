// player_v3.js — DJ Player with 3-band EQ transitions
// Drop-in replacement for player.js — same exports, same API.

import { store } from './store.js';
import { $, $$, fmtTime, showToast, setArt} from './utils.js';
import { apiJson, refreshStreamToken, streamToken, freshStreamToken, mixPlayUrl } from './api.js';
import { mixLog, watchMixSrc, watchMixEvents } from './mixlog.js';
import { isMixStreamSrc, isPrematureMixEnd, mixKnownDuration, mixStatus, awaitFinished, keepMixAlive, planMixSeek, toastSeekBeyondBuilt, explainMixFailure, resumeWhenBuilt } from './mixstream.js';
import { openModal } from './downloads.js';
import { renderQueue, shuffleNext, shufflePrev, peekShuffleNext, playOrder, resetShuffleOrder, serializeShuffleOrder, restoreShuffleOrder, autoplayStart, markAutoplayStart, appendAutoplayRows, capAutoplayTail, adoptShuffleIndex, moveInPlayOrder, noteShuffleJump, undoShuffleJump } from './queue.js';
import { syncFullPlayer } from './fullplayer.js';
import { getCachedUrl, waitForCache, getStatus as getPrefetchStatus, prefetchTrack, cleanup as prefetchCleanup, pausePrefetch, abortStale, keyFor as prefetchKey, resumePrefetch, streamQuality, setUpcomingProvider } from './prefetch.js';
import { fetchDjData, scheduleDjTransitionV3, resetDeckAfterTransitionV3, scheduleDjTransition, resetDeckAfterTransition, findCrossfadeStartBeat, findCrossfadeStartDownbeat, pickSmartNext, markPlayed, resetSmartQueuePlayed, CrossfadeBeatSyncV3, IS_WEBKIT, webkitCrossfadeDuration, resolveTransitionStyle, dropCutLead, clearPendingSeek, fadeBeatsFor } from './djmix.js';
import { getDjData } from './bpm.js';
import * as cast from './cast.js';
import { ab as _ab, abPlay, abPause, abStop } from './androidbridge.js';

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

// ── What plays next — ONE answer for prefetch, pre-analysis, the Next dot, the keep
// set and the auto-trigger. Each of those used to work it out for itself as
// queue[index + 1], which is only true with shuffle and Smart Queue both off: under
// shuffle the engine downloaded a track it was never going to play, found nothing
// cached for the one it did, and ran every single transition off the live stream
// (no seek, no beat alignment, a load in the middle of the fade).
// A prediction, never a commit: no side effects beyond dealing unplaced tracks into
// the shuffle order, which drawing the queue panel does as well.
function _smartOn() { return _djSetting('smart_queue', 'off') !== 'off' && !store.shuffleEnabled; }
function _upcomingIdx() {
  const q = store.playerQueue, i = store.playerIndex;
  if (!q.length || i < 0) return null;
  // The DJ desk picked the next track by hand — the commit honours it first.
  { const f = _deskForcedIdx(); if (f != null) return f; }
  if (store.shuffleEnabled && q.length > 1) {
    // Exhausted + repeat-all deals a fresh permutation at commit — not predictable.
    return peekShuffleNext();
  }
  // Same validity test the commit applies (_nextTrackInQueue): after a queue edit the
  // index may name another track, and the commit would then pick afresh.
  if (_smartOn() && _predictedNextIdx != null && _predictedNextIdx >= 0
      && _predictedNextIdx < q.length && _predictedNextIdx !== i
      && _smartKey(q[_predictedNextIdx]) === _predictedNextKey) {
    return _predictedNextIdx;
  }
  if (i + 1 < q.length) return i + 1;
  if (store.repeatMode === 'all' && q.length > 1) return 0;
  return null;
}
function _upcomingItem() {
  const idx = _upcomingIdx();
  return idx == null ? null : (store.playerQueue[idx] || null);
}
function _itemKey(it) { return prefetchKey(_decodeEntities(it.name || ''), _decodeEntities(it.artist || ''), it.id); }
/** Cache keys cleanup() must spare regardless of queue position. */
function _upcomingKeep() {
  const up = _upcomingItem();
  const keep = up ? [_itemKey(up)] : [];
  // A track playing in the DJ desk's headphones may sit anywhere (or nowhere) in the
  // queue; evicting its blob would pull the audio out from under the cue deck.
  if (_deskLoan && _deskLoan.item) keep.push(_itemKey(_deskLoan.item));
  return keep;
}
/** Can an auto/ended advance produce a track from the queue itself? */
function _canAdvance() {
  if (store.repeatMode === 'all') return true;
  if (_deskForcedIdx() != null) return true;
  if (store.shuffleEnabled && store.playerQueue.length > 1) return peekShuffleNext() != null;
  if (_djSetting('smart_queue', 'off') !== 'off') return true; // may pick an unplayed earlier track
  return store.playerIndex < store.playerQueue.length - 1;
}
// Shuffle: tell prefetch the real running order, so its look-ahead window and its
// eviction follow the permutation instead of the queue's storage order.
setUpcomingProvider((count) => {
  if (!(store.shuffleEnabled && store.playerQueue.length > 1)) return null;
  const order = playOrder();
  const pos = order.indexOf(store.playerIndex);
  return pos < 0 ? null : order.slice(pos + 1, pos + 1 + count);
});

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
/**
 * Throw away the bound "next track" and pick again — for a knob that must take effect
 * on the very next track (the energy direction). Without it the change would be heard
 * one track late: the pick is made, and its audio prefetched, when the current track
 * starts. Not while a transition is under way: that track is already playing in.
 */
export function repickNext() {
  if (!_smartOn() || _crossfading || _crossfadeTriggered || _advanceInFlight) return false;
  // Pick and bind in the SAME tick (as the `playing` handler does). Clearing first and
  // letting _preAnalyzeUpcoming pick later left seconds with no bound track: the auto-
  // trigger then timed the transition for queue[i+1] and the commit chose another,
  // un-prefetched one.
  const data = _outDjData || (() => {
    const cur = store.playerQueue[store.playerIndex];
    return cur ? getDjData(_decodeEntities(cur.name || ''), _decodeEntities(cur.artist || '')) : null;
  })();
  if (!data) return false;                       // nothing to steer from yet; the next pick reads the knob
  const idx = pickSmartNext(store.playerQueue, store.playerIndex, data, _djSetting('smart_queue', 'off'), store.repeatMode === 'all');
  if (idx == null || idx === _predictedNextIdx) return idx != null;
  const item = store.playerQueue[idx];
  const name = _decodeEntities(item.name || ''), artist = _decodeEntities(item.artist || '');
  _predictedNextIdx = idx;
  _predictedNextKey = _smartKey(item);
  _inDjData = getDjData(name, artist);
  resumePrefetch();
  prefetchTrack(name, artist, item.id);
  _preAnalyzeUpcoming();                         // takes its "already bound" branch
  try { renderQueue(); } catch { /* panel closed */ }
  return true;
}

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
    // NOT on WebKit: Safari/WKWebView renders a MediaElementSource through a context
    // whose rate differs from the output device unreliably — it can output pure silence
    // while the element plays on (timer runs, nothing audible). Audio that plays beats
    // audio that is resampled one time less, so WebKit gets the device's native rate.
    _ctx = IS_WEBKIT ? new _AC({ latencyHint: 'playback' })
                     : new _AC({ sampleRate: 48000, latencyHint: 'playback' });
  } catch (e) {
    _ctx = new _AC(); // device can't honor the request → fall back to default
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

  // The OS can take the context away on its own — an interruption, an output-device
  // change (WebKit reports 'interrupted', not 'suspended'). A deck playing into it is
  // silent with the clock running, and only a tap used to bring it back.
  _ctx.addEventListener?.('statechange', () => {
    if (localStorage.getItem('ms_dj_debug')) console.log(`[DJ ctx] → ${_ctx.state}`);
    if (_ctx.state !== 'running' && _ctx.state !== 'closed' && !_activeDeckEl().paused) {
      _ctx.resume().catch(() => {});
    }
  });
  if (localStorage.getItem('ms_dj_debug')) {
    console.log(`[DJ ctx] rate=${_ctx.sampleRate} state=${_ctx.state} webkit=${IS_WEBKIT}`);
  }
}

// deck.src always reads back ABSOLUTE, so the expected value has to be stored that way.
// Stream URLs are built relative ("/api/player/stream?…"); compared as written they
// never matched, _isExpectedSrc was false for every live stream and the error handler
// returned on its first line. A 404, a 401, a rate-limited or dropped stream produced
// no skip and no toast — only blob: sources ever reached the recovery code — and the
// player sat silent until the stall watchdog noticed some 15 s later.
function _absUrl(src) {
  try { return new URL(src, location.href).href; } catch { return src; }
}
let _restorePos = 0;     // position_seconds of the queue state loaded last
let _restoreSeek = null; // loadQueueState's pending "seek to the saved position"
/** An engine load puts the rate back to 1: a deck the desk drove without key lock gets
 *  the lock back with it (see deskSetKeyLock). */
function _resetPitchMode(deck) {
  if (deck.preservesPitch !== true) deck.preservesPitch = true;
  deck._deskVinyl = false; deck._deskDriven = false;
}
function _setDeckSrc(deck, src) {
  // Safety net: the engine is loading this deck — if the desk holds it, it comes back first.
  if (_deskLoan && _deskLoan.el === deck) _deskRevoke('advance', { handover: true });
  if (_restoreSeek) { _deckA.removeEventListener('loadedmetadata', _restoreSeek); _deckB.removeEventListener('loadedmetadata', _restoreSeek); _restoreSeek = null; }
  const abs = _absUrl(src);
  if (deck === _deckA) _expectedSrcA = abs;
  else _expectedSrcB = abs;
  _resetPitchMode(deck);
  deck.src = src;
  deck._mixRec = false;      // a new load supersedes any recovery wait
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
  // A manual crossfader mix is settled by where the fader stands: past half the new
  // track stays, before it the old one is live again (and the new goes back to the desk).
  if (_deskMix) { _deskSettleMix(); if (!_crossfading) return _activeDeckEl(); }
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

// Fail-safe against inaudible playback. The active deck advancing while its crossfade
// gain sits at 0 means the listener hears absolutely nothing, and nothing in the engine
// would ever correct it: that is the "timer runs but no sound" failure. It can arise
// from a fade-in that never got scheduled (WKWebView resume() stalling) or a transition
// torn down mid-ramp. Never repair during a live crossfade — the incoming gain
// legitimately sits at 0 there — and only after ~1s of confirmed silent playback, so a
// normal fade-in is never cut short.
let _silentSince = 0;
function _guardAudible(deck) {
  if (_crossfading || !_ctx || deck.paused) { _silentSince = 0; return; }
  const g = _activeGain();
  if (!g || g.gain.value > 0.01) { _silentSince = 0; return; }
  const now = Date.now();
  if (!_silentSince) { _silentSince = now; return; }
  if (now - _silentSince < 1000) return;
  _silentSince = 0;
  g.gain.cancelScheduledValues(0);
  g.gain.value = 1;
  if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
  if (localStorage.getItem('ms_dj_debug')) {
    console.warn(`[DJ guard] active deck played at gain 0 — forced audible (ctx=${_ctx.state})`);
  }
}

// A deck that reports "playing" while its clock stands still is a dead transition: the
// incoming deck never received enough data (the bounded _waitForCanPlay proceeds on
// timeout by design) and nothing in the engine ever revisits it, so playback just stops.
// This has to run on its own timer, not on timeupdate — a frozen deck emits no timeupdate,
// so that handler is blind to exactly the failure we need to catch. Nudge first; only a
// deck still frozen after 15s is written off and skipped.
let _lastProgressT = -1, _lastProgressAt = 0, _rearmedAt = 0, _refusedTicks = 0;

// Re-issue a stream request at the position the deck stopped at. One attempt per
// source (_rearmedSrc): a second failure of the same URL is the track's problem, not
// the connection's, and is left to the skip logic.
let _rearmedSrc = '';
let _rearmPending = false;
function _canRearm(deck) {
  const src = String(deck.src || '');
  return !!src && !src.startsWith('blob:') && _rearmedSrc !== src && !_crossfading;
}
/** Wait for the finished file of the streamed mix on `deck` and resume at `pos`, with
 *  visible state. The watchdog's error net stays off meanwhile; if the server says it cannot
 *  be fetched, or the listener has moved on, that ends the wait (the skip only for the
 *  former). */
function _waitMixFinished(deck, pos) {
  const gen0 = _loadGen;
  _rearmPending = true;
  deck._mixRec = true;               // the ONE owner of this deck while it waits: no watchdog, error net or re-arm touches it
  mixLog('wait', deck, { pos: Math.round(pos) }, 'dj');
  const release = () => { _rearmPending = false; deck._mixRec = false; };
  awaitFinished(deck, pos,
    (p) => {
      release();
      // The element may have recovered by itself while we waited (WebKit retries a failed
      // range request on its own): the server has the finished file, so what is loading IS
      // the same resource — keep it rather than interrupt a load that works.
      if (!deck.error && deck.readyState >= 2) {
        mixLog('keep', deck, { pos: Math.round(p) }, 'dj');
        if (p > 1 && Math.abs((deck.currentTime || 0) - p) > 5) { try { deck.currentTime = p; } catch {} }
        if (store.playerPlaying && deck.paused) deck.play().catch(() => {});
        return;
      }
      mixLog('reload-finished', deck, { pos: Math.round(p) }, 'dj');
      _reloadFinishedAndSeek(deck, p, store.playerPlaying);
    },
    () => { const ok = deck === _activeDeckEl() && _loadGen === gen0; if (!ok) release(); return ok; },
    (msg) => { release(); mixLog('skip', deck, { why: String(msg).slice(0, 60) }, 'dj'); showToast(msg, true); _skipAfterError(deck.error ? deck.error.code : undefined); });
}

/** A streamed mix failed to load. ONE path owns the deck from the first instant (no watchdog,
 *  no other `error` event may start a second recovery): if the server has the finished file or is
 *  building it, wait for it / reload it; the same stream is retried at most twice a minute before
 *  the track is given up. `deck.error` is read now — a stale event of a load we replaced finds no
 *  error and is ignored by the caller. */
async function _recoverMixError(deck) {
  if (deck._mixRec) return;
  deck._mixRec = true;                 // synchronously: the watchdog's error net runs every 2 s and used to skip in the gap
  _rearmPending = true;
  const src = deck.src, pos = deck.currentTime || 0, code = deck.error ? deck.error.code : undefined;
  mixLog('recover', deck, { pos: Math.round(pos) }, 'dj');
  const st = await mixStatus(src);
  if (deck !== _activeDeckEl() || deck.src !== src) { deck._mixRec = false; _rearmPending = false; return; }   // the listener moved on
  const url = (() => { try { return new URL(src).searchParams.get('url') || ''; } catch { return ''; } })();
  const tr = deck._mixTry && deck._mixTry.url === url && Date.now() - deck._mixTry.at < 60000 ? deck._mixTry : { url, n: 0, at: Date.now() };
  if (st && st.building) { _rearmPending = false; deck._mixRec = false; _waitMixFinished(deck, pos); return; }
  if (st && st.cached && tr.n < 2) {
    tr.n++; tr.at = Date.now(); deck._mixTry = tr;
    _rearmPending = false; deck._mixRec = false;
    mixLog('reload-finished', deck, { pos: Math.round(pos), try: tr.n }, 'dj');
    _reloadFinishedAndSeek(deck, pos, store.playerPlaying);
    return;
  }
  _rearmPending = false; deck._mixRec = false;
  mixLog('skip', deck, { why: st ? (st.cached ? 'again' : 'idle') : 'nostatus' }, 'dj');
  _skipAfterError(code);
}

function _rearmDeck(deck) {
  if (deck._mixRec) return;           // a streamed mix in recovery has its own owner
  const old = deck.src, pos = deck.currentTime || 0, rate = deck.playbackRate || 1;
  const mode = { lock: deck.preservesPitch, vinyl: deck._deskVinyl, driven: deck._deskDriven }; // the same stream comes back: so does the desk's pitch mode
  const gen = _loadGen;
  _rearmedSrc = old;
  _rearmPending = true; // the watchdog's error net must not skip what is being rescued
  if (localStorage.getItem('ms_dj_debug')) console.warn(`[DJ guard] re-arming stream at ${pos.toFixed(1)}s`);
  // The request may have failed BECAUSE its token expired (a device asleep past the
  // token's lifetime): asking again with the same URL would fail the same way and the
  // track would be skipped for nothing. Re-issue it with a token known to be fresh.
  freshStreamToken().catch(() => null).then(async (tok) => {
    _rearmPending = false;
    if (gen !== _loadGen || deck !== _activeDeckEl() || deck.src !== old) return; // superseded meanwhile
    // A streamed mix whose build still runs: a non-progressive request would wait and then be
    // refused (503) — straight into the skip. Wait for the finished file, with visible state.
    if (isMixStreamSrc(old)) {
      const st = await mixStatus(old);
      if (gen !== _loadGen || deck !== _activeDeckEl() || deck.src !== old) return;
      if (!(st && st.cached)) { _waitMixFinished(deck, pos); return; }
    }
    // Paused while we waited: bring the stream back, but leave it paused.
    const go = () => { if (store.playerPlaying) deck.play().catch(() => {}); };
    let src = old;
    try {
      const u = new URL(old);
      if (tok && u.searchParams.has('token')) u.searchParams.set('token', tok);
      // The finished, seekable file — a progressive body cannot be seeked back to
      // where the deck stopped, so the song would restart from 0.
      u.searchParams.delete('progressive');
      src = u.href;
    } catch {}
    _rearmedSrc = src;
    const onMeta = () => {
      deck.removeEventListener('loadedmetadata', onMeta);
      if (deck !== _activeDeckEl() || deck.src !== src) return;
      if (pos > 0.05) { try { deck.currentTime = pos; } catch {} }
      if (mode.vinyl || mode.driven) { deck.preservesPitch = mode.lock; deck._deskVinyl = !!mode.vinyl; deck._deskDriven = !!mode.driven; }
      deck.playbackRate = rate; // load() reset it
      go();
    };
    deck.addEventListener('loadedmetadata', onMeta);
    _setDeckSrc(deck, src);
    go();
  });
}
function _stallWatchdog() {
  // The desk is a local feature: casting or controlling another device takes its deck back.
  if (_deskLoan && (store.castDevice || store.remoteTarget)) _deskRevoke(store.castDevice ? 'cast' : 'remote');
  if (store.castDevice || store.remoteTarget) { _lastProgressAt = 0; _refusedTicks = 0; return; }
  const deck = _activeDeckEl();
  if (!deck || !deck.src) { _lastProgressAt = 0; _refusedTicks = 0; return; }
  const dbg = localStorage.getItem('ms_dj_debug');
  // (1) A deck that plays into a context that is not running is silent, and no
  // timeupdate-side guard sees it: the gain reads 1, the clock advances. The OS
  // suspends or interrupts the context on its own (a call, an output device change
  // — WebKit especially) and only a user gesture used to bring it back.
  if (_ctx && !deck.paused && _ctx.state !== 'running') {
    if (dbg) console.warn(`[DJ guard] deck playing into a ${_ctx.state} context — resuming`);
    _ctx.resume().catch(() => {});
  }
  // (2) The engine believes it is playing, yet the deck is paused with no `pause`
  // event having said so — a play() the browser refused. The rejection was swallowed
  // and nothing else looked: the icon showed "playing" over a deck that never
  // started. Ask again a few times, then let the icon tell the truth. A real pause
  // (user, audio-focus loss) fires `pause`, clears playerPlaying and never gets here.
  if (deck.paused) {
    _lastProgressAt = 0;
    if (store.playerPlaying && !deck.ended && !_advanceInFlight && !_crossfading) {
      _refusedTicks++;
      if (_refusedTicks >= 2 && _refusedTicks <= 6) {
        if (dbg) console.warn(`[DJ guard] deck paused while engine expects playback — play() retry ${_refusedTicks - 1}`);
        deck.play().catch(() => {});
      } else if (_refusedTicks > 6) {
        _refusedTicks = 0;
        updatePlayPauseIcon(false);
      }
    } else _refusedTicks = 0;
    return;
  }
  _refusedTicks = 0;
  // A deck holding a load error will never play, whatever its clock says. The error
  // event normally handles it; this is the net under an event that was missed.
  if (deck._mixRec) { _lastProgressAt = 0; return; }   // a streamed mix in recovery: nothing else touches this deck
  if (deck.error && _isExpectedSrc(deck) && !_advanceInFlight && !_crossfading
      && store.playerPlaying && !store.radioLoading && !_autofillPending && !_rearmPending) {
    _lastProgressAt = 0;
    _skipAfterError();
    return;
  }
  // (3) Reports "playing" while the clock stands still. Deliberately NOT exempting
  // deck.seeking: a seek whose request never answers leaves the element seeking
  // forever with the clock parked on the target — exactly a stall. A seek that IS
  // progressing moves currentTime and resets the timer below on its own.
  const now = Date.now();
  const t = deck.currentTime;
  if (!_lastProgressAt || Math.abs(t - _lastProgressT) > 0.05) {
    _lastProgressT = t; _lastProgressAt = now; _rearmedAt = 0; return;
  }
  const stalledMs = now - _lastProgressAt;
  if (stalledMs < 6000) return;
  // A deck that has not produced a single frame yet is most likely still WAITING for
  // the server: an un-downloaded track is fetched and transcoded in full before the
  // first byte is sent, which routinely takes longer than a mid-track stall is given.
  // Skipping at 15 s dropped songs that were seconds from starting, and set the next
  // one off on the same road. It gets a longer rope; a stall mid-track does not.
  const neverStarted = t < 0.05 && deck.readyState < 2;
  const rearmAt = neverStarted ? 20000 : 12000;
  const giveUpAt = neverStarted ? 45000 : 20000;
  if (stalledMs < rearmAt) { deck.play().catch(() => {}); return; }
  if (stalledMs < giveUpAt) {
    // Re-issue the request once, at the same position, before writing the track off —
    // a hung connection (a dozing radio, a proxy that dropped the stream) is far more
    // common than a track that cannot play, and skipping it loses the rest of the song.
    // Never for blob: (nothing to re-request) nor mid-crossfade (the fade owns the deck).
    if (_rearmedAt || !_canRearm(deck)) { deck.play().catch(() => {}); return; }
    _rearmedAt = now;
    _rearmDeck(deck);
    return;
  }
  _lastProgressAt = 0; _rearmedAt = 0;
  if (dbg) {
    console.warn(`[DJ guard] active deck frozen at ${t.toFixed(1)}s (readyState=${deck.readyState}) — advancing`);
  }
  // Not a user skip: 'error' is neither throttled nor recorded as a dislike.
  if (navigator.onLine === false) return; // no network at all — skipping would only burn the queue
  nextTrack({ reason: 'error' });
}

function _startCrossfade(seekable = true) {
  if (!_ctx) return;
  // The incoming deck is the engine's from here on, never the desk's. A hand-over only:
  // on the live-stream path the engine has already loaded that deck itself.
  if (_deskLoan) _deskRevoke('advance', { handover: true });

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
  // On the uncached path the incoming deck was started BEFORE this swap, so its `play`
  // event arrived while it was still the inactive deck and was ignored. If the outgoing
  // track then ends, its `pause` is the last thing the Android shell hears: after the
  // grace period it shows "paused", drops the wake lock and stops the foreground
  // service five minutes later — with music still playing. Say "playing" here.
  if (!_activeDeckEl().paused) {
    const _it = store.playerQueue[store.playerIndex] || _currentRecItem;
    if (_it) abPlay(_it.name, _it.artist);
  }

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
  // A transition started from the DJ desk may name where the incoming track starts
  // (its cue point). One-shot, and only for the load the desk itself started.
  const _inItem = store.playerQueue[store.playerIndex];
  const _deskAt = (_deskStartAt && _inItem && _smartKey(_inItem) === _deskStartAt.key) ? _deskStartAt.t : null;
  _deskStartAt = null;
  const introSkip = _deskAt != null ? String(_deskAt) : _djSetting('intro_skip', 'auto');

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
  // Nothing left of the outgoing track to blend with (it ended, or is about to) →
  // bring the next one straight in (see quickIn in djmix).
  let outDead = _fadingOutDeck.ended || _fadingOutDeck.paused || !!_fadingOutDeck.error;
  {
    const oDur = _deckDur(_fadingOutDeck);
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
      else outDead = true;
    }
  }

  // Use DJ mix engine for beat-synced, key-aware transition
  const result = scheduleDjTransitionV3(_ctx, outDesc, inDesc, transOutData, transInData, {
    numBeats, tempoRange, transitionStyle: transStyle,
    introSkip: inSeekable ? introSkip : '0',  // no seek on non-cached streams
    seekable: inSeekable,
    fallbackSec: _crossfadeDur(),
    fadeCapSec,
    quickIn: outDead,
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
    // "No outro fade" = the outgoing track keeps its level and stops; it does not mean
    // "stop it now". The kill used to land 20 ms after the transition STARTED, a whole
    // fade before the track's end — 8–16 s of every song gone. It lands at the end of
    // the fade, which fadeCap has already tied to the outgoing track's end; the deck
    // itself is stopped by the completion timer below, the one timer teardown clears.
    // A manual skip mid-track is not tied to the track's end (endBound false): there
    // the deck goes at once, as it always did — holding a skipped song at full level
    // under the new one for a whole fade is nobody's idea of "no outro fade". And never
    // later than the style's own exit (a drop cut swaps at its cut point).
    const t0 = _ctx.currentTime;
    const hold = (result.endBound || result.style === 'quick-in' || IS_WEBKIT)
      ? Math.min(dur, Number.isFinite(result.outEnd) ? result.outEnd : dur) : 0;
    const killAt = t0 + Math.max(0, hold - 0.02);
    desc.gain.gain.cancelScheduledValues(t0);
    desc.gain.gain.setValueAtTime(desc.gain.gain.value, t0);
    desc.gain.gain.setValueAtTime(desc.gain.gain.value, killAt);
    desc.gain.gain.linearRampToValueAtTime(0, killAt + 0.02);
  }
  _crossfadeTimer = setTimeout(() => {
    deckToStop.pause(); deckToStop.src = '';
    resetDeckAfterTransitionV3(_deckDesc(deckToStop));
    if (_beatSync) { _beatSync.stop(); _beatSync = null; }
    // The glide's rAF loop does not run while the page is hidden (screen off, phone
    // in a pocket) — its tick stays PENDING. Left alive, it fired the moment the
    // screen came back on, computed t=1 and snapped the deck that is now playing
    // alone to the old fade's target rate, where nothing ever returned it to 1.0:
    // the rest of the track ran up to 8 % off speed. The fade is over; so is the glide.
    _cancelTempoRamp();
    // Now safe to cleanup old blob URLs
    prefetchCleanup(store.playerQueue, store.playerIndex, _upcomingKeep());
    _fadingOutDeck = null;
    _crossfading = false;
    resumePrefetch();
    // A track shorter than the fade (a skit, an interlude, a stream that closed early)
    // reaches its end while it is still "the incoming deck". Its `ended` was ignored —
    // a crossfade was running — and `ended` never fires twice: the deck sat paused at
    // its end for good, where the stall watchdog does not look. Advance now.
    if (_activeDeckEl().ended && !_advanceInFlight && store.repeatMode !== 'one') {
      nextTrack({ reason: 'ended' });
      return;
    }
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

  _deskEmit('swap', { active: _activeDeck });
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
  const seqNext = _upcomingItem();
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
  const _immNext = _upcomingItem();
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

/** The user's volume lives on BOTH decks. Setting only the playing one leaves the
 *  other at the old level, and the next transition fades into that level. */
export function setVolume(v) {
  const vol = Math.max(0, Math.min(1, Number(v) || 0));
  // A deck lent to the desk plays only into the headphones, at its own level (the cue
  // bus sets it); the master fader must not reach it. It gets the master level back
  // the moment the engine takes it back or it goes live.
  if (!_deskLoan || _deskLoan.el !== _deckA) _deckA.volume = vol;
  if (!_deskLoan || _deskLoan.el !== _deckB) _deckB.volume = vol;
}


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
      deck.removeEventListener('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    deck.addEventListener('canplay', finish, { once: true });
    deck.addEventListener('loadeddata', finish, { once: true });
    // A source that failed outright (404, 429, undecodable) will never reach canplay.
    // Resolve at once so the caller can see deck.error instead of sitting out the
    // timeout and then fading into a deck that cannot play.
    deck.addEventListener('error', finish, { once: true });
  });
}

let _lastAbUpdate = 0;

// Every pause/resume that does not come from the on-screen button — the Android
// notification, a headset key, the lock screen, a remote device — goes through these
// two. They used to call pause() on the active deck alone, which mid-crossfade is the
// INCOMING one: the outgoing track played on for the rest of the fade after "pause".
// And a bare play() never looked at the AudioContext, so a context the OS had
// suspended during the pause resumed into silence.
// A press on pause/play while a failed track is waiting to be retried means "stop":
// nothing is audible, so the only thing left to pause is the retry itself. Without
// this the backoff's timer started the music again up to 30 s after the user paused.
function _stopErrorBackoff() {
  if (!_cancelErrorBackoff()) return false;
  updatePlayPauseIcon(false);
  pausePrefetch(); abPause(); // the errored deck's own `pause` is ignored — say it here
  return true;
}
// Play/pause on a deck that holds a load error. play() on it is rejected and pause()
// changes nothing anyone can see, so the button used to be dead until Next was pressed.
// "Playing" → stop (the icon tells the truth); stopped → load the same track again.
function _toggleDeadDeck(deck) {
  if (!(deck.error || deck.networkState === 3) || !deck.src || store.playerIndex < 0) return false;
  if (store.playerPlaying) {
    try { deck.pause(); } catch {}
    updatePlayPauseIcon(false);
    pausePrefetch(); abPause();
  } else {
    loadAndPlay();
  }
  return true;
}
function _pauseLocalPlayback() {
  if (store.castDevice) { cast.castPause(); return; } // notification / lock screen / media keys
  if (_stopErrorBackoff()) return;
  { const d = _activeDeckEl(); if (d.error && store.playerPlaying && _toggleDeadDeck(d)) return; }
  if (_crossfading) _finalizeCrossfadeOnPause().pause();
  else _activeDeckEl().pause();
}
function _resumeLocalPlayback() {
  if (store.castDevice) { cast.castPlay(); return; } // never start local audio under a cast
  _ensureAudioContext();
  if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
  { const d = _activeDeckEl(); if (!store.playerPlaying && _toggleDeadDeck(d)) return; }
  _activeDeckEl().play().catch(() => {});
}

// Android native media action callback (notification buttons → WebView)
window._androidMediaAction = function(action) {
  // A controller never makes sound itself (B1): the notification and headset keys
  // drive the device it controls, the same as the on-screen buttons do.
  if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action } })); return; }
  switch (action) {
    case 'play': _resumeLocalPlayback(); break;
    case 'pause': _pauseLocalPlayback(); break;
    case 'next': nextTrack(); break;
    case 'prev': prevTrack(); break;
  }
};

// Remote control: apply a command from a controlling device to LOCAL playback
// (this device is the target). Mirrors window._androidMediaAction above.
// Prepare the Web Audio graph for an inbound remote play on an IDLE target: resume a
// suspended context and force the active deck's crossfade gain to 1 (inactive to 0),
// mirroring _loadAndPlayImpl's cold-start path. Without this an idle target whose
// context is suspended or whose active gain is 0 plays silently. Never while a deck is
// playing or a fade runs — that snapped a running crossfade (B17).
// NOTE: browser autoplay policy may still keep the context suspended without a prior
// user gesture on the target — reported as `blocked` (getRemoteState).
function _prepareRemotePlayback() {
  _ensureAudioContext();
  if (_ctx && _ctx.state !== 'running') _ctx.resume().catch(() => {});
  if (_crossfading || !_activeDeckEl().paused) return;
  if (_activeGain()) { _activeGain().gain.cancelScheduledValues(0); _activeGain().gain.value = 1; }
  if (_inactiveGain()) { _inactiveGain().gain.cancelScheduledValues(0); _inactiveGain().gain.value = 0; }
}

// Is this device audibly playing (or about to: a failed track waiting for its retry)?
// A deck holding a load error can read paused === false — it is not playing.
function _localPlaying() {
  if (store.castDevice) return !!store.playerPlaying;
  if (_errRetryTimer) return true;
  const d = _activeDeckEl();
  return d.error ? !!store.playerPlaying : !d.paused;
}

// play/pause from a remote. A casting target drives its renderer, not its own deck
// (B10) — the same calls the on-screen button makes. (cast-opravy routes the cast
// inside _resume/_pauseLocalPlayback as well; once both are merged this is redundant.)
function _remotePlay() {
  if (store.castDevice) { apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {}); return; }
  _prepareRemotePlayback();
  // Nothing on the deck yet (a target that never played): start the current row.
  if (!_activeDeckEl().src && store.playerIndex >= 0) { loadAndPlay(); return; }
  _resumeLocalPlayback();
}
function _remotePause() {
  if (store.castDevice) { apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {}); return; }
  _pauseLocalPlayback();
}

// Seek from a remote, in seconds. A fade in progress is finished first: moving only
// the incoming deck lost the beat alignment. seekLocal handles a progressive stream,
// where setting currentTime is silently dropped (B6).
function _remoteSeek(sec) {
  if (!(sec >= 0) || !isFinite(sec)) return;
  if (store.castDevice) { apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: sec } }).catch(() => {}); return; }
  if (_crossfading) _finalizeCrossfadeOnPause();
  seekLocal(sec);
}

function _remoteVolume(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  store.playerVolume = v;
  const el = document.getElementById('playerVolume'); if (el) el.value = Math.round(v * 100);
  const fp = document.getElementById('fpVolume'); if (fp) fp.value = Math.round(v * 100);
  if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(v * 100) } }).catch(() => {});
  else setVolume(v); // both decks — the next transition fades into this level too
}

// A transfer: the server has merged the controller's queue into this device's queue
// file. Take queue, index, order and radio from it WITHOUT touching the playing deck
// (B11: assigning its src paused it, and the load then hard-cut instead of mixing),
// re-anchor the Smart Queue set (B18), and play through the full engine path so the
// DJ transition runs. loadAndPlay starts a track at 0 by design; a transfer is the one
// caller that means "carry on where the other device was".
function _applyTransfer(value) {
  // The server sends the merged state IN the command; reading the file back instead
  // raced a save from this device. Only an old server leaves it out.
  const inline = value && typeof value === 'object' && Array.isArray(value.queue);
  const got = !inline ? loadQueueState({ touchDeck: false })
    : !value.queue.length ? Promise.resolve(null)
    : _adoptTransferredQueue({ ...value, queue: value.queue.slice() }).then(() => value);
  got.then(async (data) => {
    if (!data) return;
    resetSmartQueuePlayed();
    _predictedNextIdx = null;
    const pos = data.position_seconds > 0 ? data.position_seconds : 0;
    const gen = _loadGen + 1;
    await loadAndPlay();
    // The temp playlist (Up Next / Radio) mirrors the queue; it now holds the old one.
    import('./upnext.js').then(u => {
      const id = u.activePlaylistId();
      if (id && u.isTempActive()) u.replaceByName(id, store.playerQueue).catch(() => {});
    }).catch(() => {});
    if (!(pos > 0) || gen !== _loadGen || store.castDevice) return;
    const d = _activeDeckEl();
    const seek = () => {
      if (gen !== _loadGen || d !== _activeDeckEl()) return;
      // A hand-off mid-song: the position is the point, so the fade ends here.
      if (_crossfading) _finalizeCrossfadeOnPause();
      seekLocal(pos);
    };
    if (d.readyState >= 1) seek();
    else d.addEventListener('loadedmetadata', seek, { once: true });
  });
}

export function applyRemoteCommand(action, value) {
  // A device that is itself controlling another must not act on a command (B2):
  // loadAndPlay would relay it as a transfer and two devices would ping-pong. remote.js
  // leaves remote mode BEFORE it hands a command over; this is the backstop.
  if (store.remoteTarget) return;
  switch (action) {
    case 'play':   _remotePlay(); break;
    case 'pause':  _remotePause(); break;
    case 'toggle': if (_localPlaying()) _remotePause(); else _remotePlay(); break;
    case 'next':   nextTrack(); break;
    case 'prev':   prevTrack(); break;
    case 'seek':   _remoteSeek(Number(value)); break;
    case 'volume': _remoteVolume(value); break;
    case 'enqueue': addToQueue(Array.isArray(value) ? value : [value], false); break;
    case 'transfer': _applyTransfer(value); break;
  }
  _remoteReport();
}

// ── Remote: what this device reports, and how a controller gets its own view back ──
// `remote:report` asks remote.js to report state now instead of on its 3 s tick. Only a
// device that is not itself controlling reports this way: on a controller the remote
// state is painted with updatePlayPauseIcon, and reporting from there would loop.
let _remoteReportTimer = null;
function _remoteReport() {
  if (store.remoteTarget || _remoteReportTimer) return;
  _remoteReportTimer = setTimeout(() => {
    _remoteReportTimer = null;
    document.dispatchEvent(new Event('remote:report'));
  }, 150);
}

// The last play() refused by the autoplay policy — a target tab nobody has touched.
let _playBlocked = false;
for (const d of [_deckA, _deckB]) {
  if (!d || typeof d.play !== 'function') continue;
  const play = d.play.bind(d);
  d.play = () => {
    const p = play();
    if (p && typeof p.then === 'function') {
      p.then(() => { _playBlocked = false; }, (e) => { if (e && e.name === 'NotAllowedError') { _playBlocked = true; _remoteReport(); } });
    }
    return p;
  };
}

// A tap on this page is the gesture the autoplay policy waited for.
if (typeof document.addEventListener === 'function') {
  for (const ev of ['pointerdown', 'keydown']) {
    document.addEventListener(ev, () => { if (_playBlocked) { _playBlocked = false; _remoteReport(); } }, { capture: true });
  }
}

function _remoteItem(it) {
  if (!it) return null;
  return {
    name: it.name || '', artist: it.artist || '', album: it.album || '',
    image: it.image || '', duration_ms: it.duration_ms || 0, id: it.id ?? null,
  };
}

// While casting, the renderer's state as cast.js publishes it (castState.position /
// duration / playing); a field it does not publish falls back to the local value.
function _castField(key, type) {
  if (!store.castDevice) return undefined;
  const v = cast.castState ? cast.castState[key] : undefined;
  return typeof v === type && (type !== 'number' || isFinite(v)) ? v : undefined;
}

// The renderer's position now: its last sample, advanced by the time since it was taken
// while it plays, never past the end. undefined → cast.js publishes no sample.
// A renderer that does not know the length reports 0: no length, not a zero one.
function _castDuration() {
  const dur = _castField('duration', 'number');
  return dur > 0 ? dur : undefined;
}
function _castPosition() {
  const pos = _castField('position', 'number');
  if (pos === undefined) return undefined;
  const at = _castField('positionAt', 'number');
  const dur = _castDuration();
  // No sample time → the position as it was sampled, not advanced.
  let p = pos + (_castField('playing', 'boolean') && at > 0 ? Math.max(0, (Date.now() - at) / 1000) : 0);
  if (dur && p > dur) p = dur;
  return p;
}

/** State for `POST /api/remote/state`; remote.js adds the fields it owns. */
export function getRemoteState() {
  const d = _activeDeckEl();
  const playing = _castField('playing', 'boolean') ?? _localPlaying();
  return {
    playing,
    position_seconds: _castPosition() ?? (d.currentTime || 0),
    duration: _castDuration() ?? (_getDuration() || 0),
    volume: store.playerVolume,
    index: store.playerIndex,
    queue_len: store.playerQueue.length,
    // What is on the deck — a recommendation played outside the queue included — so
    // title, art and the like match the position and duration; `index` stays the row.
    track: _remoteItem(_currentRecItem || store.playerQueue[store.playerIndex]),
    next: _remoteItem(_upcomingItem()),
    engine: 'v3',
    dj: {
      smart_queue: _djSetting('smart_queue', 'off'),
      tempo_pref: _djSetting('tempo_pref', 'auto'),
      fade_beats: _djSetting('crossfade_beats', '16'),
      transition_style: _djSetting('transition_style', 'auto'),
      energy_weight: _djSetting('dj_energy_weight', '10'),
      energy_dir: _djSetting('energy_dir', 'auto'),
    },
    blocked: !store.castDevice && (_playBlocked
      || ((playing || store.playerPlaying) && !!_ctx && _ctx.state !== 'running')),
    casting: store.castDevice?.name || null,
  };
}

/** Paint the bar and the full player from THIS device's queue (leaving remote mode). */
export function repaintLocal() {
  const item = store.playerQueue[store.playerIndex];
  if (!item) { hidePlayerBar(); renderQueue(); return; }
  setArt($('#playerImg'), item.image);
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  syncFullPlayer();
  const d = _activeDeckEl();
  const dur = _getDuration();
  const cur = d.currentTime || 0;
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#playerProgressFill').style.width = pct + '%';
  $('#playerTimeCurrent').textContent = fmtTime(cur);
  $('#playerTimeTotal').textContent = fmtTime(dur || 0);
  document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
  const fpFill = $('#fpProgressFill'); if (fpFill) fpFill.style.width = pct + '%';
  const fpCur = $('#fpTimeCurrent'); if (fpCur) fpCur.textContent = fmtTime(cur);
  const fpTot = $('#fpTimeTotal'); if (fpTot) fpTot.textContent = fmtTime(dur || 0);
  const vol = Math.round(store.playerVolume * 100);
  const pv = $('#playerVolume'); if (pv) pv.value = vol;
  const fv = $('#fpVolume'); if (fv) fv.value = vol;
  updatePlayPauseIcon(_localPlaying());
  updateDownloadButtons(item);
  updatePlaylistBadge();
  showPlayerBar();
  renderQueue();
}

// Called by native side when bridge is injected (may be after playback started)
window._androidBridgeReady = function() {
  if (!_activeDeckEl().paused && _ab()) {
    const item = store.playerQueue[store.playerIndex];
    if (item) abPlay(item.name, item.artist);
  }
};

// ── A deck's duration when the browser cannot know it ──
// A track that is not on disk yet is served WHILE the server builds its file
// (`progressive=1`): it starts at once instead of after 5–30 s of silence, but the
// answer has no Content-Length, so the element reports duration = Infinity — measured
// in Chromium — until it has read the stream to its very end. The transition is timed
// off the duration, so without one the track would either run into `ended` or be cut
// at whatever length the catalogue claims. The server knows the real length as soon as
// the file is finished (a few seconds in); the deck asks until it is told.
// Kept ON the deck element (both decks can be mid-poll during a fade, and one shared
// slot let the outgoing track's late answer overwrite the incoming track's).
function _deckDur(deck) {
  const d = deck.duration;
  const declared = mixKnownDuration(deck.src);           // a streamed mix: see mixstream.js
  if (declared) return declared;
  if (d && isFinite(d) && d > 0) return d;
  const l = deck._msLearned;
  return (l && l.src === deck.src) ? l.dur : d;
}
function _learnDuration(deck, item) {
  const src = deck.src;
  if (!src || src.startsWith('blob:') || deck._msLearning === src || deck._msLearned?.src === src) return;
  if (item && item.mix_url) return;   // a streamed mix: the length is the search result's (duration_ms)
  if (deck.duration && isFinite(deck.duration)) return;
  deck._msLearning = src;
  const q = new URLSearchParams({ name: _decodeEntities(item.name || ''), artist: _decodeEntities(item.artist || ''), token: streamToken() });
  let tries = 0;
  const ask = async () => {
    if (deck.src !== src || (deck.duration && isFinite(deck.duration))) { if (deck._msLearning === src) deck._msLearning = ''; return; }
    try {
      const r = await fetch(`/api/player/stream-duration?${q}&quality=${streamQuality()}`);
      const d = r.ok ? await r.json() : null;
      if (d && d.ready && d.duration > 0 && deck.src === src) {
        deck._msLearned = { src, dur: d.duration };
        deck._msLearning = '';
        if (localStorage.getItem('ms_dj_debug')) console.log(`[DJ dur] learned ${d.duration.toFixed(1)}s for a progressive stream`);
        return;
      }
    } catch {}
    if (++tries < 60) setTimeout(ask, 3000); else if (deck._msLearning === src) deck._msLearning = '';
  };
  setTimeout(ask, 1500);
}

// ── Helper: get duration with Safari fallback ──
function _getDuration() {
  // A recommendation played outside the queue is the track on the deck — the queue
  // item at playerIndex is the one it replaced.
  const item = _currentRecItem || store.playerQueue[store.playerIndex];
  const metaSec = item && item.duration_ms > 0 ? item.duration_ms / 1000 : 0;
  const deck = _activeDeckEl();
  const dur = _deckDur(deck);
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
    // "Disagrees with the metadata" is evidence of a bogus duration only for a STREAM.
    // A blob is the whole file, decoded locally: its duration is the file's, and a file
    // that is honestly longer than its Spotify entry (an extended mix matched by name,
    // a video version with an outro) was being faded out and stopped at the Spotify
    // length — a 7:00 mix behind a 3:30 entry was cut at 3:30.
    const isBlob = String(deck.src || '').startsWith('blob:');
    const disagrees = !isBlob && Math.abs(dur - metaSec) > metaSec * 0.15;
    return (tracksPlayhead || disagrees) ? metaSec : dur;
  }
  if (deckOk) return dur;
  if (metaSec > 0) return metaSec;
  return null;
}

/** Seek the local deck to `to` seconds. Exported for the full-player bar too. */
export function seekLocal(to) {
  const d = _activeDeckEl();
  // A progressive stream (duration unknown to the element) has nothing seekable:
  // the click was silently dropped. Reload the finished file and seek in that.
  // A streamed mix (fragmented MP4 while it is being built) declares a finite length yet
  // its body has no Range: inside what is buffered the element seeks itself; beyond it
  // nothing can be answered until the build is done — the listener is told and the music
  // plays on (reloading would wait for the whole build and end in an error and a skip).
  if (isMixStreamSrc(d.src) && !_crossfading) {
    const src0 = d.src;
    planMixSeek(d, to).then((plan) => {
      if (d !== _activeDeckEl() || d.src !== src0) return;       // the track changed meanwhile
      if (plan === 'direct') { try { d.currentTime = to; } catch {} }
      else if (plan === 'reload') _reloadFinishedAndSeek(d, to);
      else toastSeekBeyondBuilt();
    });
    return;
  }
  if (!(d.duration && isFinite(d.duration)) && String(d.src).includes('progressive=1') && !_crossfading) {
    _reloadFinishedAndSeek(d, to);
    return;
  }
  try { d.currentTime = to; } catch {}
}

/** Load the finished (non-progressive) file of the stream on `d` and seek in it. */
function _reloadFinishedAndSeek(d, to, play) {
  let src = d.src;
  try { const u = new URL(src); u.searchParams.delete('progressive'); src = u.href; } catch {}
  const learned = d._msLearned ? { src, dur: d._msLearned.dur } : null;
  const wasPlaying = play === undefined ? !d.paused : !!play;   // after a media error `paused` says nothing
  const onMeta = () => {
    d.removeEventListener('loadedmetadata', onMeta);
    if (d !== _activeDeckEl() || d.src !== src) return;
    try { d.currentTime = to; } catch {}
    if (wasPlaying) d.play().catch(() => {});
  };
  d.addEventListener('loadedmetadata', onMeta);
  _setDeckSrc(d, src);
  if (learned) d._msLearned = learned;
  if (wasPlaying) d.play().catch(() => {});
}

/** Fraction → seconds with the engine's own idea of the duration (learned lengths included). */
export function seekToFraction(pct) {
  const dur = _getDuration();
  if (dur) seekLocal(pct * dur);
}

// ── Play Track ──
export function playTrack(item) {
  store.radioMode = false;
  store.playerQueue = [item];
  store.playerIndex = 0;
  resetSmartQueuePlayed();
  resetShuffleOrder();
  loadAndPlay();
}

// ── Add to Queue ──
export function addToQueue(items, playNow = false) {
  // A controller's queue is not what plays (B5): no local change, no save, no mirror —
  // the target adds the items with its own addToQueue and mirrors them once.
  if (store.remoteTarget) {
    if (playNow) document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'queue_op', value: { op: 'play_now', items } } }));
    else document.dispatchEvent(new CustomEvent('remote:enqueue', { detail: items }));
    showToast(`Added ${items.length} track${items.length > 1 ? 's' : ''} to playlist`);
    return;
  }
  const startIdx = store.playerQueue.length;
  _noNextLatch = false; // there is something to play next now
  // push, never concat: search.js grows the live queue only while it is the same array.
  // A copy: `items` may BE the live queue (a page list playTracks handed over), and
  // pushing while iterating it never ends.
  for (const it of items.slice()) store.playerQueue.push(it);
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
}

// ── Load and Play Current Track ──
// Thin guard: guarantees the advance latch is released on EVERY exit of the impl —
// including a synchronous throw — so an exception can never permanently wedge
// _advanceInFlight (which would silently block all future track advances).
export async function loadAndPlay() {
  // The recommender's cursor is what picks the NEXT autoplay track, so stopping it
  // here would make the station serve its first pick again — and append it to the
  // queue a second time. It stays alive for as long as the queue still carries an
  // autoplay tail, which covers the append itself, Previous back along the tail and
  // a jump to a row above the divider; replacing or clearing the queue ends it.
  const keepRec = _keepRecCursor || autoplayStart() >= 0;
  _keepRecCursor = false;
  // Whoever calls this is starting a track now — a queue row, a new playlist, the
  // backoff's own timer (which has already cleared itself). A backoff still pending
  // is void; left armed it would hold the advance latch over the new track and then
  // skip it. The latch itself is not touched: the caller may hold it, finally frees it.
  if (_errRetryTimer) { clearTimeout(_errRetryTimer); _errRetryTimer = null; }
  _loadsPending++; // the decks are spoken for until this load has swapped (see deskLend)
  try {
    return await _loadAndPlayImpl(keepRec);
  } finally {
    _loadsPending--;
    // An error backoff that started inside the impl owns the latch until its timer
    // fires — releasing it here would let the auto-trigger race the backoff.
    if (!_errRetryTimer) _advanceInFlight = false;
  }
}

// ── A track that would not load ──
// One failed track is skipped after a second, as before. A RUN of them is something
// else: the server's YouTube arm is cooling down (every un-downloaded track 404s for
// minutes) or the link is gone. Skipping once a second through that emptied a whole
// queue in the time it takes to notice — and with repeat-all it never stopped asking.
// So the wait doubles with every consecutive failure (1, 2, 4 … 30 s) and resets the
// moment a track actually plays. While the browser itself reports no network, the
// queue position is held and the SAME track is retried when the wait is over.
let _errStreak = 0;
let _errRetryTimer = null;
function _cancelErrorBackoff() {
  if (!_errRetryTimer) return false;
  clearTimeout(_errRetryTimer);
  _errRetryTimer = null;
  _advanceInFlight = false;
  return true;
}
function _skipAfterError(errCode) {
  if (_errRetryTimer || store.remoteTarget) return;
  _errStreak++;
  const failedIdx = store.playerIndex;
  const failedItem = store.playerQueue[failedIdx];
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(_errStreak - 1, 5)));
  _advanceInFlight = true; // claim the advance synchronously for the whole wait
  // One cause of "every track fails" is ours to fix: a stream token that expired
  // (a refresh that failed once, a device that slept past its lifetime). Get a
  // fresh one before the next attempt builds its URL.
  refreshStreamToken();
  const _codeTxt = errCode ? ` (code ${errCode})` : '';
  const _generic = _errStreak > 1 ? `Stream error${_codeTxt}, retrying in ${Math.round(delay / 1000)}s...` : `Stream error${_codeTxt}, skipping...`;
  // The audio element only says "error"; for a streamed mix the server knows why (429, 502, 503).
  if (failedItem && failedItem.mix_url) explainMixFailure(failedItem, _generic);
  else showToast(_generic);
  if (localStorage.getItem('ms_dj_debug')) console.warn(`[DJ guard] load failed (streak ${_errStreak}) — next attempt in ${delay}ms`);
  _errRetryTimer = setTimeout(() => {
    _errRetryTimer = null;
    _advanceInFlight = false;
    if (store.remoteTarget) return;
    // The user moved on by hand in the meantime (a queue row, a new playlist) —
    // that playback is theirs; skipping now would drop the track they just chose.
    if (store.playerIndex !== failedIdx || store.playerQueue[failedIdx] !== failedItem) return;
    if (navigator.onLine === false) { loadAndPlay(); return; } // offline: same track again
    nextTrack({ reason: 'error' });
  }, delay);
}

// Nothing could be produced to play next (end of the queue, no radio, no
// recommendations). This used to pause the deck on the spot — but the auto-trigger
// asks ~16 beats BEFORE the end, so the last track of every set lost its final ten
// seconds. A deck that is still playing is left to play out; its own `ended` stops
// it. _noNextLatch keeps the trigger from asking again on every timeupdate tick.
let _noNextLatch = false;
function _noNextTrack() {
  _advanceInFlight = false;
  _crossfadeTriggered = false;
  const d = _activeDeckEl();
  // A deck holding a load error reads paused === false but will never play: stop it for
  // real, or the watchdog's error net finds it every 2 s and asks for a next track again.
  if (d.error) { try { d.pause(); } catch {} }
  if (d.paused || d.ended) {
    updatePlayPauseIcon(false); _noNextLatch = false;
    if (d.error) { pausePrefetch(); abPause(); } // its `pause` event is ignored
  } else _noNextLatch = true;
}

// Bumped by every load. A load that waited (cache, canplay) checks it afterwards: if a
// newer load started meanwhile — a queue row, a remote transfer, a new playlist; none
// of those take the advance latch — the decks are that load's now. Carrying on used to
// tear down ITS crossfade and swap back to a deck it had emptied: silence under a
// "playing" icon, on a paused deck the watchdog did not look at.
let _loadGen = 0;
// Loads still resolving. A queue row or a new playlist starts one WITHOUT the advance
// latch, and it waits (cache, canplay) with the inactive deck already loaded — the
// desk must not borrow that deck meanwhile.
let _loadsPending = 0;

async function _loadAndPlayImpl(keepRec) {
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) {
    return;
  }
  const myLoad = ++_loadGen;
  { const it = store.playerQueue[store.playerIndex]; if (_deskStartAt && !(it && _smartKey(it) === _deskStartAt.key)) _deskStartAt = null; } // not the desk's track
  _deskOnLoad(); // the decks are the engine's again: a lent deck comes back, a manual mix ends
  _rearmedSrc = ''; // a new load: its stream may be re-armed once again
  _rearmPending = false; // a wait for a mix's finished file that this load superseded must not keep the watchdog's error net off
  // Any pre-analysis still running was started for the previous track; after this
  // point its writes to _inDjData / the prediction would describe the wrong one.
  _analyzeGen++;
  if (store.remoteTarget) { document.dispatchEvent(new Event('remote:play')); return; }
  _remoteReport(); // the index is final: a controller shows the new track before it loads
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
  { const _up = _upcomingItem(); if (_up) _keep.add(_itemKey(_up)); } // shuffle / repeat-all wrap
  abortStale(_keep);
  _crossfadeTriggered = false;
  _noNextLatch = false;
  const endedBlend = _endedBlend; // Fix 4: consume the one-shot blend-on-ended request
  _endedBlend = false;
  // Stop any virtual rec playback — we're back in the real queue
  if (!keepRec) import('./recommendations.js').then(m => m.stopRecPlayback());
  _currentRecItem = null; // clear stale rec so "Add to playlist" targets the queue track
  const item = store.playerQueue[store.playerIndex];
  _deskTrackItem(item);
  setArt($('#playerImg'), item.image);
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  const mode = store.deviceOutputMode || 'default';
  // A streamed mix has no title the receiver could resolve to this recording.
  if (item.mix_url && ((store.castDevice && mode !== 'local') || mode === 'dlna_only')) {
    showToast('A mix that is not downloaded cannot be cast — download it first', true);
    return;
  }
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
    // One POST for every cast (cast.js castItem): it carries the queue position, what
    // plays next and repeat/shuffle, which the server's follower continues from.
    cast.castTrack(item, { name: cleanName, artist: cleanArtist });
  } else {
    _ensureAudioContext();
    if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
    const streamUrl = mixPlayUrl(item) || `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: streamToken() })}&quality=${streamQuality()}&progressive=1`;

    const currentDeck = _activeDeckEl();
    // Fix 4: a track that ended WITHOUT firing the auto trigger leaves currentDeck paused
    // (ended → paused), which would normally take the cold-start hard-swap branch. Honor
    // _endedBlend to route through the crossfade branch instead so the next track eases in
    // with a (brief, since the outgoing already ended) blend rather than a silent cut.
    // A deck holding a load error keeps paused === false (the failure steps never touch
    // it), so it looked like a playing track to fade out of: the track after a broken
    // one came up from silence over a whole beat-length fade, tempo-matched to a deck
    // that was not producing sound. A dead deck is a cold start.
    const curDead = !!currentDeck.error || currentDeck.networkState === 3;
    if ((!currentDeck.paused || endedBlend) && currentDeck.src && !curDead) {
      // Crossfade: use cache if ready, brief wait if almost done, else stream
      let cached = getCachedUrl(cleanName, cleanArtist, item.id);
      if (!cached) { const w = await waitForCache(cleanName, cleanArtist, 2000, item.id); if (w) cached = w; }
      if (myLoad !== _loadGen) return; // superseded while waiting
      const src = cached || streamUrl;
      let incomingFailed = false;
      let swapped = false;
      pausePrefetch();
      // Resolve the incoming track's DJ data SYNCHRONOUSLY from the cache so the beat
      // grid is available at fade time. _startCrossfade does _outDjData=_inDjData;
      // _inDjData=null synchronously, so an async fetchDjData().then() would not have
      // resolved yet → beat-sync silently disabled. Keep the async fetch as cache warmup.
      // M2: ALWAYS clear-then-set from the track being loaded so a stale _inDjData from a
      // previously-predicted (different) track can't survive and feed the PLL the wrong
      // beat grid (Android beat drift). The sync cache is the source of truth; the async
      // fetch is only a warmup for a cache miss (and only fills if still unset).
      const _resolveIn = () => { _inDjData = getDjData(cleanName, cleanArtist) || null; };
      _resolveIn();
      if (!_inDjData) {
        // Late arrival: before the swap this is the incoming track's data; after it,
        // the track is the CURRENT one and the data belongs in _outDjData. Written
        // into _inDjData after the swap it described the wrong track to the next fade.
        fetchDjData(cleanName, cleanArtist).then(d => {
          if (!d || myLoad !== _loadGen) return;
          if (!swapped) { if (!_inDjData) _inDjData = d; }
          else if (!_outDjData && store.playerQueue[store.playerIndex] === item) _outDjData = d;
        }).catch(() => {});
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
        if (myLoad !== _loadGen) return; // superseded while waiting — the decks are not ours
        if (nextDeck.error) incomingFailed = true;
        else { _resolveIn(); _startCrossfade(true); swapped = true; } // cached blob = seekable — also swaps _activeDeck
      } else if (cached) {
        // IMPORTANT: call _startCrossfade BEFORE setting src on the next deck.
        // _startCrossfade's rapid-skip handler clears _fadingOutDeck.src, and during
        // a rapid skip _fadingOutDeck IS the inactive deck we're about to load.
        // If we set src first, the rapid-skip handler would clear it, causing silence.
        const xfResult = _startCrossfade(true); // cached blob = seekable — also swaps _activeDeck
        swapped = true;
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
        // The error event for this deck was ignored while we waited — it was not the
        // active deck and no crossfade was running yet. Swapping to it anyway faded
        // the playing track out into a deck that could never start: 15 s of silence
        // until the stall watchdog gave up on it. Keep the outgoing track playing
        // and move on to the next one instead.
        if (myLoad !== _loadGen) return; // superseded while waiting — the decks are not ours
        if (nextDeck.error) incomingFailed = true;
        // Re-resolve: anything written to _inDjData during the wait was not for this track.
        else { _resolveIn(); _startCrossfade(false); swapped = true; } // non-seekable live stream — also swaps _activeDeck
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
      if (incomingFailed) {
        const dead = _inactiveDeckEl();
        dead.pause(); dead.src = '';
        resumePrefetch();
        _skipAfterError();
      } else if (cached) {
        resumePrefetch();
        const _afterNext = _upcomingItem();
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
      // A rate-return still easing the PREVIOUS track back to 1.0 would keep writing its
      // old rate onto this one; a seek still waiting for metadata would land in it.
      clearInterval(_rateReturnTimer); _cancelTempoRamp(); clearPendingSeek(deck);
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
        let _ramped = false;
        const _rampIn = () => {
          if (_ramped) return;
          _ramped = true;
          const t0 = _ctx.currentTime;
          g.cancelScheduledValues(t0);
          g.setValueAtTime(0, t0);
          g.linearRampToValueAtTime(1, t0 + 0.05);
        };
        // 'running' — not '!== suspended' — because WebKit also has an 'interrupted'
        // state, which used to take the else branch and ramp against a frozen clock.
        if (_ctx.state === 'running') _rampIn();
        else {
          // WKWebView/Safari can leave resume() PENDING INDEFINITELY once the user
          // activation has been spent (playTracks awaits several times before reaching
          // here). Hanging the fade-in on that promise left the gain at 0 with the deck
          // playing — silence with a running timer, from the very first track. Ask for
          // the resume, but never let audibility depend on the answer.
          _ctx.resume().then(_rampIn).catch(_rampIn);
          setTimeout(() => {
            if (_ramped) return;
            _ramped = true;
            g.cancelScheduledValues(0);
            g.value = 1; // straight to audible — a 50 ms fade is not worth silence
          }, 300);
        }
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
      prefetchCleanup(store.playerQueue, store.playerIndex, _upcomingKeep());
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
  // "Remove from playlist" deletes the track from the Navidrome playlist, not just
  // from the queue. In Up Next — the implicit, unnamed queue every ad-hoc session
  // runs in — that distinction means nothing to the user, while the button sits
  // one glyph away from "Add to playlist". Offer it only in a named playlist.
  const show = (store.playlistMode && store.playlistMode.name !== 'Up Next') ? '' : 'none';
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
  abStop();
}


// ── Next / Prev ──
let _lastNextTime = 0;
export function nextTrack(opts = {}) {
  // A controller advances nothing of its own: every user Next is a remote:cmd, and an
  // automatic one (ended, error, watchdog, cast end-of-track) would transfer its queue.
  if (store.remoteTarget) return;
  // Casting from a page that just woke: let one status poll adopt what the server moved
  // on to, THEN step from there — not from the track the page last saw.
  if (cast.deferUntilFresh(() => nextTrack(opts))) return;
  const reason = opts.reason || 'user';
  // A user skip outranks a pending error backoff — the buttons must never go dead
  // for the length of the wait.
  if (reason === 'user') {
    if (Date.now() - _lastNextTime < 500) return; // throttled: touch nothing
    _cancelErrorBackoff();
  }
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
        const _d = deck ? _deckDur(deck) : 0;
        const dur = _d && isFinite(_d) ? _d : 0;
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
  // A track played VIRTUALLY — outside the queue, which now means only a pick the
  // user started in the recommendations panel — advances along that list. The test
  // is _currentRecItem, not isPlayingRec(): the recommender's cursor stays set while
  // the autoplay tail plays, and those rows are ordinary queue rows.
  import('./recommendations.js').then(m => {
    if (_currentRecItem) {
      // Rec advance does not go through loadAndPlay — release the latch here.
      _advanceInFlight = false;
      m.playNextRec().then(filled => { if (!filled) _noNextTrack(); }).catch(() => _noNextTrack());
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
  // A next track picked by hand on the DJ desk outranks shuffle and Smart Queue alike.
  // Consumed here, whether or not it is still valid.
  {
    const forced = _deskForcedIdx();
    _deskNext = null;
    if (forced != null) {
      if (_djSetting('smart_queue', 'off') !== 'off') markPlayed(store.playerQueue[store.playerIndex]);
      _predictedNextIdx = null; _predictedNextKey = null;
      noteShuffleJump(store.playerQueue[store.playerIndex], store.playerQueue[forced]);
      store.playerIndex = forced;
      loadAndPlay();
      return;
    }
  }
  // Shuffle still takes precedence over Smart Queue — the user asked for random order
  // explicitly, and the two cannot both pick the next track.
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    let next = shuffleNext();
    if (next == null && store.repeatMode === 'all') {
      // Permutation exhausted and repeat-all is on: deal a fresh one.
      resetShuffleOrder();
      next = shuffleNext();
    }
    if (next == null) { _nextTrackTerminal(); return; }
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
  } else if (store.radioMode && store.radioLoading) {
    // A refill is already on its way and will start the next track itself.
    _advanceInFlight = false;
  } else if (store.radioMode) {
    // Auto-fill queue with more radio tracks
    store.radioLoading = true;
    // The refill is a network round trip with no deadline of its own. Holding the
    // advance latch across it swallowed Next, Previous, `ended` and the error handler
    // for as long as the request hung; radioLoading is the guard for this window.
    _advanceInFlight = false;
    const seed = store.playerQueue[store.playerQueue.length - 1] || store.radioSeedTrack;
    if (seed) {
      showToast('Loading more similar tracks...');
      const params = new URLSearchParams({ track: seed.name || '', artist: seed.artist || '', artist_id: seed.id || store.currentArtistId || '' });
      const _radioOpts = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? { signal: AbortSignal.timeout(20000) } : {};
      apiJson(`/api/radio?${params}`, _radioOpts).then(data => {
        if (store.remoteTarget) return; // started before control began: nothing plays here now
        const newTracks = (data.tracks || []).filter(t => {
          const key = (t.name || '').toLowerCase() + '|' + (t.artist || '').toLowerCase();
          return !store.playerQueue.some(q => (q.name || '').toLowerCase() + '|' + (q.artist || '').toLowerCase() === key);
        });
        if (newTracks.length) {
          // The first NEW track, by position — not "current + 1": the latch is no
          // longer held across this request, so the index may have moved meanwhile.
          const firstNew = store.playerQueue.length;
          for (const t of newTracks) store.playerQueue.push(t);
          store.playerIndex = firstNew;
          loadAndPlay();
          renderQueue();
          saveQueueDebounced();
          // Mirror auto-fill tracks into Radio playlist when active
          import('./upnext.js').then(u => u.mirrorAdd(newTracks));
        } else {
          showToast('No more similar tracks found');
          _noNextTrack(); // terminal, no loadAndPlay — releases the latch
        }
      }).catch(() => {
        showToast('Failed to load more tracks');
        _noNextTrack(); // terminal, no loadAndPlay — releases the latch
      }).finally(() => { store.radioLoading = false; });
    } else {
      store.radioLoading = false; // nothing was requested — don't leave the guard set
      _noNextTrack(); // no seed to fetch radio from — releases the latch
    }
  } else {
    _advanceInFlight = false; // the autofill reaches loadAndPlay through playRecTrack
    _autofillFromRecs();
  }
}

// ── Autoplay: the recommender keeps the queue going when it runs out ──
// The recommender used to play its pick OUTSIDE the queue: the panel still marked
// the previous track as playing, the title bar showed something no row contained,
// and Next on the last track looked like it did nothing at all. The pick now goes
// INTO the queue, behind an "Autoplay" divider, so what plays is what the panel says.
//
// There is no seam inside recommendations.js to take the track from — playNextRec()
// starts playback itself — so the hand-off is marked here and consumed in
// playRecTrack, which is where that module finally hands the track over.
const AUTOPLAY_MAX = 20;
let _autofillPending = false;
let _keepRecCursor = false;

function _autofillFromRecs() {
  _autofillPending = true;
  import('./recommendations.js').then(m => {
    m.playNextRec().then(filled => {
      if (!filled) {
        // Nothing came back, so playRecTrack never ran and the hand-off is moot.
        _autofillPending = false;
        showToast('No more recommendations for this queue');
        _noNextTrack();
      }
    }).catch(() => { _autofillPending = false; _noNextTrack(); });
  }).catch(() => { _autofillPending = false; _noNextTrack(); });
}

// True exactly once per _autofillFromRecs, for the playRecTrack call it triggered —
// a pick the user starts by hand in the panel is not part of the autoplay tail.
// Deliberately not time-boxed: the recommender's first load is a network round trip
// whose length is not ours to guess, and a guessed deadline turns the append into a
// coin toss. The flag is cleared either here or on the empty-result path, and those
// are the only two ways out of playNextRec.
function _takeAutofill() {
  if (!_autofillPending) return false;
  _autofillPending = false;
  return true;
}

// The hand-off has to be bound to its caller, and playRecTrack cannot see who called
// it. Between _autofillFromRecs and the delivered track lies a network round trip; a
// row the user taps in the panel in that window reaches playRecTrack FIRST and would
// be the one pinned behind the "Autoplay" divider. So a user-started recommendation
// voids the hand-off: the automatic pick then plays virtually, as it did before, and
// nothing the user chose is written into their queue.
//
// It is cancelled on the click rather than set from playNextRec's own .then(), which
// is a tick too late — getPlayerModule() is a cached, already-resolved promise, so
// the playRecTrack it schedules runs BEFORE playNextRec's promise resolves.
// Capture phase, document level: recommendations.js owns those rows and this batch
// may not edit it.
document.addEventListener('click', (e) => {
  if (!_autofillPending) return;
  const t = e.target;
  if (t && t.closest && t.closest('.rec-item, .ctx-menu')) _autofillPending = false;
}, true);

function _appendAutoplay(item) {
  // push, never concat: search.js grows the live queue only while the array it
  // handed out is still the same object (`store.playerQueue !== ctx`), so swapping
  // the array in would silently switch that off.
  markAutoplayStart(item);
  store.playerQueue.push(item);
  store.playerIndex = store.playerQueue.length - 1;
  // Cap the tail. Unbounded, the queue grows for as long as the app is open and
  // saveQueueNow PUTs the whole thing to the server on every change.
  capAutoplayTail(AUTOPLAY_MAX);
  _keepRecCursor = true;
  loadAndPlay();
  renderQueue();
  saveQueueDebounced();
}


// ── Autoplay while casting (cast.js) ──
// The server's follower advances a cast; the recommender lives here. At the end of
// the queue cast.js asks for the recommender's next picks (peekAutoplay) and hands
// them to the server, which appends them to the saved queue as it plays them; rows it
// appended while this page slept come back through appendAutoplayRows.
let _recsMod = null;
function _recs() {
  if (!_recsMod) import('./recommendations.js').then(m => { _recsMod = m; }).catch(() => {});
  return _recsMod;
}
function _castAppendAutoplay(items, at, kind) {
  if (kind === 'radio') {
    // The follower refilled a RADIO queue while this page slept: plain radio rows — no
    // "Autoplay" divider, nothing to tell the recommender — mirrored into the Radio
    // playlist exactly as the page's own refill mirrors its batch (_nextTrackTerminal).
    const added = appendAutoplayRows(items, at, { divider: false });
    if (added) import('./upnext.js').then(u => u.mirrorAdd(items)).catch(() => {});
    return added;
  }
  const n = appendAutoplayRows(items, at);
  if (n) {
    // Through the module already loaded (init imports it): the hint that follows the
    // adoption must see the cursor moved.
    if (_recsMod) _recsMod.markRecsPlayed(items);
    else import('./recommendations.js').then(m => { _recsMod = m; m.markRecsPlayed(items); }).catch(() => {});
  }
  return n;
}
/** What the recommender would play once the queue is over (cast.js sends it with every
 *  cast and hint; the server uses it only at the real end of the saved queue).
 *  A list; [] = nothing must follow; null = not known yet (the server keeps its list).
 *  cast.js has already ruled out repeat, radio and a controller. */
function _castPeekAutoplay(n) {
  if (_currentRecItem) return null;
  const q = store.playerQueue, i = store.playerIndex;
  if (!(store.shuffleEnabled && q.length > 1) && i === q.length - 1 && _deskForcedIdx() == null) {
    // Smart Queue on the last row may still pick an unplayed earlier track
    // (_nextTrackInQueue): then the queue is not over, and the server must not play a
    // pick in that track's place — it ends the queue and this page chooses, as before.
    const mode = _djSetting('smart_queue', 'off');
    if (mode !== 'off') {
      const cur = q[i];
      const dj = _outDjData || (cur ? getDjData(_decodeEntities(cur.name || ''), _decodeEntities(cur.artist || '')) : null);
      if (dj && pickSmartNext(q, i, dj, mode, false) != null) return [];
    }
  }
  const m = _recs();
  return m ? m.peekNextRecs(n) : null;
}

// ── Play a track from recommendations (virtual, not in queue) ──
let _currentRecItem = null;
export async function playRecTrack(item) {
  // An autoplay pick is automatic: on a controller it would transfer this device's queue.
  if (_takeAutofill()) { if (!store.remoteTarget) _appendAutoplay(item); return; }
  // On a controller: the target appends it and plays it now (queue_op play_now). A remote:play
  // transferred this device's scratch queue and the target lost its own.
  if (store.remoteTarget) { addToQueue([item], true); return; }
  _currentRecItem = item;
  _loadGen++; // a queue load still waiting on cache/canplay must not fade this track out
  _deskOnLoad();
  _deskStartAt = null;
  _rearmedSrc = '';
  _cancelErrorBackoff(); // this track supersedes whatever the backoff was waiting to skip
  _crossfadeTriggered = false; // fresh track — re-arm the auto-crossfade trigger
  _noNextLatch = false;
  setArt($('#playerImg'), item.image);
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
  if (item.mix_url && store.castDevice) {
    showToast('A mix that is not downloaded cannot be cast — download it first', true);
    return;
  }
  if (store.castDevice) {
    cast.castTrack(item, { name: cleanName, artist: cleanArtist, queueIndex: -1 }); // not a queue row
  } else {
    _ensureAudioContext();
    if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
    const streamUrl = mixPlayUrl(item) || `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: streamToken() })}&quality=${streamQuality()}&progressive=1`;
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
      clearInterval(_rateReturnTimer); _cancelTempoRamp(); clearPendingSeek(curDeck);
      _setDeckSrc(curDeck, src);
      curDeck.play().catch(() => {});
      // The deck now holds another track; the previous one's grid and outro would time
      // this one's transition (a lead longer than the fade → its ending cut). The
      // `playing` handler only refills when this is empty.
      _outDjData = getDjData(cleanName, cleanArtist) || null;
      _inDjData = null;
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
  if (fpImg) setArt(fpImg, item.image);
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
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _resumeLocalPlayback(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _pauseLocalPlayback(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

export function prevTrack() {
  if (store.remoteTarget) return; // see nextTrack
  if (cast.deferUntilFresh(() => prevTrack())) return; // see nextTrack
  // #13: respect the single-flight advance latch. Without this, pressing Previous during
  // an in-flight auto-advance runs a concurrent loadAndPlay() and clears the latch out
  // from under nextTrack → overlapping crossfades. Claim it synchronously at entry; it is
  // released by loadAndPlay's finally on paths that load, and explicitly here otherwise.
  _cancelErrorBackoff(); // a user action outranks a pending error backoff
  if (_advanceInFlight) return;
  _advanceInFlight = true;
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // Previous is queue history, nothing else. Autoplay picks land in the queue now,
  // so walking the recommendation list backwards would step outside what the panel
  // shows — and it never matched where the user came from anyway.
  //
  // Only a track playing VIRTUALLY has no row behind it; for that one Previous drops
  // back to the queue. Keyed on _currentRecItem, not on the recommender's cursor:
  // the cursor is still set all through the autoplay tail, and keying on it made
  // Previous restart the tail track instead of stepping back — and, because that
  // reload cleared the cursor, the next Next served the same pick again and appended
  // it to the queue a second time.
  if (_currentRecItem) {
    if (store.playerIndex >= 0) {
      loadAndPlay(); // finally releases the latch
    } else {
      _advanceInFlight = false;
    }
    return;
  }
  // Normal queue navigation
  if (!store.castDevice && _activeDeckEl().currentTime > 3) {
    _activeDeckEl().currentTime = 0;
    _advanceInFlight = false; // seek-to-start, no loadAndPlay — release latch
    return;
  }
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    const prev = shufflePrev();
    if (prev != null) {
      store.playerIndex = prev;
      loadAndPlay(); // finally releases the latch
      return;
    }
    // No history to walk back: right after switching shuffle on, and after every
    // page load, because the order is module memory. Fall through to the linear
    // Previous rather than being a dead button.
  }
  if (store.playerIndex > 0) {
    store.playerIndex--;
    loadAndPlay(); // finally releases the latch
  } else {
    _advanceInFlight = false; // at first track, nothing advanced — release latch
  }
}

// ── Play/Pause Icon ──
export function updatePlayPauseIcon(playing) {
  if (store.playerPlaying !== playing) _remoteReport();
  store.playerPlaying = playing;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  $('#playPauseIcon').innerHTML = playing ? pausePath : playPath;
  const fpIcon = $('#fpPlayPauseIcon');
  if (fpIcon) fpIcon.innerHTML = playing ? pausePath : playPath;
}

export function pauseLocal() {
  try {
    if (_crossfading) _finalizeCrossfadeOnPause(); // or the fade timer outlives the pause
    _deckA.pause(); _deckB.pause();
  } catch {}
  pausePrefetch(); // nothing local will play: don't keep downloading for it
  updatePlayPauseIcon(false);
}

/** Entering remote control: nothing on this device may sound or advance on its own.
 *  pauseLocal alone left a pending error retry, a load waiting on cache/canplay and the
 *  renderer of a cast running — each reached loadAndPlay and transferred this device's
 *  queue over the target's. The automatic paths themselves return under remoteTarget. */
export function silenceForRemote() {
  // A controller makes no sound — not even in the DJ desk's headphones. The lent deck goes
  // back now (the watchdog would only notice within 2 s); a hand mix is settled by the
  // fader in _finalizeCrossfadeOnPause below.
  _deskRevoke('remote');
  _cancelErrorBackoff();
  _loadGen++;    // a load waiting on cache/canplay gives up at its next check
  _analyzeGen++; // and so does a pre-analysis
  _crossfadeTriggered = false; _endedBlend = false; _noNextLatch = false;
  try {
    if (_crossfading) _finalizeCrossfadeOnPause();
    _deckA.pause(); _deckB.pause();
  } catch {}
  pausePrefetch();
  updatePlayPauseIcon(false);
  // Paused, not stopped: the session survives, and leaving control can resume it.
  if (store.castDevice) apiJson('/api/dlna/pause', { method: 'POST' }).catch(() => {});
}

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
  _remoteReport();
  store.playerSavePending = true; // cast.js flushes it before a cast (the server reads it)
  clearTimeout(store.playerSaveTimer);
  store.playerSaveTimer = setTimeout(saveQueueNow, 2000);
  cast.noteQueueChanged(); // what plays next may have changed: the server hears it now
  // Trigger recommendations refresh
  import('./recommendations.js').then(m => m.onQueueChanged());
}

const KEEPALIVE_MAX_BYTES = 60000;
async function saveQueueNow(force, opts) {
  // While casting, the server's follower writes this file too (the pointer, the rows it
  // appends from the autoplay list). A save left in the debounce when the page froze
  // fires on wake with the queue as it was BEFORE the sleep and would erase those rows:
  // hold it until the page has seen a fresh status and any adoption has finished.
  // flushQueue (a cast is going out, the page is being hidden) saves at once.
  if (force !== true && store.castDevice && !cast.castStateFresh()) {
    store.playerSavePending = true;
    clearTimeout(store.playerSaveTimer);
    store.playerSaveTimer = setTimeout(saveQueueNow, 2000);
    return;
  }
  store.playerSavePending = false;
  if (!store.currentUser) return;
  // A controller's queue is a scratch pad while it controls another device: its saved
  // queue stays what it was before, and remote.js restores it on the way out.
  if (store.remoteTarget) return;
  try {
    const body = {
      queue: store.playerQueue,
      current_index: store.playerIndex,
      position_seconds: store.castDevice ? cast.castPosition() : (_activeDeckEl().currentTime || 0),
      volume: store.playerVolume,
      playlist_mode: store.playlistMode,
      shuffle_order: serializeShuffleOrder(),
      radio_mode: !!store.radioMode,
      radio_seed: store.radioSeedTrack || null,
    };
    const req = { method: 'PUT', body };
    // The page is being hidden (cast.js): a frozen page may never finish an ordinary
    // fetch, a keepalive one is carried on by the browser. Its body is limited to
    // 64 KiB — a queue row is ~245 bytes (measured), so about 250 rows fit; a longer
    // queue goes out as an ordinary request, as before.
    if (opts && opts.keepalive) {
      try { if (new TextEncoder().encode(JSON.stringify(body)).length <= KEEPALIVE_MAX_BYTES) req.keepalive = true; } catch {}
    }
    const res = await apiJson('/api/player/queue', req);
    // The file a controller fetches has changed only now (the save is debounced).
    document.dispatchEvent(new Event('remote:queue-saved'));
    return res;
  } catch {}
}

// Synchronous (awaitable) flush of the pending queue save — cancels the debounce
// timer and performs the PUT immediately. Used before engine-switch reloads so
// recent queue/position changes are persisted to the server before unload.
export async function flushQueue(opts) {
  clearTimeout(store.playerSaveTimer);
  return saveQueueNow(true, opts);
}

// Put `item` on the active deck WITHOUT playing it, to start at `pos` when the listener
// presses Play: the restored queue, and the hand-back when a cast ends (cast.js
// primeLocal — the receiver's position, even for a track the deck never held).
function _primeDeck(item, pos) {
  if (_restoreSeek) { _deckA.removeEventListener('loadedmetadata', _restoreSeek); _deckB.removeEventListener('loadedmetadata', _restoreSeek); _restoreSeek = null; }
  const deck = _activeDeckEl();
  const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: streamToken() });
  const restoreSrc = mixPlayUrl(item) || `/api/player/stream?${params}&quality=${streamQuality()}`;
  if (deck === _deckA) _expectedSrcA = _absUrl(restoreSrc);
  else _expectedSrcB = _absUrl(restoreSrc);
  _resetPitchMode(deck);
  deck.src = restoreSrc;
  deck.preload = 'none';
  _restorePos = pos > 0 ? pos : 0;
  if (pos > 0) {
    // preload is 'none', so this waits for whatever loads on the deck FIRST. If
    // that is not the restored track — the user opened the app and picked another
    // song — the saved position belonged to a different file: the new song
    // started in its middle, or past its end and was skipped outright. Seek only
    // if the deck still holds the restored source (the classic engine always did).
    // And only when the listener resumes it (Play): an explicit load of a track
    // — even the same one, from a playlist — starts at 0; _setDeckSrc drops this.
    const want = _absUrl(restoreSrc);
    _restoreSeek = () => {
      deck.removeEventListener('loadedmetadata', _restoreSeek);
      _restoreSeek = null;
      if (deck.src !== want) return;
      // A streamed mix whose build is not there any more (a deploy empties the cache):
      // the body cannot be sought yet — wait for the build, with visible state.
      if (isMixStreamSrc(deck.src)) {
        const gen0 = _loadGen;     // another load (even of another mix) ends this wait for good
        resumeWhenBuilt(deck, pos, (p) => _reloadFinishedAndSeek(deck, p, store.playerPlaying), () => deck === _activeDeckEl() && _loadGen === gen0);
      }
      else deck.currentTime = pos;
    };
    deck.addEventListener('loadedmetadata', _restoreSeek);
  }
}

// The server's cast follower played queue[idx] after the track that ended while this
// page slept (cast.js). Show it as the current track — it is already playing on the
// receiver, so nothing is loaded or cast. idx -1: the track is not in this queue.
function _adoptCastTrack(idx, track, saved) {
  const smart = _djSetting('smart_queue', 'off') !== 'off';
  const adopted = cast.adoptQueueIndex(idx, {
    shuffle: adoptShuffleIndex, restoreOrder: restoreShuffleOrder, saved,
    played: smart ? markPlayed : null,
  });
  if (!adopted) return;
  // Rows the follower appended while the page slept count against the tail's cap too.
  capAutoplayTail(AUTOPLAY_MAX);
  // The prediction was made for the track before this one.
  _predictedNextIdx = null;
  _predictedNextKey = null;
  _currentRecItem = null;
  const item = adopted || track || {};
  setArt($('#playerImg'), item.image);
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  syncFullPlayer();
  updateDownloadButtons(item);
  updateMediaSessionWith(item);
  renderQueue();
  saveQueueDebounced();
}

/** The transfer half of loadQueueState: queue, index, order, radio and playlist context
 *  — no deck source, no volume, no paint. */
async function _adoptTransferredQueue(data) {
  store.playerQueue = data.queue;
  store.playerIndex = data.current_index >= 0 ? data.current_index : 0;
  // After the queue, never before: the saved order is positions into it.
  restoreShuffleOrder(data.shuffle_order);
  // Radio refills from its seed; without these a transferred radio stopped (B15).
  if ('radio_mode' in data) {
    store.radioMode = !!data.radio_mode;
    store.radioSeedTrack = data.radio_seed || null;
  }
  // No playlist context (the server drops a named playlist the transfer does not
  // belong to): this device's own Up Next again, so the new queue is mirrored there
  // and never into the old named playlist.
  if (data.playlist_mode) store.playlistMode = data.playlist_mode;
  else {
    store.playlistMode = null;
    try { await (await import('./upnext.js')).initUpNext(); } catch {}
  }
  updatePlaylistBadge();
  renderQueue();
  import('./queue.js').then(m => m.updateSaveButton());
}

/** Restore the saved queue. `touchDeck: false` (a remote transfer) takes queue, index,
 *  order, radio and playlist context only: no deck source, no volume, no paint — the
 *  playing deck is left to loadAndPlay, which mixes into the new track. Resolves to the
 *  saved state when a queue was taken, else null. */
export async function loadQueueState({ touchDeck = true } = {}) {
  try {
    const data = await apiJson('/api/player/queue');
    if (data.queue && data.queue.length) {
      if (!touchDeck) { await _adoptTransferredQueue(data); return data; }
      store.playerQueue = data.queue;
      store.playerIndex = data.current_index >= 0 ? data.current_index : 0;
      // After the queue, never before: the saved order is positions into it.
      restoreShuffleOrder(data.shuffle_order);
      // Radio refills from its seed; without these a transferred radio stopped (B15).
      if ('radio_mode' in data) {
        store.radioMode = !!data.radio_mode;
        store.radioSeedTrack = data.radio_seed || null;
      }
      store.playerVolume = data.volume ?? 1.0;
      setVolume(store.playerVolume);
      $('#playerVolume').value = Math.round(store.playerVolume * 100);
      const item = store.playerQueue[store.playerIndex];
      if (item) {
        setArt($('#playerImg'), item.image);
        $('#playerTitle').textContent = item.name || '';
        $('#playerArtist').textContent = item.artist || '';
        _primeDeck(item, data.position_seconds);
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
      return data;
    }
  } catch {}
  return null;
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
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } _resumeLocalPlayback(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } _pauseLocalPlayback(); });
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
  keepMixAlive(_activeDeckEl);
  for (const d of [_deckA, _deckB]) { watchMixSrc(d, 'dj'); watchMixEvents(d, 'dj'); }   // what the element says about a streamed mix, to the server's log   // a streamed mix that is playing (or paused) is kept in the server's cache
  // WKWebView/Safari only start an AudioContext from inside a user-activated task, and
  // the engine reaches _ctx.resume() several awaits after the click that caused playback
  // — by then the activation may be spent. Resume straight from the raw gesture too, so
  // the graph is already live by the time a deck plays. Not `once`: the context is created
  // later than this listener and can be re-suspended (tab hidden, audio interruption).
  for (const evName of ['pointerdown', 'touchend', 'keydown']) {
    document.addEventListener(evName, () => {
      if (_ctx && _ctx.state !== 'running') _ctx.resume().catch(() => {});
    }, { capture: true });
  }
  setInterval(_stallWatchdog, 2000);
  // Audio events
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('play', () => {
      if (deck !== _activeDeckEl() && !_crossfading) return;
      updatePlayPauseIcon(true);
      const item = store.playerQueue[store.playerIndex];
      if (item) abPlay(item.name, item.artist);
    });
    deck.addEventListener('playing', () => {
      if (deck !== _activeDeckEl()) return;
      _errStreak = 0; // a track is audibly playing — the failure run is over
      { const _li = _currentRecItem || store.playerQueue[store.playerIndex]; if (_li) _learnDuration(deck, _li); }
      { // Audible now, whatever `pause` an outgoing deck reported on the way here.
        const _it = _currentRecItem || store.playerQueue[store.playerIndex];
        if (_it) abPlay(_it.name, _it.artist);
      }
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
      if (store.shuffleEnabled) {
        // Shuffle outranks Smart Queue at commit (_nextTrackInQueue) — so it must here.
        immediate = _upcomingItem();
      } else if (sm !== 'off' && _predictedNextIdx != null
          && _predictedNextIdx >= 0 && _predictedNextIdx < store.playerQueue.length) {
        // Prediction already bound (e.g. a previous playing event or pre-analysis already
        // ran) — reuse it: same track dot/crossfade/prefetch all target → no divergence.
        immediate = store.playerQueue[_predictedNextIdx];
      } else if (sm !== 'off') {
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
        if (!immediate) immediate = _upcomingItem(); // DJ data miss → sequential fallback
      } else {
        immediate = _upcomingItem();
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
      // A failed load can leave the deck paused. That is the error handler's business
      // (it is about to skip) — reporting it as a pause would tell the UI and the
      // Android shell that the listener stopped the music.
      if (deck.error) return;
      // Casting pauses the local decks; the receiver plays on. The icon follows the
      // receiver (cast.js poll) and the Android shell must not hear a pause — it would
      // drop its wake lock and let the page freeze mid-cast.
      if (cast.castOwnsLocalPause()) return;
      updatePlayPauseIcon(false);
      pausePrefetch();
      abPause();
    });
  });
  // Both decks need ended/error handlers
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('ended', () => {
      if (store.remoteTarget) return; // a controller plays nothing out and advances nothing
      // The OUTGOING deck of a hand mix played out: nothing is left to go back to.
      if (_deskMix && deck === _deskMix.outEl) { _deskEndMixImpl(true, { fromLoad: true }); return; }
      // The new track ended with the fader still mid-way: commit the mix, then this end is
      // an ordinary one — handled below, once (deskEndMix must not advance as well).
      if (_deskMix && deck === _activeDeckEl()) _deskEndMixImpl(true, { fromLoad: true });
      // Existing double-advance guard: an in-progress crossfade (_crossfading) or an
      // already-fired auto trigger (_crossfadeTriggered) is ALREADY handling the advance —
      // don't fire a second one. _advanceInFlight is covered by nextTrack's own latch.
      if (deck !== _activeDeckEl() || _crossfading || _crossfadeTriggered || !deck.src) return;
      // An `ended` far from the mix's real end (an element that took the edge of what it had
      // parsed for the end): reload the finished file where it stopped — once per 30 s.
      if (isPrematureMixEnd(deck, store.playerQueue[store.playerIndex]) && Date.now() - (deck._prematureAt || 0) > 30000) {
        deck._prematureAt = Date.now();
        console.warn(`[mix] premature ended at ${deck.currentTime.toFixed(1)}s — reloading from there`);
        _reloadFinishedAndSeek(deck, deck.currentTime || 0, true);
        return;
      }
      _noNextLatch = false; // the track played out; this advance is the real attempt
      if (store.repeatMode === 'one') {
        deck.currentTime = 0;
        deck.play().catch(() => {});
      } else {
        // Fix 4 safety net: this `ended` slipped through WITHOUT the auto crossfade having
        // fired (the trigger missed — e.g. _outDjData was null at the trigger window, or the
        // advance was swallowed). A bare nextTrack here would hard-cut. Request a blend so the
        // next track eases in instead of a silent cut. Only when a real next track can be
        // produced and we're not casting (cast has its own advance path).
        const hasNext = _canAdvance() || store.radioMode;
        if (hasNext && !store.castDevice) _endedBlend = true;
        nextTrack({ reason: 'ended' });
      }
    });
    deck.addEventListener('error', () => {
      if (store.remoteTarget) return; // a controller's deck: nothing to rescue or skip
      if (!_isExpectedSrc(deck)) return; // ignore deferred errors from previous sources
      // A hand mix decides by which deck failed: the new one failing keeps the old track
      // live (it is still what the audience hears), the old one failing commits the new.
      if (_deskMix && _deskMixValid()) {
        if (deck === _deskMix.inEl) {
          _deskEndMixImpl(false, { fromLoad: true });
          // Promoted to a commit (the old deck was dead too): the failing deck is the live one now.
          if (deck !== _activeDeckEl()) { _deskRevoke('error'); return; }
        }
        if (_deskMix && deck === _deskMix.outEl) { _deskEndMixImpl(true, { fromLoad: true }); return; }
      }
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
      // A streamed mix: ONE recovery path owns the deck (any source, progressive or the finished
      // file). An `error` event while it runs is part of the same failure; one that finds no
      // error on the element is the stale event of a load we replaced (WebKit fires them after a
      // src change) and is ignored.
      if (deck === _activeDeckEl() && isMixStreamSrc(deck.src) && store.playerQueue[store.playerIndex]?.mix_url) {
        if (deck._mixRec) return;
        if (!deck.error) { mixLog('error-stale', deck, {}, 'dj'); return; }
        _recoverMixError(deck);
        return;
      }
      // A connection that dropped part-way through a song (MEDIA_ERR_NETWORK) is not a
      // broken track. Now that this handler really runs for streams, skipping here
      // would throw away the rest of a song over one lost packet run — ask for the
      // same stream again from where it stopped, once, before giving the track up.
      if (deck === _activeDeckEl() && deck.error && deck.error.code === 2
          && deck.currentTime > 1 && _canRearm(deck)) {
        _rearmDeck(deck);
        return;
      }
      _skipAfterError(); // claims the advance synchronously, then skips after a backoff
    });
  });

  // Timeupdate on both decks, but only UI-update from active deck
  [_deckA, _deckB].forEach(deck => {
    deck.addEventListener('timeupdate', () => {
      if (deck !== _activeDeckEl()) return;
      _guardAudible(deck);
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
        const nextItem = _upcomingItem();
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
        // Never let the native side throw into this handler — the auto-crossfade
        // trigger sits below it.
        try { _ab().onProgress(Math.floor(deck.currentTime * 1000), Math.floor(dur * 1000)); } catch {}
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
          triggerAt = webkitCrossfadeDuration(_outDjData?.bpm, numBeats, _crossfadeDur());
          // #36: mirror the beat-grid clamp — on short tracks a long beat-derived fade
          // would trigger too early. Never trigger earlier than 25% from end, max 30s.
          if (triggerAt > dur * 0.25 || triggerAt > 30) triggerAt = _crossfadeDur();
        } else if (_outDjData && _outDjData.beat_grid && _outDjData.bpm) {
          // The same bounded count the scheduler fades over (fadeBeatsFor) — a lead
          // longer than the fade would leave the track's tail playing under nothing.
          const numBeats = fadeBeatsFor(_outDjData.bpm, parseInt(_djSetting('crossfade_beats', '16')) || 16);
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
        // The re-arm test below keeps using the full lead: a shortened one would re-arm
        // the trigger inside the window it has already fired in.
        const armAt = triggerAt;
        // A drop cut (clashing keys) silences the outgoing track at its cut point, so it
        // must START a few beats before the end, not a whole fade before it — else the
        // song's last ~8 s are never heard. Only when the incoming track is already in
        // memory: an uncached one needs the long lead to cover its load, and the
        // scheduler then blends instead (see resolveTransitionStyle / endBound in djmix).
        // Looked up only inside the window, from the same sources commit will use.
        if (!IS_WEBKIT && remaining <= triggerAt && !_crossfadeTriggered && _outDjData) {
          const up = _upcomingItem();
          if (up) {
            const upName = _decodeEntities(up.name || ''), upArtist = _decodeEntities(up.artist || '');
            const planned = resolveTransitionStyle(_djSetting('transition_style', 'auto'), _outDjData, getDjData(upName, upArtist));
            if (planned === 'drop_cut' && getCachedUrl(upName, upArtist, up.id)) {
              triggerAt = Math.min(triggerAt, dropCutLead(_outDjData.bpm) + 0.4);
            }
          }
        }
        if (remaining <= triggerAt && remaining > -5 && !_crossfadeTriggered && !_noNextLatch
            && !_deskManual // DJ desk in manual mode: the DJ mixes; a track left alone ends and continues via `ended`
            && !_advanceInFlight && store.repeatMode !== 'one' && !store.castDevice
            && deck.currentTime > 10) { // don't trigger in first 10s
          // Radio refills at the end of the queue; without it here the last track of
          // every batch ran to its end and the refill then started from silence.
          const hasNext = _canAdvance() || (store.radioMode && !store.radioLoading);
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
        if (remaining > armAt + 1) {
          _crossfadeTriggered = false;
          _noNextLatch = false;
        }
      }
    });
  });
  // (error handlers registered in the deck loop above)

  // Controls
  $('#playerPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      cast.castToggle();
    } else {
      _ensureAudioContext();
      if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
      const deck = _activeDeckEl();
      if (_stopErrorBackoff()) {
        // stopped the pending retry — nothing else to do
      } else if (_toggleDeadDeck(deck)) {
        // a deck that failed to load: stop it, or try the track again
      } else if (deck.paused) {
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
      setVolume(store.playerVolume);
    }
  });
  async function _seekFromEvent(bar, e) {
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    // Under remote control the target seeks (B6): the touchstart below suppresses the
    // click remote.js listens for, and this device's own deck is paused anyway.
    if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'seek_pct', value: pct } })); return; }
    // The local deck never holds the cast track: its duration is another track's.
    const dur = cast.castSeekDuration(_getDuration);
    if (!dur) return;
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      seekLocal(pct * dur);
    }
  }
  const miniBar = $('#playerProgressBar');
  miniBar.addEventListener('click', (e) => _seekFromEvent(miniBar, e));
  miniBar.addEventListener('touchstart', (e) => { e.preventDefault(); _seekFromEvent(miniBar, e); }, { passive: false });

  // Under remote control the bar shows the target's track; the per-track buttons act on
  // that one (B7), never on this device's stale queue row.
  const _remoteTrack = () => (store.remoteDevices[store.remoteTarget] || {}).track || null;

  // Add to playlist
  async function _addToPlaylist() {
    // Prefer the currently displayed track (recommended item if rec is playing)
    const item = store.remoteTarget ? _remoteTrack()
      : (typeof _currentRecItem !== 'undefined' && _currentRecItem)
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
      if (!store.remoteTarget && store.playlistMode && store.playlistMode.id === picked.id) {
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
    // The playlist the target plays from is not this device's playlistMode, and a
    // remove by name cannot say which row — not something to guess from here.
    if (store.remoteTarget) {
      const dev = store.remoteDevices[store.remoteTarget];
      showToast(`Remove it on ${(dev && dev.name) || 'the playing device'}`);
      return;
    }
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
    const item = store.remoteTarget ? _remoteTrack()
      : store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
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
  _recs(); // load the recommender now: the first cast already wants its picks
  cast.initCast({
    getAudioEl: getAudio, nextTrack, syncVolume: () => setVolume(store.playerVolume),
    getUpcoming: () => { const i = _upcomingIdx(); return i == null ? null : { index: i, item: store.playerQueue[i] }; },
    adoptTrack: _adoptCastTrack,
    peekAutoplay: _castPeekAutoplay,
    appendAutoplayRows: _castAppendAutoplay,
    pauseLocal,
    resumeLocal: _resumeLocalPlayback,
    flushQueue,
    onCastPlaying: updatePlayPauseIcon,
    localPosition: () => (_currentRecItem ? 0 : (_restoreSeek ? _restorePos : (_activeDeckEl().currentTime || 0))),
    primeLocal: (idx, pos) => { const it = _currentRecItem || store.playerQueue[idx]; if (it) _primeDeck(it, pos); },
  });
  cast.wireControls();

  // Play button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-play-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    // A song started from inside a list takes the rest of that list with it,
    // the way it does on Spotify — otherwise playback stops after one track.
    const { queueFromContext } = await import('./playcontext.js');
    const ctx = queueFromContext(card, item);
    const u = await import('./upnext.js');
    if (ctx) { u.playTracks(ctx.tracks, ctx.index); return; }
    const tracks = await resolveItemTracks(item);
    if (tracks.length) u.playTracks(tracks);
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
    // Under remote control every key drives the target (B21), whatever this device holds.
    if (store.remoteTarget) {
      const cmd = { Space: { action: 'toggle' }, ArrowRight: { action: 'next' }, ArrowLeft: { action: 'prev' },
        ArrowUp: { action: 'volume_step', value: 0.05 }, ArrowDown: { action: 'volume_step', value: -0.05 } }[e.code];
      if (!cmd) return;
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('remote:cmd', { detail: cmd }));
      return;
    }
    if (!store.playerQueue.length && !_activeDeckEl().src) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (store.castDevice) {
          cast.castToggle();
        } else {
          _ensureAudioContext();
          if (_ctx.state !== 'running') _ctx.resume().catch(() => {});
          const deck = _activeDeckEl();
          if (_stopErrorBackoff()) {
            // stopped the pending retry
          } else if (_toggleDeadDeck(deck)) {
            // failed deck: stop, or retry the track
          } else if (deck.paused) {
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
        else setVolume(store.playerVolume);
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else setVolume(store.playerVolume);
        break;
    }
  });

  // Periodic save while playing
  // Not while a cast view may be stale (page just woke): the server's follower may have
  // moved current_index on, and this save would put the old one back.
  setInterval(() => { if (store.playerPlaying && store.currentUser && cast.castStateFresh()) saveQueueNow(); }, 30000);

  // Save on page unload (sync XHR since sendBeacon can't set auth headers)
  window.addEventListener('beforeunload', () => {
    // While casting, the server's follower writes this file too: a page that merely woke
    // up must not write its pre-sleep queue over it — but an edit still waiting to be
    // saved is never dropped (cast.castMaySaveOnUnload has the rule).
    if (store.playerQueue.length && store.currentUser && !store.remoteTarget
        && cast.castMaySaveOnUnload()) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/player/queue', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        const token = store.authToken;
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        // Same slot and same shape as saveQueueNow: without the device id this wrote
        // the "default" queue instead of this device's, and without shuffle_order it
        // would erase the saved running order the moment it did reach the right one.
        if (store.deviceId) xhr.setRequestHeader('X-Device-ID', store.deviceId);
        xhr.send(JSON.stringify({
          queue: store.playerQueue, current_index: store.playerIndex,
          position_seconds: store.castDevice ? cast.castPosition() : (_activeDeckEl().currentTime || 0), volume: store.playerVolume,
          playlist_mode: store.playlistMode,
          shuffle_order: serializeShuffleOrder(),
          radio_mode: !!store.radioMode,
          radio_seed: store.radioSeedTrack || null,
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


// ══ DJ desk hooks (dj-pult, 2026-11-19) ══
// The DJ desk (djdesk.js) and the headphone cue (cuebus.js) reach the engine ONLY through
// the desk* exports below; nothing else in the engine knows the desk exists. The model:
//  - The desk BORROWS the inactive deck (deskLend). A lent deck keeps its crossfade gain
//    at 0, so it is silent in the master; the cue bus taps it before that gain. Every
//    event handler and watchdog above already ignores the inactive deck outside a
//    transition, so a lent deck cannot trigger a skip, a stall rescue, a saved position,
//    the media session or the Android bridge.
//  - Any load (_loadAndPlayImpl, playRecTrack) takes the deck back FIRST (_deskOnLoad):
//    the engine never has a second idea of which deck is its own.
//  - "What plays next" stays ONE answer: a hand-picked next track is an input to
//    _upcomingIdx() (and to the commit), not a parallel notion.
//  - A manual crossfader mix (deskBeginMix) makes the lent deck the active deck at once
//    and runs as a crossfade the user drives (_crossfading true, _fadingOutDeck set), so
//    every existing guard treats it as a transition in progress.
let _deskLoan = null;     // { key, el, item, index, gen } — the inactive deck, lent to the desk
let _deskManual = false;  // desk in manual mode: the auto-trigger never fires
let _deskNext = null;     // { idx, key } — the next track picked on the desk
let _deskStartAt = null;  // { t, key } — one-shot start position, only for the track the desk mixes in
let _deskMix = null;      // manual crossfader mix in progress
let _deskCurItem = null, _deskPrevItem = null; // what the active deck holds / held before it

function _deskEmit(type, detail = {}) {
  try { document.dispatchEvent(new CustomEvent('desk:engine', { detail: { type, ...detail } })); } catch {}
}
function _deskKeyOf(el) { return el === _deckA ? 'A' : 'B'; }
function _deskEl(key) { return key === 'A' ? _deckA : (key === 'B' ? _deckB : null); }
function _deskNodes(key) { return key === 'A' ? _nodesA : _nodesB; }
function _deskBlocked() {
  if (store.castDevice) return 'cast';
  if (store.remoteTarget) return 'remote';
  if (_currentRecItem) return 'rec';
  return null;
}
function _deskTrackItem(item) {
  // The hand-picked next track is playing now (it came up by any route — a queue row
  // too): it has been served, or it would come round a second time after this one.
  if (_deskNext && item && _smartKey(item) === _deskNext.key) _deskNext = null;
  if (item === _deskCurItem) return;
  _deskPrevItem = _deskCurItem;
  _deskCurItem = item;
}
function _deskData(item) {
  return item ? getDjData(_decodeEntities(item.name || ''), _decodeEntities(item.artist || '')) || null : null;
}
function _deskQueueIndex(item, hint) {
  const q = store.playerQueue;
  if (!item) return null;
  if (Number.isInteger(hint) && hint >= 0 && hint < q.length && q[hint] === item) return hint;
  const i = q.indexOf(item);
  if (i >= 0) return i;
  const k = _smartKey(item);
  const j = q.findIndex(it => it && _smartKey(it) === k);
  return j >= 0 ? j : null;
}
/** The hand-picked next track, re-found by identity if a queue edit moved it. */
function _deskForcedIdx() {
  const f = _deskNext;
  if (!f) return null;
  const q = store.playerQueue;
  if (!(f.idx >= 0 && f.idx < q.length && q[f.idx] && _smartKey(q[f.idx]) === f.key)) {
    const j = q.findIndex(it => it && _smartKey(it) === f.key);
    if (j < 0) { _deskNext = null; return null; }
    f.idx = j;
  }
  return f.idx === store.playerIndex ? null : f.idx;
}
/** A deck the engine is about to use again. The lent one comes back clean. */
function _deskRevoke(reason, { handover = false } = {}) {
  const loan = _deskLoan;
  if (!loan) return;
  _deskLoan = null;
  const el = loan.el;
  if (handover) {
    // The engine is loading this very deck right now: its source and gains are the
    // load's business — clearing them would empty the deck it is about to swap to.
    el.volume = _activeDeckEl().volume;
    _deskEmit('revoked', { reason, key: loan.key });
    return;
  }
  try { el.pause(); } catch {}
  clearPendingSeek(el);
  if (el === _deckA) _expectedSrcA = ''; else _expectedSrcB = '';
  try { el.src = ''; } catch {}
  el._msLearned = null;
  if (_ctx) {
    resetDeckAfterTransitionV3(_deckDesc(el)); // rate 1, EQ open, crossfade gain 0
    const n = _deskNodes(loan.key);
    if (n) n.levelGain.gain.value = 1;
  }
  el.volume = _activeDeckEl().volume; // the master level, as setVolume would have set it
  _deskEmit('revoked', { reason, key: loan.key });
}
/** Called by every load: the decks are the engine's again. */
function _deskOnLoad() {
  // Settle a hand mix by the fader before the load touches the decks: killing the deck
  // the audience mostly hears and fading out of one at 16 % was a cut to near-silence.
  _deskSettleMix({ fromLoad: true, keepIndex: true });
  _deskRevoke('advance');
}
function _deskSettleMix(opts = {}) {
  if (!_deskMixValid()) return;
  _deskEndMixImpl(_deskMix.level >= 0.5, opts);
}
function _deskMixValid() {
  const m = _deskMix;
  if (!m) return false;
  if (_crossfading && _fadingOutDeck === m.outEl && _activeDeckEl() === m.inEl) return true;
  // Something else (a load error, a teardown) ended it under the desk's feet.
  _deskMix = null;
  _deskEmit('mixend', { commit: _activeDeckEl() === m.inEl, superseded: true });
  return false;
}
function _deskAnnounce(item) {
  if (!item) return;
  setArt($('#playerImg'), item.image);
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  showPlayerBar();
  updatePlayPauseIcon(!_activeDeckEl().paused);
  syncFullPlayer();
  updateDownloadButtons(item);
  renderQueue();
  saveQueueDebounced();
  updateMediaSession();
  resolveSource(item);
  updatePlaylistBadge();
  if (!_activeDeckEl().paused) abPlay(item.name, item.artist);
}
/** The new "next" is what prefetch and pre-analysis warm — as repickNext does. */
function _deskWarmNext() {
  const up = _upcomingItem();
  if (up) {
    const n = _decodeEntities(up.name || ''), a = _decodeEntities(up.artist || '');
    if (!_crossfading) _inDjData = getDjData(n, a) || null;
    resumePrefetch();
    prefetchTrack(n, a, up.id);
  }
  try { renderQueue(); } catch { /* panel closed */ }
}

/** The audio graph, for the cue bus. Creates the context (call it from a gesture). */
export function deskGraph() {
  if (store.castDevice || store.remoteTarget) return null;
  _ensureAudioContext();
  if (!_ctx) return null;
  return { ctx: _ctx, master: _master, nodes: { A: _nodesA, B: _nodesB }, els: { A: _deckA, B: _deckB } };
}

/** Everything the desk draws, in one read. Keys are PHYSICAL decks (A = #audioElement). */
export function deskInfo() {
  _deskMixValid();
  const active = _activeDeck;
  const fading = _fadingOutDeck ? _deskKeyOf(_fadingOutDeck) : null;
  const items = { A: null, B: null }, data = { A: null, B: null };
  const cur = _currentRecItem || store.playerQueue[store.playerIndex] || null;
  items[active] = cur;
  data[active] = (cur && cur === _deskCurItem && _outDjData) ? _outDjData : _deskData(cur);
  if (_deskLoan) {
    items[_deskLoan.key] = _deskLoan.item;
    data[_deskLoan.key] = _deskData(_deskLoan.item);
  } else if (_deskMix) {
    const k = _deskKeyOf(_deskMix.outEl);
    items[k] = _deskMix.prevItem;
    data[k] = _deskMix.prevOut || _deskData(_deskMix.prevItem);
  } else if (fading) {
    items[fading] = _deskPrevItem;
    data[fading] = _deskData(_deskPrevItem);
  }
  return {
    ready: !!_ctx,
    active, fading,
    crossfading: _crossfading,
    mixing: !!_deskMix,
    mixLevel: _deskMix ? _deskMix.level : null,
    loan: _deskLoan ? _deskLoan.key : null,
    loanIndex: _deskLoan ? (_deskLoan.index = _deskQueueIndex(_deskLoan.item, _deskLoan.index)) : null,
    manual: _deskManual,
    busy: _advanceInFlight || !!_errRetryTimer,
    blocked: _deskBlocked(),
    volume: _activeDeckEl().volume,
    index: store.playerIndex,
    next: _upcomingIdx(),
    deskNext: _deskForcedIdx(),
    playing: !_activeDeckEl().paused,
    items, data,
  };
}

/** Lend the inactive deck to the desk. null when the engine needs it or cannot lend. */
export function deskLend() {
  if (_deskLoan) return _deskLoan.key;
  if (_deskBlocked() || _crossfading || _advanceInFlight || _errRetryTimer || _loadsPending > 0) return null;
  if (!deskGraph()) return null;
  const el = _inactiveDeckEl();
  try { el.pause(); } catch {}
  clearPendingSeek(el);
  resetDeckAfterTransitionV3(_deckDesc(el)); // crossfade gain 0 = nothing of it in the master
  _inactiveLevel().gain.value = 1;
  el.volume = 1;            // its level is the cue bus's business, not the master fader's
  el._deskDriven = true; // the lent deck is the desk's: its mode is set now, while it is silent
  _deskPitchMode(el);
  _deskLoan = { key: _deskKeyOf(el), el, item: null, index: null, gen: 0 };
  return _deskLoan.key;
}

/** Load a track onto the lent deck. Resolves true when it can play. Never touches the
 *  saved-position restore (_restoreSeek) the way _setDeckSrc would. */
export async function deskLoad(item, { startAt = 0, play = true, index = null, warm = true } = {}) {
  const loan = _deskLoan;
  if (!loan || !item) return false;
  const gen = ++loan.gen;
  const el = loan.el;
  const name = _decodeEntities(item.name || ''), artist = _decodeEntities(item.artist || '');
  loan.item = item;
  loan.index = _deskQueueIndex(item, index);
  // The finished file, not a progressive body: the desk scrubs and sets cue points in it.
  // The blob is warmed alongside so a later transition can start at the cue point — but
  // only for a track loaded to be MIXED (warm): a quick listen must not jump the queue of
  // the engine's own next-track download (3 at a time, newest first), nor cost a second
  // YouTube fetch of a track nobody owns.
  if (warm) { resumePrefetch(); if (!item.mix_url) prefetchTrack(name, artist, item.id); }   // never a whole set by title
  const cached = getCachedUrl(name, artist, item.id);
  const src = cached || mixPlayUrl(item) || `/api/player/stream?${new URLSearchParams({ name, artist, token: streamToken() })}&quality=${streamQuality()}`;
  clearPendingSeek(el);
  try { el.pause(); } catch {}
  el.playbackRate = 1;
  el._msLearned = null;
  if (el === _deckA) _expectedSrcA = _absUrl(src); else _expectedSrcB = _absUrl(src);
  el.src = src;
  el.load();
  const at = Number(startAt) || 0;
  if (at > 0) {
    const onMeta = () => {
      el.removeEventListener('loadedmetadata', onMeta);
      if (el._msSeekOnMeta === onMeta) el._msSeekOnMeta = null;
      if (_deskLoan !== loan || loan.gen !== gen) return;
      try { el.currentTime = at; } catch {}
    };
    el._msSeekOnMeta = onMeta; // clearPendingSeek drops it if the deck is reused first
    el.addEventListener('loadedmetadata', onMeta);
  }
  if (play) el.play().catch(() => {});
  await _waitForCanPlay(el, 4000);
  if (_deskLoan !== loan || loan.gen !== gen) return false;
  return !el.error;
}

/** Give the lent deck back. */
export function deskRelease() { _deskRevoke('release'); }

/** Length of what a deck holds (learned lengths included); 0 when unknown. */
export function deskDur(key) {
  const el = _deskEl(key);
  if (!el) return 0;
  const d = el === _activeDeckEl() ? _getDuration() : _deckDur(el);
  return d && isFinite(d) && d > 0 ? d : 0;
}

/** Bind queue[idx] as what plays next (null clears). Under shuffle it is moved to the
 *  head of the shuffle order (as a drag in the queue panel would), so the permutation
 *  carries on after it instead of playing it twice. */
export function deskSetNext(idx) {
  if (idx == null) { _deskNext = null; _deskWarmNext(); return true; }
  const q = store.playerQueue;
  if (!Number.isInteger(idx) || idx < 0 || idx >= q.length || idx === store.playerIndex) return false;
  _deskNext = null;
  if (store.shuffleEnabled && q.length > 1) {
    const order = playOrder();
    const from = order.indexOf(idx), to = order.indexOf(store.playerIndex) + 1;
    if (from > to) moveInPlayOrder(from, to);
    if (peekShuffleNext() === idx) { _deskWarmNext(); return true; }
  }
  _deskNext = { idx, key: _smartKey(q[idx]) };
  _deskWarmNext();
  return true;
}

/** An ordinary engine transition, started now, into the next track (deskSetNext first).
 *  startAt = where the incoming track starts — honoured when its audio is cached, as the
 *  intro skip is; the beat alignment may move it by less than a beat. */
export function deskMixNow({ startAt = null } = {}) {
  if (_deskBlocked() || _crossfading || _advanceInFlight || _errRetryTimer) return false;
  if (_upcomingIdx() == null) return false;
  const deck = _activeDeckEl();
  if (deck.paused || !deck.src) return false;
  _deskRevoke('mixnow');
  const t = Number(startAt);
  // Keyed by the TRACK, not by a load counter: nextTrack reaches the load only after an
  // import(), and a queue-row load started in between would have taken a counter value.
  const target = _upcomingItem();
  _deskStartAt = Number.isFinite(t) && t > 0 && target ? { t, key: _smartKey(target) } : null;
  nextTrack({ reason: 'desk' });
  return true;
}

/** Manual mode: no automatic transition. A track left alone still continues into the next
 *  one when it ends (the `ended` path), so the music never stops. */
export function deskSetManual(on) { _deskManual = !!on; }

/** Start a crossfader mix: the lent deck (holding a queue track, playing) is the live
 *  track from this moment; the previous one keeps playing as the outgoing deck. */
export function deskBeginMix() {
  const loan = _deskLoan;
  if (!loan || _deskMix || _deskBlocked() || _crossfading || _advanceInFlight || _errRetryTimer) return false;
  const idx = _deskQueueIndex(loan.item, loan.index);
  if (idx == null || idx === store.playerIndex) return false;
  const inEl = loan.el, outEl = _activeDeckEl();
  if (inEl.paused || inEl.error || !inEl.src) return false;
  _teardownCrossfade();
  clearInterval(_rateReturnTimer);
  _loadGen++;    // a load still waiting must not tear this down afterwards
  _analyzeGen++; // nor may a pre-analysis for the previous track bind its prediction
  const prevIdx = store.playerIndex;
  const prevItem = store.playerQueue[prevIdx] || null;
  const prevOut = _outDjData;
  _deskLoan = null; // not a revoke: the desk keeps showing this deck, now as the live one
  _fadingOutDeck = outEl;
  _activeDeck = _deskKeyOf(inEl);
  _crossfading = true;
  _deskMix = { outEl, inEl, prevIdx, prevItem, prevOut, item: loan.item, index: idx, level: 0 };
  inEl.volume = outEl.volume; // the master fader applies to it from now on
  _outDjData = _deskData(loan.item);
  _inDjData = null;
  _activeLevel().gain.value = _levelGainFor(_outDjData?.lufs);
  if (_djSetting('smart_queue', 'off') !== 'off' && prevItem) markPlayed(prevItem);
  _predictedNextIdx = null; _predictedNextKey = null;
  if (_deskNext && _deskForcedIdx() === idx) _deskNext = null;
  _deskMix.shuffleNote = noteShuffleJump(prevItem, store.playerQueue[idx]);
  store.playerIndex = idx;
  _crossfadeTriggered = false; _noNextLatch = false;
  _deskTrackItem(loan.item);
  _deskMixApply(0);
  _deskAnnounce(loan.item);
  resumePrefetch();
  { const up = _upcomingItem(); if (up) prefetchTrack(_decodeEntities(up.name || ''), _decodeEntities(up.artist || ''), up.id); }
  _preAnalyzeUpcoming();
  _deskEmit('mixstart', { active: _activeDeck });
  return true;
}
function _deskMixApply(t) {
  const m = _deskMix;
  if (!m || !_ctx) return;
  const x = Math.max(0, Math.min(1, Number(t) || 0));
  m.level = x;
  const now = _ctx.currentTime;
  const gIn = _deskNodes(_deskKeyOf(m.inEl)).gain.gain;
  const gOut = _deskNodes(_deskKeyOf(m.outEl)).gain.gain;
  // Equal power, smoothed so a dragged fader does not zipper.
  for (const [g, v] of [[gIn, Math.sin(x * Math.PI / 2)], [gOut, Math.cos(x * Math.PI / 2)]]) {
    g.cancelScheduledValues(now);
    g.setTargetAtTime(v, now, 0.015);
  }
}
/** Crossfader position during a mix: 0 = only the outgoing deck, 1 = only the new one. */
export function deskMixLevel(t) {
  if (!_deskMixValid()) return false;
  _deskMixApply(t);
  return true;
}
/** End the mix. commit: the outgoing deck stops. Otherwise the previous track is the live
 *  one again and the new deck goes back to the desk, still playing in the headphones. */
export function deskEndMix(commit) { return _deskEndMixImpl(commit); }
function _deskEndMixImpl(commit, { fromLoad = false, keepIndex = false } = {}) {
  if (!_deskMixValid()) return false;
  const m = _deskMix;
  // Going back to a deck that already ended or failed would leave the master silent
  // with nothing to advance it: the new track stays instead.
  if (!commit && (m.outEl.ended || m.outEl.error || !m.outEl.src)) commit = true;
  _deskMix = null;
  const gIn = _deskNodes(_deskKeyOf(m.inEl)).gain.gain;
  const gOut = _deskNodes(_deskKeyOf(m.outEl)).gain.gain;
  if (commit) {
    try { m.outEl.pause(); } catch {}
    m.outEl.src = '';
    resetDeckAfterTransitionV3(_deckDesc(m.outEl));
    gIn.cancelScheduledValues(0); gIn.value = 1;
    _fadingOutDeck = null;
    _crossfading = false;
    prefetchCleanup(store.playerQueue, store.playerIndex, _upcomingKeep());
    resumePrefetch();
    _deskEmit('mixend', { commit: true, active: _activeDeck });
    // A new track that ended while the fader sat in the middle advances now (its own
    // `ended` was swallowed by the transition guard), as the crossfade timer does.
    if (!fromLoad && _activeDeckEl().ended && !_advanceInFlight && store.repeatMode !== 'one') nextTrack({ reason: 'ended' });
    return true;
  }
  _activeDeck = _deskKeyOf(m.outEl);
  _fadingOutDeck = null;
  _crossfading = false;
  // Outside a load: a load still waiting must not carry on over the restored track. Inside
  // one (keepIndex) the load has just taken its generation — bumping it would void that
  // very load, and the track the user asked for would never play.
  if (!keepIndex) { _loadGen++; _analyzeGen++; }
  gOut.cancelScheduledValues(0); gOut.value = 1;
  gIn.cancelScheduledValues(0); gIn.value = 0;
  const back = _deskQueueIndex(m.prevItem, m.prevIdx);
  // Inside a load the caller has already chosen the index it is about to play; the
  // decks are put back, the queue position is the load's.
  if (!keepIndex) { undoShuffleJump(m.prevItem, m.item, m.shuffleNote); if (back != null) store.playerIndex = back; }
  _outDjData = m.prevOut || _deskData(m.prevItem);
  _inDjData = null;
  _predictedNextIdx = null; _predictedNextKey = null;
  m.inEl.volume = 1;
  { const n = _deskNodes(_deskKeyOf(m.inEl)); if (n) n.levelGain.gain.value = 1; } // as deskLend leaves it
  _deskLoan = { key: _deskKeyOf(m.inEl), el: m.inEl, item: m.item, index: _deskQueueIndex(m.item, m.index), gen: 0 };
  if (!keepIndex) {
    _deskTrackItem(m.prevItem);
    _deskAnnounce(m.prevItem);
    _preAnalyzeUpcoming();
  }
  _deskEmit('mixend', { commit: false, active: _activeDeck });
  return true;
}

/** Tempo of one deck. On the live deck it stops the post-transition return to 1.0 and
 *  the beat-sync PLL, which would otherwise overwrite the DJ's setting. Refused while an
 *  engine transition runs — the transition owns both rates then. */
export function deskSetRate(key, rate) {
  const el = _deskEl(key);
  if (!el) return false;
  if (_crossfading && !_deskMixValid()) return false;
  const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
  const live = el === _activeDeckEl() || (_deskMix && el === _deskMix.outEl);
  if (live) {
    clearInterval(_rateReturnTimer);
    _cancelTempoRamp();
    clearTimeout(_beatSyncStartTimer); _beatSyncStartTimer = null;
    if (_beatSync) { _beatSync.stop(); _beatSync = null; }
  } else if (!(_deskLoan && el === _deskLoan.el)) return false;
  // The live deck becomes the desk's only when its tempo really leaves the original:
  // opening the desk, or pressing "0" on an untouched deck, changes nothing about it.
  if (r !== 1 || el._deskDriven) { el._deskDriven = true; _deskPitchMode(el); }
  el.playbackRate = r;
  return true;
}

/** Key lock on the desk. OFF (the default) = the pitch fader works like a turntable: the
 *  key moves with the tempo. ON = the browser time-stretches, and Chromium clicks every
 *  time the rate enters or leaves the narrow zone around 1.0 (measured: 18 clicks in 20
 *  crossings with it, 0 without) — i.e. on every touch of a fader resting at zero and on
 *  every nudge. Switching `preservesPitch` itself clicks too (18 in 20, even at rate 1),
 *  so it is switched as rarely as possible: on a deck the desk DRIVES (`_deskDriven`: the
 *  lent deck, and a live deck once the desk moved its tempo off 1), never on a deck it
 *  merely shows. Without key lock such a deck is `_deskVinyl`; the engine's transitions
 *  leave it alone while its rate is not 1 (djmix.js `keyLockForTransition`) and every
 *  engine load gives the lock back (`_resetPitchMode`). */
let _deskKeyLock = false;
function _deskPitchMode(el) {
  if (el.preservesPitch !== _deskKeyLock) el.preservesPitch = _deskKeyLock;
  el._deskVinyl = !_deskKeyLock;
}
export function deskSetKeyLock(on) {
  _deskKeyLock = !!on;
  if (_crossfading && !_deskMixValid()) return _deskKeyLock; // an engine transition owns both decks; the next desk move applies it
  const els = new Set([_deskLoan && _deskLoan.el, _activeDeckEl(), _deskMix && _deskMix.outEl, _deskMix && _deskMix.inEl]);
  for (const el of els) if (el && el._deskDriven) _deskPitchMode(el);
  return _deskKeyLock;
}
export function deskKeyLock() { return _deskKeyLock; }

/** Seek a deck: the live one through seekLocal (it handles progressive streams). */
export function deskSeek(key, t) {
  const el = _deskEl(key);
  const to = Math.max(0, Number(t) || 0);
  if (!el) return false;
  if (_deskLoan && el === _deskLoan.el) { try { el.currentTime = to; } catch {} return true; }
  if (_deskMix && (el === _deskMix.inEl || el === _deskMix.outEl)) { try { el.currentTime = to; } catch {} return true; }
  if (el === _activeDeckEl() && !_crossfading) { seekLocal(to); return true; }
  return false;
}
