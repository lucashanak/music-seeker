// mixcut.js — cut a passage out of a downloaded DJ set and save it as a library track.
//
// Pure logic first (exported, unit-tested in tests/js/mixcut.test.mjs), then the
// editor overlay, then the "Clips" section of Library → Mixes.
//
// Contract (backend, /api/clips): waveform = one byte per 1/10 s; beats = absolute
// seconds in a window; POST saves a clip; GET lists; DELETE removes.
// The overlay follows the dialog-stack contract (utils.js): one history layer,
// Back/popstate closes it through entry.cancel(true), the audio is stopped and every
// listener / RAF removed on close.

import { $$, esc, escAttr, showToast, showConfirmModal, dialogOpen, historyBack } from './utils.js';
import { apiJson, streamToken } from './api.js';
import { store } from './store.js';

// ───────────────────────── pure logic ─────────────────────────

// What the toast says after a save. The clip itself is always saved by now; the
// playlist part can be done, still waiting for Navidrome to index the file, or failed.
export function saveMessage(r, title) {
  const base = `Saved – ${(r && r.name) || title}`;
  const pl = r && r.playlist;
  if (!pl) return base;
  if (pl.state === 'added') return `${base} · added to ${pl.name}`;
  if (pl.state === 'pending') return `${base} · will appear in ${pl.name} once the library has indexed it`;
  return `${base} · but it could not be added to ${pl.name}`;
}

export const MIN_CLIP = 10;          // seconds
export const MAX_CLIP = 20 * 60;
export const MIN_SPAN = 10;          // detail window, seconds
export const MAX_SPAN = 300;
export const BEAT_WINDOW = 30;       // beats are fetched and cached per 30 s
export const EDGE_MIN_GAP = 0.1;
export const BEAT_MAX_SPAN = 90;     // beats are only worth fetching while the detail view is this close
export const BEAT_MAX_INFLIGHT = 2;
export const BEAT_RETRY_MS = 10000;
export const WAVE_RETRY_MS = 4000;   // the server keeps building the waveform after a request is dropped
export const WAVE_GIVE_UP_MS = 5 * 60 * 1000;

const fin = (n, d = 0) => (Number.isFinite(n) ? n : d);

/** base64 → Uint8Array (empty on bad input). */
export function decodePeaks(b64) {
  try {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return new Uint8Array(0); }
}

/** nBars values in 0..1: the max of the peaks falling into each bar. Ranges past
 *  either end give 0 there. Never NaN. */
export function barsFor(peaks, rate, fromSec, toSec, nBars) {
  const n = Math.max(0, Math.floor(fin(nBars)));
  const out = new Float32Array(n);
  const len = peaks ? peaks.length : 0;
  rate = fin(rate, 10) || 10;
  fromSec = fin(fromSec); toSec = fin(toSec, fromSec);
  if (!n || !len || toSec <= fromSec) return out;
  const step = (toSec - fromSec) / n;
  for (let i = 0; i < n; i++) {
    const t0 = fromSec + i * step;
    const i0 = Math.floor(t0 * rate);
    const i1 = Math.max(i0, Math.ceil((t0 + step) * rate) - 1);
    if (i1 < 0 || i0 >= len) continue;
    let m = 0;
    for (let j = Math.max(0, i0); j <= Math.min(len - 1, i1); j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m / 255;
  }
  return out;
}

/** Seconds → x in a canvas showing fromSec..toSec across `width` px. */
export function timeToX(t, fromSec, toSec, width) {
  const span = toSec - fromSec;
  return span > 0 ? ((t - fromSec) / span) * width : 0;
}
export function xToTime(x, fromSec, toSec, width) {
  return width > 0 ? fromSec + (x / width) * (toSec - fromSec) : fromSec;
}

/** The known beat nearest to t if within tolerance, else t. */
export function snapToBeat(t, beats, tolerance = 0.35) {
  let best = null; let bd = Infinity;
  for (const b of beats || []) {
    const d = Math.abs(b - t);
    if (d < bd) { bd = d; best = b; }
  }
  return best !== null && bd <= tolerance ? best : t;
}

/** The first beat strictly after (dir>0) / before (dir<0) t, or null. */
export function nextBeat(t, beats, dir) {
  let best = null;
  for (const b of beats || []) {
    if (dir > 0 && b > t + 1e-3 && (best === null || b < best)) best = b;
    if (dir < 0 && b < t - 1e-3 && (best === null || b > best)) best = b;
  }
  return best;
}

/** Both ends inside 0..duration, start <= end. */
export function clampSelection(start, end, duration) {
  const d = Math.max(0, fin(duration));
  let s = Math.min(Math.max(0, fin(start)), d);
  let e = Math.min(Math.max(0, fin(end)), d);
  if (e < s) [s, e] = [e, s];
  return { start: s, end: e };
}

/** Move one edge to t without crossing the other; keeps the pair valid. */
export function moveEdge(sel, edge, t, duration) {
  const d = Math.max(0, fin(duration));
  t = Math.min(Math.max(0, fin(t)), d);
  if (edge === 'start') return { start: Math.min(t, Math.max(0, sel.end - EDGE_MIN_GAP)), end: sel.end };
  return { start: sel.start, end: Math.max(t, Math.min(d, sel.start + EDGE_MIN_GAP)) };
}

/** Put one edge at t. A start at/after the end (or an end at/before the start) takes
 *  the other edge along and keeps the selection's length — collapsing it to 0.1 s made
 *  every "Set start" past the old end throw the passage away. The length is clamped to
 *  the set, so near its end the selection shrinks instead of overflowing. */
export function placeEdge(sel, edge, t, duration) {
  const d = Math.max(0, fin(duration));
  t = Math.min(Math.max(0, fin(t)), d);
  const len = sel.end - sel.start;
  if (edge === 'start' && t >= sel.end - EDGE_MIN_GAP) {
    const end = Math.min(d, t + len);
    return end - t >= EDGE_MIN_GAP ? { start: t, end } : { start: Math.max(0, d - EDGE_MIN_GAP), end: d };
  } else if (edge === 'end' && t <= sel.start + EDGE_MIN_GAP) {
    const start = Math.max(0, t - len);
    return t - start >= EDGE_MIN_GAP ? { start, end: t } : { start: 0, end: Math.min(d, EDGE_MIN_GAP) };
  }
  return moveEdge(sel, edge, t, d);
}

/** null when the length is fine, else 'short' | 'long'. */
export function lengthProblem(len) {
  if (!(len >= MIN_CLIP - 1e-9)) return 'short';
  if (len > MAX_CLIP + 1e-9) return 'long';
  return null;
}

/** m:ss (h:mm:ss from an hour); `precise` adds tenths: mm:ss.s */
export function fmt(sec, precise = false) {
  let s = Math.max(0, fin(sec));
  if (precise) s = Math.floor(s * 10 + 1e-6) / 10; else s = Math.floor(s + 1e-6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s - h * 3600 - m * 60;
  const rs = precise ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${rs}` : `${m}:${rs}`;
}

/** "17:45", "1:02:03.5", "95" (seconds) → seconds, or null when it is not a time.
 *  The tracklist under a set gives times as text; typing one beats hunting for it
 *  on a 2-hour waveform. */
export function parseTime(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?(:\d{1,2}(\.\d+)?){0,2}$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length > 1 && parts.slice(1).some((n) => n >= 60)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** `<mix title> (m:ss–m:ss)` — never equal to the mix's own title (the server refuses that). */
export function defaultTitle(mixTitle, start, end) {
  return `${mixTitle || 'Clip'} (${fmt(start)}–${fmt(end)})`;
}

/** Which edge a pointer is on: 'start' | 'end' | null. Both in reach → the nearer one. */
export function hitEdge(x, startX, endX, slop) {
  const ds = startX == null ? Infinity : Math.abs(x - startX);
  const de = endX == null ? Infinity : Math.abs(x - endX);
  if (ds > slop && de > slop) return null;
  if (ds === de) return x < startX ? 'start' : 'end';
  return ds < de ? 'start' : 'end';
}

export function clampSpan(span) {
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, fin(span, 40)));
}

/** The set's own file, served with Range: the editor must play exactly the audio the
 *  cut is made from (the player's stream may be a transcode with other timing). An
 *  <audio> element cannot send a header, hence the token in the query. */
export function mixStreamUrl(source, token) {
  const q = refParams(refOf(source));
  q.set('token', token || '');
  return `/api/clips/audio?${q}`;
}

/** A source is a downloaded set ({dj, file}) or a track of the user's own library
 *  ({name, artist}); the server takes either form, never both. */
function refOf(source) {
  const s = source || {};
  return s.name && !(s.dj && s.file) ? { name: s.name, artist: s.artist || '' } : { dj: s.dj || '', file: s.file || '' };
}

/** Query parameters naming the source — waveform, beats and audio all use this one. */
export function refParams(ref) {
  const r = refOf(ref);
  return new URLSearchParams(r.name !== undefined ? { name: r.name, artist: r.artist } : { dj: r.dj, file: r.file });
}

/** The same ref as a POST body. `artist` there is the CLIP's artist, so a track's own
 *  artist travels as `source_artist`. */
export function refBody(ref) {
  const r = refOf(ref);
  return r.name !== undefined ? { name: r.name, source_artist: r.artist } : { dj: r.dj, file: r.file };
}

// Names reach the menu as the search providers sent them, entities and all. The player
// decodes them through a textarea; this does the same without needing a DOM.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  if (!s || !String(s).includes('&')) return s || '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** One internal shape for whatever the editor was opened with: a Mixes row
 *  ({dj, file, title, ...}) or a track item from the app ({name, artist, ...}).
 *  `ref` is what the server is asked with; `key` matches clips to this source. */
export function describeSource(source) {
  const s = source || {};
  if (s.dj && s.file) {
    return { title: s.title || '', artist: s.artist || s.dj || '', sub: s.dj || s.artist || '',
      ref: { dj: s.dj, file: s.file }, key: { dj: s.dj, file: s.file }, known: true, duration: Number(s.duration) || 0 };
  }
  const name = decodeEntities(s.name || ''); const artist = decodeEntities(s.artist || '');
  // `resolved` is the answer of GET /api/clips/source, asked before the editor opened: the
  // server has already agreed this track can be cut and told us its key.
  const r = s.resolved && s.resolved.dj && s.resolved.file ? s.resolved : null;
  // otherwise the relpath is only known to the server: waveform's `source` fills `key.file` in
  return { title: name, artist, sub: artist, ref: { name, artist },
    key: r ? { dj: r.dj, file: r.file } : { dj: '@track', file: '' }, known: !!r,
    duration: Number(s.duration) || (r ? Number(r.duration) || 0 : 0) };
}

/** Was this clip cut from this set? By dj folder + file name — titles are not unique
 *  and the tag title is not the file's name. Clips written before the marker carried
 *  those two fall back to title + artist. */
export function isClipOfSet(c, mix) {
  if (c.source_file) return c.source_dj === mix.dj && c.source_file === mix.file;
  return c.source_title === mix.title && c.source_artist === (mix.artist || '');
}
export function clipsOfSet(clips, mix) {
  return (clips || []).filter((c) => isClipOfSet(c, mix)).sort((a, b) => (a.start || 0) - (b.start || 0));
}

/** Group clips by source set; each group is in DJ order (by start). */
export function groupClips(clips) {
  const map = new Map();
  for (const c of clips || []) {
    const k = c.source_file ? `f\u0000${c.source_dj || ''}\u0000${c.source_file}` : `t\u0000${c.source_artist || ''}\u0000${c.source_title || ''}`;
    if (!map.has(k)) map.set(k, { title: c.source_title || 'Unknown set', artist: c.source_artist || '', clips: [] });
    map.get(k).clips.push(c);
  }
  const groups = [...map.values()];
  groups.forEach((g) => g.clips.sort((a, b) => (a.start || 0) - (b.start || 0)));
  return groups;
}

// duration_ms from the cut (end − start): a cast needs the length (cast review, 4/10).
const clipItem = (c) => ({ name: c.title, artist: c.artist, type: 'track',
  duration_ms: c.end > c.start ? Math.round((c.end - c.start) * 1000) : 0 });

// ───────────────────────── playback helpers ─────────────────────────

async function playClips(clips, index = 0) {
  const u = await import('./upnext.js');
  // playTracks, never addToQueue(items, true): that one mirrors into the open playlist.
  await u.playTracks(clips.map(clipItem), index);
}

async function queueClip(c) {
  const { getPlayerModule } = await import('./player_active.js');
  const m = await getPlayerModule();
  m.addToQueue([clipItem(c)]);
  showToast(`Added to queue – ${c.title}`);
}

async function deleteClip(c) {
  const ok = await showConfirmModal(`Delete “${c.title}”?`, 'The clip is removed from your library.', { okLabel: 'Delete' });
  if (!ok) return false;
  try {
    await apiJson('/api/clips', { method: 'DELETE', body: { dir: c.dir, file: c.file } });
    showToast(`Deleted “${c.title}”`);
    return true;
  } catch (e) {
    showToast('Delete failed: ' + (e.message || 'error'), true);
    return false;
  }
}

// ───────────────────────── editor ─────────────────────────

let _open = null;   // the one live editor instance

const COL_PLAYED = '#ff5500';
const COL_PLAYED_REFL = 'rgba(255,170,120,0.55)';
const COL_REST = '#e6e6ee';
const COL_REST_REFL = 'rgba(230,230,238,0.32)';
const BASE_FRAC = 0.65;          // the centre line: the upper part is 65 % of the height
const CLIP_COLORS = ['#3ddc97', '#4ea8ff', '#ffd24d', '#c58bff', '#ff6b8b'];

export async function openCutter(source, opener) {
  if (!source || dialogOpen('mixcut') || _open) return;
  const mix = describeSource(source);   // title, artist, sub, ref, key (what clips are matched by)
  // document.body is what activeElement falls back to: not an opener, so the data-cut-key lookup runs.
  const isOpener = (el) => el && el !== document.body;
  const opening = isOpener(opener) ? opener : (isOpener(document.activeElement) ? document.activeElement : null);
  const openerKey = mix.ref.dj ? `${mix.ref.dj}/${mix.ref.file}` : '';

  // ── state ──
  let closed = false;
  let duration = mix.duration > 0 ? mix.duration : 0;
  let unavailable = false;           // the server said this source cannot be cut: nothing to play either
  let peaks = new Uint8Array(0);
  let rate = 10;
  let sel = null;                    // {start, end}
  let edge = 'start';                // the active edge
  let pos = 0;                       // playhead
  let span = 40;
  let viewCenter = null;             // null = follow (playing: playhead, else active edge)
  let snapOn = true;
  let loopOn = false;
  let stopAt = null;
  let clips = [];
  let raf = 0;
  let dirty = true;
  const beatWin = new Map();         // window index → [beats]
  const beatPending = new Map();     // window index → the request's promise (joined, never doubled)
  const beatFailed = new Map();      // window index → when it failed (retried after BEAT_RETRY_MS)
  const beatWaiters = [];
  let beatActive = 0;
  let bpmNow = null;

  // ── DOM ──
  const root = document.createElement('div');
  root.className = 'mixcut-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Cut a clip from this set');
  root.innerHTML = `
    <div class="mixcut-head">
      <div class="mixcut-headtext"><div class="mixcut-h-title">${esc(mix.title)}</div><div class="mixcut-h-sub">${esc(mix.sub)}</div></div>
      <button type="button" class="mixcut-close" data-r="close" aria-label="Close">&times;</button>
    </div>
    <div class="mixcut-body">
      <div class="mixcut-status" data-r="status">Analysing the set…</div>
      <div class="mixcut-wrap mixcut-wrap--ov"><canvas data-r="ov" class="mixcut-canvas" aria-label="Whole set waveform"></canvas></div>
      <div class="mixcut-detailbar">
        <span class="mixcut-label">Detail <span data-r="spanLbl"></span><span data-r="bpm" class="mixcut-bpm"></span></span>
        <span><button type="button" class="mixcut-btn mixcut-btn--sm" data-r="zoomOut" aria-label="Zoom out">&minus;</button>
        <button type="button" class="mixcut-btn mixcut-btn--sm" data-r="zoomIn" aria-label="Zoom in">+</button></span>
      </div>
      <div class="mixcut-wrap mixcut-wrap--dt"><canvas data-r="dt" class="mixcut-canvas" aria-label="Zoomed waveform"></canvas></div>
      <div class="mixcut-transport">
        <button type="button" class="mixcut-btn mixcut-btn--primary" data-r="play">&#9654; Play</button>
        <button type="button" class="mixcut-btn" data-r="back10" aria-label="Back 10 seconds">&minus;10 s</button>
        <button type="button" class="mixcut-btn" data-r="fwd10" aria-label="Forward 10 seconds">+10 s</button>
        <button type="button" class="mixcut-btn" data-r="setStart">Set start</button>
        <button type="button" class="mixcut-btn" data-r="setEnd">Set end</button>
        <button type="button" class="mixcut-btn" data-r="playStart">&#9654; Start</button>
        <button type="button" class="mixcut-btn" data-r="playEnd">&#9654; End</button>
        <button type="button" class="mixcut-btn mixcut-toggle" data-r="loop" aria-pressed="false">Loop</button>
        <button type="button" class="mixcut-btn mixcut-toggle on" data-r="snap" aria-pressed="true">Snap to beat</button>
      </div>
      <div class="mixcut-nudge">
        <span class="mixcut-label">Edge</span>
        <button type="button" class="mixcut-btn mixcut-toggle on" data-r="edgeStart" aria-pressed="true">Start</button>
        <button type="button" class="mixcut-btn mixcut-toggle" data-r="edgeEnd" aria-pressed="false">End</button>
        <button type="button" class="mixcut-btn" data-r="nudgeBack" aria-label="Nudge earlier">&#9664; <span data-r="nudgeLbl">0.5 s</span></button>
        <button type="button" class="mixcut-btn" data-r="nudgeFwd" aria-label="Nudge later"><span data-r="nudgeLbl2">0.5 s</span> &#9654;</button>
      </div>
      <div class="mixcut-readout">
        <label>Start <input type="text" class="mixcut-time" data-r="rStart" inputmode="text" autocomplete="off" placeholder="m:ss" aria-label="Start time"></label><label>End <input type="text" class="mixcut-time" data-r="rEnd" inputmode="text" autocomplete="off" placeholder="m:ss" aria-label="End time"></label><span>Length <b data-r="rLen">–</b></span>
      </div>
      <div class="mixcut-hint" data-r="hint" role="status"></div>
      <form class="mixcut-form" data-r="form" autocomplete="off">
        <label>Title<input type="text" data-r="title" maxlength="200"></label>
        <div class="mixcut-err" data-r="titleErr" role="alert"></div>
        <label>Artist<input type="text" data-r="artist" maxlength="200"></label>
        <label>Add to playlist<select data-r="playlist" disabled><option value="">Loading playlists…</option></select></label>
        <button type="submit" class="mixcut-btn mixcut-btn--primary mixcut-save" data-r="save" disabled>Save as track</button>
      </form>
      <div class="mixcut-clips"><div class="mixcut-label">Clips of this set</div><div data-r="clips"></div></div>
    </div>
    <audio data-r="audio" preload="metadata"></audio>`;
  const R = {};
  root.querySelectorAll('[data-r]').forEach((el) => { R[el.dataset.r] = el; });
  document.body.appendChild(root);
  R.artist.value = mix.artist;

  const audio = R.audio;
  let titleTouched = false;

  // ── overlay contract ──
  const close = (fromPopstate) => {
    const stack = store.dialogStack || [];
    const i = stack.lastIndexOf(entry);
    if (i === -1) return;
    stack.splice(i, 1);
    if (!fromPopstate) historyBack();
    closed = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
    root.remove();
    if (_open === inst) _open = null;
    let target = opening && opening.isConnected ? opening : null;
    if (!target) {
      target = $$('.mix-lib-row [data-act="cut"]').find((b) => b.dataset.cutKey === openerKey) || null;
    }
    if (target) { try { target.focus(); } catch {} }
  };
  const entry = { kind: 'mixcut', cancel: (fromPopstate) => close(fromPopstate) };
  const inst = { close };
  _open = inst;
  (store.dialogStack || (store.dialogStack = [])).push(entry);
  history.pushState({ layer: 'dialog' }, '');
  try { R.close.focus(); } catch {}   // keyboard and screen-reader users land inside the dialog

  // Two things must never play at once.
  import('./player_active.js').then((p) => p.getPlayerModule()).then((m) => { try { m.pauseLocal(); } catch {} }).catch(() => {});

  // ── geometry / drawing ──
  const ov = R.ov; const dt = R.dt;
  const ovCtx = ov.getContext('2d'); const dtCtx = dt.getContext('2d');
  const sizes = { ov: { w: 0, h: 0 }, dt: { w: 0, h: 0 } };

  function fit(canvas, key, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.parentElement.clientWidth || 300));
    const h = cssH;
    canvas.style.height = h + 'px';
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    sizes[key] = { w, h, dpr };
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const onResize = () => { dirty = true; };
  window.addEventListener('resize', onResize);

  const detailRange = () => {
    const c = viewCenter != null ? viewCenter
      : (!audio.paused ? pos : (sel ? sel[edge] : pos));
    return [c - span / 2, c + span / 2];
  };

  function drawBars(ctx, w, h, bars, barW, gap, playedX) {
    const base = Math.round(h * BASE_FRAC);
    const topH = base - 2;
    const reflH = h - base - 2;
    const stride = barW + gap;
    for (let i = 0; i < bars.length; i++) {
      const x = i * stride;
      const v = bars[i];
      const bh = Math.max(v > 0 ? 1 : 0, Math.round(v * topH));
      const rh = Math.round(v * reflH * 0.85);
      const played = x + barW <= playedX;
      ctx.fillStyle = played ? COL_PLAYED : COL_REST;
      ctx.fillRect(x, base - bh, barW, bh);
      ctx.fillStyle = played ? COL_PLAYED_REFL : COL_REST_REFL;
      ctx.fillRect(x, base + 1, barW, rh);
    }
  }

  function label(ctx, text, x, y, align) {
    ctx.font = '11px system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 8;
    const lx = align === 'right' ? x - tw : x;
    ctx.fillStyle = '#000';
    ctx.fillRect(lx, y, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 4, y + 8.5);
  }

  function drawOverview() {
    fit(ov, 'ov', 96);
    const { w, h } = sizes.ov;
    ovCtx.clearRect(0, 0, w, h);
    if (!duration) return;
    const stripH = 8;
    const plotH = h - stripH;
    const n = Math.max(1, Math.floor(w / 3));
    const bars = barsFor(peaks, rate, 0, duration, n);
    ovCtx.save();
    ovCtx.beginPath(); ovCtx.rect(0, 0, w, plotH); ovCtx.clip();
    drawBars(ovCtx, w, plotH, bars, 2, 1, timeToX(pos, 0, duration, w));
    ovCtx.restore();
    // saved clips: thin markers under the waveform
    // only THIS set's clips: the list holds every clip the user owns
    clipsOfSet(clips, matchKey()).forEach((c) => {
      const i = clips.indexOf(c);
      const x0 = timeToX(c.start, 0, duration, w); const x1 = timeToX(c.end, 0, duration, w);
      ovCtx.fillStyle = CLIP_COLORS[i % CLIP_COLORS.length];
      ovCtx.fillRect(x0, plotH + 2, Math.max(2, x1 - x0), 4);
    });
    if (sel) {
      const x0 = timeToX(sel.start, 0, duration, w); const x1 = timeToX(sel.end, 0, duration, w);
      ovCtx.fillStyle = 'rgba(255,255,255,0.16)';
      ovCtx.fillRect(x0, 0, Math.max(1, x1 - x0), plotH);
      ovCtx.fillStyle = '#fff';
      ovCtx.fillRect(x0 - 1, 0, 2, plotH);
      ovCtx.fillRect(x1 - 1, 0, 2, plotH);
    }
    const px = timeToX(pos, 0, duration, w);
    ovCtx.fillStyle = COL_PLAYED;
    ovCtx.fillRect(px - 0.5, 0, 1.5, plotH);
    const ly = Math.round(plotH * BASE_FRAC) - 8;
    label(ovCtx, fmt(pos), 0, ly, 'left');
    label(ovCtx, fmt(duration), w, ly, 'right');
  }

  function drawDetail() {
    fit(dt, 'dt', 150);
    const { w, h } = sizes.dt;
    dtCtx.clearRect(0, 0, w, h);
    if (!duration) return;
    const [a, b] = detailRange();
    const n = Math.max(1, Math.floor(w / 3));
    drawBars(dtCtx, w, h, barsFor(peaks, rate, a, b, n), 2, 1, timeToX(pos, a, b, w));
    // beat ticks
    dtCtx.fillStyle = 'rgba(255,255,255,0.14)';
    for (const t of visibleBeats(a, b)) dtCtx.fillRect(Math.round(timeToX(t, a, b, w)), 0, 1, h);
    // seconds ruler
    dtCtx.fillStyle = 'rgba(255,255,255,0.5)';
    dtCtx.font = '10px system-ui, sans-serif';
    dtCtx.textBaseline = 'top';
    const tick = span <= 20 ? 2 : span <= 60 ? 5 : span <= 150 ? 15 : 30;
    for (let t = Math.max(0, Math.ceil(a / tick) * tick); t < b; t += tick) {
      const x = timeToX(t, a, b, w);
      dtCtx.fillRect(x, h - 5, 1, 5);
      dtCtx.fillText(fmt(t), x + 3, h - 14);
    }
    if (sel) {
      const x0 = timeToX(sel.start, a, b, w); const x1 = timeToX(sel.end, a, b, w);
      dtCtx.fillStyle = 'rgba(255,255,255,0.12)';
      dtCtx.fillRect(Math.max(0, x0), 0, Math.min(w, x1) - Math.max(0, x0), h);
      [['start', x0], ['end', x1]].forEach(([k, x]) => {
        if (x < -20 || x > w + 20) return;
        dtCtx.fillStyle = k === edge ? '#ffd24d' : '#fff';
        dtCtx.fillRect(x - 1, 0, 2, h);
        // handle knob: a comfortably large (≥ 40 px) touch target, drawn as a tab
        const kx = k === 'start' ? x - 14 : x;
        dtCtx.fillRect(kx, h / 2 - 16, 14, 32);
        dtCtx.fillStyle = '#000';
        dtCtx.fillText(k === 'start' ? 'S' : 'E', kx + 3, h / 2 - 5);
      });
    }
    const px = timeToX(pos, a, b, w);
    if (px >= 0 && px <= w) { dtCtx.fillStyle = COL_PLAYED; dtCtx.fillRect(px - 0.5, 0, 1.5, h); }
  }

  // ── beats ──
  function allBeats() { return [...beatWin.values()].flat(); }
  function visibleBeats(a, b) {
    const out = [];
    for (let k = Math.floor(a / BEAT_WINDOW); k <= Math.floor(b / BEAT_WINDOW); k++) {
      for (const t of beatWin.get(k) || []) if (t >= a && t <= b) out.push(t);
    }
    return out;
  }
  async function beatSlot() {
    while (beatActive >= BEAT_MAX_INFLIGHT) await new Promise((r) => beatWaiters.push(r));
    beatActive++;
  }
  function beatFree() { beatActive--; const w = beatWaiters.shift(); if (w) w(); }
  /** Resolves once the window holding t is known (or failed). A caller that needs the
   *  beats NOW (snap, nudge) awaits the very request already running for that window. */
  function ensureBeats(t) {
    const k = Math.floor(Math.max(0, t) / BEAT_WINDOW);
    if (beatWin.has(k)) return Promise.resolve();
    if (beatPending.has(k)) return beatPending.get(k);
    // A failed window is not remembered forever: a hiccup would otherwise switch snapping off for good.
    if (beatFailed.has(k) && Date.now() - beatFailed.get(k) < BEAT_RETRY_MS) return Promise.resolve();
    const p = (async () => {
      await beatSlot();
      try {
        if (closed) return;
        const q = refParams(mix.ref);
        q.set('t', String(k * BEAT_WINDOW + BEAT_WINDOW / 2));
        const d = await apiJson(`/api/clips/beats?${q}`);
        if (closed) return;
        // the window is t±15 s: keep only this window's own beats so windows never double up
        const lo = k * BEAT_WINDOW; const hi = lo + BEAT_WINDOW;
        beatWin.set(k, (d && d.beats || []).filter((x) => x >= lo && x < hi));
        beatFailed.delete(k);
        if (d && d.bpm) bpmNow = Math.round(d.bpm);
      } catch {
        if (!closed) beatFailed.set(k, Date.now());
      } finally {
        beatFree();
      }
    })().finally(() => { beatPending.delete(k); dirty = true; });
    beatPending.set(k, p);
    return p;
  }
  function wantBeats() {
    if (span > BEAT_MAX_SPAN) return;   // zoomed far out the ticks are noise and each window costs a decode
    const [a, b] = detailRange();
    for (let k = Math.floor(Math.max(0, a) / BEAT_WINDOW); k <= Math.floor(Math.max(0, b) / BEAT_WINDOW); k++) {
      if (k * BEAT_WINDOW <= duration) ensureBeats(k * BEAT_WINDOW);
    }
  }

  // ── selection / UI sync ──
  function syncUi() {
    // Never rewrite a field the user is typing in.
    if (document.activeElement !== R.rStart) R.rStart.value = sel ? fmt(sel.start, true) : '';
    if (document.activeElement !== R.rEnd) R.rEnd.value = sel ? fmt(sel.end, true) : '';
    const len = sel ? sel.end - sel.start : 0;
    R.rLen.textContent = sel ? fmt(len, true) : '–';
    const prob = sel ? lengthProblem(len) : null;
    R.hint.textContent = !sel ? 'Drag on the waveform to select a passage, or use Set start / Set end at the playhead.'
      : prob === 'short' ? `Too short — a clip must be at least ${MIN_CLIP} s.`
      : prob === 'long' ? `Too long — a clip can be at most ${MAX_CLIP / 60} min.` : '';
    R.hint.classList.toggle('mixcut-hint--bad', !!prob);
    R.save.disabled = !sel || !!prob || saving || R.playlist.disabled;
    if (sel && !titleTouched) R.title.value = defaultTitle(mix.title, sel.start, sel.end);
    R.spanLbl.textContent = `${Math.round(span)} s`;
    R.bpm.textContent = bpmNow ? ` · ${bpmNow} BPM` : '';
    const step = snapOn && allBeats().length ? '1 beat' : '0.5 s';
    R.nudgeLbl.textContent = step; R.nudgeLbl2.textContent = step;
    R.play.innerHTML = audio.paused ? '&#9654; Play' : '&#10074;&#10074; Pause';
    dirty = true;
  }

  async function releaseEdge(which) {
    if (!sel || !snapOn) { syncUi(); return; }
    await ensureBeats(sel[which]);
    if (closed || !sel) return;
    sel = moveEdge(sel, which, snapToBeat(sel[which], allBeats(), 0.35), duration);
    syncUi();
  }

  // ── transport ──
  function seek(t) {
    pos = Math.min(Math.max(0, t), duration || t);
    try { audio.currentTime = pos; } catch {}
    dirty = true;
  }
  function play() { stopAt = null; audio.play().catch((e) => showToast('Playback failed: ' + (e.message || 'error'), true)); }
  function toggle() { if (audio.paused) play(); else audio.pause(); }
  function setActive(k) {
    edge = k; viewCenter = null;
    R.edgeStart.classList.toggle('on', k === 'start'); R.edgeStart.setAttribute('aria-pressed', String(k === 'start'));
    R.edgeEnd.classList.toggle('on', k === 'end'); R.edgeEnd.setAttribute('aria-pressed', String(k === 'end'));
    dirty = true;
  }
  function setEdgeAt(k, t) {
    if (!sel) sel = clampSelection(t, Math.min(duration, t + 30), duration);
    else sel = placeEdge(sel, k, t, duration);
    setActive(k); syncUi(); wantBeats();
  }
  async function nudge(dir) {
    if (!sel) return;
    await ensureBeats(sel[edge]);
    if (closed || !sel) return;
    let t = sel[edge] + dir * 0.5;
    if (snapOn) {
      const nb = nextBeat(sel[edge], allBeats(), dir);
      if (nb !== null) t = nb;
    }
    sel = moveEdge(sel, edge, t, duration);
    viewCenter = null; syncUi(); wantBeats();
  }

  const on = (el, ev, fn, opts) => el.addEventListener(ev, fn, opts);
  on(R.close, 'click', () => close());
  on(R.play, 'click', toggle);
  on(R.back10, 'click', () => seek(pos - 10));
  on(R.fwd10, 'click', () => seek(pos + 10));
  on(R.setStart, 'click', () => setEdgeAt('start', pos));
  on(R.setEnd, 'click', () => setEdgeAt('end', pos));
  on(R.playStart, 'click', () => { if (sel) { seek(sel.start); play(); } });
  on(R.playEnd, 'click', () => { if (sel) { seek(Math.max(sel.start, sel.end - 6)); play(); stopAt = sel.end; } });
  on(R.loop, 'click', () => { loopOn = !loopOn; R.loop.classList.toggle('on', loopOn); R.loop.setAttribute('aria-pressed', String(loopOn)); });
  on(R.snap, 'click', () => { snapOn = !snapOn; R.snap.classList.toggle('on', snapOn); R.snap.setAttribute('aria-pressed', String(snapOn)); syncUi(); });
  // Typed times: exactly what was typed, no snapping — the user asked for that second.
  const typed = (k, input) => {
    const t = parseTime(input.value);
    if (t === null || !(duration > 0)) { syncUi(); return; }
    if (!sel) sel = k === 'start' ? clampSelection(t, Math.min(duration, t + 30), duration)
      : clampSelection(Math.max(0, t - 30), t, duration);
    else sel = placeEdge(sel, k, t, duration);
    setActive(k); input.blur(); syncUi(); wantBeats();
  };
  for (const [k, input] of [['start', R.rStart], ['end', R.rEnd]]) {
    on(input, 'change', () => typed(k, input));
    // Escape is let through: onKey blurs the field (dropping what was typed) instead of closing the editor.
    on(input, 'keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); typed(k, input); } });
  }
  on(R.edgeStart, 'click', () => { setActive('start'); });
  on(R.edgeEnd, 'click', () => { setActive('end'); });
  on(R.nudgeBack, 'click', () => nudge(-1));
  on(R.nudgeFwd, 'click', () => nudge(1));
  on(R.zoomIn, 'click', () => { span = clampSpan(span / 1.5); wantBeats(); syncUi(); });
  on(R.zoomOut, 'click', () => { span = clampSpan(span * 1.5); wantBeats(); syncUi(); });
  on(R.title, 'input', () => { titleTouched = true; R.titleErr.textContent = ''; });
  on(audio, 'play', syncUi);
  on(audio, 'pause', () => { syncUi(); });
  on(audio, 'ended', syncUi);
  on(audio, 'timeupdate', checkBounds);   // rAF stops in a hidden tab / locked phone; this does not
  on(audio, 'error', () => { if (!closed && !unavailable && audio.getAttribute('src')) showToast('The set could not be played', true); });

  // ── pointers: overview ──
  const localX = (canvas, e) => e.clientX - canvas.getBoundingClientRect().left;
  {
    let drag = null;   // {mode:'edge'|'new'|'tap', which, x0}
    on(ov, 'pointerdown', (e) => {
      if (!duration) return;
      ov.setPointerCapture(e.pointerId);
      const x = localX(ov, e); const w = sizes.ov.w;
      const which = sel ? hitEdge(x, timeToX(sel.start, 0, duration, w), timeToX(sel.end, 0, duration, w), 14) : null;
      drag = which ? { mode: 'edge', which } : { mode: 'tap', x0: x };
      if (which) setActive(which);
    });
    on(ov, 'pointermove', (e) => {
      if (!drag) return;
      const x = localX(ov, e); const w = sizes.ov.w;
      const t = xToTime(x, 0, duration, w);
      if (drag.mode === 'tap' && Math.abs(x - drag.x0) > 4) { drag = { mode: 'new', x0: drag.x0 }; }
      if (drag.mode === 'new') {
        const t0 = xToTime(drag.x0, 0, duration, w);
        sel = clampSelection(Math.min(t0, t), Math.max(t0, t), duration);
        edge = t < t0 ? 'start' : 'end'; syncUi();
      } else if (drag.mode === 'edge') {
        sel = moveEdge(sel, drag.which, t, duration); syncUi();
      }
    });
    const up = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === 'tap') seek(xToTime(localX(ov, e), 0, duration, sizes.ov.w));
      else if (d.mode === 'edge') { viewCenter = null; releaseEdge(d.which); }
      else if (d.mode === 'new') {
        // the end the user dragged is the one being placed; the other edge is where they began
        viewCenter = null; releaseEdge(edge); wantBeats();
      }
    };
    on(ov, 'pointerup', up);
    on(ov, 'pointercancel', () => { drag = null; });
  }

  // ── pointers: detail (edge handles, pan, tap-seek, pinch, wheel) ──
  {
    const ptrs = new Map();
    let drag = null; let pinch = null;
    on(dt, 'pointerdown', (e) => {
      if (!duration) return;
      dt.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, e.clientX);
      const [a, b] = detailRange(); const w = sizes.dt.w;
      if (ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        pinch = { d: Math.abs(p - q) || 1, span }; drag = null; return;
      }
      const x = localX(dt, e);
      // handle tabs sit on the outside of the selection; 24 px slop each side = 48 px target
      const which = sel ? hitEdge(x, timeToX(sel.start, a, b, w), timeToX(sel.end, a, b, w), 24) : null;
      if (which) { setActive(which); drag = { mode: 'edge', which, a, b }; }
      else drag = { mode: 'tap', x0: x, a, b, moved: false };
      viewCenter = (a + b) / 2;   // frozen while a finger is down
    });
    on(dt, 'pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, e.clientX);
      if (pinch && ptrs.size === 2) {
        const [p, q] = [...ptrs.values()];
        span = clampSpan(pinch.span * pinch.d / (Math.abs(p - q) || 1)); syncUi(); wantBeats(); return;
      }
      if (!drag) return;
      const x = localX(dt, e); const w = sizes.dt.w;
      if (drag.mode === 'edge') {
        sel = moveEdge(sel, drag.which, xToTime(x, drag.a, drag.b, w), duration); syncUi();
      } else {
        if (Math.abs(x - drag.x0) > 4) drag.moved = true;
        if (drag.moved) { const dtSec = xToTime(drag.x0, drag.a, drag.b, w) - xToTime(x, drag.a, drag.b, w); viewCenter = (drag.a + drag.b) / 2 + dtSec; dirty = true; wantBeats(); }
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (pinch) { if (ptrs.size < 2) pinch = null; drag = null; return; }
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === 'edge') { viewCenter = null; releaseEdge(d.which); }
      else if (!d.moved) { viewCenter = null; seek(xToTime(localX(dt, e), d.a, d.b, sizes.dt.w)); }
    };
    on(dt, 'pointerup', up);
    on(dt, 'pointercancel', (e) => { ptrs.delete(e.pointerId); drag = null; pinch = null; });
    on(dt, 'wheel', (e) => {
      e.preventDefault();
      span = clampSpan(span * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); syncUi(); wantBeats();
    }, { passive: false });
  }

  // ── keyboard ──
  function onKey(e) {
    // A confirm modal over the editor owns the keyboard: Escape there must not also close
    // the editor, and Space / I / O must not act underneath it.
    const stack = store.dialogStack || [];
    if (stack[stack.length - 1] !== entry) return;
    const t = e.target;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (t === R.rStart || t === R.rEnd) { t.blur(); syncUi(); return; }
      close();
      return;
    }
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && !(t && t.tagName === 'BUTTON')) { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(pos - 5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(pos + 5); }
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setEdgeAt('start', pos); }
    else if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setEdgeAt('end', pos); }
  }
  document.addEventListener('keydown', onKey);

  // ── frame loop ──
  function checkBounds() {
    if (closed || audio.paused) return;
    pos = audio.currentTime;
    if (stopAt != null && pos >= stopAt) { audio.pause(); stopAt = null; pos = audio.currentTime; }
    else if (loopOn && sel && pos >= sel.end) { audio.currentTime = sel.start; pos = sel.start; }
    dirty = true;
  }
  function frame() {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    if (!audio.paused) {
      checkBounds();
      wantBeats();
    }
    if (dirty) { dirty = false; drawOverview(); drawDetail(); }
  }

  // ── clips list ──
  const matchKey = () => ({ dj: mix.key.dj, file: mix.key.file, title: mix.title, artist: mix.artist });
  function renderClipList() {
    const mine = clipsOfSet(clips, matchKey());
    if (!mine.length) { R.clips.innerHTML = '<p class="mixcut-empty">No clips cut from this set yet.</p>'; return; }
    R.clips.innerHTML = mine.map((c, i) => `
      <div class="mixcut-clip" data-i="${i}" tabindex="0" role="button" aria-label="Jump to ${escAttr(c.title)}">
        <span class="mixcut-clip-dot" style="background:${CLIP_COLORS[clips.indexOf(c) % CLIP_COLORS.length]}"></span>
        <span class="mixcut-clip-main"><span class="mixcut-clip-title">${esc(c.title)}</span>
          <span class="mixcut-clip-meta">${esc(fmt(c.start))}–${esc(fmt(c.end))} · ${esc(fmt(c.duration || (c.end - c.start)))}</span></span>
        <span class="mixcut-clip-actions">
          <button type="button" class="mixcut-btn mixcut-btn--sm" data-a="play">&#9654; Play</button>
          <button type="button" class="mixcut-btn mixcut-btn--sm" data-a="queue">+ Queue</button>
          <button type="button" class="mixcut-btn mixcut-btn--sm mixcut-btn--danger" data-a="del">Delete</button>
        </span>
      </div>`).join('');
    R.clips.querySelectorAll('.mixcut-clip').forEach((row) => {
      const c = mine[Number(row.dataset.i)];
      const jump = () => { sel = clampSelection(c.start, c.end, duration); viewCenter = null; setActive('start'); seek(c.start); syncUi(); wantBeats(); };
      row.addEventListener('click', (e) => { if (!e.target.closest('button')) jump(); });
      row.addEventListener('keydown', (e) => { if ((e.key === 'Enter') && e.target === row) jump(); });
      row.querySelector('[data-a="play"]').addEventListener('click', () => { audio.pause(); playClips([c]).catch((x) => showToast('Play failed: ' + (x.message || 'error'), true)); });
      row.querySelector('[data-a="queue"]').addEventListener('click', () => queueClip(c).catch((x) => showToast('Queue failed: ' + (x.message || 'error'), true)));
      row.querySelector('[data-a="del"]').addEventListener('click', async () => { if (await deleteClip(c) && !closed) { await loadClips(); refreshSection(); } });
    });
  }
  async function loadClips() {
    try {
      const d = await apiJson('/api/clips');
      if (closed) return;
      clips = (d && d.clips) || [];
    } catch (e) {
      if (!closed) R.clips.innerHTML = `<div class="mixcut-err">${esc(e.message || 'Could not load clips')}</div>`;
      return;
    }
    renderClipList(); dirty = true;
  }

  // ── playlist to file the clip into (remembered: a session of cutting goes to one place) ──
  const PL_KEY = 'ms_clip_playlist';
  const savedPlaylist = () => { try { return localStorage.getItem(PL_KEY) || ''; } catch { return ''; } };
  on(R.playlist, 'change', () => { try { localStorage.setItem(PL_KEY, R.playlist.value); } catch { /* private mode */ } });
  // Until the list is here the select is disabled: a quick Save must not silently
  // go out without the playlist the user expects to be remembered.
  const plReady = () => { R.playlist.options[0].textContent = 'None – just save the track'; R.playlist.disabled = false; syncUi(); };
  apiJson('/api/library/playlists').then((d) => {
    if (closed) return;
    plReady();
    const want = savedPlaylist();
    for (const p of (d && d.playlists) || []) {
      if (p.own === false) continue;        // someone else's shared playlist: Navidrome would refuse the write
      const o = document.createElement('option');
      o.value = String(p.id); o.textContent = p.name;
      R.playlist.appendChild(o);
    }
    // A remembered playlist that is gone falls back to "None" by itself.
    if (want && [...R.playlist.options].some((o) => o.value === want)) R.playlist.value = want;
  }).catch(() => { if (!closed) plReady(); /* the clip can still be saved without one */ });

  // ── save ──
  let saving = false;
  on(R.form, 'submit', async (e) => {
    e.preventDefault();
    if (saving || !sel || lengthProblem(sel.end - sel.start)) return;
    const title = R.title.value.trim();
    if (!title) { R.titleErr.textContent = 'Give the clip a title.'; return; }
    saving = true; R.save.disabled = true; R.save.textContent = 'Saving…'; R.titleErr.textContent = '';
    try {
      const r = await apiJson('/api/clips', {
        method: 'POST',
        body: { ...refBody(mix.ref), start: sel.start, end: sel.end, title, artist: R.artist.value.trim(),
                playlist_id: R.playlist.value || '' },
      });
      showToast(saveMessage(r, title), !!(r && r.playlist && r.playlist.state === 'failed'));
      titleTouched = false;           // the next passage gets a fresh default title
      await loadClips();
      refreshSection();
    } catch (err) {
      // 409 and 400 both explain themselves; the message belongs next to the field
      R.titleErr.textContent = err.status === 409 ? 'A clip with this title already exists.' : (err.message || 'Could not save');
      if (err.status !== 409 && err.status !== 400) showToast('Save failed: ' + (err.message || 'error'), true);
    } finally {
      saving = false; R.save.textContent = 'Save as track'; if (!closed) syncUi();
    }
  });

  // ── go ──
  syncUi();
  raf = requestAnimationFrame(frame);
  loadClips();
  // A source the server has not yet agreed to serve gets no <audio> request: its 404 could
  // beat the waveform's and toast "could not be played" next to the status message.
  const attachAudio = () => { if (!closed && !unavailable && !audio.getAttribute('src')) { try { audio.src = mixStreamUrl(mix.ref, streamToken()); } catch {} } };
  if (mix.known) attachAudio();
  await loadWaveform();

  // A 2.5 h set can take longer to analyse than nginx waits for one request. The server
  // keeps building after the request is dropped, so the same request is simply asked again.
  async function loadWaveform() {
    const give = Date.now() + WAVE_GIVE_UP_MS;
    R.status.style.display = ''; R.status.textContent = 'Analysing the set…';
    const q = refParams(mix.ref);
    for (;;) {
      let wf;
      try {
        wf = await apiJson(`/api/clips/waveform?${q}`);
      } catch (e) {
        if (closed) return;
        // a set that is not there or a path that is refused will not get better by waiting
        const hopeless = e.status === 400 || e.status === 404 || Date.now() >= give;
        if (!hopeless) {
          await new Promise((r) => setTimeout(r, WAVE_RETRY_MS));
          if (closed) return;
          continue;
        }
        // 400/404 are final (the server's own words say why, e.g. "Only a track stored in
        // your own library can be cut"): shown plainly, no Retry, and nothing left to play.
        const final = e.status === 400 || e.status === 404;
        if (final) { unavailable = true; try { audio.removeAttribute('src'); audio.load(); } catch {} }
        R.status.classList.toggle('mixcut-status--bad', final);
        R.status.innerHTML = esc(e.message || 'Could not analyse the set')
          + (final ? '' : ' <button type="button" class="mixcut-btn mixcut-btn--sm" data-r="retry">Retry</button>');
        const retry = R.status.querySelector('[data-r="retry"]');
        if (retry) retry.addEventListener('click', () => { R.status.classList.remove('mixcut-status--bad'); loadWaveform(); });
        return;
      }
      if (closed) return;
      // For a track the relpath is the server's to know; clips are matched by what it says.
      if (wf.source && wf.source.dj && wf.source.file) { mix.key = { dj: wf.source.dj, file: wf.source.file }; renderClipList(); }
      attachAudio();
      peaks = decodePeaks(wf.peaks);
      rate = wf.rate || 10;
      duration = Number(wf.duration) || (peaks.length / rate);
      R.status.style.display = 'none';
      if (!peaks.length) { R.status.style.display = ''; R.status.textContent = 'No waveform could be made for this set.'; }
      wantBeats(); syncUi();
      return;
    }
  }
}

// ───────────────────────── Clips section (Library → Mixes) ─────────────────────────

let _section = null;

function refreshSection() {
  if (_section && _section.isConnected) renderClipsSection(_section);
}

let _sectionGen = 0;

export async function renderClipsSection(container) {
  if (!container) return;
  _section = container;
  const gen = ++_sectionGen;
  let clips;
  try {
    const d = await apiJson('/api/clips');
    clips = (d && d.clips) || [];
  } catch (e) {
    if (gen !== _sectionGen) return;
    container.innerHTML = `<div class="mixcut-section"><h3 class="mixcut-sec-h">Clips</h3><div class="mixcut-err">${esc(e.message || 'Could not load clips')}</div></div>`;
    return;
  }
  if (gen !== _sectionGen) return;
  if (!clips.length) {
    container.innerHTML = '<div class="mixcut-section"><h3 class="mixcut-sec-h">Clips</h3><p class="mix-hint">Clips are cut from a downloaded set with the Cut button on its row, or from any track in your library with “✂ Cut a clip…” in its menu.</p></div>';
    return;
  }
  const groups = groupClips(clips);
  container.innerHTML = `<div class="mixcut-section"><h3 class="mixcut-sec-h">Clips <span class="mixcut-count">${clips.length}</span></h3>${groups.map((g, gi) => `
    <div class="mixcut-group" data-g="${gi}">
      <div class="mixcut-group-head"><div class="mixcut-group-title">${esc(g.title)}<span class="mixcut-group-sub">${esc(g.artist)}</span></div>
        <button type="button" class="import-btn import-btn-primary" data-a="all">&#9654; Play all in DJ order</button></div>
      ${g.clips.map((c, ci) => `
        <div class="mixcut-clip" data-g="${gi}" data-c="${ci}">
          <span class="mixcut-clip-main"><span class="mixcut-clip-title">${esc(c.title)}</span>
            <span class="mixcut-clip-meta">${esc(fmt(c.start))}–${esc(fmt(c.end))} · ${esc(fmt(c.duration || (c.end - c.start)))}</span></span>
          <span class="mixcut-clip-actions">
            <button type="button" class="import-btn" data-a="play">&#9654; Play</button>
            <button type="button" class="import-btn" data-a="queue">+ Queue</button>
            <button type="button" class="btn-delete-ep" data-a="del">&#128465; Delete</button>
          </span>
        </div>`).join('')}
    </div>`).join('')}</div>`;
  const fail = (what) => (x) => showToast(`${what} failed: ` + (x.message || 'error'), true);
  container.querySelectorAll('.mixcut-group').forEach((gEl) => {
    const g = groups[Number(gEl.dataset.g)];
    gEl.querySelector('[data-a="all"]').addEventListener('click', () => playClips(g.clips, 0).catch(fail('Play')));
    gEl.querySelectorAll('.mixcut-clip').forEach((row) => {
      const ci = Number(row.dataset.c); const c = g.clips[ci];
      row.querySelector('[data-a="play"]').addEventListener('click', () => playClips([c]).catch(fail('Play')));
      row.querySelector('[data-a="queue"]').addEventListener('click', () => queueClip(c).catch(fail('Queue')));
      row.querySelector('[data-a="del"]').addEventListener('click', async () => { if (await deleteClip(c)) renderClipsSection(container); });
    });
  });
}
