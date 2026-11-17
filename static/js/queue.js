// queue.js — Queue panel rendering (renderQueue), small player queue panel

import { store } from './store.js';
import { $, $$, esc, historyBack, showToast, showInputModal } from './utils.js';
import { getCachedBpm, isBpmUnavailable } from './bpm.js';
import { attachContextMenu, wasLongPress, makeKebabButton } from './contextmenu.js';
import { makeHeartButton } from './likes.js';
import { getPlayerModule } from './player_active.js';

// Forward references set during init to avoid circular imports
let loadAndPlay, hidePlayerBar, saveQueueDebounced;
let _audioRef = null;
let _audioGetter = null;
// Shown instead of a tempo number when the server said the track has no audio to
// analyse. DJ mode cannot beat-match such a track and Smart Queue cannot pick it.
const NOBPM_TITLE = 'No tempo data: the server found no audio file or library entry for it, so DJ mode and Smart Queue cannot use it';
function _noBpmBadgeHtml() {
  return `<span class="qi-bpm qi-nobpm" style="opacity:.6" title="${NOBPM_TITLE}">no BPM</span>`;
}

function audio() { return _audioGetter ? _audioGetter() : _audioRef; }

// ── Shuffle order ───────────────────────────────────────────────────────────
// Shuffle plays a PERMUTATION of the queue, so the panel has to draw that
// permutation: otherwise the "up next" row names a track the engine will never
// pick, which is what the audit measured (row 2 said "Get Lucky", the engine
// played "Solar Sailer").
//
// Two pieces of state: the tracks already played (Previous pops that stack) and
// the still-unplayed tail in the order it will be played. Both hold the queue's
// ITEMS, not their positions. Positions shift under every content change — a row
// removed with ✕, a row dragged, "Play next" from a kebab — and an order kept over
// positions then names other tracks without noticing. Recomputing on a LENGTH
// change alone was worse still: one ✕ re-dealt the whole tail, so 49 of 50 rows
// changed place, while a drag changed no length at all and left the order stale.
//
// The order NEVER touches data-qi. That attribute stays the index into
// store.playerQueue because the row's ✕ sends it to the server as a position in
// the user's Navidrome playlist — a permuted value would delete another track.
let _shufPlayed = [];
let _shufTail = [];

function _shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Reconcile with the queue as it stands now: tracks that left are dropped, tracks
// that arrived are dealt into the tail, everything else keeps the place it had.
function _syncShuffleOrder() {
  const q = store.playerQueue;
  const present = new Set(q);
  const seen = new Set();
  const keep = (list) => list.filter((it) => {
    if (!present.has(it) || seen.has(it)) return false;
    seen.add(it);
    return true;
  });
  _shufPlayed = keep(_shufPlayed);
  const cur = store.playerIndex >= 0 ? q[store.playerIndex] : null;
  if (cur) seen.add(cur);
  _shufTail = keep(_shufTail);
  const fresh = [];
  for (const it of q) if (!seen.has(it)) { seen.add(it); fresh.push(it); }
  if (fresh.length) _shufTail = _shufTail.concat(_shuffleInPlace(fresh));
}

function _idx(item) {
  const i = store.playerQueue.indexOf(item);
  return i >= 0 ? i : null;
}

/** Next index in the shuffle order, or null when it is exhausted. */
export function shuffleNext() {
  _syncShuffleOrder();
  const cur = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
  if (cur && _shufPlayed[_shufPlayed.length - 1] !== cur) _shufPlayed.push(cur);
  const next = _shufTail.shift();
  return next === undefined ? null : _idx(next);
}

/** The index shuffleNext() would return, WITHOUT consuming it — null when the order is
 *  exhausted. The DJ engine prefetches and pre-analyzes this track; before it existed
 *  the engine warmed queue[index + 1], which under shuffle is never the track played. */
export function peekShuffleNext() {
  _syncShuffleOrder();
  const next = _shufTail[0];
  return next === undefined ? null : _idx(next);
}

/** Previous index from the play history, or null when there is none. */
export function shufflePrev() {
  _syncShuffleOrder();
  const prev = _shufPlayed.pop();
  if (prev === undefined) return null;
  const cur = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
  if (cur) _shufTail.unshift(cur);
  return _idx(prev);
}

/** Drop the order — on toggle, and when a finished one has to start over. */
export function resetShuffleOrder() {
  _shufPlayed = [];
  _shufTail = [];
}

// The order has to outlive the page, or every restart deals a brand-new
// permutation: the panel shows a different running order than the one the user
// was listening to, and tracks already played come round again. It travels with
// the queue in the SAME save, as positions into that queue — two separate
// stores (the queue on the server, the order in localStorage) would drift apart
// the moment one write lands and the other does not.
export function serializeShuffleOrder() {
  if (!store.shuffleEnabled || !store.playerQueue.length) return null;
  // Deal anything still unplaced before writing, so what is saved is the order in
  // full — not a half of one that a restart would have to complete at random.
  _syncShuffleOrder();
  const pos = (list) => list.map(_idx).filter((i) => i != null);
  return { played: pos(_shufPlayed), tail: pos(_shufTail) };
}

// Positions are only meaningful against the queue they were saved with, so the
// caller restores the queue FIRST. Anything out of range, repeated or missing is
// dropped here; _syncShuffleOrder then deals whatever is left over.
export function restoreShuffleOrder(data) {
  _shufPlayed = [];
  _shufTail = [];
  if (!data) return;
  const q = store.playerQueue;
  const seen = new Set();
  const pick = (list) => (Array.isArray(list) ? list : []).reduce((out, i) => {
    if (Number.isInteger(i) && i >= 0 && i < q.length && !seen.has(i)) {
      seen.add(i);
      out.push(q[i]);
    }
    return out;
  }, []);
  _shufPlayed = pick(data.played);
  _shufTail = pick(data.tail);
}

/** Queue indices in the order they will actually be played. */
export function playOrder() {
  const n = store.playerQueue.length;
  const order = [];
  if (!store.shuffleEnabled || n < 2) {
    for (let i = 0; i < n; i++) order.push(i);
    return order;
  }
  _syncShuffleOrder();
  const taken = new Set();
  const take = (i) => { if (i != null && i >= 0 && i < n && !taken.has(i)) { taken.add(i); order.push(i); } };
  _shufPlayed.forEach((it) => take(_idx(it)));
  take(store.playerIndex);
  _shufTail.forEach((it) => take(_idx(it)));
  // Safety net: the panel must draw every row exactly once, whatever the state
  // above says — a queue holding the same object twice would otherwise lose a row.
  for (let i = 0; i < n; i++) take(i);
  return order;
}

// ── Autoplay tail ───────────────────────────────────────────────────────────
// Tracks the recommender appends once the queue runs dry. Remembered by object
// identity, not by position: upnext.playTracks REPLACES store.playerQueue with a
// fresh array, and an index remembered across that would point into a queue the
// user has since started over.
let _autoFirst = null;

/** Index of the first automatically appended track, or -1. */
export function autoplayStart() {
  if (!_autoFirst) return -1;
  return store.playerQueue.indexOf(_autoFirst);
}

export function markAutoplayStart(item) {
  if (autoplayStart() < 0) _autoFirst = item;
}

export function setAutoplayStartIndex(i) {
  _autoFirst = (i >= 0 && i < store.playerQueue.length) ? store.playerQueue[i] : null;
}

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
// Where a tempo badge belongs in a row. The heart and the kebab are appended AFTER
// the row's markup is built, so a badge that arrives later (lazy fetch) and anchors
// on .qi-remove lands past them, while a cached one sits before the heart — the same
// badge in two different slots depending on when the number showed up.
function _badgeAnchor(qi) {
  return qi.querySelector('.like-btn') || qi.querySelector('.kebab-btn') || qi.querySelector('.qi-remove');
}
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
        if (abort.aborted) return;
        if (!bpm && isBpmUnavailable(item.name, item.artist) && !qi.querySelector('.qi-bpm')) {
          const anchor = _badgeAnchor(qi);
          if (anchor) anchor.insertAdjacentHTML('beforebegin', _noBpmBadgeHtml());
        }
        // Small delay between API calls to not starve prefetch
        await new Promise(r => setTimeout(r, 200));
      }
      if (abort.aborted) return;
      if (bpm && !qi.querySelector('.qi-bpm')) {
        const anchor = _badgeAnchor(qi);
        if (anchor) {
          const badge = document.createElement('span');
          badge.className = 'qi-bpm';
          badge.textContent = Math.round(bpm);
          anchor.before(badge);
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
  const autoAt = autoplayStart();
  el.innerHTML = playOrder().map((i, pos) => {
    const item = store.playerQueue[i];
    const sep = i === autoAt ? '<div class="qi-autoplay-sep">Autoplay</div>' : '';
    return sep + `
    <div class="queue-item${i === store.playerIndex ? ' now-playing' : ''}" data-qi="${i}" data-qp="${pos}" draggable="true">
      <span class="qi-drag" title="Drag to reorder">&#x2630;</span>
      <span class="qi-num">${i === store.playerIndex ? '&#9654;' : pos + 1}</span>
      <img class="qi-img" ${item.image ? `src="${esc(item.image)}"` : ''} alt="" onerror="this.style.background='var(--bg-elevated)'">
      <div class="qi-info">
        <div class="qi-title">${esc(item.name || '')}</div>
        <div class="qi-artist">${esc(item.artist || '')}</div>
      </div>
      ${(() => { const b = getCachedBpm(item.name, item.artist); return b ? `<span class="qi-bpm">${Math.round(b)}</span>` : (isBpmUnavailable(item.name, item.artist) ? _noBpmBadgeHtml() : ''); })()}
      <button class="qi-remove" data-qi-rm="${i}" title="Remove">&times;</button>
    </div>
  `;
  }).join('');
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

// Every queue surface carries the same Save control. Saving an ad-hoc queue is a
// phone action above all, and the two panels a phone can reach had only Clear.
const SAVE_BTN_IDS = ['#fpSaveQueue', '#queuePanelSave', '#fpQueuePanelSave'];

export function updateSaveButton() {
  // Show "Save as playlist" whenever there is something to save. The click
  // handler promotes an Up Next playlistMode via rename, and otherwise falls
  // back to creating a fresh Navidrome playlist from the current queue.
  const show = store.playerQueue.length > 0;
  for (const id of SAVE_BTN_IDS) {
    const btn = $(id);
    if (!btn) continue;
    btn.style.display = show ? '' : 'none';
    btn.textContent = 'Save as playlist';
  }
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
  if (!np) return;
  // Scroll ONLY this container to center the now-playing row. scrollIntoView() walks
  // up and scrolls EVERY scrollable ancestor to reveal the target — including the
  // overflow:hidden fixed .full-player. On desktop WebKit that shifted the whole
  // full-player overlay up (both columns) and left a black band at the bottom when
  // the now-playing track sat near the end of a long queue. Setting el.scrollTop
  // directly touches only this list. Rects make it robust to offsetParent.
  const elRect = el.getBoundingClientRect();
  const npRect = np.getBoundingClientRect();
  const delta = (npRect.top - elRect.top) - (el.clientHeight / 2) + (npRect.height / 2);
  el.scrollTop = Math.max(0, el.scrollTop + delta);
}

// ── Queue Panel (small player) ──
export function openQueuePanel() {
  renderQueue();
  $('#queueBackdrop').classList.add('open');
  $('#queuePanel').classList.add('open');
  // Lift the bar over the backdrop for as long as THIS panel is open. The class is
  // set here and cleared in closeQueuePanel only — #queueBackdrop is shared with the
  // big player's queue panel, so a rule keyed off the backdrop would also raise the
  // bar over the full player.
  $('#playerBar').classList.add('queue-open');
  store.queuePanelOpen = true;
  history.pushState({ layer: 'queuePanel' }, '');
  scrollToNowPlaying($('#queueList'));
}

export function closeQueuePanel(fromPopstate) {
  if (!store.queuePanelOpen) return;
  $('#queueBackdrop').classList.remove('open');
  $('#playerBar').classList.remove('queue-open');
  const qp = $('#queuePanel');
  qp.classList.remove('open');
  qp.style.transform = '';
  qp.style.transition = '';
  store.queuePanelOpen = false;
  if (!fromPopstate) historyBack();
}

// ── Drag & Drop Reorder ──
// A track dropped above the one that is playing is never reached: playback only
// ever moves forward from store.playerIndex, so the move silently drops it from
// the set. Moving the now-playing track itself is fine — the index follows it.
// Where the playing track sits in the drawn order. With shuffle off this is
// store.playerIndex itself, so the rule below is unchanged for it.
function _currentPos() {
  return playOrder().indexOf(store.playerIndex);
}

// Positions in the DRAWN order. Nothing may be dropped into the part already
// played, and the playing track stays put.
function _dropAllowed(fromPos, toPos) {
  const cur = _currentPos();
  return fromPos === cur || toPos > cur;
}

// A drag expresses "play this one there", and with shuffle on "there" is a place
// in the permutation — not in store.playerQueue. Rewriting the queue for it
// would move a different track than the one under the finger (the rows are drawn
// permuted) and, in a named playlist, mirror that to Navidrome. So shuffle moves
// the tail and leaves the queue alone; without shuffle the two are the same list
// and the old by-index move still runs.
export function moveInPlayOrder(fromPos, toPos) {
  if (!store.shuffleEnabled || store.playerQueue.length < 2) {
    _moveQueueItem(fromPos, toPos);
    return;
  }
  _syncShuffleOrder();
  const order = playOrder();
  const moved = store.playerQueue[order[fromPos]];
  const target = store.playerQueue[order[toPos]];
  const from = _shufTail.indexOf(moved);
  const to = _shufTail.indexOf(target);
  if (from < 0 || to < 0) return;
  _shufTail.splice(from, 1);
  _shufTail.splice(to, 0, moved);
  renderQueue();
  saveQueueDebounced();
}

let _dragIdx = -1;
let _dragContainer = null; // the queue list a drag started in (queue renders into up to 3)
function _attachDragHandlers(el) {
  $$('.queue-item', el).forEach(qi => {
    qi.addEventListener('dragstart', (e) => {
      _dragIdx = parseInt(qi.dataset.qp);
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
      const targetIdx = parseInt(target.dataset.qp);
      if (targetIdx !== _dragIdx && _dropAllowed(_dragIdx, targetIdx)) {
        target.classList.add('qi-drag-over');
      }
    });
    qi.addEventListener('dragleave', () => {
      qi.classList.remove('qi-drag-over');
    });
    qi.addEventListener('drop', (e) => {
      e.preventDefault();
      qi.classList.remove('qi-drag-over');
      const toIdx = parseInt(qi.dataset.qp);
      // Only honor a drop in the SAME container the drag started in, and only if
      // both indices are still valid (the queue may have re-rendered mid-drag).
      const n = store.playerQueue.length;
      if (_dragContainer === el && _dragIdx >= 0 && _dragIdx < n
          && toIdx >= 0 && toIdx < n && _dragIdx !== toIdx
          && _dropAllowed(_dragIdx, toIdx)) {
        moveInPlayOrder(_dragIdx, toIdx);
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
      const fromIdx = parseInt(row.dataset.qp);
      let toIdx = fromIdx;
      row.classList.add('qi-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}

      const onMove = (ev) => {
        // Target index = the last row whose vertical midpoint is above the pointer.
        const rows = $$('.queue-item', el);
        let target = 0;
        for (const r of rows) {
          const rect = r.getBoundingClientRect();
          if (ev.clientY > rect.top + rect.height / 2) target = parseInt(r.dataset.qp);
        }
        const n = store.playerQueue.length;
        const cur = _currentPos();
        const floor = fromIdx === cur ? 0 : Math.min(cur + 1, n - 1);
        target = Math.max(floor, Math.min(n - 1, target));
        if (target !== toIdx) {
          rows.forEach(r => r.classList.remove('qi-drag-over'));
          toIdx = target;
          if (toIdx !== fromIdx) {
            const tr = el.querySelector(`.queue-item[data-qp="${toIdx}"]`);
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
        if (commit && fromIdx >= 0 && fromIdx < n && toIdx >= 0 && toIdx < n && fromIdx !== toIdx
            && _dropAllowed(fromIdx, toIdx)) {
          moveInPlayOrder(fromIdx, toIdx);
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
  async function _saveQueueAsPlaylist(btn) {
    if (!store.playerQueue.length) return;
    const name = await showInputModal('Save as playlist', '', { okLabel: 'Save', placeholder: 'Playlist name' });
    if (!name || !name.trim()) return;
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
          showToast(`Playlist "${name.trim()}" already exists — pick another name`);
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
  }
  for (const id of SAVE_BTN_IDS) {
    const b = $(id);
    if (b) b.addEventListener('click', () => _saveQueueAsPlaylist(b));
  }

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
      // This panel closes on an upward swipe — the same gesture that scrolls
      // the list *down*. Inside the list that swipe belongs to the list, or
      // the queue can never be scrolled at all (it starts at scrollTop 0, and
      // the old `scrollTop > 0` guard meant it could never leave it).
      const qList = qPanel.querySelector('.queue-list');
      if (qList && qList.contains(e.target) &&
          qList.scrollTop + qList.clientHeight < qList.scrollHeight - 1) return;
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
      // Closes on a downward swipe; inside the list that gesture scrolls up,
      // so it only becomes a close once the list sits at its top. Outside the
      // list (handle, header) the drag always closes.
      const qList = fpQPanel.querySelector('.queue-list');
      if (qList && qList.contains(e.target) && qList.scrollTop > 0) return;
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
