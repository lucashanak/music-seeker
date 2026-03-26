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
  return res.json();
}
