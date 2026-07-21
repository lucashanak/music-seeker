// bpm.js — BPM badges, filtering, and playlist analysis

import { $, $$, showToast } from './utils.js';
import { apiJson } from './api.js';

// In-memory BPM cache (artist::name → bpm data)
const _cache = {};

// Below this confidence a cached BPM is treated as "low confidence". When the
// "include low-confidence" toggle is OFF, such tracks behave like unknown-BPM
// for filtering/play purposes. Keep in sync with the DJ engine's expectations.
const CONF_FLOOR = 0.5;

// Coverage threshold: if more than this fraction of a list's tracks have no
// known BPM, the tempo controls render disabled (owned-only reality).
const LOW_COVERAGE_RATIO = 0.8;

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

/**
 * Bulk-hydrate the BPM cache for an arbitrary track list (album / Spotify
 * playlist / search) in ONE cached-only request — avoids N slow serial calls.
 * Populates _cache using the same loop as fetchPlaylistBpm. Returns the raw
 * response or null on failure.
 */
export async function hydrateBpmByName(tracks) {
  if (!tracks || !tracks.length) return null;
  const payload = tracks
    .filter(t => t && (!t.type || t.type === 'track'))
    .map(t => ({ name: t.name || '', artist: t.artist || '' }));
  if (!payload.length) return null;
  try {
    const data = await apiJson('/api/bpm/lookup-by-name', {
      method: 'POST',
      body: { tracks: payload },
    });
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

/**
 * BPM usable for filtering. When includeLowConf is false, a cached entry whose
 * confidence is below CONF_FLOOR is treated as unknown (returns null), so shaky
 * detections don't silently pollute a tempo subset. Legacy entries without a
 * confidence field are treated as low-confidence (0) rather than silently trusted.
 */
function _effectiveBpm(name, artist, includeLowConf) {
  const entry = _cache[_key(name, artist)];
  if (!entry || entry.bpm == null) return null;
  const conf = entry.confidence == null ? 0 : entry.confidence;
  if (!includeLowConf && conf < CONF_FLOOR) return null;
  return entry.bpm;
}

/**
 * Coverage stats for a rendered track container.
 * Returns { total, known, noBpm } where `total` counts only track cards.
 * `known` respects the include-low-confidence flag (default true).
 */
export function coverageSummary(containerId, includeLowConf = true) {
  const container = typeof containerId === 'string' ? $(containerId) : containerId;
  let total = 0, known = 0;
  if (container) {
    $$('.card', container).forEach(card => {
      if (!card.dataset.item) return;
      let item;
      try { item = JSON.parse(card.dataset.item); } catch { return; }
      if (item.type && item.type !== 'track') return;
      total++;
      if (_effectiveBpm(item.name, item.artist, includeLowConf) != null) known++;
    });
  }
  return { total, known, noBpm: total - known };
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
      if (card.querySelector('.bpm-badge')) continue;
      const badge = document.createElement('span');
      badge.className = 'bpm-badge';
      badge.textContent = `${Math.round(bpm)} BPM`;
      const meta = card.querySelector('.card-meta');
      if (meta) {
        meta.prepend(badge);
      } else {
        // Flat song-row (album/playlist list) has no .card-meta — sit the badge
        // next to the duration on the right of the row.
        const dur = card.querySelector('.song-duration');
        if (!dur) continue;
        dur.parentNode.insertBefore(badge, dur);
      }
    } catch {}
  }
}

/**
 * Build BPM filter bar.
 * @param {string} tracksContainerId  selector for the track-card container.
 * @param {object} [opts]
 *   - allowAnalyze {boolean=true}: show the "Analyze" action in the not-analyzed
 *     toast. Set false for unowned views where on-demand analysis mostly 404s.
 */
export function createBpmFilter(tracksContainerId, opts = {}) {
  const allowAnalyze = opts.allowAnalyze !== false;
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
    <span class="bpm-filter-sep">|</span>
    <button class="bpm-preset" id="bpmPlayFiltered">&#9654; Play filtered</button>
    <button class="bpm-preset" id="bpmPlayRamp">&#9654; Play slow&rarr;fast</button>
    <span class="bpm-filter-sep">|</span>
    <label class="bpm-lowconf-label" title="Include tracks whose BPM detection is low-confidence">
      <input type="checkbox" id="bpmLowConf" checked> low-conf
    </label>
    <span class="bpm-coverage" id="bpmCoverage"></span>
  `;

  // Tracks the active bucket so the play buttons know whether to exclude
  // unknown-BPM tracks. "All" (min 0 / max 999) means include everything.
  let _activeMin = 0, _activeMax = 999;

  const _includeLowConf = () => !!el.querySelector('#bpmLowConf').checked;

  const _updateCoverage = () => {
    const cov = coverageSummary(tracksContainerId, _includeLowConf());
    const badge = el.querySelector('#bpmCoverage');
    if (!badge) return;
    if (!cov.total) { badge.textContent = ''; return; }
    badge.textContent = `BPM known for ${cov.known}/${cov.total}` +
      (cov.noBpm ? ` (${cov.noBpm} no BPM)` : '');
  };

  const apply = (min, max) => {
    _activeMin = min; _activeMax = max;
    const container = $(tracksContainerId);
    if (!container) return;
    const inc = _includeLowConf();
    $$('.card', container).forEach(card => {
      if (!card.dataset.item) return;
      try {
        const item = JSON.parse(card.dataset.item);
        const bpm = _effectiveBpm(item.name, item.artist, inc);
        card.style.display = (bpm == null || (bpm >= min && bpm <= max)) ? '' : 'none';
      } catch {}
    });
  };

  el.querySelectorAll('.bpm-preset').forEach(btn => {
    if (btn.id === 'bpmPlayFiltered' || btn.id === 'bpmPlayRamp') return;
    btn.addEventListener('click', () => {
      el.querySelectorAll('.bpm-preset').forEach(b => {
        if (b.id === 'bpmPlayFiltered' || b.id === 'bpmPlayRamp') return;
        b.classList.remove('active');
      });
      btn.classList.add('active');
      const min = parseInt(btn.dataset.min), max = parseInt(btn.dataset.max);
      el.querySelector('#bpmMin').value = min > 0 ? min : '';
      el.querySelector('#bpmMax').value = max < 999 ? max : '';
      apply(min, max);
    });
  });

  const onRange = () => {
    el.querySelectorAll('.bpm-preset').forEach(b => {
      if (b.id === 'bpmPlayFiltered' || b.id === 'bpmPlayRamp') return;
      b.classList.remove('active');
    });
    apply(parseInt(el.querySelector('#bpmMin').value) || 0,
          parseInt(el.querySelector('#bpmMax').value) || 999);
  };
  el.querySelector('#bpmMin').addEventListener('input', onRange);
  el.querySelector('#bpmMax').addEventListener('input', onRange);

  // Re-apply current filter (low-conf membership may change) + refresh coverage.
  el.querySelector('#bpmLowConf').addEventListener('change', () => {
    apply(_activeMin, _activeMax);
    _updateCoverage();
  });

  // ── Collect the currently-visible (filtered) tracks from the DOM. ──
  const _visibleTracks = () => {
    const container = $(tracksContainerId);
    if (!container) return [];
    return $$('.card', container)
      .filter(card => card.style.display !== 'none' && card.dataset.item)
      .map(card => { try { return JSON.parse(card.dataset.item); } catch { return null; } })
      .filter(Boolean);
  };

  // Whether a non-"All" bucket/range is active (so unknown-BPM tracks are excluded).
  const _filterActive = () => !(_activeMin <= 0 && _activeMax >= 999);

  // Apply the unknown-BPM exclusion policy and surface an Analyze toast for any
  // tracks that were dropped because they have no usable (per low-conf) BPM.
  const _applyUnknownPolicy = (tracks) => {
    if (!_filterActive()) return tracks;
    const inc = _includeLowConf();
    const kept = [], dropped = [];
    for (const t of tracks) {
      if (_effectiveBpm(t.name, t.artist, inc) == null) dropped.push(t); else kept.push(t);
    }
    if (dropped.length) {
      const msg = `${dropped.length} tracks not analyzed`;
      if (allowAnalyze) _showAnalyzeToast(msg, () => _analyzeContainer(tracksContainerId));
      else showToast('BPM only available for tracks in your library');
    }
    return kept;
  };

  el.querySelector('#bpmPlayFiltered').addEventListener('click', async () => {
    const tracks = _applyUnknownPolicy(_visibleTracks());
    if (!tracks.length) { showToast('No tracks to play'); return; }
    const u = await import('./upnext.js');
    u.playTracks(tracks);
  });

  el.querySelector('#bpmPlayRamp').addEventListener('click', async () => {
    // Tempo ramp: drop unusable BPM, sort ascending by cached BPM.
    const inc = _includeLowConf();
    const tracks = _visibleTracks()
      .map(t => ({ t, bpm: _effectiveBpm(t.name, t.artist, inc) }))
      .filter(x => x.bpm != null)
      .sort((a, b) => a.bpm - b.bpm)
      .map(x => x.t);
    if (!tracks.length) {
      if (allowAnalyze) _showAnalyzeToast('No analyzed tracks to ramp', () => _analyzeContainer(tracksContainerId));
      else showToast('BPM only available for tracks in your library');
      return;
    }
    const u = await import('./upnext.js');
    u.playTracks(tracks);
  });

  // Expose a coverage refresher so callers can update the badge after hydration.
  el._refreshCoverage = _updateCoverage;
  _updateCoverage();

  return el;
}

/**
 * Mount the tempo filter above a track container, following the library.js
 * insertion pattern. Feasibility-aware: if BPM coverage is too low the controls
 * render disabled with an explanatory note (owned-only reality). Call AFTER
 * hydrateBpmByName + addBpmBadges so coverage is accurate.
 * @param {string} tracksContainerId  selector for the track container.
 * @param {object} [opts]  forwarded to createBpmFilter (e.g. allowAnalyze).
 * @returns {HTMLElement|null} the inserted filter element.
 */
export function initTempoFilter(tracksContainerId, opts = {}) {
  const tracksEl = $(tracksContainerId);
  if (!tracksEl || !tracksEl.parentNode) return null;
  // Remove any prior filter bar for this container (idempotent re-mount).
  const prev = tracksEl.parentNode.querySelector(':scope > .bpm-filter');
  if (prev) prev.remove();

  const filter = createBpmFilter(tracksContainerId, opts);

  // Read the checkbox's default state (CHECKED = include low-conf) so the gate
  // uses the same policy as the filter and badge — one consistent includeLowConf.
  const filterCheckbox = filter.querySelector('#bpmLowConf');
  const includeLowConfDefault = filterCheckbox ? filterCheckbox.checked : true;
  const cov = coverageSummary(tracksContainerId, includeLowConfDefault);
  const lowCoverage = cov.total > 0 && (cov.noBpm / cov.total) > LOW_COVERAGE_RATIO;
  if (lowCoverage) {
    // Disable interactive controls; keep coverage badge visible.
    filter.classList.add('bpm-filter-disabled');
    filter.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
    const note = document.createElement('span');
    note.className = 'bpm-filter-note';
    note.textContent = 'Tempo filter needs analyzed local tracks';
    filter.appendChild(note);
  }

  tracksEl.parentNode.insertBefore(filter, tracksEl);
  return filter;
}

// Toast with an "Analyze" action button (showToast has no action support).
function _showAnalyzeToast(msg, onAnalyze) {
  let toast = $('#bpmActionToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'bpmActionToast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--bg-elevated);color:var(--text);padding:10px 16px;border-radius:20px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s;border:1px solid var(--border);display:flex;align-items:center;gap:12px;';
    document.body.appendChild(toast);
  }
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.textContent = 'Analyze';
  btn.style.cssText = 'background:var(--accent);color:#000;border:none;border-radius:14px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;';
  btn.addEventListener('click', () => { toast.style.opacity = '0'; onAnalyze && onAnalyze(); });
  toast.appendChild(span);
  toast.appendChild(btn);
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 5000);
}

// Trigger the existing Analyze flow by clicking the on-screen scan button if
// present; otherwise fall back to analyzing every un-analyzed track in-place.
async function _analyzeContainer(tracksContainerId) {
  const scanBtn = $('#bpmScanBtn');
  if (scanBtn && !scanBtn.disabled) { scanBtn.click(); return; }
  const cards = $$('.card', $(tracksContainerId));
  for (const card of cards) {
    if (!card.dataset.item) continue;
    try {
      const item = JSON.parse(card.dataset.item);
      if (item.type && item.type !== 'track') continue;
      if (getCachedBpm(item.name, item.artist) != null) continue;
      await fetchTrackBpm(item.name, item.artist);
      addBpmBadges(tracksContainerId); // live badge progress as each track resolves
    } catch {}
  }
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
    const CONCURRENT = 4;
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

function _dec(s) { if (!s || !s.includes('&')) return s; const e = document.createElement('textarea'); e.innerHTML = s; return e.value; }
function _key(name, artist) {
  return `${_dec((artist || '')).toLowerCase().trim()}::${_dec((name || '')).toLowerCase().trim()}`;
}
