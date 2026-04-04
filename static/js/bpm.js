// bpm.js — BPM badges, filtering, and playlist analysis

import { $, $$, showToast } from './utils.js';
import { apiJson } from './api.js';

// In-memory BPM cache (artist::name → bpm data)
const _cache = {};

/** Fetch cached BPM data for a playlist (no analysis, fast). */
export async function fetchPlaylistBpm(playlistId) {
  try {
    const data = await apiJson(`/api/bpm/playlist/${playlistId}`);
    if (data && data.tracks) {
      for (const t of data.tracks) _cache[_key(t.name, t.artist)] = t;
    }
    return data;
  } catch { return null; }
}

/** Get cached BPM for a track. Returns number or null. */
export function getCachedBpm(name, artist) {
  const entry = _cache[_key(name, artist)];
  return entry ? entry.bpm : null;
}

/** Get full cached DJ data (bpm, key, camelot, beat_grid). Returns object or null. */
export function getDjData(name, artist) {
  return _cache[_key(name, artist)] || null;
}

/** Fetch and cache BPM/DJ data for a single track. Triggers server analysis if needed. */
export async function fetchTrackBpm(name, artist) {
  const key = _key(name, artist);
  if (_cache[key]) return _cache[key];
  try {
    const data = await apiJson(`/api/bpm/track?name=${encodeURIComponent(name)}&artist=${encodeURIComponent(artist)}`);
    if (data && data.bpm) {
      _cache[key] = data;
      return data;
    }
  } catch {}
  return null;
}

/** Add BPM badges to rendered cards in a container. */
export function addBpmBadges(container) {
  const cards = $$(`.card`, typeof container === 'string' ? $(container) : container);
  for (const card of cards) {
    if (!card.dataset.item) continue;
    try {
      const item = JSON.parse(card.dataset.item);
      if (item.type && item.type !== 'track') continue;
      const bpm = getCachedBpm(item.name, item.artist);
      if (bpm == null) continue;
      const meta = card.querySelector('.card-meta');
      if (!meta || meta.querySelector('.bpm-badge')) continue;
      const badge = document.createElement('span');
      badge.className = 'bpm-badge';
      badge.textContent = `${Math.round(bpm)} BPM`;
      meta.prepend(badge);
    } catch {}
  }
}

/** Build BPM filter bar. */
export function createBpmFilter(tracksContainerId) {
  const el = document.createElement('div');
  el.className = 'bpm-filter';
  el.innerHTML = `
    <button class="bpm-preset active" data-min="0" data-max="999">All</button>
    <button class="bpm-preset" data-min="60" data-max="90">Slow &lt;90</button>
    <button class="bpm-preset" data-min="90" data-max="110">Mid 90-110</button>
    <button class="bpm-preset" data-min="110" data-max="150">Fast 110+</button>
    <span class="bpm-filter-sep">|</span>
    <label class="bpm-range-label">
      <input type="number" class="bpm-range-input" id="bpmMin" min="40" max="200" placeholder="Min">
      &ndash;
      <input type="number" class="bpm-range-input" id="bpmMax" min="40" max="200" placeholder="Max">
    </label>
  `;

  const apply = (min, max) => {
    const container = $(tracksContainerId);
    if (!container) return;
    $$('.card', container).forEach(card => {
      if (!card.dataset.item) return;
      try {
        const item = JSON.parse(card.dataset.item);
        const bpm = getCachedBpm(item.name, item.artist);
        card.style.display = (bpm == null || (bpm >= min && bpm <= max)) ? '' : 'none';
      } catch {}
    });
  };

  el.querySelectorAll('.bpm-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.bpm-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const min = parseInt(btn.dataset.min), max = parseInt(btn.dataset.max);
      el.querySelector('#bpmMin').value = min > 0 ? min : '';
      el.querySelector('#bpmMax').value = max < 999 ? max : '';
      apply(min, max);
    });
  });

  const onRange = () => {
    el.querySelectorAll('.bpm-preset').forEach(b => b.classList.remove('active'));
    apply(parseInt(el.querySelector('#bpmMin').value) || 0,
          parseInt(el.querySelector('#bpmMax').value) || 999);
  };
  el.querySelector('#bpmMin').addEventListener('input', onRange);
  el.querySelector('#bpmMax').addEventListener('input', onRange);

  return el;
}

/** Add "Analyze BPM" button — fires 6 concurrent per-track requests for real-time progress. */
export function addScanButton(heroActions, playlistId, tracksContainerId) {
  const old = $('#bpmScanBtn');
  if (old) old.remove();
  const btn = document.createElement('button');
  btn.id = 'bpmScanBtn';
  btn.className = 'bpm-preset';
  btn.textContent = 'Analyze BPM';

  btn.addEventListener('click', async () => {
    btn.disabled = true;

    // Collect tracks that need analysis
    const cards = $$('.card', $(tracksContainerId));
    const toAnalyze = [];
    for (const card of cards) {
      if (!card.dataset.item) continue;
      try {
        const item = JSON.parse(card.dataset.item);
        if (item.type && item.type !== 'track') continue;
        if (getCachedBpm(item.name, item.artist) != null) continue;
        toAnalyze.push(item);
      } catch {}
    }

    if (!toAnalyze.length) {
      showToast('All tracks already analyzed');
      btn.disabled = false;
      return;
    }

    let done = 0;
    const total = toAnalyze.length;
    btn.textContent = `0 / ${total}`;

    // Analyze single track, update UI on completion
    const analyzeOne = async (item) => {
      try {
        const url = `/api/bpm/track?name=${encodeURIComponent(item.name)}&artist=${encodeURIComponent(item.artist || '')}&song_id=${item.id || ''}`;
        const data = await apiJson(url);
        if (data && data.bpm != null) {
          _cache[_key(data.name || item.name, data.artist || item.artist)] = data;
          addBpmBadges(tracksContainerId);
        }
      } catch {}
      done++;
      btn.textContent = `${done} / ${total}`;
    };

    // 12 concurrent requests (server has 6-thread pool, 12 keeps it saturated)
    const CONCURRENT = 12;
    for (let i = 0; i < total; i += CONCURRENT) {
      const batch = toAnalyze.slice(i, i + CONCURRENT);
      await Promise.all(batch.map(analyzeOne));
    }

    showToast(`Analyzed ${done} tracks`);
    btn.disabled = false;
    btn.textContent = 'Analyze BPM';
  });

  heroActions.appendChild(btn);
}

function _key(name, artist) {
  return `${(artist || '').toLowerCase().trim()}::${(name || '').toLowerCase().trim()}`;
}
