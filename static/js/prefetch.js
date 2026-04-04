// prefetch.js — Prefetch upcoming tracks for smooth crossfade
// Based on proven working version with targeted improvements.

import { store } from './store.js';
import { apiFetch } from './api.js';

const _cache = new Map();       // "artist:name" → { blobUrl }
const _fetching = new Map();    // key → { priority, controller, progress }
const MAX_CONCURRENT = 2;
function _prefetchCount() { return parseInt(localStorage.getItem('ms_dj_prefetch_count')) || 3; }

let _paused = false;
export function pausePrefetch() { _paused = true; }
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

/** Get prefetch status for a track. */
export function getStatus(name, artist) {
  const key = _key(name, artist);
  if (_cache.has(key)) return { state: 'ready', progress: 100 };
  const f = _fetching.get(key);
  if (f) return { state: 'loading', progress: f.progress || 0 };
  return null;
}

/** Prefetch a specific track with highest priority (for Smart Queue). */
export function prefetchTrack(name, artist) {
  if (store.castDevice || _paused) return;
  const key = _key(name, artist);
  if (_cache.has(key) || _fetching.has(key)) return;
  _fetchTrack({ name, artist }, key, 0);
}

/** Prefetch next N tracks from current position. */
export function prefetchUpcoming(queue, currentIndex, count) {
  if (count == null) count = _prefetchCount();
  if (store.castDevice || !queue || !queue.length || _paused) return;

  const toFetch = [];
  for (let i = currentIndex + 1; i < queue.length && toFetch.length < count; i++) {
    const item = queue[i];
    const key = _key(item.name, item.artist);
    if (!_cache.has(key) && !_fetching.has(key)) {
      toFetch.push({ item, key, priority: i - currentIndex });
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
  const state = { priority, controller, progress: 0 };
  _fetching.set(key, state);
  try {
    const cleanName = _decodeEntities(item.name || '');
    const cleanArtist = _decodeEntities(item.artist || '');
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    const res = await apiFetch(`/api/player/stream?${params}`, { signal: controller.signal });
    if (!res.ok) { _fetching.delete(key); return; }

    // Track download progress via ReadableStream if Content-Length available
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
    _cache.set(key, { blobUrl: URL.createObjectURL(blob) });
    state.progress = 100;
  } catch (e) {
    if (e.name !== 'AbortError') { /* network error, skip */ }
  } finally {
    _fetching.delete(key);
    // After one finishes, try to start more
    if (!_paused) prefetchUpcoming(store.playerQueue, store.playerIndex);
  }
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
  // Keep anything currently being fetched
  for (const [k] of _fetching) keepKeys.add(k);
  for (const [k, entry] of _cache) {
    if (!keepKeys.has(k)) {
      URL.revokeObjectURL(entry.blobUrl);
      _cache.delete(k);
    }
  }
}
