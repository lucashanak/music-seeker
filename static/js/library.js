// library.js — Navidrome library playlists management

import { store } from './store.js';
import { $, $$, esc, escAttr, showToast, historyBack, showPlaylistPicker, showInputModal, showPlaylistFormModal, showConfirmModal } from './utils.js';
import { apiJson } from './api.js';
import { renderResults } from './search.js';
import { fetchPlaylistBpm, addBpmBadges, createBpmFilter, addScanButton } from './bpm.js';
import { attachContextMenu, buildActionsFor, showContextMenu, wasLongPress, makeKebabButton } from './contextmenu.js';
import { getPlayerModule } from './player_active.js';
import { loadLikes, getLikedTracks, likedCount } from './likes.js';

let libraryCache = null;

// ── Library sub-tabs (Downloaded / Spotify / Podcasts / Favorites) ──
// The former "My Spotify", "My Podcasts" and "Favorites" pages now live as
// sub-views inside #pageLibrary. Each sub-view is lazy-loaded the first time its
// tab is opened; the matching loader is imported dynamically to avoid load-order
// coupling. Container IDs are preserved from the old pages so their existing JS
// keeps working unchanged.
const _LIB_TABS = {
  downloaded: '#libTabDownloaded',
  spotify:    '#pagePlaylists',
  podcasts:   '#pagePodcasts',
  favorites:  '#pageFavorites',
};
let _activeLibTab = null;
const _loadedLibTabs = new Set();

function _spotifyHidden() {
  // A known API outage hides the tab regardless of per-user OAuth: the 403 is
  // app-level (expired Premium on the app owner's account), so a user's own
  // refresh token does not rescue it. Only a *reported* outage counts — absent
  // status means "no information", which must not hide anything.
  if (store.spotifyStatus && store.spotifyStatus.available === false) return true;
  return !!(store.currentUser && store.currentUser.hide_spotify);
}

// Show/hide the Spotify sub-tab button per the hide_spotify user setting. The
// settings.js #settingHideSpotify handler can't be edited, so we re-read the
// setting whenever the Library page is (re)entered rather than reacting live.
function _applySpotifyTabVisibility() {
  const tabBtn = $('#libraryTabs .sp-tab[data-lib-tab="spotify"]');
  if (tabBtn) tabBtn.style.display = _spotifyHidden() ? 'none' : '';
}

// Toggle which sub-view container + tab button is active (no loading).
function _setActiveLibTab(name, bypassGate = false) {
  if (!_LIB_TABS[name]) name = 'downloaded';
  if (!bypassGate && name === 'spotify' && _spotifyHidden()) name = 'downloaded';
  _activeLibTab = name;
  $$('#libraryTabs .sp-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.libTab === name));
  Object.entries(_LIB_TABS).forEach(([key, sel]) => {
    const el = $(sel);
    if (el) el.style.display = key === name ? '' : 'none';
  });
}

// Reveal the Library page + a sub-view container WITHOUT (re)loading it. Used by
// cross-module detail openers (e.g. opening a Spotify playlist from search) that
// render their own content into a moved sub-view.
export function showLibrarySubView(name) {
  const page = $('#pageLibrary');
  if (page) page.style.display = '';
  // bypassGate: a caller is about to render detail into this container, so show
  // it even if its tab is gated (e.g. Spotify hidden) — else detail renders hidden.
  _setActiveLibTab(name, true);
}

// Switch sub-tab: activate it and lazy-load its content the first time.
export function switchLibraryTab(name, force) {
  _setActiveLibTab(name);
  name = _activeLibTab; // normalized (may have fallen back to 'downloaded')
  if (!force && _loadedLibTabs.has(name)) return;
  _loadedLibTabs.add(name);
  if (name === 'downloaded') loadLibrary();
  else if (name === 'spotify') import('./spotify.js').then(m => m.loadPlaylists());
  else if (name === 'podcasts') import('./podcasts.js').then(m => m.loadPodcasts());
  else if (name === 'favorites') import('./favorites.js').then(m => m.loadFavorites());
}

// Page loader registered with the router for 'library'. Applies the Spotify-tab
// visibility gate, then shows the active sub-tab (defaulting to Downloaded).
export function loadLibraryPage() {
  _applySpotifyTabVisibility();
  switchLibraryTab(_activeLibTab || 'downloaded');
}

// Format a total duration (seconds) coarsely: "1 h 23 min" / "42 min".
function _fmtTotal(seconds) {
  seconds = Math.round(seconds || 0);
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

// Set the opened-playlist header: track count + total length (summed from the
// live track list, each track carries duration_ms from the playlist endpoint).
function _setLibDetailCount() {
  const n = currentLibPlaylistTracks.length;
  const totalSec = currentLibPlaylistTracks.reduce((a, t) => a + (t.duration_ms || 0), 0) / 1000;
  const total = _fmtTotal(totalSec);
  $('#libDetailCount').textContent = `${n} tracks` + (total ? ` · ${total}` : '');
}
let currentLibPlaylistId = null;
let currentLibPlaylistName = '';
let currentLibPlaylistDesc = '';
let currentLibPlaylistTracks = [];

// ── Multi-select state for playlist detail tracks ──
// Separate from the bulk-checkbox mode; lives only while detail view is open.
let _selectSet = new Set(); // indices of selected cards
let _lastSelectIdx = -1;    // last single-clicked index for shift-range

// Current playlist context for the (persistent) #libraryTracks context menu.
// The menu listener is attached ONCE on the persistent node; each detail load
// just updates this var so the handler reads the current playlist — avoids
// re-attaching (and leaking) listeners on every visit.
let _ctxPlaylistId = null;
let _ctxPlaylistName = '';

// ── Load Playlists ──
export async function loadLibrary() {
  const grid = $('#libraryGrid');
  if (!grid) return;
  $('#libraryDetail').style.display = 'none';
  const likedDetail = $('#likedSongsDetail');
  if (likedDetail) likedDetail.style.display = 'none';
  $('#libraryList').style.display = '';
  _refreshLikedCount();
  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson('/api/library/playlists');
    libraryCache = data.playlists || [];
    renderLibraryGrid(libraryCache, grid);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><p>Failed to load library playlists</p></div>`;
  }
}

function renderLibraryGrid(playlists, grid) {
  if (!playlists.length) {
    grid.innerHTML = '<div class="empty-state"><p>No playlists yet — tap + New Playlist above, or download an album to get started.</p></div>';
    return;
  }
  grid.innerHTML = playlists.map((pl, i) => `
    <div class="card lib-card" data-lib-idx="${i}">
      ${pl.image ? `<img class="card-img" src="${escAttr(pl.image)}" alt="" loading="lazy">` : `<div class="card-img" style="background:linear-gradient(135deg,var(--accent),#1a1a2e);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--text);">&#9835;</div>`}
      <div class="card-body">
        <div class="card-title">${esc(pl.name)}</div>
        <div class="card-sub">${pl.songCount} tracks${pl.duration ? ' · ' + _fmtTotal(pl.duration) : ''}</div>
      </div>
    </div>`).join('');

  $$('.lib-card', grid).forEach(card => {
    card.addEventListener('click', () => {
      if (wasLongPress(card)) return;
      const pl = playlists[card.dataset.libIdx];
      if (pl) loadLibraryDetail(pl.id);
    });
  });
  attachContextMenu(grid, {
    selector: '.lib-card',
    getItem: (targetEl) => {
      const pl = playlists[parseInt(targetEl.dataset.libIdx)];
      if (!pl) return null;
      return {
        title: pl.name,
        actions: [
          { label: 'Open', icon: '&#128194;', onClick: () => loadLibraryDetail(pl.id) },
          { label: 'Play all', icon: '&#9654;', onClick: () => _playLibraryPlaylist(pl, true) },
          { label: 'Queue all', icon: '+', onClick: () => _playLibraryPlaylist(pl, false) },
          { divider: true },
          { label: 'Rename…', icon: '&#9998;', onClick: () => _renameLibraryPlaylist(pl) },
          { label: 'Delete playlist', icon: '&times;', danger: true, onClick: () => _deleteLibraryPlaylist(pl) },
        ],
      };
    },
  });
}

async function _fetchPlaylistTracks(id) {
  const data = await apiJson(`/api/library/playlist/${id}`);
  return data.tracks || [];
}

async function _playLibraryPlaylist(pl, playNow) {
  try {
    const tracks = await _fetchPlaylistTracks(pl.id);
    if (!tracks.length) { showToast('Empty playlist'); return; }
    store.playlistMode = { id: pl.id, name: pl.name };
    const m = await getPlayerModule();
    if (playNow) {
      // Mode is named playlist — playTracks will not mirror (guarded by isUpNextActive)
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    } else {
      m.addToQueue(tracks);
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

async function _renameLibraryPlaylist(pl) {
  const name = await showInputModal('Rename playlist', pl.name, { okLabel: 'Rename' });
  if (!name || name === pl.name) return;
  try {
    await apiJson(`/api/library/playlist/${pl.id}/rename`, {
      method: 'PUT', body: { name },
    });
    libraryCache = null;
    loadLibrary();
    showToast('Renamed');
  } catch (e) {
    showToast('Rename failed');
  }
}

// Undoable playlist deletes: the actual DELETE fires only after a 5s window
// elapses without the user tapping "Undo". Keyed by id so Undo can cancel it.
const _pendingPlaylistDeletes = new Map(); // id -> timeout handle

function _schedulePlaylistDelete(id, name, onRestore) {
  if (_pendingPlaylistDeletes.has(id)) return; // already pending
  const timer = setTimeout(async () => {
    _pendingPlaylistDeletes.delete(id);
    try {
      await apiJson(`/api/library/playlist/${id}`, { method: 'DELETE' });
    } catch (e) {
      showToast('Delete failed');
      if (onRestore) onRestore();
    }
  }, 5000);
  _pendingPlaylistDeletes.set(id, timer);
  showToast(`Deleted "${name}"`, false, {
    actionLabel: 'Undo',
    duration: 5000,
    onAction: () => {
      const t = _pendingPlaylistDeletes.get(id);
      if (t) { clearTimeout(t); _pendingPlaylistDeletes.delete(id); }
      if (onRestore) onRestore();
      showToast('Restored');
    },
  });
}

async function _deleteLibraryPlaylist(pl) {
  const ok = await showConfirmModal('Delete playlist?', `"${pl.name}" will be deleted.`, { okLabel: 'Delete' });
  if (!ok) return;
  // Optimistically drop the card; the DELETE fires after the undo window.
  if (Array.isArray(libraryCache)) {
    libraryCache = libraryCache.filter(p => p.id !== pl.id);
    const grid = $('#libraryGrid');
    if (grid) renderLibraryGrid(libraryCache, grid);
  }
  _schedulePlaylistDelete(pl.id, pl.name, () => { libraryCache = null; loadLibrary(); });
}

// ── Playlist Detail ──
async function loadLibraryDetail(id) {
  currentLibPlaylistId = id;
  $('#libraryList').style.display = 'none';
  $('#libraryDetail').style.display = '';
  history.pushState({ layer: 'libraryDetail' }, '');
  const tracksEl = $('#libraryTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson(`/api/library/playlist/${id}`);
    currentLibPlaylistTracks = data.tracks || [];
    currentLibPlaylistName = data.name || '';
    currentLibPlaylistDesc = data.description || '';
    $('#libDetailName').textContent = data.name || '';
    const descEl = $('#libDetailDesc');
    if (descEl) {
      descEl.textContent = currentLibPlaylistDesc;
      descEl.style.display = currentLibPlaylistDesc ? '' : 'none';
    }
    $('#libDetailImg').src = data.image || '';
    if (!data.image) {
      $('#libDetailImg').style.background = 'linear-gradient(135deg,var(--accent),#1a1a2e)';
    } else {
      $('#libDetailImg').style.background = '';
    }
    _setLibDetailCount();
    _renderLibDetailTracks(id);
    // BPM: filter bar with scan button, fetch cached BPM, add badges
    const bpmFilter = _initBpmFilter(id);
    fetchPlaylistBpm(id).then(() => {
      addBpmBadges('#libraryTracks');
      if (bpmFilter && bpmFilter._refreshCoverage) bpmFilter._refreshCoverage();
    });
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load playlist</p></div>`;
  }
}

// Render + (re)attach all per-card handlers for the opened playlist. Factored out
// of loadLibraryDetail so a drag-reorder can re-render locally (instant feedback)
// without a refetch, keeping index-based checkbox/remove handlers in sync.
function _renderLibDetailTracks(id) {
  renderResults(currentLibPlaylistTracks, '#libraryTracks');
  // Tracks from a Navidrome playlist are definitively in the library —
  // mark them so openModal shows the Delete button without waiting for checkLibrary.
  _markTracksInLibrary('#libraryTracks', currentLibPlaylistTracks);
  // Override context menu: inject libraryPlaylistId/Name so right-click offers
  // "Remove from playlist" and "Delete from library" actions.
  _attachLibraryTrackContextMenu(id, currentLibPlaylistName);
  _attachLibraryKebabs(id, currentLibPlaylistName);
  _addBulkCheckboxes();
  _addSelectListeners();
  _addRemoveButtons(id);
  _addDragHandles(id);
  // Restore BPM badges from cache (fetchPlaylistBpm populates it on first load;
  // a local re-render after reorder would otherwise drop them).
  addBpmBadges('#libraryTracks');
}

// ── Drag-to-reorder (mouse + touch via Pointer Events) ──
// A dedicated per-card handle drives reordering; the card itself stays
// non-draggable so the existing bulk-select checkbox + modifier-click capture
// handlers are untouched.
function _addDragHandles(playlistId) {
  $$('#libraryTracks .card').forEach(card => {
    if (card.querySelector('.card-drag-handle')) return;
    const handle = document.createElement('span');
    handle.className = 'card-drag-handle';
    handle.title = 'Drag to reorder';
    handle.innerHTML = '&#x2630;';
    // Swallow clicks so the handle never opens the track modal.
    handle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    card.style.position = 'relative';
    card.appendChild(handle);
    _wireDragHandle(handle, card, playlistId);
  });
}

function _wireDragHandle(handle, card, playlistId) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const container = $('#libraryTracks');
    if (!container) return;
    const cards0 = () => Array.from(container.querySelectorAll('.card'));
    const fromIdx = cards0().indexOf(card);
    if (fromIdx < 0) return;
    card.classList.add('lib-dragging');
    let moved = false;
    const onMove = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const overCard = el && el.closest('#libraryTracks .card');
      if (!overCard || overCard === card) return;
      const sibs = cards0();
      const overIdx = sibs.indexOf(overCard);
      const curIdx = sibs.indexOf(card);
      if (overIdx < 0 || curIdx < 0) return;
      // Move the dragged node toward the hovered card (works for list + grid).
      if (overIdx < curIdx) container.insertBefore(card, overCard);
      else container.insertBefore(card, overCard.nextSibling);
      moved = true;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      card.classList.remove('lib-dragging');
      if (!moved) return;
      const toIdx = cards0().indexOf(card);
      if (toIdx < 0 || toIdx === fromIdx) return;
      _commitLibReorder(playlistId, fromIdx, toIdx);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

async function _commitLibReorder(playlistId, from, to) {
  // Splice the local model to match the DOM the drag already produced.
  const [movedTrack] = currentLibPlaylistTracks.splice(from, 1);
  currentLibPlaylistTracks.splice(to, 0, movedTrack);
  // Re-render locally so index-based checkbox/remove handlers resync to new order.
  _renderLibDetailTracks(playlistId);
  _setLibDetailCount();
  const songIds = currentLibPlaylistTracks.map(t => t.id).filter(Boolean);
  try {
    await apiJson(`/api/library/playlist/${playlistId}/reorder`, {
      method: 'PUT', body: { song_ids: songIds },
    });
  } catch (e) {
    showToast('Failed to reorder — reloading');
    loadLibraryDetail(playlistId);
  }
}

// ── Fix #1: mark Navidrome playlist tracks as inLibrary so openModal shows Delete ──
function _markTracksInLibrary(containerSelector, tracks) {
  $$(`${containerSelector} .card`).forEach((card, i) => {
    try {
      const item = JSON.parse(card.dataset.item);
      item.inLibrary = true;
      card.dataset.item = JSON.stringify(item);
      // Add visual badge if not already present
      if (!card.querySelector('.in-library-badge')) {
        card.classList.add('in-library');
        const badge = document.createElement('div');
        badge.className = 'in-library-badge';
        badge.textContent = 'In Library';
        card.appendChild(badge);
      }
    } catch {}
  });
}

// ── Fix #2: override context menu on libraryTracks with playlist context ──
// Re-attaches with augmented getItem that adds "Remove from playlist" and
// "Delete from library" actions. Resets __ctxAttached so attachContextMenu
// replaces the previous handler from renderResults.
// Build the menu info for a library-detail track card. Shared by both the
// right-click/long-press context menu and the visible ⋯ kebab so they offer
// identical actions (including multi-select and Remove/Delete from library).
function _libraryTrackInfo(targetEl, playlistId, playlistName) {
  try {
    const item = JSON.parse(targetEl.dataset.item);
    const idx = Array.from($$('#libraryTracks .card')).indexOf(targetEl);
    // If this card is part of a multi-selection, build a multi-track menu
    if (_selectSet.size > 1 && _selectSet.has(idx)) {
      return _buildMultiSelectMenu(playlistId, playlistName);
    }
    const type = item.type || 'track';
    const base = buildActionsFor(item, type, { inLibrary: true });
    // Inject "Remove from this playlist" before Delete at the end
    const removeAction = {
      label: `Remove from "${playlistName}"`, icon: '&times;', danger: false,
      onClick: () => _removeTrackFromPlaylist(playlistId, item, idx),
    };
    const deleteAction = {
      label: 'Delete from library', icon: '&#128465;', danger: true,
      onClick: () => _deleteTrackFromLibrary(item),
    };
    return {
      item,
      type,
      actions: [...base, { divider: true }, removeAction, deleteAction],
    };
  } catch { return null; }
}

function _attachLibraryTrackContextMenu(playlistId, playlistName) {
  const el = $('#libraryTracks');
  if (!el) return;
  // Update the current playlist context; the listener below reads these module
  // vars, so re-renders only refresh the context — never reset __ctxAttached.
  _ctxPlaylistId = playlistId;
  _ctxPlaylistName = playlistName;
  // Attach the listener exactly once on the persistent #libraryTracks node.
  attachContextMenu(el, {
    selector: '.card[data-item]',
    getItem: (targetEl) => _libraryTrackInfo(targetEl, _ctxPlaylistId, _ctxPlaylistName),
  });
}

// Replace the generic kebabs (added by renderResults) with library-context ones
// so the ⋯ button offers the same Remove/Delete actions as right-click.
function _attachLibraryKebabs(playlistId, playlistName) {
  $$('#libraryTracks .card').forEach(card => {
    const old = card.querySelector('.kebab-btn');
    if (old) old.remove();
    const kebab = makeKebabButton(() => _libraryTrackInfo(card, playlistId, playlistName), { className: 'kebab-lib' });
    card.appendChild(kebab);
  });
}

async function _removeTrackFromPlaylist(playlistId, item, idx) {
  try {
    await apiJson(`/api/library/playlist/${playlistId}/remove-by-name`, {
      method: 'POST',
      body: { name: item.name || '', artist: item.artist || '' },
    });
    showToast('Removed from playlist');
    loadLibraryDetail(playlistId);
  } catch (e) {
    showToast('Failed: ' + (e.message || ''));
  }
}

async function _deleteTrackFromLibrary(item) {
  try {
    const check = await apiJson('/api/library/track/check-playlists', {
      method: 'POST',
      body: { name: item.name || '', artist: item.artist || '' },
    });
    let msg = 'This removes it from the library permanently.';
    if (check.in_playlists && check.in_playlists.length) {
      msg += `\n\nThis track is in ${check.in_playlists.length} playlist(s):\n` +
        check.in_playlists.map(p => `• ${p.name}`).join('\n');
    }
    const ok = await showConfirmModal(`Delete "${item.artist} - ${item.name}"?`, msg, { okLabel: 'Delete' });
    if (!ok) return;
    await apiJson('/api/library/track/delete', {
      method: 'POST',
      body: { name: item.name || '', artist: item.artist || '' },
    });
    showToast('Track deleted');
    if (currentLibPlaylistId) loadLibraryDetail(currentLibPlaylistId);
  } catch (e) {
    showToast(e.message || 'Failed to delete');
  }
}

// ── Fix #3: Multi-select (shift/cmd-click) on playlist detail tracks ──
function _addSelectListeners() {
  // _selectSet and _lastSelectIdx already reset by _addBulkCheckboxes()
  $$('#libraryTracks .card').forEach((card, i) => {
    // Use capture=true so this fires BEFORE the card's bubble-phase click
    // handler (added by renderResults) — modifier clicks are intercepted here
    // and stopImmediatePropagation prevents the modal from opening.
    card.addEventListener('click', (e) => {
      // Checkbox clicks are handled by their own change handler — don't interfere
      if (e.target.classList.contains('lib-bulk-cb')) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // Modifier click → select only, never open modal
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey && _lastSelectIdx >= 0) {
          // Range select
          const lo = Math.min(_lastSelectIdx, i);
          const hi = Math.max(_lastSelectIdx, i);
          for (let j = lo; j <= hi; j++) _selectSet.add(j);
        } else {
          // Cmd/Ctrl toggle
          if (_selectSet.has(i)) _selectSet.delete(i); else _selectSet.add(i);
          _lastSelectIdx = i;
        }
        _updateSelectUI();
      } else {
        // Plain click: clear selection, let normal handler proceed
        if (_selectSet.size > 0) {
          _selectSet.clear();
          _updateSelectUI();
        }
        _lastSelectIdx = i;
      }
    }, true); // capture phase
  });
}

function _updateSelectUI() {
  $$('#libraryTracks .card').forEach((card, i) => {
    if (_selectSet.has(i)) {
      card.dataset.selected = 'true';
    } else {
      delete card.dataset.selected;
    }
    // Keep checkbox in sync with _selectSet
    const cb = card.querySelector('.lib-bulk-cb');
    if (cb) cb.checked = _selectSet.has(i);
  });
  _updateBulkUI();
}

function _buildMultiSelectMenu(playlistId, playlistName) {
  const cards = $$('#libraryTracks .card');
  const selectedItems = [..._selectSet]
    .filter(i => cards[i])
    .map(i => { try { return JSON.parse(cards[i].dataset.item); } catch { return null; } })
    .filter(Boolean);
  if (!selectedItems.length) return null;
  const count = selectedItems.length;
  return {
    title: `${count} tracks selected`,
    actions: [
      {
        label: 'Play all', icon: '&#9654;',
        onClick: () => import('./upnext.js').then(m => m.playTracks(selectedItems)),
      },
      {
        label: 'Play next', icon: '&#8595;',
        onClick: () => {
          const playing = store.playerIndex >= 0;
          const idx = (playing ? store.playerIndex : -1) + 1;
          store.playerQueue.splice(idx, 0, ...selectedItems);
          import('./queue.js').then(m => m.renderQueue());
          if (!playing) store.playerIndex = idx;
          getPlayerModule().then(m => {
            if (!playing && m.loadAndPlay) m.loadAndPlay();
            m.saveQueueDebounced && m.saveQueueDebounced();
          });
          showToast(playing ? `${count} tracks will play next` : 'Playing');
        },
      },
      {
        label: 'Add to playlist', icon: '+',
        onClick: () => {
          getPlayerModule().then(m => {
            m.addToQueue(selectedItems);
            showToast(`Added ${count} to playlist`);
          });
        },
      },
      {
        label: 'Add to other playlist…', icon: '&#9776;',
        onClick: async () => {
          try {
            const data = await apiJson('/api/library/playlists');
            const others = (data.playlists || []).filter(p => p.id !== playlistId);
            // No bail on an empty list: the picker's "+ New playlist" row is a
            // legitimate destination for "add to other playlist".
            const picked = await showPlaylistPicker(others);
            if (!picked || !picked.length) return;
            for (const pl of picked) {
              await apiJson(`/api/library/playlist/${pl.id}/add-and-download-batch`, {
                method: 'POST',
                body: { tracks: selectedItems.map(t => ({ name: t.name, artist: t.artist || '', album: t.album || '' })) },
              });
            }
            showToast(`Added ${count} tracks to ${picked.map(p => p.name).join(', ')}`);
          } catch (e) { showToast(e.message || 'Failed'); }
        },
      },
      { divider: true },
      {
        label: `Remove ${count} from "${playlistName}"`, icon: '&times;',
        onClick: async () => {
          const ok = await showConfirmModal('Remove tracks?', `Remove ${count} tracks from "${playlistName}"?`, { okLabel: 'Remove', danger: false });
          if (!ok) return;
          try {
            // Sort descending to avoid index shift
            const indices = [..._selectSet].sort((a, b) => b - a);
            await apiJson(`/api/library/playlist/${playlistId}/tracks`, {
              method: 'DELETE', body: { indices },
            });
            showToast(`Removed ${count} tracks`);
            loadLibraryDetail(playlistId);
          } catch (e) { showToast(e.message || 'Failed'); }
        },
      },
      {
        label: `Delete ${count} from library`, icon: '&#128465;', danger: true,
        onClick: async () => {
          const ok = await showConfirmModal('Delete tracks?', `Delete ${count} tracks from library? This cannot be undone.`, { okLabel: 'Delete' });
          if (!ok) return;
          let deleted = 0;
          for (const item of selectedItems) {
            try {
              await apiJson('/api/library/track/delete', {
                method: 'POST',
                body: { name: item.name || '', artist: item.artist || '' },
              });
              deleted++;
            } catch {}
          }
          showToast(`Deleted ${deleted} of ${count} tracks`);
          if (currentLibPlaylistId) loadLibraryDetail(currentLibPlaylistId);
        },
      },
    ],
  };
}

// ── Bulk select (checkboxes — unified with _selectSet) ──

function _addBulkCheckboxes() {
  // _selectSet is the single source of truth; reset it on each detail load
  _selectSet.clear();
  _lastSelectIdx = -1;
  _updateBulkUI();
  const toggle = $('#libBulkToggle');
  if (toggle) { toggle.checked = false; toggle.indeterminate = false; }
  $$('#libraryTracks .card').forEach((card, i) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lib-bulk-cb';
    cb.style.cssText = 'position:absolute;top:8px;left:8px;width:18px;height:18px;accent-color:var(--accent);z-index:2;cursor:pointer;';
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) _selectSet.add(i); else _selectSet.delete(i);
      _lastSelectIdx = i;
      _updateSelectUI();
      _updateBulkUI();
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
    card.style.position = 'relative';
    card.prepend(cb);
  });
}

function _updateBulkUI() {
  const actions = $('#libBulkActions');
  const count = $('#libBulkCount');
  if (actions) actions.style.display = _selectSet.size > 0 ? 'flex' : 'none';
  if (count) count.textContent = `${_selectSet.size} selected`;
  // Sync master toggle indeterminate state
  const toggle = $('#libBulkToggle');
  if (toggle) {
    const total = $$('#libraryTracks .card').length;
    if (_selectSet.size === 0) {
      toggle.checked = false;
      toggle.indeterminate = false;
    } else if (_selectSet.size === total) {
      toggle.checked = true;
      toggle.indeterminate = false;
    } else {
      toggle.checked = false;
      toggle.indeterminate = true;
    }
  }
}

function _addRemoveButtons(playlistId) {
  $$('#libraryTracks .card').forEach((card, i) => {
    const btn = document.createElement('button');
    btn.className = 'lib-track-remove';
    btn.title = 'Remove from playlist';
    btn.innerHTML = '&times;';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;width:24px;height:24px;border:none;background:rgba(0,0,0,.5);color:var(--text-muted);border-radius:50%;cursor:pointer;font-size:16px;line-height:1;z-index:2;display:flex;align-items:center;justify-content:center;';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await apiJson(`/api/library/playlist/${playlistId}/tracks`, {
          method: 'DELETE', body: { indices: [i] },
        });
        showToast('Removed from playlist');
        loadLibraryDetail(playlistId);
      } catch (err) { showToast('Failed: ' + (err.message || '')); }
    });
    card.style.position = 'relative';
    card.appendChild(btn);
  });
}

function _initBpmFilter(playlistId) {
  const existing = $('#libraryDetail .bpm-filter');
  if (existing) existing.remove();
  const filter = createBpmFilter('#libraryTracks');
  addScanButton(filter, playlistId, '#libraryTracks');
  const tracksEl = $('#libraryTracks');
  tracksEl.parentNode.insertBefore(filter, tracksEl);
  return filter;
}

export function closeLibraryDetail(fromPopstate) {
  $('#libraryDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  currentLibPlaylistId = null;
  if (!fromPopstate) historyBack();
}

// ── Liked Songs view ──
let _likedViewOpen = false;

function _refreshLikedCount() {
  const n = likedCount();
  const tileCount = $('#likedSongsCount');
  if (tileCount) tileCount.textContent = n === 1 ? '1 song' : `${n} songs`;
}

export async function openLikedSongs() {
  $('#libraryList').style.display = 'none';
  $('#libraryDetail').style.display = 'none';
  $('#likedSongsDetail').style.display = '';
  _likedViewOpen = true;
  history.pushState({ layer: 'likedSongs' }, '');
  const tracksEl = $('#likedSongsTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  await loadLikes();
  const tracks = getLikedTracks();
  $('#likedDetailCount').textContent = tracks.length === 1 ? '1 song' : `${tracks.length} songs`;
  _refreshLikedCount();
  if (!tracks.length) {
    tracksEl.innerHTML = '<div class="empty-state"><p>Songs you like will appear here.</p></div>';
    return;
  }
  // Reuse the shared track-row renderer (gives kebab + heart + context menu).
  renderResults(tracks, '#likedSongsTracks');
}

// Re-render the open Liked Songs view from the current liked set. Called on
// `likeschange` so unliking a row removes it (no ghost row) and the count stays
// in sync without a full reload.
function _rerenderLikedSongs() {
  if (!_likedViewOpen) return;
  const tracksEl = $('#likedSongsTracks');
  if (!tracksEl) return;
  const tracks = getLikedTracks();
  const countEl = $('#likedDetailCount');
  if (countEl) countEl.textContent = tracks.length === 1 ? '1 song' : `${tracks.length} songs`;
  _refreshLikedCount();
  if (!tracks.length) {
    tracksEl.innerHTML = '<div class="empty-state"><p>Songs you like will appear here.</p></div>';
    return;
  }
  renderResults(tracks, '#likedSongsTracks');
}

export function closeLikedSongs(fromPopstate) {
  if (!_likedViewOpen) return;
  $('#likedSongsDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  _likedViewOpen = false;
  _refreshLikedCount();
  if (!fromPopstate) historyBack();
}

function _getLikedTracksForPlayer() {
  const cards = $$('#likedSongsTracks .card');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}

// ── Get current library playlist context (for recommendations) ──
export function getCurrentLibPlaylist() {
  if (!currentLibPlaylistId || !currentLibPlaylistTracks.length) return null;
  return { id: currentLibPlaylistId, tracks: currentLibPlaylistTracks };
}

// ── Init ──
export function init() {
  // Library sub-tab strip (Downloaded / Spotify / Podcasts / Favorites)
  $$('#libraryTabs .sp-tab').forEach(tab => {
    tab.addEventListener('click', () => switchLibraryTab(tab.dataset.libTab));
  });

  const backBtn = $('#backToLibrary');
  if (backBtn) backBtn.addEventListener('click', () => closeLibraryDetail());

  // ── Liked Songs tile / view ──
  const likedTile = $('#likedSongsTile');
  if (likedTile) likedTile.addEventListener('click', () => openLikedSongs());
  const likedBack = $('#backToLibraryFromLiked');
  if (likedBack) likedBack.addEventListener('click', () => closeLikedSongs());
  // Keep the open Liked Songs view in sync — unliking a row removes it and
  // updates the count instead of leaving a stale ghost row.
  window.addEventListener('likeschange', () => _rerenderLikedSongs());

  const playLiked = $('#playLikedSongs');
  if (playLiked) playLiked.addEventListener('click', () => {
    const tracks = _getLikedTracksForPlayer();
    if (tracks.length) import('./upnext.js').then(m => m.playTracks(tracks));
  });
  const shuffleLiked = $('#shuffleLikedSongs');
  if (shuffleLiked) shuffleLiked.addEventListener('click', () => {
    const tracks = _getLikedTracksForPlayer();
    if (!tracks.length) return;
    const shuffled = tracks.slice().sort(() => Math.random() - 0.5);
    import('./upnext.js').then(m => m.playTracks(shuffled));
  });

  // Play All
  const playBtn = $('#playLibPlaylist');
  if (playBtn) playBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      import('./upnext.js').then(m => m.playTracks(tracks));
    }
  });

  // Queue All
  const queueBtn = $('#queueLibPlaylist');
  if (queueBtn) queueBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      getPlayerModule().then(m => m.addToQueue(tracks));
    }
  });

  // Delete Playlist
  const delBtn = $('#deleteLibPlaylist');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const id = currentLibPlaylistId;
    const name = currentLibPlaylistName;
    const ok = await showConfirmModal('Delete playlist?', `"${name}" will be deleted.`, { okLabel: 'Delete' });
    if (!ok) return;
    // Leave the detail view and optimistically drop the card; DELETE fires after
    // the undo window (undo re-loads the library from the server).
    closeLibraryDetail();
    if (Array.isArray(libraryCache)) {
      libraryCache = libraryCache.filter(p => p.id !== id);
      const grid = $('#libraryGrid');
      if (grid) renderLibraryGrid(libraryCache, grid);
    } else {
      loadLibrary();
    }
    _schedulePlaylistDelete(id, name, () => { libraryCache = null; loadLibrary(); });
  });

  // Edit Playlist details (name + description)
  const renameBtn = $('#renameLibPlaylist');
  if (renameBtn) renameBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const result = await showPlaylistFormModal({
      title: 'Edit playlist',
      name: currentLibPlaylistName,
      description: currentLibPlaylistDesc,
      okLabel: 'Save',
    });
    if (!result) return;
    if (result.name === currentLibPlaylistName && result.description === currentLibPlaylistDesc) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/details`, {
        method: 'PUT',
        body: { name: result.name, description: result.description },
      });
      if (store.playlistMode && store.playlistMode.id === currentLibPlaylistId) {
        store.playlistMode.name = result.name;
      }
      libraryCache = null;
      loadLibraryDetail(currentLibPlaylistId);
      loadLibrary();
      showToast('Playlist updated');
    } catch (e) {
      showToast('Failed to update');
    }
  });

  // Change / remove cover
  const coverBtn = $('#coverLibPlaylist');
  if (coverBtn) coverBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const url = await showInputModal('Change cover', '', { okLabel: 'Set cover', placeholder: 'Paste an image URL' });
    if (!url) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/cover`, {
        method: 'POST',
        body: { image_url: url },
      });
      libraryCache = null;
      loadLibraryDetail(currentLibPlaylistId);
      loadLibrary();
      showToast('Cover updated');
    } catch (e) {
      showToast('Failed to set cover');
    }
  });

  // Duplicate Playlist
  const dupBtn = $('#duplicateLibPlaylist');
  if (dupBtn) dupBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const name = await showInputModal('Duplicate playlist as', currentLibPlaylistName + ' (copy)', { okLabel: 'Duplicate' });
    if (!name) return;
    try {
      // Create new playlist — the endpoint returns the new id directly (no racy name-match)
      const created = await apiJson('/api/library/playlist', { method: 'POST', body: { name } });
      let pl = created && created.id ? { id: created.id, name } : null;
      if (!pl) {
        // Fallback for older backends that didn't return an id
        const data = await apiJson('/api/library/playlists');
        pl = (data.playlists || []).find(p => p.name === name);
      }
      if (!pl) throw new Error('Playlist not created');
      // Add all tracks
      const songIds = currentLibPlaylistTracks.map(t => t.id).filter(Boolean);
      if (songIds.length) {
        await apiJson(`/api/library/playlist/${pl.id}/tracks`, {
          method: 'PUT',
          body: { song_ids: songIds },
        });
      }
      libraryCache = null;
      showToast(`Duplicated as "${name}" (${songIds.length} tracks)`);
      loadLibraryDetail(pl.id);
    } catch (e) {
      showToast('Failed to duplicate');
    }
  });

  // Bulk: Select All / None (master toggle)
  const bulkToggle = $('#libBulkToggle');
  if (bulkToggle) bulkToggle.addEventListener('change', () => {
    const cards = $$('#libraryTracks .card');
    if (bulkToggle.checked) {
      // Only select visible cards — BPM-filtered (display:none) tracks excluded,
      // matching Play All / Queue All which act on the visible set.
      cards.forEach((c, i) => { if (c.style.display !== 'none') _selectSet.add(i); });
    } else {
      _selectSet.clear();
    }
    _updateSelectUI(); // syncs card data-selected + checkboxes + bulk bar + toggle state
  });

  // Bulk: Copy to playlist
  const bulkCopy = $('#libBulkCopy');
  if (bulkCopy) bulkCopy.addEventListener('click', async () => {
    if (!_selectSet.size) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const others = (data.playlists || []).filter(p => p.id !== currentLibPlaylistId);
      // Copying to a brand-new playlist is a valid destination — let the picker
      // offer "+ New playlist" instead of dead-ending here.
      const picked = await showPlaylistPicker(others);
      if (!picked || !picked.length) return;
      const songIds = [..._selectSet].map(i => currentLibPlaylistTracks[i]?.id).filter(Boolean);
      for (const pl of picked) {
        await apiJson(`/api/library/playlist/${pl.id}/tracks`, {
          method: 'PUT',
          body: { song_ids: songIds },
        });
      }
      showToast(`Copied ${songIds.length} tracks to ${picked.map(p => p.name).join(', ')}`);
    } catch (e) {
      showToast('Failed to copy');
    }
  });

  // Bulk: Remove from playlist
  const bulkRemove = $('#libBulkRemove');
  if (bulkRemove) bulkRemove.addEventListener('click', async () => {
    if (!_selectSet.size || !currentLibPlaylistId) return;
    const ok = await showConfirmModal('Remove tracks?', `Remove ${_selectSet.size} tracks from playlist?`, { okLabel: 'Remove', danger: false });
    if (!ok) return;
    try {
      // Remove by indices (descending to avoid shift)
      const indices = [..._selectSet].sort((a, b) => b - a);
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/tracks`, {
        method: 'DELETE',
        body: { indices },
      });
      showToast(`Removed ${indices.length} tracks`);
      loadLibraryDetail(currentLibPlaylistId);
    } catch (e) {
      showToast('Failed to remove');
    }
  });

  // Merge Playlists
  const mergeBtn = $('#mergeLibPlaylist');
  if (mergeBtn) mergeBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const others = (data.playlists || []).filter(p => p.id !== currentLibPlaylistId);
      if (!others.length) { showToast('No other playlists'); return; }
      const picked = await showPlaylistPicker(others);
      if (!picked || !picked.length) return;
      let added = 0;
      for (const pl of picked) {
        const plData = await apiJson(`/api/library/playlist/${pl.id}`);
        const songIds = (plData.tracks || []).map(t => t.id).filter(Boolean);
        if (songIds.length) {
          await apiJson(`/api/library/playlist/${currentLibPlaylistId}/tracks`, {
            method: 'PUT',
            body: { song_ids: songIds },
          });
          added += songIds.length;
        }
      }
      showToast(`Merged ${added} tracks from ${picked.length} playlist(s)`);
      loadLibraryDetail(currentLibPlaylistId);
    } catch (e) {
      showToast('Failed to merge');
    }
  });

  // New Playlist
  const newBtn = $('#newLibPlaylist');
  if (newBtn) newBtn.addEventListener('click', async () => {
    const result = await showPlaylistFormModal({ title: 'New playlist', okLabel: 'Create' });
    if (!result) return;
    try {
      const created = await apiJson('/api/library/playlist', { method: 'POST', body: { name: result.name, description: result.description } });
      showToast('Playlist created');
      libraryCache = null;
      if (created && created.id) loadLibraryDetail(created.id);
      else loadLibrary();
    } catch (e) {
      showToast('Failed to create playlist');
    }
  });
}

function getLibTracksForPlayer() {
  // Respect the active BPM filter: hidden cards (display:none) are excluded so
  // Play All / Queue All only act on the currently-visible (filtered) set.
  const cards = $$('#libraryTracks .card').filter(c => c.style.display !== 'none');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}
