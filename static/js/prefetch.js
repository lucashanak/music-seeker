// prefetch.js — Prefetch upcoming tracks for offline resilience
// Priority: current track (if not loaded) > next track > next 4

import { store } from './store.js';
import { apiFetch } from './api.js';

// Cache: "artist:name" → { blobUrl, key }
const _cache = new Map();
const _fetching = new Map(); // key → { priority, controller }
const MAX_CONCURRENT = 1;
function _prefetchCount() { return parseInt(localStorage.getItem('ms_dj_prefetch_count')) || 3; }

let _paused = false;
/** Stop starting new prefetches (running ones finish). */
export function pausePrefetch() { _paused = true; }
/** Resume prefetching from current queue position. */
export function resumePrefetch() { _paused = false; prefetchUpcoming(store.playerQueue, store.playerIndex); }

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

/** Prefetch current + next N tracks, prioritized. */
export function prefetchUpcoming(queue, currentIndex, count) {
  if (count == null) count = _prefetchCount();
  if (store.castDevice || !queue || !queue.length || _paused) return;

  // Build priority list: next track (1) > rest (2+)
  // Current track is NOT prefetched — loadAndPlay loads it directly via audio.src
  const toFetch = [];

  // Next tracks (starting from currentIndex + 1)
  for (let i = currentIndex + 1; i < queue.length && toFetch.length < count; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist);
    if (!_cache.has(key) && !_fetching.has(key)) {
      toFetch.push({ item, key, priority: i - currentIndex });
    }
  }

  // Cancel lower-priority fetches if higher-priority ones need slots
  if (toFetch.length > 0 && _fetching.size >= MAX_CONCURRENT) {
    const highestNeed = toFetch[0].priority;
    for (const [key, info] of _fetching) {
      if (info.priority > highestNeed + _prefetchCount()) {
        // Cancel far-away fetch to make room
        info.controller.abort();
        _fetching.delete(key);
      }
    }
  }

  // Start fetches up to concurrency limit
  let active = _fetching.size;
  for (const { item, key, priority } of toFetch) {
    if (active >= MAX_CONCURRENT) break;
    active++;
    _fetchTrack(item, key, priority);
  }
}

async function _fetchTrack(item, key, priority) {
  const controller = new AbortController();
  _fetching.set(key, { priority, controller });
  try {
    const cleanName = _decodeEntities(item.name || '');
    const cleanArtist = _decodeEntities(item.artist || '');
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    const res = await apiFetch(`/api/player/stream?${params}`, { signal: controller.signal });
    if (!res.ok) return;
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    _cache.set(key, { blobUrl, key });
    _fetching.delete(key);
    // After one finishes, try to start more
    prefetchUpcoming(store.playerQueue, store.playerIndex);
  } catch (e) {
    if (e.name !== 'AbortError') {
      // Network error — silently skip
    }
  } finally {
    _fetching.delete(key);
  }
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
  for (const [k, entry] of _cache) {
    if (!keepKeys.has(k)) {
      URL.revokeObjectURL(entry.blobUrl);
      _cache.delete(k);
    }
  }
}
