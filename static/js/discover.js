// discover.js — Tags cloud, tag results, loadTags

import { store } from './store.js';
import { $, $$, esc, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderResults, checkLibrary, addCardKebabs, cardPlayBtn, cardDlBtn, cardRadioBtn, cardFavBtn, cardSubHtml } from './search.js';
import { wasLongPress } from './contextmenu.js';

// Curated quick-access genre chips for zouk-family discovery.
// Limited to Last.fm tags that actually return tracks (verified via API):
// dropped 'brazilian zouk' (0 results) and 'soulzouk' (0); added 'zouk love' (rich).
const ZOUK_PRESETS = ['zouk', 'zouk love', 'kizomba', 'cabo love', 'tarraxinha', 'lambada', 'ghetto zouk'];

// ── Load Tags ──
export async function loadTags() {
  const presets = $('#tagPresets');
  if (presets && !presets.dataset.built) {
    presets.innerHTML = ZOUK_PRESETS.map(t =>
      `<button class="tag-chip tag-chip-preset" data-tag="${esc(t)}">${esc(t)}</button>`
    ).join('');
    $$('.tag-chip', presets).forEach(chip => {
      chip.addEventListener('click', () => loadTagResults(chip.dataset.tag));
    });
    presets.dataset.built = '1';
  }

  const cloud = $('#tagCloud');
  cloud.innerHTML = '<div class="skeleton" style="height:200px;"></div>';
  $('#tagCloudView').style.display = '';
  $('#tagDetailView').style.display = 'none';
  $('#tagFilter').value = '';
  try {
    const data = await apiJson('/api/discover/tags?limit=60');
    cloud.innerHTML = data.tags.map(t =>
      `<button class="tag-chip" data-tag="${esc(t.name)}">${esc(t.name)}<span class="tag-count">${t.count.toLocaleString()}</span></button>`
    ).join('');
    $$('.tag-chip', cloud).forEach(chip => {
      chip.addEventListener('click', () => loadTagResults(chip.dataset.tag));
    });
  } catch (e) {
    cloud.innerHTML = `<div class="empty-state"><p>${e.message || 'Failed to load tags'}</p></div>`;
  }
}

// ── Load Tag Results ──
export async function loadTagResults(tag, type, append) {
  if (!append) {
    const switchingTag = tag !== store.currentTag;
    store.currentTag = tag;
    store.discoverTagType = type || 'track';
    store.tagPage = 1;
    store.tagHasMore = true;
    store.allTagResults = [];
    // Reset discovery-mode filters when opening a different tag.
    if (switchingTag) {
      store.tagNovelty = '';
      store.tagDepth = '';
    }
    $('#tagCloudView').style.display = 'none';
    $('#tagDetailView').style.display = '';
    history.pushState({ layer: 'tagDetail' }, '');
    $('#tagDetailName').textContent = tag;
    $('#tagFilter').value = '';
    $$('[data-tagtype]').forEach(b => b.classList.toggle('active', b.dataset.tagtype === store.discoverTagType));
    $$('[data-novelty]').forEach(b => b.classList.toggle('active', b.dataset.novelty === (store.tagNovelty || '')));
    $$('[data-depth]').forEach(b => b.classList.toggle('active', b.dataset.depth === (store.tagDepth || '')));
    // Filters apply only where the backend honors them: novelty → track+album, depth → track.
    // Hide the inert toggles for the other result types.
    const novEl = $('#tagNovelty'); if (novEl) novEl.style.display = (store.discoverTagType === 'artist') ? 'none' : '';
    const depEl = $('#tagDepth'); if (depEl) depEl.style.display = (store.discoverTagType === 'track') ? '' : 'none';
    $('#tagResults').innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  }
  store.tagLoading = true;
  $('#tagLoadMore').style.display = '';
  try {
    let qs = `type=${store.discoverTagType}&limit=20&page=${store.tagPage}`;
    if (store.tagNovelty) qs += `&novelty=${store.tagNovelty}`;
    if (store.tagDepth) qs += `&depth=${store.tagDepth}`;
    const data = await apiJson(`/api/discover/tag/${encodeURIComponent(tag)}?${qs}`);
    if (data.results.length < 20) store.tagHasMore = false;
    store.allTagResults = store.allTagResults.concat(data.results);
    if (!append) {
      renderResults(store.allTagResults, '#tagResults', 'discover');
    } else {
      const grid = $('#tagResults');
      const fragment = document.createElement('div');
      fragment.innerHTML = data.results.map(item => `
        <div class="card" data-item='${JSON.stringify(item).replace(/&/g, "&amp;").replace(/'/g, "&#39;")}'>
          ${cardPlayBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
          <div class="card-body">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${cardSubHtml(item)}</div>
            <div class="card-meta"></div>
          </div>
        </div>
      `).join('');
      const newCards = Array.from(fragment.children);
      newCards.forEach(card => {
        card.addEventListener('click', (e) => {
          if (wasLongPress()) return;
          if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
          openModal(JSON.parse(card.dataset.item));
        });
        grid.appendChild(card);
      });
      addCardKebabs(newCards);
      checkLibrary(data.results, grid, newCards);
    }
    applyTagFilter();
  } catch (e) {
    if (!append) $('#tagResults').innerHTML = `<div class="empty-state"><p>${e.message || 'Failed to load'}</p></div>`;
  }
  store.tagLoading = false;
  $('#tagLoadMore').style.display = 'none';
}

function applyTagFilter() {
  const filter = $('#tagFilter').value.toLowerCase().trim();
  $$('#tagResults .card').forEach(card => {
    if (!filter) { card.style.display = ''; return; }
    const item = JSON.parse(card.dataset.item);
    const text = `${item.name} ${item.artist}`.toLowerCase();
    card.style.display = text.includes(filter) ? '' : 'none';
  });
}

export function closeTagDetail(fromPopstate) {
  $('#tagCloudView').style.display = '';
  $('#tagDetailView').style.display = 'none';
  store.currentTag = null;
  if (!fromPopstate) historyBack();
}

// ── Init ──
export function init() {
  $('#tagFilter').addEventListener('input', applyTagFilter);

  $('#backToTags').addEventListener('click', () => closeTagDetail());

  $$('[data-tagtype]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (store.currentTag) loadTagResults(store.currentTag, btn.dataset.tagtype);
    });
  });

  $$('[data-novelty]').forEach(btn => {
    btn.addEventListener('click', () => {
      store.tagNovelty = btn.dataset.novelty || '';
      $$('[data-novelty]').forEach(b => b.classList.toggle('active', b === btn));
      // Re-run with the same tag so switchingTag stays false and filters persist.
      if (store.currentTag) loadTagResults(store.currentTag, store.discoverTagType);
    });
  });

  $$('[data-depth]').forEach(btn => {
    btn.addEventListener('click', () => {
      store.tagDepth = btn.dataset.depth || '';
      $$('[data-depth]').forEach(b => b.classList.toggle('active', b === btn));
      if (store.currentTag) loadTagResults(store.currentTag, store.discoverTagType);
    });
  });

  // Infinite scroll (discover part)
  window.addEventListener('scroll', () => {
    const scrollBottom = window.innerHeight + window.scrollY;
    if (scrollBottom < document.body.offsetHeight - 300) return;

    if (store.currentPage === 'discover' && store.currentTag && !store.tagLoading && store.tagHasMore && $('#tagDetailView').style.display !== 'none') {
      store.tagPage++;
      loadTagResults(store.currentTag, store.discoverTagType, true);
    }
  });
}
