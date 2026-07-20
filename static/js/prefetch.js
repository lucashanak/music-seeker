// prefetch.js — Prefetch upcoming tracks for smooth crossfade
// 2 concurrent downloads, priority queue, progress tracking.

import { store } from './store.js';
import { apiFetch } from './api.js';

const _cache = new Map();       // "artist:name" → { blobUrl, size }
const _fetching = new Map();    // key → { priority, controller, progress }
const MAX_CONCURRENT = 3;
const _queue = [];              // priority-sorted FIFO
// Preload-set state: keys pinned against eviction + the (key,item) targets to
// keep re-enqueued across resume. Empty when no preload is active → cleanup and
// resume behave EXACTLY as before (no pins → nothing extra kept/re-enqueued).
const _pinned = new Set();      // keys that must never be evicted
const _preloadItems = [];       // [{ key, item }] of the preload target
function _prefetchCount() { return parseInt(localStorage.getItem('ms_dj_prefetch_count')) || 3; }

/** Stream quality gate (engine-agnostic; set via Settings → Streaming Quality).
 *  Default 'standard' → server transcodes local FLAC → 320k MP3 (smaller blob,
 *  faster streaming/prefetch). 'lossless' → server serves raw FLAC (audiophile).
 *  Falls back to the legacy ms_dj_quality key for any value stored before the
 *  toggle was made engine-agnostic. */
export function streamQuality() {
  return localStorage.getItem('ms_stream_quality')
    || localStorage.getItem('ms_dj_quality')
    || 'standard';
}

let _paused = false;
export function pausePrefetch() { _paused = true; }
/** Abort all in-progress prefetch downloads to free bandwidth for the playing track. */
export function abortPrefetch() {
  _paused = true;
  for (const [key, state] of _fetching) {
    state.controller.abort();
    _fetching.delete(key);
  }
}
/** Abort/evict only NOW-STALE in-flight + queued fetches whose key is not in keepKeys,
 *  keeping the still-needed downloads (e.g. the immediate/predicted next track) running.
 *  Unlike abortPrefetch this does NOT set _paused — prefetch keeps flowing so the kept
 *  download finishes and new ones can be issued right after an advance. Returns nothing. */
export function abortStale(keepKeys) {
  const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
  for (const [key, state] of _fetching) {
    if (keep.has(key)) continue;
    try { state.controller.abort(); } catch (e) {}
    _fetching.delete(key);
  }
  for (let i = _queue.length - 1; i >= 0; i--) {
    if (!keep.has(_queue[i].key)) _queue.splice(i, 1);
  }
}

/** Build the prefetch cache key for a track (decoded artist:name or id:<id>).
 *  Exposed so callers can compute keepKeys for abortStale that match _key exactly. */
export function keyFor(name, artist, id) { return _key(name, artist, id); }

/** Abort in-flight fetches, drop the pending queue, and revoke EVERY cached blob.
 *  Call when the active queue is cleared/replaced so blob URLs don't leak.
 *  Precondition: callers must pause active playback first — this revokes the
 *  currently-playing blob too (all current callers pause before clearActiveQueue). */
export function clearAll() {
  for (const [, state] of _fetching) { try { state.controller.abort(); } catch (e) {} }
  _fetching.clear();
  _queue.length = 0;
  // Queue is being replaced → any preload target is void; clear pins so the new
  // blobs evict normally (no leftover pins keeping stale-queue blobs alive).
  _pinned.clear();
  _preloadItems.length = 0;
  for (const [, entry] of _cache) URL.revokeObjectURL(entry.blobUrl);
  _cache.clear();
}
export function resumePrefetch() {
  _paused = false;
  // Rebuild queue from current position (clear stale entries)
  _queue.length = 0;
  _fillQueue();
  _processNext();
}

function _decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

// Always decode entities before building key — ensures loadAndPlay lookups match.
// Prefer a stable track id when present (avoids same-title/remix collisions); fall
// back to the decoded artist:name pair. id is threaded as an optional 3rd arg so
// prefetch-time and consume-time keys match — both sides MUST pass the same id.
function _key(name, artist, id) {
  if (id != null) return `id:${id}`;
  return `${_decodeEntities((artist || '')).toLowerCase().trim()}:${_decodeEntities((name || '')).toLowerCase().trim()}`;
}

/** Return cached blob URL if available, or null. */
export function getCachedUrl(name, artist, id) {
  const entry = _cache.get(_key(name, artist, id));
  return entry ? entry.blobUrl : null;
}

/** If track is currently being prefetched, wait for it (max 10s). Returns blob URL or null. */
export async function waitForCache(name, artist, timeoutMs = 10000, id) {
  const key = _key(name, artist, id);
  // Already cached
  if (_cache.has(key)) return _cache.get(key).blobUrl;
  // Not being fetched — can't wait
  if (!_fetching.has(key)) return null;
  // Wait for prefetch to complete
  const start = Date.now();
  return new Promise(resolve => {
    const check = () => {
      if (_cache.has(key)) return resolve(_cache.get(key).blobUrl);
      if (!_fetching.has(key)) return resolve(null); // fetch failed
      if (Date.now() - start > timeoutMs) return resolve(null); // timeout
      setTimeout(check, 200);
    };
    check();
  });
}

/** Get prefetch status for a track. */
export function getStatus(name, artist, id) {
  const key = _key(name, artist, id);
  if (_cache.has(key)) return { state: 'ready', progress: 100 };
  const f = _fetching.get(key);
  if (f) return { state: 'loading', progress: f.progress || 0 };
  if (_queue.some(q => q.key === key)) return { state: 'queued', progress: 0 };
  return null;
}

/** Prefetch a specific track at front of queue (for Smart Queue). */
export function prefetchTrack(name, artist, id) {
  if (store.castDevice || _paused) return;
  const key = _key(name, artist, id);
  if (_cache.has(key) || _fetching.has(key)) return;
  // Remove from queue if already there, re-add at front
  const idx = _queue.findIndex(q => q.key === key);
  if (idx >= 0) _queue.splice(idx, 1);
  _queue.unshift({ item: { name, artist, id }, key, priority: 0 });
  _processNext();
}

/** Prefetch next N tracks from current position. */
export function prefetchUpcoming(queue, currentIndex, count) {
  if (count == null) count = _prefetchCount();
  if (store.castDevice || !queue || !queue.length || _paused) return;
  _fillQueueFrom(queue, currentIndex, count);
  _processNext();
}

/** Preload the ENTIRE forward queue into device memory, pinned against eviction.
 *  For a flaky venue link: the deck then plays cached blobs and a link outage
 *  during the set doesn't matter. Uses the existing priority queue so the live
 *  deck's immediate/predicted-next prefetch (priority 0/low) still wins — preload
 *  entries get priority `i - fromIndex` so NEAR tracks download first and the
 *  far tail never starves the playing track. Pins the current index too so it
 *  isn't evicted out from under the deck. */
export function preloadSet(queue, fromIndex) {
  if (store.castDevice || !queue || !queue.length) return;
  // New preload target replaces any prior one.
  _pinned.clear();
  _preloadItems.length = 0;
  // Pin the current track so cleanup won't evict it while preload is active.
  const cur = queue[fromIndex];
  if (cur) _pinned.add(_key(cur.name, cur.artist, cur.id));
  for (let i = fromIndex; i < queue.length; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist, item.id);
    _pinned.add(key);
    _preloadItems.push({ key, item });
    if (_cache.has(key) || _fetching.has(key) || _queue.some(q => q.key === key)) continue;
    // priority i - fromIndex: near tracks first, far tail last (won't starve the
    // live deck, which enqueues at priority 0 / unshifts to the front).
    _queue.push({ item, key, priority: i - fromIndex });
  }
  _processNext();
}

/** Stop pinning the preload set — normal window eviction resumes. Does NOT
 *  revoke blobs (cleanup() handles that on the next advance). */
export function clearPreload() {
  _pinned.clear();
  _preloadItems.length = 0;
}

/** Preload progress for the UI: total pinned, how many are cached (done) /
 *  fetching (loading), and the summed cached blob bytes for the ~MB estimate. */
export function preloadStatus() {
  let done = 0, loading = 0, bytes = 0;
  for (const key of _pinned) {
    if (_cache.has(key)) { done++; bytes += (_cache.get(key).size || 0); }
    else if (_fetching.has(key)) loading++;
  }
  return { total: _pinned.size, done, loading, bytes };
}

function _fillQueue() {
  _fillQueueFrom(store.playerQueue, store.playerIndex, _prefetchCount());
  // Preload survives a resume: after the normal near-window fill, re-enqueue any
  // pinned preload targets that aren't already cached/fetching/queued (resumePrefetch
  // cleared _queue, dropping preload entries that hadn't started yet).
  for (const { key, item } of _preloadItems) {
    if (_cache.has(key) || _fetching.has(key) || _queue.some(q => q.key === key)) continue;
    _queue.push({ item, key, priority: 1000 }); // low priority: never starve the near window
  }
}

function _fillQueueFrom(queue, currentIndex, count) {
  for (let i = currentIndex + 1; i < queue.length && i <= currentIndex + count; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist, item.id);
    if (_cache.has(key) || _fetching.has(key) || _queue.some(q => q.key === key)) continue;
    _queue.push({ item, key, priority: i - currentIndex });
  }
}

/** Process queue — up to MAX_CONCURRENT downloads at a time. */
function _processNext() {
  while (!_paused && _fetching.size < MAX_CONCURRENT && _queue.length > 0) {
    const entry = _queue.shift();
    if (_cache.has(entry.key) || _fetching.has(entry.key)) continue;
    _startFetch(entry);
  }
}

async function _startFetch(entry) {
  const controller = new AbortController();
  const state = { priority: entry.priority, controller, progress: 0 };
  _fetching.set(entry.key, state);

  try {
    const cleanName = _decodeEntities(entry.item.name || '');
    const cleanArtist = _decodeEntities(entry.item.artist || '');
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) });
    const res = await apiFetch(`/api/player/stream?${params}&quality=${streamQuality()}`, { signal: controller.signal });
    if (!res.ok) { _fetching.delete(entry.key); _processNext(); return; }
    // Validate content-type — reject HTML/JSON error pages served with 200 status.
    // Accept audio/* and application/octet-stream (some flac/mp3 streams use it).
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('audio/') && !ct.startsWith('application/octet-stream')) {
      _fetching.delete(entry.key); _processNext(); return;
    }

    // Track download progress via ReadableStream
    const total = parseInt(res.headers.get('content-length')) || 0;
    let blob;
    if (total && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        state.progress = Math.round((received / total) * 100);
      }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
    }
    // Reject suspiciously small bodies — an error page/JSON served as octet-stream
    // with HTTP 200 would otherwise poison the cache for the full 4h stream TTL.
    if (blob.size < 10240) { _fetching.delete(entry.key); _processNext(); return; }
    // Aborted mid-flight (skip/clear deleted the _fetching entry): don't poison the
    // cache with a blob for an already-skipped track, and don't leak the object URL.
    if (controller.signal.aborted || !_fetching.has(entry.key)) { _processNext(); return; }
    _cache.set(entry.key, { blobUrl: URL.createObjectURL(blob), size: blob.size });
    state.progress = 100;
  } catch (e) {
    if (e.name !== 'AbortError') { /* network error, skip */ }
  }

  _fetching.delete(entry.key);
  if (!_paused) _processNext();
}

/** Revoke blob URLs for tracks outside the keep window. */
export function cleanup(queue, currentIndex) {
  if (!queue || !queue.length) return;
  const count = _prefetchCount();
  const keepKeys = new Set();
  const lo = Math.max(0, currentIndex - 2);
  const hi = Math.min(queue.length - 1, currentIndex + count + 2);
  for (let i = lo; i <= hi; i++) {
    keepKeys.add(_key(queue[i].name, queue[i].artist, queue[i].id));
  }
  for (const [k] of _fetching) keepKeys.add(k);
  for (const q of _queue) keepKeys.add(q.key);
  // Pinned preload keys are NEVER evicted while preload is active. When no preload
  // is active _pinned is empty → this loop adds nothing → cleanup is unchanged.
  for (const k of _pinned) keepKeys.add(k);
  for (const [k, entry] of _cache) {
    if (!keepKeys.has(k)) {
      URL.revokeObjectURL(entry.blobUrl);
      _cache.delete(k);
    }
  }
}
