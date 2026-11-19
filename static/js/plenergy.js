// plenergy.js — the energy view of an open library playlist: order the rows by
// energy, and a summary of the playlist's energy and tempo in its header.
//
// Ordering is a VIEW and only that. The rows stay in playlist order in the DOM and
// are moved on screen with CSS `order` (the list is a flex column), because every
// per-row action in library.js — selection, bulk copy/remove, drag-reorder, the
// remove button — names a row by its DOM index into the playlist, and the
// playlist manager names it by (index, song id). Nothing here writes to the
// playlist in Navidrome or to the queue. Starting playback from the ordered view
// plays the rows in the order shown (the list's play context is swapped for an
// ordered copy; Play All asks `inViewOrder`).

import { $, $$ } from './utils.js';
import { store } from './store.js';
import { getDjData, displayBpm } from './bpm.js';
import { setPlayContext, getPlayContext, queueFromContext } from './playcontext.js';
import { energySortOrder, energySummary, tempoSummary } from './energyview.js';

const MODES = ['playlist', 'asc', 'desc'];
const LABELS = { playlist: 'Playlist order', asc: 'Calm first', desc: 'Energetic first' };

let _mode = 'playlist';
let _forId = null;

function _item(card) {
  try { return JSON.parse(card.dataset.item); } catch { return null; }
}

function _entryFor(item) {
  return item ? getDjData(item.name, item.artist) : null;
}

/** A different playlist starts in playlist order; the same one keeps its choice. */
export function energySortFor(playlistId) {
  if (playlistId !== _forId) { _mode = 'playlist'; _forId = playlistId; }
}

/** The current order mode: 'playlist', 'asc' or 'desc'. */
export function energySortMode() { return _mode; }

/** Cards in the order they are shown (CSS `order`), playlist order where equal. */
export function inViewOrder(cards) {
  if (_mode === 'playlist') return cards;
  return cards
    .map((c, i) => ({ c, i, o: Number(c.style.order) || 0 }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map(x => x.c);
}

/**
 * Order the rows of `container` by the current mode. Safe to call after every
 * (re)render and after the BPM cache fills: it reads the cache each time.
 */
export function applyEnergySort(container) {
  const el = typeof container === 'string' ? $(container) : container;
  if (!el) return;
  const list = el.querySelector('.song-list');
  const cards = $$('.card', el).filter(c => c.dataset.item);
  const items = cards.map(_item);
  el.classList.toggle('energy-sorted', _mode !== 'playlist');
  if (list && !list._msPlaylistCtx) list._msPlaylistCtx = getPlayContext(list);
  if (_mode === 'playlist') {
    cards.forEach(c => { c.style.order = ''; });
    if (list && list._msPlaylistCtx) setPlayContext(list, list._msPlaylistCtx);
    return;
  }
  const order = energySortOrder(items.map(_entryFor), _mode);
  order.forEach((cardIdx, pos) => { cards[cardIdx].style.order = String(pos); });
  // Starting a row plays on down the list AS SHOWN. A copy, so the playlist's own
  // array (library.js currentLibPlaylistTracks) keeps its order.
  if (list) setPlayContext(list, order.map(i => items[i]).filter(Boolean));
  if (list && !list._msUnbindOnPlay) {
    // A row's play button (player_v3.js, delegated on document) keeps whatever
    // `store.playlistMode` is. When that is this very playlist, a later drag in
    // the queue would write the energy order into it — unbind first. Capture
    // phase on the list runs before the document handler.
    list._msUnbindOnPlay = true;
    list.addEventListener('click', (e) => {
      if (_mode === 'playlist' || e.shiftKey || e.metaKey || e.ctrlKey) return;
      const btn = e.target.closest('.card-play-btn');
      const card = btn && btn.closest('.card');
      if (!card) return;
      const ctx = queueFromContext(card, _item(card));
      if (!ctx) return;                       // one-row list: the normal handler plays it
      e.stopPropagation();
      e.preventDefault();
      playViewThroughUpNext(ctx.tracks.slice(), ctx.index);
    }, true);
  }
}

function _setMode(mode, container) {
  _mode = MODES.includes(mode) ? mode : 'playlist';
  $$('.energy-sort .es-btn').forEach(b => {
    const on = b.dataset.mode === _mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  applyEnergySort(container);
}

/**
 * The order control, placed right before the track list. A different playlist
 * starts in playlist order; reopening or reloading the same one keeps the choice.
 */
export function mountEnergySort(container, playlistId, onRefresh) {
  const el = $(container);
  if (!el) return null;
  energySortFor(playlistId);
  _onScanned = onRefresh || null;
  const parent = el.parentNode;
  const old = parent.querySelector(':scope > .energy-sort');
  if (old) old.remove();
  const bar = document.createElement('div');
  bar.className = 'energy-sort';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Order');
  bar.innerHTML = '<span class="es-label">Order</span>' + MODES.map(m =>
    `<button type="button" class="es-btn" data-mode="${m}" aria-pressed="false">${LABELS[m]}</button>`).join('');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('.es-btn');
    if (b) _setMode(b.dataset.mode, el);
  });
  parent.insertBefore(bar, el);
  _setMode(_mode, el);
  return bar;
}

function _fmtBpm(x) { return x == null ? '' : String(Math.round(x)); }

/**
 * The energy and tempo of the whole playlist (all its tracks, whatever the tempo
 * filter shows), drawn under the track count in the header. Uses only what the
 * BPM cache already holds — no request of its own.
 */
export function renderEnergySummary(tracks, anchorSel) {
  const anchor = $(anchorSel);
  if (!anchor) return null;
  let box = anchor.parentNode.querySelector(':scope > .pl-energy-summary');
  if (!box) {
    box = document.createElement('div');
    box.className = 'pl-energy-summary';
    anchor.after(box);
  }
  const entries = (tracks || []).map(t => (t ? getDjData(t.name, t.artist) : null));
  const en = energySummary(entries);
  const tp = tempoSummary(entries.map(displayBpm));
  if (!en.total || (!en.measured && !tp.measured)) {
    box.hidden = true;
    box.innerHTML = '';
    return box;
  }
  box.hidden = false;
  const peak = Math.max(1, ...en.levels);
  const bars = en.levels.map((n, i) =>
    `<span class="pes-bar" data-level="${i + 1}" data-count="${n}" title="Energy ${i + 1}/5: ${n} tracks">` +
    `<i style="height:${n ? Math.max(12, Math.round(n / peak * 100)) : 0}%"></i></span>`).join('');
  const energyText = en.measured
    ? `Energy median ${en.medianLevel}/5`
    : 'No energy measured';
  const missText = en.missing ? ` · ${en.missing} without energy` : '';
  const tempoText = tp.measured
    ? `Tempo ${_fmtBpm(tp.min)}${tp.max !== tp.min ? '–' + _fmtBpm(tp.max) : ''} BPM · median ${_fmtBpm(tp.median)}`
      + (tp.missing ? ` · ${tp.missing} without BPM` : '')
    : '';
  box.innerHTML =
    `<span class="pes-bars" role="img" aria-label="Energy levels 1 to 5: ${en.levels.join(', ')} tracks">${bars}</span>` +
    `<span class="pes-text"><span class="pes-energy" data-median-level="${en.medianLevel ?? ''}" data-missing="${en.missing}">${energyText}${missText}</span>` +
    (tempoText ? `<span class="pes-tempo" data-min="${_fmtBpm(tp.min)}" data-max="${_fmtBpm(tp.max)}" data-median="${_fmtBpm(tp.median)}">${tempoText}</span>` : '') +
    `</span>`;
  return box;
}

/** Remove the summary (another playlist is loading). */
export function clearEnergySummary(anchorSel) {
  const anchor = $(anchorSel);
  const box = anchor && anchor.parentNode.querySelector(':scope > .pl-energy-summary');
  if (box) box.remove();
}

/**
 * Play tracks taken from an energy-ordered view. The queue is then not the
 * playlist in its order, so it must not be bound to the playlist: queue.js
 * mirrors a drag in the queue into `store.playlistMode` as a whole-list rewrite.
 * Up Next takes it instead, as it does for any other ad-hoc list.
 */
export async function playViewThroughUpNext(tracks, startIndex = 0) {
  if (!tracks || !tracks.length) return;
  const u = await import('./upnext.js');
  store.playlistMode = null;
  try { await u.initUpNext(); } catch {}
  await u.playTracks(tracks, startIndex);
}

/**
 * DOM indices of the rows between two clicked rows AS SHOWN (shift-click range),
 * skipping rows the tempo filter hides. In playlist order this is the plain
 * index range it always was.
 */
export function viewRange(cards, fromIdx, toIdx) {
  const shown = inViewOrder(cards);
  const a = shown.indexOf(cards[fromIdx]);
  const b = shown.indexOf(cards[toIdx]);
  if (a < 0 || b < 0) return [];
  const out = [];
  for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
    const c = shown[p];
    if (_mode === 'playlist' || c.style.display !== 'none') out.push(cards.indexOf(c));
  }
  return out;
}

// "Analyze BPM" (bpm.js) fills the cache after the view was drawn; redraw then.
let _onScanned = null;
window.addEventListener('ms-bpm-scanned', () => { if (_onScanned) _onScanned(); });
