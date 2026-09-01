// spotify.js — Spotify library tabs, playlist/artist/show detail, spCache

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderResults, renderSongRows, checkLibrary } from './search.js';
import { switchPage } from './router.js';
import { attachContextMenu, wasLongPress, makeKebabButton, addTracksToNavidromePlaylist } from './contextmenu.js';
import { getPlayerModule } from './player_active.js';
import { hydrateBpmByName, addBpmBadges, initTempoFilter } from './bpm.js';

// Bulk-hydrate cached BPM for a freshly-rendered track list, then add badges and
// mount the (feasibility-aware) tempo filter. Owned-only: unowned tracks get no
// BPM and the filter disables itself when coverage is too low. allowAnalyze=false
// since on-demand analysis of unowned Spotify tracks mostly 404s.
async function _mountTempoFilter(tracks, containerSel) {
  try {
    await hydrateBpmByName(tracks);
    addBpmBadges(containerSel);
    const filter = initTempoFilter(containerSel, { allowAnalyze: false });
    if (filter && filter._refreshCoverage) filter._refreshCoverage();
  } catch {}
}

// ── Tab Switching ──
function loadSpTab(tab) {
  const gridMap = { playlists: '#playlistsGrid', albums: '#spAlbumsGrid', artists: '#spArtistsGrid', podcasts: '#spPodcastsGrid' };
  const grid = $(gridMap[tab]);
  if (!grid) return;

  if (store.spCache[tab]) { renderSpGrid(tab, store.spCache[tab], grid); return; }

  grid.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
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
      <div class="card sp-card" data-playlist-id="liked" data-playlist-url="" data-sp-type="playlist" data-item='${JSON.stringify({id:"liked",name:"Liked Songs",image:"",url:"",type:"playlist",provider:"spotify"}).replace(/&/g,"&amp;").replace(/'/g,"&#39;")}'>
        <div class="card-img" style="background:linear-gradient(135deg,#604be8,#1db954);display:flex;align-items:center;justify-content:center;font-size:32px;">&#9829;</div>
        <div class="card-body">
          <div class="card-title">Liked Songs</div>
          <div class="card-sub">Your saved tracks</div>
        </div>
      </div>`;
    grid.innerHTML = likedCard + items.map(pl => `
      <div class="card sp-card" data-playlist-id="${pl.id}" data-playlist-url="${pl.url}" data-sp-type="playlist" data-item='${JSON.stringify({id:pl.id,name:pl.name,image:pl.image||"",url:pl.url||"",type:"playlist",provider:"spotify"}).replace(/&/g,"&amp;").replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${pl.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(pl.name)}</div>
          <div class="card-sub">${pl.tracks_total} tracks</div>
        </div>
      </div>`).join('');
  } else if (tab === 'albums') {
    grid.innerHTML = items.map(a => `
      <div class="card sp-card" data-sp-type="album" data-item='${JSON.stringify({id:a.id,name:a.name,artist:a.artist,image:a.image,url:a.url,type:"album",provider:"spotify"}).replace(/&/g,"&amp;").replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${esc(a.artist)} &middot; ${a.total_tracks} tracks</div>
        </div>
      </div>`).join('') || '<div class="empty-state"><p>No saved albums</p></div>';
  } else if (tab === 'artists') {
    grid.innerHTML = items.map(a => `
      <div class="card sp-card" data-sp-type="artist" data-item='${JSON.stringify({id:a.id,name:a.name,artist:a.name,image:a.image,url:a.url,type:"artist"}).replace(/&/g,"&amp;").replace(/'/g,"&#39;")}'>
        <img class="card-img" src="${a.image || ''}" alt="" loading="lazy" style="border-radius:50%;">
        <div class="card-body">
          <div class="card-title">${esc(a.name)}</div>
          <div class="card-sub">${a.genres ? esc(a.genres.join(', ')) : 'Artist'}</div>
        </div>
      </div>`).join('') || '<div class="empty-state"><p>No followed artists</p></div>';
  } else if (tab === 'podcasts') {
    grid.innerHTML = items.map(s => `
      <div class="card sp-card" data-sp-type="show" data-show-id="${s.id}" data-item='${JSON.stringify({id:s.id,name:s.name,artist:s.artist,image:s.image,url:s.url,type:"show",provider:"spotify"}).replace(/&/g,"&amp;").replace(/'/g,"&#39;")}'>
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
      // A long-press opened the context menu — don't also navigate.
      if (wasLongPress(card)) return;
      const type = card.dataset.spType;
      if (type === 'playlist') {
        // These come from the user's Spotify library — pin the provider so the
        // OAuth'd Spotify path is used even when the API omitted the url.
        loadPlaylistDetail(card.dataset.playlistId, card.dataset.playlistUrl, undefined, { provider: 'spotify' });
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

  _attachSpCardMenus(grid);
}

// Same context menu (right-click / long-press / ⋯ kebab) as search results, so
// the playlist actions added in contextmenu.js are reachable here too. The items
// carry provider:'spotify' — that's what keeps Open / Play all / Add all to
// queue on the OAuth'd Spotify endpoints instead of the search provider's.
//
// Only playlist and show cards opt in, because every id in this grid is
// Spotify's and the rest of the menu can't honor that namespace yet:
//   • artist — favorites are keyed by the search provider's ids (the follow
//     endpoint hardcodes that provider), so a Follow from here would store an
//     entry whose release-checks can never resolve. This is also why the card's
//     own click resolves the artist by name first, see searchForArtistDetail().
//   • album — no endpoint serves Spotify album tracks: search_providers'
//     get_album_tracks falls through to Deezer for provider=spotify, so
//     "Play all"/"Add all to queue" would silently load the wrong album.
// Both need backend work before they can be enabled; the card click already
// opens the download modal for albums, which is that menu's only working extra.
const SP_MENU_SELECTOR = '.sp-card[data-item][data-sp-type="playlist"], .sp-card[data-item][data-sp-type="show"]';

function _attachSpCardMenus(grid) {
  const _info = (targetEl) => {
    try {
      const item = JSON.parse(targetEl.dataset.item);
      const type = item.type || 'playlist';
      // Mirror the source each card click already passes, since the two detail
      // views live on different pages: #playlistDetail is inside this page
      // (null → closing stays put) while #showDetail is inside #pageSearch, so
      // it needs a source to navigate back to the Library.
      const detailSource = type === 'show' ? 'playlists' : null;
      return { item, type, context: { inLibrary: !!item.inLibrary, detailSource } };
    } catch { return null; }
  };
  // attachContextMenu no-ops after the first call per element; the grid element
  // survives re-renders and getItem re-reads data-item from the DOM, so a single
  // delegated listener stays correct across tab switches.
  attachContextMenu(grid, { selector: SP_MENU_SELECTOR, getItem: _info });
  $$(SP_MENU_SELECTOR, grid).forEach(card => {
    if (card.querySelector('.kebab-btn')) return;
    card.appendChild(makeKebabButton(() => _info(card)));
  });
}

async function searchForArtistDetail(item) {
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(item.name)}&type=artist`);
    const match = (data.results || []).find(r => r.name.toLowerCase() === item.name.toLowerCase()) || (data.results || [])[0];
    if (match && match.id) {
      switchPage('search', true);
      // match came from /api/search, which stamps the serving provider — pass it
      // on, since the fallback provider can differ from the configured one.
      loadArtistDetail(match.id, 'playlists', match.provider);
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

// ── Provider-aware playlist track fetch ──
// Universal search returns playlists from whichever provider is configured
// (Deezer by default), whose ids mean nothing to Spotify — the Spotify-only
// endpoint 500s on them. Resolve the provider from the item's url so Spotify
// playlists (the user's own OAuth'd library) keep the /api/spotify path and
// everything else goes through the provider-aware /api/playlist path.
export function inferPlaylistProvider(url) {
  const u = String(url || '');
  if (!u) return '';
  if (/deezer\.com/i.test(u)) return 'deezer';
  if (/spotify\.com/i.test(u)) return 'spotify';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'ytmusic';
  if (/apple\.com/i.test(u)) return 'itunes';
  return '';
}

// Returns the raw endpoint payload: { tracks: [...], name, image }.
// An unresolved provider is omitted so the backend falls back to the app's
// configured search provider.
export async function fetchPlaylistTracks(id, url, provider) {
  if (id === 'liked') return apiJson('/api/spotify/liked');
  const prov = provider || inferPlaylistProvider(url);
  if (prov === 'spotify') return apiJson(`/api/spotify/playlist/${encodeURIComponent(id)}/tracks`);
  const qs = prov ? `?provider=${encodeURIComponent(prov)}` : '';
  return apiJson(`/api/playlist/${encodeURIComponent(id)}/tracks${qs}`);
}

// ── Playlist Detail ──
// Reveal #playlistDetail and reset its hero. Shared by loadPlaylistDetail (which
// then fetches the tracks) and showImportedPlaylist (which already has them), so
// page reveal, history layer and back navigation behave identically for both.
function _openPlaylistDetail({ id, url, fromPage, name, image, liked }) {
  store.currentPlaylistId = id;
  store.currentPlaylistUrl = url;
  store.playlistDetailSource = fromPage || null;
  if (fromPage) {
    // The Spotify library is now the Library → Spotify sub-tab. Reveal the
    // Library page + that sub-view (without reloading it) so #playlistDetail,
    // which lives inside #pagePlaylists, becomes visible.
    store.currentPage = 'library';
    $('#pageSearch').style.display = 'none';
    $('#pageDiscover').style.display = 'none';
    $('#pageSettings').style.display = 'none';
    import('./library.js').then(m => m.showLibrarySubView && m.showLibrarySubView('spotify'));
  }
  $('#spotifyLibrary').style.display = 'none';
  $('#playlistDetail').style.display = '';
  history.pushState({ layer: 'playlistDetail' }, '');
  // Paint whatever the caller already knows so the hero isn't blank while loading.
  if (liked) {
    $('#plDetailImg').style.background = 'linear-gradient(135deg,#604be8,#1db954)';
    $('#plDetailImg').src = '';
  } else {
    $('#plDetailImg').style.background = '';
    $('#plDetailImg').src = image || '';
  }
  $('#plDetailName').textContent = name || '';
  $('#plDetailCount').textContent = '';
  const note = $('#plDetailNote');
  if (note) { note.innerHTML = ''; note.style.display = 'none'; }
}

// Publish a track list as "the playlist on screen" and render it. Everything the
// hero buttons act on (Play All / Shuffle / Add All / Add to playlist / Download
// All) reads store.currentPlaylistTracks or the rendered cards, so this is the
// only wiring an imported playlist needs.
function _paintPlaylistTracks(tracks) {
  store.currentPlaylistTracks = tracks.map(t => ({ name: t.name, artist: t.artist, album: t.album || '', image: t.image || '', url: t.url }));
  $('#plDetailCount').textContent = `${tracks.length} tracks`;
  renderResults(tracks, '#playlistTracks');
  _mountTempoFilter(tracks, '#playlistTracks');
}

// Truncation / provenance line under the hero title. `onAction`, when given,
// renders the one-click way out (the paste-track-links import).
function _setPlaylistNote(text, onAction, actionLabel) {
  const el = $('#plDetailNote');
  if (!el || !text) return;
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pl-note-btn';
    btn.textContent = actionLabel || 'Import all tracks…';
    btn.addEventListener('click', onAction);
    el.appendChild(btn);
  }
  el.style.display = '';
}

// `opts` is optional and accepts either a provider string or
// { provider, name, image } — callers that already know those (search cards)
// get an instantly-populated hero; older 3-arg callers still work via url
// inference.
export async function loadPlaylistDetail(id, url, fromPage, opts) {
  const o = typeof opts === 'string' ? { provider: opts } : (opts || {});
  _openPlaylistDetail({ id, url, fromPage, name: o.name, image: o.image, liked: id === 'liked' });
  const tracksEl = $('#playlistTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await fetchPlaylistTracks(id, url, o.provider);
    const tracks = data.tracks || [];
    // Caller-supplied values win; the response fills the gaps.
    if (id !== 'liked' && !o.image && data.image) $('#plDetailImg').src = data.image;
    $('#plDetailName').textContent = o.name || data.name || '';
    _paintPlaylistTracks(tracks);
  } catch (e) {
    store.currentPlaylistTracks = [];
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load tracks: ${esc(e.message || 'unknown error')}</p></div>`;
  }
}

// Paint an already-resolved playlist (a playlist import) into #playlistDetail
// with NO network call. `data` is the /api/import/* payload plus an optional
// `url` (the link it was imported from) and `onImportMore` callback for the
// truncation escape hatch.
//
// The id is synthetic — `import:<source>:<id>` — so nothing mistakes it for a
// real Spotify/Deezer playlist id. Nothing fetches by it: fetchPlaylistTracks()
// is only reached from loadPlaylistDetail(), and the hero buttons all read
// store.currentPlaylistTracks / the rendered cards instead.
export function showImportedPlaylist(data, fromPage) {
  const source = data.source || 'import';
  _openPlaylistDetail({
    id: `import:${source}:${data.id || 'paste'}`,
    // The real source link, so Download All sends something meaningful (it may
    // legitimately be empty for a pasted list of track links).
    url: data.url || '',
    fromPage,
    name: data.name || 'Imported tracks',
    image: data.image || '',
  });
  const tracks = (data.tracks || []).map(t => ({
    name: t.name,
    artist: t.artist || '',
    album: t.album || '',
    image: t.image || '',
    duration_ms: t.duration_ms || 0,
    type: 'track',
  }));
  _paintPlaylistTracks(tracks);
  _setPlaylistNote(data.note, data.onImportMore, data.importMoreLabel);
  return tracks;
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
  episodesEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
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
// Provider-scoped ids again: album/artist ids only mean something to the
// provider that issued them. The configured provider is the backend's default,
// which is wrong whenever the search fallback served the result (e.g. settings
// say deezer but the item came from ytmusic), so pass it through when known.
function _providerQs(provider) {
  return provider ? `?provider=${encodeURIComponent(provider)}` : '';
}

// Remembers which provider the artist currently on screen came from, so the
// album cards built from its response inherit it (that endpoint doesn't stamp a
// provider on each album the way search results do).
let _artistDetailProvider = '';

// `provider` is optional — 2-arg callers still work and fall back to the
// backend's configured-provider default.
export async function loadArtistDetail(id, fromPage, provider) {
  store.artistDetailSource = fromPage || null;
  store.currentArtistId = id;
  _artistDetailProvider = provider || '';
  $('#searchResults').style.display = 'none';
  $('#searchLoadMore').style.display = 'none';
  $('#artistDetail').style.display = '';
  history.pushState({ layer: 'artistDetail' }, '');
  const albumsEl = $('#artistAlbums');
  albumsEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    const data = await apiJson(`/api/artist/${id}/albums${_providerQs(provider)}`);
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
        if (wasLongPress()) return;
        if (e.target.closest('.card-dl-btn')) return;
        const album = store.currentArtistAlbums[card.dataset.albumIdx];
        // Inherit the artist's provider — these albums came from its response.
        if (album && album.id) loadAlbumDetail({ ...album, type: 'album', artist: $('#artistDetailName').textContent, provider: album.provider || _artistDetailProvider }, 'search');
        else if (album) openModal(album);
      });
    });
    attachContextMenu(albumsEl, {
      selector: '.card[data-album-idx]',
      getItem: (targetEl) => {
        const album = store.currentArtistAlbums[parseInt(targetEl.dataset.albumIdx)];
        if (!album) return null;
        // provider: the menu's "Play all"/"Add all to queue" fetch this album's
        // tracks by id, so it needs the provider that issued the id.
        return { item: { ...album, type: 'album', provider: album.provider || _artistDetailProvider }, type: 'album', context: { inLibrary: !!album.inLibrary } };
      },
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
    checkLibrary(store.currentArtistAlbums.map(a => ({ name: a.name, artist: data.name, type: 'album', id: a.id })), albumsEl);
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

// ── Album Detail ──
export async function loadAlbumDetail(album, fromPage) {
  store.albumDetailSource = fromPage || null;
  store.currentAlbum = album;
  // Hide all known siblings; back will restore via switchPage or popstate
  $('#searchResults').style.display = 'none';
  $('#searchLoadMore').style.display = 'none';
  if ($('#artistDetail')) $('#artistDetail').style.display = 'none';
  $('#albumDetail').style.display = '';
  history.pushState({ layer: 'albumDetail' }, '');
  const tracksEl = $('#albumTracks');
  tracksEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  $('#albumDetailImg').src = album.image || '';
  $('#albumDetailName').textContent = album.name || '';
  $('#albumDetailArtist').textContent = album.artist || '';
  $('#albumDetailCount').textContent = '';
  try {
    // album.provider comes from the search result (stamped by the backend) or is
    // inherited from the artist detail; omitted when unknown.
    const data = await apiJson(`/api/album/${album.id}/tracks${_providerQs(album.provider)}`);
    const tracks = (data.tracks || []).map(t => ({
      ...t, type: 'track',
      album: album.name || t.album || '',
      image: t.image || album.image || '',
    }));
    store.currentAlbumTracks = tracks;
    $('#albumDetailCount').textContent = `${tracks.length} tracks`;
    // Album detail: numbered track list (position + duration) instead of a card
    // grid that repeats the album cover on every row. Drop the per-track artist
    // line when every track shares the album's artist (the common case).
    const albumArtist = (album.artist || '').toLowerCase();
    const hideArtist = tracks.every(t => (t.artist || '').toLowerCase() === albumArtist);
    const sink = { items: [], cards: [] };
    const listEl = renderSongRows(tracks, sink, { numbered: true, hideArtist });
    tracksEl.innerHTML = '';
    tracksEl.appendChild(listEl);
    checkLibrary(sink.items, tracksEl, sink.cards);
    _mountTempoFilter(tracks, '#albumTracks');
  } catch (e) {
    tracksEl.innerHTML = `<div class="empty-state"><p>Failed to load tracks: ${e.message}</p></div>`;
  }
}

export function closeAlbumDetail(fromPopstate) {
  $('#albumDetail').style.display = 'none';
  $('#searchResults').style.display = '';
  $('#searchLoadMore').style.display = '';
  const src = store.albumDetailSource;
  store.albumDetailSource = null;
  if (src) switchPage(src, true);
  if (!fromPopstate) historyBack();
}

// ── Init ──
export function init() {
  // Tab switching
  // Bind ONLY the Spotify sub-tabs. The Library sub-tabs (#libraryTabs) reuse the
  // .sp-tab class but carry data-lib-tab, so an unqualified binding set
  // store.activeSpTab = undefined and then threw on .charAt(0) — i.e. every
  // Library sub-tab click raised a TypeError and cleared the Spotify sections.
  $$('.sp-tab[data-sp-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.spTab === store.activeSpTab) return;
      $$('.sp-tab[data-sp-tab]').forEach(t => t.classList.remove('active'));
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
    // Liked Songs and imported playlists have no id Spotify would recognise, so
    // the open.spotify.com fallback below must not be built for them — an import
    // carries its real source link in store.currentPlaylistUrl (which is empty
    // for a pasted list of track links, and that's fine: the job only needs
    // playlist_tracks).
    const synthetic = store.currentPlaylistId === 'liked' || String(store.currentPlaylistId).startsWith('import:');
    openModal({
      name: $('#plDetailName').textContent,
      artist: 'Playlist',
      image: store.currentPlaylistId === 'liked' ? '' : $('#plDetailImg').src,
      // Prefer the real playlist url — non-Spotify playlists (Deezer, YT Music)
      // would otherwise be sent as a bogus open.spotify.com link.
      url: store.currentPlaylistUrl || (synthetic ? '' : `https://open.spotify.com/playlist/${store.currentPlaylistId}`),
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

  // Album detail
  $('#backFromAlbum').addEventListener('click', () => closeAlbumDetail());
  $('#playAlbum').addEventListener('click', async () => {
    const tracks = store.currentAlbumTracks || [];
    if (!tracks.length) return;
    const { playTracks } = await import('./upnext.js');
    playTracks(tracks);
  });
  $('#shuffleAlbum').addEventListener('click', async () => {
    const tracks = store.currentAlbumTracks || [];
    if (!tracks.length) return;
    const shuffled = tracks.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const { playTracks } = await import('./upnext.js');
    playTracks(shuffled);
  });
  $('#queueAlbum').addEventListener('click', async () => {
    const tracks = store.currentAlbumTracks || [];
    if (!tracks.length) return;
    const mod = await getPlayerModule();
    mod.addToQueue(tracks);
  });
  $('#addAlbumToPlaylist').addEventListener('click', () => {
    addTracksToNavidromePlaylist(store.currentAlbumTracks || []);
  });
  $('#downloadAlbum').addEventListener('click', () => {
    if (!store.currentAlbum) return;
    openModal({ ...store.currentAlbum, type: 'album' });
  });

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
          const data = await apiJson(`/api/album/${album.id}/tracks${_providerQs(album.provider || _artistDetailProvider)}`);
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
      import('./upnext.js').then(m => m.playTracks(tracks));
    }
  });
  $('#shufflePlaylist').addEventListener('click', () => {
    const tracks = getPlaylistTracksForPlayer();
    if (!tracks.length) return;
    const shuffled = tracks.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    import('./upnext.js').then(m => m.playTracks(shuffled));
  });
  $('#queuePlaylist').addEventListener('click', () => {
    const tracks = getPlaylistTracksForPlayer();
    if (tracks.length) {
      getPlayerModule().then(m => m.addToQueue(tracks));
    }
  });
  $('#addPlaylistToPlaylist').addEventListener('click', () => {
    addTracksToNavidromePlaylist(getPlaylistTracksForPlayer());
  });
}

function getPlaylistTracksForPlayer() {
  const cards = $$('#playlistTracks .card');
  return cards.map(c => { try { return JSON.parse(c.dataset.item); } catch { return null; } }).filter(Boolean);
}
