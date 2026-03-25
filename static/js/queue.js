// queue.js — Queue panel rendering (renderQueue), small player queue panel

import { store } from './store.js';
import { $, $$, esc, historyBack } from './utils.js';

// Forward references set during init to avoid circular imports
let loadAndPlay, hidePlayerBar, saveQueueDebounced, audio;

export function setPlayerRefs(refs) {
  loadAndPlay = refs.loadAndPlay;
  hidePlayerBar = refs.hidePlayerBar;
  saveQueueDebounced = refs.saveQueueDebounced;
  audio = refs.audio;
}

// ── Render Queue Into Element ──
export function renderQueueInto(el) {
  if (!el) return;
  if (!store.playerQueue.length) {
    el.innerHTML = '<div class="empty-state"><p>Queue is empty</p></div>';
    return;
  }
  el.innerHTML = store.playerQueue.map((item, i) => `
    <div class="queue-item${i === store.playerIndex ? ' now-playing' : ''}" data-qi="${i}">
      <span class="qi-num">${i === store.playerIndex ? '&#9654;' : i + 1}</span>
      <img class="qi-img" src="${item.image || ''}" alt="" onerror="this.style.background='var(--bg-elevated)'">
      <div class="qi-info">
        <div class="qi-title">${esc(item.name || '')}</div>
        <div class="qi-artist">${esc(item.artist || '')}</div>
      </div>
      <button class="qi-remove" data-qi-rm="${i}" title="Remove">&times;</button>
    </div>
  `).join('');
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('click', (e) => {
      if (e.target.closest('.qi-remove')) return;
      const idx = parseInt(qi.dataset.qi);
      if (idx !== store.playerIndex) { store.playerIndex = idx; loadAndPlay(); }
    });
  });
  // Scroll to now-playing track
  const nowPlaying = el.querySelector('.now-playing');
  if (nowPlaying) nowPlaying.scrollIntoView({ block: 'center', behavior: 'instant' });

  $$('.qi-remove', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.qiRm);
      store.playerQueue.splice(idx, 1);
      if (idx < store.playerIndex) store.playerIndex--;
      else if (idx === store.playerIndex) {
        if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
        if (store.playerIndex >= 0) loadAndPlay();
        else { audio.pause(); hidePlayerBar(); }
      }
      renderQueue();
      saveQueueDebounced();
    });
  });
}

export function renderQueue() {
  renderQueueInto($('#queueList'));
  if (store.fpQueuePanelOpen) renderQueueInto($('#fpQueuePanelList'));
  if (store.fullPlayerOpen && window.innerWidth > 640) renderQueueInto($('#fpQueueList'));
}

// ── Queue Panel (small player) ──
export function openQueuePanel() {
  renderQueue();
  $('#queueBackdrop').classList.add('open');
  $('#queuePanel').classList.add('open');
  store.queuePanelOpen = true;
  history.pushState({ layer: 'queuePanel' }, '');
}

export function closeQueuePanel(fromPopstate) {
  if (!store.queuePanelOpen) return;
  $('#queueBackdrop').classList.remove('open');
  const qp = $('#queuePanel');
  qp.classList.remove('open');
  qp.style.transform = '';
  qp.style.transition = '';
  store.queuePanelOpen = false;
  if (!fromPopstate) historyBack();
}

// ── Full Player Queue Panel ──
export function openFpQueuePanel() {
  store.fpQueuePanelOpen = true;
  renderQueue();
  $('#queueBackdrop').classList.add('open');
  $('#fpQueuePanel').classList.add('open');
  history.pushState({ layer: 'fpQueuePanel' }, '');
}

export function closeFpQueuePanel(fromPopstate) {
  if (!store.fpQueuePanelOpen) return;
  $('#queueBackdrop').classList.remove('open');
  const qp = $('#fpQueuePanel');
  qp.classList.remove('open');
  qp.style.transform = '';
  qp.style.transition = '';
  store.fpQueuePanelOpen = false;
  if (!fromPopstate) historyBack();
}

// ── Init ──
export function init() {
  $('#playerQueueBtn').addEventListener('click', () => {
    store.queuePanelOpen ? closeQueuePanel() : openQueuePanel();
  });
  $('#queuePanelClose').addEventListener('click', () => closeQueuePanel());
  $('#clearQueue').addEventListener('click', () => {
    audio.pause();
    store.playerQueue = [];
    store.playerIndex = -1;
    hidePlayerBar();
    renderQueue();
    closeQueuePanel();
    saveQueueDebounced();
  });
  $('#fpQueuePanelClose').addEventListener('click', () => closeFpQueuePanel());
  $('#fpQueueClear').addEventListener('click', () => {
    audio.pause();
    store.playerQueue = [];
    store.playerIndex = -1;
    hidePlayerBar();
    renderQueue();
    closeFpQueuePanel();
    saveQueueDebounced();
  });

  // ── Swipe down from top edge to open queue (not inside full player) ──
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

  // ── Swipe up to close small queue panel (slides from top) ──
  const qPanel = document.getElementById('queuePanel');
  if (qPanel) {
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
  }

  // ── Swipe down to close big player queue panel (slides from bottom) ──
  const fpQPanel = document.getElementById('fpQueuePanel');
  if (fpQPanel) {
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
  }
}
