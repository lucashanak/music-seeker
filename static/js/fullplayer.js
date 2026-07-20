// fullplayer.js — Full player UI, open/close, sync, volume, desktop split

import { store } from './store.js';
import { $, fmtTime, showToast, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { renderQueueInto, renderQueue, openFpQueuePanel, closeFpQueuePanel, closeQueuePanel, scrollToNowPlaying } from './queue.js';
import { toggleLike, isLiked } from './likes.js';
import * as djPanel from './djpanel.js';

// Forward references set during init to avoid circular imports
let nextTrack, prevTrack, loadAndPlay, hidePlayerBar, saveQueueDebounced, updatePlayPauseIcon;
let _audioRef = null;    // static ref (classic player)
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
}

// ── Shared player-mode toggles (engine-agnostic: drive store, sync both UIs) ──
// Behavior mirrors the original full-player handlers; the active engine reads
// store.shuffleEnabled / store.repeatMode, so flipping the store is sufficient.
export function toggleShuffle() {
  store.shuffleEnabled = !store.shuffleEnabled;
  syncShuffleRepeatUI();
}

export function toggleRepeat() {
  const modes = ['off', 'all', 'one'];
  store.repeatMode = modes[(modes.indexOf(store.repeatMode) + 1) % 3];
  syncShuffleRepeatUI();
}

export function syncShuffleRepeatUI() {
  for (const id of ['#fpShuffle', '#playerShuffle']) {
    const b = $(id);
    if (b) b.classList.toggle('active', store.shuffleEnabled);
  }
  const repeatTitle = store.repeatMode === 'off' ? 'Repeat off'
    : store.repeatMode === 'all' ? 'Repeat all' : 'Repeat one';
  for (const [btnId, badgeId] of [['#fpRepeat', '#fpRepeatBadge'], ['#playerRepeat', '#playerRepeatBadge']]) {
    const btn = $(btnId);
    if (!btn) continue;
    btn.classList.toggle('active', store.repeatMode !== 'off');
    btn.title = repeatTitle;
    const badge = $(badgeId);
    if (badge) badge.textContent = store.repeatMode === 'one' ? '1' : '';
  }
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
    const a = audio(); if (a) a.volume = vol;
  }
}

export function toggleMute() {
  if (store.playerVolume > 0) {
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
  const muted = store.playerVolume <= 0;
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
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) return;
  const item = store.playerQueue[store.playerIndex];
  const fpImg = $('#fpImg');
  if (fpImg) fpImg.src = item.image || '';
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = item.name || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = item.artist || '';
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

// ── Open/Close Full Player ──
export function openFullPlayer() {
  if (store.fullPlayerOpen || store.playerIndex < 0) return;
  syncFullPlayer();
  // Update progress if already playing
  const _a = audio();
  if (_a && _a.duration) {
    const pct = (_a.currentTime / _a.duration) * 100;
    $('#fpProgressFill').style.width = pct + '%';
    $('#fpTimeCurrent').textContent = fmtTime(_a.currentTime);
    $('#fpTimeTotal').textContent = fmtTime(_a.duration);
  }
  if (updatePlayPauseIcon) updatePlayPauseIcon(store.playerPlaying);
  $('#fullPlayer').classList.add('open');
  store.fullPlayerOpen = true;
  // Populate desktop inline queue
  if (window.innerWidth > 640) {
    renderQueueInto($('#fpQueueList'));
    scrollToNowPlaying($('#fpQueueList'));
  }
  history.pushState({ layer: 'fullPlayer' }, '');
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

// Current now-playing item (or null).
function _currentItem() {
  return (store.playerIndex >= 0 && store.playerIndex < store.playerQueue.length)
    ? store.playerQueue[store.playerIndex] : null;
}

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
    // Throw the user into a Search for the artist (close the full player first so
    // the search view isn't hidden under the overlay).
    if (store.fullPlayerOpen) closeFullPlayer();
    import('./router.js').then(m => m.searchFor(item.artist, 'artist'));
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
    audio().pause();
    const u = await import('./upnext.js');
    await u.clearActiveQueue();
    hidePlayerBar();
    renderQueue();
    closeFullPlayer();
    saveQueueDebounced();
  });

  // Full player controls
  $('#fpPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
      else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
    } else {
      const a = audio();
      if (a.paused) a.play().catch(() => {}); else a.pause();
    }
  });
  $('#fpPrev').addEventListener('click', () => prevTrack());
  $('#fpNext').addEventListener('click', () => nextTrack());

  // Full player seek
  function _fpSeek(e) {
    const a = audio();
    const dur = a.duration && isFinite(a.duration) && a.duration > 0
      ? a.duration
      : (() => { const item = store.playerQueue[store.playerIndex]; return item?.duration_ms > 0 ? item.duration_ms / 1000 : null; })();
    if (!dur) return;
    const bar = $('#fpProgressBar');
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      try { a.currentTime = pct * dur; } catch {}
    }
  }
  $('#fpProgressBar').addEventListener('click', _fpSeek);
  $('#fpProgressBar').addEventListener('touchstart', (e) => { e.preventDefault(); _fpSeek(e); }, { passive: false });

  // Full player volume
  $('#fpVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    $('#playerVolume').value = e.target.value;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      audio().volume = store.playerVolume;
    }
    syncMuteUI();
  });

  // Full player download
  $('#fpDownload').addEventListener('click', async () => {
    const item = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
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
          if (goNext) {
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
      const isInteractive = e.target.closest('button, input, .fp-progress-bar');
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
