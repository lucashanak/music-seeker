// prefetch.js — Prefetch upcoming tracks for offline resilience

import { store } from './store.js';
import { apiFetch } from './api.js';

// Cache: "artist:name" → { blobUrl, key }
const _cache = new Map();
const _fetching = new Set(); // keys currently being fetched
const MAX_CONCURRENT = 2;
const PREFETCH_COUNT = 5;

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

/** Prefetch next N tracks from queue starting after currentIndex. */
export function prefetchUpcoming(queue, currentIndex, count = PREFETCH_COUNT) {
  // Don't prefetch in DLNA/cast mode
  if (store.castDevice) return;
  if (!queue || !queue.length) return;

  const toFetch = [];
  for (let i = currentIndex + 1; i < queue.length && toFetch.length < count; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist);
    if (!_cache.has(key) && !_fetching.has(key)) {
      toFetch.push({ item, key });
    }
  }

  // Limit concurrency
  let active = _fetching.size;
  for (const { item, key } of toFetch) {
    if (active >= MAX_CONCURRENT) break;
    active++;
    _fetchTrack(item, key);
  }
}

async function _fetchTrack(item, key) {
  _fetching.add(key);
  try {
    const cleanName = _decodeEntities(item.name || '');
    const cleanArtist = _decodeEntities(item.artist || '');
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    const res = await apiFetch(`/api/player/stream?${params}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    _cache.set(key, { blobUrl, key });
    // After one finishes, try to start more from the current queue
    _fetching.delete(key);
    prefetchUpcoming(store.playerQueue, store.playerIndex);
  } catch {
    // Network error — silently skip
  } finally {
    _fetching.delete(key);
  }
}

/** Revoke blob URLs for tracks outside the keep window (current-1 .. current+PREFETCH_COUNT). */
export function cleanup(queue, currentIndex) {
  if (!queue || !queue.length) return;
  const keepKeys = new Set();
  const lo = Math.max(0, currentIndex - 1);
  const hi = Math.min(queue.length - 1, currentIndex + PREFETCH_COUNT);
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
