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
// An EMPTY list is sent too: it is how Clear empties Up Next (clearActiveQueue,
// and the target's queue_op clear). The server must tell that apart from a list
// none of whose names matched, which it never applies.
export async function replaceByName(playlistId, tracks) {
  if (!playlistId || !Array.isArray(tracks)) return { matched: 0, missing: [] };
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
    if (!first || first.mix_url) return;   // a streamed mix has no title to warm
    apiJson('/api/player/prewarm', {
      method: 'POST',
      body: { tracks: [{ name: first.name, artist: first.artist, id: first.id }] },
    }).catch(() => {});
  } catch {}
}

// Under remote control (store.remoteTarget) this device is a remote, not a
// player: store.playerQueue/playerIndex are only the scratch the transfer is built
// from (loadAndPlay sends it), and nothing here may write to Navidrome or move
// store.playlistMode — the target adopts the list and mirrors it itself.

// The queue is a COPY of the caller's list, never the list itself. Callers pass
// arrays their page keeps (store.currentAlbumTracks, an artist's top tracks, the
// search results): with the queue being that array, addToQueue's push grew the
// page's list, and an album's "Add all" handed addToQueue the live queue itself.
// `_src` (the list it came from) and `_srcLen` (how many of its rows it took) are
// non-enumerable: never saved, never sent; search.js grows the queue from them.
function _queueCopy(tracks) {
  const q = tracks.slice();
  Object.defineProperty(q, '_src', { value: tracks });
  Object.defineProperty(q, '_srcLen', { value: tracks.length, writable: true });
  return q;
}

// startIndex: where in `tracks` to begin. Starting a song from the middle of a
// list keeps the whole list as the queue, so the rest plays on in order.
export async function playTracks(tracks, startIndex = 0) {
  if (!tracks || !tracks.length) return;
  const remote = !!store.remoteTarget;
  store.playerQueue = _queueCopy(tracks);
  store.playerIndex = Math.min(Math.max(0, startIndex | 0), tracks.length - 1);
  // A new list ends a radio session (playTrack does the same). Left on, the
  // engine refilled the end of an album with radio tracks, and under remote
  // control the stale flag rode along in the transfer to the target.
  store.radioMode = false;
  // Warms the SERVER's stream cache, which the target plays from as well.
  _prewarmFirst();
  // Re-anchor DJ per-set state to the NEW subset so the smart queue's candidate
  // pool (== store.playerQueue) is freshly bounded and prediction==commit holds.
  // Not under remote: this device plays nothing, and its own set state is what
  // it resumes when control ends (the transfer re-anchors the target's).
  if (!remote) await _resetDjSet();
  const playerMod = await getPlayerModule();
  playerMod.loadAndPlay();
  if (remote) return;
  const id = activePlaylistId();
  // A streamed mix is not in Navidrome: its row would send a title that matches nothing.
  // The mirror gets the rest (possibly none), so it never keeps the PREVIOUS queue.
  if (id && isTempActive()) {
    replaceByName(id, tracks.filter(t => !(t && t.mix_url))).catch(e => console.warn('Mirror failed:', e));
  }
}

// Switch playback context to the Radio temp playlist, replace its contents,
// and start playing. The Up Next temp playlist is left untouched so the user
// can return to their previous queue when radio mode ends.
export async function playRadio(tracks) {
  if (!tracks || !tracks.length) return;
  if (store.remoteTarget) {
    // The target plays the radio in its own context. Fetching /api/library/radio
    // here would touch THIS device's Radio playlist; and a named playlist left in
    // this device's scratch playlistMode would ride along in the transfer and be
    // adopted by the target (the server takes named ones), which would then write
    // radio tracks into it. null = "not a named playlist": the target keeps its own.
    // store.radioMode / radioSeedTrack (set by radio.js) travel in the transfer.
    store.playlistMode = null;
    store.playerQueue = _queueCopy(tracks);
    store.playerIndex = 0;
    _prewarmFirst();
    const playerMod = await getPlayerModule();
    playerMod.loadAndPlay();
    return;
  }
  try {
    const rpl = await apiJson('/api/library/radio');
    if (rpl && rpl.id) {
      store.playlistMode = { id: rpl.id, name: RADIO_DISPLAY };
      const badge = document.getElementById('fpPlaylistBadge');
      if (badge) { badge.textContent = RADIO_DISPLAY; badge.style.display = ''; }
    }
  } catch {}
  store.playerQueue = _queueCopy(tracks);
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
  if (store.remoteTarget) return;   // the target mirrors what it is sent
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
  if (store.remoteTarget) {
    // Clear the controlled device's queue, not this one's scratch (nor its Up Next).
    document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'queue_op', value: { op: 'clear' } } }));
    return;
  }
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
