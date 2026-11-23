// api.js — API communication functions

import { store } from './store.js';

// ── Auth Headers ──
export function authHeaders() {
  const h = store.authToken ? { 'Authorization': `Bearer ${store.authToken}` } : {};
  if (store.deviceId) h['X-Device-ID'] = store.deviceId;
  return h;
}

// ── Fetch with Auth + 401 Handling ──
// A write that changes what the Library shows (GitHub #12). Every playlist write
// in the app goes through here, from whichever page made it — the player bar,
// a context menu, the manager — so this is the one place that sees them all.
// `librarychange` fires after the write answered OK; `libraryWritesInFlight`
// lets a listener tell that another one is still on its way.
const _LIBRARY_WRITE = /^\/api\/library\/(playlist|track\/delete|album\/delete)/;
let _libraryWrites = 0;
export function libraryWritesInFlight() { return _libraryWrites; }

export async function apiFetch(url, opts = {}) {
  opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  const libWrite = method !== 'GET' && method !== 'HEAD' && _LIBRARY_WRITE.test(String(url));
  if (libWrite) _libraryWrites++;
  let res;
  try {
    res = await fetch(url, opts);
  } finally {
    if (libWrite) _libraryWrites--;
  }
  if (libWrite && res.ok) {
    try { window.dispatchEvent(new CustomEvent('librarychange', { detail: { url: String(url), method } })); } catch {}
  }
  // Sliding session renewal: the server hands back a fresh token via this header
  // once the current one is past half its lifetime. Swap it in so an active
  // session rolls forward indefinitely and never hits the hard expiry.
  const refreshed = res.headers.get('X-Refresh-Token');
  if (refreshed && refreshed !== store.authToken) {
    store.authToken = refreshed;
    try { localStorage.setItem('ms_token', refreshed); } catch {}
  }
  if (res.status === 401) {
    if (store.authToken) {
      // Dispatch event instead of calling logout() directly to avoid circular imports
      document.dispatchEvent(new Event('auth:logout'));
    }
    throw new Error('Session expired');
  }
  return res;
}

// ── JSON API Wrapper ──
export async function apiJson(url, opts = {}) {
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.body = JSON.stringify(opts.body);
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  const res = await apiFetch(url, opts);
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // FastAPI/Pydantic validation errors return `detail` as an ARRAY of
    // {msg, loc, ...} objects (truthy but not a string) — stringifying it
    // verbatim used to show the user a literal "[object Object]" toast.
    // A handler that needs the caller to branch on WHY it failed sends an object
    // ({message, cause}); without this branch that object stringified to
    // "[object Object]" exactly like the array case above.
    const d = body.detail;
    let msg, reason;
    if (Array.isArray(d)) {
      msg = d[0]?.msg || res.statusText;
    } else if (d && typeof d === 'object') {
      msg = d.message || res.statusText;
      reason = d.cause;
    } else {
      msg = d || res.statusText;
    }
    const err = new Error(msg);
    err.status = res.status;
    if (reason) err.reason = reason;
    throw err;
  }
  return res.json();
}

// ── Stream token ──
// Mint a short-lived, stream-scoped token so the full session JWT never appears in
// stream URLs (logs, history, Referer, DLNA metadata). Stored in store.streamToken
// and used by the player/prefetch when building /api/player/stream URLs.
let _streamTokenAt = 0;       // wall clock of the last successful mint
let _streamTokenBusy = null;  // in-flight refresh, shared by concurrent callers
const STREAM_TOKEN_STALE_MS = 4 * 3600 * 1000; // the token lives 6 h

/** The token to put in a stream URL. Also the place its age is checked: the 5-hourly
 *  timer runs on a clock that stops while the device sleeps and it does not retry, so
 *  one missed refresh left an expired token in every stream URL for hours — and a 401
 *  on a prefetch then logged the user out mid-set. Whoever builds a stream URL passes
 *  through here, so an ageing token is renewed by use, on wall-clock time. */
export function streamToken() {
  if (store.streamToken && Date.now() - _streamTokenAt > STREAM_TOKEN_STALE_MS) refreshStreamToken();
  return store.streamToken || store.authToken;
}

/** Stream URL of a mix found in search (an item with `mix_url`), else ''. The exact URL
 *  plays: /api/player/stream resolves by title and could land on another recording.
 *  Always progressive — the file is built while it plays (services/mix_stream.py). */
export function mixPlayUrl(item) {
  if (!item || !item.mix_url) return '';
  // dur: the length the search result gave — the server refuses a download clearly shorter.
  const dur = item.duration_ms > 0 ? `&dur=${Math.round(item.duration_ms / 1000)}` : '';
  return `/api/player/mix-stream?${new URLSearchParams({ url: item.mix_url, token: streamToken() })}&progressive=1${dur}`;
}

/** Resolves to a stream token that is not past its staleness age (renewing first). */
export async function freshStreamToken() {
  if (!store.streamToken || Date.now() - _streamTokenAt > STREAM_TOKEN_STALE_MS) await refreshStreamToken();
  return store.streamToken || store.authToken;
}

export function refreshStreamToken() {
  if (!_streamTokenBusy) {
    _streamTokenBusy = _refreshStreamToken().finally(() => { _streamTokenBusy = null; });
  }
  return _streamTokenBusy;
}

async function _refreshStreamToken() {
  try {
    const d = await apiJson('/api/player/stream-token');
    store.streamToken = d.token || null;
    if (store.streamToken) _streamTokenAt = Date.now();
    return store.streamToken;
  } catch (e) {
    // Playback still works via the session-token fallback, but the C2/C3 hardening
    // silently degrades — surface it once so it's diagnosable.
    console.warn('Stream token refresh failed; stream URLs fall back to the session token.', e);
    return null;
  }
}
