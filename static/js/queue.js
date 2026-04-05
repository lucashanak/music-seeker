// queue.js — Queue panel rendering (renderQueue), small player queue panel

import { store } from './store.js';
import { $, $$, esc, historyBack, showToast } from './utils.js';
import { getCachedBpm } from './bpm.js';

// Forward references set during init to avoid circular imports
let loadAndPlay, hidePlayerBar, saveQueueDebounced;
let _audioRef = null;
let _audioGetter = null;
function audio() { return _audioGetter ? _audioGetter() : _audioRef; }

export function setPlayerRefs(refs) {
  loadAndPlay = refs.loadAndPlay;
  hidePlayerBar = refs.hidePlayerBar;
  saveQueueDebounced = refs.saveQueueDebounced;
  _audioRef = refs.audio;
  _audioGetter = refs.getAudio || null;
}

import { fetchTrackBpm } from './bpm.js';

let _bpmLoadTimer = null;
let _bpmLoadAbort = null;
/** Lazy-load BPM badges — limited to nearby tracks, with delays between requests. */
async function _loadMissingBpm(el) {
  clearTimeout(_bpmLoadTimer);
  if (_bpmLoadAbort) _bpmLoadAbort.aborted = true;
  const abort = { aborted: false };
  _bpmLoadAbort = abort;

  _bpmLoadTimer = setTimeout(async () => {
    // Only load BPM for tracks near current position (±10)
    const lo = Math.max(0, store.playerIndex - 5);
    const hi = Math.min(store.playerQueue.length - 1, store.playerIndex + 10);
    for (let i = lo; i <= hi; i++) {
      if (abort.aborted) return;
      const qi = el.querySelector(`[data-qi="${i}"]`);
      if (!qi || qi.querySelector('.qi-bpm')) continue;
      const item = store.playerQueue[i];
      if (!item) continue;
      let bpm = getCachedBpm(item.name, item.artist);
      if (!bpm) {
        const data = await fetchTrackBpm(item.name, item.artist).catch(() => null);
        if (data) bpm = data.bpm;
        // Small delay between API calls to not starve prefetch
        await new Promise(r => setTimeout(r, 200));
      }
      if (abort.aborted) return;
      if (bpm && !qi.querySelector('.qi-bpm')) {
        const rmBtn = qi.querySelector('.qi-remove');
        if (rmBtn) {
          const badge = document.createElement('span');
          badge.className = 'qi-bpm';
          badge.textContent = Math.round(bpm);
          rmBtn.before(badge);
        }
      }
    }
  }, 1000);
}

// ── Render Queue Into Element ──
export function renderQueueInto(el) {
  if (!el) return;
  if (!store.playerQueue.length) {
    el.innerHTML = '<div class="empty-state"><p>Queue is empty</p></div>';
    return;
  }
  el.innerHTML = store.playerQueue.map((item, i) => `
    <div class="queue-item${i === store.playerIndex ? ' now-playing' : ''}" data-qi="${i}" draggable="true">
      <span class="qi-drag" title="Drag to reorder">&#x2630;</span>
      <span class="qi-num">${i === store.playerIndex ? '&#9654;' : i + 1}</span>
      <img class="qi-img" src="${item.image || ''}" alt="" onerror="this.style.background='var(--bg-elevated)'">
      <div class="qi-info">
        <div class="qi-title">${esc(item.name || '')}</div>
        <div class="qi-artist">${esc(item.artist || '')}</div>
      </div>
      ${(() => { const b = getCachedBpm(item.name, item.artist); return b ? `<span class="qi-bpm">${Math.round(b)}</span>` : ''; })()}
      <button class="qi-remove" data-qi-rm="${i}" title="Remove">&times;</button>
    </div>
  `).join('');
  _attachDragHandlers(el);
  // Lazy-load BPM badges for tracks not yet in cache
  _loadMissingBpm(el);
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('click', (e) => {
      if (e.target.closest('.qi-remove')) return;
      const idx = parseInt(qi.dataset.qi);
      if (idx !== store.playerIndex) { store.playerIndex = idx; loadAndPlay(); }
    });
  });
  $$('.qi-remove', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.qiRm);
      const removed = store.playerQueue[idx];
      store.playerQueue.splice(idx, 1);
      if (idx < store.playerIndex) store.playerIndex--;
      else if (idx === store.playerIndex) {
        if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
        if (store.playerIndex >= 0) loadAndPlay();
        else { audio().pause(); hidePlayerBar(); }
      }
      renderQueue();
      saveQueueDebounced();
      // Playlist mode: remove from Navidrome playlist too
      if (store.playlistMode && removed) {
        import('./api.js').then(m => m.apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
          method: 'POST',
          body: { name: removed.name || '', artist: removed.artist || '' },
        })).catch(() => {});
      }
    });
  });
}

export function updateSaveButton() {
  const btn = $('#fpSaveQueue');
  if (btn) btn.style.display = (!store.playlistMode && store.playerQueue.length > 0) ? '' : 'none';
}

export function renderQueue() {
  renderQueueInto($('#queueList'));
  if (store.fpQueuePanelOpen) {
    renderQueueInto($('#fpQueuePanelList'));
  }
  if (store.fullPlayerOpen && window.innerWidth > 640) {
    renderQueueInto($('#fpQueueList'));
  }
  // Re-append recs after queue re-render (they share scroll containers)
  import('./recommendations.js').then(m => { if (m.hasRecs()) m.appendRecsToQueue(); });
  updateSaveButton();
}

export function scrollToNowPlaying(el) {
  if (!el) return;
  const np = el.querySelector('.now-playing');
  if (np) np.scrollIntoView({ block: 'center', behavior: 'instant' });
}

// ── Queue Panel (small player) ──
export function openQueuePanel() {
  renderQueue();
  $('#queueBackdrop').classList.add('open');
  $('#queuePanel').classList.add('open');
  store.queuePanelOpen = true;
  history.pushState({ layer: 'queuePanel' }, '');
  scrollToNowPlaying($('#queueList'));
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

// ── Drag & Drop Reorder ──
let _dragIdx = -1;
function _attachDragHandlers(el) {
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('dragstart', (e) => {
      _dragIdx = parseInt(qi.dataset.qi);
      qi.classList.add('qi-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    qi.addEventListener('dragend', () => {
      qi.classList.remove('qi-dragging');
      _dragIdx = -1;
    });
    qi.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = qi;
      const targetIdx = parseInt(target.dataset.qi);
      if (targetIdx !== _dragIdx) {
        target.classList.add('qi-drag-over');
      }
    });
    qi.addEventListener('dragleave', () => {
      qi.classList.remove('qi-drag-over');
    });
    qi.addEventListener('drop', (e) => {
      e.preventDefault();
      qi.classList.remove('qi-drag-over');
      const toIdx = parseInt(qi.dataset.qi);
      if (_dragIdx < 0 || _dragIdx === toIdx) return;
      _moveQueueItem(_dragIdx, toIdx);
      _dragIdx = -1;
    });
  });
}

function _moveQueueItem(from, to) {
  const [item] = store.playerQueue.splice(from, 1);
  store.playerQueue.splice(to, 0, item);
  // Adjust playerIndex
  if (store.playerIndex === from) {
    store.playerIndex = to;
  } else if (from < store.playerIndex && to >= store.playerIndex) {
    store.playerIndex--;
  } else if (from > store.playerIndex && to <= store.playerIndex) {
    store.playerIndex++;
  }
  renderQueue();
  saveQueueDebounced();
  // Playlist mode: sync reorder to Navidrome playlist
  if (store.playlistMode) {
    const songIds = store.playerQueue.map(t => t.id).filter(Boolean);
    if (songIds.length) {
      import('./api.js').then(m => m.apiJson(`/api/library/playlist/${store.playlistMode.id}/reorder`, {
        method: 'PUT',
        body: { song_ids: songIds },
      })).catch(() => {});
    }
  }
}


// ── Full Player Queue Panel ──
export function openFpQueuePanel() {
  store.fpQueuePanelOpen = true;
  renderQueue();
  $('#queueBackdrop').classList.add('open');
  $('#fpQueuePanel').classList.add('open');
  history.pushState({ layer: 'fpQueuePanel' }, '');
  scrollToNowPlaying($('#fpQueuePanelList'));
  import('./recommendations.js').then(m => m.onPanelOpened());
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
  // Save queue as Navidrome playlist
  $('#fpSaveQueue').addEventListener('click', async () => {
    if (!store.playerQueue.length) return;
    const name = prompt('Save queue as playlist:');
    if (!name || !name.trim()) return;
    const btn = $('#fpSaveQueue');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const { apiJson } = await import('./api.js');
      // Create playlist
      await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      // Get new playlist ID
      const data = await apiJson('/api/library/playlists');
      const pl = (data.playlists || []).find(p => p.name === name.trim());
      if (!pl) throw new Error('Playlist not created');
      // Add all tracks by name
      let added = 0;
      for (const track of store.playerQueue) {
        try {
          await apiJson(`/api/library/playlist/${pl.id}/add-by-name`, {
            method: 'POST',
            body: { name: track.name || '', artist: track.artist || '', album: track.album || '' },
          });
          added++;
        } catch {}
      }
      showToast(`Saved "${name.trim()}" (${added}/${store.playerQueue.length} tracks)`);
      // Activate playlist mode
      store.playlistMode = { id: pl.id, name: name.trim() };
      import('./player.js').then(m => m.updatePlaylistBadge());
      updateSaveButton();
    } catch (e) {
      showToast('Failed to save: ' + (e.message || ''));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  // Click playlist badge to deactivate playlist mode
  const plBadge = $('#fpPlaylistBadge');
  if (plBadge) plBadge.addEventListener('click', () => {
    store.playlistMode = null;
    plBadge.style.display = 'none';
    import('./utils.js').then(m => m.showToast('Playlist mode deactivated'));
  });
  $('#queuePanelClose').addEventListener('click', () => closeQueuePanel());
  $('#clearQueue').addEventListener('click', () => {
    audio().pause();
    store.playerQueue = [];
    store.playerIndex = -1;
    store.playlistMode = null;
    hidePlayerBar();
    renderQueue();
    closeQueuePanel();
    saveQueueDebounced();
  });
  $('#fpQueuePanelClose').addEventListener('click', () => closeFpQueuePanel());
  $('#fpQueueClear').addEventListener('click', () => {
    audio().pause();
    store.playerQueue = [];
    store.playerIndex = -1;
    store.playlistMode = null;
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
