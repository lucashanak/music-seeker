// discover.js — Tags cloud, tag results, loadTags

import { store } from './store.js';
import { $, $$, esc, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderResults, checkLibrary, cardPlayBtn, cardDlBtn, cardRadioBtn, cardFavBtn, cardSubHtml } from './search.js';

// ── Load Tags ──
export async function loadTags() {
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
    store.currentTag = tag;
    store.discoverTagType = type || 'track';
    store.tagPage = 1;
    store.tagHasMore = true;
    store.allTagResults = [];
    $('#tagCloudView').style.display = 'none';
    $('#tagDetailView').style.display = '';
    history.pushState({ layer: 'tagDetail' }, '');
    $('#tagDetailName').textContent = tag;
    $('#tagFilter').value = '';
    $$('[data-tagtype]').forEach(b => b.classList.toggle('active', b.dataset.tagtype === store.discoverTagType));
    $('#tagResults').innerHTML = Array(8).fill('<div class="skeleton skeleton-card"></div>').join('');
  }
  store.tagLoading = true;
  $('#tagLoadMore').style.display = '';
  try {
    const data = await apiJson(`/api/discover/tag/${encodeURIComponent(tag)}?type=${store.discoverTagType}&limit=20&page=${store.tagPage}`);
    if (data.results.length < 20) store.tagHasMore = false;
    store.allTagResults = store.allTagResults.concat(data.results);
    if (!append) {
      renderResults(store.allTagResults, '#tagResults', 'discover');
    } else {
      const grid = $('#tagResults');
      const fragment = document.createElement('div');
      fragment.innerHTML = data.results.map(item => `
        <div class="card" data-item='${JSON.stringify(item).replace(/'/g, "&#39;")}'>
          ${cardPlayBtn(item)}${cardDlBtn(item)}${cardRadioBtn(item)}${cardFavBtn(item)}<img class="card-img" src="${item.image || ''}" alt="" loading="lazy" onerror="this.style.background='var(--bg-elevated)'">
          <div class="card-body">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${cardSubHtml(item)}</div>
            <div class="card-meta"></div>
          </div>
        </div>
      `).join('');
      Array.from(fragment.children).forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.clickable') || e.target.closest('.card-play-btn') || e.target.closest('.card-dl-btn') || e.target.closest('.card-radio-btn') || e.target.closest('.card-fav-btn')) return;
          openModal(JSON.parse(card.dataset.item));
        });
        grid.appendChild(card);
      });
      checkLibrary(data.results, grid);
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
