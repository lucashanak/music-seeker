// upnext.js — Up Next temp playlist: the unified queue/playlist abstraction.
// Maintains a single Navidrome playlist per (user, device) used as the active
// playback context. Queue mutations write through to this playlist.

import { store } from './store.js';
import { apiJson } from './api.js';
import { showToast } from './utils.js';
import { getPlayerModule } from './player_active.js';
import { clearAll as clearPrefetch } from './prefetch.js';

const UPNEXT_DISPLAY = 'Up Next';
const RADIO_DISPLAY = 'Radio';

// Re-anchor the DJ engine's per-set state whenever the playback queue is
// replaced wholesale (the smart-queue candidate pool IS store.playerQueue, so a
// stale set anchor would corrupt the tempo ramp + prediction==commit invariant).
// Lazy import keeps the heavy djmix module off the upnext load path.
async function _resetDjSet() {
  try {
    const dj = await import('./djmix.js');
    dj.resetSmartQueuePlayed && dj.resetSmartQueuePlayed();
  } catch {}
}

function _isUpnextRaw(name) {
  return typeof name === 'string' && name.startsWith('__upnext_');
}
function _isRadioRaw(name) {
  return typeof name === 'string' && name.startsWith('__radio_');
}

// Friendly display name: hide internal prefix from the UI.
export function displayPlaylistName(rawName) {
  if (_isUpnextRaw(rawName)) return UPNEXT_DISPLAY;
  if (_isRadioRaw(rawName)) return RADIO_DISPLAY;
  return rawName || '';
}

// Initialize on boot: idempotently fetch/create Up Next, set as playlistMode
// only if user is not currently in a named playlist context.
export async function initUpNext() {
  try {
    const pl = await apiJson('/api/library/upnext');
    if (!pl || !pl.id) return null;
    // Only adopt Up Next as the active playlist mode if not already in a named one
    if (!store.playlistMode) {
      store.playlistMode = { id: pl.id, name: displayPlaylistName(pl.name) };
      const badge = document.getElementById('fpPlaylistBadge');
      if (badge) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    }
    // Hydrate local playback queue from Up Next when local state is empty.
    // This recovers the cross-session "what was I listening to" without
    // overriding an in-progress local queue.
    if ((!store.playerQueue || !store.playerQueue.length) && pl.tracks && pl.tracks.length) {
      store.playerQueue = pl.tracks;
      store.playerIndex = 0;
      // Rebuild visible queue panel(s)
      try {
        const q = await import('./queue.js');
        q.renderQueue && q.renderQueue();
      } catch {}
    }
    return pl;
  } catch (e) {
    // Navidrome unavailable — keep legacy behaviour (ad-hoc queue)
    return null;
  }
}

// Atomic replace of a playlist's contents by name/artist matching.
// Returns the API response: { matched: int, missing: [{name, artist, album}] }.
export async function replaceByName(playlistId, tracks) {
  if (!playlistId || !tracks || !tracks.length) return { matched: 0, missing: [] };
  return await apiJson(`/api/library/playlist/${playlistId}/replace-by-name`, {
    method: 'POST',
    body: { tracks },
  });
}

// Returns the playlist ID currently treated as the active context (Up Next
// or a named playlist). Null when neither.
export function activePlaylistId() {
  return store.playlistMode && store.playlistMode.id;
}

// Returns true when the active playlist is Up Next (the temp one).
export function isUpNextActive() {
  return !!(store.playlistMode && store.playlistMode.name === UPNEXT_DISPLAY);
}

// Returns true when the active playlist is the Radio temp playlist.
export function isRadioActive() {
  return !!(store.playlistMode && store.playlistMode.name === RADIO_DISPLAY);
}

// Returns true when active playlist is any of our internal temp playlists.
export function isTempActive() {
  return isUpNextActive() || isRadioActive();
}

// Replace local playback queue AND mirror to the active temp playlist on
// Navidrome (Up Next OR Radio). Named playlists are never auto-replaced.
// Fire-and-forget: ask the server to pre-warm its stream cache for the upcoming
// first track so its first GET /api/player/stream skips cold-start transcode
// latency. Best-effort — never blocks playback, never surfaces errors.
function _prewarmFirst() {
  try {
    const first = store.playerQueue && store.playerQueue[store.playerIndex];
    if (!first) return;
    apiJson('/api/player/prewarm', {
      method: 'POST',
      body: { tracks: [{ name: first.name, artist: first.artist, id: first.id }] },
    }).catch(() => {});
  } catch {}
}

export async function playTracks(tracks) {
  if (!tracks || !tracks.length) return;
  store.playerQueue = tracks;
  store.playerIndex = 0;
  _prewarmFirst();
  // Re-anchor DJ per-set state to the NEW subset so the smart queue's candidate
  // pool (== store.playerQueue) is freshly bounded and prediction==commit holds.
  await _resetDjSet();
  const playerMod = await getPlayerModule();
  playerMod.loadAndPlay();
  const id = activePlaylistId();
  if (id && isTempActive()) {
    replaceByName(id, tracks).catch(e => console.warn('Mirror failed:', e));
  }
}

// Switch playback context to the Radio temp playlist, replace its contents,
// and start playing. The Up Next temp playlist is left untouched so the user
// can return to their previous queue when radio mode ends.
export async function playRadio(tracks) {
  if (!tracks || !tracks.length) return;
  try {
    const rpl = await apiJson('/api/library/radio');
    if (rpl && rpl.id) {
      store.playlistMode = { id: rpl.id, name: RADIO_DISPLAY };
      const badge = document.getElementById('fpPlaylistBadge');
      if (badge) { badge.textContent = RADIO_DISPLAY; badge.style.display = ''; }
    }
  } catch {}
  store.playerQueue = tracks;
  store.playerIndex = 0;
  _prewarmFirst();
  await _resetDjSet();
  const playerMod = await getPlayerModule();
  playerMod.loadAndPlay();
  const id = activePlaylistId();
  if (id && isRadioActive()) {
    replaceByName(id, tracks).catch(e => console.warn('Radio mirror failed:', e));
  }
}

// Append-only mirror: fire-and-forget batch add to the active temp playlist
// after the caller has appended tracks to store.playerQueue locally. Useful
// for auto-radio fills and similar incremental appends.
export function mirrorAdd(tracks) {
  if (!tracks || !tracks.length) return;
  const id = activePlaylistId();
  if (!id || !isTempActive()) return;
  apiJson(`/api/library/playlist/${id}/add-and-download-batch`, {
    method: 'POST',
    // Queue mirror only — DJ/radio fills must not pull tracks into the library.
    body: { tracks: tracks.map(t => ({ name: t.name || '', artist: t.artist || '', album: t.album || '' })), download: false },
  }).catch(() => {});
}

// Clear the local playback queue. If Up Next is the active context, also clear
// its Navidrome contents (so the mirror stays in sync). Named playlists are
// never destructively cleared — we just switch back to a fresh Up Next.
export async function clearActiveQueue() {
  store.playerQueue = [];
  store.playerIndex = -1;
  clearPrefetch(); // revoke cached blob URLs so they don't leak when the queue is emptied
  if (isUpNextActive() && activePlaylistId()) {
    replaceByName(activePlaylistId(), []).catch(() => {});
  } else {
    // Named playlist active — leave its contents alone, just go back to Up Next
    store.playlistMode = null;
    await initUpNext().catch(() => {});
  }
}

export { UPNEXT_DISPLAY };
