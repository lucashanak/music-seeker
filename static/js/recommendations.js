// recommendations.js — Smart recommendations in full player queue side + auto-queue

import { store } from './store.js';
import { $, $$, esc, showToast } from './utils.js';
import { apiJson } from './api.js';

let recsCache = [];
let recsLoading = false;
let recsDirty = true;
export let autoQueueEnabled = false;

// ── Load Recommendations ──
async function loadRecs() {
  if (recsLoading || !store.playerQueue.length) return;
  recsLoading = true;
  const section = $('#fpRecsSection');
  if (section) section.style.display = '';
  renderLoading();
  try {
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: { tracks: store.playerQueue.slice(-20), limit: 15 },
    });
    recsCache = data.tracks || [];
    recsDirty = false;
    renderRecs();
  } catch {
    recsCache = [];
    renderRecs();
  } finally {
    recsLoading = false;
  }
}

function renderLoading() {
  const el = $('#fpRecsList');
  if (el) el.innerHTML = Array(3).fill('<div class="skeleton" style="height:48px;border-radius:8px;margin-bottom:6px;"></div>').join('');
}

function renderRecs() {
  const el = $('#fpRecsList');
  if (!el) return;
  if (!recsCache.length) {
    el.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">No recommendations available</div>';
    return;
  }
  el.innerHTML = recsCache.map((t, i) => `
    <div class="rec-item" data-rec-idx="${i}">
      <img class="rec-img" src="${t.image || ''}" alt="" loading="lazy">
      <div class="rec-info">
        <div class="rec-name">${esc(t.name || '')}</div>
        <div class="rec-artist">${esc(t.artist || '')}</div>
      </div>
      <div class="rec-actions">
        <button class="rec-add-queue" title="Add to queue" data-rec-idx="${i}">+</button>
        <button class="rec-add-playlist" title="Add to Navidrome playlist" data-rec-idx="${i}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </button>
      </div>
    </div>`).join('');

  $$('.rec-add-queue', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = recsCache[btn.dataset.recIdx];
      if (!track) return;
      import('./player.js').then(m => m.addToQueue([track]));
      recsCache.splice(parseInt(btn.dataset.recIdx), 1);
      renderRecs();
    });
  });

  $$('.rec-add-playlist', el).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const track = recsCache[btn.dataset.recIdx];
      if (!track) return;
      try {
        const data = await apiJson('/api/library/playlists');
        const playlists = data.playlists || [];
        if (!playlists.length) { showToast('No Navidrome playlists'); return; }
        const names = playlists.map(p => p.name);
        const choice = prompt('Add to playlist:\n' + names.map((n, i) => `${i + 1}. ${n}`).join('\n') + '\n\nEnter number:');
        if (!choice) return;
        const idx = parseInt(choice) - 1;
        if (idx < 0 || idx >= playlists.length) return;
        await apiJson(`/api/library/playlist/${playlists[idx].id}/add-by-name`, {
          method: 'POST',
          body: { name: track.name, artist: track.artist, album: track.album || '' },
        });
        showToast(`Added to ${playlists[idx].name}`);
      } catch (e) {
        showToast(e.message || 'Failed to add to playlist');
      }
    });
  });
}

// ── Called when full player opens ──
export function onPanelOpened() {
  if (!store.fullPlayerOpen || !store.playerQueue.length) return;
  if (recsDirty || !recsCache.length) {
    loadRecs();
  } else {
    const section = $('#fpRecsSection');
    if (section) section.style.display = '';
    renderRecs();
  }
}

// ── Auto-queue: called when queue runs out ──
export async function autoFillQueue() {
  if (!autoQueueEnabled || recsLoading) return false;
  if (recsCache.length) {
    const track = recsCache.shift();
    import('./player.js').then(m => m.addToQueue([track], true));
    renderRecs();
    return true;
  }
  if (store.playerQueue.length) {
    recsDirty = true;
    await loadRecs();
    if (recsCache.length) {
      const track = recsCache.shift();
      import('./player.js').then(m => m.addToQueue([track], true));
      renderRecs();
      return true;
    }
  }
  return false;
}

// ── Mark cache as dirty on queue change ──
export function onQueueChanged() {
  recsDirty = true;
}

// ── Init ──
export function init() {
  const el = $('#autoQueueToggle');
  if (el) el.addEventListener('change', (e) => {
    autoQueueEnabled = e.target.checked;
  });
}
