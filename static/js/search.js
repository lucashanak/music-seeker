// search.js — doSearch, renderResults, checkLibrary, renderCards, infinite scroll, card helpers

import { store } from './store.js';
import { $, $$, esc, escAttr, formatDuration, autoFocus } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { loadPlaylistDetail, loadShowDetail, loadArtistDetail, loadAlbumDetail } from './spotify.js';
import { attachContextMenu, wasLongPress, makeKebabButton, _addToNavidromePlaylist } from './contextmenu.js';
import { makeHeartButton } from './likes.js';

// ── Card Helper Functions ──
export function cardPlayBtn(item) {
  const type = item.type || 'track';
  if (type === 'playlist' || type === 'show' || type === 'artist') return '';
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
  return '<button class="card-radio-btn" title="Play Radio">&#x1f4fb;</button>';
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

export function cardSubHtml(item) {
  const artist = item.artist || '';
  const album = item.album || '';
  const type = item.type || 'track';
  if (type === 'track' && artist) {
    let html = `<span class="clickable" data-search-type="artist" data-search-q="${escAttr(artist)}">${esc(artist)}</span>`;
    if (album) html += ` · <span class="clickable" data-search-type="album" data-search-q="${escAttr(album)}">${esc(album)}</span>`;
    return html;
  }
  if ((type === 'album' || type === 'episode') && artist) {
    return `<span class="clickable" data-search-type="artist" data-search-q="${escAttr(artist)}">${esc(artist)}</span>`;
  }
  return esc(artist);
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
      ${cardPlayBtn(item)}${cardRadioBtn(item)}${cardAddPlBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${escAttr(item.image || '')}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
      <div class="card-body">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-sub">${cardSubHtml(item)}</div>
        <div class="card-meta">
          ${item.year ? `<span>${esc(item.year)}</span>` : ''}
          ${item.total_tracks ? `<span>${esc(item.total_tracks)} ${item.type === 'show' ? 'episodes' : 'tracks'}</span>` : ''}
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
    _routeCardClick(it, fromPage);
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
    }
  } catch {}
}

// ── Recent searches (localStorage, last ~8 distinct queries) ──
const RECENT_KEY = 'ms_recent_searches';
const RECENT_MAX = 8;

function getRecentSearches() {
  try {
    const arr = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function addRecentSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  let list = getRecentSearches().filter(x => x.toLowerCase() !== q.toLowerCase());
  list.unshift(q);
  list = list.slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_KEY); } catch {}
  renderRecentSearches();
}

// Render recent-search chips, but only while the input is focused AND empty.
function renderRecentSearches() {
  const wrap = $('#recentSearches');
  if (!wrap) return;
  const input = $('#searchInput');
  const focused = document.activeElement === input;
  const list = getRecentSearches();
  if (!focused || (input && input.value.trim()) || !list.length) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = list.map(q =>
    // escAttr (not esc) inside the attribute: esc() leaves quotes intact, and the
    // value is attacker-reachable (provider artist name → data-search-q → input
    // → addRecentSearch → localStorage → here).
    `<button type="button" class="recent-chip" data-recent-q="${escAttr(q)}">${esc(q)}</button>`
  ).join('') + '<button type="button" class="recent-clear" id="recentClear">Clear</button>';
  wrap.style.display = 'flex';
  $$('.recent-chip', wrap).forEach(chip => {
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus
    chip.addEventListener('click', () => {
      const input2 = $('#searchInput');
      input2.value = chip.dataset.recentQ;
      $('#searchClear').style.display = 'block';
      wrap.style.display = 'none';
      clearTimeout(store.searchTimeout);
      doSearch();
    });
  });
  const clearBtn = $('#recentClear', wrap);
  if (clearBtn) {
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', clearRecentSearches);
  }
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
    const wrap = $('#recentSearches');
    if (wrap) wrap.style.display = 'none';
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
  if (!q) { $('#searchResults').innerHTML = ''; store.searchLoading = false; saveSearchState(); return; }
  if (!append) {
    store.searchOffset = 0;
    store.searchHasMore = true;
    store.searchQuery = q;
    $('#searchResults').classList.add('grid');
    $('#searchResults').innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  }
  store.searchLoading = true;
  // Append-only: on a fresh search this flashed a load-more skeleton underneath
  // the card skeletons.
  if (append) $('#searchLoadMore').style.display = '';
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(q)}&type=${store.searchType}&limit=20&offset=${store.searchOffset}`, { signal });
    if (gen !== _searchGen) return; // superseded — leave DOM/store to the newer search
    if (data.results.length < 20) store.searchHasMore = false;
    if (!append) {
      renderResults(data.results, '#searchResults', 'search');
    } else {
      const grid = $('#searchResults');
      const newCards = data.results.map(item => buildCardElement(item, 'search'));
      newCards.forEach(card => grid.appendChild(card));
      addCardKebabs(newCards);
      checkLibrary(data.results, grid, newCards);
    }
    store.searchOffset += data.results.length;
    if (!append) {
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
      ${cardPlayBtn(item)}${cardRadioBtn(item)}${cardAddPlBtn(item)}${cardFavBtn(item)}<img class="top-result-img" src="${escAttr(item.image || '')}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
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
    _routeCardClick(it, fromPage);
  });
  _wireAddPlBtn(card);
  // The shared .card-radio-btn / .card-addpl-btn rules pin these to a card's
  // bottom-LEFT, which on the tall hero lands on the name/type labels rather
  // than on cover art. Line them up to the left of the play button instead —
  // bottom-right is the corner the hero already reserves for actions.
  let right = card.querySelector('.card-play-btn') ? 52 : 8;
  ['.card-addpl-btn', '.card-radio-btn'].forEach(sel => {
    const btn = card.querySelector(sel);
    if (!btn) return;
    btn.style.left = 'auto';
    btn.style.right = right + 'px';
    right += 44;
  });
  return card;
}

// ── Compact song rows (list, not cards) — reuse card-play delegation + kebab/heart ──
// sink (optional): { items: [], cards: [] } accumulators so the caller can run a
// library-check over these rows (they carry `.card` but live outside the grid).
export function renderSongRows(tracks, sink, opts = {}) {
  const list = document.createElement('div');
  list.className = 'song-list' + (opts.numbered ? ' song-list-numbered' : '');
  tracks.forEach((item, idx) => {
    // `.card` class lets the event-delegated .card-play-btn handler (player_v3.js)
    // find this row via btn.closest('.card'); CSS re-styles it as a flat row.
    const row = document.createElement('div');
    row.className = 'song-row card';
    row.dataset.item = JSON.stringify(item);
    // Numbered mode (album detail): show the track position instead of repeating
    // the album cover on every row. hideArtist drops the redundant per-track
    // artist line when every track shares the album's artist.
    const lead = opts.numbered
      ? `<div class="song-num">${esc(String(item.track_number || (idx + 1)))}</div>`
      : `<img class="song-thumb" src="${escAttr(item.image || '')}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">`;
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
    row.appendChild(makeHeartButton(item));
    row.addEventListener('click', (e) => {
      if (wasLongPress()) return;
      if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-addpl-btn')
          || e.target.closest('.kebab-btn') || e.target.closest('.like-btn')) return;
      let it;
      try { it = JSON.parse(row.dataset.item); } catch { return; }
      openModal(it);
    });
    list.appendChild(row);
    if (sink) { sink.items.push(item); sink.cards.push(row); }
  });
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

// ── All-mode aggregated search (Spotify-style sections) ──
async function doSearchAll() {
  const { gen, signal } = _beginSearch();
  const q = $('#searchInput').value.trim();
  const resultsEl = $('#searchResults');
  if (!q) { resultsEl.innerHTML = ''; store.searchLoading = false; saveSearchState(); return; }
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
    const tracks = _withoutTop(top, Array.isArray(data.tracks) ? data.tracks : []);
    // Artists only: same-name albums/playlists are frequently distinct releases
    // or distinct user playlists, so collapsing them would hide real results.
    const artists = _dedupeByName(_withoutTop(top, Array.isArray(data.artists) ? data.artists : []));
    const albums = _withoutTop(top, Array.isArray(data.albums) ? data.albums : []);
    const playlists = _withoutTop(top, Array.isArray(data.playlists) ? data.playlists : []);

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
        panel.appendChild(renderSongRows(tracks.slice(0, 6), { items: allItems, cards: allCards }));
        row.appendChild(panel);
      }
      frag.appendChild(row);
    }

    // 2-4) Artists / Albums / Playlists sections
    const _section = (title, type, items) => {
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
    _section('Artists', 'artist', artists);
    _section('Albums', 'album', albums);
    _section('Playlists', 'playlist', playlists);

    if (!top && !tracks.length && !artists.length && !albums.length && !playlists.length) {
      resultsEl.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
    } else {
      resultsEl.innerHTML = '';
      resultsEl.appendChild(frag);
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

// ── Init (called from app.js) ──
export function init() {
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
    $('#searchClear').style.display = $('#searchInput').value ? 'block' : 'none';
    _setKbdActive(-1);
    renderRecentSearches();
    store.searchTimeout = setTimeout(doSearch, 400);
  });
  // Recent-search chips appear when the input is focused and empty.
  $('#searchInput').addEventListener('focus', renderRecentSearches);
  $('#searchInput').addEventListener('blur', () => {
    // Delay so a chip click (which blurs the input) still registers.
    setTimeout(() => { const w = $('#recentSearches'); if (w) w.style.display = 'none'; }, 150);
  });
  $('#searchInput').addEventListener('keydown', _handleSearchKeydown);
  $('#searchClear').addEventListener('click', () => {
    // Invalidate any in-flight search so it can't repaint results (or re-show
    // this button) under a now-empty input.
    _cancelSearch();
    $('#searchInput').value = '';
    $('#searchClear').style.display = 'none';
    $('#searchResults').innerHTML = '';
    store.searchQuery = '';
    store.searchHasMore = false;
    _setKbdActive(-1);
    saveSearchState();
    autoFocus($('#searchInput'));
    renderRecentSearches();
  });

  $$('.type-btn[data-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.type-btn[data-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.searchType = btn.dataset.type;
      doSearch();
    });
  });

  // Infinite scroll (search part)
  window.addEventListener('scroll', () => {
    const scrollBottom = window.innerHeight + window.scrollY;
    if (scrollBottom < document.body.offsetHeight - 300) return;

    if (store.currentPage === 'search' && !store.searchLoading && store.searchHasMore && store.searchQuery) {
      doSearch(true);
    }
  });
}
