// library.js — Navidrome library playlists management

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack, showPlaylistPicker } from './utils.js';
import { apiJson } from './api.js';
import { renderResults } from './search.js';

let libraryCache = null;
let currentLibPlaylistId = null;
let currentLibPlaylistName = '';
let currentLibPlaylistTracks = [];

// ── Load Playlists ──
export async function loadLibrary() {
  const grid = $('#libraryGrid');
  if (!grid) return;
  $('#libraryDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
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
    grid.innerHTML = '<div class="empty-state"><p>No playlists in Navidrome yet</p></div>';
    return;
  }
  grid.innerHTML = playlists.map((pl, i) => `
    <div class="card lib-card" data-lib-idx="${i}">
      ${pl.image ? `<img class="card-img" src="${pl.image}" alt="" loading="lazy">` : `<div class="card-img" style="background:linear-gradient(135deg,var(--accent),#1a1a2e);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--text);">&#9835;</div>`}
      <div class="card-body">
        <div class="card-title">${esc(pl.name)}</div>
        <div class="card-sub">${pl.songCount} tracks</div>
      </div>
    </div>`).join('');

  $$('.lib-card', grid).forEach(card => {
    card.addEventListener('click', () => {
      const pl = playlists[card.dataset.libIdx];
      if (pl) loadLibraryDetail(pl.id);
    });
  });
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
    $('#libDetailName').textContent = data.name || '';
    $('#libDetailImg').src = data.image || '';
    if (!data.image) {
      $('#libDetailImg').style.background = 'linear-gradient(135deg,var(--accent),#1a1a2e)';
    } else {
      $('#libDetailImg').style.background = '';
    }
    $('#libDetailCount').textContent = `${currentLibPlaylistTracks.length} tracks`;
    renderResults(currentLibPlaylistTracks, '#libraryTracks');
    _addBulkCheckboxes();
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load playlist</p></div>`;
  }
}

// ── Bulk select ──
let _bulkSelected = new Set();

function _addBulkCheckboxes() {
  _bulkSelected.clear();
  _updateBulkUI();
  const toggle = $('#libBulkToggle');
  if (toggle) toggle.checked = false;
  $$('#libraryTracks .card').forEach((card, i) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lib-bulk-cb';
    cb.style.cssText = 'position:absolute;top:8px;left:8px;width:18px;height:18px;accent-color:var(--accent);z-index:2;cursor:pointer;';
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      if (cb.checked) _bulkSelected.add(i); else _bulkSelected.delete(i);
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
  if (actions) actions.style.display = _bulkSelected.size > 0 ? 'flex' : 'none';
  if (count) count.textContent = `${_bulkSelected.size} selected`;
}

export function closeLibraryDetail(fromPopstate) {
  $('#libraryDetail').style.display = 'none';
  $('#libraryList').style.display = '';
  currentLibPlaylistId = null;
  if (!fromPopstate) historyBack();
}

// ── Get current library playlist context (for recommendations) ──
export function getCurrentLibPlaylist() {
  if (!currentLibPlaylistId || !currentLibPlaylistTracks.length) return null;
  return { id: currentLibPlaylistId, tracks: currentLibPlaylistTracks };
}

// ── Init ──
export function init() {
  const backBtn = $('#backToLibrary');
  if (backBtn) backBtn.addEventListener('click', () => closeLibraryDetail());

  // Play All
  const playBtn = $('#playLibPlaylist');
  if (playBtn) playBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      import('./player.js').then(m => {
        store.playerQueue = tracks;
        store.playerIndex = 0;
        m.loadAndPlay();
      });
    }
  });

  // Queue All
  const queueBtn = $('#queueLibPlaylist');
  if (queueBtn) queueBtn.addEventListener('click', () => {
    const tracks = getLibTracksForPlayer();
    if (tracks.length) {
      store.playlistMode = currentLibPlaylistId ? { id: currentLibPlaylistId, name: currentLibPlaylistName } : null;
      import('./player.js').then(m => m.addToQueue(tracks));
    }
  });

  // Delete Playlist
  const delBtn = $('#deleteLibPlaylist');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    if (!confirm('Delete this playlist from Navidrome?')) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}`, { method: 'DELETE' });
      showToast('Playlist deleted');
      libraryCache = null;
      closeLibraryDetail();
      loadLibrary();
    } catch (e) {
      showToast('Failed to delete playlist');
    }
  });

  // Rename Playlist
  const renameBtn = $('#renameLibPlaylist');
  if (renameBtn) renameBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId) return;
    const name = prompt('Rename playlist:', currentLibPlaylistName);
    if (!name || !name.trim() || name.trim() === currentLibPlaylistName) return;
    try {
      await apiJson(`/api/library/playlist/${currentLibPlaylistId}/rename`, {
        method: 'PUT',
        body: { name: name.trim() },
      });
      currentLibPlaylistName = name.trim();
      $('#libDetailName').textContent = name.trim();
      if (store.playlistMode && store.playlistMode.id === currentLibPlaylistId) {
        store.playlistMode.name = name.trim();
      }
      libraryCache = null;
      showToast('Playlist renamed');
    } catch (e) {
      showToast('Failed to rename');
    }
  });

  // Duplicate Playlist
  const dupBtn = $('#duplicateLibPlaylist');
  if (dupBtn) dupBtn.addEventListener('click', async () => {
    if (!currentLibPlaylistId || !currentLibPlaylistTracks.length) return;
    const name = prompt('Duplicate as:', currentLibPlaylistName + ' (copy)');
    if (!name || !name.trim()) return;
    try {
      // Create new playlist
      await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      // Find new playlist ID
      const data = await apiJson('/api/library/playlists');
      const pl = (data.playlists || []).find(p => p.name === name.trim());
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
      showToast(`Duplicated as "${name.trim()}" (${songIds.length} tracks)`);
    } catch (e) {
      showToast('Failed to duplicate');
    }
  });

  // Bulk: Select All
  const bulkToggle = $('#libBulkToggle');
  if (bulkToggle) bulkToggle.addEventListener('change', () => {
    const cbs = $$('#libraryTracks .lib-bulk-cb');
    cbs.forEach((cb, i) => {
      cb.checked = bulkToggle.checked;
      if (bulkToggle.checked) _bulkSelected.add(i); else _bulkSelected.delete(i);
    });
    _updateBulkUI();
  });

  // Bulk: Copy to playlist
  const bulkCopy = $('#libBulkCopy');
  if (bulkCopy) bulkCopy.addEventListener('click', async () => {
    if (!_bulkSelected.size) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const others = (data.playlists || []).filter(p => p.id !== currentLibPlaylistId);
      if (!others.length) { showToast('No other playlists'); return; }
      const picked = await showPlaylistPicker(others);
      if (!picked || !picked.length) return;
      const songIds = [..._bulkSelected].map(i => currentLibPlaylistTracks[i]?.id).filter(Boolean);
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
    if (!_bulkSelected.size || !currentLibPlaylistId) return;
    if (!confirm(`Remove ${_bulkSelected.size} tracks from playlist?`)) return;
    try {
      // Remove by indices (descending to avoid shift)
      const indices = [..._bulkSelected].sort((a, b) => b - a);
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
    const name = prompt('New playlist name:');
    if (!name || !name.trim()) return;
    try {
      await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      showToast('Playlist created');
      libraryCache = null;
      loadLibrary();
    } catch (e) {
      showToast('Failed to create playlist');
    }
  });
}

function getLibTracksForPlayer() {
  const cards = $$('#libraryTracks .card');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}
