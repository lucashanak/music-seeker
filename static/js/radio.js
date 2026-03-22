// radio.js — startRadio, radio auto-continue

import { store } from './store.js';
import { $, showToast } from './utils.js';
import { apiJson } from './api.js';
import { loadAndPlay } from './player.js';
import { toggleFavoriteArtist } from './favorites.js';

// ── Start Radio ──
export async function startRadio(item) {
  const params = new URLSearchParams({
    track: item.name || '',
    artist: item.artist || '',
    artist_id: item.id || store.currentArtistId || '',
  });
  showToast('Starting radio...');
  try {
    const data = await apiJson(`/api/radio?${params}`);
    const tracks = data.tracks || [];
    if (!tracks.length) { showToast('No radio tracks found'); return; }
    store.playerQueue = tracks;
    store.playerIndex = 0;
    store.radioMode = true;
    store.radioSeedTrack = item;
    store.radioLoading = false;
    loadAndPlay();
    showToast(`Playing radio based on ${item.artist || item.name}`);
  } catch (e) {
    showToast('Radio failed: ' + e.message);
  }
}

// ── Init ──
export function init() {
  // Radio button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-radio-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    startRadio(item);
  });

  // Favorite button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-fav-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    if (item.type !== 'artist' || !item.id) return;
    await toggleFavoriteArtist(item, btn);
  });

  // Artist detail: radio + follow buttons
  $('#downloadArtist').insertAdjacentHTML('afterend', `
    <button class="btn-download" id="radioArtist" style="width:auto; padding:12px 28px; background:var(--bg-elevated); color:var(--text); border:1px solid var(--border);">&#x1f4fb; Radio</button>
    <button class="btn-download" id="followArtist" style="width:auto; padding:12px 28px; background:var(--bg-elevated); color:var(--text); border:1px solid var(--border);">&#x2661; Follow</button>
  `);

  $('#radioArtist').addEventListener('click', () => {
    const name = $('#artistDetailName').textContent;
    const img = $('#artistDetailImg').src;
    startRadio({ name, artist: name, image: img, id: store.currentArtistId, type: 'artist' });
  });

  $('#followArtist').addEventListener('click', async () => {
    const name = $('#artistDetailName').textContent;
    const img = $('#artistDetailImg').src;
    const btn = $('#followArtist');
    const isFollowing = store.favoritedArtistIds.has(store.currentArtistId);
    if (isFollowing) {
      await apiJson(`/api/favorites/${store.currentArtistId}`, { method: 'DELETE' });
      store.favoritedArtistIds.delete(store.currentArtistId);
      btn.innerHTML = '&#x2661; Follow';
      btn.style.color = '';
      showToast(`Unfollowed ${name}`);
    } else {
      await apiJson('/api/favorites', { method: 'POST', body: { artist_id: store.currentArtistId, name, image: img } });
      store.favoritedArtistIds.add(store.currentArtistId);
      btn.innerHTML = '&#x2665; Following';
      btn.style.color = '#ef4444';
      showToast(`Following ${name}`);
    }
  });
}
