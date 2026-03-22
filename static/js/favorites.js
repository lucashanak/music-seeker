// favorites.js — Favorites page, follow/unfollow, loadFavoritedArtistIds, release check

import { store } from './store.js';
import { $, $$, esc, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';

// ── Load Favorited Artist IDs ──
export async function loadFavoritedArtistIds() {
  try {
    const data = await apiJson('/api/favorites');
    store.favoritedArtistIds = new Set((data.artists || []).map(a => a.id));
  } catch {}
}

// ── Toggle Favorite Artist ──
export async function toggleFavoriteArtist(item, btnEl) {
  const isFollowing = store.favoritedArtistIds.has(item.id);
  try {
    if (isFollowing) {
      await apiJson(`/api/favorites/${item.id}`, { method: 'DELETE' });
      store.favoritedArtistIds.delete(item.id);
      if (btnEl) { btnEl.classList.remove('following'); btnEl.innerHTML = '&#x2661;'; btnEl.title = 'Follow'; }
      showToast(`Unfollowed ${item.name}`);
    } else {
      await apiJson('/api/favorites', { method: 'POST', body: { artist_id: item.id, name: item.name, image: item.image || '' } });
      store.favoritedArtistIds.add(item.id);
      if (btnEl) { btnEl.classList.add('following'); btnEl.innerHTML = '&#x2665;'; btnEl.title = 'Unfollow'; }
      showToast(`Following ${item.name}`);
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
  }
}

// ── Load Favorites Page ──
export async function loadFavorites() {
  const grid = $('#favoritesGrid');
  const empty = $('#favoritesEmpty');
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  empty.style.display = 'none';
  try {
    const data = await apiJson('/api/favorites');
    const artists = data.artists || [];
    store.favoritedArtistIds = new Set(artists.map(a => a.id));
    if (!artists.length) {
      grid.innerHTML = '';
      empty.style.display = '';
      return;
    }
    grid.innerHTML = artists.map(a => `
      <div class="card fav-card" data-artist-id="${a.id}" data-item='${JSON.stringify({id: a.id, name: a.name, artist: a.name, image: a.image, type: "artist"}).replace(/'/g, "&#39;")}'>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy" style="border-radius:50%;" onerror="this.style.background='var(--bg-elevated)'">
        ${a.new_release ? '<div class="fav-new-badge">NEW</div>' : ''}
        ${a.auto_download ? '<div class="fav-auto-dl-badge" title="Auto-download enabled">&#x21E9; Auto</div>' : ''}
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${a.new_release ? esc(a.new_release.name) : (a.last_album_name ? esc(a.last_album_name) : '')}</div>
        </div>
      </div>
    `).join('');
    $$('.fav-card', grid).forEach(card => {
      card.addEventListener('click', () => {
        const artistId = card.dataset.artistId;
        const artist = artists.find(a => a.id === artistId);
        if (artist) openFavoriteModal(artist);
      });
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><p>Failed to load favorites: ${e.message}</p></div>`;
  }
}

export function openFavoriteModal(artist) {
  openModal({
    id: artist.id,
    name: artist.name,
    artist: artist.name,
    image: artist.image,
    type: 'artist',
    _autoDownload: artist.auto_download,
    _isFavorite: true,
  });
}

// ── Init ──
export function init() {
  // Check new releases button
  $('#checkReleasesBtn').addEventListener('click', async () => {
    const btn = $('#checkReleasesBtn');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    try {
      const data = await apiJson('/api/favorites/check', { method: 'POST' });
      showToast(data.new_count ? `Found ${data.new_count} new release(s)!` : 'No new releases');
      loadFavorites();
    } catch (e) {
      showToast('Check failed: ' + e.message);
    } finally {
      btn.textContent = 'Check Now';
      btn.disabled = false;
    }
  });
}
