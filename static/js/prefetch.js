// prefetch.js — Sequential track prefetch for offline resilience + crossfade
// Strict FIFO queue: one download at a time, priority-ordered.

import { store } from './store.js';
import { apiFetch } from './api.js';

// Cache: "artist:name" → { blobUrl }
const _cache = new Map();
const _activeFetches = new Map(); // key → controller (max 2 concurrent)
const MAX_CONCURRENT = 2;
let _paused = false;
const _queue = [];         // priority queue: [{ item, key, priority }]

function _prefetchCount() { return parseInt(localStorage.getItem('ms_dj_prefetch_count')) || 3; }

function _key(name, artist) {
  return `${(artist || '').toLowerCase().trim()}:${(name || '').toLowerCase().trim()}`;
}

function _decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

/** Return cached blob URL if available, or null. */
export function getCachedUrl(name, artist) {
  const entry = _cache.get(_key(name, artist));
  return entry ? entry.blobUrl : null;
}

/** Stop starting new fetches. Current download finishes. */
export function pausePrefetch() { _paused = true; }

/** Resume and refill queue from current position. */
export function resumePrefetch() {
  _paused = false;
  _fillQueue();
  _processNext();
}

/** Add a specific track to front of queue (highest priority). */
export function prefetchTrack(name, artist) {
  if (store.castDevice) return;
  const key = _key(name, artist);
  if (_cache.has(key)) return; // already cached
  // Remove if already in queue, then add at front
  const idx = _queue.findIndex(q => q.key === key);
  if (idx >= 0) _queue.splice(idx, 1);
  if (_activeFetches.has(key)) return;
  _queue.unshift({ item: { name, artist }, key, priority: 0 });
  _processNext();
}

/** Build sequential prefetch queue from current queue position. */
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
    if (_cache.has(key)) continue;
    if (_activeFetches.has(key)) continue;
    if (_queue.some(q => q.key === key)) continue;
    _queue.push({ item, key, priority: i - currentIndex });
  }
}

/** Process queue — up to MAX_CONCURRENT (2) downloads at a time. */
async function _processNext() {
  while (!_paused && _activeFetches.size < MAX_CONCURRENT && _queue.length > 0) {
    const entry = _queue.shift();
    if (_cache.has(entry.key) || _activeFetches.has(entry.key)) continue;
    _startFetch(entry);
  }
}

async function _startFetch(entry) {
  const controller = new AbortController();
  _activeFetches.set(entry.key, controller);

  try {
    const cleanName = _decodeEntities(entry.item.name || '');
    const cleanArtist = _decodeEntities(entry.item.artist || '');
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    const res = await apiFetch(`/api/player/stream?${params}`, { signal: controller.signal });
    if (res.ok) {
      const blob = await res.blob();
      _cache.set(entry.key, { blobUrl: URL.createObjectURL(blob) });
    }
  } catch (e) {
    if (e.name !== 'AbortError') { /* network error, skip */ }
  }

  _activeFetches.delete(entry.key);
  if (!_paused) _processNext();
}

/** Revoke blob URLs for tracks outside the keep window. */
export function cleanup(queue, currentIndex) {
  if (!queue || !queue.length) return;
  const keepKeys = new Set();
  const lo = Math.max(0, currentIndex - 1);
  const hi = Math.min(queue.length - 1, currentIndex + _prefetchCount());
  for (let i = lo; i <= hi; i++) {
    keepKeys.add(_key(queue[i].name, queue[i].artist));
  }
  // Keep actively fetching tracks
  for (const [k] of _activeFetches) keepKeys.add(k);
  // Keep everything in queue (Smart Queue picks etc.)
  for (const q of _queue) keepKeys.add(q.key);
  for (const [k, entry] of _cache) {
    if (!keepKeys.has(k)) {
      URL.revokeObjectURL(entry.blobUrl);
      _cache.delete(k);
    }
  }
}
