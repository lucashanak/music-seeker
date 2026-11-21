// cast.js — shared DLNA cast cluster for both player engines.
//
// This logic was triplicated byte-for-byte across player.js / player_v2.js /
// player_v3.js (the only per-engine difference was the active audio element). It now
// lives here once. Engines inject their specifics via initCast({...}) and call
// wireControls() in init(). cast.js imports only leaf utils (no engine import), so
// there is no circular dependency.
//
// WHO ADVANCES THE QUEUE (cast-opravy, 2026-11-19). A phone page freezes its timers
// whenever the screen goes off, and a 1–2 h mix always outlives the screen. So while a
// cast is active the SERVER watches the receiver and casts the next track itself; it
// says so with `status.follow === true`. The page then does no end-of-track or stall
// logic of its own: it shows the state, sends what the user does, tells the server
// what it would play next (/api/dlna/next-hint) and, when the server has moved on
// (`cast_seq` newer than the last one we know, another track), ADOPTS that track
// without casting it again. Without `follow` (an older server) the page runs the old
// algorithm, with the position extrapolated across poll gaps.
//
// Engine hooks (all optional, passed to initCast):
//   getAudioEl()           the active local <audio>
//   nextTrack()            the engine's Next (fallback auto-advance only)
//   syncVolume()           re-apply the UI volume to the local element(s)
//   getUpcoming()          {index, item} the engine would play after the current one, or null
//   adoptTrack(idx, track) the server cast queue[idx] — make it current (adoptQueueIndex:
//                          Smart Queue + shuffle bookkeeping), show it, save; NO cast.
//                          A track that is in no row is not adopted at all.
//   peekAutoplay(n)        what the recommender would play once the queue is over: a
//                          list, [] = nothing, null = not known yet; consumes nothing
//   appendAutoplayRows(items, at, kind) rows the server appended: put them into
//                          store.playerQueue (same array; at the end and behind the
//                          "Autoplay" divider, or at index `at`), tell the recommender.
//                          kind 'radio': the server refilled a radio queue — plain rows,
//                          no divider, nothing for the recommender
//   pauseLocal()           pause BOTH local decks (and the prefetch)
//   resumeLocal()          a cast that failed to start: local playback carries on
//   onCastPlaying(bool)    sync the play/pause icon (store.playerPlaying)
//   localPosition()        seconds into the current item on the local deck
//   primeLocal(idx, pos)   after a cast ends: load queue[idx] paused, so Play continues at pos

import { store } from './store.js';
import { $, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';
import { abPlay, abPause, abProgress } from './androidbridge.js';

// ── Engine-injected context ──
let _ctx = { getAudioEl: () => null, nextTrack: () => {} };
export function initCast(ctx) { _ctx = { ..._ctx, ...ctx }; }

const POLL_MS = 2000;       // status poll period while things answer
const POLL_MAX_MS = 30000;  // ceiling of the back-off after failed polls
const GAP_MS = 6000;        // a gap between polls longer than this = the page was asleep
const STATUS_TIMEOUT_MS = 8000; // a status request is abandoned after this
const FLUSH_TIMEOUT_MS = 3000;  // a queue save before a cast is waited for at most this
const AUTOPLAY_SEND = 20;       // recommender picks handed to the server (its own bound)

function _dec(s) {
  if (!s || !s.includes('&')) return s || '';
  try {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  } catch { return s; }
}
function _key(it) {
  return it ? `${_dec(it.name || '').toLowerCase()}\u0001${_dec(it.artist || '').toLowerCase()}` : '';
}
// The server's model takes an int; a fractional catalogue value would be a 422.
function _ms(v) { const n = Math.round(Number(v) || 0); return n > 0 ? n : 0; }
function _call(fn, ...args) { try { return fn ? fn(...args) : undefined; } catch { return undefined; } }

// Fetch known renderers; if none are known yet (cold start / no prior scan), kick a
// one-shot LAN scan so casting works without the user opening Settings → Scan first.
// The backend also runs a periodic background scan, so this is usually a no-op.
async function _getDevicesOrScan() {
  const data = await apiJson('/api/dlna/devices');
  let devices = data.devices || [];
  if (!devices.length) {
    try {
      const scan = await apiJson('/api/dlna/scan', { method: 'POST' });
      devices = scan.devices || [];
    } catch { /* fall through with empty list */ }
  }
  return devices;
}

// Resolve the renderer the user actually chose.
//
// The stored preference is a descriptor URL (the backend also accepts it as a manual
// renderer, so the field has to stay a URL) — and that URL embeds the renderer's IP.
// A DHCP lease change therefore invalidates the setting: the Onkyo moved from
// 192.168.1.95 to 192.168.1.45 and the saved URL matched nothing, so casting silently
// fell through to devices[0] — the projector. Picking a DIFFERENT device than the one
// the user chose is never a reasonable answer, so this resolves generously and then
// refuses rather than guessing.
//
// The per-device URL only counts in dlna_only mode: that is the only mode whose UI
// shows the field (#deviceDlnaRow is hidden otherwise), and an invisible value must not
// override the app-wide picker the user CAN see.
function _savedRendererPref() {
  const perDevice = store.deviceOutputMode === 'dlna_only' ? (store.deviceDlnaRendererUrl || '') : '';
  return perDevice || (store.appSettings && store.appSettings.dlna_renderer_url) || '';
}

function _resolveRenderer(devices, saved) {
  if (!saved) return null;
  // Stable UPnP UDN, if the preference was ever stored as an id.
  let d = devices.find(x => x.id === saved);
  if (d) return d;
  // Exact descriptor URL — the normal case, while the IP still holds.
  d = devices.find(x => x.location === saved);
  if (d) return d;
  // Same port and descriptor path on another host: the renderer moved to a new IP.
  // Only accept it when exactly one device matches, so a pair of identical renderers
  // can never be silently confused for one another.
  try {
    const want = new URL(saved);
    const hits = devices.filter(x => {
      try { const u = new URL(x.location); return u.port === want.port && u.pathname === want.pathname; }
      catch { return false; }
    });
    if (hits.length === 1) return hits[0];
  } catch { /* not a URL — nothing more to try */ }
  return null;
}

// ── Shared flags ──
// Set by the ENGINE's loadAndPlay/nextTrack/prevTrack cast branches and read by the
// poll. Must be a shared object (live binding) so cross-module writes are visible here.
// position / positionAt / duration / playing: the receiver as this page last saw it
// (seconds, Date.now() of that sample, castDuration(), its play state) — read by the
// remote-control state report while store.castDevice is set. Extrapolate position
// from positionAt only while playing.
export const castState = {
  skipAutoAdvance: false, transitioning: false,
  position: 0, positionAt: 0, duration: 0, playing: false,
};
function _publish(playing) {
  castState.position = _castLastPos;
  castState.positionAt = _castLastPosAt;
  castState.duration = castDuration();
  castState.playing = !!playing;
}
let _castTransitionTimer = null;
// Cast-stall tracking: when the last cast was issued, and whether the renderer has
// actually reported PLAYING since. A renderer that silently never starts the track is
// the "DLNA stops between tracks" failure — the app told it to play and then waited
// forever, because BOTH latches below are only released by seeing PLAYING.
let _castIssuedAt = 0, _castSawPlaying = false, _castRetried = false;

// Suppress the disconnect branch for a window while a track change is in flight, and
// arm the stall clock. Both latches get a hard expiry: skipAutoAdvance in particular
// used to be released ONLY by a PLAYING state, so one track the renderer never started
// disabled auto-advance for the rest of the session — every later track then "ended"
// with nothing happening.
export function markCastTransition(ms = 20000) {
  castState.transitioning = true;
  _castIssuedAt = Date.now();
  _castSawPlaying = false;
  _castRetried = false;
  clearTimeout(_castTransitionTimer);
  _castTransitionTimer = setTimeout(() => {
    castState.transitioning = false;
    castState.skipAutoAdvance = false;
  }, ms);
}

// ── Private poll state ──
let _castLastDur = 0;     // last non-zero duration seen while playing/paused (renderers zero it at STOP)
let _castLastPos = 0;     // last known position of the cast track, seconds
let _castLastPosAt = 0;   // Date.now() when _castLastPos was sampled
let _castExtrap = false;  // the last sample said PLAYING: the position moves on with the clock
let _castWasPlaying = false; // latched true while playing; survives the TRANSITIONING blip before STOP
let _castPollFails = 0;      // consecutive failed status polls (drive the back-off)
let _castDeadTracks = 0;     // consecutive tracks the renderer never started playing
let _castVolTimer = null;    // debounce timer for the cast volume slider
let _castSeq = -1;           // newest cast_seq this page knows of (its own casts and adopted ones)
let _castPosts = 0;          // POST /cast requests on their way
let _hintKey = '';           // what the server was last told about "what plays next"
let _hintInFlight = false;
let _hintAgain = false;      // the hint changed while one was on its way
let _followStatus = null;    // the last status of a FOLLOWED cast (its track is what a hint is about)
let _abKey = '';             // what the Android shell was last told ('' | 'paused' | track key)
let _pollGen = 0;            // bumped by every (re)start/end of the poll chain
let _pollPromise = null;     // the ONE status request on its way, if any (finding 6)
let _castEpoch = 0;          // bumped by every cast POST: older status answers are dropped
let _lastState = '';         // the receiver's last state: playing | paused | stopped | other
let _castSeenPos = 0;        // last position the receiver itself REPORTED (no extrapolation)
let _stoppedSeq = null, _stoppedPolls = 0; // follow: consecutive STOPPED polls on one cast_seq
let _endedSeq = null;        // follow: the cast_seq whose queue end was handed to the engine
let _inactiveCount = 0;      // consecutive {active:false} answers without `abandoned`
let _deferQueue = [], _bypassDefer = false; // deferUntilFresh: presses waiting for a poll
let _sessionId = null;       // the server's session the seqs above belong to
let _sawPlayingSeq = null;   // cast_seq this page last saw PLAYING in a live poll
let _adoptPromise = null;    // an adoption still reading the server's saved queue
const QUEUE_END_FRESH_S = 60; // a queue end older than this is not handed to the engine
let _lastPollEndAt = 0;      // when the previous status request finished (answer or error)
let _lastStatusAt = 0;       // when the last status was applied

// The position the receiver is at NOW, as well as we can tell: the last sample, plus
// the time since it if the receiver was playing. A page that slept through the end of
// a track otherwise compared a minutes-old position with the duration and never saw
// "near the end" (finding 1 — both stuck episodes of 2026-11-19).
function _estPos(now = Date.now()) {
  let p = _castLastPos;
  if (_castExtrap && _castLastPosAt) p += (now - _castLastPosAt) / 1000;
  // Clamp only to a length the RECEIVER reported: a catalogue duration_ms can be wrong.
  if (_castLastDur > 0 && p > _castLastDur) p = _castLastDur;
  return Math.max(0, p);
}

function _trackReset(start = 0) {
  _castLastPos = Math.max(0, Number(start) || 0);
  _castSeenPos = _castLastPos;
  _lastState = '';
  _stoppedSeq = null; _stoppedPolls = 0;
  _castLastPosAt = Date.now();
  _castExtrap = false;
  _castLastDur = 0;
  _castWasPlaying = false;
  _abKey = '';
  _publish(false); // a new track: not playing until the receiver says so
}

/** Length of the track on the receiver, seconds (0 = unknown). The local deck never
 *  holds the cast track, so its duration is the PREVIOUS local track's (finding 4). */
export function castDuration() {
  if (_castLastDur > 0) return _castLastDur;
  const it = store.playerQueue[store.playerIndex];
  return it && it.duration_ms > 0 ? it.duration_ms / 1000 : 0;
}

/** Where the receiver is in the current track, extrapolated; 0 once it has played out
 *  (handing back "the very end" would only end the track again locally).
 *  The extrapolation never runs past the track's length — the receiver's, else the
 *  item's duration_ms — but never below what the receiver itself last reported (a
 *  reported position beyond duration_ms proves duration_ms wrong). With no length at
 *  all, an extrapolation minutes past the last report is a guess about a receiver that
 *  may have stopped long ago: hand back the report instead. */
const NO_LENGTH_SLACK = 180;
export function castPosition() {
  const est = _estPos();
  const seen = _castSeenPos;
  const it = store.playerQueue[store.playerIndex];
  const known = _castLastDur || (it && it.duration_ms > 0 ? it.duration_ms / 1000 : 0);
  if (known > 0) {
    const p = Math.min(est, Math.max(known, seen));
    if (seen <= known && p >= known - 2) return 0;
    return p;
  }
  return est - seen > NO_LENGTH_SLACK ? seen : est;
}

/** The server follower's own "this stop is the end of the track" window (dlna.py:
 *  NEAR_END_MARGIN 12 s, NEAR_END_FRACTION 0.85, NEAR_END_MAX_WINDOW 60 s). In follow
 *  mode the page must judge a stop exactly as the server does: a hand stop at 55:00 of
 *  a 60-minute mix is mid-track to the server (it will not move on), so the icon must
 *  say paused. The fallback keeps its wider window on purpose — there no server covers
 *  a stale tail. */
export function serverNearEnd(est, d) {
  if (!(d > 0)) return false;
  return est >= d - Math.max(12, Math.min(0.15 * d, 60));
}

/** The length a seek bar spans: the receiver's while casting, else the engine's own
 *  (`localDuration`). The local deck never holds the cast track (finding 4). */
export function castSeekDuration(localDuration) {
  return store.castDevice ? castDuration() : (typeof localDuration === 'function' ? localDuration() : 0);
}

/** A local deck's `pause` while casting is the cast's own doing (the local decks are
 *  paused when it starts): it must reach neither the icon nor the Android shell. */
export function castOwnsLocalPause() { return !!store.castDevice; }

/** True unless a cast is active and the page's view of it may be out of date (the page
 *  just woke, or a cast is on its way). A periodic queue save must not write a stale
 *  current_index over the one the server advanced to while the page slept. */
export function castStateFresh() {
  if (!store.castDevice) return true;
  return _castPosts === 0 && !_adoptPromise && _lastStatusAt > 0 && Date.now() - _lastStatusAt < GAP_MS;
}

// ── What plays next ──
function _upcoming() {
  // Repeat one: what plays next is this track again.
  if (store.repeatMode === 'one' && store.playerIndex >= 0 && store.playerQueue[store.playerIndex]) {
    return { index: store.playerIndex, item: store.playerQueue[store.playerIndex] };
  }
  if (_ctx.getUpcoming) return _call(_ctx.getUpcoming) || null;
  const q = store.playerQueue, i = store.playerIndex;
  if (!q.length || i < 0) return null;
  if (i + 1 < q.length) return { index: i + 1, item: q[i + 1] };
  if (store.repeatMode === 'all' && q.length > 1) return { index: 0, item: q[0] };
  return null;
}
function _nextBody(up) {
  if (!up || !up.item) return null;
  const it = up.item;
  return {
    queue_index: up.index, name: _dec(it.name || ''), artist: _dec(it.artist || ''),
    album: it.album || '', image: it.image || '', duration_ms: _ms(it.duration_ms),
  };
}
function _hintKeyFor(idx, up, ap) {
  return [idx, up ? up.index : -1, up ? _key(up.item) : '', store.repeatMode || 'off', !!store.shuffleEnabled,
    ap == null ? '?' : '=' + ap.map(_key).join('\u0003')].join('\u0002');
}

// ── What plays when the queue is over ──
// Autoplay — the recommender — lives in the page, and the page is frozen while the
// phone's screen is off: the server then reached the last row and stopped. So every
// cast and every hint carries the recommender's next picks, wherever in the queue the
// cast is (a phone locked for the whole queue reaches the last row by the server's own
// advances, with no page awake to say anything then). The server uses the list only
// when its saved queue is really over, and appends the picks as it plays them.
//
// Three answers (the wire's too):
//   undefined  not known — the recommender is still loading, or this page has no say
//              (a controller): the body has no `autoplay`, the server KEEPS what it holds
//   []         no recommender pick may follow the queue: repeat; radio (the SERVER
//              refills a radio queue from the radio service, see dlna.py _take_radio);
//              or a recommender that has nothing — the server drops its list
//   [rows]     the picks, the current track left out
function _autoplayFor(idx) {
  if (idx < 0 || idx !== store.playerIndex || store.remoteTarget || !_ctx.peekAutoplay) return undefined;
  if ((store.repeatMode || 'off') !== 'off' || store.radioMode) return [];
  const list = _call(_ctx.peekAutoplay, AUTOPLAY_SEND);
  if (!Array.isArray(list)) return undefined;
  const seen = new Set([_key(store.playerQueue[idx])]);
  const out = [];
  for (const it of list) {
    if (!it || !it.name) continue;
    const k = _key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    const row = { name: _dec(it.name), artist: _dec(it.artist || ''), album: it.album || '',
      image: it.image || '', duration_ms: _ms(it.duration_ms) };
    if (it.id != null && it.id !== '') row.id = String(it.id);
    out.push(row);
    if (out.length >= AUTOPLAY_SEND) break;
  }
  return out;
}

// ── The ONE place a track is sent to the receiver ──
// Every POST /api/dlna/cast goes through here, so each carries where it sits in the
// queue, what the page would play after it, repeat/shuffle (the server's follower
// continues from those) and the cast_seq the server answers with.
export async function castItem(item, opts = {}) {
  const device = opts.device || store.castDevice;
  if (!device || !item) throw new Error('No cast device');
  const q = store.playerQueue;
  let idx = opts.queueIndex;
  if (idx == null) idx = q[store.playerIndex] === item ? store.playerIndex : q.indexOf(item);
  const up = idx >= 0 && idx === store.playerIndex ? _upcoming() : null;
  const ap = _autoplayFor(idx);
  const start = Math.max(0, Number(opts.startSeconds) || 0);
  const body = {
    device_id: device.id,
    name: opts.name != null ? opts.name : _dec(item.name || ''),
    artist: opts.artist != null ? opts.artist : _dec(item.artist || ''),
    album: item.album || '', image: item.image || '', duration_ms: _ms(item.duration_ms),
    start_seconds: start,
    queue_index: idx,
    next: _nextBody(up),
    repeat: store.repeatMode || 'off',
    shuffle: !!store.shuffleEnabled,
  };
  if (ap) body.autoplay = ap; // absent = "not known": the server keeps its list
  _trackReset(start);
  _castEpoch++; // any status asked for before this cast is about the track it replaces
  _castPosts++;
  try {
    // The server's follower reads the SAVED queue, which trails the page by the save
    // debounce. A cast right after a queue change (new playlist, Play next, a row
    // removed) would be followed through the old one: save first. Yield once so the
    // caller's own saveQueueDebounced (often right after it starts the cast) counts.
    await null;
    if (store.playerSavePending && _ctx.flushQueue) {
      // Bounded: a save that hangs must not hold the cast (the user pressed Next).
      let cut;
      try {
        await Promise.race([_ctx.flushQueue(), new Promise((r) => { cut = setTimeout(r, FLUSH_TIMEOUT_MS); })]);
      } catch {} finally { clearTimeout(cut); }
    }
    const res = await apiJson('/api/dlna/cast', { method: 'POST', body });
    if (res) _sessionSeen(res.session_id);
    if (res && Number.isFinite(res.cast_seq)) _castSeq = Math.max(_castSeq, res.cast_seq);
    _hintKey = idx >= 0 ? _hintKeyFor(idx, up, ap) : '';
    _trackReset(start);
    return res;
  } finally {
    _castPosts--;
  }
}

/** Engine cast branch (loadAndPlay / playRecTrack): send `item` to the active device. */
export function castTrack(item, opts = {}) {
  castState.skipAutoAdvance = true;
  // markCastTransition (not a bare flag) so both latches carry a hard expiry — a raw
  // `transitioning = true` could only ever be cleared by a PLAYING state, which a
  // renderer that never starts the track does not send.
  markCastTransition();
  return castItem(item, opts).catch(e => {
    // 409 without cause "device": a later cast (or a stop) superseded this one on the
    // server. That later action owns the latches and the message — say nothing here.
    if (_superseded(e)) return null;
    showToast('Cast failed: ' + (e.message || ''));
    castState.transitioning = false;
    castState.skipAutoAdvance = false;
    return null;
  });
}

// ── Play / pause on the receiver (buttons, media keys, notification) ──
// On a receiver that stopped mid-track, the server answers Play by casting the same
// track again at its last position — so Play is always just Play here.
export function castPlay() {
  if (!store.castDevice) return Promise.resolve();
  return apiJson('/api/dlna/play', { method: 'POST' }).then(() => {
    _lastState = 'playing';
    _publish(true);
    _call(_ctx.onCastPlaying, true);
    _reportAndroid('playing');
  }).catch(() => {});
}
export function castPause() {
  if (!store.castDevice) return Promise.resolve();
  return apiJson('/api/dlna/pause', { method: 'POST' }).then(() => {
    _lastState = 'paused';
    _publish(false);
    _call(_ctx.onCastPlaying, false);
    _reportAndroid('paused');
  }).catch(() => {});
}
export function castToggle() { return store.playerPlaying ? castPause() : castPlay(); }

// The Android shell keeps the page (and its CPU) alive only while it believes audio is
// playing. Casting pauses the local deck, so without this the shell heard a pause,
// dropped the wake lock and let the WebView freeze — finding 1, Android half.
function _reportAndroid(state, pos = 0, dur = 0) {
  if (state === 'playing') {
    const it = store.playerQueue[store.playerIndex];
    const k = it ? _key(it) : 'cast';
    if (_abKey !== k) { _abKey = k; abPlay(it ? _dec(it.name) : '', it ? _dec(it.artist) : ''); }
    // ACTION_PROGRESS re-takes the shell's 1 h wake lock — a mix outlives an hour.
    if (dur > 0) abProgress(Math.floor(pos * 1000), Math.floor(dur * 1000));
  } else if (state === 'paused') {
    if (_abKey !== 'paused') { _abKey = 'paused'; abPause(); }
  }
}

// DLNA Only mode: auto-connect to a renderer and cast the current item.
export async function autoCastAndPlay(item, cleanName, cleanArtist) {
  try {
    const devices = await _getDevicesOrScan();
    if (!devices.length) { showToast('No DLNA devices found. Configure in Settings.'); return; }
    const savedUrl = _savedRendererPref();
    const device = savedUrl ? _resolveRenderer(devices, savedUrl) : devices[0];
    if (!device) {
      showToast('Chosen DLNA renderer not found on the network — check Settings');
      return;
    }
    store.castDevice = device;
    castState.skipAutoAdvance = true;
    markCastTransition(); // arms a 20s safety clear so a stuck transition can't block forever
    await castItem(item, { name: cleanName, artist: cleanArtist });
    _castDeadTracks = 0;
    _pauseLocal();
    syncCastButtons('var(--accent)');
    _call(_ctx.onCastPlaying, true);
    startCastPoll();
  } catch (e) {
    if (_superseded(e)) return; // the cast that superseded it owns the device now
    castState.transitioning = false;
    if (e.reason === 'device') { abandonCast(e.message); return; }
    // A failed first cast leaves no session: drop the device too, or every later
    // track would go down the cast branch with no poll behind it.
    store.castDevice = null;
    showToast('DLNA auto-cast failed: ' + (e.message || ''));
  }
}

// 409 without cause "device": a later cast (or a stop) superseded this one on the
// server. That later action owns the session, the latches and any message.
function _superseded(e) { return !!e && e.status === 409 && e.reason !== 'device'; }

function _pauseLocal() {
  if (_ctx.pauseLocal) { _call(_ctx.pauseLocal); return; }
  try { _ctx.getAudioEl()?.pause(); } catch {}
}

export async function castToDevice(device) {
  const item = store.playerQueue[store.playerIndex];
  if (!item) return;
  // The receiver starts where the phone was (finding 3): a mix at 45:00 used to
  // restart from 0:00 on the receiver.
  let start = 0;
  if (_ctx.localPosition) start = Number(_call(_ctx.localPosition)) || 0;
  else { try { start = _ctx.getAudioEl()?.currentTime || 0; } catch {} }
  // Silence BOTH local decks before the receiver starts (a crossfade in progress used
  // to keep one playing — finding 18), and bring them back if the cast fails.
  const wasPlaying = !!store.playerPlaying;
  _pauseLocal();
  try {
    markCastTransition();
    await castItem(item, { device, startSeconds: start });
    store.castDevice = device;
    syncCastButtons('var(--accent)');
    _call(_ctx.onCastPlaying, true);
    _reportAndroid('playing'); // cancels the pause the local decks just reported
    showToast(`Casting to ${device.name}`);
    _castDeadTracks = 0;
    startCastPoll();
  } catch (e) {
    // Superseded (a second tap on Cast): the later cast owns the receiver. Bringing the
    // local decks back here would play local audio under it.
    if (_superseded(e)) return;
    castState.transitioning = false;
    if (e.reason === 'device') abandonCast(e.message);
    else showToast('Cast failed: ' + (e.message || ''));
    if (wasPlaying && !store.castDevice) _call(_ctx.resumeLocal);
  }
}

// End the session on THIS page: poll, latches, buttons. The receiver is not told.
// Returns whether there was a session to end — a second call is a no-op for the
// caller's hand-back (two paths can race to the same end: a poll and a click).
function _endSession() {
  const had = !!store.castDevice;
  Object.assign(castState, { position: 0, positionAt: Date.now(), duration: 0, playing: false });
  _pollGen++;
  clearTimeout(store.castPollTimer);
  store.castPollTimer = null;
  store.castDevice = null;
  _castDeadTracks = 0;
  _castIssuedAt = 0;
  _castWasPlaying = false;
  _castExtrap = false;
  _lastStatusAt = 0;
  castState.transitioning = false;
  castState.skipAutoAdvance = false;
  _inactiveCount = 0;
  // The next session counts its casts from 0 again.
  _castSeq = -1; _endedSeq = null; _hintKey = ''; _sessionId = null; _sawPlayingSeq = null;
  _followStatus = null; _hintAgain = false;
  _deferQueue = [];
  if (!had) return false;
  syncCastButtons('');
  _call(_ctx.onCastPlaying, false);
  if (_abKey) abPause();
  _abKey = '';
  return true;
}

// Hand the receiver's position back to the local player (finding 3): pressing Play
// after the cast continues the current item where the receiver was, even when the
// local deck never held that track.
function _handBack(idx, pos) {
  if (idx >= 0) _call(_ctx.primeLocal, idx, pos);
}

// A renderer that is off, asleep, or refusing fails EVERY track, and the poll's
// give-up path answers by advancing the queue — so one dead receiver silently chewed
// through the whole queue, one 30s stall at a time, and the user was left with a
// different song selected and still no sound. Say what happened and end the session.
// `stop`: the page gives up on its own — tell the server too, so the receiver does not
// carry on behind a page that now believes it plays locally (finding 11).
function abandonCast(message, { stop = true } = {}) {
  const idx = store.playerIndex, pos = castPosition();
  if (stop) apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
  if (_endSession()) _handBack(idx, pos);
  if (message) showToast(message);
}

export async function stopCast() {
  const idx = store.playerIndex, pos = castPosition();
  await apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
  if (_endSession()) _handBack(idx, pos);
}

// Finding 2: a page reloaded (or a tab the browser discarded) while casting used to
// believe it played locally — the receiver ran on, the queue never advanced, and Play
// started local audio on top of it. Ask the server; if a session is alive, take it up.
// Called once the queue is loaded (its track is matched against the queue).
let _restoreTries = 0;
export async function restoreCast() {
  if (store.castDevice) return false;
  let st;
  try { st = await apiJson('/api/dlna/status'); } catch { return false; }
  if (!st || store.castDevice) return false;
  if (store.deviceOutputMode === 'local') {
    // This device plays locally only: a session left over from before must not keep
    // the receiver going behind a page that will never show it.
    if (st.active) apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
    return false;
  }
  if (!st.active) {
    if (st.abandoned) showToast(st.abandoned);
    return false;
  }
  if (!st.device_id) {
    // The first cast is still connecting (device "transitioning", no id yet): ask again
    // shortly rather than adopt a device with no id. A server that never sends an id
    // (older version) ends up here too, and is not taken up.
    if (st.device === 'transitioning' && ++_restoreTries <= 5) setTimeout(() => { restoreCast(); }, 3000);
    return false;
  }
  _restoreTries = 0;
  // A queue that ended long ago (the receiver has sat there since yesterday) is not a
  // session to take up: no autoplay on it, no stop either — the server lets it expire.
  if (st.queue_ended && Number.isFinite(st.queue_ended_ago) && st.queue_ended_ago > QUEUE_END_FRESH_S) return false;
  store.castDevice = { id: st.device_id, name: st.device || 'DLNA renderer', location: st.location || '' };
  _sessionSeen(st.session_id);
  if (Number.isFinite(st.cast_seq)) _castSeq = st.cast_seq;
  _castDeadTracks = 0;
  _pauseLocal();
  syncCastButtons('var(--accent)');
  if (st.track) _adopt(st.track);
  if (_adoptPromise) { try { await _adoptPromise; } catch {} }
  startCastPoll();
  _applyStatus(st, 0);
  return true;
}

// Where the server's track sits in our queue: its queue_index when that row is the
// same song, else the current row if it is, else the first row that is; -1 if none.
function _resolveIndex(t) {
  const q = store.playerQueue, k = _key(t);
  const qi = Number.isInteger(t.queue_index) ? t.queue_index : -1;
  if (qi >= 0 && qi < q.length && _key(q[qi]) === k) return qi;
  const cur = store.playerIndex;
  if (cur >= 0 && q[cur] && _key(q[cur]) === k) return cur;
  return q.findIndex(it => _key(it) === k);
}

// A cast_seq means something only within one server session: after a Stop (or a
// server restart that lost it) the server counts from 0 again, and a page that kept
// its old, higher seq stopped adopting and hinting for good.
function _sessionSeen(id) {
  if (id == null || id === _sessionId) return;
  if (_sessionId != null) { _castSeq = -1; _endedSeq = null; _hintKey = ''; _sawPlayingSeq = null; }
  _sessionId = id;
}

// The server cast another track while we were not looking: show it, don't cast it.
function _maybeAdopt(status) {
  const seq = status.cast_seq;
  if (!Number.isFinite(seq) || _castPosts > 0 || seq <= _castSeq) return;
  _castSeq = seq;
  if (status.track) _adopt(status.track);
}

function _adopt(t) {
  const idx = _resolveIndex(t);
  // Same row: not a new track — e.g. a seek on a stopped receiver, which the server
  // answers by casting the same track again. Only the seq is taken (caller).
  if (idx >= 0 && idx === store.playerIndex) return;
  // A row the server appended from the autoplay list is in no row of ours yet: it is
  // taken from the server's saved queue (below), never cast again.
  if (idx < 0 && !(t.by === 'server' && t.autoplay)) {
    // Not in this queue under any row or name: the page cannot make it current without
    // inventing a queue entry. Leave the queue alone and say so.
    console.warn(`[cast] the receiver plays "${t.name || '?'}", which is not in this queue — not adopted`);
    return;
  }
  _trackReset(0);
  if (t.by === 'server') {
    // The server may have played several tracks while the page slept. Its saved queue
    // knows which (shuffle_order, current_index); booking only the adopted one left
    // the others in the tail — the hint then named a track already played and the
    // next save wrote that order over the server's.
    const p = _adoptFromServer(idx, t);
    _adoptPromise = p;
    p.finally(() => { if (_adoptPromise === p) _adoptPromise = null; });
    return;
  }
  _call(_ctx.adoptTrack, idx, t, null);
}

function _sameQueue(q) {
  const mine = store.playerQueue;
  return Array.isArray(q) && q.length === mine.length && q.every((it, i) => _key(it) === _key(mine[i]));
}

const _queueSig = () => store.playerQueue.map(_key).join('\u0003');

// The saved queue is ours plus rows after it: what the server appended (autoplay).
function _appendedRows(q) {
  const mine = store.playerQueue;
  if (!Array.isArray(q) || !mine.length || q.length <= mine.length) return null;
  if (!mine.every((it, i) => _key(it) === _key(q[i]))) return null;
  return q.slice(mine.length).filter((it) => it && it.name);
}

// Rows the server appended go into OUR array (push — search.js tests its identity),
// behind the "Autoplay" divider; the recommender is told they have been played.
function _pushAutoplay(rows, at = null, kind = '') {
  if (!rows || !rows.length) return;
  if (_ctx.appendAutoplayRows) _call(_ctx.appendAutoplayRows, rows, at, kind);
  else if (at != null) store.playerQueue.splice(at, 0, ...rows);
  else for (const it of rows) store.playerQueue.push(it);
}

async function _adoptFromServer(idx, t) {
  const seq = _castSeq;
  const q0 = store.playerQueue, sig0 = _queueSig();
  const auto = t.autoplay === true;
  // 'radio': rows of a radio refill the server made — radio rows, not an autoplay tail.
  const kind = t.kind === 'radio' ? 'radio' : '';
  let saved = null, data = null;
  try {
    data = await apiJson('/api/player/queue');
    if (data && _sameQueue(data.queue)) saved = data;
  } catch {}
  if (!store.castDevice || seq !== _castSeq) return; // a newer cast or adoption took over
  // A cast of ours is on its way (its POST has not answered, so the seq above has not
  // moved yet) — the user started something else, typically a new playlist: what the
  // server was playing belongs to the queue they just left. Nothing of it is taken.
  if (_castPosts > 0) return;
  let i = idx;
  const changed = store.playerQueue !== q0 || _queueSig() !== sig0;
  if (auto && !changed && !saved && data) {
    // The server played on past the end of our queue: take its rows — all of them, it
    // may have appended several while the page slept. From here the two queues agree.
    const rows = _appendedRows(data.queue);
    if (rows && rows.length) {
      _pushAutoplay(rows, null, kind);
      if (_sameQueue(data.queue)) saved = data;
      i = _resolveIndex(t);
    }
  }
  // The queue changed while the GET was out (a row removed, a new playlist, a drag):
  // the server's order and index are positions into a queue that no longer exists, and
  // so is `idx`. Find the track again and book only the one step.
  if (changed) {
    saved = null;
    i = _resolveIndex(t);
    if (i < 0) {
      // Edited while the GET was out and the track is in no row: positions (ours and
      // the server's) mean nothing now. Not adopted — an autoplay row neither.
      console.warn(`[cast] the receiver plays "${t.name || '?'}", which left the queue meanwhile — not adopted`);
      return;
    }
    if (i === store.playerIndex) return;
  }
  if (i < 0) {
    if (!auto) return;
    // An autoplay row we could not read from the saved queue (the GET failed, or a save
    // of ours replaced the file after the server appended): the status names the track.
    // It followed the row that was current — so it goes right after that row. Anything
    // behind it was queued by the user while the server was already moving on (the save
    // is debounced) and must stay AHEAD of what plays now, or it would never play.
    const row = { name: t.name || '', artist: t.artist || '', album: t.album || '', image: t.image || '',
      duration_ms: _ms(t.duration_ms) };
    if (!row.name) return;
    saved = null;
    const at = store.playerIndex + 1;
    if (store.playerIndex >= 0 && at < store.playerQueue.length) {
      _pushAutoplay([row], at, kind);
      i = store.playerQueue[at] === row ? at : _resolveIndex(t);
      if (i < 0) return;
    } else {
      _pushAutoplay([row], null, kind);
      i = store.playerQueue.length - 1;
    }
  }
  if (saved && Number.isInteger(saved.current_index) && _key(store.playerQueue[saved.current_index]) === _key(t)) i = saved.current_index;
  _call(_ctx.adoptTrack, i, t, saved ? { shuffle_order: saved.shuffle_order || null, current_index: saved.current_index } : null);
}

/** Make queue[idx] the current track for an adoption. Returns the new item, or null.
 *  - `saved` (the server's saved queue, when it matches ours): its shuffle_order is
 *    taken whole (`restoreOrder`), after the index moves — it already books every
 *    track the server played. Without it, the step is booked by `shuffle(idx)` before
 *    the index moves, as if the page had advanced once.
 *  - Smart Queue (`played`): the outgoing track; with the server's order, every track
 *    in its played list; without shuffle, every row the server stepped over in order
 *    (it advances one row at a time). A Smart Queue hint pick the server followed in
 *    between is not recoverable from the saved queue and is not marked. */
export function adoptQueueIndex(idx, { shuffle, played, restoreOrder, saved } = {}) {
  const q = store.playerQueue;
  if (!(Number.isInteger(idx) && idx >= 0 && idx < q.length)) return null;
  const from = store.playerIndex;
  const out = from >= 0 ? q[from] : null;
  const marked = new Set();
  const mark = (it) => { if (it && it !== q[idx] && !marked.has(it)) { marked.add(it); _call(played, it); } };
  mark(out);
  const order = saved && saved.shuffle_order;
  if (store.shuffleEnabled && order) {
    (Array.isArray(order.played) ? order.played : []).forEach((i) => mark(q[i]));
    store.playerIndex = idx;
    _call(restoreOrder, order);
    return q[idx];
  }
  if (!store.shuffleEnabled && from >= 0 && idx > from) for (let i = from; i < idx; i++) mark(q[i]);
  if (store.shuffleEnabled) _call(shuffle, idx);
  store.playerIndex = idx;
  return q[idx];
}

// Tell the server what the page would play next — only when that changed, and only
// while the server's current track is ours (otherwise it answers 409 stale).
function _maybeHint(status) {
  if (!status || _castPosts > 0 || _adoptPromise) return;
  if (_hintInFlight) { _hintAgain = true; return; } // looked at again when it lands
  const t = status.track;
  const idx = store.playerIndex;
  // Ours when it resolves to our row — by index, or by name after the indices drifted
  // apart (a row removed above it). The server then gets ITS index for the track.
  if (!t || idx < 0 || _resolveIndex(t) !== idx) return;
  const serverIdx = Number.isInteger(t.queue_index) && t.queue_index >= 0 ? t.queue_index : idx;
  const up = _upcoming();
  const ap = _autoplayFor(idx);
  const key = _hintKeyFor(idx, up, ap);
  if (key === _hintKey) return;
  _hintInFlight = true;
  _hintAgain = false;
  const body = { queue_index: serverIdx, next: _nextBody(up), repeat: store.repeatMode || 'off', shuffle: !!store.shuffleEnabled };
  if (ap) body.autoplay = ap; // absent = "not known": the server keeps its list
  // The save first: a hint naming a row the saved queue does not hold yet is cast with
  // no queue index (and the queue ends after it).
  _flushPendingSave().then(() => apiJson('/api/dlna/next-hint', { method: 'POST', body })).then(() => { _hintKey = key; })
    .catch(e => { if (e && (e.status === 409 || e.status === 400)) _hintKey = key; })
    .finally(() => {
      _hintInFlight = false;
      if (_hintAgain) { _hintAgain = false; if (store.castDevice) _maybeHint(_followStatus); }
    });
}

/** The queue changed (the engine's saveQueueDebounced): what plays next may be another
 *  track now. The poll would notice within 2 s and the save lands after its own 2 s
 *  debounce — long enough for the current row to end and the server to move on by its
 *  old idea of the queue (a track queued on the last row was skipped for an autoplay
 *  pick). So, while the server follows: save now, then tell it, in that order — a hint
 *  naming a row the saved queue does not hold yet is cast with no queue index. */
let _noteScheduled = false;
export function noteQueueChanged() {
  if (!store.castDevice || !_followStatus || _noteScheduled) return;
  _noteScheduled = true;
  // After the caller has finished its own edit (it often saves first, then moves the index).
  Promise.resolve().then(() => {
    _noteScheduled = false;
    if (!store.castDevice || !_followStatus || _castPosts > 0 || _adoptPromise) return;
    if (!castStateFresh()) {
      // The page's view is old (it slept, or its timers are throttled in a hidden tab —
      // a remote command still gets here): look first. The poll adopts what the server
      // did, then releases the save and sends the hint (_pollRequest).
      pollCastOnce();
      return;
    }
    const idx = store.playerIndex;
    if (_hintKeyFor(idx, _upcoming(), _autoplayFor(idx)) === _hintKey) return; // nothing the server needs
    _maybeHint(_followStatus); // saves first
  });
}

// Save a queue edit that is waiting — in its debounce, or HELD by the engine because
// the page's view of the cast was stale (saveQueueNow). Bounded: a save that hangs
// must not hold what waits behind it.
async function _flushPendingSave() {
  if (!store.playerSavePending || !_ctx.flushQueue) return;
  let cut;
  try {
    await Promise.race([_ctx.flushQueue(), new Promise((r) => { cut = setTimeout(r, FLUSH_TIMEOUT_MS); })]);
  } catch {} finally { clearTimeout(cut); }
}

/** May the engine's last-moment save (beforeunload) write the queue? Not casting, or
 *  the view is fresh: yes. Stale: only if an EDIT is waiting to be saved and no
 *  adoption is reading the server's queue — a user's edit is not dropped because the
 *  tab's timers were throttled. A page that merely woke up, with nothing of its own
 *  to save, does not write: its queue and index are from before the sleep and the
 *  server's follower has written the file since. */
export function castMaySaveOnUnload() {
  if (!store.castDevice || castStateFresh()) return true;
  return !!store.playerSavePending && !_adoptPromise;
}

export function syncCastButtons(color) {
  ['#playerCastBtn', '#fpCastBtn'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.style.color = color;
  });
  // Toggle volume sliders: show DLNA volume in cast mode, local volume otherwise
  const isCasting = color && color !== '';
  // While casting, the volume controls talk to the renderer and the local element keeps
  // its old level. Back on local output, the element takes the level the UI now shows.
  if (!isCasting) { try { _ctx.syncVolume?.(); } catch {} }
  const castVol = $('#fpCastVol');
  if (castVol) castVol.style.display = isCasting ? '' : 'none';
  const localVol = document.querySelector('.fp-vol-wrap');
  if (localVol) localVol.style.display = isCasting ? 'none' : '';
}

async function handleCastClick() {
  if (store.deviceOutputMode === 'local') return;
  if (store.castDevice) {
    await stopCast();
    showToast('Cast stopped');
    return;
  }
  try {
    showToast('Searching for cast devices…');
    const devices = await _getDevicesOrScan();
    if (!devices.length) { showToast('No DLNA devices found. Configure in Settings.'); return; }
    const savedUrl = _savedRendererPref();
    if (savedUrl) {
      const savedDevice = _resolveRenderer(devices, savedUrl);
      if (!savedDevice) {
        showToast('Chosen DLNA renderer not found on the network — check Settings');
        return;
      }
      castToDevice(savedDevice);
    } else {
      // No stated preference — unchanged behaviour: take the first renderer found.
      castToDevice(devices[0]);
    }
  } catch (e) {
    showToast('Cast failed: ' + (e.message || ''));
  }
}

// ── The status poll ──
// A setTimeout chain, re-armed only after the previous request has finished: with a
// setInterval and a slow server (three SOAP calls, 3 s timeout each) a woken page sent
// 2–5 overlapping requests, and a late PLAYING answer could re-arm the end detector
// after the advance (finding 6). Failed polls back off instead of tearing the session
// down — a phone reconnecting to Wi-Fi fails a burst in a second (finding 11).
export function startCastPoll() {
  _pollGen++;
  clearTimeout(store.castPollTimer);
  _castWasPlaying = false;
  _castPollFails = 0;
  _lastPollEndAt = Date.now();
  _schedule(POLL_MS);
}

function _schedule(ms) {
  const gen = _pollGen;
  clearTimeout(store.castPollTimer);
  store.castPollTimer = setTimeout(() => { _tick(gen); }, ms);
}

async function _tick(gen) {
  if (gen !== _pollGen || !store.castDevice) return;
  let ok = true;
  // Whatever goes wrong inside one poll (a hook that throws), the chain must go on —
  // a dead chain is a page that never sees the receiver again.
  try { ok = await pollCastOnce(); } catch (e) { console.warn('[cast] status poll failed', e); }
  if (gen !== _pollGen || !store.castDevice) return;
  _schedule(ok ? POLL_MS : Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.min(_castPollFails, 4)));
}

/** One status poll. Never more than one on its way: a call while one is pending does
 *  nothing (resolves true at once). Resolves false when the request failed (the chain
 *  then backs off). */
export function pollCastOnce() {
  if (!store.castDevice || _pollPromise) return Promise.resolve(true);
  if (store.deviceOutputMode === 'local') {
    // User switched to local output mid-cast — stop the renderer and end the poll.
    abandonCast('', { stop: true });
    return Promise.resolve(true);
  }
  const p = _pollRequest();
  _pollPromise = p;
  p.then(() => { if (_pollPromise === p) _pollPromise = null; }, () => { if (_pollPromise === p) _pollPromise = null; });
  return p;
}

async function _pollRequest() {
  const gen = _pollGen;
  const epoch = _castEpoch;
  const gap = _lastPollEndAt ? Date.now() - _lastPollEndAt : 0;
  let status;
  // A request that never answers would hold the one-at-a-time slot for good: no more
  // polls, and a Next/Prev waiting in deferUntilFresh swallowed. Cut it off.
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const cut = ctl ? setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS) : null;
  try {
    status = await apiJson('/api/dlna/status', ctl ? { signal: ctl.signal } : {});
  } catch {
    _castPollFails++;
    _lastPollEndAt = Date.now();
    return false;
  } finally {
    clearTimeout(cut);
  }
  _lastPollEndAt = Date.now();
  if (gen !== _pollGen || !store.castDevice) return true; // the session changed meanwhile
  _castPollFails = 0;
  // Asked before our latest cast, or while one is on its way: it describes the track
  // being replaced. Applied, a late PLAYING would re-arm the end detector after the
  // advance, or a STOPPED from the swap would look like the end (finding 6).
  if (epoch !== _castEpoch || _castPosts > 0) return true;
  _applyStatus(status, gap);
  if (_adoptPromise) { try { await _adoptPromise; } catch {} }
  // The engine HOLDS a debounced queue save while this page's view of the cast is stale
  // (saveQueueNow), and re-checks on a timer. A timer is not enough: in a hidden desktop
  // tab timers run about once a minute, save timer and poll in one batch — the save looks
  // before the status lands and is held for good. So the hold is released HERE, by the
  // event that makes the view fresh: the status is applied, any adoption is done.
  if (gen === _pollGen && store.castDevice && castStateFresh()) {
    await _flushPendingSave();
    // A hint that could not go while the adoption was reading the queue goes now.
    if (store.castDevice && _followStatus) _maybeHint(_followStatus);
  }
  return true;
}

/** The page may have slept: before a Next/Prev acts on its idea of the current track,
 *  let one status poll (and any adoption it brings) land first. Returns true when it
 *  took the call — `fn` then runs once the poll has finished, whatever its outcome. */
export function deferUntilFresh(fn) {
  if (_bypassDefer || !store.castDevice || castStateFresh()) return false;
  // Every press counts, in order: Next ×3 is three steps, Prev after Next is not lost.
  _deferQueue.push(fn);
  if (_deferQueue.length > 1) return true; // the poll is already on its way
  const p = _pollPromise || pollCastOnce();
  const go = () => {
    const fns = _deferQueue;
    _deferQueue = [];
    _bypassDefer = true;
    try { for (const f of fns) { try { f(); } catch (e) { console.warn('[cast] deferred action failed', e); } } }
    finally { _bypassDefer = false; }
  };
  p.then(go, go);
  return true;
}

function _setText(sel, txt) { const el = $(sel); if (el) el.textContent = txt; }

function _applyStatus(status, gap) {
  if (!status) return;
  if (!status.active) {
    // The server gave up on the receiver (it stopped answering, two tracks in a row
    // never started, or another device took the receiver). Its session is already
    // gone: say why, end ours.
    if (status.abandoned) { abandonCast(status.abandoned, { stop: false }); return; }
    // Right after a server restart the sessions are still being restored: "inactive"
    // then means "not yet", not "gone".
    if (status.resuming) { _inactiveCount = 0; return; }
    if (castState.transitioning || status.state === 'TRANSITIONING') return;
    // Without a reason, believe it only the second time in a row.
    if (++_inactiveCount < 2) return;
    abandonCast('', { stop: false });
    return;
  }
  _inactiveCount = 0;
  if (status.stale) return; // transient backend query failure — skip tick, keep last state
  // The first cast is still connecting: no device, track or volume yet, `follow` false.
  // Nothing in it is about the receiver — above all, it must not drive the fallback's
  // stall clock or end detection.
  if (status.device === 'transitioning' && status.device_id == null) return;
  const now = Date.now();
  _lastStatusAt = now;
  const follow = status.follow === true;
  _sessionSeen(status.session_id);
  _followStatus = follow ? status : null;
  if (follow) _maybeAdopt(status);

  const dur = status.duration_seconds || 0;
  const pos = status.position_seconds || 0;
  const state = (status.state || '').toLowerCase();
  const playing = state.includes('playing');
  const paused = state.includes('paused');
  const stopped = state.includes('stopped') || state.includes('no_media');
  _lastState = playing ? 'playing' : paused ? 'paused' : stopped ? 'stopped' : 'other';

  // Detect track end. The Onkyo goes PLAYING → TRANSITIONING → STOPPED and zeros
  // position (keeps duration) at STOP, so we (a) LATCH "was playing" across the
  // TRANSITIONING blip and (b) compare against the last good position/duration
  // captured while playing — never the zeroed stopped frame.
  if (playing) {
    if (Number.isFinite(status.cast_seq)) _sawPlayingSeq = status.cast_seq;
    castState.skipAutoAdvance = false;
    castState.transitioning = false;
    _castSawPlaying = true;
    _castIssuedAt = 0;   // it started; the stall clock is done
    _castDeadTracks = 0; // the renderer is alive; the give-up budget resets
    _castWasPlaying = true;
    if (dur > 0) _castLastDur = dur;
    if (pos > 0 || !_castExtrap) { _castLastPos = pos; _castLastPosAt = now; }
    if (pos > 0) _castSeenPos = pos;
    _castExtrap = true;
  } else if (paused) {
    if (dur > 0) _castLastDur = dur;
    if (pos > 0) { _castLastPos = pos; _castLastPosAt = now; _castSeenPos = pos; }
    _castExtrap = false;
  }

  // The position NOW, not the last sample: across a poll gap the receiver kept playing.
  const est = _estPos(now);
  // A stopped receiver does not move on: freeze the estimate where it is.
  if (stopped) { _castLastPos = est; _castLastPosAt = now; _castExtrap = false; }
  _publish(playing);
  const shownDur = dur || castDuration();
  const shownPos = (playing || paused) && pos > 0 ? pos : est;
  if (shownDur > 0) {
    const pct = Math.min(100, (shownPos / shownDur) * 100);
    const fill = $('#playerProgressFill');
    if (fill) fill.style.width = pct + '%';
    const bar = document.getElementById('playerBar');
    if (bar) bar.style.setProperty('--player-progress', pct + '%');
    const fpFill = $('#fpProgressFill');
    if (fpFill) fpFill.style.width = pct + '%';
  }
  _setText('#playerTimeCurrent', fmtTime(shownPos));
  _setText('#playerTimeTotal', fmtTime(shownDur));
  _setText('#fpTimeCurrent', fmtTime(shownPos));
  _setText('#fpTimeTotal', fmtTime(shownDur));
  // Sync the cast volume slider. `null` = the server could not read it this time; the
  // slider stays where it is instead of jumping to 0 (finding 19).
  if (typeof status.volume === 'number') {
    const cvs = $('#fpCastVolume');
    const cvl = $('#fpCastVolLabel');
    if (cvs && !cvs.matches(':active')) { cvs.value = status.volume; }
    if (cvl) cvl.textContent = status.volume + '%';
  }

  // Play/pause icon follows the receiver (finding 9): the first tap after a cast used
  // to send "play" to a receiver that was already playing.
  if (playing) {
    if (!store.playerPlaying) _call(_ctx.onCastPlaying, true);
    _reportAndroid('playing', pos, shownDur);
  } else if (paused) {
    if (store.playerPlaying) _call(_ctx.onCastPlaying, false);
    _reportAndroid('paused');
  }

  if (follow) {
    // The server owns end-of-track and stalls. Nothing here advances or re-casts —
    // except at the very end of the queue, below.
    if (stopped && status.queue_ended) {
      if (store.playerPlaying) _call(_ctx.onCastPlaying, false);
      _reportAndroid('paused');
      // The server only knows the saved queue. Radio refills and autoplay picks are
      // the engine's: hand it the end once per cast, and it decides (it may well have
      // nothing to add — then its Next does nothing audible).
      // Only a FRESH end: a page opened the next day must not start autoplay on a
      // receiver that went quiet hours ago.
      const ago = status.queue_ended_ago;
      const fresh = Number.isFinite(ago) ? ago <= QUEUE_END_FRESH_S : _sawPlayingSeq === status.cast_seq;
      if (_endedSeq !== status.cast_seq && fresh) {
        _endedSeq = status.cast_seq;
        _ctx.nextTrack({ reason: 'ended' });
      }
    } else if (stopped && !castState.transitioning) {
      // Stopped in the middle of a track (by hand on the receiver, an input switch)
      // and the server is not about to move on: after two polls on the same cast, say
      // so — otherwise the next tap sends Pause to a stopped receiver and nothing
      // happens. Near the end, the server's advance is due: leave the icon alone.
      const nearEnd = serverNearEnd(est, castDuration());
      if (_stoppedSeq === status.cast_seq) _stoppedPolls++;
      else { _stoppedSeq = status.cast_seq; _stoppedPolls = 1; }
      if (_stoppedPolls >= 2 && !nearEnd) {
        if (store.playerPlaying) _call(_ctx.onCastPlaying, false);
        _reportAndroid('paused');
      }
    } else if (!stopped) {
      _stoppedSeq = null; _stoppedPolls = 0;
    }
    _maybeHint(status);
    return;
  }

  // ── Fallback: a server that does not follow the receiver ──
  // Our own cast is on its way: whatever the receiver says now is about the track
  // being replaced. Neither stall nor end may be judged from it.
  if (_castPosts > 0) return;
  // Stall clock (finding 8): only time the page actually watched counts. A page that
  // slept through the start of a track used to wake with "waited > 30 s", re-cast it
  // from 0 and skip it in the same burst of polls.
  if (gap > GAP_MS && _castIssuedAt && !_castSawPlaying) _castIssuedAt = now;
  // A cast was issued and the renderer never reached PLAYING. Nothing else in the
  // poll reacts to that: end-of-track detection needs a preceding PLAYING, so the
  // session just sits there and the queue stops. Re-issue once (the renderer may
  // have dropped the SetAVTransportURI), then give the track up and move on.
  // A receiver reporting a position is playing something: never re-cast over it.
  if (_castIssuedAt && !_castSawPlaying && store.castDevice && pos <= 1) {
    const waited = now - _castIssuedAt;
    if (waited > 15000 && !_castRetried) {
      _castRetried = true;
      const it = store.playerQueue[store.playerIndex];
      if (it) castItem(it).catch(() => {});
    } else if (waited > 30000) {
      _castDeadTracks++;
      if (_castDeadTracks >= 2) {
        abandonCast('The renderer is not playing anything — cast stopped');
        return;
      }
      _castIssuedAt = 0;
      _castWasPlaying = false; _castLastPos = 0; _castLastDur = 0; _castExtrap = false;
      castState.skipAutoAdvance = false;
      _ctx.nextTrack();
      return;
    }
  }
  // Auto-advance on a real end-of-track: we were playing (possibly via TRANSITIONING),
  // now stopped/no_media, observed real progress, and reached near the end. If the
  // duration is unknown, advance on any playing→stopped after progress.
  const ended = _castWasPlaying && stopped;
  const sawProgress = est > 1;
  // "Near the end" has to tolerate a stale tail. The last position we can observe is
  // whatever the renderer reported on the last successful poll, and that sample can
  // be far from the real end: each status query makes three UPnP calls with 3s
  // timeouts, and a `stale` tick updates nothing at all — precisely what happens at
  // the end of a track, when the renderer is busy finishing and loading. A fixed 12s
  // window therefore missed real end-of-track stops and the queue simply halted.
  // A percentage floor covers the long gap; the absolute one still covers short
  // tracks. Stopping the renderer by hand inside the last 15% now advances instead
  // of stopping — a far cheaper mistake than silently ending the session.
  const d = castDuration();
  const nearEnd = d === 0 || est >= d - 12 || est >= d * 0.85;
  if (!castState.skipAutoAdvance && ended && sawProgress && nearEnd) {
    _castWasPlaying = false; _castLastPos = 0; _castLastDur = 0; _castExtrap = false;
    _ctx.nextTrack();
    return;
  }
  if (stopped && !castState.transitioning && store.playerPlaying) _call(_ctx.onCastPlaying, false);
}

// Wire the cast button(s) and the cast volume slider. Call once from each engine's init().
let _wired = false;
export function wireControls() {
  const castBtn = $('#playerCastBtn');
  if (castBtn) castBtn.addEventListener('click', handleCastClick);
  if ($('#fpCastBtn')) $('#fpCastBtn').addEventListener('click', handleCastClick);

  const castVolSlider = $('#fpCastVolume');
  if (castVolSlider) {
    castVolSlider.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value);
      const label = $('#fpCastVolLabel');
      if (label) label.textContent = vol + '%';
      if (store.castDevice) {
        clearTimeout(_castVolTimer);
        _castVolTimer = setTimeout(() => { if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: vol } }).catch(() => {}); }, 150);
      }
    });
  }
  if (_wired) return;
  _wired = true;
  // A page coming back to the screen asks at once instead of waiting out the timer
  // (which, after a long sleep, may be a back-off interval).
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // About to be frozen: a queue save still in its debounce would fire only on
        // wake, over whatever the server appended meanwhile. Save it now.
        // keepalive: a page frozen right after may never finish an ordinary fetch.
        if (store.castDevice && store.playerSavePending && castStateFresh()) _call(_ctx.flushQueue, { keepalive: true });
        return;
      }
      if (!store.castDevice || _pollPromise) return;
      const gen = _pollGen;
      clearTimeout(store.castPollTimer);
      _tick(gen);
    });
  } catch {}
}

// Exposed for tests only.
export const _internals = {
  POLL_MS, GAP_MS,
  ctx: () => _ctx, // the hooks the engine wired (tests call the real ones)
  state: () => ({ castSeq: _castSeq, lastPos: _castLastPos, lastPosAt: _castLastPosAt, extrap: _castExtrap,
    wasPlaying: _castWasPlaying, issuedAt: _castIssuedAt, pollInFlight: !!_pollPromise, hintKey: _hintKey, lastState: _lastState, seenPos: _castSeenPos }),
  reset() {
    _pollGen++;
    clearTimeout(store.castPollTimer);
    clearTimeout(_castTransitionTimer);
    store.castPollTimer = null;
    _castSeq = -1; _castPosts = 0; _hintKey = ''; _hintInFlight = false; _hintAgain = false; _followStatus = null; _noteScheduled = false; _abKey = '';
    _pollPromise = null; _castEpoch = 0; _endedSeq = null; _inactiveCount = 0;
    _deferQueue = []; _bypassDefer = false; _sessionId = null; _sawPlayingSeq = null; _adoptPromise = null; _lastPollEndAt = 0; _lastStatusAt = 0; _castPollFails = 0; _castDeadTracks = 0; _restoreTries = 0;
    _castIssuedAt = 0; _castSawPlaying = false; _castRetried = false;
    castState.skipAutoAdvance = false; castState.transitioning = false;
    _trackReset(0);
  },
};
