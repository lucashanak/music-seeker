// library.js — Navidrome library playlists management

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack } from './utils.js';
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
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load playlist</p></div>`;
  }
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
