// player.js — Audio playback, controls, media session, queue persistence

import { store } from './store.js';
import { $, $$, fmtTime, showToast, setArt} from './utils.js';
import { apiJson, mixPlayUrl } from './api.js';
import { mixLog, watchMixSrc, watchMixEvents } from './mixlog.js';
import { isMixStreamSrc, isPrematureMixEnd, mixKnownDuration, mixStatus, awaitFinished, keepMixAlive, planMixSeek, toastSeekBeyondBuilt, explainMixFailure, resumeWhenBuilt } from './mixstream.js';
import { openModal } from './downloads.js';
import { renderQueue, shuffleNext, shufflePrev, peekShuffleNext, adoptShuffleIndex, resetShuffleOrder, serializeShuffleOrder, restoreShuffleOrder, autoplayStart, markAutoplayStart, appendAutoplayRows, capAutoplayTail } from './queue.js';
import { syncFullPlayer, syncMuteUI } from './fullplayer.js';
import { getCachedUrl, waitForCache, prefetchUpcoming, cleanup as prefetchCleanup, pausePrefetch, resumePrefetch, streamQuality } from './prefetch.js';
import * as cast from './cast.js';
import { ab as _ab, abPlay, abPause, abStop } from './androidbridge.js';

const audio = $('#audioElement');
let _lastAbUpdate = 0;

// Play/pause from outside the page's own buttons (notification, lock screen, media keys,
// remote control). While casting they act on the receiver, never on the local element.
function _pauseLocalPlayback() {
  if (store.castDevice) { cast.castPause(); return; }
  audio.pause();
}
function _resumeLocalPlayback() {
  if (store.castDevice) { cast.castPlay(); return; }
  audio.play().catch(() => {});
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

// Is this device playing? A casting device asks its renderer's state (B10).
function _localPlaying() {
  if (store.castDevice) return !!store.playerPlaying;
  return !audio.paused && !audio.error;
}

function _remotePlay() {
  if (store.castDevice) { apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {}); return; }
  // Nothing on the element yet (a target that never played): start the current row.
  if (!audio.src && store.playerIndex >= 0) { loadAndPlay(); return; }
  audio.play().catch(() => {});
}
function _remotePause() {
  if (store.castDevice) { apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {}); return; }
  audio.pause();
}
function _remoteSeek(sec) {
  if (!(sec >= 0) || !isFinite(sec)) return;
  if (store.castDevice) { apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: sec } }).catch(() => {}); return; }
  try { audio.currentTime = sec; } catch {}
}
function _remoteVolume(value) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  store.playerVolume = v;
  const el = document.getElementById('playerVolume'); if (el) el.value = Math.round(v * 100);
  const fp = document.getElementById('fpVolume'); if (fp) fp.value = Math.round(v * 100);
  if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(v * 100) } }).catch(() => {});
  else audio.volume = v;
  syncMuteUI();
}

// A transfer: the server has merged the controller's queue into this device's queue
// file. Take queue, index, order and radio from it without touching the element, then
// play through the full engine path and carry on at the controller's position.
function _applyTransfer(value) {
  // The server sends the merged state IN the command; reading the file back instead
  // raced a save from this device. Only an old server leaves it out.
  const inline = value && typeof value === 'object' && Array.isArray(value.queue);
  const got = !inline ? loadQueueState({ touchDeck: false })
    : !value.queue.length ? Promise.resolve(null)
    : _adoptTransferredQueue({ ...value, queue: value.queue.slice() }).then(() => value);
  got.then(async (data) => {
    if (!data) return;
    const pos = data.position_seconds > 0 ? data.position_seconds : 0;
    await loadAndPlay();
    import('./upnext.js').then(u => {
      const id = u.activePlaylistId();
      if (id && u.isTempActive()) u.replaceByName(id, store.playerQueue).catch(() => {});
    }).catch(() => {});
    if (!(pos > 0) || store.castDevice) return;
    const src = audio.src; // a newer load changes it; then the position is not ours
    const seek = () => { if (audio.src === src) { try { audio.currentTime = pos; } catch {} } };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
  });
}

// Remote control: apply a command from a controlling device to LOCAL playback
// (this device is the target). Mirrors window._androidMediaAction above.
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
// `remote:report` asks remote.js to report now instead of on its tick. Never from a
// controller: it paints the remote state through updatePlayPauseIcon, and would loop.
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
if (audio && typeof audio.play === 'function') {
  const play = audio.play.bind(audio);
  audio.play = () => {
    const p = play();
    if (p && typeof p.then === 'function') {
      p.then(() => { _playBlocked = false; }, (e) => { if (e && e.name === 'NotAllowedError') { _playBlocked = true; _remoteReport(); } });
    }
    return p;
  };
}
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
  const i = store.playerIndex, q = store.playerQueue;
  let next = null;
  if (i >= 0 && q.length) {
    if (store.shuffleEnabled && q.length > 1) { const p = peekShuffleNext(); next = p == null ? null : q[p]; }
    else if (i + 1 < q.length) next = q[i + 1];
    else if (store.repeatMode === 'all' && q.length > 1) next = q[0];
  }
  return {
    playing: _castField('playing', 'boolean') ?? _localPlaying(),
    position_seconds: _castPosition() ?? (audio.currentTime || 0),
    duration: _castDuration() ?? (_getDuration() || 0),
    volume: store.playerVolume,
    index: i,
    queue_len: q.length,
    // What is playing — a recommendation played outside the queue included — so title,
    // art and the like match the position and duration; `index` stays the row.
    track: _remoteItem(_currentRecItem || q[i]),
    next: _remoteItem(next),
    engine: 'classic',
    dj: null,
    blocked: !store.castDevice && _playBlocked,
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
  const dur = _getDuration();
  const cur = audio.currentTime || 0;
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
  syncMuteUI();
  updatePlayPauseIcon(_localPlaying());
  updateDownloadButtons(item);
  updatePlaylistBadge();
  showPlayerBar();
  renderQueue();
}

// Called by native side when bridge is injected (may be after playback started)
window._androidBridgeReady = function() {
  if (!audio.paused && _ab()) {
    const item = store.playerQueue[store.playerIndex];
    if (item) abPlay(item.name, item.artist);
  }
};

// ── Helper: get duration with Safari fallback ──
function _getDuration() {
  let dur = audio.duration;
  const declared = mixKnownDuration(audio.src);   // a streamed mix: the element's length is what has arrived (mixstream.js)
  if (declared) return declared;
  if (dur && isFinite(dur) && dur > 0) return dur;
  const item = store.playerQueue[store.playerIndex] || _currentRecItem;
  if (item && item.duration_ms > 0) return item.duration_ms / 1000;
  return null;
}

/** Load the finished (non-progressive) file of the streamed mix and seek in it. */
function _reloadFinishedAndSeek(to, play) {
  let next = String(audio.src || '');
  try { const u = new URL(next, location.href); u.searchParams.delete('progressive'); next = u.href; } catch {}
  const wasPlaying = play === undefined ? !audio.paused : !!play;   // after a media error `paused` says nothing
  const onMeta = () => {
    audio.removeEventListener('loadedmetadata', onMeta);
    if (audio.src !== next) return;
    try { audio.currentTime = to; } catch {}
    if (wasPlaying) audio.play().catch(() => {});
  };
  audio.addEventListener('loadedmetadata', onMeta);
  audio.src = next;
  audio.load();
  if (wasPlaying) audio.play().catch(() => {});
}

/** Seek the element to `to` seconds. A streamed mix is served as a body that is still being
 *  built (progressive=1: no Range): inside what is buffered the element seeks itself;
 *  beyond it nothing can be answered until the build is done — the listener is told and
 *  the music plays on; once it is done the finished file is loaded (mixstream.js). */
export function seekLocal(to) {
  const src = String(audio.src || '');
  if (isMixStreamSrc(src)) {
    planMixSeek(audio, to).then((plan) => {
      if (audio.src !== src) return;                        // the track changed meanwhile
      if (plan === 'direct') { try { audio.currentTime = to; } catch {} }
      else if (plan === 'reload') _reloadFinishedAndSeek(to);
      else toastSeekBeyondBuilt();
    });
    return;
  }
  try { audio.currentTime = to; } catch {}
}

/** Fraction → seconds with this engine's idea of the duration. */
export function seekToFraction(pct) {
  const dur = _getDuration();
  if (dur) seekLocal(pct * dur);
}

// ── Play Track ──
export function playTrack(item) {
  store.radioMode = false;
  store.playerQueue = [item];
  store.playerIndex = 0;
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
// Bumped by every load and by silenceForRemote: a load that waited for the cache checks
// it, so a superseded one does not set its source over the newer track.
let _loadGen = 0;
export async function loadAndPlay() {
  // The recommender's cursor is what picks the NEXT autoplay track, so stopping it
  // here would make the station serve its first pick again — and append it to the
  // queue a second time. It stays alive for as long as the queue still carries an
  // autoplay tail, which covers the append itself, Previous back along the tail and
  // a jump to a row above the divider; replacing or clearing the queue ends it.
  const keepRec = _keepRecCursor || autoplayStart() >= 0;
  _keepRecCursor = false;
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) return;
  if (store.remoteTarget) { document.dispatchEvent(new Event('remote:play')); return; }
  const myLoad = ++_loadGen;
  _remoteReport(); // the index is final: a controller shows the new track before it loads
  // Stop any virtual rec playback — we're back in the real queue
  if (!keepRec) import('./recommendations.js').then(m => m.stopRecPlayback());
  _currentRecItem = null; // clear stale rec so "Add to playlist" targets the queue track
  const item = store.playerQueue[store.playerIndex];
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
    cast.castTrack(item, { name: cleanName, artist: cleanArtist }); // the one cast POST (cast.js)
  } else {
    let cached = getCachedUrl(cleanName, cleanArtist);
    // If prefetch is downloading this track, wait for it (avoids competing parallel stream)
    if (!cached && localStorage.getItem('ms_prefetch_enabled') !== '0') {
      const waited = await waitForCache(cleanName, cleanArtist, 2000);
      if (myLoad !== _loadGen) return; // superseded (a newer load, or remote control began)
      if (waited) cached = waited;
    }
    if (cached) {
      audio.src = cached;
    } else {
      const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) });
      audio.src = mixPlayUrl(item) || `/api/player/stream?${params}&quality=${streamQuality()}`;
    }
    audio.load();
    audio.play().catch(() => {});
    // Prefetch cleanup + starts on 'playing' event (if enabled)
    if (localStorage.getItem('ms_prefetch_enabled') !== '0') {
      prefetchCleanup(store.playerQueue, store.playerIndex);
    }
  }
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

// ── Stall recovery ──
// A deck that reports playing while its clock stands still is dead playback that
// nothing in this engine ever revisits. It is what a hung stream request looks like:
// `ended` fires, loadAndPlay sets src and calls play(), and if that request never
// answers there is no error to react to — `error` only fires on a real failure, not
// on a request that simply hangs. Reported from a phone playing over Bluetooth with
// the screen off: playback stopped between tracks and only a screen wake brought it
// back, because waking restores the radio and the pending request finally completes.
//
// This has to run on its own timer, not on timeupdate: a frozen element emits no
// timeupdate, so that handler is blind to exactly the failure it would need to catch.
//
// Recovery ladder, so the cheap fix is tried first and a track is only abandoned last:
//   6s   nudge play() — enough for a decode/buffer hiccup
//   12s  re-arm the source, which re-issues the HTTP request and restores position.
//        Skipped for blob: sources — those are already local, so a re-load fixes
//        nothing and would only throw away a decoded buffer.
//   20s  give up on the track and advance
let _progressT = -1, _progressAt = 0, _rearmedAt = 0;
function _stallWatchdog() {
  if (store.castDevice || store.remoteTarget) { _progressAt = 0; return; }
  // Deliberately NOT excluding audio.seeking: a seek whose request never answers
  // leaves the element seeking forever with the clock parked on the target, which is
  // precisely a stall to recover from. A seek that IS progressing moves currentTime,
  // and the position check below resets the clock on its own.
  if (!audio || audio.paused || !audio.src) { _progressAt = 0; return; }
  const now = Date.now();
  const t = audio.currentTime;
  if (!_progressAt || Math.abs(t - _progressT) > 0.05) {
    _progressT = t; _progressAt = now; _rearmedAt = 0; return;
  }
  const stalledMs = now - _progressAt;
  if (stalledMs < 6000) return;
  if (stalledMs < 12000) { audio.play().catch(() => {}); return; }
  if (stalledMs < 20000) {
    // One re-arm per stall — re-issuing every 2s would restart the request forever
    // and guarantee it never finishes.
    if (_rearmedAt || String(audio.src).startsWith('blob:')) { audio.play().catch(() => {}); return; }
    _rearmedAt = now;
    const src = audio.src, pos = t;
    if (localStorage.getItem('ms_dj_debug')) console.warn(`[stall] re-arming stream at ${pos.toFixed(1)}s`);
    const onMeta = () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      if (pos > 0.05) { try { audio.currentTime = pos; } catch {} }
      audio.play().catch(() => {});
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.src = src;
    audio.load();
    audio.play().catch(() => {});
    return;
  }
  _progressAt = 0; _rearmedAt = 0;
  if (localStorage.getItem('ms_dj_debug')) {
    console.warn(`[stall] frozen at ${t.toFixed(1)}s (readyState=${audio.readyState}) — advancing`);
  }
  nextTrack();
}

// ── Next / Prev ──
let _lastNextTime = 0;
export function nextTrack() {
  // A controller advances nothing of its own: every user Next is a remote:cmd, and an
  // automatic one (ended, error, cast end-of-track) would transfer its queue.
  if (store.remoteTarget) return;
  // Casting from a page that just woke: let one status poll adopt what the server moved
  // on to, THEN step from there.
  if (cast.deferUntilFresh(() => nextTrack())) return;
  // Throttle rapid advances (error/ended chain-skips) — matches crossfade/dj engines
  const now = Date.now();
  if (now - _lastNextTime < 500) return;
  _lastNextTime = now;
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // A track played VIRTUALLY — outside the queue, which now means only a pick the
  // user started in the recommendations panel — advances along that list. The test
  // is _currentRecItem, not isPlayingRec(): the recommender's cursor stays set while
  // the autoplay tail plays, and those rows are ordinary queue rows.
  if (_currentRecItem) {
    import('./recommendations.js').then(m => {
      m.playNextRec().then(filled => {
        if (!filled) { audio.pause(); updatePlayPauseIcon(false); }
      });
    });
    return;
  }
  _nextTrackInQueue();
}

function _nextTrackInQueue() {
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    let next = shuffleNext();
    if (next == null && store.repeatMode === 'all') {
      // Permutation exhausted and repeat-all is on: deal a fresh one.
      resetShuffleOrder();
      next = shuffleNext();
    }
    if (next == null) { _autofillFromRecs(); return; }
    store.playerIndex = next;
    loadAndPlay();
  } else if (store.playerIndex < store.playerQueue.length - 1) {
    store.playerIndex++;
    loadAndPlay();
  } else if (store.repeatMode === 'all') {
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
        if (store.remoteTarget) return; // started before control began: nothing plays here now
        const newTracks = (data.tracks || []).filter(t => {
          const key = (t.name || '').toLowerCase() + '|' + (t.artist || '').toLowerCase();
          return !store.playerQueue.some(q => (q.name || '').toLowerCase() + '|' + (q.artist || '').toLowerCase() === key);
        });
        if (newTracks.length) {
          for (const t of newTracks) store.playerQueue.push(t);
          store.playerIndex++;
          loadAndPlay();
          renderQueue();
          saveQueueDebounced();
          import('./upnext.js').then(u => u.mirrorAdd(newTracks));
        } else {
          showToast('No more similar tracks found');
          audio.pause();
          updatePlayPauseIcon(false);
        }
      }).catch(() => {
        showToast('Failed to load more tracks');
        audio.pause();
        updatePlayPauseIcon(false);
      }).finally(() => { store.radioLoading = false; });
    }
  } else {
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
        audio.pause();
        updatePlayPauseIcon(false);
      }
    });
  }).catch(() => { _autofillPending = false; });
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

// ── Play a track from recommendations (virtual, not in queue) ──
let _currentRecItem = null;
export function playRecTrack(item) {
  // An autoplay pick is automatic: on a controller it would transfer this device's queue.
  if (_takeAutofill()) { if (!store.remoteTarget) _appendAutoplay(item); return; }
  // On a controller: the target appends it and plays it now (queue_op play_now). A remote:play
  // transferred this device's scratch queue and the target lost its own.
  if (store.remoteTarget) { addToQueue([item], true); return; }
  _currentRecItem = item;
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
    const cached = getCachedUrl(cleanName, cleanArtist);
    if (cached) {
      audio.src = cached;
    } else {
      const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) });
      audio.src = mixPlayUrl(item) || `/api/player/stream?${params}&quality=${streamQuality()}`;
    }
    audio.load();
    audio.play().catch(() => {});
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
    if (store.playerIndex >= 0) loadAndPlay();
    return;
  }
  if (!store.castDevice && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    const prev = shufflePrev();
    if (prev != null) { store.playerIndex = prev; loadAndPlay(); return; }
    // No history to walk back: right after switching shuffle on, and after every
    // page load, because the order is module memory. Fall through to the linear
    // Previous rather than being a dead button.
  }
  if (store.playerIndex > 0) {
    store.playerIndex--;
    loadAndPlay();
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
      position_seconds: store.castDevice ? cast.castPosition() : (audio.currentTime || 0),
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

// Load `item` without playing it, to start at `pos` on Play: the restored queue, and
// the hand-back when a cast ends (cast.js primeLocal).
const _primed = { src: '', pos: 0 }; // the source _primeAudio set, and where it will start
function _primeAudio(item, pos) {
  const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: (store.streamToken || store.authToken) });
  audio.src = mixPlayUrl(item) || `/api/player/stream?${params}&quality=${streamQuality()}`;
  audio.preload = 'none';
  _primed.src = audio.src;
  _primed.pos = pos > 0 ? pos : 0;
  if (pos > 0) {
    const restoreSrc = audio.src;
    audio.addEventListener('loadedmetadata', () => {
      // Only seek if still the restored track — the user may have switched tracks
      // before this one-shot metadata load fired.
      if (audio.src !== restoreSrc) return;
      // A streamed mix whose build is gone (a deploy empties the cache) cannot be sought
      // yet: wait for it, with visible state (mixstream.js).
      if (isMixStreamSrc(restoreSrc)) resumeWhenBuilt(audio, pos, (p) => _reloadFinishedAndSeek(p, store.playerPlaying), () => audio.src === restoreSrc);
      else audio.currentTime = pos;
    }, { once: true });
  }
}

// What the classic engine plays after the current track (cast.js next-hint).
function _castUpcoming() {
  const q = store.playerQueue, i = store.playerIndex;
  if (!q.length || i < 0) return null;
  let n = null;
  if (store.shuffleEnabled && q.length > 1) n = peekShuffleNext();
  else if (i + 1 < q.length) n = i + 1;
  else if (store.repeatMode === 'all' && q.length > 1) n = 0;
  return n == null ? null : { index: n, item: q[n] };
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
 *  cast and hint and has ruled out repeat, radio and a controller). A list; [] = it has
 *  nothing; null = not known yet, or a pick plays virtually. */
function _castPeekAutoplay(n) {
  if (_currentRecItem) return null;
  const m = _recs();
  return m ? m.peekNextRecs(n) : null;
}

// The server's cast follower moved on to queue[idx] while the page slept: show it, do
// not load or cast it (cast.js). idx -1: not in this queue.
function _adoptCastTrack(idx, track, saved) {
  // No Smart Queue in this engine.
  const adopted = cast.adoptQueueIndex(idx, { shuffle: adoptShuffleIndex, restoreOrder: restoreShuffleOrder, saved });
  if (!adopted) return;
  capAutoplayTail(AUTOPLAY_MAX);
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
 *  — no source, no volume, no paint. */
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
 *  order, radio and playlist context only: no source, no volume, no paint. Resolves to
 *  the saved state when a queue was taken, else null. */
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
      audio.volume = store.playerVolume;
      $('#playerVolume').value = Math.round(store.playerVolume * 100);
      const item = store.playerQueue[store.playerIndex];
      if (item) {
        setArt($('#playerImg'), item.image);
        $('#playerTitle').textContent = item.name || '';
        $('#playerArtist').textContent = item.artist || '';
        // Pre-set audio source so play button works immediately
        _primeAudio(item, data.position_seconds);
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
export { audio };
export function getAudio() { return audio; }

// Fully stop local playback (used when handing off / controlling a remote device,
// so the source device doesn't keep playing alongside the target).
export function pauseLocal() { try { audio.pause(); } catch {} pausePrefetch(); updatePlayPauseIcon(false); }

/** Entering remote control: nothing on this device may sound or advance on its own —
 *  a load waiting for the cache, or a cast renderer, used to carry on. The automatic
 *  paths themselves (ended, error, nextTrack) return under remoteTarget. */
export function silenceForRemote() {
  _loadGen++; // a load waiting for the cache gives up
  try { audio.pause(); } catch {}
  pausePrefetch();
  updatePlayPauseIcon(false);
  // Paused, not stopped: the session survives, and leaving control can resume it.
  if (store.castDevice) apiJson('/api/dlna/pause', { method: 'POST' }).catch(() => {});
}

// ── Init ──
export function init() {
  watchMixSrc(audio, 'classic'); watchMixEvents(audio, 'classic');   // what the element says about a streamed mix, to the server's log
  keepMixAlive(() => audio);   // a streamed mix that is playing (or paused) is kept in the server's cache
  setInterval(_stallWatchdog, 2000);
  // Audio events
  audio.addEventListener('play', () => {
    updatePlayPauseIcon(true);
    const item = store.playerQueue[store.playerIndex];
    if (item) abPlay(item.name, item.artist);
  });
  // 'playing' fires after buffering — start prefetch if enabled
  audio.addEventListener('playing', () => {
    if (localStorage.getItem('ms_prefetch_enabled') !== '0') resumePrefetch();
  });
  audio.addEventListener('pause', () => {
    // Casting pauses the element; the receiver plays on (icon: cast.js poll). The
    // Android shell must not hear a pause — it would let the page freeze mid-cast.
    if (cast.castOwnsLocalPause()) return;
    updatePlayPauseIcon(false);
    pausePrefetch();
    abPause();
  });
  audio.addEventListener('ended', () => {
    if (store.remoteTarget) return; // a controller plays nothing out and advances nothing
    // An `ended` far from the mix's real end: reload the finished file where it stopped (once per 30 s).
    if (isPrematureMixEnd(audio, store.playerQueue[store.playerIndex]) && Date.now() - (audio._prematureAt || 0) > 30000) {
      audio._prematureAt = Date.now();
      console.warn(`[mix] premature ended at ${audio.currentTime.toFixed(1)}s — reloading from there`);
      _reloadFinishedAndSeek(audio.currentTime || 0, true);
      return;
    }
    if (store.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      nextTrack();
    }
  });
  audio.addEventListener('timeupdate', () => {
    const dur = _getDuration();
    if (!dur) return;
    const pct = (audio.currentTime / dur) * 100;
    $('#playerProgressFill').style.width = pct + '%';
    $('#playerTimeCurrent').textContent = fmtTime(audio.currentTime);
    $('#playerTimeTotal').textContent = fmtTime(dur);
    // Sync mini bar top progress line
    document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
    // Sync full player
    const fpFill = $('#fpProgressFill');
    if (fpFill) fpFill.style.width = pct + '%';
    const fpCur = $('#fpTimeCurrent');
    if (fpCur) fpCur.textContent = fmtTime(audio.currentTime);
    const fpTot = $('#fpTimeTotal');
    if (fpTot) fpTot.textContent = fmtTime(dur);
    // Update Android notification progress (throttled to ~1/sec)
    if (_ab() && Math.abs(audio.currentTime - (_lastAbUpdate || 0)) >= 1) {
      _lastAbUpdate = audio.currentTime;
      _ab().onProgress(Math.floor(audio.currentTime * 1000), Math.floor(dur * 1000));
    }
  });
  audio.addEventListener('error', (e) => {
    if (store.remoteTarget) return; // a controller's element: nothing to skip
    if (!audio.src) return; // ignore error from cleared src
    const code = audio.error?.code || '?';
    const msg = audio.error?.message || '';
    const src = audio.src?.substring(0, 60) || 'none';
    const _item = store.playerQueue[store.playerIndex];
    if (_item && _item.mix_url && isMixStreamSrc(audio.src)) {
      // A streamed mix: ONE recovery path owns the element (any source, progressive or the
      // finished file). Events during it are the same failure; an `error` event that finds no
      // error on the element is the stale event of a load we replaced and is ignored.
      if (audio._mixRec) return;
      if (!audio.error) { mixLog('error-stale', audio, {}, 'classic'); return; }
      audio._mixRec = true;
      const failedSrc = audio.src, pos = audio.currentTime || 0;
      mixLog('recover', audio, { pos: Math.round(pos) }, 'classic');
      const done = () => { audio._mixRec = false; };
      const skip = (why) => {
        done();
        mixLog('skip', audio, { why }, 'classic');
        explainMixFailure(_item, `Stream error (code ${code}), skipping`);
        setTimeout(() => nextTrack(), 2000);
      };
      const reload = (p) => {
        done();
        // The element may have recovered by itself (WebKit retries a failed range request): keep a load that works.
        if (!audio.error && audio.readyState >= 2 && audio.src === failedSrc) {
          mixLog('keep', audio, { pos: Math.round(p) }, 'classic');
          if (p > 1 && Math.abs((audio.currentTime || 0) - p) > 5) { try { audio.currentTime = p; } catch {} }
          if (store.playerPlaying && audio.paused) audio.play().catch(() => {});
          return;
        }
        mixLog('reload-finished', audio, { pos: Math.round(p) }, 'classic');
        _reloadFinishedAndSeek(p, store.playerPlaying);
      };
      mixStatus(failedSrc).then((st) => {
        if (audio.src !== failedSrc) { done(); return; }          // the listener moved on
        const url = (() => { try { return new URL(failedSrc).searchParams.get('url') || ''; } catch { return ''; } })();
        const tr = audio._mixTry && audio._mixTry.url === url && Date.now() - audio._mixTry.at < 60000 ? audio._mixTry : { url, n: 0, at: Date.now() };
        if (st && st.building) {
          mixLog('wait', audio, { pos: Math.round(pos) }, 'classic');
          awaitFinished(audio, pos, reload, () => audio.src === failedSrc && audio._mixRec,
            (m) => { showToast(m, true); skip(String(m).slice(0, 60)); });
        } else if (st && st.cached && tr.n < 2) {
          tr.n++; tr.at = Date.now(); audio._mixTry = tr;
          reload(pos);
        } else {
          skip(st ? (st.cached ? 'again' : 'idle') : 'nostatus');
        }
      });
      return;
    }
    showToast(`Stream error (${code}): ${msg || src}`);
    // Don't chain-skip — wait 2s
    setTimeout(() => nextTrack(), 2000);
  });

  // Controls
  $('#playerPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      cast.castToggle();
    } else {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    }
  });
  $('#playerNext').addEventListener('click', nextTrack);
  $('#playerPrev').addEventListener('click', prevTrack);
  $('#playerVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    if ($('#fpVolume')) $('#fpVolume').value = e.target.value;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      audio.volume = store.playerVolume;
    }
    syncMuteUI();
  });
  async function _seekFromEvent(bar, e) {
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    // Under remote control the target seeks (B6): the touchstart below suppresses the
    // click remote.js listens for, and this device's own element is paused anyway.
    if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'seek_pct', value: pct } })); return; }
    const dur = cast.castSeekDuration(_getDuration); // while casting: the receiver's, not the element's
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

  async function _removeFromPlaylist() {
    // The playlist the target plays from is not this device's playlistMode, and its
    // row index is not ours — not something to guess from here.
    if (store.remoteTarget) {
      const dev = store.remoteDevices[store.remoteTarget];
      showToast(`Remove it on ${(dev && dev.name) || 'the playing device'}`);
      return;
    }
    const idx = store.playerIndex;
    const item = idx >= 0 ? store.playerQueue[idx] : null;
    if (!item || !store.playlistMode) return;
    try {
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
        method: 'POST', body: { name: cleanName, artist: cleanArtist, index: idx },
      });
      showToast(`Removed from ${store.playlistMode.name}`);
      // Mirror the backend removal in the local queue / now-playing UI.
      if (idx >= 0 && idx < store.playerQueue.length) {
        const wasCurrent = (idx === store.playerIndex);
        store.playerQueue.splice(idx, 1);
        if (idx < store.playerIndex) store.playerIndex--;
        else if (wasCurrent) {
          if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
          if (store.playerIndex >= 0) {
            try { if (audio) audio.pause(); } catch (e) {}
            loadAndPlay();
          } else {
            // Queue emptied: stop the track that was just removed.
            try { if (audio) audio.pause(); } catch (e) {}
          }
        }
        renderQueue();
        saveQueueDebounced();
      }
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
    getAudioEl: getAudio, nextTrack, syncVolume: () => { const el = getAudio(); if (el) el.volume = store.playerVolume; },
    getUpcoming: _castUpcoming,
    adoptTrack: _adoptCastTrack,
    peekAutoplay: _castPeekAutoplay,
    appendAutoplayRows: _castAppendAutoplay,
    pauseLocal,
    resumeLocal: _resumeLocalPlayback,
    flushQueue,
    onCastPlaying: updatePlayPauseIcon,
    // A restored queue that was never played sits at 0 with its seek still pending.
    localPosition: () => (_currentRecItem ? 0
      : (!audio.currentTime && _primed.src && audio.src === _primed.src ? _primed.pos : (audio.currentTime || 0))),
    primeLocal: (idx, pos) => { const it = _currentRecItem || store.playerQueue[idx]; if (it) _primeAudio(it, pos); },
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
    if (!store.playerQueue.length && !audio.src) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (store.castDevice) {
          cast.castToggle();
        } else {
          if (audio.paused) audio.play().catch(() => {}); else audio.pause();
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
        else audio.volume = store.playerVolume;
        syncMuteUI();
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else audio.volume = store.playerVolume;
        syncMuteUI();
        break;
    }
  });

  // Periodic save while playing
  // Not while a cast view may be stale: the server's follower may have moved on.
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
          position_seconds: store.castDevice ? cast.castPosition() : (audio.currentTime || 0), volume: store.playerVolume,
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
