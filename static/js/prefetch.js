// prefetch.js — Prefetch upcoming tracks for smooth crossfade
// 2 concurrent downloads, priority queue, progress tracking.

import { store } from './store.js';
import { apiFetch } from './api.js';

const _cache = new Map();       // "artist:name" → { blobUrl }
const _fetching = new Map();    // key → { priority, controller, progress }
const MAX_CONCURRENT = 2;
const _queue = [];              // priority-sorted FIFO
function _prefetchCount() { return parseInt(localStorage.getItem('ms_dj_prefetch_count')) || 3; }

let _paused = false;
export function pausePrefetch() { _paused = true; }
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

// Always decode entities before building key — ensures loadAndPlay lookups match
function _key(name, artist) {
  return `${_decodeEntities((artist || '')).toLowerCase().trim()}:${_decodeEntities((name || '')).toLowerCase().trim()}`;
}

/** Return cached blob URL if available, or null. */
export function getCachedUrl(name, artist) {
  const entry = _cache.get(_key(name, artist));
  return entry ? entry.blobUrl : null;
}

/** Get prefetch status for a track. */
export function getStatus(name, artist) {
  const key = _key(name, artist);
  if (_cache.has(key)) return { state: 'ready', progress: 100 };
  const f = _fetching.get(key);
  if (f) return { state: 'loading', progress: f.progress || 0 };
  if (_queue.some(q => q.key === key)) return { state: 'queued', progress: 0 };
  return null;
}

/** Prefetch a specific track at front of queue (for Smart Queue). */
export function prefetchTrack(name, artist) {
  if (store.castDevice || _paused) return;
  const key = _key(name, artist);
  if (_cache.has(key) || _fetching.has(key)) return;
  // Remove from queue if already there, re-add at front
  const idx = _queue.findIndex(q => q.key === key);
  if (idx >= 0) _queue.splice(idx, 1);
  _queue.unshift({ item: { name, artist }, key, priority: 0 });
  _processNext();
}

/** Prefetch next N tracks from current position. */
export function prefetchUpcoming(queue, currentIndex, count) {
  if (count == null) count = _prefetchCount();
  if (store.castDevice || !queue || !queue.length || _paused) return;
  _fillQueueFrom(queue, currentIndex, count);
  _processNext();
}

function _fillQueue() {
  _fillQueueFrom(store.playerQueue, store.playerIndex, _prefetchCount());
}

function _fillQueueFrom(queue, currentIndex, count) {
  for (let i = currentIndex + 1; i < queue.length && i <= currentIndex + count; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist);
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
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    const res = await apiFetch(`/api/player/stream?${params}`, { signal: controller.signal });
    if (!res.ok) { _fetching.delete(entry.key); _processNext(); return; }

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
    _cache.set(entry.key, { blobUrl: URL.createObjectURL(blob) });
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
    keepKeys.add(_key(queue[i].name, queue[i].artist));
  }
  for (const [k] of _fetching) keepKeys.add(k);
  for (const q of _queue) keepKeys.add(q.key);
  for (const [k, entry] of _cache) {
    if (!keepKeys.has(k)) {
      URL.revokeObjectURL(entry.blobUrl);
      _cache.delete(k);
    }
  }
}
