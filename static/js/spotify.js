// spotify.js — Spotify library tabs, playlist/artist/show detail, spCache

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderResults, checkLibrary } from './search.js';
import { switchPage } from './router.js';

// ── Tab Switching ──
function loadSpTab(tab) {
  const gridMap = { playlists: '#playlistsGrid', albums: '#spAlbumsGrid', artists: '#spArtistsGrid', podcasts: '#spPodcastsGrid' };
  const grid = $(gridMap[tab]);
  if (!grid) return;

  if (store.spCache[tab]) { renderSpGrid(tab, store.spCache[tab], grid); return; }

  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  (async () => {
    try {
      if (tab === 'playlists') {
        const data = await apiJson('/api/spotify/playlists');
        store.spCache.playlists = data.playlists;
        renderSpGrid('playlists', data.playlists, grid);
      } else if (tab === 'albums') {
        const data = await apiJson('/api/spotify/albums');
        store.spCache.albums = data.albums;
        renderSpGrid('albums', data.albums, grid);
      } else if (tab === 'artists') {
        const data = await apiJson('/api/spotify/artists');
        store.spCache.artists = data.artists;
        renderSpGrid('artists', data.artists, grid);
      } else if (tab === 'podcasts') {
        const data = await apiJson('/api/spotify/shows');
        store.spCache.podcasts = data.shows;
        renderSpGrid('podcasts', data.shows, grid);
      }
    } catch (e) {
      grid.innerHTML = `<div class="empty-state"><p>Failed to load ${tab}</p></div>`;
    }
  })();
}

function renderSpGrid(tab, items, grid) {
  if (tab === 'playlists') {
    const likedCard = `
      <div class="card sp-card" data-playlist-id="liked" data-playlist-url="" data-sp-type="playlist">
        <div class="card-img" style="background:linear-gradient(135deg,#604be8,#1db954);display:flex;align-items:center;justify-content:center;font-size:32px;">&#9829;</div>
        <div class="card-body">
          <div class="card-title">Liked Songs</div>
          <div class="card-sub">Your saved tracks</div>
        </div>
      </div>`;
    grid.innerHTML = likedCard + items.map(pl => `
      <div class="card sp-card" data-playlist-id="${pl.id}" data-playlist-url="${pl.url}" data-sp-type="playlist">
        <img class="card-img" src="${pl.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(pl.name)}</div>
          <div class="card-sub">${pl.tracks_total} tracks</div>
        </div>
      </div>`).join('');
  } else if (tab === 'albums') {
    grid.innerHTML = items.map(a => `
      <div class="card sp-card" data-sp-type="album" data-item='${JSON.stringify({id:a.id,name:a.name,artist:a.artist,image:a.image,url:a.url,type:"album"}).replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${esc(a.artist)} &middot; ${a.total_tracks} tracks</div>
        </div>
      </div>`).join('') || '<div class="empty-state"><p>No saved albums</p></div>';
  } else if (tab === 'artists') {
    grid.innerHTML = items.map(a => `
      <div class="card sp-card" data-sp-type="artist" data-item='${JSON.stringify({id:a.id,name:a.name,artist:a.name,image:a.image,url:a.url,type:"artist"}).replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy" style="border-radius:50%;">
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${a.genres ? esc(a.genres.join(', ')) : 'Artist'}</div>
        </div>
      </div>`).join('') || '<div class="empty-state"><p>No followed artists</p></div>';
  } else if (tab === 'podcasts') {
    grid.innerHTML = items.map(s => `
      <div class="card sp-card" data-sp-type="show" data-show-id="${s.id}" data-item='${JSON.stringify({id:s.id,name:s.name,artist:s.artist,image:s.image,url:s.url,type:"show"}).replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${s.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(s.name)}</div>
          <div class="card-sub">${esc(s.artist || '')} &middot; ${s.total_episodes || 0} episodes</div>
        </div>
      </div>`).join('') || '<div class="empty-state"><p>No saved podcasts</p></div>';
  }

  // Attach click handlers
  $$('.sp-card', grid).forEach(card => {
    card.addEventListener('click', () => {
      const type = card.dataset.spType;
      if (type === 'playlist') {
        loadPlaylistDetail(card.dataset.playlistId, card.dataset.playlistUrl);
      } else if (type === 'album') {
        const item = JSON.parse(card.dataset.item);
        openModal(item);
      } else if (type === 'artist') {
        const item = JSON.parse(card.dataset.item);
        searchForArtistDetail(item);
      } else if (type === 'show') {
        const item = JSON.parse(card.dataset.item);
        loadShowDetail(item.id, item.url || '', 'playlists');
      }
    });
  });
}

async function searchForArtistDetail(item) {
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(item.name)}&type=artist`);
    const match = (data.results || []).find(r => r.name.toLowerCase() === item.name.toLowerCase()) || (data.results || [])[0];
    if (match && match.id) {
      switchPage('search', true);
      loadArtistDetail(match.id, 'playlists');
    } else {
      showToast('Artist not found on Deezer');
    }
  } catch {
    showToast('Failed to find artist');
  }
}

// ── Load Playlists ──
export function loadPlaylists() {
  $('#playlistDetail').style.display = 'none';
  $('#spotifyLibrary').style.display = '';
  if (!store.spotifyUser) {
    $('#playlistsGrid').innerHTML = `<div class="empty-state" style="opacity:.5;"><p>Spotify user token not configured.<br>Set SPOTIFY_REFRESH_TOKEN to access playlists and liked songs.</p></div>`;
    return;
  }
  loadSpTab(store.activeSpTab);
}

// ── Playlist Detail ──
export async function loadPlaylistDetail(id, url, fromPage) {
  store.currentPlaylistId = id;
  store.currentPlaylistUrl = url;
  store.playlistDetailSource = fromPage || null;
  if (fromPage) {
    store.currentPage = 'playlists';
    $('#pageSearch').style.display = 'none';
    $('#pageDiscover').style.display = 'none';
    $('#pagePlaylists').style.display = '';
    $('#pageFavorites').style.display = 'none';
    $('#pageSettings').style.display = 'none';
  }
  $('#spotifyLibrary').style.display = 'none';
  $('#playlistDetail').style.display = '';
  history.pushState({ layer: 'playlistDetail' }, '');
  const tracksEl = $('#playlistTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = id === 'liked'
      ? await apiJson('/api/spotify/liked')
      : await apiJson(`/api/spotify/playlist/${id}/tracks`);
    store.currentPlaylistTracks = data.tracks.map(t => ({ name: t.name, artist: t.artist, album: t.album || '', image: t.image || '', url: t.url }));
    if (id === 'liked') {
      $('#plDetailImg').style.background = 'linear-gradient(135deg,#604be8,#1db954)';
      $('#plDetailImg').src = '';
    } else {
      $('#plDetailImg').style.background = '';
      $('#plDetailImg').src = data.image || '';
    }
    $('#plDetailName').textContent = data.name;
    $('#plDetailCount').textContent = `${data.tracks.length} tracks`;
    renderResults(data.tracks, '#playlistTracks');
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load tracks</p></div>`;
  }
}

export function closePlaylistDetail(fromPopstate) {
  $('#playlistDetail').style.display = 'none';
  $('#spotifyLibrary').style.display = '';
  const src = store.playlistDetailSource;
  store.playlistDetailSource = null;
  if (src) {
    switchPage(src, true);
  }
  if (!fromPopstate) historyBack();
}

// ── Show (Podcast) Detail ──
export async function loadShowDetail(id, url, fromPage, feedUrl) {
  store.showDetailSource = fromPage || null;
  store.currentShowSpotifyId = id;
  store.currentShowFeedUrl = feedUrl || '';
  $('#searchResults').style.display = 'none';
  $('#searchLoadMore').style.display = 'none';
  $('#showDetail').style.display = '';
  history.pushState({ layer: 'showDetail' }, '');
  const episodesEl = $('#showEpisodes');
  episodesEl.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  const subBtn = $('#subscribeShow');
  subBtn.textContent = 'Subscribe';
  subBtn.disabled = false;
  subBtn.style.opacity = '1';
  try {
    const data = await apiJson(`/api/spotify/show/${id}/episodes`);
    if (data.feed_url) store.currentShowFeedUrl = data.feed_url;
    store.currentShowEpisodes = data.episodes.map(e => ({ name: e.name, artist: e.artist, album: e.artist, image: e.image || '', url: e.url, type: 'episode' }));
    $('#showDetailImg').src = data.image || '';
    $('#showDetailName').textContent = data.name;
    $('#showDetailPublisher').textContent = data.publisher || '';
    $('#showDetailCount').textContent = `${data.episodes.length} episodes`;
    renderResults(data.episodes, '#showEpisodes');
    // Check if already subscribed
    try {
      const subsData = await apiJson('/api/podcasts/subs');
      if (subsData.subs.some(s => s.spotify_id === id)) {
        subBtn.textContent = 'Subscribed';
        subBtn.disabled = true;
        subBtn.style.opacity = '0.5';
      }
    } catch {}
  } catch (e) {
    episodesEl.innerHTML = `<div class="empty-state"><p>Failed to load episodes: ${e.message}</p></div>`;
  }
}

export function closeShowDetail(fromPopstate) {
  $('#showDetail').style.display = 'none';
  $('#searchResults').style.display = '';
  const src = store.showDetailSource;
  store.showDetailSource = null;
  if (src) switchPage(src, true);
  if (!fromPopstate) historyBack();
}

// ── Artist Detail ──
export async function loadArtistDetail(id, fromPage) {
  store.artistDetailSource = fromPage || null;
  store.currentArtistId = id;
  $('#searchResults').style.display = 'none';
  $('#searchLoadMore').style.display = 'none';
  $('#artistDetail').style.display = '';
  history.pushState({ layer: 'artistDetail' }, '');
  const albumsEl = $('#artistAlbums');
  albumsEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson(`/api/artist/${id}/albums`);
    store.currentArtistAlbums = data.albums || [];
    $('#artistDetailImg').src = data.image || '';
    $('#artistDetailName').textContent = data.name;
    $('#artistDetailCount').textContent = `${store.currentArtistAlbums.length} albums`;
    albumsEl.innerHTML = store.currentArtistAlbums.map((a, i) => `
      <div class="card" data-album-idx="${i}">
        <button class="card-dl-btn" title="Download"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${a.total_tracks || ''} tracks${a.release_date ? ' · ' + a.release_date.slice(0, 4) : ''}</div>
        </div>
      </div>
    `).join('');
    $$('.card', albumsEl).forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-dl-btn')) return;
        const album = store.currentArtistAlbums[card.dataset.albumIdx];
        if (album) openModal(album);
      });
    });
    $$('.card-dl-btn', albumsEl).forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const card = btn.closest('.card');
        const album = store.currentArtistAlbums[card.dataset.albumIdx];
        if (album) { openModal(album); if (!album.inLibrary) setTimeout(() => $('#modalDownload').click(), 100); }
      });
    });
    // Check library status for albums
    checkLibrary(store.currentArtistAlbums.map(a => ({ name: a.name, artist: data.name, type: 'album' })), albumsEl);
    // Update follow button state
    updateFollowButton(id);
  } catch (e) {
    albumsEl.innerHTML = `<div class="empty-state"><p>Failed to load albums: ${e.message}</p></div>`;
  }
}

function updateFollowButton(id) {
  const btn = $('#followArtist');
  if (!btn) return;
  if (store.favoritedArtistIds.has(id)) {
    btn.innerHTML = '&#x2665; Following';
    btn.style.color = '#ef4444';
  } else {
    btn.innerHTML = '&#x2661; Follow';
    btn.style.color = '';
  }
}

export function closeArtistDetail(fromPopstate) {
  $('#artistDetail').style.display = 'none';
  $('#searchResults').style.display = '';
  $('#searchLoadMore').style.display = '';
  const src = store.artistDetailSource;
  store.artistDetailSource = null;
  if (src) switchPage(src, true);
  if (!fromPopstate) historyBack();
}

// ── Init ──
export function init() {
  // Tab switching
  $$('.sp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.spTab === store.activeSpTab) return;
      $$('.sp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      store.activeSpTab = tab.dataset.spTab;
      $$('.sp-section').forEach(s => s.style.display = 'none');
      $(`#sp${store.activeSpTab.charAt(0).toUpperCase() + store.activeSpTab.slice(1)}`).style.display = '';
      loadSpTab(store.activeSpTab);
    });
  });

  $('#backToPlaylists').addEventListener('click', () => closePlaylistDetail());

  $('#downloadPlaylist').addEventListener('click', () => {
    if (!store.currentPlaylistId) return;
    openModal({
      name: $('#plDetailName').textContent,
      artist: 'Playlist',
      image: store.currentPlaylistId === 'liked' ? '' : $('#plDetailImg').src,
      url: store.currentPlaylistId === 'liked' ? '' : `https://open.spotify.com/playlist/${store.currentPlaylistId}`,
      type: 'playlist',
    });
  });

  $('#backToSearch').addEventListener('click', () => closeShowDetail());

  $('#downloadShow').addEventListener('click', () => {
    if (!store.currentShowEpisodes.length) return;
    openModal({
      name: $('#showDetailName').textContent,
      artist: $('#showDetailPublisher').textContent || 'Podcast',
      image: $('#showDetailImg').src,
      url: '',
      type: 'show',
    });
  });

  $('#subscribeShow').addEventListener('click', async () => {
    const btn = $('#subscribeShow');
    if (btn.disabled) return;
    try {
      await apiJson('/api/podcasts/subs', { method: 'POST', body: {
        show_name: $('#showDetailName').textContent,
        spotify_id: store.currentShowSpotifyId,
        image: $('#showDetailImg').src || '',
        feed_url: store.currentShowFeedUrl,
      }});
      btn.textContent = 'Subscribed';
      btn.disabled = true;
      btn.style.opacity = '0.5';
    } catch (e) { alert('Failed: ' + e.message); }
  });

  $('#backFromArtist').addEventListener('click', () => closeArtistDetail());

  // Note: #followArtist and #radioArtist buttons are created by radio.js init()
  // and their click handlers are attached there.

  $('#downloadArtist').addEventListener('click', async () => {
    if (!store.currentArtistAlbums.length) return;
    const btn = $('#downloadArtist');
    btn.disabled = true; btn.textContent = 'Starting...';
    try {
      for (const album of store.currentArtistAlbums) {
        const tracks = [];
        try {
          const data = await apiJson(`/api/album/${album.id}/tracks`);
          (data.tracks || []).forEach(t => tracks.push({ name: t.name, artist: t.artist, album: t.album || album.name, image: t.image || album.image || '', url: t.url || '' }));
        } catch {}
        await apiJson('/api/download', { method: 'POST', body: {
          url: album.url || `https://www.deezer.com/album/${album.id}`,
          title: `${album.artist || $('#artistDetailName').textContent} - ${album.name}`,
          method: store.appSettings.default_method || 'yt-dlp',
          format: store.appSettings.default_format || 'flac',
          type: 'album',
          playlist_tracks: tracks,
        }});
      }
      showToast(`Queued ${store.currentArtistAlbums.length} albums for download`);
      import('./downloads.js').then(m => m.openPanel());
    } catch (e) {
      alert('Download failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Download All Albums';
    }
  });

  // Playlist play/queue all
  $('#playPlaylist').addEventListener('click', () => {
    const tracks = getPlaylistTracksForPlayer();
    if (tracks.length) {
      import('./player.js').then(m => {
        store.playerQueue = tracks;
        store.playerIndex = 0;
        m.loadAndPlay();
      });
    }
  });
  $('#queuePlaylist').addEventListener('click', () => {
    const tracks = getPlaylistTracksForPlayer();
    if (tracks.length) {
      import('./player.js').then(m => m.addToQueue(tracks));
    }
  });
}

function getPlaylistTracksForPlayer() {
  const cards = $$('#playlistTracks .card');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}
