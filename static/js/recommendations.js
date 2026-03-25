// recommendations.js — Virtual recommendation queue (plays after main queue ends)

import { store } from './store.js';
import { $, $$, esc, showToast, showPlaylistPicker } from './utils.js';
import { apiJson } from './api.js';

let recsCache = [];
let recsLoading = false;
let recsDirty = true;
let recsPlayingIdx = -1; // -1 = not playing from recs

export function isPlayingRec() { return recsPlayingIdx >= 0; }

// ── Play next rec (called from player.js when queue ends) ──
export async function playNextRec() {
  // If already playing recs, advance to next
  if (recsPlayingIdx >= 0) {
    recsPlayingIdx++;
  } else {
    recsPlayingIdx = 0;
  }

  // Need to load recs?
  if (!recsCache.length || recsPlayingIdx >= recsCache.length) {
    if (store.playerQueue.length) {
      recsDirty = true;
      await loadRecs();
      recsPlayingIdx = 0;
    }
    if (!recsCache.length) {
      recsPlayingIdx = -1;
      return false;
    }
  }

  const track = recsCache[recsPlayingIdx];
  if (!track) { recsPlayingIdx = -1; return false; }

  // Play directly via player without adding to queue
  import('./player.js').then(m => m.playRecTrack(track));
  renderRecs();
  return true;
}

// ── Stop virtual rec playback (when user interacts with queue) ──
export function stopRecPlayback() {
  recsPlayingIdx = -1;
  renderRecs();
}

// ── Load Recommendations ──
async function loadRecs() {
  if (recsLoading || !store.playerQueue.length) return;
  recsLoading = true;
  renderLoading();
  try {
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: { tracks: store.playerQueue.slice(-20), limit: 10 },
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

function _ensureRecsIn(queueListEl) {
  if (!queueListEl) return null;
  let list = queueListEl.querySelector('.recs-list');
  if (list) return list;
  const section = document.createElement('div');
  section.className = 'recs-section';
  section.innerHTML = `<div class="panel-header" style="font-size:13px;border-top:1px solid var(--border);padding-top:12px;">Recommended</div><div class="recs-list"></div>`;
  queueListEl.appendChild(section);
  return section.querySelector('.recs-list');
}

function _getAllRecsContainers() {
  // Desktop queue side + mobile queue panel
  const containers = [];
  const desktop = _ensureRecsIn($('#fpQueueList'));
  if (desktop) containers.push(desktop);
  const mobile = _ensureRecsIn($('#fpQueuePanelList'));
  if (mobile) containers.push(mobile);
  return containers;
}

function renderLoading() {
  _getAllRecsContainers().forEach(el => {
    el.innerHTML = Array(3).fill('<div class="skeleton" style="height:48px;border-radius:8px;margin-bottom:6px;"></div>').join('');
  });
}

function _recsHtml() {
  if (!recsCache.length) {
    return '<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">No recommendations available</div>';
  }
  return recsCache.map((t, i) => `
    <div class="rec-item${i === recsPlayingIdx ? ' rec-playing' : ''}" data-rec-idx="${i}">
      <span class="rec-num">${i === recsPlayingIdx ? '&#9654;' : ''}</span>
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
}

function _attachRecsHandlers(el) {
  // Click on rec = play it directly (virtual, not added to queue)
  $$('.rec-item', el).forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.rec-add-queue') || e.target.closest('.rec-add-playlist')) return;
      const idx = parseInt(item.dataset.recIdx);
      const track = recsCache[idx];
      if (!track) return;
      recsPlayingIdx = idx;
      import('./player.js').then(m => m.playRecTrack(track));
      renderRecs();
    });
  });
  // "+" = add to actual queue
  $$('.rec-add-queue', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = recsCache[btn.dataset.recIdx];
      if (!track) return;
      import('./player.js').then(m => m.addToQueue([track]));
    });
  });
  // Playlist icon = add to Navidrome playlist
  $$('.rec-add-playlist', el).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const track = recsCache[btn.dataset.recIdx];
      if (!track) return;
      try {
        const data = await apiJson('/api/library/playlists');
        const playlists = data.playlists || [];
        if (!playlists.length) { showToast('No Navidrome playlists'); return; }
        const picked = await showPlaylistPicker(playlists);
        if (!picked || !picked.length) return;
        for (const pl of picked) {
          await apiJson(`/api/library/playlist/${pl.id}/add-and-download`, {
            method: 'POST',
            body: { name: track.name, artist: track.artist, album: track.album || '' },
          });
        }
        showToast(`Added to ${picked.map(p => p.name).join(', ')}`);
      } catch (e) {
        showToast(e.message || 'Failed to add to playlist');
      }
    });
  });
}

function renderRecs() {
  const html = _recsHtml();
  _getAllRecsContainers().forEach(el => {
    el.innerHTML = html;
    _attachRecsHandlers(el);
  });
}

// ── Re-append recs to queue list after queue re-render ──
export function hasRecs() { return recsCache.length > 0 || recsLoading; }
export function appendRecsToQueue() { renderRecs(); }

// ── Called when full player or queue panel opens ──
export function onPanelOpened() {
  if (!store.playerQueue.length) return;
  if (recsDirty || !recsCache.length) {
    loadRecs();
  } else {
    renderRecs();
  }
}

// ── Mark cache as dirty on queue change ──
export function onQueueChanged() {
  recsDirty = true;
}

// ── Init ──
export function init() {}
