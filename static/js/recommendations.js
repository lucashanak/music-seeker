// recommendations.js — Virtual recommendation queue (plays after main queue ends)

import { store } from './store.js';
import { $, $$, esc, showToast, showPlaylistPicker } from './utils.js';
import { apiJson } from './api.js';
import { attachContextMenu, wasLongPress } from './contextmenu.js';
import { getPlayerModule } from './player_active.js';

let recsCache = [];
let recsLoading = false;
let recsDirty = true;
let recsPlayingIdx = -1; // -1 = not playing from recs

// ── Endless radio: re-seed from a sliding window of recently played recs ──
const SEED_WINDOW = 8;        // last N played/accepted recs become the drift seed
const TOPUP_THRESHOLD = 5;    // top up when fewer than this remain ahead
const MAX_DRIFT_STEPS = 6;    // after this many top-ups, re-anchor to original seed
let _originalSeed = [];       // snapshot of the queue that started the station
let _playedWindow = [];       // recently played recs (sliding window of {name, artist, album, image})
let _driftSteps = 0;          // how far we've drifted from the original seed
let _toppingUp = false;       // guard against concurrent top-ups

function _recordPlayedRec(track) {
  if (!track || !track.name) return;
  _playedWindow.push({ name: track.name, artist: track.artist || '', album: track.album || '', image: track.image || '' });
  if (_playedWindow.length > SEED_WINDOW) _playedWindow = _playedWindow.slice(-SEED_WINDOW);
}

// ── Feedback log (skipped/accepted) — persisted in localStorage ──
const FB_KEY = 'ms_recs_feedback_v1';
const FB_MAX = 60;          // cap size per list
const FB_TTL_DAYS = 14;

function _loadFeedback() {
  try {
    const raw = JSON.parse(localStorage.getItem(FB_KEY) || '{}');
    const now = Date.now();
    const fresh = (arr) => (arr || []).filter(e => (now - (e.ts || 0)) < FB_TTL_DAYS * 86400000);
    return { skipped: fresh(raw.skipped), accepted: fresh(raw.accepted) };
  } catch { return { skipped: [], accepted: [] }; }
}

function _saveFeedback(fb) {
  try { localStorage.setItem(FB_KEY, JSON.stringify(fb)); } catch {}
}

export function recordSkip(track) {
  if (!track || !track.name) return;
  const fb = _loadFeedback();
  fb.skipped.push({ name: track.name, artist: track.artist || '', ts: Date.now() });
  if (fb.skipped.length > FB_MAX) fb.skipped = fb.skipped.slice(-FB_MAX);
  _saveFeedback(fb);
  recsDirty = true;
}

export function recordAccept(track) {
  if (!track || !track.name) return;
  const fb = _loadFeedback();
  fb.accepted.push({ name: track.name, artist: track.artist || '', ts: Date.now() });
  if (fb.accepted.length > FB_MAX) fb.accepted = fb.accepted.slice(-FB_MAX);
  _saveFeedback(fb);
  recsDirty = true;
}

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

  // Endless radio: remember what played and top up the station in the background.
  _recordPlayedRec(track);
  _maybeTopUp();

  // Play directly via player without adding to queue
  getPlayerModule().then(m => m.playRecTrack(track));
  renderRecs();
  return true;
}

// ── Play previous rec ──
export function playPrevRec() {
  if (recsPlayingIdx <= 0) {
    // Go back to last track in queue
    recsPlayingIdx = -1;
    renderRecs();
    return false;
  }
  recsPlayingIdx--;
  const track = recsCache[recsPlayingIdx];
  if (!track) { recsPlayingIdx = -1; renderRecs(); return false; }
  getPlayerModule().then(m => m.playRecTrack(track));
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
    const fb = _loadFeedback();
    const seedTracks = store.playerQueue.slice(-30);
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: {
        tracks: seedTracks,
        limit: 20,
        skipped: fb.skipped.slice(-30),
        accepted: fb.accepted.slice(-30),
      },
    });
    recsCache = data.tracks || [];
    recsDirty = false;
    // Re-anchor the endless-radio station on a fresh full load.
    _originalSeed = seedTracks;
    _playedWindow = [];
    _driftSteps = 0;
    renderRecs();
  } catch {
    recsCache = [];
    renderRecs();
    showToast("Couldn't load recommendations");
  } finally {
    recsLoading = false;
  }
}

// ── Endless radio: top up the virtual queue in the background ──
// Re-seeds from the sliding window of recently played recs so the station drifts
// with the session, but re-anchors to the original seed after MAX_DRIFT_STEPS to
// guard against drifting infinitely off-taste.
async function _maybeTopUp() {
  if (_toppingUp || recsLoading) return;
  const remaining = recsCache.length - (recsPlayingIdx + 1);
  if (remaining > TOPUP_THRESHOLD) return;

  _toppingUp = true;
  try {
    // Drift guard: every MAX_DRIFT_STEPS top-ups, fold the original seed back in.
    let seed;
    if (_driftSteps >= MAX_DRIFT_STEPS) {
      seed = _originalSeed.slice();
      _driftSteps = 0;
    } else {
      // Blend recent plays (drift) with a slice of the original seed (anchor).
      seed = _playedWindow.concat(_originalSeed.slice(-4));
      _driftSteps++;
    }
    if (!seed.length) seed = _originalSeed.slice();
    if (!seed.length) return;

    const fb = _loadFeedback();
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: {
        tracks: seed,
        limit: 15,
        skipped: fb.skipped.slice(-30),
        accepted: fb.accepted.slice(-30),
      },
    });
    const fresh = data.tracks || [];
    if (fresh.length) {
      // Append only tracks not already in the cache (dedup by name+artist).
      const seen = new Set(recsCache.map(t => `${(t.name || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`));
      for (const t of fresh) {
        const k = `${(t.name || '').toLowerCase()}|${(t.artist || '').toLowerCase()}`;
        if (!seen.has(k)) { recsCache.push(t); seen.add(k); }
      }
      renderRecs();
    }
  } catch {
    // top-up failure is non-fatal; station keeps playing what it has
  } finally {
    _toppingUp = false;
  }
}

// Human-readable seed label for the recs header — "Based on {track/artist}".
function _seedLabel() {
  const seed = (_originalSeed && _originalSeed.length)
    ? _originalSeed[_originalSeed.length - 1]
    : (store.playerQueue.length ? store.playerQueue[store.playerQueue.length - 1] : null);
  if (!seed) return 'your queue';
  if (seed.name && seed.artist) return `${seed.name} — ${seed.artist}`;
  return seed.name || seed.artist || 'your queue';
}

function _refreshRecsHeader() {
  $$('.recs-section').forEach(section => {
    const lbl = section.querySelector('.recs-seed');
    if (lbl) lbl.textContent = `Based on ${_seedLabel()}`;
  });
}

function _ensureRecsIn(queueListEl) {
  if (!queueListEl) return null;
  let list = queueListEl.querySelector('.recs-list');
  if (list) return list;
  const section = document.createElement('div');
  section.className = 'recs-section';
  section.innerHTML = `
    <div class="panel-header recs-header" style="font-size:13px;border-top:1px solid var(--border);padding-top:12px;">
      <div class="recs-header-titles">
        <span>Recommended</span>
        <span class="recs-seed" style="font-size:11px;font-weight:400;color:var(--text-muted);">Based on ${_seedLabel()}</span>
      </div>
      <button class="recs-refresh" title="Refresh recommendations" aria-label="Refresh recommendations">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      </button>
    </div>
    <div class="recs-moods" role="group" aria-label="Recommendation mood">
      <button class="recs-mood active" data-vibe="" title="Default mood">Default</button>
      <button class="recs-mood" data-vibe="calm" title="Calmer picks">&#127769; Calm</button>
      <button class="recs-mood" data-vibe="energy" title="Higher energy picks">&#9889; Energy</button>
    </div>
    <div class="recs-list"></div>`;
  queueListEl.appendChild(section);
  // Reconcile chip highlight against the persisted _recsVibe (e.g. the queue
  // container was wiped by renderQueueInto and the section rebuilt from the
  // template which hard-codes Default as active).
  $$('.recs-mood', section).forEach(b => b.classList.toggle('active', (b.dataset.vibe || '') === _recsVibe));
  _attachHeaderHandlers(section);
  return section.querySelector('.recs-list');
}

// Currently selected mood/vibe for the recs station ('' = default).
let _recsVibe = '';

// Seed track for vibe-aware radio — the last track of the original seed (the one
// the station is "Based on"), falling back to the live queue tail.
function _vibeSeedTrack() {
  if (_originalSeed && _originalSeed.length) return _originalSeed[_originalSeed.length - 1];
  if (store.playerQueue.length) return store.playerQueue[store.playerQueue.length - 1];
  return null;
}

function _attachHeaderHandlers(section) {
  const refresh = section.querySelector('.recs-refresh');
  if (refresh) refresh.addEventListener('click', (e) => {
    e.stopPropagation();
    recsDirty = true;
    loadRecs();
  });
  $$('.recs-mood', section).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _recsVibe = btn.dataset.vibe || '';
      // Reflect selection across all rendered headers (desktop + mobile).
      $$('.recs-mood').forEach(b => b.classList.toggle('active', (b.dataset.vibe || '') === _recsVibe));
      if (_recsVibe) {
        // Calm/Energy: the virtual-recs endpoint has no vibe axis, so start a
        // vibe-aware track radio from the seed (backend supports vibe on /radio/track).
        const seed = _vibeSeedTrack();
        if (seed) import('./radio.js').then(m => m.startTrackRadio(seed, { vibe: _recsVibe }));
      } else {
        // Default: refresh the normal (non-vibe) recommendation station.
        recsDirty = true;
        loadRecs();
      }
    });
  });
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
        <button class="rec-dismiss" title="Dismiss" aria-label="Dismiss recommendation" data-rec-idx="${i}">&times;</button>
      </div>
    </div>`).join('');
}

export function playRecIndex(idx) {
  if (typeof idx !== 'number' || idx < 0 || idx >= recsCache.length) return;
  const track = recsCache[idx];
  if (!track) return;
  recsPlayingIdx = idx;
  _recordPlayedRec(track);
  _maybeTopUp();
  getPlayerModule().then(m => m.playRecTrack(track));
  import('./queue.js').then(m => {
    if (store.queuePanelOpen && m.closeQueuePanel) m.closeQueuePanel();
    if (store.fpQueuePanelOpen && m.closeFpQueuePanel) m.closeFpQueuePanel();
  });
  renderRecs();
}

export function dismissRec(idx) {
  if (typeof idx !== 'number' || idx < 0 || idx >= recsCache.length) return;
  recsCache.splice(idx, 1);
  if (recsPlayingIdx > idx) recsPlayingIdx--;
  renderRecs();
}

function _attachRecsHandlers(el) {
  // Click on rec = play it directly (virtual, not added to queue)
  $$('.rec-item', el).forEach(item => {
    item.addEventListener('click', (e) => {
      if (wasLongPress()) return;
      if (e.target.closest('.rec-add-queue') || e.target.closest('.rec-add-playlist')) return;
      const idx = parseInt(item.dataset.recIdx);
      const track = recsCache[idx];
      if (!track) return;
      recsPlayingIdx = idx;
      _recordPlayedRec(track);
      _maybeTopUp();
      getPlayerModule().then(m => m.playRecTrack(track));
      // Close any open queue panel so player controls are accessible
      // (queue-panel sits above the player bar via z-index)
      import('./queue.js').then(m => {
        if (store.queuePanelOpen && m.closeQueuePanel) m.closeQueuePanel();
        if (store.fpQueuePanelOpen && m.closeFpQueuePanel) m.closeFpQueuePanel();
      });
      renderRecs();
    });
  });
  // "+" = add to actual queue
  $$('.rec-add-queue', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = recsCache[btn.dataset.recIdx];
      if (!track) return;
      getPlayerModule().then(m => m.addToQueue([track]));
    });
  });
  // "✕" = dismiss this rec from the station
  $$('.rec-dismiss', el).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.recIdx);
      const track = recsCache[idx];
      dismissRec(idx);
      if (track) recordSkip(track);
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
        // No early bail on an empty list: the picker offers "+ New playlist",
        // so a user with zero playlists can still create one right here.
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
  attachContextMenu(el, {
    selector: '.rec-item',
    getItem: (targetEl) => {
      const idx = parseInt(targetEl.dataset.recIdx);
      const item = recsCache[idx];
      if (!item) return null;
      return { item, type: 'recommendation', context: { recIndex: idx } };
    },
  });
}

function renderRecs() {
  const html = _recsHtml();
  _getAllRecsContainers().forEach(el => {
    el.innerHTML = html;
    _attachRecsHandlers(el);
  });
  _refreshRecsHeader();
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
