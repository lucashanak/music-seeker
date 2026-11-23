// mixstream.js — what the player does differently for a mix that is streamed from its
// own site (a queue item with `mix_url`, server: services/mix_stream.py).
//
// The server builds a cache file while the deck plays it ("progressive": a body with no
// Range and no Content-Length). Three consequences live here, shared by both engines:
//  - a seek inside what is buffered is the browser's own; a seek beyond it cannot be
//    answered until the file is finished — then the finished file (with Range) is
//    reloaded; before that the listener is told, and the music plays on;
//  - a refusal (429 / 502 / 503) reaches the audio element as a bare "error": the
//    server is asked what it was, and the listener is told;
//  - restoring a saved position in a build that is not there yet waits for it.
import { streamToken } from './api.js';
import { showToast } from './utils.js';

export const isMixStreamSrc = (src) => String(src || '').includes('/api/player/mix-stream');
const isProgressive = (src) => String(src || '').includes('progressive=1');

// What the server said about each mix's finished file: url -> its real length in seconds.
const _finished = new Map();
const _urlOf = (src) => { try { return new URL(src, location.href).searchParams.get('url') || ''; } catch { return ''; } };

/** The length to use for a streamed mix, or 0 to use the element's own.
 *  One rule, in both engines: the element's duration is never trusted while the file is
 *  being built (a fragmented MP4 under construction reports what has arrived — 0:07 at
 *  second 7 — and near a real-time fetch it sits just behind the playhead, so the
 *  auto-transition fired at ~90 % of the set). Until the server says the file is finished
 *  the search result's length (`dur` in the URL, a display hint) stands; after that, the
 *  finished file's real length as the server measured it. */
export function mixKnownDuration(src) {
  if (!isMixStreamSrc(src)) return 0;
  const real = _finished.get(_urlOf(src));
  if (real > 0) return real;
  if (!isProgressive(src)) return 0;                    // the finished file, loaded by us
  let dur = 0;
  try { dur = Number(new URL(src, location.href).searchParams.get('dur')) || 0; } catch {}
  return dur > 0 ? dur : 0;
}

/** An `ended` that is not the end of the mix. A media element that takes the edge of what it has
 *  parsed or buffered for the end of the file (WebKit with a fragmented MP4 or an index it has
 *  not read; any element on a body that was cut) fires `ended` minutes into a set — and the
 *  engine would advance to whatever is next (Autoplay, when the queue holds only the mix).
 *  True when the element is more than 20 s short of the length we know (the finished file's,
 *  else the search result's). Callers retry ONCE per 30 s from the same position before they
 *  believe such an end (a file that really is shorter than claimed must still move on). */
export function isPrematureMixEnd(el, item) {
  if (!item || !item.mix_url || !isMixStreamSrc(el.src)) return false;
  const known = mixKnownDuration(el.src) || (item.duration_ms > 0 ? item.duration_ms / 1000 : 0);
  return known > 60 && (el.currentTime || 0) < known - 20;
}

/** True when `t` lies inside a buffered range of the element. */
export function bufferedTo(el, t) {
  try {
    for (let i = 0; i < el.buffered.length; i++) {
      if (t >= el.buffered.start(i) - 0.25 && t <= el.buffered.end(i)) return true;
    }
  } catch {}
  return false;
}

/** The server's view of the stream behind `src`: {ok, cached, building, status, message} or null. */
export async function mixStatus(src) {
  try {
    const u = new URL(src, location.href);
    const q = new URLSearchParams({ url: u.searchParams.get('url') || '', token: streamToken() });
    const r = await fetch(`/api/player/mix-stream-status?${q}`);
    const st = r.ok ? await r.json() : null;
    if (st && st.cached && st.duration > 0) _finished.set(u.searchParams.get('url') || '', st.duration);
    return st;
  } catch { return null; }
}

/** What to do for a seek to `to` on an element playing a streamed mix:
 *  'direct' (the element can), 'reload' (the finished file exists: load it, seek there),
 *  'wait' (the target is beyond what is fetched: say so, change nothing). */
export async function planMixSeek(el, to) {
  if (!isProgressive(el.src)) return 'direct';          // the finished file, with Range
  if (bufferedTo(el, to)) return 'direct';
  const st = await mixStatus(el.src);
  return st && st.cached ? 'reload' : 'wait';
}

export function toastSeekBeyondBuilt() {
  showToast('That part of the mix is available once it has been fetched');
}

/** Ask the server why a stream was refused and tell the listener; `fallback` otherwise. */
export async function explainMixFailure(item, fallback = 'Stream error') {
  let msg = fallback;
  try {
    if (item && item.mix_url) {
      const st = await mixStatus(`/api/player/mix-stream?${new URLSearchParams({ url: item.mix_url })}`);
      if (st && st.ok === false && st.message) msg = st.message;
    }
  } catch {}
  showToast(msg, true);
}

/** Wait for the finished file of the stream on `el`, then `load(pos)` (the engine's "load the
 *  finished file and seek"). The listener sees "Fetching the mix…" meanwhile. Stops — without
 *  loading — as soon as the element holds another source (`still()` is false or the source
 *  changed): a poll started for one mix must never move a different one. `giveUp(message)`
 *  when the server says the mix cannot be fetched or after ~10 minutes. */
export function awaitFinished(el, pos, load, still, giveUp, label) {
  const src0 = el.src;
  const same = () => el.src === src0 && still();
  const say = (st) => {            // one calm line, not an error: what the server has fetched so far
    let tail = '';
    if (st && st.progress > 0) tail = ` ${Math.round(st.progress * 100)} %`;
    else if (st && st.bytes > 0) tail = ` ${(st.bytes / 1048576).toFixed(0)} MB`;
    showToast((label || 'Fetching the mix…') + tail, false, { duration: 4000 });
  };
  say(null);
  let tries = 0;
  const poll = async () => {
    if (!same()) return;
    const st = await mixStatus(src0);
    if (!same()) return;
    if (st && st.cached) { load(pos); return; }
    say(st);
    if (st && st.ok === false) { if (giveUp) giveUp(st.message || 'The mix could not be fetched'); return; }
    // Neither finished nor being built: the build failed or was dropped — nothing to wait for.
    if (st && st.ok && !st.building && !st.cached) { if (giveUp) giveUp('The mix is no longer being fetched'); return; }
    if (++tries < 200) setTimeout(poll, 3000);
    else if (giveUp) giveUp('The mix took too long to fetch');
  };
  setTimeout(poll, 1500);
}

/** Resume a streamed mix at `pos` (the saved position). When the build is still running the
 *  position cannot be sought yet: wait for the finished file, then jump (awaitFinished). */
export function resumeWhenBuilt(el, pos, reload, still) {
  const seekable = (() => {      // a finished file served with Range: the element can seek itself
    try { for (let i = 0; i < el.seekable.length; i++) if (pos >= el.seekable.start(i) && pos <= el.seekable.end(i)) return true; } catch {}
    return false;
  })();
  if (!isMixStreamSrc(el.src) || !isProgressive(el.src) || bufferedTo(el, pos) || seekable) {
    if (still()) { try { el.currentTime = pos; } catch {} }
    return;
  }
  const mm = Math.floor(pos / 60), ss = String(Math.floor(pos % 60)).padStart(2, '0');
  awaitFinished(el, pos, reload, still, (m) => showToast(m, true), `Fetching the mix — resuming at ${mm}:${ss} when it is ready`);
}

/** While a streamed mix is the current track the server is asked about it now and then: a
 *  cached file is touched (eviction spares what was touched lately — a response ends early
 *  behind a buffering proxy, and a paused or long set would be evictable) and a running
 *  build is kept. Also how the page learns the finished file's real length. Every 10 s
 *  until the file is finished, every 2 min after. */
export function keepMixAlive(getEl) {
  const last = new Map();
  setInterval(() => {
    try {
      const el = getEl();
      if (!el || !isMixStreamSrc(el.src)) return;
      const key = _urlOf(el.src);
      const gap = _finished.has(key) ? 120000 : 10000;
      if (Date.now() - (last.get(key) || 0) < gap) return;
      last.set(key, Date.now());
      mixStatus(el.src);
    } catch {}
  }, 5000);
}
