// queue.js — Queue panel rendering (renderQueue), small player queue panel

import { store } from './store.js';
import { $, $$, esc, historyBack, showToast, showInputModal } from './utils.js';
import { getCachedBpm } from './bpm.js';
import { attachContextMenu, wasLongPress, makeKebabButton } from './contextmenu.js';
import { makeHeartButton } from './likes.js';
import { getPlayerModule } from './player_active.js';

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

// Per-panel lazy-load state. renderQueue() renders into up to 3 panels; a single
// shared timer/abort would let each panel's call cancel the previous one, so only
// the last-rendered panel ever got badges. Key the state per element.
const _bpmLoadState = new WeakMap();
/** Lazy-load BPM badges — limited to nearby tracks, with delays between requests. */
async function _loadMissingBpm(el) {
  const prev = _bpmLoadState.get(el);
  if (prev) {
    clearTimeout(prev.timer);
    prev.abort.aborted = true;
  }
  const abort = { aborted: false };
  const state = { timer: null, abort };
  _bpmLoadState.set(el, state);

  state.timer = setTimeout(async () => {
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
      <img class="qi-img" src="${esc(item.image || '')}" alt="" onerror="this.style.background='var(--bg-elevated)'">
      <div class="qi-info">
        <div class="qi-title">${esc(item.name || '')}</div>
        <div class="qi-artist">${esc(item.artist || '')}</div>
      </div>
      ${(() => { const b = getCachedBpm(item.name, item.artist); return b ? `<span class="qi-bpm">${Math.round(b)}</span>` : ''; })()}
      <button class="qi-remove" data-qi-rm="${i}" title="Remove">&times;</button>
    </div>
  `).join('');
  _attachDragHandlers(el);
  _attachTouchReorder(el);
  // Lazy-load BPM badges for tracks not yet in cache
  _loadMissingBpm(el);
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('click', (e) => {
      if (wasLongPress()) return;
      if (e.target.closest('.qi-remove') || e.target.closest('.qi-drag')) return;
      const idx = parseInt(qi.dataset.qi);
      if (idx !== store.playerIndex) { store.playerIndex = idx; loadAndPlay(); }
    });
  });
  attachContextMenu(el, {
    selector: '.queue-item',
    getItem: (targetEl) => {
      const idx = parseInt(targetEl.dataset.qi);
      const item = store.playerQueue[idx];
      if (!item) return null;
      return { item, type: 'queue-track', context: { queueIndex: idx } };
    },
  });
  // Visible ⋯ kebab + heart on each row → heart left of the kebab.
  $$('.queue-item', el).forEach(qi => {
    if (qi.querySelector('.kebab-btn')) return;
    const idx = parseInt(qi.dataset.qi);
    const kebab = makeKebabButton(() => {
      const item = store.playerQueue[idx];
      if (!item) return null;
      return { item, type: 'queue-track', context: { queueIndex: idx } };
    });
    const rm = qi.querySelector('.qi-remove');
    if (rm) qi.insertBefore(kebab, rm); else qi.appendChild(kebab);
    if (store.playerQueue[idx] && !qi.querySelector('.like-btn')) {
      // getter (not a snapshot) so the heart stays correct after a queue reorder
      qi.insertBefore(makeHeartButton(() => store.playerQueue[idx]), kebab);
    }
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
        if (store.playerIndex >= 0) {
          // Hard cut: pause the active deck so the engine does NOT crossfade out of
          // the track the user just removed (crossfade/dj loadAndPlay crossfades
          // whenever the active deck is still playing).
          try { const a = audio(); if (a) a.pause(); } catch (e) {}
          loadAndPlay();
        }
        else { audio().pause(); hidePlayerBar(); }
      }
      renderQueue();
      saveQueueDebounced();
      // Playlist mode: remove from Navidrome playlist too
      if (store.playlistMode && removed) {
        import('./api.js').then(m => m.apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
          method: 'POST',
          body: { name: removed.name || '', artist: removed.artist || '', index: idx },
        })).catch(() => {});
      }
    });
  });
}

export function updateSaveButton() {
  const btn = $('#fpSaveQueue');
  if (!btn) return;
  // Show "Save as playlist" whenever there is something to save. The click
  // handler promotes an Up Next playlistMode via rename, and otherwise falls
  // back to creating a fresh Navidrome playlist from the current queue.
  const show = store.playerQueue.length > 0;
  btn.style.display = show ? '' : 'none';
  btn.textContent = 'Save as playlist';
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
let _dragContainer = null; // the queue list a drag started in (queue renders into up to 3)
function _attachDragHandlers(el) {
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('dragstart', (e) => {
      _dragIdx = parseInt(qi.dataset.qi);
      _dragContainer = el;
      qi.classList.add('qi-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    qi.addEventListener('dragend', () => {
      qi.classList.remove('qi-dragging');
      _dragIdx = -1;
      _dragContainer = null;
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
      // Only honor a drop in the SAME container the drag started in, and only if
      // both indices are still valid (the queue may have re-rendered mid-drag).
      const n = store.playerQueue.length;
      if (_dragContainer === el && _dragIdx >= 0 && _dragIdx < n
          && toIdx >= 0 && toIdx < n && _dragIdx !== toIdx) {
        _moveQueueItem(_dragIdx, toIdx);
      }
      _dragIdx = -1;
      _dragContainer = null;
    });
  });
}

// ── Touch/Pointer Reorder ──
// HTML5 Drag-and-Drop (above) never fires on touch, so the queue — the mobile-
// primary surface — has no reorder there. This adds a Pointer Events path on the
// .qi-drag handle for touch/pen only; desktop mouse still uses the native DnD.
// On commit it reuses the same _moveQueueItem(from, to) as the drop handler.
function _attachTouchReorder(el) {
  $$('.qi-drag', el).forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return; // mouse keeps the HTML5 DnD path
      const row = handle.closest('.queue-item');
      if (!row) return;
      e.preventDefault(); // touch-action:none on the handle also blocks scroll
      const fromIdx = parseInt(row.dataset.qi);
      let toIdx = fromIdx;
      row.classList.add('qi-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      const onMove = (ev) => {
        // Target index = the last row whose vertical midpoint is above the pointer.
        const rows = $$('.queue-item', el);
        let target = 0;
        for (const r of rows) {
          const rect = r.getBoundingClientRect();
          if (ev.clientY > rect.top + rect.height / 2) target = parseInt(r.dataset.qi);
        }
        const n = store.playerQueue.length;
        target = Math.max(0, Math.min(n - 1, target));
        if (target !== toIdx) {
          rows.forEach(r => r.classList.remove('qi-drag-over'));
          toIdx = target;
          if (toIdx !== fromIdx) {
            const tr = el.querySelector(`.queue-item[data-qi="${toIdx}"]`);
            if (tr) tr.classList.add('qi-drag-over');
          }
        }
      };
      const finish = (commit) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        row.classList.remove('qi-dragging');
        $$('.queue-item', el).forEach(r => r.classList.remove('qi-drag-over'));
        const n = store.playerQueue.length;
        if (commit && fromIdx >= 0 && fromIdx < n && toIdx >= 0 && toIdx < n && fromIdx !== toIdx) {
          _moveQueueItem(fromIdx, toIdx);
        }
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onCancel);
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
  // Playlist mode: sync reorder to Navidrome playlist. Use a name-based full-queue
  // replace (same contract as upnext.js) so id-less tracks (Spotify/reco/yt-dlp)
  // are preserved instead of being dropped by an id-filtered partial reorder.
  if (store.playlistMode) {
    const tracks = store.playerQueue.map(t => ({
      name: t.name || '', artist: t.artist || '', album: t.album || '',
    }));
    import('./upnext.js').then(m => m.replaceByName(store.playlistMode.id, tracks)).catch(() => {});
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
  // Save: promote current Up Next to a named playlist, then spawn a fresh Up Next.
  $('#fpSaveQueue').addEventListener('click', async () => {
    if (!store.playerQueue.length) return;
    const name = await showInputModal('Save as playlist', '', { okLabel: 'Save', placeholder: 'Playlist name' });
    if (!name || !name.trim()) return;
    const btn = $('#fpSaveQueue');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const { apiJson } = await import('./api.js');
      // Promote an existing "Up Next" context via rename; otherwise (no playlist
      // context, or already a named playlist) create a fresh playlist and copy.
      const isUpNext = !!store.playlistMode && store.playlistMode.name === 'Up Next';
      if (isUpNext) {
        // Rename Up Next → user's chosen name. The Navidrome playlist sheds the
        // __upnext_ prefix, becoming a regular library entry. Tracks unchanged.
        await apiJson(`/api/library/playlist/${store.playlistMode.id}/rename`, {
          method: 'PUT', body: { name: name.trim() },
        });
        store.playlistMode = { id: store.playlistMode.id, name: name.trim() };
        // Spawn a fresh Up Next for the next round of ad-hoc playback.
        const u = await import('./upnext.js');
        // Don't override playlistMode (now points to the named playlist),
        // but ensure a new Up Next exists for later use.
        const prev = store.playlistMode;
        store.playlistMode = null;
        await u.initUpNext();
        store.playlistMode = prev;
        showToast(`Saved as "${name.trim()}"`);
      } else {
        // Already in a named playlist — fall back to the legacy create-and-copy.
        // Guard against name collision: creating is idempotent by name, so re-using
        // an existing name would append the whole queue to that playlist (doubling it).
        const existing = await apiJson('/api/library/playlists');
        if ((existing.playlists || []).some(p => p.name === name.trim())) {
          showToast(`Playlist "${name.trim()}" už existuje — zvol jiný název`);
          return;
        }
        await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
        const data = await apiJson('/api/library/playlists');
        const pl = (data.playlists || []).find(p => p.name === name.trim());
        if (!pl) throw new Error('Playlist not created');
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
        store.playlistMode = { id: pl.id, name: name.trim() };
      }
      getPlayerModule().then(m => m.updatePlaylistBadge());
      const badge = $('#fpPlaylistBadge');
      if (badge && store.playlistMode) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
      updateSaveButton();
    } catch (e) {
      showToast('Failed to save: ' + (e.message || ''));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save as playlist';
    }
  });

  // Click playlist badge: if a named playlist is active, switch back to Up Next;
  // otherwise (already in Up Next) it's a no-op. We never leave the unified model.
  const plBadge = $('#fpPlaylistBadge');
  if (plBadge) plBadge.addEventListener('click', async () => {
    if (!store.playlistMode) return;
    if (store.playlistMode.name === 'Up Next') return;
    const u = await import('./upnext.js');
    store.playlistMode = null;
    await u.initUpNext();
    showToast('Switched to Up Next');
  });
  $('#queuePanelClose').addEventListener('click', () => closeQueuePanel());
  $('#clearQueue').addEventListener('click', async () => {
    audio().pause();
    const u = await import('./upnext.js');
    await u.clearActiveQueue();
    hidePlayerBar();
    renderQueue();
    closeQueuePanel();
    saveQueueDebounced();
  });
  $('#fpQueuePanelClose').addEventListener('click', () => closeFpQueuePanel());
  $('#fpQueueClear').addEventListener('click', async () => {
    audio().pause();
    const u = await import('./upnext.js');
    await u.clearActiveQueue();
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
