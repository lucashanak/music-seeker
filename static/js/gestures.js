// gestures.js — All touch/swipe gesture handlers

import { store } from './store.js';
import { openFullPlayer, closeFullPlayer } from './fullplayer.js';
import { openQueuePanel, closeQueuePanel, openFpQueuePanel, closeFpQueuePanel } from './queue.js';

// Forward references set during init to avoid circular imports
let nextTrack, prevTrack, loadAndPlay, audio;

export function setPlayerRefs(refs) {
  nextTrack = refs.nextTrack;
  prevTrack = refs.prevTrack;
  loadAndPlay = refs.loadAndPlay;
  audio = refs.audio;
}

// ── Init ──
export function init() {
  // 1. Full player swipe on album art for next/prev
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
      // If vertical scroll is dominant, cancel swipe tracking
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
        // Swipe out animation
        art.classList.add(dx < 0 ? 'swipe-out-left' : 'swipe-out-right');
        art.style.transform = '';
        art.style.opacity = '';
        const goNext = dx < 0;
        // New art enters from the opposite side
        const enterFrom = goNext ? 100 : -100;
        setTimeout(() => {
          art.classList.remove('swipe-out-left', 'swipe-out-right');
          art.style.transition = 'none';
          art.style.transform = `translateX(${enterFrom}px)`;
          art.style.opacity = '0';
          // Now change track
          if (goNext) {
            nextTrack();
          } else if (store.playerIndex > 0) {
            store.playerIndex--;
            loadAndPlay();
          }
          // Animate new art sliding in
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
        // Snap back
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

  // 2. Swipe up on mini player -> open full player
  (function() {
    const playerBar = document.getElementById('playerBar');
    if (!playerBar) return;
    let sy = 0, tracking = false;
    playerBar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sy = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    playerBar.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dy = sy - e.touches[0].clientY;
      if (dy > 40) { tracking = false; openFullPlayer(); }
    }, { passive: true });
    playerBar.addEventListener('touchend', () => { tracking = false; }, { passive: true });
    playerBar.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  })();

  // 3. Swipe down on full player -> close (on fp-player-side, non-scrollable areas)
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

      // Direction lock: first 10px determines horizontal vs vertical
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

    // 5b. Swipe up in full player (bottom area, below controls) -> open queue from bottom
    let qsy = 0, qdy = 0, qTracking = false;
    fpSide.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !store.fullPlayerOpen || store.queuePanelOpen || store.fpQueuePanelOpen) return;
      // Only activate in bottom 1/3 of the player (actions/controls area)
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

  // 4. Swipe down from top edge -> open queue (not inside full player)
  (function() {
    let edgeSy = 0, edgeTracking = false;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (e.touches[0].clientY <= 25 && !store.queuePanelOpen && !store.fullPlayerOpen) {
        edgeSy = e.touches[0].clientY;
        edgeTracking = true;
      }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!edgeTracking) return;
      const dy = e.touches[0].clientY - edgeSy;
      if (dy > 50) {
        edgeTracking = false;
        e.preventDefault();
        openQueuePanel();
      }
    }, { passive: false });
    document.addEventListener('touchend', () => { edgeTracking = false; }, { passive: true });
    document.addEventListener('touchcancel', () => { edgeTracking = false; }, { passive: true });
  })();

  // 5. Swipe up to close queue panel (slides from top)
  (function() {
    const qPanel = document.getElementById('queuePanel');
    if (!qPanel) return;
    let sy = 0, dy = 0, tracking = false;
    qPanel.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const qList = qPanel.querySelector('.queue-list');
      if (qList && qList.scrollTop > 0) return;
      sy = e.touches[0].clientY;
      dy = 0;
      tracking = true;
    }, { passive: true });

    qPanel.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      dy = -(e.touches[0].clientY - sy); // positive = upward
      if (dy > 0) {
        e.preventDefault();
        qPanel.style.transition = 'none';
        qPanel.style.transform = `translateY(${-dy}px)`;
      }
    }, { passive: false });

    qPanel.addEventListener('touchend', () => {
      if (!tracking) return;
      tracking = false;
      if (dy > 60) {
        qPanel.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
        qPanel.style.transform = 'translateY(-100%)';
        setTimeout(() => closeQueuePanel(), 300);
      } else {
        qPanel.style.transition = 'transform .25s ease';
        qPanel.style.transform = 'translateY(0)';
        setTimeout(() => { qPanel.style.transition = ''; qPanel.style.transform = ''; }, 250);
      }
    }, { passive: true });

    qPanel.addEventListener('touchcancel', () => {
      tracking = false;
      qPanel.style.transition = '';
      qPanel.style.transform = '';
    }, { passive: true });
  })();

  // 6. Swipe down to close big player queue panel (slides from bottom)
  (function() {
    const fpQPanel = document.getElementById('fpQueuePanel');
    if (!fpQPanel) return;
    let sy = 0, dy = 0, tracking = false;
    fpQPanel.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const qList = fpQPanel.querySelector('.queue-list');
      if (qList && qList.scrollTop > 0) return;
      sy = e.touches[0].clientY;
      dy = 0;
      tracking = true;
    }, { passive: true });

    fpQPanel.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      dy = e.touches[0].clientY - sy; // positive = downward
      if (dy > 0) {
        e.preventDefault();
        fpQPanel.style.transition = 'none';
        fpQPanel.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: false });

    fpQPanel.addEventListener('touchend', () => {
      if (!tracking) return;
      tracking = false;
      if (dy > 60) {
        fpQPanel.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
        fpQPanel.style.transform = 'translateY(100%)';
        setTimeout(() => closeFpQueuePanel(), 300);
      } else {
        fpQPanel.style.transition = 'transform .25s ease';
        fpQPanel.style.transform = 'translateY(0)';
        setTimeout(() => { fpQPanel.style.transition = ''; fpQPanel.style.transform = ''; }, 250);
      }
    }, { passive: true });

    fpQPanel.addEventListener('touchcancel', () => {
      tracking = false;
      fpQPanel.style.transition = '';
      fpQPanel.style.transform = '';
    }, { passive: true });
  })();
}
