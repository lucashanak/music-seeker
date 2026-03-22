// search.js — doSearch, renderResults, checkLibrary, renderCards, infinite scroll, card helpers

import { store } from './store.js';
import { $, $$, esc, formatDuration } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { loadPlaylistDetail, loadShowDetail, loadArtistDetail } from './spotify.js';

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
    let html = `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
    if (album) html += ` · <span class="clickable" data-search-type="album" data-search-q="${esc(album)}">${esc(album)}</span>`;
    return html;
  }
  if ((type === 'album' || type === 'episode') && artist) {
    return `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
  }
  return esc(artist);
}

// ── Render Results ──
export function renderResults(items, container, fromPage) {
  const el = $(container);
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><p>No results found</p></div>';
    return;
  }
  el.innerHTML = items.map(item => `
    <div class="card" data-item='${JSON.stringify(item).replace(/'/g, "&#39;")}'>
      ${cardPlayBtn(item)}${cardDlBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
      <div class="card-body">
        <div class="card-title">${esc(item.name)}</div>
        <div class="card-sub">${cardSubHtml(item)}</div>
        <div class="card-meta">
          ${item.year ? `<span>${item.year}</span>` : ''}
          ${item.total_tracks ? `<span>${item.total_tracks} ${item.type === 'show' ? 'episodes' : 'tracks'}</span>` : ''}
          ${item.release_date ? `<span>${item.release_date}</span>` : ''}
          ${item.duration_ms ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $$('.card', el).forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
      const item = JSON.parse(card.dataset.item);
      if (item.type === 'playlist' && item.id) {
        loadPlaylistDetail(item.id, item.url, fromPage);
      } else if (item.type === 'show' && item.id) {
        loadShowDetail(item.id, item.url, fromPage, item.feed_url);
      } else if (item.type === 'artist' && item.id) {
        loadArtistDetail(item.id, fromPage);
      } else {
        openModal(item);
      }
    });
  });
  checkLibrary(items, el);
}

// ── Library Check ──
// cards: optional array of card elements to check (must align 1:1 with items).
// If omitted, all .card children of containerEl are used.
export async function checkLibrary(items, containerEl, cards) {
  try {
    const checkItems = items.map(item => ({ name: item.name, artist: item.artist || '', type: item.type || 'track' }));
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
        const dlBtn = cards[i].querySelector('.card-dl-btn');
        if (dlBtn) {
          dlBtn.disabled = true;
          dlBtn.style.opacity = '0.3';
          dlBtn.title = 'Already in library';
        }
        const item = JSON.parse(cards[i].dataset.item);
        item.inLibrary = true;
        cards[i].dataset.item = JSON.stringify(item).replace(/'/g, "&#39;");
      }
    });
  } catch {}
}

// ── Do Search ──
export async function doSearch(append) {
  const q = $('#searchInput').value.trim();
  if (!q) { $('#searchResults').innerHTML = ''; return; }
  if (!append) {
    store.searchOffset = 0;
    store.searchHasMore = true;
    store.searchQuery = q;
    $('#searchResults').innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  }
  store.searchLoading = true;
  $('#searchLoadMore').style.display = '';
  try {
    const data = await apiJson(`/api/search?q=${encodeURIComponent(q)}&type=${store.searchType}&limit=20&offset=${store.searchOffset}`);
    if (data.results.length < 20) store.searchHasMore = false;
    if (!append) {
      renderResults(data.results, '#searchResults', 'search');
    } else {
      const grid = $('#searchResults');
      const fragment = document.createElement('div');
      fragment.innerHTML = data.results.map(item => `
        <div class="card" data-item='${JSON.stringify(item).replace(/'/g, "&#39;")}'>
          ${cardPlayBtn(item)}${cardDlBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
          <div class="card-body">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${cardSubHtml(item)}</div>
            <div class="card-meta">
              ${item.year ? `<span>${item.year}</span>` : ''}
              ${item.total_tracks ? `<span>${item.total_tracks} ${item.type === 'show' ? 'episodes' : 'tracks'}</span>` : ''}
              ${item.release_date ? `<span>${item.release_date}</span>` : ''}
              ${item.duration_ms ? `<span>${formatDuration(item.duration_ms)}</span>` : ''}
            </div>
          </div>
        </div>
      `).join('');
      const newCards = Array.from(fragment.children);
      newCards.forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
          const item = JSON.parse(card.dataset.item);
          if (item.type === 'playlist' && item.id) {
            loadPlaylistDetail(item.id, item.url, 'search');
          } else if (item.type === 'show' && item.id) {
            loadShowDetail(item.id, item.url, 'search', item.feed_url);
          } else if (item.type === 'artist' && item.id) {
            loadArtistDetail(item.id, 'search');
          } else {
            openModal(item);
          }
        });
        grid.appendChild(card);
      });
      checkLibrary(data.results, grid, newCards);
    }
    store.searchOffset += data.results.length;
  } catch (e) {
    if (!append) $('#searchResults').innerHTML = `<div class="empty-state"><p>Search failed: ${e.message}</p></div>`;
  }
  store.searchLoading = false;
  $('#searchLoadMore').style.display = 'none';
}

// ── Init (called from app.js) ──
export function init() {
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(store.searchTimeout);
    $('#searchClear').style.display = $('#searchInput').value ? '' : 'none';
    store.searchTimeout = setTimeout(doSearch, 400);
  });
  $('#searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { clearTimeout(store.searchTimeout); doSearch(); }
  });
  $('#searchClear').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#searchClear').style.display = 'none';
    $('#searchResults').innerHTML = '';
    store.searchQuery = '';
    store.searchHasMore = false;
    $('#searchInput').focus();
  });

  $$('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.type-btn').forEach(b => b.classList.remove('active'));
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
