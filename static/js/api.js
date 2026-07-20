// api.js — API communication functions

import { store } from './store.js';

// ── Auth Headers ──
export function authHeaders() {
  const h = store.authToken ? { 'Authorization': `Bearer ${store.authToken}` } : {};
  if (store.deviceId) h['X-Device-ID'] = store.deviceId;
  return h;
}

// ── Fetch with Auth + 401 Handling ──
export async function apiFetch(url, opts = {}) {
  opts.headers = { ...authHeaders(), ...(opts.headers || {}) };
  const res = await fetch(url, opts);
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
    throw new Error(body.detail || res.statusText);
  }
  return res.json();
}

// ── Stream token ──
// Mint a short-lived, stream-scoped token so the full session JWT never appears in
// stream URLs (logs, history, Referer, DLNA metadata). Stored in store.streamToken
// and used by the player/prefetch when building /api/player/stream URLs.
export async function refreshStreamToken() {
  try {
    const d = await apiJson('/api/player/stream-token');
    store.streamToken = d.token || null;
    return store.streamToken;
  } catch (e) {
    // Playback still works via the session-token fallback, but the C2/C3 hardening
    // silently degrades — surface it once so it's diagnosable.
    console.warn('Stream token refresh failed; stream URLs fall back to the session token.', e);
    return null;
  }
}
