// search.js — doSearch, renderResults, checkLibrary, renderCards, infinite scroll, card helpers

import { store } from './store.js';
import { $, $$, esc, escAttr, formatDuration, autoFocus, historyBack, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
// The cycle with spotify.js is deliberate and already load-bearing (it imports
// renderResults from here): both sides are only reached from event handlers, so
// neither module is read during the other's evaluation. The close* functions go
// through the same static import — a dynamic one would make closing async, and
// the search would then start before the detail layer was gone.
import {
  loadPlaylistDetail, loadShowDetail, loadArtistDetail, loadAlbumDetail,
  closeArtistDetail, closeAlbumDetail, closeShowDetail,
} from './spotify.js';
import { attachContextMenu, wasLongPress, makeKebabButton, _addToNavidromePlaylist } from './contextmenu.js';
import { makeHeartButton } from './likes.js';
import { setPlayContext } from './playcontext.js';

// ── Card Helper Functions ──
// opts.hero: the top-result card. An artist gets a play button only there — it
// is a single element, so one extra request for the artist's top tracks is
// affordable; in a grid of six artist cards every tap would pay for it.
export function cardPlayBtn(item, opts = {}) {
  const type = item.type || 'track';
  if (type === 'artist') return opts.hero ? _playBtnHtml() : '';
  if (type === 'playlist' || type === 'show') return '';
  return _playBtnHtml();
}

function _playBtnHtml() {
  return '<button class="card-play-btn" title="Play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>';
}

export function cardDlBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'artist') return '';
  return '<button class="card-dl-btn" title="Download"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></button>';
}

export function cardRadioBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'episode') return '';
  // Line icon like every other control on a card; the emoji rendered in the
  // system font and sat a couple of pixels off the circle's centre.
  return '<button class="card-radio-btn" title="Play Radio"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 7H7.6l4.6-1.9-.6-1.5L4.3 6.6A2 2 0 0 0 3 8.5V19a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zm0 12H5V9h15v10zM7.5 11a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm6 0h5v1.5h-5V11zm0 3h5v1.5h-5V14z"/></svg></button>';
}

export function cardAddPlBtn(item) {
  const type = item.type || 'track';
  if (type !== 'track') return '';
  return '<button class="card-addpl-btn" title="Add to playlist"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg></button>';
}

export function cardFavBtn(item) {
  if ((item.type || 'track') !== 'artist') return '';
  const isFav = store.favoritedArtistIds.has(item.id);
  return `<button class="card-fav-btn${isFav ? ' following' : ''}" title="${isFav ? 'Unfollow' : 'Follow'}">${isFav ? '&#x2665;' : '&#x2661;'}</button>`;
}

// Deezer/iTunes both flag explicit lyrics; Spotify marks them with the same
// little grey E in front of the byline, which is where a listener looks for it.
export function explicitBadge(item) {
  return (item && item.explicit) ? '<span class="explicit-badge" title="Explicit">E</span>' : '';
}

export function cardSubHtml(item) {
  const artist = item.artist || '';
  const album = item.album || '';
  const type = item.type || 'track';
  if (type === 'track' && artist) {
    let html = explicitBadge(item) + `<span class="clickable" data-search-type="artist" data-search-q="${escAttr(artist)}">${esc(artist)}</span>`;
    // Separator and album in one span so a narrow song row can drop both and not
    // leave a dangling " · " behind the artist name.
    if (album) html += `<span class="sub-album"> · <span class="clickable" data-search-type="album" data-search-q="${escAttr(album)}">${esc(album)}</span></span>`;
    return html;
  }
  if ((type === 'album' || type === 'episode') && artist) {
    return explicitBadge(item) + `<span class="clickable" data-search-type="artist" data-search-q="${escAttr(artist)}">${esc(artist)}</span>`;
  }
  // An artist's `artist` field repeats its own name, so the subtitle read
  // "Daft Punk / Daft Punk". The useful line there is what the card IS.
  if (type === 'artist') return 'Artist';
  return esc(artist);
}

// "1 episodes" was the giveaway that nobody had looked at a single-item show.
function countLabel(n, one, many) {
  return `${esc(n)} ${Number(n) === 1 ? one : many}`;
}

// ── Route a card/hero click to the right detail view (or download modal) ──
function _routeCardClick(item, fromPage) {
  if (item.type === 'playlist' && item.id) {
    // Pass the provider explicitly: ytmusic playlist items carry no `url`, so URL
    // inference alone would fall back to the configured provider and resolve a
    // ytmusic id against Deezer. name/image let the hero paint before the fetch.
    loadPlaylistDetail(item.id, item.url, fromPage,
      { provider: item.provider, name: item.name, image: item.image });
  } else if (item.type === 'show' && item.id) {
    loadShowDetail(item.id, item.url, fromPage, item.feed_url);
  } else if (item.type === 'artist' && item.id) {
    // Pass the item's own provider: with the fallback chain live, an artist can
    // come from a different provider than the configured one, and its id must be
    // resolved against the API that issued it.
    loadArtistDetail(item.id, fromPage, item.provider);
  } else if (item.type === 'album' && item.id) {
    loadAlbumDetail(item, fromPage);
  } else {
    openModal(item);
  }
}

// Tapping a song plays it, the way it does on Spotify — the download dialog
// moved to the ⋯ menu (and long-press / right-click), which is where the rest of
// the per-track actions already live. Everything that isn't playable on its own
// (album, artist, playlist, show) still opens, so only songs and episodes change.
// Routed through the row's own play button so the queue context, the resolver
// and the two player engines keep their single implementation.
function _playOrRoute(el, item, fromPage) {
  const type = item.type || 'track';
  const playBtn = (type === 'track' || type === 'episode') ? el.querySelector('.card-play-btn') : null;
  if (playBtn) { playBtn.click(); return; }
  _routeCardClick(item, fromPage);
}

// ── Wire the quick "+" (add to Navidrome playlist) button on a card/row ──
// Shared by grid cards, the top-result hero and the compact song rows so the
// same affordance behaves identically everywhere it appears.
function _wireAddPlBtn(el) {
  const btn = el.querySelector('.card-addpl-btn');
  if (!btn) return null;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    let it;
    try { it = JSON.parse(el.dataset.item); } catch { return; }
    _addToNavidromePlaylist(it);
  });
  return btn;
}

// ── Build a single result card element (markup + click handler) ──
export function buildCardElement(item, fromPage) {
  const artistCls = (item.type === 'artist') ? ' artist-card' : '';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="card${artistCls}" data-item='${JSON.stringify(item).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'>
      ${cardPlayBtn(item)}${cardRadioBtn(item)}${cardAddPlBtn(item)}${cardFavBtn(item)}<img class="card-img" ${item.image ? `src="${escAttr(item.image)}"` : ''} alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
      <div class="card-body">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-sub">${cardSubHtml(item)}</div>
        <div class="card-meta">
          ${item.year ? `<span>${esc(item.year)}</span>` : ''}
          ${item.total_tracks ? `<span>${item.type === 'show' ? countLabel(item.total_tracks, 'episode', 'episodes') : countLabel(item.total_tracks, 'track', 'tracks')}</span>` : ''}
          ${item.release_date ? `<span>${esc(item.release_date)}</span>` : ''}
          ${item.duration_ms ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}
        </div>
      </div>
    </div>
  `;
  const card = wrap.firstElementChild;
  card.addEventListener('click', (e) => {
    if (wasLongPress()) return;
    if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-addpl-btn') || e.target.closest('.card-fav-btn')) return;
    let it;
    try { it = JSON.parse(card.dataset.item); } catch { return; }
    _playOrRoute(card, it, fromPage);
  });
  _wireAddPlBtn(card);
  return card;
}

// ── Render Results ──
export function renderResults(items, container, fromPage) {
  const el = $(container);
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
    return;
  }
  const cards = items.map(item => buildCardElement(item, fromPage));
  el.innerHTML = '';
  cards.forEach(card => el.appendChild(card));
  _attachCardContextMenu(el);
  addCardKebabs(cards);
  checkLibrary(items, el, cards);
}

function _attachCardContextMenu(el) {
  attachContextMenu(el, {
    selector: '.card[data-item]',
    getItem: (targetEl) => {
      try {
        const item = JSON.parse(targetEl.dataset.item);
        const type = item.type || 'track';
        return { item, type, context: { inLibrary: !!item.inLibrary } };
      } catch { return null; }
    },
  });
}

// Add a visible ⋯ kebab to each card that opens the same context menu.
// Reads the card's data-item live so it reflects later library-check updates.
export function addCardKebabs(cards) {
  cards.forEach(card => {
    if (!card.dataset.item || card.querySelector('.kebab-btn')) return;
    let item;
    try { item = JSON.parse(card.dataset.item); } catch { return; }
    const type = item.type || 'track';
    const kebab = makeKebabButton(() => {
      try {
        const it = JSON.parse(card.dataset.item);
        return { item: it, type: it.type || 'track', context: { inLibrary: !!it.inLibrary } };
      } catch { return null; }
    });
    card.appendChild(kebab);
    // Heart only makes sense for individual tracks (albums/artists/playlists excluded).
    if (type === 'track' && !card.querySelector('.like-btn')) {
      card.appendChild(makeHeartButton(item));
    }
  });
}

// ── Library Check ──
// cards: optional array of card elements to check (must align 1:1 with items).
// If omitted, all .card children of containerEl are used.
export async function checkLibrary(items, containerEl, cards) {
  try {
    const checkItems = items.map(item => ({ name: item.name, artist: item.artist || '', type: item.type || 'track', id: item.id || '' }));
    const data = await apiJson('/api/library/check', {
      method: 'POST', body: { items: checkItems },
    });
    if (!cards) cards = $$('.card', containerEl);
    data.results.forEach((inLib, i) => {
      if (inLib && cards[i]) {
        cards[i].classList.add('in-library');
        const badge = document.createElement('div');
        badge.className = 'in-library-badge';
        badge.textContent = 'In Library';
        cards[i].appendChild(badge);
        // Search/discover cards don't render a download button, but the
        // artist-detail album cards built in spotify.js do (and they route
        // through this same helper), so the branch is live there.
        const dlBtn = cards[i].querySelector('.card-dl-btn');
        if (dlBtn) {
          dlBtn.disabled = true;
          dlBtn.style.opacity = '0.3';
          dlBtn.title = 'Already in library';
        }
        if (cards[i].dataset.item) {
          const item = JSON.parse(cards[i].dataset.item);
          item.inLibrary = true;
          cards[i].dataset.item = JSON.stringify(item);
        }
        if (cards[i].dataset.albumIdx != null) {
          const idx = parseInt(cards[i].dataset.albumIdx);
          if (store.currentArtistAlbums && store.currentArtistAlbums[idx]) {
            store.currentArtistAlbums[idx].inLibrary = true;
          }
        }
      }
    });
  } catch (e) {
    // Non-fatal: results stay rendered without the "In Library" badges. Surface
    // it though — a mid-search auth expiry looks identical to "nothing matched".
    console.warn('Library check failed; in-library badges skipped.', e);
  }
}

// ── Persist / Restore Search ──
function saveSearchState() {
  const user = store.currentUser?.username || '';
  const q = $('#searchInput').value.trim();
  if (q) {
    localStorage.setItem(`ms_search_${user}`, JSON.stringify({ q, type: store.searchType }));
  } else {
    localStorage.removeItem(`ms_search_${user}`);
  }
}

export function restoreSearch() {
  const user = store.currentUser?.username || '';
  try {
    const saved = JSON.parse(localStorage.getItem(`ms_search_${user}`));
    if (saved && saved.q) {
      $('#searchInput').value = saved.q;
      $('#searchClear').style.display = 'block';
      store.searchType = saved.type || 'all';
      $$('.type-btn[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === store.searchType));
      doSearch();
      return;
    }
  } catch {}
  renderBrowse();
}

// ── Recent searches (localStorage, last ~8 distinct queries) ──
// They used to be chips shown only while the box was focused, which on a phone
// meant "only with the keyboard up". The list now belongs to the empty-state
// screen and renderBrowse() is its only renderer — two renderers of the same
// list have to agree on the state after a delete, and the chip row additionally
// hid itself 150 ms after blur.
const RECENT_MAX = 8;

// Per account: the old global key handed the previous user's search history to
// whoever logged in next on the same browser, and it is now visible with no
// interaction at all.
function _recentKey() {
  return `ms_recent_searches_${store.currentUser?.username || ''}`;
}

function getRecentSearches() {
  try {
    const arr = JSON.parse(localStorage.getItem(_recentKey()));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function _saveRecentSearches(list) {
  try { localStorage.setItem(_recentKey(), JSON.stringify(list)); } catch {}
}

function addRecentSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  let list = getRecentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  list = list.slice(0, RECENT_MAX);
  _saveRecentSearches(list);
}

function removeRecentSearch(q) {
  _saveRecentSearches(getRecentSearches().filter(x => x !== q));
  renderBrowse();
}

function clearRecentSearches() {
  try { localStorage.removeItem(_recentKey()); } catch {}
  renderBrowse();
}

// Markup only — renderBrowse() owns #searchResults and paints this above the
// genre tiles.
function _recentSearchesHtml() {
  const list = getRecentSearches();
  if (!list.length) return '';
  return '<div class="search-section-header"><h3>Recent searches</h3>'
    + '<button type="button" class="section-showall" id="recentClear">Clear</button></div>'
    + '<div class="recent-list">'
    // escAttr (not esc) inside the attribute: esc() leaves quotes intact, and the
    // value is attacker-reachable (provider artist name → data-search-q → input
    // → addRecentSearch → localStorage → here).
    + list.map(q => `<div class="recent-item">
        <button type="button" class="recent-item-q" data-recent-q="${escAttr(q)}">${esc(q)}</button>
        <button type="button" class="recent-item-del" data-recent-del="${escAttr(q)}" title="Remove" aria-label="Remove ${escAttr(q)}">&#x2715;</button>
      </div>`).join('')
    + '</div>';
}

function _wireRecentSearches(el) {
  $$('.recent-item-q', el).forEach(btn => btn.addEventListener('click', () => {
    $('#searchInput').value = btn.dataset.recentQ;
    $('#searchClear').style.display = 'block';
    clearTimeout(store.searchTimeout);
    doSearch();
  }));
  $$('.recent-item-del', el).forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRecentSearch(btn.dataset.recentDel);
  }));
  $('#recentClear', el)?.addEventListener('click', clearRecentSearches);
}

// ── Browse tiles (what an empty search box shows) ──
// Recent searches are a chip row above the results; this fills the results area
// itself, the way Spotify's search screen opens on a wall of genres.
let _genreCache = null;

// Deterministic colour per genre so a tile keeps the same hue between visits.
function _tileHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// A failed load used to be cached as an empty list and answered with an empty
// page for the rest of the session. Keep the cache null on failure so the
// retry button has something to retry.
function _browseErrorHtml(msg) {
  return `<div class="empty-state"><p>${esc(msg)}</p>`
    + '<button type="button" class="retry-btn" id="browseRetry">Try again</button></div>';
}

export async function renderBrowse() {
  const el = $('#searchResults');
  if (!el) return;
  store.genreOpen = false;
  el.classList.remove('grid');
  const recent = _recentSearchesHtml();
  let failed = false;
  if (!_genreCache) {
    el.innerHTML = recent + `<div class="browse-grid">${Array(12).fill('<div class="skeleton skeleton-tile"></div>').join('')}</div>`;
    _wireRecentSearches(el);
    try {
      const data = await apiJson('/api/genres');
      const genres = Array.isArray(data.genres) ? data.genres : [];
      if (genres.length) _genreCache = genres; else failed = true;
    } catch { failed = true; }
  }
  // The box may have been typed into while the genres were loading — a stale
  // tile wall must not land on top of real results.
  if ($('#searchInput').value.trim()) return;
  if (failed || !_genreCache) {
    el.innerHTML = recent + _browseErrorHtml('Could not load the genre list.');
    _wireRecentSearches(el);
    $('#browseRetry', el)?.addEventListener('click', renderBrowse);
    return;
  }
  el.innerHTML = recent + '<div class="search-section-header"><h3>Browse all</h3></div><div class="browse-grid">'
    + _genreCache.map(g => `
      <button type="button" class="genre-tile" data-genre-id="${escAttr(g.id)}" data-genre-name="${escAttr(g.name)}" style="--tile-hue:${_tileHue(g.name)}">
        <span class="genre-tile-name">${esc(g.name)}</span>
        ${g.image ? `<img class="genre-tile-img" src="${escAttr(g.image)}" alt="" loading="lazy">` : ''}
      </button>`).join('')
    + '</div>';
  _wireRecentSearches(el);
  $$('.genre-tile', el).forEach(tile => tile.addEventListener('click', () => {
    openGenre(tile.dataset.genreId, tile.dataset.genreName);
  }));
}

// One "Artists" / "Albums" / "Playlists" block of cards.
function _cardSection(title, items, sink) {
  const section = document.createElement('div');
  section.className = 'search-section';
  const header = document.createElement('div');
  header.className = 'search-section-header';
  header.innerHTML = `<h3>${esc(title)}</h3>`;
  section.appendChild(header);
  const grid = document.createElement('div');
  grid.className = 'grid';
  const cards = items.map(it => buildCardElement(it, 'search'));
  cards.forEach(c => grid.appendChild(c));
  addCardKebabs(cards);
  _attachCardContextMenu(grid);
  section.appendChild(grid);
  if (sink) { items.forEach(it => sink.items.push(it)); cards.forEach(c => sink.cards.push(c)); }
  return section;
}

// A genre's charts: top tracks as rows (so starting one queues the rest), then
// the artists, albums and playlists carrying it.
// The genre chart is a layer like artist/album detail, but it has no DOM
// element of its own (it repaints #searchResults), so the router cannot spot it
// by visibility — it goes on the flag instead. historyBack() only when the user
// asked for it; a popstate has already moved history itself.
export function closeGenre(fromPopstate) {
  if (!store.genreOpen) return;
  store.genreOpen = false;
  renderBrowse();
  if (!fromPopstate) historyBack();
}

async function openGenre(id, name) {
  // Takes over the search generation so an in-flight query can't repaint over
  // this, and clears searchQuery so infinite scroll stays out of it.
  const { gen, signal } = _beginSearch();
  // Without an entry of its own, Back was swallowed here for good: the router's
  // anti-exit guard pushes the popped item straight back.
  history.pushState({ layer: 'genre' }, '');
  store.genreOpen = true;
  const el = $('#searchResults');
  store.searchHasMore = false;
  store.searchQuery = '';
  store.searchLoading = false;
  el.classList.remove('grid');
  const head = `<div class="search-section-header"><h3>${esc(name)}</h3><button type="button" class="section-showall" id="genreBack">&larr; Browse all</button></div>`;
  el.innerHTML = head + Array(6).fill('<div class="skeleton skeleton-row"></div>').join('');
  let data;
  try {
    data = await apiJson(`/api/genre/${encodeURIComponent(id)}/chart?limit=20`, { signal });
  } catch (e) {
    if (gen !== _searchGen) return;
    el.innerHTML = head + `<div class="empty-state"><p>Could not load ${esc(name)}: ${esc(e.message)}</p></div>`;
    $('#genreBack')?.addEventListener('click', () => closeGenre());
    return;
  }
  if (gen !== _searchGen) return;
  const sink = { items: [], cards: [] };
  const frag = document.createDocumentFragment();
  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
  if (tracks.length) {
    const section = document.createElement('div');
    section.className = 'search-section';
    const h = document.createElement('div');
    h.className = 'search-section-header';
    h.innerHTML = '<h3>Top songs</h3>';
    section.appendChild(h);
    section.appendChild(renderSongRows(tracks, sink));
    frag.appendChild(section);
  }
  [['Artists', data.artists], ['Albums', data.albums], ['Playlists', data.playlists]].forEach(([title, items]) => {
    if (Array.isArray(items) && items.length) frag.appendChild(_cardSection(title, items.slice(0, 6), sink));
  });
  el.innerHTML = head;
  el.appendChild(frag);
  $('#genreBack')?.addEventListener('click', () => closeGenre());
  if (sink.items.length) checkLibrary(sink.items, el, sink.cards);
  _setKbdActive(-1);
}

// ── Keyboard navigation through search result cards ──
let _kbdIndex = -1;

function _kbdCards() {
  return $$('#searchResults .card');
}

function _setKbdActive(idx) {
  const cards = _kbdCards();
  cards.forEach(c => c.classList.remove('kbd-active'));
  _kbdIndex = Math.max(-1, Math.min(idx, cards.length - 1));
  if (_kbdIndex >= 0 && cards[_kbdIndex]) {
    cards[_kbdIndex].classList.add('kbd-active');
    cards[_kbdIndex].scrollIntoView({ block: 'nearest' });
  }
}

function _activateKbdCard() {
  const cards = _kbdCards();
  if (_kbdIndex < 0 || !cards[_kbdIndex]) return;
  // Reuse the card's own click handler (play track / open album / artist / etc.).
  cards[_kbdIndex].click();
}

function _handleSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    const cards = _kbdCards();
    if (!cards.length) return;
    e.preventDefault();
    _setKbdActive(_kbdIndex + 1);
  } else if (e.key === 'ArrowUp') {
    const cards = _kbdCards();
    if (!cards.length) return;
    e.preventDefault();
    _setKbdActive(_kbdIndex - 1);
  } else if (e.key === 'Enter') {
    if (_kbdIndex >= 0) { e.preventDefault(); _activateKbdCard(); return; }
    clearTimeout(store.searchTimeout);
    doSearch();
  } else if (e.key === 'Escape') {
    _setKbdActive(-1);
    $('#searchInput').blur();
  }
}

// ── Search request generation guard ──
// Every search (per-type, "All", infinite-scroll append) bumps _searchGen and
// gets a fresh AbortController; the previous one is aborted. A response from an
// older generation must never touch the DOM or `store` — without this a slow
// "daft punk" response landing after "enya" repainted the whole page under the
// newer query, a stale append double-advanced store.searchOffset, and a stale
// "All" response repainted sections after the user switched to a per-type tab
// (leaving searchHasMore=true with no .grid class → unstyled append cards).
let _searchGen = 0;
let _searchAbort = null;

function _beginSearch() {
  // Any search repaints #searchResults, so whatever the genre layer put there
  // is gone — the flag must not outlive it.
  store.genreOpen = false;
  try { _searchAbort?.abort(); } catch {}
  _searchAbort = (typeof AbortController === 'function') ? new AbortController() : null;
  return { gen: ++_searchGen, signal: _searchAbort ? _searchAbort.signal : undefined };
}

// Invalidate any in-flight search without starting a new one (input cleared).
// Clears searchLoading too: the aborted request returns via the stale-generation
// path and would otherwise leave the flag stuck on.
function _cancelSearch() {
  _beginSearch();
  store.searchLoading = false;
  // An aborted append returns via the stale-generation path, which skips the
  // line that normally hides this — otherwise the spinner outlives the results.
  const more = $('#searchLoadMore');
  if (more) more.style.display = 'none';
}

// Tracks are rendered as one growing list so that infinite scroll extends it
// instead of stacking a separate list per page — and so that playing a row
// queues everything loaded so far, not just the twenty that arrived together.
let _trackRowQueue = [];

// How deep the queue should be once you start playing from the results. The
// rows on screen used to BE the queue, so a tap on a fresh search queued the
// twenty that had loaded and then stopped. Playing now pulls the next pages in
// behind you, exactly as scrolling would have.
const QUEUE_TARGET = 100;
let _toppingUp = false;

// playTracks() adopts a list's context array as store.playerQueue, so anything
// pushed into that same array lands in the live queue. The identity check is
// what tells us the thing playing is still this list.
async function _growLiveQueue(ctx, added) {
  if (!added.length || store.playerQueue !== ctx) return false;
  // The server-side mirror was written when playback started and knows nothing
  // about these, and the queue panel paints from a snapshot.
  try { (await import('./upnext.js')).mirrorAdd(added); } catch {}
  try { (await import('./queue.js')).renderQueue(); } catch {}
  return true;
}

async function _topUpQueue() {
  if (_toppingUp || store.searchType !== 'track') return;
  _toppingUp = true;
  try {
    while (_trackRowQueue.length < QUEUE_TARGET && store.searchHasMore && store.searchQuery) {
      const ctx = _trackRowQueue;
      const before = ctx.length;
      await doSearch(true);
      const added = ctx.slice(before);
      if (!added.length) break;   // superseded search, or the list was replaced
      if (!await _growLiveQueue(ctx, added)) break;   // playing something else now
    }
  } catch (e) {
    console.warn('Queue top-up failed', e);
  } finally {
    _toppingUp = false;
  }
}

// The All tab shows six songs under the top result. Starting one of those used
// to queue just those six; this pulls the full Songs tab in behind them.
async function _topUpAllSongs(ctx, q) {
  if (_toppingUp || !q) return;
  _toppingUp = true;
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(q)}&type=track&limit=50&offset=0`);
    const seen = new Set(ctx.map(t => String(t.id)));
    const added = (data.results || []).filter(t => !seen.has(String(t.id)));
    ctx.push(...added);
    await _growLiveQueue(ctx, added);
  } catch (e) {
    console.warn('Queue top-up failed', e);
  } finally {
    _toppingUp = false;
  }
}

function _renderTrackRows(tracks, append) {
  const el = $('#searchResults');
  const existing = append ? el.querySelector('.song-list') : null;
  if (!existing) _trackRowQueue = [];
  // Mutated in place: the list registered this very array as its play context,
  // so appending a page keeps that context current without re-registering.
  _trackRowQueue.push(...tracks);
  const sink = { items: [], cards: [] };
  const list = renderSongRows(tracks, sink, { context: _trackRowQueue });
  if (existing) {
    while (list.firstChild) existing.appendChild(list.firstChild);
  } else {
    // Starting a song here is what asks for a deeper queue — both the ▶ button
    // and a tap on the row, which clicks that same button.
    list.addEventListener('click', (e) => {
      if (e.target.closest('.card-play-btn')) _topUpQueue();
    });
    el.innerHTML = '';
    el.appendChild(list);
  }
  checkLibrary(sink.items, el, sink.cards);
}

// ── Do Search ──
export async function doSearch(append) {
  // "All" mode has its own renderer; it bumps the shared generation counter
  // itself, which is what invalidates any in-flight per-type search.
  if (store.searchType === 'all') {
    store.searchHasMore = false;
    await doSearchAll();
    return;
  }
  const { gen, signal } = _beginSearch();
  const q = $('#searchInput').value.trim();
  if (!q) { store.searchLoading = false; saveSearchState(); renderBrowse(); return; }
  // Songs read as a list, not a poster wall: the title, artist and duration are
  // what you scan down, and a card per song fits four of them on a phone.
  // Albums, artists and playlists stay in the grid, where the cover IS the item.
  const asRows = store.searchType === 'track';
  // Rows are a third the height of a card, and they double as the play queue,
  // so the song list pulls Deezer's full page instead of a grid-sized one.
  const pageSize = asRows ? 50 : 20;
  if (!append) {
    store.searchOffset = 0;
    store.searchHasMore = true;
    store.searchQuery = q;
    const el = $('#searchResults');
    el.classList.toggle('grid', !asRows);
    el.innerHTML = Array(asRows ? 12 : 8)
      .fill(asRows ? '<div class="skeleton skeleton-row"></div>' : '<div class="skeleton skeleton-card"></div>')
      .join('');
  }
  store.searchLoading = true;
  // Append-only: on a fresh search this flashed a load-more skeleton underneath
  // the card skeletons.
  if (append) $('#searchLoadMore').style.display = '';
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(q)}&type=${store.searchType}&limit=${pageSize}&offset=${store.searchOffset}`, { signal });
    if (gen !== _searchGen) return; // superseded — leave DOM/store to the newer search
    if (data.results.length < pageSize) store.searchHasMore = false;
    // Paging stays on the raw page: the server's offset counts what it sent,
    // not what survived the hygiene pass below.
    const shown = store.searchType === 'artist'
      ? _dedupeByName(_dropCreditEntities(data.results))
      : data.results;
    if (asRows) {
      _renderTrackRows(shown, append);
    } else if (!append) {
      renderResults(shown, '#searchResults', 'search');
    } else {
      const grid = $('#searchResults');
      const newCards = shown.map(item => buildCardElement(item, 'search'));
      newCards.forEach(card => grid.appendChild(card));
      addCardKebabs(newCards);
      checkLibrary(shown, grid, newCards);
    }
    store.searchOffset += data.results.length;
    if (!append) {
      _noteIfNothingMatches(q, shown);
      saveSearchState();
      addRecentSearch(q);
      _setKbdActive(-1);
    }
  } catch (e) {
    if (gen !== _searchGen) return; // also swallows our own AbortError
    if (!append) $('#searchResults').innerHTML = `<div class="empty-state"><p>Search failed: ${esc(e.message)}</p></div>`;
  }
  if (gen !== _searchGen) return; // the newer search owns searchLoading now
  store.searchLoading = false;
  $('#searchLoadMore').style.display = 'none';
}

// ── Top-result hero card (large, Spotify-style) ──
const _TOP_TYPE_LABEL = { track: 'Song', album: 'Album', artist: 'Artist', playlist: 'Playlist', show: 'Podcast', episode: 'Episode' };

function buildTopResultCard(item, fromPage) {
  const type = item.type || 'track';
  const artistCls = (type === 'artist') ? ' artist-card' : '';
  const label = _TOP_TYPE_LABEL[type] || esc(type);
  const sub = (item.artist && type !== 'artist') ? `${label} · ${esc(item.artist)}` : label;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="card top-result-card${artistCls}" data-item='${JSON.stringify(item).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'>
      ${cardPlayBtn(item, { hero: true })}${cardRadioBtn(item)}${cardAddPlBtn(item)}${cardFavBtn(item)}<img class="top-result-img" ${item.image ? `src="${escAttr(item.image)}"` : ''} alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
      <div class="top-result-name">${esc(item.name)}</div>
      <div class="top-result-type">${sub}</div>
    </div>
  `;
  const card = wrap.firstElementChild;
  card.addEventListener('click', (e) => {
    if (wasLongPress()) return;
    if (e.target.closest('.card-play-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-addpl-btn')
        || e.target.closest('.card-fav-btn') || e.target.closest('.kebab-btn') || e.target.closest('.like-btn')) return;
    let it;
    try { it = JSON.parse(card.dataset.item); } catch { return; }
    _playOrRoute(card, it, fromPage);
  });
  _wireAddPlBtn(card);
  if (type === 'artist') _wireHeroArtistPlay(card, item);
  // The shared .card-radio-btn / .card-addpl-btn rules pin these to a card's
  // bottom-LEFT, which on the tall hero lands on the name/type labels rather
  // than on cover art. They belong in the artwork's bottom-right corner — but
  // the offsets are CSS now (.hero-act-N in search.css), because the inline
  // pixels were computed from the desktop artwork size and the mobile
  // breakpoint had no way to override them: on a 390px screen the buttons
  // ended up beside the cover instead of on it. All JS still says is which
  // button is how many places from the right.
  let slot = 0;
  ['.card-play-btn', '.card-addpl-btn', '.card-radio-btn'].forEach(sel => {
    const btn = card.querySelector(sel);
    if (btn) btn.classList.add(`hero-act-${slot++}`);
  });
  return card;
}

// An artist hero plays its top tracks, the way it does on Spotify. The track
// list is not in the search payload, so it is fetched on the click — which is
// why only the hero gets the button and the artist grid cards do not.
function _wireHeroArtistPlay(card, item) {
  const btn = card.querySelector('.card-play-btn');
  if (!btn || !item.id) return;
  btn.addEventListener('click', async (e) => {
    // The document-level .card-play-btn delegation would try to resolve the
    // artist itself as a playable track.
    e.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const qs = item.provider ? `?provider=${encodeURIComponent(item.provider)}&limit=10` : '?limit=10';
      const data = await apiJson(`/api/artist/${encodeURIComponent(item.id)}/top${qs}`);
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      if (!tracks.length) { showToast('No popular tracks for this artist', true); return; }
      (await import('./upnext.js')).playTracks(tracks, 0);
    } catch (err) {
      showToast(`Could not start ${item.name}: ${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ── Compact song rows (list, not cards) — reuse card-play delegation + kebab/heart ──
// sink (optional): { items: [], cards: [] } accumulators so the caller can run a
// library-check over these rows (they carry `.card` but live outside the grid).
export function renderSongRows(tracks, sink, opts = {}) {
  // opts.context: a longer list these rows belong to (infinite scroll appends a
  // page at a time, but playing row 3 should queue every row on screen, not the
  // twenty that happened to arrive together).
  const list = document.createElement('div');
  list.className = 'song-list' + (opts.numbered ? ' song-list-numbered' : '') + (opts.withArt ? ' song-list-art' : '');
  tracks.forEach((item, idx) => {
    // `.card` class lets the event-delegated .card-play-btn handler (player_v3.js)
    // find this row via btn.closest('.card'); CSS re-styles it as a flat row.
    const row = document.createElement('div');
    row.className = 'song-row card';
    row.dataset.item = JSON.stringify(item);
    // Numbered mode (album detail): show the track position instead of repeating
    // the album cover on every row. hideArtist drops the redundant per-track
    // artist line when every track shares the album's artist.
    // Album detail numbers its rows and drops the art (every row shares one
    // cover); a playlist shows both, the way Spotify does — the covers are how
    // you recognise a track in a list that spans a hundred different albums.
    const art = `<img class="song-thumb" ${item.image ? `src="${escAttr(item.image)}"` : ''} alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">`;
    const lead = opts.numbered
      ? `<div class="song-num">${esc(String(item.track_number || (idx + 1)))}</div>` + (opts.withArt ? art : '')
      : art;
    const sub = opts.hideArtist ? '' : `<div class="song-artist">${cardSubHtml(item)}</div>`;
    row.innerHTML = `
      ${lead}
      <div class="song-info">
        <div class="song-title">${esc(item.name)}</div>
        ${sub}
      </div>
      <span class="song-duration">${item.duration_ms ? formatDuration(item.duration_ms) : ''}</span>
      ${opts.numbered ? '' : cardAddPlBtn(item)}${cardPlayBtn(item)}
    `;
    // Quick-add "+" on the flat song rows (parity with track cards). Skipped in
    // `numbered` mode (album/playlist detail): at 360px the extra 44px truncates
    // those titles, which is why search.css already drops the heart there.
    //
    // Inline flow + sizing for this button lives in search.css
    // (`.song-list .song-row .card-addpl-btn`), alongside the play/kebab/like resets.
    _wireAddPlBtn(row);
    row.appendChild(makeKebabButton(() => {
      try { const it = JSON.parse(row.dataset.item); return { item: it, type: it.type || 'track', context: { inLibrary: !!it.inLibrary } }; } catch { return null; }
    }));
    // Spotify puts the heart first in the trailing cluster — ♡, length, ⋯.
    // Appending it left it to the right of both.
    row.insertBefore(makeHeartButton(item), row.querySelector('.song-duration'));
    row.addEventListener('click', (e) => {
      if (wasLongPress()) return;
      if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-addpl-btn')
          || e.target.closest('.kebab-btn') || e.target.closest('.like-btn')) return;
      let it;
      try { it = JSON.parse(row.dataset.item); } catch { return; }
      _playOrRoute(row, it, 'search');
    });
    list.appendChild(row);
    if (sink) { sink.items.push(item); sink.cards.push(row); }
  });
  // Starting any row in this list keeps the list as the queue (see playcontext.js).
  setPlayContext(list, opts.context || tracks);
  attachContextMenu(list, {
    selector: '.song-row[data-item]',
    getItem: (targetEl) => {
      try {
        const item = JSON.parse(targetEl.dataset.item);
        return { item, type: item.type || 'track', context: { inLibrary: !!item.inLibrary } };
      } catch { return null; }
    },
  });
  return list;
}

// ── A finished track list as rows (playlist / liked songs / album) ──
// Same shape Spotify gives every track list: numbered rows, the whole list as
// the play context, and the in-library check the grid renderer used to run.
// Returns the row elements so callers can hang their own per-row controls on
// them (the library playlist adds checkboxes, remove buttons and drag handles).
export function renderSongList(tracks, container, opts = {}) {
  const el = $(container);
  if (!el) return [];
  el.classList.remove('grid');
  if (!tracks || !tracks.length) {
    el.innerHTML = `<div class="empty-state"><p>${esc(opts.emptyText || 'Nothing here yet')}</p></div>`;
    return [];
  }
  const sink = { items: [], cards: [] };
  const list = renderSongRows(tracks, sink, { numbered: true, context: tracks, ...opts });
  el.innerHTML = '';
  el.appendChild(list);
  if (opts.check !== false) checkLibrary(sink.items, el, sink.cards);
  return sink.cards;
}

// ── Result-list hygiene for the All view ──
// The backend's _pick_top_result returns an entry that is STILL in its own list,
// so the hero and the first Songs row (or first Artists card) were the same
// entity. Drop it from its own list before rendering (Spotify does the same).
function _sameEntity(a, b) {
  if (!a || !b || !a.id || !b.id) return false;
  return (a.type || 'track') === (b.type || 'track') && String(a.id) === String(b.id);
}

function _withoutTop(top, list) {
  return top ? list.filter(it => !_sameEntity(it, top)) : list;
}

// Fold case + diacritics + whitespace so a provider returning 5 separate "Enya"
// artist entries (distinct ids, identical name) collapses to one card.
function _normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks left behind by NFKD
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Keep the FIRST occurrence: in-library state isn't known until checkLibrary()
// has run, so there's nothing better to rank duplicates by without another request.
function _dedupeByName(list) {
  const seen = new Set();
  return list.filter(it => {
    const key = _normName(it && it.name);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Deezer answers with a placeholder cover whose path carries an empty hash
// (/images/artist//500x500-…). It is a real URL that loads, so an empty-field
// test finds nothing; the shape of the address is the only tell. Combined with
// a comma in the name it reliably marks a credit entity ("Daft Punk, Pharrell
// Williams", "Made famous by Daft Punk") rather than a real artist.
const PROVIDER_PLACEHOLDER_IMG = /\/images\/[a-z]+\/\/\d+x\d+/;

function _dropCreditEntities(list) {
  return list.filter(it => !(it && typeof it.image === 'string'
    && PROVIDER_PLACEHOLDER_IMG.test(it.image)
    && String(it.name || '').includes(',')));
}

// Deezer matches fuzzily enough that nonsense comes back as a confident page of
// somebody else's music. Say so above the results and leave them as suggestions.
//
// Whole-word equality was too strict: a typo keeps the opening of the word but
// not the whole of it, so "beyonse" over a page headed by Beyoncé, "thriler"
// over Thriller and "michaell jacksonn" over Michael Jackson all got told
// "No results" above the very thing they were looking for. Two words count as
// the same word when they open the same way; four characters is enough to keep
// "zzzqqqxyznotathing12345" apart from everything a provider can return, and
// short words are compared whole rather than padded.
const _MATCH_PREFIX = 4;

function _sharesOpening(a, b) {
  const n = Math.min(_MATCH_PREFIX, a.length, b.length);
  return n >= 2 && a.slice(0, n) === b.slice(0, n);
}

// The top result is not a second, independent test. `_pick_top_result` in
// app/services/search_providers.py only returns nothing at its last step, i.e.
// when all four branches came back empty — and then there is nothing to put the
// note above either. "Only say it when the answer has no top" would therefore make
// this note dead code; measured, `top` is non-null even for
// "zzzqqqxyznotathing12345" (it falls through to tracks[0]). The top is already
// one of `items` here, so the single test below covers it.
function _nothingMatches(q, items) {
  // Both sides go through the same _normName, so diacritics can never split a
  // pair on their own ("beyonce" the query vs. "Beyoncé" the result).
  const words = [...new Set(_normName(q).split(' ').filter(w => w.length > 1))];
  if (!words.length || !items.length) return false;
  return !items.some(it => _normName(`${(it && it.name) || ''} ${(it && it.artist) || ''}`)
    .split(' ').some(w => words.some(qw => _sharesOpening(qw, w))));
}

function _noteIfNothingMatches(q, items) {
  const el = $('#searchResults');
  if (!el || !_nothingMatches(q, items)) return;
  const note = document.createElement('div');
  note.className = 'no-match-note';
  note.innerHTML = `No results for <strong>${esc(q)}</strong>`;
  el.insertBefore(note, el.firstChild);
}

// The four branches /api/search/all runs; `errors` is keyed by these.
const SEARCH_ALL_TYPES = ['track', 'artist', 'album', 'playlist'];

function _sectionErrorStrip(title, onRetry) {
  const section = document.createElement('div');
  section.className = 'search-section';
  const header = document.createElement('div');
  header.className = 'search-section-header';
  header.innerHTML = `<h3>${esc(title)}</h3>`;
  section.appendChild(header);
  const strip = document.createElement('div');
  strip.className = 'section-error';
  strip.innerHTML = `<span>Couldn&rsquo;t load ${esc(title.toLowerCase())}.</span>`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry-btn';
  retry.textContent = 'Try again';
  retry.addEventListener('click', onRetry);
  strip.appendChild(retry);
  section.appendChild(strip);
  return section;
}

// ── All-mode aggregated search (Spotify-style sections) ──
async function doSearchAll() {
  const { gen, signal } = _beginSearch();
  const q = $('#searchInput').value.trim();
  const resultsEl = $('#searchResults');
  if (!q) { store.searchLoading = false; saveSearchState(); renderBrowse(); return; }
  store.searchQuery = q;
  store.searchHasMore = false;
  store.searchLoading = true;
  $('#searchLoadMore').style.display = 'none';
  resultsEl.classList.add('grid');
  resultsEl.innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  try {
    // Fetch 8 per type but render 6: both the top-result exclusion and the
    // artist de-dup below remove entries, so fetching 8 keeps the rows full
    // instead of dropping to 4-5 cards.
    const data = await apiJson('/api/search/all?q=' + encodeURIComponent(q) + '&limit_per_type=8', { signal });
    if (gen !== _searchGen) return; // superseded — don't repaint under a newer query
    const top = data.top || null;
    const errors = (data.errors && typeof data.errors === 'object') ? data.errors : {};
    const tracks = _withoutTop(top, Array.isArray(data.tracks) ? data.tracks : []);
    // Artists only: same-name albums/playlists are frequently distinct releases
    // or distinct user playlists, so collapsing them would hide real results.
    const artists = _dedupeByName(_dropCreditEntities(_withoutTop(top, Array.isArray(data.artists) ? data.artists : [])));
    const albums = _withoutTop(top, Array.isArray(data.albums) ? data.albums : []);
    const playlists = _withoutTop(top, Array.isArray(data.playlists) ? data.playlists : []);

    // Every branch down: that is a dead provider, not an empty result, and the
    // user has to be able to ask again.
    if (SEARCH_ALL_TYPES.every(t => errors[t])) {
      resultsEl.classList.remove('grid');
      resultsEl.innerHTML = _browseErrorHtml('Search is unavailable right now.');
      $('#browseRetry', resultsEl)?.addEventListener('click', () => doSearchAll());
      store.searchLoading = false;
      return;
    }

    resultsEl.classList.remove('grid');
    const frag = document.createDocumentFragment();
    const allItems = [];
    const allCards = [];

    // 1) Top-result hero + Songs panel
    if (top) {
      const row = document.createElement('div');
      row.className = 'top-result-row';
      const topCard = buildTopResultCard(top, 'search');
      row.appendChild(topCard);
      // The hero is the most prominent card on the page, so give it the same ⋯
      // kebab / heart and right-click / long-press menu the grid cards get.
      // Attached to the card itself (not `row`) so the song rows inside the
      // panel keep the menu renderSongRows already wired for them.
      addCardKebabs([topCard]);
      _attachCardContextMenu(topCard);
      allItems.push(top);
      allCards.push(topCard);

      // Songs panel only when there are tracks (avoids an empty "Songs" header).
      if (tracks.length) {
        const panel = document.createElement('div');
        panel.className = 'top-songs-panel';
        const ph = document.createElement('div');
        ph.className = 'search-section-header';
        ph.innerHTML = '<h3>Songs</h3><button class="section-showall" data-showall="track">Show all</button>';
        panel.appendChild(ph);
        // A mutable context array: playing a row here tops it up to the full
        // Songs tab in the background (see _topUpAllSongs).
        const songCtx = tracks.slice(0, 6);
        const songList = renderSongRows(songCtx, { items: allItems, cards: allCards }, { context: songCtx });
        songList.addEventListener('click', (e) => {
          if (e.target.closest('.card-play-btn')) _topUpAllSongs(songCtx, q);
        });
        panel.appendChild(songList);
        row.appendChild(panel);
      }
      frag.appendChild(row);
    }

    // 2-4) Artists / Albums / Playlists sections
    const _section = (title, type, items) => {
      // A provider that fell over gets a visible strip. Leaving the section out
      // made a partial outage look like "there simply are no albums".
      if (errors[type]) { frag.appendChild(_sectionErrorStrip(title, () => doSearchAll())); return; }
      if (!items.length) return;
      const section = document.createElement('div');
      section.className = 'search-section';
      const header = document.createElement('div');
      header.className = 'search-section-header';
      header.innerHTML = `<h3>${esc(title)}</h3><button class="section-showall" data-showall="${type}">Show all</button>`;
      section.appendChild(header);
      const grid = document.createElement('div');
      grid.className = 'grid';
      const slice = items.slice(0, 6);
      const cards = slice.map(it => buildCardElement(it, 'search'));
      cards.forEach(c => grid.appendChild(c));
      addCardKebabs(cards);
      _attachCardContextMenu(grid);
      section.appendChild(grid);
      frag.appendChild(section);
      slice.forEach(it => allItems.push(it));
      cards.forEach(c => allCards.push(c));
    };
    if (errors.track) frag.appendChild(_sectionErrorStrip('Songs', () => doSearchAll()));
    _section('Artists', 'artist', artists);
    _section('Albums', 'album', albums);
    _section('Playlists', 'playlist', playlists);

    // `errors` has to be part of the emptiness test. Three branches down and the
    // fourth legitimately empty is not "nothing was found" — throwing the
    // fragment away there would hide the strips, the Try again buttons and every
    // trace of the outage behind the one sentence that says the opposite.
    if (!top && !tracks.length && !artists.length && !albums.length && !playlists.length
        && !Object.keys(errors).length) {
      resultsEl.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
    } else {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(frag);
      _noteIfNothingMatches(q, allItems);
      $$('.section-showall', resultsEl).forEach(btn => {
        btn.addEventListener('click', () => {
          const type = btn.dataset.showall;
          store.searchType = type;
          $$('.type-btn[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === type));
          doSearch();
        });
      });
      if (allItems.length) checkLibrary(allItems, resultsEl, allCards);
    }
    saveSearchState();
    addRecentSearch(q);
    _setKbdActive(-1);
  } catch (e) {
    if (gen !== _searchGen) return; // also swallows our own AbortError
    resultsEl.classList.remove('grid');
    resultsEl.innerHTML = `<div class="empty-state"><p>Search failed: ${esc(e.message)}</p></div>`;
  }
  if (gen !== _searchGen) return; // the newer search owns searchLoading now
  store.searchLoading = false;
  $('#searchLoadMore').style.display = 'none';
}

// Artist, album and show detail all live inside #pageSearch, so switching a tab
// or typing a new query searched BEHIND them: the tab turned green, the results
// repainted out of sight, and "← Back to results" was the only way out. Each
// close() also pops the history entry its layer pushed, exactly as that button
// does. offsetParent, not style.display — see docs/architecture.md.
function _closeOpenDetail() {
  const layers = [
    ['#artistDetail', closeArtistDetail],
    ['#albumDetail', closeAlbumDetail],
    ['#showDetail', closeShowDetail],
  ];
  for (const [sel, close] of layers) {
    const el = $(sel);
    if (el && el.offsetParent !== null) { close(); return; }
  }
}

// ── Init (called from app.js) ──
export function init() {
  // The recent-search list used to live under one key for the whole browser.
  try { localStorage.removeItem('ms_recent_searches'); } catch {}

  // Quick "refresh app" button next to the mic — clears the asset cache and
  // reloads with a cache-bust (same effect as Settings → Refresh), so users can
  // pull a new frontend without hunting through Settings. Keeps login.
  const refreshBtn = $('#appRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) {}
    const av = new URLSearchParams(window.location.search).get('app_version') || localStorage.getItem('app_installed_version');
    window.location.href = window.location.origin + '/?_=' + Date.now() + (av ? '&app_version=' + av : '');
  });

  $('#searchInput').addEventListener('input', () => {
    clearTimeout(store.searchTimeout);
    const value = $('#searchInput').value;
    $('#searchClear').style.display = value ? 'block' : 'none';
    _setKbdActive(-1);
    _closeOpenDetail();
    if (!value.trim()) {
      // Without this an older request still in flight comes back and paints its
      // results over the empty-state screen we are about to draw.
      _cancelSearch();
      store.searchQuery = '';
      store.searchHasMore = false;
      saveSearchState();
      renderBrowse();
      return;
    }
    store.searchTimeout = setTimeout(doSearch, 400);
  });
  $('#searchInput').addEventListener('keydown', _handleSearchKeydown);
  $('#searchClear').addEventListener('click', () => {
    // Invalidate any in-flight search so it can't repaint results (or re-show
    // this button) under a now-empty input.
    _cancelSearch();
    $('#searchInput').value = '';
    $('#searchClear').style.display = 'none';
    renderBrowse();
    store.searchQuery = '';
    store.searchHasMore = false;
    _setKbdActive(-1);
    saveSearchState();
    autoFocus($('#searchInput'));
  });

  $$('.type-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.type-btn[data-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.searchType = btn.dataset.type;
      _closeOpenDetail();
      doSearch();
    });
  });

  // Infinite scroll (search part)
  window.addEventListener('scroll', () => {
    const scrollBottom = window.innerHeight + window.scrollY;
    if (scrollBottom < document.body.offsetHeight - 300) return;

    // currentPage stays 'search' while an artist/album/show detail is open —
    // those layers live inside #pageSearch — so scrolling one of them used to
    // page the hidden result list underneath. Ask whether the list is actually
    // on screen; style.display doesn't answer that for a layer inside a page.
    const results = $('#searchResults');
    if (store.currentPage === 'search' && results && results.offsetParent !== null
        && !store.searchLoading && store.searchHasMore && store.searchQuery) {
      doSearch(true);
    }
  });
}
