// fullplayer.js — Full player UI, open/close, sync, volume, desktop split

import { store } from './store.js';
import { $, fmtTime, showToast, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { renderQueueInto, renderQueue, openFpQueuePanel, closeFpQueuePanel, closeQueuePanel, scrollToNowPlaying } from './queue.js';

// Forward references set during init to avoid circular imports
let nextTrack, prevTrack, loadAndPlay, hidePlayerBar, saveQueueDebounced, updatePlayPauseIcon, audio;

export function setPlayerRefs(refs) {
  nextTrack = refs.nextTrack;
  prevTrack = refs.prevTrack;
  loadAndPlay = refs.loadAndPlay;
  hidePlayerBar = refs.hidePlayerBar;
  saveQueueDebounced = refs.saveQueueDebounced;
  updatePlayPauseIcon = refs.updatePlayPauseIcon;
  audio = refs.audio;
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
  if (fpTot) fpTot.textContent = fmtTime(audio ? audio.duration || 0 : 0);
  // Sync volume
  const fpVol = $('#fpVolume');
  if (fpVol) fpVol.value = Math.round(store.playerVolume * 100);
}

// ── Open/Close Full Player ──
export function openFullPlayer() {
  if (store.fullPlayerOpen || store.playerIndex < 0) return;
  syncFullPlayer();
  // Update progress if already playing
  if (audio && audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    $('#fpProgressFill').style.width = pct + '%';
    $('#fpTimeCurrent').textContent = fmtTime(audio.currentTime);
    $('#fpTimeTotal').textContent = fmtTime(audio.duration);
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

// ── Init ──
export function init() {
  // Open full player by clicking mini player img/text
  $('#playerImg').addEventListener('click', openFullPlayer);
  $('.player-text').addEventListener('click', openFullPlayer);

  // Now Playing bottom nav button
  $('#bnavNowPlaying').addEventListener('click', openFullPlayer);

  // Full player close button
  $('#fpClose').addEventListener('click', () => closeFullPlayer());

  // Queue backdrop closes queue
  $('#queueBackdrop').addEventListener('click', () => {
    if (store.fpQueuePanelOpen) closeFpQueuePanel();
    else if (store.queuePanelOpen) closeQueuePanel();
  });

  // Desktop inline queue clear button
  $('#fpClearQueue').addEventListener('click', () => {
    audio.pause();
    store.playerQueue = [];
    store.playerIndex = -1;
    hidePlayerBar();
    renderQueue();
    closeFullPlayer();
    saveQueueDebounced();
  });

  // Full player controls
  $('#fpPlayPause').addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  });
  $('#fpPrev').addEventListener('click', () => prevTrack());
  $('#fpNext').addEventListener('click', () => nextTrack());

  // Full player seek
  $('#fpProgressBar').addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  // Full player volume
  $('#fpVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    audio.volume = store.playerVolume;
    $('#playerVolume').value = e.target.value;
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

  // Shuffle toggle
  $('#fpShuffle').addEventListener('click', () => {
    store.shuffleEnabled = !store.shuffleEnabled;
    $('#fpShuffle').classList.toggle('active', store.shuffleEnabled);
  });

  // Repeat toggle: off -> all -> one -> off
  $('#fpRepeat').addEventListener('click', () => {
    const modes = ['off', 'all', 'one'];
    store.repeatMode = modes[(modes.indexOf(store.repeatMode) + 1) % 3];
    const btn = $('#fpRepeat');
    const badge = $('#fpRepeatBadge');
    btn.classList.toggle('active', store.repeatMode !== 'off');
    badge.textContent = store.repeatMode === 'one' ? '1' : '';
    btn.title = store.repeatMode === 'off' ? 'Repeat off' : store.repeatMode === 'all' ? 'Repeat all' : 'Repeat one';
  });

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
        if (audio.paused) audio.play().catch(() => {}); else audio.pause();
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
