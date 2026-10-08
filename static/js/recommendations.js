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

// ── Seed window: WHERE in the playlist the station is built from ──
// The station used to seed off store.playerQueue.slice(-30) — the queue's TAIL,
// ignoring store.playerIndex entirely. On a 200-track playlist that built
// recommendations for music the listener had not reached (and would not for
// hours). The window sits on the cursor instead, and reaches further BACK than
// forward (what just played is stronger context than what is merely queued) —
// an asymmetric window, not a per-track weighting; the sampler still weights
// only by artist frequency and mood fit. The PROFILE meanwhile still covers the
// whole playlist, so the picks keep its overall direction.
const PROFILE_MAX = 200;   // cap on tracks sent as the profile (payload + cost)
const SEED_BACK = 20;      // tracks up to and including the cursor
const SEED_AHEAD = 10;     // tracks after it

// Currently selected mood/vibe for the recs station ('' = default).
let _recsVibe = '';

// Project a queue item to the fields the recommendation engine actually reads
// (name/artist for the profile, id for seed radio, bpm/camelot for tempo
// coherence) — a 200-track profile of full queue items ships image URLs and
// per-track player state for nothing.
function _payloadTrack(t) {
  const out = { name: t.name || '', artist: t.artist || '' };
  if (t.album) out.album = t.album;
  if (t.id) out.id = t.id;
  if (t.bpm) out.bpm = t.bpm;
  if (t.camelot) out.camelot = t.camelot;
  return out;
}

function _key(t) {
  return `${((t && t.name) || '').toLowerCase()}|${((t && t.artist) || '').toLowerCase()}`;
}

// Cursor position, falling back to the queue tail when nothing is playing yet
// (which is exactly the old behavior, so an idle queue is unchanged).
function _cursorIdx() {
  const q = store.playerQueue;
  const i = store.playerIndex;
  return (i >= 0 && i < q.length) ? i : q.length - 1;
}

function _seedWindow() {
  const q = store.playerQueue;
  if (!q.length) return [];
  const idx = _cursorIdx();
  return q.slice(Math.max(0, idx - SEED_BACK + 1), idx + 1 + SEED_AHEAD)
          .map(_payloadTrack);
}

// The profile: the whole playlist when it fits, else a PROFILE_MAX slice
// centered on the cursor (never the head — that is the same bug as the tail).
function _profileTracks() {
  const q = store.playerQueue;
  if (q.length <= PROFILE_MAX) return q.map(_payloadTrack);
  const half = Math.floor(PROFILE_MAX / 2);
  let start = Math.max(0, _cursorIdx() - half);
  if (start + PROFILE_MAX > q.length) start = q.length - PROFILE_MAX;
  return q.slice(start, start + PROFILE_MAX).map(_payloadTrack);
}

// ── Scene anchor for the co-occurrence recall arm ──
// The backend mines public playlists named after a scene, and the single thing
// that determines whether that works is the anchor. A playlist name is the best
// anchor available client-side: it is what the user themselves called this music.
// Temp and system contexts name no scene, so they contribute nothing.
const _ANCHOR_SKIP = new Set(['up next', 'radio']);

function _queueAnchors() {
  const name = ((store.playlistMode && store.playlistMode.name) || '').trim();
  if (!name || name.startsWith('__')) return [];
  if (_ANCHOR_SKIP.has(name.toLowerCase())) return [];
  return [name];
}

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
// What the list on screen was actually built from, so nothing in the UI can
// claim a mood or a seed the visible picks do not come from.
let _loadedVibe = '';
let _loadedSeedTrack = null;
let _loadFailed = false;

async function loadRecs() {
  if (!store.playerQueue.length) return;
  // A mood chip tapped while a load is in flight must not be swallowed: the
  // chip would show Calm over a Default list, and re-tapping it could not fix
  // it. Let the in-flight request finish and re-enter from its `finally`.
  if (recsLoading) return;
  recsLoading = true;
  renderLoading();
  const vibe = _recsVibe;
  try {
    const fb = _loadFeedback();
    const profileTracks = _profileTracks();
    const seedTracks = _seedWindow();
    const cursorTrack = store.playerQueue[_cursorIdx()] || null;
    // Hold on to the rec playing right now: a reload (refresh, mood switch)
    // replaces the cache, and recsPlayingIdx would then point at an unrelated
    // row — highlighting the wrong track and mis-advancing "next".
    const playing = recsPlayingIdx >= 0 ? recsCache[recsPlayingIdx] : null;
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: {
        tracks: profileTracks,
        seed_tracks: seedTracks,
        limit: 20,
        skipped: fb.skipped.slice(-30),
        accepted: fb.accepted.slice(-30),
        anchors: _queueAnchors(),
        vibe: vibe || null,
      },
    });
    const fresh = data.tracks || [];
    // Only carry the playing track over when the mood actually returned
    // something — otherwise the single surviving row would masquerade as a
    // result, and the "no picks for this mood" state would never show.
    if (playing && fresh.length) {
      const pk = _key(playing);
      recsCache = [playing, ...fresh.filter(t => _key(t) !== pk)];
      recsPlayingIdx = 0;
    } else {
      recsCache = fresh;
      // The preserved track is gone (or there was nothing to preserve): drop
      // the index rather than leaving it pointing into the new list.
      if (recsPlayingIdx >= 0) recsPlayingIdx = -1;
    }
    recsDirty = false;
    _loadFailed = false;
    _loadedVibe = vibe;
    _loadedSeedTrack = cursorTrack;
    // Re-anchor the endless-radio station on a fresh full load.
    _originalSeed = seedTracks;
    _playedWindow = [];
    _driftSteps = 0;
    renderRecs();
  } catch {
    recsCache = [];
    _loadFailed = true;
    _loadedVibe = vibe;
    _loadedSeedTrack = store.playerQueue[_cursorIdx()] || _loadedSeedTrack;
    renderRecs();
    showToast("Couldn't load recommendations");
  } finally {
    recsLoading = false;
    // The mood changed under an in-flight request — serve the latest choice.
    if (_recsVibe !== _loadedVibe) loadRecs();
  }
}

// Up to 150 already-shown recs (model caps `exclude` at 200), deduped.
function _excludeKeys() {
  const ends = recsCache.length <= 150
    ? recsCache
    : [...recsCache.slice(0, 75), ...recsCache.slice(-75)];
  const seen = new Set();
  const out = [];
  for (const t of ends) {
    const k = _key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: t.name || '', artist: t.artist || '' });
  }
  return out;
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
    // The drift window is the SEED pool; the profile stays the playlist, with
    // the played recs folded in so they are excluded from the result too.
    // `exclude` carries what the station already shows, so the top-up spends
    // its limit on new tracks instead of duplicates we then filter out.
    const profileTracks = _profileTracks();
    const inProfile = new Set(profileTracks.map(_key));
    const tracks = profileTracks.concat(seed.filter(t => !inProfile.has(_key(t))));
    const data = await apiJson('/api/player/recommendations', {
      method: 'POST',
      body: {
        tracks,
        seed_tracks: seed,
        limit: 15,
        skipped: fb.skipped.slice(-30),
        accepted: fb.accepted.slice(-30),
        anchors: _queueAnchors(),
        // Both ends of the cache: the tail is what was just shown, the head is
        // what the server is most likely to surface again (it ranked those
        // first), and a long session's cache outgrows any one-sided slice.
        exclude: _excludeKeys(),
        vibe: _recsVibe || null,
      },
    });
    const fresh = data.tracks || [];
    if (fresh.length) {
      // Append only tracks not already in the cache (dedup by name+artist).
      const seen = new Set(recsCache.map(_key));
      for (const t of fresh) {
        const k = _key(t);
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
// Names the track the visible list was BUILT around, captured at load time.
// Reading the live cursor instead would let the header advance to "track 47"
// while the list still came from a window around track 12 — a quieter version
// of the bug the seed window exists to fix. (And before the window existed this
// named the queue's last track, rarely anything the listener could hear.)
function _seedLabel() {
  let seed = _loadedSeedTrack;
  if (!seed && _originalSeed && _originalSeed.length) {
    seed = _originalSeed[_originalSeed.length - 1];
  }
  if (!seed) return 'your queue';
  if (seed.name && seed.artist) return `${seed.name} — ${seed.artist}`;
  return seed.name || seed.artist || 'your queue';
}

const VIBE_LABELS = { calm: '\u{1F319} Calm', energy: '\u26A1 Energy' };

function _headerSubtitle() {
  const base = `Based on ${_seedLabel()}`;
  // _loadedVibe, not _recsVibe: the subtitle describes the list on screen.
  return _loadedVibe ? `${VIBE_LABELS[_loadedVibe]} \u00B7 ${base}` : base;
}

function _refreshRecsHeader() {
  $$('.recs-section').forEach(section => {
    const lbl = section.querySelector('.recs-seed');
    if (lbl) lbl.textContent = _headerSubtitle();
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
        <span class="recs-seed" style="font-size:11px;font-weight:400;color:var(--text-muted);">${esc(_headerSubtitle())}</span>
      </div>
      <button class="recs-refresh" title="Refresh recommendations" aria-label="Refresh recommendations">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
      </button>
    </div>
    <div class="recs-moods" role="group" aria-label="Recommendation mood">
      <button class="recs-mood" data-vibe="" title="Balanced picks for this playlist">Default</button>
      <button class="recs-mood" data-vibe="calm" title="Slower, lower-energy picks">&#127769; Calm</button>
      <button class="recs-mood" data-vibe="energy" title="Faster, higher-energy picks">&#9889; Energy</button>
    </div>
    <div class="recs-list"></div>`;
  queueListEl.appendChild(section);
  // Reconcile chip state against _recsVibe — the template renders none active,
  // and the section is rebuilt from it whenever renderQueueInto wipes the queue
  // container.
  _syncMoodChips(section);
  _attachHeaderHandlers(section);
  return section.querySelector('.recs-list');
}

// Reflect the selected mood on every rendered header (desktop + mobile).
function _syncMoodChips(root) {
  const chips = root ? $$('.recs-mood', root) : $$('.recs-mood');
  chips.forEach(b => {
    const on = (b.dataset.vibe || '') === _recsVibe;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
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
      const next = btn.dataset.vibe || '';
      // Re-tapping the active chip must still reload: it is the only way back
      // when a load raced the selection, or when a request failed.
      if (next === _recsVibe && next === _loadedVibe && recsCache.length
          && !recsLoading) return;
      _recsVibe = next;
      _syncMoodChips();
      // A mood is a FILTER on this station, not a playback action. It used to
      // call startTrackRadio, which replaced the queue with a Radio temp
      // playlist and started playing — so tapping a chip next to a list of
      // suggestions threw the playlist away. Now the endpoint carries the mood
      // (radio.py: seed bias + calm gate + tag/feature steering) and only the
      // list below reloads; whatever is playing keeps playing.
      recsDirty = true;
      loadRecs();
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
    const msg = _loadFailed
      ? "Couldn't load recommendations"
      : _loadedVibe
        ? `No ${_loadedVibe === 'calm' ? 'calm' : 'high-energy'} picks for this playlist — try Default`
        : 'No recommendations available';
    return `<div style="text-align:center;color:var(--text-muted);font-size:12px;padding:12px;">${esc(msg)}</div>`;
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
