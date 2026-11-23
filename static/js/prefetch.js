// prefetch.js — Prefetch upcoming tracks for smooth crossfade
// 2 concurrent downloads, priority queue, progress tracking.

import { store } from './store.js';
import { refreshStreamToken, streamToken } from './api.js';

const _cache = new Map();       // "artist:name" → { blobUrl, size }
const _fetching = new Map();    // key → { priority, controller, progress }
const MAX_CONCURRENT = 3;
const IDLE_ABORT_MS = 30000;
const _queue = [];              // priority-sorted FIFO
// A download that FAILED (link dropped, body cut short, server 5xx) is tried again.
// It used to be dropped for good: nothing asked for that track again until the next
// `playing` event, so one network blip meant the transition into it ran off the live
// stream. Exported (and mutable) so the tests do not wait real seconds.
export const RETRY_DELAYS_MS = [3000, 10000, 30000];
const RETRY_FORGET_MS = 5 * 60 * 1000;
const _retries = new Map();     // key → { n, timer, last }
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
  // …and a pending retry of a download that is stale now must not bring it back.
  for (const [key, r] of _retries) {
    if (keep.has(key)) continue;
    clearTimeout(r.timer);
    _retries.delete(key);
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
  for (const [, r] of _retries) clearTimeout(r.timer);
  _retries.clear();
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

// The order tracks will really be played in is not always index + 1: under shuffle
// it is a permutation only the queue module knows. The engine registers a provider
// returning the upcoming queue indices (or null for "sequential"); without it the
// window below downloaded three tracks nobody was about to play on every advance,
// and cleanup() evicted the one that was.
let _upcomingProvider = null;
export function setUpcomingProvider(fn) { _upcomingProvider = fn; }

function _upcomingIndices(queue, currentIndex, count) {
  if (_upcomingProvider && queue === store.playerQueue) {
    let custom = null;
    try { custom = _upcomingProvider(count); } catch (e) { custom = null; }
    if (Array.isArray(custom)) {
      return custom.filter(i => Number.isInteger(i) && i >= 0 && i < queue.length).slice(0, count);
    }
  }
  const out = [];
  for (let i = currentIndex + 1; i < queue.length && i <= currentIndex + count; i++) out.push(i);
  return out;
}

function _fillQueueFrom(queue, currentIndex, count) {
  const upcoming = _upcomingIndices(queue, currentIndex, count);
  for (let n = 0; n < upcoming.length; n++) {
    const i = upcoming[n];
    const item = queue[i];
    const key = _key(item.name, item.artist, item.id);
    if (_cache.has(key) || _fetching.has(key) || _queue.some(q => q.key === key)) continue;
    _queue.push({ item, key, priority: n + 1 });
  }
}

/** Still worth downloading: in the window of what plays next (the same one cleanup()
 *  keeps), pinned by a preload, or asked for by the engine by name (priority 0 — the
 *  bound next track, which Smart Queue takes from anywhere) and still in the queue.
 *  A track the user skipped past is neither: abortStale() drops its pending retry. */
function _stillWanted(entry) {
  const key = entry.key;
  if (_pinned.has(key)) return true;
  const q = store.playerQueue || [];
  for (const i of _upcomingIndices(q, store.playerIndex, _prefetchCount() + 2)) {
    if (q[i] && _key(q[i].name, q[i].artist, q[i].id) === key) return true;
  }
  if (entry.priority !== 0) return false;
  for (let i = 0; i < q.length; i++) {
    if (i !== store.playerIndex && q[i] && _key(q[i].name, q[i].artist, q[i].id) === key) return true;
  }
  return false;
}

function _retryLater(entry) {
  const now = Date.now();
  let r = _retries.get(entry.key);
  if (!r || now - r.last > RETRY_FORGET_MS) r = { n: 0, timer: null, last: now };
  r.last = now;
  _retries.set(entry.key, r);
  clearTimeout(r.timer);
  // Gave up: forget it, so a later request (the next `playing`, a refill) starts afresh.
  if (r.n >= RETRY_DELAYS_MS.length) { _retries.delete(entry.key); return; }
  r.timer = setTimeout(() => {
    r.timer = null;
    // Paused: resumePrefetch() refills the window itself, and the engine asks for the
    // bound next track on every `playing`. Not an attempt — do not count it.
    if (_paused || store.castDevice) { r.n = Math.max(0, r.n - 1); return; }
    if (_cache.has(entry.key) || _fetching.has(entry.key) || _queue.some(q => q.key === entry.key)) return;
    if (!_stillWanted(entry)) { _retries.delete(entry.key); return; }
    // By priority: a retry from further down the window must not jump ahead of the
    // track the engine has just asked for.
    const at = _queue.findIndex(q => q.priority > entry.priority);
    if (at < 0) _queue.push(entry); else _queue.splice(at, 0, entry);
    _processNext();
  }, RETRY_DELAYS_MS[r.n]);
  r.n++;
}

/** Process queue — up to MAX_CONCURRENT downloads at a time. */
function _processNext() {
  while (!_paused && _fetching.size < MAX_CONCURRENT && _queue.length > 0) {
    const entry = _queue.shift();
    if (_cache.has(entry.key) || _fetching.has(entry.key)) continue;
    _startFetch(entry);
  }
}

// A mix found in search plays from /api/player/mix-stream while the server builds it. It
// is never prefetched: a blob of a 100-300 MB set is device memory for nothing, and the
// title-based /api/player/stream this module uses could resolve to another recording.
// prefetchTrack() is called with a name only, so the queue is asked who the key belongs to.
function _isStreamedMix(entry) {
  if (entry.item && entry.item.mix_url) return true;
  const q = store.playerQueue || [];
  return q.some(t => t && t.mix_url && _key(t.name, t.artist, t.id) === entry.key);
}

async function _startFetch(entry) {
  if (_isStreamedMix(entry)) return;
  const controller = new AbortController();
  const state = { priority: entry.priority, controller, progress: 0, idleAbort: false };
  _fetching.set(entry.key, state);
  // Only OUR registration: after an abort the same key may already belong to a newer
  // download, and deleting that one threw its finished blob away.
  const drop = () => { if (_fetching.get(entry.key) === state) _fetching.delete(entry.key); };

  try {
    const cleanName = _decodeEntities(entry.item.name || '');
    const cleanArtist = _decodeEntities(entry.item.artist || '');
    const url = () => `/api/player/stream?${new URLSearchParams({ name: cleanName, artist: cleanArtist, token: streamToken() })}&quality=${streamQuality()}`;
    // Plain fetch, not apiFetch. The stream endpoint authenticates by the token in the
    // URL, and a 401 here means THAT token expired — apiFetch reads every 401 as "the
    // session is over", logs the user out and reloads the page: the music stopped
    // mid-set because a background download was refused. Mint a new token, try once.
    let res = await fetch(url(), { signal: controller.signal });
    if (res.status === 401) {
      await refreshStreamToken();
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      res = await fetch(url(), { signal: controller.signal });
    }
    if (!res.ok) {
      drop();
      if (res.status >= 500) _retryLater(entry);     // a 4xx is an answer, not a hiccup
      _processNext(); return;
    }
    // Validate content-type — reject HTML/JSON error pages served with 200 status.
    // Accept audio/* and application/octet-stream (some flac/mp3 streams use it).
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('audio/') && !ct.startsWith('application/octet-stream')) {
      drop(); _processNext(); return;
    }

    // Track download progress via ReadableStream
    const total = parseInt(res.headers.get('content-length')) || 0;
    let blob;
    if (total && res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      // A connection that went half-open (a network switch, a dozing radio) delivers
      // nothing and never fails. The download then sat in _fetching for good — where
      // it is protected from cleanup and blocks a retry — so that track was never
      // cached. Bytes have started; 30 s without another one is a dead link.
      let idle = null;
      const arm = () => { clearTimeout(idle); idle = setTimeout(() => { state.idleAbort = true; try { controller.abort(); } catch (e) {} }, IDLE_ABORT_MS); };
      try {
        arm();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          chunks.push(value);
          received += value.length;
          state.progress = Math.round((received / total) * 100);
        }
      } finally { clearTimeout(idle); }
      // A body that ends early WITHOUT throwing (proxy cut, server-side stream
      // giving up) would otherwise be cached as a complete track. The container
      // header still declares the full duration, so playback would run out of
      // audio partway and play silence to the shown end — never cache a short read.
      if (received !== total) { drop(); _retryLater(entry); _processNext(); return; }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
    }
    // Reject suspiciously small bodies — an error page/JSON served as octet-stream
    // with HTTP 200 would otherwise poison the cache for the full 4h stream TTL.
    if (blob.size < 10240) { drop(); _processNext(); return; }
    // Aborted mid-flight (skip/clear deleted the _fetching entry): don't poison the
    // cache with a blob for an already-skipped track, and don't leak the object URL.
    if (controller.signal.aborted || _fetching.get(entry.key) !== state) { _processNext(); return; }
    _cache.set(entry.key, { blobUrl: URL.createObjectURL(blob), size: blob.size });
    state.progress = 100;
    const done = _retries.get(entry.key);
    if (done) { clearTimeout(done.timer); _retries.delete(entry.key); }
  } catch (e) {
    // A user/engine abort (skip, queue cleared) is final. A network error, or our own
    // idle abort of a link that went dead, is worth another try.
    if ((e.name !== 'AbortError' || state.idleAbort) && _fetching.get(entry.key) === state) _retryLater(entry);
  }

  drop();
  if (!_paused) _processNext();
}

/** Revoke blob URLs for tracks outside the keep window.
 *  `alsoKeep` — cache keys (keyFor) that must survive whatever their queue position:
 *  the track the engine has bound as next. Smart Queue and shuffle pick it from
 *  anywhere in the queue, so the index window alone threw that blob away the moment
 *  the crossfade finished and the transition into it then ran off the live stream. */
export function cleanup(queue, currentIndex, alsoKeep) {
  if (!queue || !queue.length) return;
  const count = _prefetchCount();
  const keepKeys = new Set(alsoKeep || []);
  for (const i of _upcomingIndices(queue, currentIndex, count + 2)) {
    keepKeys.add(_key(queue[i].name, queue[i].artist, queue[i].id));
  }
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
