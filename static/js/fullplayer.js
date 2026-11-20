// fullplayer.js — Full player UI, open/close, sync, volume, desktop split

import { store } from './store.js';
import { $, fmtTime, showToast, historyBack, setArt} from './utils.js';
import { apiJson } from './api.js';
import { castDuration, castToggle } from './cast.js';
import { renderQueueInto, renderQueue, openFpQueuePanel, closeFpQueuePanel, closeQueuePanel, scrollToNowPlaying, resetShuffleOrder } from './queue.js';
import { toggleLike, isLiked } from './likes.js';
import * as djPanel from './djpanel.js';
// Namespace import: clearQueueAction is C2's newer export; a missing name here is
// `undefined`, where a named import of it would fail the whole module.
import * as queueMod from './queue.js';

// Forward references set during init to avoid circular imports
let nextTrack, prevTrack, loadAndPlay, hidePlayerBar, saveQueueDebounced, updatePlayPauseIcon;
let _audioRef = null;    // static ref (classic player)
let _engineSeek = null;
let _engineVolume = null; // DJ engine: sets both decks, not just the one playing
let _audioGetter = null; // dynamic getter (crossfade player — returns active deck)

function audio() {
  return _audioGetter ? _audioGetter() : _audioRef;
}

export function setPlayerRefs(refs) {
  nextTrack = refs.nextTrack;
  prevTrack = refs.prevTrack;
  loadAndPlay = refs.loadAndPlay;
  hidePlayerBar = refs.hidePlayerBar;
  saveQueueDebounced = refs.saveQueueDebounced;
  updatePlayPauseIcon = refs.updatePlayPauseIcon;
  _audioRef = refs.audio;
  _audioGetter = refs.getAudio || null;
  _engineSeek = refs.seekToFraction || null; // DJ engine only; classic leaves it unset
  _engineVolume = refs.setVolume || null;
}

// ── Remote control (this device drives another one) ──
// Under store.remoteTarget this device is a remote: it never changes its own playback
// state for a button press, it asks the target (remote.js turns `remote:cmd` into a
// command) and shows what the target reports. `dev` is that report.
function _remoteDev() {
  return store.remoteTarget ? (store.remoteDevices[store.remoteTarget] || null) : null;
}

function _remoteCmd(action, value) {
  const detail = value === undefined ? { action } : { action, value };
  document.dispatchEvent(new CustomEvent('remote:cmd', { detail }));
}

const _REPEAT_MODES = ['off', 'all', 'one'];

// What was just asked of the target, per key (`muted`, `shuffle`, `repeat`), until its
// report shows it. Without this a second press computed the next state from a report
// older than the first press — a snapshot that arrived in between still carried the
// old value (production: unmute 0.8 s after mute sent mute:true again, the target
// stayed silent). remote.js writes the value into the CURRENT snapshot object too, so
// only a snapshot that replaced it (another object) can confirm; one that still shows
// the old value is a report from before the target applied the press.
const _OVERLAY_MS = 4000;
const _overlay = {}; // key -> { v, until, target, dev }

function _remoteVal(key, dev) {
  const p = _overlay[key];
  const reported = dev ? dev[key] : undefined;
  if (p) {
    // Confirmation is judged on the snapshot in the store, never on `dev`: remote.js
    // hands paintRemoteState a COPY ({...dev, playing}), which already carries the
    // value it wrote at the press and would read as a confirmation at once.
    const snap = _remoteDev();
    const done = p.target !== store.remoteTarget || Date.now() > p.until
      || (snap && snap !== p.dev && snap[key] === p.v);
    if (done) delete _overlay[key];
    else return p.v;
  }
  return reported;
}

// Out of remote mode nothing is pending: exitRemoteMode repaints the toggles with
// store.remoteTarget already null, which lands here.
function _dropOverlays() { for (const k in _overlay) delete _overlay[k]; }

function _sendModeCmd(key, action, v) {
  _overlay[key] = { v, until: Date.now() + _OVERLAY_MS, target: store.remoteTarget, dev: _remoteDev() };
  _remoteCmd(action, v);
  // Painted at once from the overlay (remote.js repaints too; the key may not change).
  _remotePaintKey = '';
  if (key === 'muted') syncMuteUI(); else syncShuffleRepeatUI();
}

function _remoteRepeat(dev) {
  const r = _remoteVal('repeat', dev);
  return _REPEAT_MODES.includes(r) ? r : 'off';
}

// ── Shared player-mode toggles (engine-agnostic: drive store, sync both UIs) ──
// Behavior mirrors the original full-player handlers; the active engine reads
// store.shuffleEnabled / store.repeatMode, so flipping the store is sufficient.
export function toggleShuffle() {
  if (store.remoteTarget) {
    _sendModeCmd('shuffle', 'shuffle', !_remoteVal('shuffle', _remoteDev()));
    return;
  }
  _applyShuffle(!store.shuffleEnabled);
}

/** Target side of a `shuffle` command: the same as pressing the button here. */
export function setShuffle(on) {
  _restoreModes();
  if (!!on === store.shuffleEnabled) { syncShuffleRepeatUI(); return; }
  _applyShuffle(!!on);
}

function _applyShuffle(on) {
  _restoreModes();
  store.shuffleEnabled = on;
  // A fresh permutation per switch-on; switching off leaves the queue order and the
  // index already on the playing track, so there is nothing to restore.
  resetShuffleOrder();
  _persistModes();
  // The fresh permutation is part of the saved queue now; without this it would
  // only reach the server on the next queue change or the 30s tick.
  if (saveQueueDebounced) saveQueueDebounced();
  syncShuffleRepeatUI();
}

export function toggleRepeat() {
  if (store.remoteTarget) {
    const cur = _remoteRepeat(_remoteDev());
    _sendModeCmd('repeat', 'repeat', _REPEAT_MODES[(_REPEAT_MODES.indexOf(cur) + 1) % 3]);
    return;
  }
  _restoreModes();
  setRepeat(_REPEAT_MODES[(_REPEAT_MODES.indexOf(store.repeatMode) + 1) % 3]);
}

/** Target side of a `repeat` command. Anything but off/all/one is ignored. */
export function setRepeat(mode) {
  if (!_REPEAT_MODES.includes(mode)) return;
  _restoreModes();
  store.repeatMode = mode;
  _persistModes();
  syncShuffleRepeatUI();
}

// Shuffle and repeat live in `store`, which is memory only — the saved queue carries
// neither, so both silently went back to off on every reload while the queue itself
// came back intact. Mirror them into localStorage; they are per-device settings, the
// same way ms_player_engine is.
const _SHUFFLE_KEY = 'ms_shuffle';
const _REPEAT_KEY = 'ms_repeat_mode';
let _modesRestored = false;

function _persistModes() {
  try {
    localStorage.setItem(_SHUFFLE_KEY, store.shuffleEnabled ? '1' : '0');
    localStorage.setItem(_REPEAT_KEY, store.repeatMode);
  } catch {}
}

function _restoreModes() {
  if (_modesRestored) return;
  _modesRestored = true;
  try {
    store.shuffleEnabled = localStorage.getItem(_SHUFFLE_KEY) === '1';
    const mode = localStorage.getItem(_REPEAT_KEY);
    if (mode === 'off' || mode === 'all' || mode === 'one') store.repeatMode = mode;
  } catch {}
}

export function syncShuffleRepeatUI() {
  _restoreModes();
  // Under remote control the buttons show the TARGET's modes; this device's own
  // store values are left alone and come back on screen when control ends.
  if (!store.remoteTarget) _dropOverlays();
  const dev = _remoteDev();
  const shuffle = store.remoteTarget ? !!_remoteVal('shuffle', dev) : store.shuffleEnabled;
  const repeat = store.remoteTarget ? _remoteRepeat(dev) : store.repeatMode;
  for (const id of ['#fpShuffle', '#playerShuffle']) {
    const b = $(id);
    if (b) b.classList.toggle('active', shuffle);
  }
  const repeatTitle = repeat === 'off' ? 'Repeat off'
    : repeat === 'all' ? 'Repeat all' : 'Repeat one';
  for (const [btnId, badgeId] of [['#fpRepeat', '#fpRepeatBadge'], ['#playerRepeat', '#playerRepeatBadge']]) {
    const btn = $(btnId);
    if (!btn) continue;
    btn.classList.toggle('active', repeat !== 'off');
    btn.title = repeatTitle;
    const badge = $(badgeId);
    if (badge) badge.textContent = repeat === 'one' ? '1' : '';
  }
}

/** A deck that is not playing must carry the volume too: the DJ engine crossfades
 *  into it, and a mute set on one deck used to come back as a silent next track. */
function _setElementVolume(vol) {
  if (_engineVolume) { _engineVolume(vol); return; }
  const a = audio(); if (a) a.volume = vol;
}

// ── Mute toggle ──
let _preMuteVolume = null;

function _applyVolume(vol) {
  store.playerVolume = vol;
  const pct = Math.round(vol * 100);
  const pv = $('#playerVolume'); if (pv) pv.value = pct;
  const fv = $('#fpVolume'); if (fv) fv.value = pct;
  if (store.castDevice) {
    apiJson('/api/dlna/volume', { method: 'POST', body: { volume: pct } }).catch(() => {});
  } else {
    _setElementVolume(vol);
  }
}

export function toggleMute() {
  if (store.remoteTarget) {
    _sendModeCmd('muted', 'mute', !_remoteVal('muted', _remoteDev()));
    return;
  }
  setMuted(!isMuted());
}

/** Muted = volume 0, the same rule the icon has always used. */
export function isMuted() {
  return store.playerVolume <= 0;
}

/** Target side of a `mute` command (and the local button). Unmuting goes back to
 *  the level before the mute, or to full volume when there is none to go back to. */
export function setMuted(muted) {
  if (!!muted === isMuted()) { syncMuteUI(); return; }
  if (muted) {
    _preMuteVolume = store.playerVolume;
    _applyVolume(0);
  } else {
    _applyVolume(_preMuteVolume && _preMuteVolume > 0 ? _preMuteVolume : 1);
  }
  syncMuteUI();
}

const _ICON_SPEAKER = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>';
const _ICON_MUTED = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

export function syncMuteUI() {
  const dev = _remoteDev();
  if (!store.remoteTarget) _dropOverlays();
  const muted = store.remoteTarget ? !!_remoteVal('muted', dev) : isMuted();
  for (const [iconId, btnId] of [['#playerMuteIcon', '#playerMute'], ['#fpMuteIcon', '#fpMute']]) {
    const icon = $(iconId);
    if (icon) icon.innerHTML = muted ? _ICON_MUTED : _ICON_SPEAKER;
    const btn = $(btnId);
    if (btn) btn.title = muted ? 'Unmute' : 'Mute';
  }
}

// ── Like toggle (player bar + full player) ──
// Engine-agnostic: reads the now-playing item straight from the store and the
// likes.js in-memory set, so it works no matter which player engine is active.
const _LIKE_FILLED = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.9-10-9.2C.6 9.1 1.6 5.5 5 4.6c2-.5 3.9.5 5 2 1.1-1.5 3-2.5 5-2 3.4.9 4.4 4.5 3 7.2C19.5 16.1 12 21 12 21z"/></svg>';
const _LIKE_OUTLINE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 20s-6.8-4.5-9.1-8.4C1.5 9 2.4 5.9 5.3 5.1c1.8-.5 3.6.4 4.7 1.9 1.1-1.5 2.9-2.4 4.7-1.9 2.9.8 3.8 3.9 2.4 6.5C18.8 15.5 12 20 12 20z"/></svg>';

export function syncLikeUI() {
  const item = _currentItem();
  const liked = !!item && isLiked(item);
  for (const id of ['#playerLike', '#fpLike']) {
    const btn = $(id);
    if (!btn) continue;
    btn.innerHTML = liked ? _LIKE_FILLED : _LIKE_OUTLINE;
    btn.classList.toggle('liked', liked);
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    btn.title = liked ? 'Remove from Liked Songs' : 'Add to Liked Songs';
  }
}

function _toggleCurrentLike() {
  const item = _currentItem();
  if (item) toggleLike(item);
}

// ── Sync Full Player ──
export function syncFullPlayer() {
  // Under remote control the controller's own (paused) track must not be painted:
  // the engine calls this on its own track changes, and openFullPlayer on every open.
  if (store.remoteTarget) { _remotePaintKey = ''; _paintRemoteTrack(_remoteDev()); return; }
  _remotePaintKey = '';
  _hideRemoteNext();
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) {
    // Nothing local to show, but the toggles may still carry the target's state
    // from a remote session that just ended.
    syncShuffleRepeatUI();
    syncMuteUI();
    syncLikeUI();
    syncSourceLabel();
    return;
  }
  const item = store.playerQueue[store.playerIndex];
  const fpImg = $('#fpImg');
  if (fpImg) setArt(fpImg, item.image);
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = item.name || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = item.artist || '';
  syncSourceLabel();
  const fpFill = $('#fpProgressFill');
  if (fpFill) fpFill.style.width = '0%';
  const fpCur = $('#fpTimeCurrent');
  if (fpCur) fpCur.textContent = '0:00';
  const fpTot = $('#fpTimeTotal');
  if (fpTot) { const _a2 = audio(); fpTot.textContent = fmtTime(_a2 ? _a2.duration || 0 : 0); }
  // Sync volume
  const fpVol = $('#fpVolume');
  if (fpVol) fpVol.value = Math.round(store.playerVolume * 100);
  // Keep shuffle/repeat/mute icons (mini bar + full player) reflecting real store state
  // on every track change — they live in `store`, but the glyphs need re-painting.
  syncShuffleRepeatUI();
  syncMuteUI();
  syncLikeUI();
}

// Where this track is playing from. The header said "NOW PLAYING" and nothing else;
// the only context label lived in .fp-queue-side, which is hidden below 641 px, so on
// a phone there was no way to tell a playlist from an ad-hoc queue.
export function syncSourceLabel() {
  const el = document.querySelector('.fp-source');
  if (!el) return;
  if (store.remoteTarget) {
    const dev = _remoteDev();
    const pm = store.remoteQueue && store.remoteQueue.playlist_mode;
    const pl = pm && typeof pm === 'object' ? pm.name : '';
    el.textContent = `Playing on ${(dev && dev.name) || 'other device'}` + (pl ? ` · ${pl}` : '');
    return;
  }
  const name = store.playlistMode && store.playlistMode.name;
  el.textContent = name ? `Playing from ${name}` : 'Now Playing';
}

// ── Remote now-playing extras ──
// remote.js paints title, art, time, play/pause and volume from the target's report;
// this paints the rest of the full player from the same report. Idempotent — remote.js
// calls it on every state update, syncFullPlayer() on open.
// remote.js calls this every second while controlling: skip the repaint when nothing
// it shows has changed. Liked state is in the key too — a like made on another
// device changes it, and the 'likeschange' listener repaints the hearts anyway.
let _remotePaintKey = '';

export function paintRemoteState(dev) {
  if (!store.remoteTarget) return;
  dev = dev || _remoteDev();
  const tr = dev && dev.track, nx = dev && dev.next;
  const pm = store.remoteQueue && store.remoteQueue.playlist_mode;
  const key = [store.remoteTarget, dev && dev.name, tr && tr.id, tr && tr.name, tr && tr.artist,
    tr ? isLiked(tr) : '', !!_remoteVal('muted', dev), !!_remoteVal('shuffle', dev), _remoteRepeat(dev),
    nx && nx.name, nx && nx.artist, pm && typeof pm === 'object' ? pm.name : ''].join('\u0001');
  if (key === _remotePaintKey) return;
  _remotePaintKey = key;
  syncLikeUI();
  syncMuteUI();
  syncShuffleRepeatUI();
  syncSourceLabel();
  _paintRemoteNext(dev);
}

function _paintRemoteTrack(dev) {
  const tr = (dev && dev.track) || null;
  const fpImg = $('#fpImg');
  if (fpImg && tr) setArt(fpImg, tr.image || '');
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = (tr && tr.name) || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = (tr && tr.artist) || '';
  paintRemoteState(dev);
}

// "Next: <name> — <artist>" under the artist row: what the TARGET will play next
// (its shuffle / Smart Queue pick), which the queue order on screen cannot tell.
// Built here rather than in markup; it exists only for remote control.
function _remoteNextEl() {
  let el = $('#fpRemoteNext');
  if (el) return el;
  const anchor = document.querySelector('#fullPlayer .fp-artist-row');
  if (!anchor) return null;
  el = document.createElement('div');
  el.id = 'fpRemoteNext';
  el.className = 'fp-remote-next';
  el.style.cssText = 'display:none;font-size:12px;color:var(--text-muted);margin-top:4px;'
    + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  anchor.after(el);
  return el;
}

function _paintRemoteNext(dev) {
  const nx = dev && dev.next;
  if (!nx || !(nx.name || nx.artist)) { _hideRemoteNext(); return; }
  const el = _remoteNextEl();
  if (!el) return;
  el.textContent = `Next: ${nx.name || ''}` + (nx.artist ? ` — ${nx.artist}` : '');
  el.style.display = '';
}

function _hideRemoteNext() {
  const el = $('#fpRemoteNext');
  if (el) { el.style.display = 'none'; el.textContent = ''; }
}

// ── Open/Close Full Player ──
export function openFullPlayer() {
  // Under remote control the controller's own queue may well be empty; the full
  // player then shows the target's track.
  if (store.fullPlayerOpen || (store.playerIndex < 0 && !store.remoteTarget)) return;
  // The bar is now lifted over the queue backdrop (z-index 250) so it stays usable
  // while the small panel is open — and a tap on the bar's artwork opens THIS player
  // (201). Left alone, bar and panel would both sit on top of it: two players over
  // each other. The panel already owns a history entry, so take it over rather than
  // stacking a second one; one Back then closes the big player, as it does anywhere
  // else it was opened from.
  const inheritHistory = store.queuePanelOpen;
  if (inheritHistory) closeQueuePanel(true);
  syncFullPlayer();
  syncSourceLabel();
  // Update progress if already playing (locally — under remote control remote.js
  // paints the target's position and play/pause icon).
  const _a = store.remoteTarget ? null : audio();
  if (_a && _a.duration) {
    const pct = (_a.currentTime / _a.duration) * 100;
    $('#fpProgressFill').style.width = pct + '%';
    $('#fpTimeCurrent').textContent = fmtTime(_a.currentTime);
    $('#fpTimeTotal').textContent = fmtTime(_a.duration);
  }
  if (updatePlayPauseIcon && !store.remoteTarget) updatePlayPauseIcon(store.playerPlaying);
  $('#fullPlayer').classList.add('open');
  store.fullPlayerOpen = true;
  // Populate desktop inline queue
  if (window.innerWidth > 640) {
    renderQueueInto($('#fpQueueList'));
    scrollToNowPlaying($('#fpQueueList'));
  }
  if (inheritHistory) history.replaceState({ layer: 'fullPlayer' }, '');
  else history.pushState({ layer: 'fullPlayer' }, '');
  // Show/hide cast volume slider
  const castVol = $('#fpCastVol');
  if (castVol) castVol.style.display = store.castDevice ? '' : 'none';
  // FIX 3: re-sync DJ panel in case Settings changed a ms_dj_* key while
  // the user had navigated away from the player within the same tab.
  djPanel.syncDjPanel();
  // Load recommendations if not loaded yet
  import('./recommendations.js').then(m => m.onPanelOpened());
}

export function closeFullPlayer(fromPopstate) {
  if (!store.fullPlayerOpen) return;
  // Close fp queue panel first if open
  if (store.fpQueuePanelOpen) closeFpQueuePanel(true);
  const fp = $('#fullPlayer');
  fp.classList.remove('open');
  fp.style.transform = '';
  fp.style.transition = '';
  store.fullPlayerOpen = false;
  if (!fromPopstate) historyBack();
}

async function _openArtistPage(name) {
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(name)}&type=artist&limit=5`);
    const list = data.results || [];
    const exact = list.find(a => (a.name || '').toLowerCase() === name.toLowerCase()) || list[0];
    if (exact && exact.id) {
      const m = await import('./spotify.js');
      if (m.loadArtistDetail) {
        // #artistDetail lives inside #pageSearch — opened from another page it would
        // be shown on a page nobody is looking at.
        const router = await import('./router.js');
        if (router.switchPage) router.switchPage('search');
        m.loadArtistDetail(exact.id, 'search', { provider: exact.provider, name: exact.name, image: exact.image });
        return;
      }
    }
  } catch {}
  const cm = await import('./contextmenu.js');
  cm.openArtistByName(name);
}

// Current now-playing item (or null). Under remote control it is the track the
// TARGET reports playing — like, download, add to playlist and the ⋯ menu act on
// what is heard, not on the controller's stale local track. The likes API is per
// user, so liking the reported item is liking it for the target's user too.
function _currentItem() {
  if (store.remoteTarget) {
    const dev = _remoteDev();
    const tr = dev && dev.track;
    return tr && (tr.name || tr.id) ? tr : null;
  }
  return (store.playerIndex >= 0 && store.playerIndex < store.playerQueue.length)
    ? store.playerQueue[store.playerIndex] : null;
}

/** The track per-track actions should act on (see _currentItem). */
export function currentItem() { return _currentItem(); }

// ── Init ──
export function init() {
  // Open full player by clicking mini player img/text
  $('#playerImg').addEventListener('click', openFullPlayer);
  $('.player-text').addEventListener('click', openFullPlayer);

  // ── Now-playing navigation (clickable artist/art) ──
  // Reuse the context-menu "Show artist" / "Show album" navigation so behavior
  // matches the rest of the app. stopPropagation prevents the parent handlers
  // (open-full-player / full-player swipe-to-close) from also firing.
  const _navArtist = (e) => {
    const item = _currentItem();
    if (!item || !item.artist) return;
    e.stopPropagation();
    // Straight to the artist page. A name search only puts a grid of cards in the
    // way and makes the user recognise and click the artist they were already
    // listening to. A queue item carries no artist id — nothing in the app does,
    // which is why every "show artist" ends in a search — so resolve the name to
    // one first and fall back to the search when there is no match.
    if (store.fullPlayerOpen) closeFullPlayer();
    _openArtistPage(item.artist);
  };
  const _navAlbum = (e) => {
    const item = _currentItem();
    if (!item) return;
    e.stopPropagation();
    // Close the full player first so the navigation target isn't hidden under the overlay.
    if (store.fullPlayerOpen) closeFullPlayer();
    import('./contextmenu.js').then(m => {
      if (item.album) m.openAlbumByName(item.album);
      else if (item.artist) m.openArtistByName(item.artist);
    });
  };
  // Mini player bar: artist text → artist. (The art keeps opening the full
  // player, which itself exposes artist/album navigation.)
  const playerArtist = $('#playerArtist');
  if (playerArtist) { playerArtist.style.cursor = 'pointer'; playerArtist.addEventListener('click', _navArtist); }
  // Full player: artist → artist, title → album. (The art keeps its existing
  // tap=play/pause + swipe=next/prev gestures, so navigation lives on the text.)
  const fpArtist = $('#fpArtist');
  if (fpArtist) { fpArtist.style.cursor = 'pointer'; fpArtist.addEventListener('click', _navArtist); }
  const fpTitle = $('#fpTitle');
  if (fpTitle) { fpTitle.style.cursor = 'pointer'; fpTitle.addEventListener('click', _navAlbum); }

  // Now Playing bottom nav button
  $('#bnavNowPlaying').addEventListener('click', openFullPlayer);

  // Swipe up on the mini player bar → open the full player (migrated from gestures.js,
  // which was removed; this is the one gesture it had that wasn't already here).
  (function () {
    const bar = document.getElementById('playerBar');
    if (!bar) return;
    let sy = 0, tracking = false;
    bar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    bar.addEventListener('touchmove', (e) => {
      if (tracking && sy - e.touches[0].clientY > 40) { tracking = false; openFullPlayer(); }
    }, { passive: true });
    bar.addEventListener('touchend', () => { tracking = false; }, { passive: true });
    bar.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  })();

  // Full player close button
  $('#fpClose').addEventListener('click', () => closeFullPlayer());

  // Queue backdrop closes queue
  $('#queueBackdrop').addEventListener('click', () => {
    if (store.fpQueuePanelOpen) closeFpQueuePanel();
    else if (store.queuePanelOpen) closeQueuePanel();
  });

  // Desktop inline queue clear button
  $('#fpClearQueue').addEventListener('click', async () => {
    // queue.js owns what "clear" means in both modes (local: pause, clear, hide the
    // bar, save; remote: queue_op clear to the target, nothing local touched).
    if (typeof queueMod.clearQueueAction === 'function') {
      await queueMod.clearQueueAction();
      closeFullPlayer();
      return;
    }
    if (store.remoteTarget) {
      // The target clears its own queue (and its Up Next); nothing local changes —
      // no pause, no hidePlayerBar (the bar shows the target's track).
      _remoteCmd('queue_op', { op: 'clear' });
      closeFullPlayer();
      return;
    }
    audio().pause();
    const u = await import('./upnext.js');
    await u.clearActiveQueue();
    hidePlayerBar();
    renderQueue();
    closeFullPlayer();
    saveQueueDebounced();
  });

  // Full player controls
  // Under remote control remote.js intercepts these in the capture phase and calls
  // preventDefault(); the branches here only send when that did not happen, so a
  // press is never sent twice and never plays this device's own deck.
  $('#fpPlayPause').addEventListener('click', (e) => {
    if (store.remoteTarget) { if (!e.defaultPrevented) _remoteCmd('toggle'); return; }
    if (store.castDevice) {
      castToggle();
    } else {
      const a = audio();
      if (a.paused) a.play().catch(() => {}); else a.pause();
    }
  });
  $('#fpPrev').addEventListener('click', (e) => {
    if (store.remoteTarget) { if (!e.defaultPrevented) _remoteCmd('prev'); return; }
    prevTrack();
  });
  $('#fpNext').addEventListener('click', (e) => {
    if (store.remoteTarget) { if (!e.defaultPrevented) _remoteCmd('next'); return; }
    nextTrack();
  });

  // Full player seek
  function _fpPct(e) {
    const rect = $('#fpProgressBar').getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    return rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  }
  function _fpSeek(e) {
    const a = audio();
    const pct = _fpPct(e);
    // The DJ engine knows durations this element does not (a stream served while its
    // file is still being built reports Infinity) and how to seek in such a stream.
    if (!store.castDevice && _engineSeek) { _engineSeek(pct); return; }
    // While casting, the element holds another track (or nothing): the length is the
    // receiver's — a 50 % tap on a 2 h mix used to land at ~2:00.
    const dur = store.castDevice ? (castDuration() || null) : a.duration && isFinite(a.duration) && a.duration > 0
      ? a.duration
      : (() => { const item = store.playerQueue[store.playerIndex]; return item?.duration_ms > 0 ? item.duration_ms / 1000 : null; })();
    if (!dur) return;
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      try { a.currentTime = pct * dur; } catch {}
    }
  }
  // Under remote control a seek must reach the target and never this device's own
  // paused deck. remote.js has capture-phase interceptors for click AND touchstart
  // that preventDefault(); these handlers send `seek_pct` only when no interceptor
  // did (remote.js converts it with the TARGET's duration and refuses an unknown one).
  $('#fpProgressBar').addEventListener('click', (e) => {
    if (store.remoteTarget) { if (!e.defaultPrevented) _remoteCmd('seek_pct', _fpPct(e)); return; }
    _fpSeek(e);
  });
  $('#fpProgressBar').addEventListener('touchstart', (e) => {
    if (store.remoteTarget) {
      if (!e.defaultPrevented) { e.preventDefault(); _remoteCmd('seek_pct', _fpPct(e)); }
      return;
    }
    e.preventDefault(); _fpSeek(e);
  }, { passive: false });

  // Full player volume
  $('#fpVolume').addEventListener('input', (e) => {
    // remote.js sends the slider to the target (capture phase); this device's own
    // volume must not follow it.
    if (store.remoteTarget) return;
    store.playerVolume = e.target.value / 100;
    $('#playerVolume').value = e.target.value;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      _setElementVolume(store.playerVolume);
    }
    syncMuteUI();
  });

  // Full player download
  $('#fpDownload').addEventListener('click', async () => {
    const item = _currentItem();
    if (!item) return;
    const btn = $('#fpDownload');
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

  // Full player queue button
  $('#fpQueueTop').addEventListener('click', () => {
    if (window.innerWidth > 640) {
      // Desktop: queue is inline, just refresh it
      renderQueueInto($('#fpQueueList'));
    } else {
      // Mobile: open dedicated big player queue (slides from bottom)
      openFpQueuePanel();
    }
  });

  // Shuffle toggle — flips store (engine reads store.shuffleEnabled) and syncs
  // both the full-player and mini-bar buttons so they stay identical.
  $('#fpShuffle').addEventListener('click', toggleShuffle);
  const playerShuffle = $('#playerShuffle');
  if (playerShuffle) playerShuffle.addEventListener('click', toggleShuffle);

  // Legacy DJ-mode cycle button (#fpDjMode). The DJ engine now uses the quick-control
  // panel (djpanel.js) for Smart Queue and the 'crossfade' engine was removed, so this
  // button stays hidden; djpanel.refreshDjPanelVisibility() also enforces this.
  const djBtn = $('#fpDjMode');
  if (djBtn) {
    djBtn.style.display = 'none';
    // Sync initial state
    const curMode = localStorage.getItem('ms_dj_smart_queue') || 'off';
    djBtn.classList.toggle('active', curMode !== 'off');
    djBtn.title = curMode === 'off' ? 'DJ Mode off' : `DJ Mode: ${curMode === 'bpm' ? 'BPM' : 'BPM+Key'}`;
    djBtn.addEventListener('click', () => {
      const modes = ['off', 'bpm', 'bpm_key'];
      const cur = localStorage.getItem('ms_dj_smart_queue') || 'off';
      const next = modes[(modes.indexOf(cur) + 1) % modes.length];
      localStorage.setItem('ms_dj_smart_queue', next);
      djBtn.classList.toggle('active', next !== 'off');
      const labels = { off: 'DJ Mode off', bpm: 'DJ Mode: BPM', bpm_key: 'DJ Mode: BPM+Key' };
      djBtn.title = labels[next];
      import('./utils.js').then(m => m.showToast(labels[next]));
    });
  }

  // Every queue row has a ⋯ menu; the track that is actually playing had none, so
  // "start a radio from this" was unreachable from the player itself. Built here
  // rather than in markup so it carries the same actions a queue row's kebab does.
  const fpDownload = $('#fpDownload');
  if (fpDownload && !$('#fpKebab')) {
    import('./contextmenu.js').then(m => {
      const kebab = m.makeKebabButton(() => {
        const item = _currentItem();
        if (!item) return null;
        // Under remote control the row is the target's current queue row.
        if (store.remoteTarget) {
          const dev = _remoteDev();
          const qi = dev && Number.isInteger(dev.index) ? dev.index : -1;
          return { item, type: 'queue-track', context: { queueIndex: qi, remote: true } };
        }
        return { item, type: 'queue-track', context: { queueIndex: store.playerIndex } };
      });
      kebab.id = 'fpKebab';
      fpDownload.after(kebab);
    });
  }

  // DJ quick-control drawer (curated live knobs; DJ engine only)
  djPanel.init();

  // Repeat toggle: off -> all -> one -> off
  $('#fpRepeat').addEventListener('click', toggleRepeat);
  const playerRepeat = $('#playerRepeat');
  if (playerRepeat) playerRepeat.addEventListener('click', toggleRepeat);

  // Mute toggles (mini bar + full player). Speaker icon flips to muted glyph.
  const fpMute = $('#fpMute');
  if (fpMute) fpMute.addEventListener('click', toggleMute);
  const playerMute = $('#playerMute');
  if (playerMute) playerMute.addEventListener('click', toggleMute);

  // Like toggles (mini bar + full player). Both act on the now-playing track.
  const fpLike = $('#fpLike');
  if (fpLike) fpLike.addEventListener('click', _toggleCurrentLike);
  const playerLike = $('#playerLike');
  if (playerLike) playerLike.addEventListener('click', _toggleCurrentLike);
  // Repaint both hearts whenever like state changes anywhere (e.g. via a row heart).
  window.addEventListener('likeschange', syncLikeUI);

  // Reflect initial state on all toggle buttons.
  syncShuffleRepeatUI();
  syncMuteUI();
  syncLikeUI();

  // ── Swipe on album art for next/prev ──
  (function() {
    const artWrap = document.querySelector('.fp-art-wrap');
    const art = document.getElementById('fpImg');
    if (!artWrap || !art) return;
    let startX = 0, startY = 0, dx = 0, tracking = false;
    const THRESHOLD = 50;

    artWrap.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0;
      tracking = true;
      art.classList.add('swiping');
    }, { passive: true });

    artWrap.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const moveX = e.touches[0].clientX;
      const moveY = e.touches[0].clientY;
      if (Math.abs(moveY - startY) > Math.abs(moveX - startX) * 1.5) {
        tracking = false;
        art.classList.remove('swiping');
        art.style.transform = '';
        art.style.opacity = '';
        return;
      }
      dx = moveX - startX;
      const pct = Math.min(Math.abs(dx) / 200, 1);
      art.style.transform = `translateX(${dx}px) scale(${1 - pct * 0.1})`;
      art.style.opacity = 1 - pct * 0.4;
    }, { passive: true });

    artWrap.addEventListener('touchend', () => {
      if (!tracking) return;
      tracking = false;
      art.classList.remove('swiping');
      // Tap (minimal movement) -> toggle play/pause
      if (Math.abs(dx) < 5) {
        art.style.transform = '';
        art.style.opacity = '';
        // Under remote control a tap toggles the TARGET; this device's deck still
        // holds its old track and must stay silent.
        if (store.remoteTarget) { _remoteCmd('toggle'); return; }
        const a = audio();
        if (a.paused) a.play().catch(() => {}); else a.pause();
        return;
      }
      if (Math.abs(dx) >= THRESHOLD) {
        art.classList.add(dx < 0 ? 'swipe-out-left' : 'swipe-out-right');
        art.style.transform = '';
        art.style.opacity = '';
        const goNext = dx < 0;
        const enterFrom = goNext ? 100 : -100;
        setTimeout(() => {
          art.classList.remove('swipe-out-left', 'swipe-out-right');
          art.style.transition = 'none';
          art.style.transform = `translateX(${enterFrom}px)`;
          art.style.opacity = '0';
          if (store.remoteTarget) {
            _remoteCmd(goNext ? 'next' : 'prev');
          } else if (goNext) {
            nextTrack();
          } else if (store.playerIndex > 0) {
            store.playerIndex--;
            loadAndPlay();
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              art.style.transition = 'transform .3s ease, opacity .3s ease';
              art.style.transform = 'translateX(0)';
              art.style.opacity = '1';
              setTimeout(() => { art.style.transition = ''; art.style.transform = ''; art.style.opacity = ''; }, 300);
            });
          });
        }, 250);
      } else {
        art.style.transition = 'transform .2s ease, opacity .2s ease';
        art.style.transform = '';
        art.style.opacity = '';
        setTimeout(() => { art.style.transition = ''; }, 200);
      }
    }, { passive: true });

    artWrap.addEventListener('touchcancel', () => {
      tracking = false;
      art.classList.remove('swiping');
      art.style.transform = '';
      art.style.opacity = '';
    }, { passive: true });
  })();

  // ── Swipe down on full player to close ──
  (function() {
    const fpSide = document.getElementById('fpPlayerSide');
    if (!fpSide) return;
    let sy = 0, dy = 0, tracking = false, locked = null;
    const fp = document.getElementById('fullPlayer');

    fpSide.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const isInteractive = e.target.closest('button, input, .fp-progress-bar, .fp-art-wrap');
      if (isInteractive) { tracking = false; return; }
      sy = e.touches[0].clientY;
      dy = 0;
      tracking = true;
      locked = null;
    }, { passive: true });

    fpSide.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const cx = e.touches[0].clientX;
      const cy = e.touches[0].clientY;
      dy = cy - sy;

      if (!locked) {
        const ax = Math.abs(cx - (fpSide._sx || cx));
        const ay = Math.abs(dy);
        if (ax + ay > 10) locked = ay > ax ? 'v' : 'h';
        fpSide._sx = fpSide._sx || cx;
        if (locked === 'h') { tracking = false; return; }
      }

      if (dy > 0) {
        e.preventDefault();
        fp.style.transition = 'none';
        fp.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: false });

    fpSide.addEventListener('touchend', () => {
      if (!tracking) { fpSide._sx = undefined; return; }
      tracking = false;
      fpSide._sx = undefined;
      if (dy > 80) {
        fp.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
        fp.style.transform = 'translateY(100%)';
        setTimeout(() => closeFullPlayer(), 300);
      } else {
        fp.style.transition = 'transform .25s ease';
        fp.style.transform = 'translateY(0)';
        setTimeout(() => { fp.style.transition = ''; fp.style.transform = ''; }, 250);
      }
    }, { passive: true });

    fpSide.addEventListener('touchcancel', () => {
      tracking = false;
      fpSide._sx = undefined;
      fp.style.transition = '';
      fp.style.transform = '';
    }, { passive: true });

    // ── Swipe up in full player bottom area to open queue ──
    let qsy = 0, qdy = 0, qTracking = false;
    fpSide.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !store.fullPlayerOpen || store.queuePanelOpen || store.fpQueuePanelOpen) return;
      const rect = fpSide.getBoundingClientRect();
      const touchY = e.touches[0].clientY;
      if (touchY < rect.top + rect.height * 0.65) return;
      // `button` is deliberately NOT in this guard: the bottom third of the player is
      // where the controls are, so excluding buttons left the gesture dead across most
      // of its own area. It cannot steal a tap — it only commits after 40 px of travel,
      // and unlike the swipe-to-close guard above it never calls preventDefault.
      const isInteractive = e.target.closest('input, .fp-progress-bar');
      if (isInteractive) return;
      qsy = touchY;
      qdy = 0;
      qTracking = true;
    }, { passive: true });

    fpSide.addEventListener('touchmove', (e) => {
      if (!qTracking) return;
      qdy = qsy - e.touches[0].clientY;
      if (qdy > 40) {
        qTracking = false;
        openFpQueuePanel();
      }
    }, { passive: true });

    fpSide.addEventListener('touchend', () => { qTracking = false; }, { passive: true });
    fpSide.addEventListener('touchcancel', () => { qTracking = false; }, { passive: true });
  })();
}
