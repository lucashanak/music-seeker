// mixlog.js — the client's side of the log for streamed mixes.
//
// We were blind on the macOS app (WKWebView): the server answered every request 206 and the
// page still raised a media error and skipped. Both engines report what the element says —
// every `error` (MediaError code and message), every `ended`, every recovery step and every
// change of its source (with the functions that made it) — to POST /api/player/client-log,
// which the server writes to its own log under musicseeker.mixstream. Cheap and capped: at
// most 30 lines a minute per user here, and the server caps again; never a token or a URL
// (the source is reduced to "prog" / "plain" / "other").
import { store } from './store.js';
import { authHeaders } from './api.js';
import { isMixStreamSrc } from './mixstream.js';

const MAX_PER_MIN = 30;
let _times = [];

const srcKind = (src) => (!src ? 'none' : !isMixStreamSrc(src) ? 'other' : /progressive=1/.test(src) ? 'prog' : 'plain');
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : (v === Infinity ? 'inf' : null));

/** The names of the functions that led here (no files, no URLs). */
export function callers(skip = 2, n = 4) {
  try {
    return String(new Error().stack || '').split('\n').slice(skip + 1)
      .map((l) => (/^\s*at\s+(?:async\s+)?([^\s(]+)/.exec(l) || /^\s*([^@\s]*)@/.exec(l) || [])[1]).filter((x) => x && x !== 'set' && x !== 'callers').slice(0, n).join('<');   // V8 "at fn (url)" and WebKit/Firefox "fn@url"
  } catch { return ''; }
}

/** Report `kind` for the element `el` (only while a streamed mix is the track / its source). */
export function mixLog(kind, el, extra = {}, engine = '') {
  try {
    const item = (store.playerQueue || [])[store.playerIndex];
    if (!(item && item.mix_url) && !isMixStreamSrc(el && el.src)) return;
    const now = Date.now();
    _times = _times.filter((t) => now - t < 60000);
    if (_times.length >= MAX_PER_MIN) return;
    _times.push(now);
    const body = {
      k: kind, eng: engine || (typeof localStorage !== 'undefined' ? localStorage.getItem('ms_player_engine') : '') || 'classic',
      src: srcKind(el && el.src), t: num(el && el.currentTime), rs: el && el.readyState, ns: el && el.networkState,
      buf: num(el && el.buffered && el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0),
      dur: num(el && el.duration), paused: !!(el && el.paused),
      ec: el && el.error ? el.error.code : null, em: el && el.error ? String(el.error.message || '').slice(0, 120) : null,
      ...extra,
    };
    fetch('/api/player/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body), keepalive: true }).catch(() => {});
  } catch {}
}

/** Report every assignment of `el.src` that is a streamed mix, with its callers. */
export function watchMixSrc(el, engine) {
  try {
    if (typeof HTMLMediaElement === 'undefined' || el.__mixSrcWatched) return;
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (!d) return;
    el.__mixSrcWatched = true;
    Object.defineProperty(el, 'src', {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { this._mixRec = false; if (isMixStreamSrc(v)) mixLog('src', this, { to: srcKind(String(v)), why: callers(2) }, engine); d.set.call(this, v); },
    });
  } catch {}
}

/** The error/ended/stalled/abort events of a deck, reported. */
export function watchMixEvents(el, engine) {
  for (const ev of ['error', 'ended', 'stalled', 'abort', 'emptied']) {
    el.addEventListener(ev, () => mixLog(ev, el, {}, engine));
  }
}
