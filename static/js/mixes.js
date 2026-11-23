// mixes.js — Library → Mixes: search DJ sets across SoundCloud, YouTube, Mixcloud
// and hearthis.at, follow DJs, and the mixes already downloaded.
//
// Downloading goes through the one mix path (POST /api/download type:"mix" →
// mixes.run_mix on the server), whichever site the result is from. Filters run
// here over the full server answer (mixfilter.js) so a change is instant.
//
// Loaded lazily by library.js switchLibraryTab; the first load wires the
// controls, so app.js needs no init call.

import { $, $$, esc, escAttr, showToast, formatSize, showConfirmModal } from './utils.js';
import { store } from './store.js';
import { apiJson } from './api.js';
import { openPanel } from './downloads.js';
import {
  MIX_SOURCES, applyMixFilters, normalizeFilters, qualityClass, fmtMixDuration,
} from './mixfilter.js';

const FILTER_KEY = 'ms_mix_filters';
const SOURCE_LABEL = { soundcloud: 'SoundCloud', youtube: 'YouTube', mixcloud: 'Mixcloud', hearthis: 'hearthis.at' };

let _wired = false;
let _filters = _loadFilters();
let _searchGen = 0;
// Two places draw the same rows: Library → Mixes and the Search page's Mixes type.
// A view is where one of them lives and the last answer it was given; the ids in
// its status line carry `idp` so the two never share an id.
const _view = (o) => ({ last: null, shown: [], q: '', srcs: [], errs: {}, page: 1, done: true, loading: false,
  stalled: false, paused: false, sid: '', note: '', gen: 0, observer: null, ...o });
const _libView = _view({ box: '#mixResults', status: '#mixSearchStatus', idp: 'mix' });
const _searchView = _view({ box: '#searchResults', status: '#mixSearchViewStatus', idp: 'smix', onOpenLib: null });
// More pages: at most this many requests per scroll trigger, until a screenful of new
// VISIBLE rows has arrived (the filters run here, so a page may add few).
const MORE_SCREENFUL = 8;
const MORE_MAX_PER_TRIGGER = 3;
let _follows = [];         // [{source, user_id, ...}]
let _followsGen = 0;
let _followsLoaded = false;
let _libGen = 0;
// Downloads started from this page, by URL: a re-render (a filter change, a new
// follow) must not hand back an enabled button for a mix already on its way.
const _started = new Set();

function _loadFilters() {
  try { return normalizeFilters(JSON.parse(localStorage.getItem(FILTER_KEY) || 'null')); }
  catch { return normalizeFilters(null); }
}

function _saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(_filters)); } catch {}
}

const safeHref = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');

// ── Rows ──

function qualityBadge(it) {
  const typical = it.quality_known === false;
  const title = typical
    ? `Typical for ${it.source_label || SOURCE_LABEL[it.source] || 'this site'}, not measured`
    : 'Quality the download gets';
  return `<span class="mix-q ${qualityClass(it.kbps)}" title="${escAttr(title)}">${esc(it.quality_label || '?')}${typical ? '<span class="mix-q-typ">typ.</span>' : ''}</span>`;
}

function thumb(url, cls = 'mix-thumb') {
  return url
    ? `<img class="${cls}" src="${escAttr(url)}" alt="" loading="lazy" onerror="this.removeAttribute('src');this.classList.add('${cls}--empty')">`
    : `<div class="${cls} ${cls}--empty">&#9835;</div>`;
}

function isFollowed(source, uid) {
  return _follows.some((f) => f.source === source && f.user_id === uid);
}

/** One result row — the same for search results and a DJ's uploads. */
function resultRow(it, idx, { showFollow = true } = {}) {
  const meta = [it.uploader, fmtMixDuration(it.duration), it.date].filter(Boolean).join(' · ');
  const also = (it.also || []).length
    ? `<div class="mix-also">Also on ${it.also.map((a) => `${esc(a.source_label)} ${esc(a.quality_label || '')}`).join(', ')}</div>`
    : '';
  const canFollow = showFollow && it.uploader_id;
  const followed = canFollow && isFollowed(it.source, it.uploader_id);
  const href = safeHref(it.url);
  const started = _started.has(it.url);
  return `
    <div class="mix-row" data-idx="${idx}" data-url="${escAttr(it.url)}">
      ${thumb(it.thumbnail)}
      <div class="mix-info">
        <div class="mix-title">${href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : esc(it.title)}</div>
        <div class="mix-meta">${esc(meta)}</div>
        <div class="mix-badges">
          ${qualityBadge(it)}
          <span class="mix-src mix-src--${escAttr(it.source)}">${esc(it.source_label || SOURCE_LABEL[it.source] || it.source)}</span>
          ${it.in_library ? '<span class="mix-owned">In library</span>' : ''}
        </div>
        ${also}
      </div>
      <div class="mix-actions">
        <button type="button" class="import-btn import-btn-primary mix-play" data-act="play" aria-label="Play ${escAttr(it.title)}">&#9654; Play</button>
        <button type="button" class="import-btn mix-dl" data-act="download"${it.in_library || started ? ' disabled' : ''}>${started ? 'Downloading…' : '&#8681; Download'}</button>
        ${canFollow ? `<button type="button" class="import-btn mix-follow-btn" data-act="follow"${followed ? ' disabled' : ''}>${followed ? 'Following' : '+ Follow DJ'}</button>` : ''}
      </div>
    </div>`;
}

function wireRows(container, items) {
  $$('.mix-row', container).forEach((row) => {
    if (row.dataset.wired) return;          // rows of earlier pages are wired already
    const it = items[Number(row.dataset.idx)];
    if (!it) return;
    row.dataset.wired = '1';
    const pl = row.querySelector('[data-act="play"]');
    if (pl) pl.addEventListener('click', () => playResult(it));
    const dl = row.querySelector('[data-act="download"]');
    if (dl) dl.addEventListener('click', () => downloadMix(it, dl));
    const fol = row.querySelector('[data-act="follow"]');
    if (fol) fol.addEventListener('click', () => followDj(it, fol));
  });
}

/** Play a search result at once. A mix the user owns plays its library file the usual way
 *  (the stream resolves it by title + artist); any other plays from its own site through
 *  /api/player/mix-stream, addressed by the exact URL (`mix_url` on the queue item, which
 *  is saved with the queue). duration_ms: the deck cannot learn the length of a body that
 *  is still being built. */
export function playResult(it) {
  const item = { name: it.title, artist: it.uploader || '', album: 'DJ Sets', image: it.thumbnail || '',
    duration_ms: it.duration > 0 ? Math.round(it.duration * 1000) : 0 };
  if (!it.in_library && safeHref(it.url)) item.mix_url = it.url;
  // Not castable: refuse BEFORE touching the queue (playTracks replaces it and moves the
  // index and the title; the engine's own guard would come too late for that).
  const mode = store.deviceOutputMode || 'default';
  // Controlling another device: the TARGET may be casting (its report says so).
  const target = store.remoteTarget ? (store.remoteDevices || {})[store.remoteTarget] : null;
  if (item.mix_url && ((store.castDevice && mode !== 'local') || mode === 'dlna_only' || (target && target.casting))) {
    showToast('A mix that is not downloaded cannot be cast — download it first', true);
    return;
  }
  import('./upnext.js').then((u) => u.playTracks([item], 0));
}

async function downloadMix(it, btn) {
  if (_started.has(it.url)) return;
  _started.add(it.url);
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await apiJson('/api/download', {
      method: 'POST',
      // type:"mix" explicitly: a YouTube link is a mix only when we say so.
      body: { url: it.url, title: `${it.uploader} - ${it.title}`, type: 'mix', method: 'yt-dlp' },
    });
    btn.textContent = 'Downloading…';
    showToast(`Downloading “${it.title}” from ${it.source_label || it.source}`);
    openPanel();
  } catch (e) {
    _started.delete(it.url);
    btn.disabled = false;
    btn.innerHTML = '&#8681; Download';
    showToast('Download failed: ' + (e.message || 'error'), true);
  }
}

// ── Search ──

/** Take a first page as the start of `view`'s search (everything later pages add accumulates). */
/** A fresh id for each search: the server keeps one search's paging per (user, id), so two tabs
 *  with the same query never reset each other. */
const newSid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function startView(view, q, data, sid) {
  view.gen++;
  if (view.observer) { try { view.observer.disconnect(); } catch {} view.observer = null; }
  view.last = { ...data, results: [...(data.results || [])] };
  view.q = q;
  view.sid = sid || '';
  view.paused = false;
  view.srcs = data.sources || [];
  view.errs = { ...(data.errors || {}) };
  view.page = data.page || 1;
  view.done = data.done !== false && !Object.values(data.more || {}).some(Boolean);
  view.loading = false;
  view.stalled = false;
  view.note = '';
  view.shown = [];
}

function hiddenNote(r) {
  const hidden = [];
  if (r.hiddenQuality) hidden.push(`${r.hiddenQuality} hidden by quality`);
  if (r.hiddenLength) hidden.push(`${r.hiddenLength} hidden by length`);
  if (r.hiddenSource) hidden.push(`${r.hiddenSource} from switched-off sources`);
  return hidden;
}

/** The status line: counts EVERYTHING loaded so far, says when more is coming or that there
 *  is no more, and keeps the per-source errors of every page. */
function renderStatus(view) {
  const status = $(view.status);
  const last = view.last;
  if (!status || !last) return;
  const idp = view.idp;
  const r = applyMixFilters(last.results || [], _filters);
  const total = (last.results || []).length;
  const hidden = hiddenNote(r);
  const errs = Object.entries(view.errs || {})
    .filter(([s]) => _filters.sources.includes(s))
    .map(([s, msg]) => `<div class="mix-err">${esc(SOURCE_LABEL[s] || s)}: ${esc(msg)}</div>`).join('');
  let more = '';
  if (view.loading) more = '<div class="mix-count mix-more">Loading more…</div>';
  else if (view.stalled) more = `<div class="mix-count mix-more">${esc(view.note || 'Could not load more.')} <button type="button" class="mix-linkbtn" id="${idp}More">Try again</button></div>`;
  else if (view.paused) more = `<div class="mix-count mix-more">${hidden.length ? esc(hidden.join(' · ')) : 'Nothing new'} so far — more results are being held back by your filters. <button type="button" class="mix-linkbtn" id="${idp}More">Load more</button></div>`;
  else if (view.done) more = `<div class="mix-count mix-more" id="${idp}NoMore">${esc(view.note || 'No more results')}${view.page > 1 ? ` · ${view.page} pages` : ''}</div>`;
  status.innerHTML = `
    <div class="mix-count"><span id="${idp}ShownCount">${r.shown.length}</span> of ${total} shown${hidden.length ? ` · <span id="${idp}HiddenNote">${esc(hidden.join(' · '))}</span>` : ''}
      ${(r.hiddenQuality || r.hiddenLength) ? `<button type="button" class="mix-linkbtn" id="${idp}ShowAll">Show all</button>` : ''}</div>
    ${more}
    ${errs}
    ${view.onOpenLib ? `<div class="mix-count"><button type="button" class="mix-linkbtn" id="${idp}OpenLib">Filters and followed DJs &rarr; Library &rsaquo; Mixes</button></div>` : ''}`;
  const openLib = $(`#${idp}OpenLib`);
  if (openLib) openLib.addEventListener('click', () => view.onOpenLib());
  const retry = $(`#${idp}More`);
  if (retry) retry.addEventListener('click', () => { view.stalled = false; view.paused = false; view.note = ''; loadMore(view); });
  const all = $(`#${idp}ShowAll`);
  if (all) all.addEventListener('click', () => {
    _filters.minKbps = 0;
    _filters.minMinutes = 0;
    _saveFilters();
    syncFilterControls();
    renderAll();
  });
}

/** Everything loaded, drawn afresh under the current filters and sort (a filter or sort change,
 *  a follow). Rows that are on screen only ever move here — never when a page arrives. */
function renderResults(view = _libView) {
  const box = $(view.box);
  const status = $(view.status);
  const last = view.last;
  if (!box || !status) return;
  if (!last) { if (view === _libView) { box.innerHTML = ''; status.innerHTML = ''; } return; }
  const r = applyMixFilters(last.results || [], _filters);
  view.shown = r.shown;
  renderStatus(view);
  if (!r.shown.length) {
    const total = (last.results || []).length;
    box.innerHTML = `<div class="empty-state mix-empty"><p>${total ? 'Nothing passes the filters.' : (view.done ? 'No mixes found.' : 'Looking further…')}</p></div>`;
  } else {
    box.innerHTML = r.shown.map((it, i) => resultRow(it, i)).join('');
    wireRows(box, view.shown);
  }
  armSentinel(view);
}

function renderAll() {
  _libView.paused = false; _searchView.paused = false;     // a filter or sort change is a reason to look again
  renderResults(_libView);
  renderResults(_searchView);
}

// ── More pages ──
// A sentinel under the last row; when it comes into view (and the view is on screen) the next
// page is asked for. One request in flight per view, a bounded number per trigger, nothing
// while the page is hidden, and it stops when a page adds nothing or the sources are dry.

function viewVisible(view) {
  const box = $(view.box);
  return !!box && box.offsetParent !== null && !document.hidden;
}

function armSentinel(view) {
  const box = $(view.box);
  if (view.observer) { try { view.observer.disconnect(); } catch {} view.observer = null; }
  const old = box && box.querySelector('.mix-sentinel');
  if (old) old.remove();
  if (!box || !view.last || view.done || view.stalled || view.paused || typeof IntersectionObserver !== 'function') return;
  const sent = document.createElement('div');
  sent.className = 'mix-sentinel';
  sent.setAttribute('aria-hidden', 'true');
  sent.style.minHeight = '1px';
  box.appendChild(sent);
  view.observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) loadMore(view);
  }, { rootMargin: '600px 0px' });
  view.observer.observe(sent);
}

/** Rows (and folds) of a page after the first: appended below what is shown, never re-sorted
 *  into it. Returns how many VISIBLE rows were added. */
function appendPage(view, data) {
  const box = $(view.box);
  const last = view.last;
  // Copies of a set already sent: fold into that row (its "Also on …" line changes in place).
  for (const f of data.folds || []) {
    const row = last.results.find((x) => x.url === f.into);
    if (row) row.also = [...(row.also || []), ...(f.also || [])];
    const idx = view.shown.findIndex((x) => x.url === f.into);
    if (idx >= 0 && box) {
      if (view.shown[idx] !== row) view.shown[idx] = { ...view.shown[idx], also: [...(view.shown[idx].also || []), ...(f.also || [])] };
      const el = box.querySelector(`.mix-row[data-idx="${idx}"]`);
      if (el) { el.outerHTML = resultRow(view.shown[idx], idx); wireRows(box, view.shown); }
    }
  }
  last.results.push(...(data.results || []));
  Object.assign(view.errs, data.errors || {});
  view.page = data.page || view.page + 1;
  view.done = data.done === true;
  const r = applyMixFilters(data.results || [], _filters);
  if (box && r.shown.length) {
    if (box.querySelector('.mix-empty')) box.innerHTML = '';
    const sent = box.querySelector('.mix-sentinel');
    const html = r.shown.map((it, i) => resultRow(it, view.shown.length + i)).join('');
    if (sent) sent.insertAdjacentHTML('beforebegin', html); else box.insertAdjacentHTML('beforeend', html);
    view.shown.push(...r.shown);
    wireRows(box, view.shown);
  }
  return r.shown.length;
}

// Coming back to a hidden tab / page re-arms the sentinels (an observer callback that fired
// while the view was hidden was ignored, and would not fire again by itself).
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { armSentinel(_libView); armSentinel(_searchView); }
  });
}

async function loadMore(view) {
  if (view.loading || view.done || view.stalled || view.paused || !view.last || !view.q) return;
  if (!viewVisible(view)) return;
  const gen = view.gen;
  view.loading = true;
  renderStatus(view);
  let visibleAdded = 0, tries = 0;
  try {
    while (tries < MORE_MAX_PER_TRIGGER && !view.done && visibleAdded < MORE_SCREENFUL) {
      tries++;
      const params = new URLSearchParams({ q: view.q, sources: view.srcs.join(','), page: String(view.page + 1), sid: view.sid });
      const data = await apiJson(`/api/mixes/search?${params}`);
      if (gen !== view.gen) return;                 // a new query or another type: this page is nobody's
      visibleAdded += appendPage(view, data);
      if (!(data.results || []).length && !(data.folds || []).length) { view.done = true; break; }   // adds nothing: stop
    }
    // A trigger's pages all hidden by the filters: do not keep walking the sources unattended —
    // say so and let the user choose (Show all / Load more).
    if (gen === view.gen && !view.done && visibleAdded === 0 && tries >= MORE_MAX_PER_TRIGGER) view.paused = true;
  } catch (e) {
    if (gen !== view.gen) return;
    if (e.status === 409) { view.done = true; view.note = 'This search has expired — search again'; }
    else { view.stalled = true; view.note = e.status === 429 ? (e.message || 'Too many requests — wait a moment') : 'Could not load more.'; }
  } finally {
    if (gen === view.gen) {
      view.loading = false;
      renderStatus(view);
      armSentinel(view);           // re-observe: still in view means the next page is wanted
    }
  }
}

async function runSearch() {
  const input = $('#mixSearchInput');
  const q = (input && input.value || '').trim();
  if (!q) return;
  const gen = ++_searchGen;
  _libView.gen++;                       // a pending page of the old query is nobody's
  const box = $('#mixResults');
  $('#mixSearchStatus').innerHTML = '<div class="mix-count">Searching SoundCloud, YouTube, Mixcloud and hearthis.at…</div>';
  box.innerHTML = '<div class="skeleton" style="height:180px;"></div>';
  const btn = $('#mixSearchBtn');
  if (btn) btn.disabled = true;
  try {
    const sid = newSid();
    const params = new URLSearchParams({ q, sources: _filters.sources.join(','), sid });
    const data = await apiJson(`/api/mixes/search?${params}`);
    if (gen !== _searchGen) return;
    startView(_libView, q, data, sid);
    renderResults(_libView);
  } catch (e) {
    if (gen !== _searchGen) return;
    _libView.gen++; _libView.last = null;
    box.innerHTML = '';
    $('#mixSearchStatus').innerHTML = `<div class="mix-err">${esc(e.message || 'Search failed')}</div>`;
  } finally {
    if (btn && gen === _searchGen) btn.disabled = false;
  }
}

function syncFilterControls() {
  $$('#mixFilters .mix-chip').forEach((c) => {
    const on = _filters.sources.includes(c.dataset.mixSource);
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if ($('#mixMinKbps')) $('#mixMinKbps').value = String(_filters.minKbps);
  if ($('#mixMinMinutes')) $('#mixMinMinutes').value = String(_filters.minMinutes);
  if ($('#mixSort')) $('#mixSort').value = _filters.sort;
}

// ── Followed DJs ──

async function followDj(it, btn) {
  btn.disabled = true;
  try {
    await apiJson('/api/mixes/follows', {
      method: 'POST',
      body: { source: it.source, user_id: it.uploader_id, name: it.uploader, image: it.thumbnail || '', url: it.uploader_url || '' },
    });
    showToast(`Following ${it.uploader}`);
    await loadFollows();
    renderAll();
  } catch (e) {
    btn.disabled = false;
    showToast('Follow failed: ' + (e.message || 'error'), true);
  }
}

const KBPS_OPTS = [[0, 'Any quality'], [128, '≥ 128 kbps'], [160, '≥ 160 kbps'], [192, '≥ 192 kbps']];
const MIN_OPTS = [[0, 'Any length'], [20, '≥ 20 min'], [45, '≥ 45 min']];

function opts(list, cur) {
  return list.map(([v, l]) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

function followCard(f, i) {
  const label = SOURCE_LABEL[f.source] || f.source;
  const href = safeHref(f.url);
  return `
    <div class="mix-follow" data-fi="${i}">
      <div class="mix-follow-main">
        ${thumb(f.image, 'mix-avatar')}
        <div class="mix-info">
          <div class="mix-title">${href ? `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : esc(f.name)}</div>
          <div class="mix-meta">${esc(label)}</div>
        </div>
        <div class="mix-actions">
          <button type="button" class="import-btn" data-act="uploads" aria-expanded="false">Latest mixes</button>
          <button type="button" class="btn-unsub" data-act="unfollow">Unfollow</button>
        </div>
      </div>
      <div class="mix-follow-opts">
        <label class="mix-toggle"><input type="checkbox" data-act="auto"${f.auto_download ? ' checked' : ''}> Auto-download new mixes</label>
        <select data-act="kbps" aria-label="Minimum quality for auto-download">${opts(KBPS_OPTS, f.min_kbps)}</select>
        <select data-act="minutes" aria-label="Minimum length for auto-download">${opts(MIN_OPTS, f.min_minutes)}</select>
      </div>
      <div class="mix-uploads" style="display:none"></div>
    </div>`;
}

function followPath(f) {
  return `/api/mixes/follows/${encodeURIComponent(f.source)}/${encodeURIComponent(f.user_id)}`;
}

async function loadFollows() {
  const box = $('#mixFollows');
  const gen = ++_followsGen;
  let data;
  try {
    data = await apiJson('/api/mixes/follows');
  } catch (e) {
    if (gen !== _followsGen) return;
    if (box) box.innerHTML = `<div class="mix-err">${esc(e.message || 'Could not load followed DJs')}</div>`;
    return;
  }
  if (gen !== _followsGen) return;   // a newer load is on its way
  _follows = data.follows || [];
  _followsLoaded = true;
  if (!box) return;
  if (!_follows.length) {
    box.innerHTML = '<p class="mix-hint">Follow a DJ from a search result to see their latest mixes here. With auto-download on, new mixes are fetched every 6 hours — never their back catalogue.</p>';
    return;
  }
  box.innerHTML = _follows.map(followCard).join('');
  $$('.mix-follow', box).forEach((card) => {
    const f = _follows[Number(card.dataset.fi)];
    card.querySelector('[data-act="uploads"]').addEventListener('click', (e) => toggleUploads(f, card, e.currentTarget));
    card.querySelector('[data-act="unfollow"]').addEventListener('click', () => unfollow(f));
    const put = async (body) => {
      try { await apiJson(followPath(f), { method: 'PUT', body }); Object.assign(f, body); }
      catch (e) { showToast('Could not save: ' + (e.message || 'error'), true); loadFollows(); }
    };
    card.querySelector('[data-act="auto"]').addEventListener('change', (e) => put({ auto_download: e.target.checked }));
    card.querySelector('[data-act="kbps"]').addEventListener('change', (e) => put({ min_kbps: Number(e.target.value) }));
    card.querySelector('[data-act="minutes"]').addEventListener('change', (e) => put({ min_minutes: Number(e.target.value) }));
  });
}

async function toggleUploads(f, card, btn) {
  const box = card.querySelector('.mix-uploads');
  if (box.style.display !== 'none') {
    box.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  box.style.display = '';
  btn.setAttribute('aria-expanded', 'true');
  box.innerHTML = '<div class="skeleton" style="height:120px;"></div>';
  // Per card: closing and reopening while the first answer is out must not let
  // the older answer paint over the newer one.
  const gen = String((Number(card.dataset.upGen) || 0) + 1);
  card.dataset.upGen = gen;
  try {
    const data = await apiJson(`${followPath(f)}/uploads?limit=10`);
    if (card.dataset.upGen !== gen || !card.isConnected) return;
    const items = data.uploads || [];
    box.innerHTML = items.length
      ? items.map((it, i) => resultRow(it, i, { showFollow: false })).join('')
      : '<p class="mix-hint">No uploads found.</p>';
    wireRows(box, items);
  } catch (e) {
    if (card.dataset.upGen !== gen || !card.isConnected) return;
    box.innerHTML = `<div class="mix-err">${esc(e.message || 'Could not load uploads')}</div>`;
  }
}

async function unfollow(f) {
  const ok = await showConfirmModal(`Unfollow ${f.name}?`,
    'Their new mixes will stop downloading. Mixes you already have stay.', { okLabel: 'Unfollow' });
  if (!ok) return;
  try {
    await apiJson(followPath(f), { method: 'DELETE' });
  } catch (e) {
    showToast('Unfollow failed: ' + (e.message || 'error'), true);
    return;
  }
  await loadFollows();
  renderAll();
}

async function checkNow(btn) {
  btn.disabled = true;
  try {
    const r = await apiJson('/api/mixes/follows/check', { method: 'POST' });
    if (r.status === 'already_running') { showToast('A check is already running'); return; }
    const n = (r.queued || []).length;
    const errs = Object.keys(r.errors || {}).length;
    if (!r.checked && !errs) showToast('No followed DJ has auto-download on');
    else showToast(n ? `Downloading ${n} new mix${n === 1 ? '' : 'es'}` : 'No new mixes', !!errs && !n);
    if (n) openPanel();
  } catch (e) {
    showToast('Check failed: ' + (e.message || 'error'), true);
  } finally {
    btn.disabled = false;
  }
}

// ── Downloaded mixes ──

let _lib = null;

export async function refreshMixLibrary() {
  const box = $('#mixLibrary');
  if (!box) return;
  if (!_lib) box.innerHTML = '<div class="skeleton" style="height:120px;"></div>';
  const gen = ++_libGen;
  let data;
  try {
    data = await apiJson('/api/mixes/library');
  } catch (e) {
    if (gen !== _libGen) return;
    box.innerHTML = `<div class="mix-err">${esc(e.message || 'Could not load downloaded mixes')}</div>`;
    return;
  }
  if (gen !== _libGen) return;   // a newer refresh is on its way
  _lib = data;
  mountClips(box);   // inside the refresh path, after the generation guard
  $('#mixLibTotal').textContent = _lib.count ? `${_lib.count} mix${_lib.count === 1 ? '' : 'es'} · Total: ${formatSize(_lib.total_size)}` : '';
  if (!_lib.djs.length) {
    box.innerHTML = '<p class="mix-hint">No downloaded mixes yet.</p>';
    return;
  }
  box.innerHTML = _lib.djs.map((dj, di) => `
    <div class="mix-dj" data-di="${di}">
      <div class="mix-dj-head"><span class="mix-dj-name">${esc(dj.name)}</span>
        <span class="mix-dj-meta">${dj.count} mix${dj.count === 1 ? '' : 'es'} · ${formatSize(dj.total_size)}</span></div>
      ${dj.mixes.map((m, mi) => `
        <div class="mix-row mix-lib-row" data-di="${di}" data-mi="${mi}">
          ${thumb(m.thumbnail)}
          <div class="mix-info">
            <div class="mix-title">${esc(m.title)}</div>
            <div class="mix-meta">${esc([m.quality, formatSize(m.size), fmtMixDuration(m.duration)].filter(Boolean).join(' · '))}</div>
          </div>
          <div class="mix-actions">
            <button type="button" class="import-btn import-btn-primary" data-act="play" aria-label="Play ${escAttr(m.title)}">&#9654; Play</button>
            <button type="button" class="import-btn" data-act="cut" data-cut-key="${escAttr(m.dj + '/' + m.file)}" aria-label="Cut a clip from ${escAttr(m.title)}">&#9986; Cut</button>
            <button type="button" class="btn-delete-ep" data-act="delete" aria-label="Delete ${escAttr(m.title)}">&#128465; Delete</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
  $$('.mix-lib-row', box).forEach((row) => {
    const m = _lib.djs[Number(row.dataset.di)].mixes[Number(row.dataset.mi)];
    row.querySelector('[data-act="play"]').addEventListener('click', () => playMix(m));
    row.querySelector('[data-act="delete"]').addEventListener('click', () => deleteMix(m));
    row.querySelector('[data-act="cut"]').addEventListener('click', (e) => {
      const btn = e.currentTarget;   // currentTarget is null once the await-ing import resolves
      import('./mixcut.js').then((c) => c.openCutter(m, btn));
    });
  });
}

function mountClips(box) {
  let c = document.getElementById('mixClips');
  if (!c) { c = document.createElement('div'); c.id = 'mixClips'; box.insertAdjacentElement('afterend', c); }
  import('./mixcut.js').then((m) => m.renderClipsSection(c)).catch(() => {}); // the Downloaded list must render even if the clip editor cannot load
}

function playMix(m) {
  // The same shape as any other downloaded track: the stream resolves the local
  // file by title + artist. playTracks, not addToQueue: addToQueue mirrors what
  // it queues into store.playlistMode — the user's open Navidrome playlist.
  // duration_ms: a cast needs the length — a receiver may report none, and then any
  // stop looked like the end of the set (cast review, findings 4/10).
  const item = { name: m.title, artist: m.artist, album: 'DJ Sets', image: m.thumbnail || '',
    duration_ms: m.duration > 0 ? Math.round(m.duration * 1000) : 0 };
  import('./upnext.js').then((u) => u.playTracks([item], 0));
}

async function deleteMix(m) {
  const ok = await showConfirmModal(`Delete “${m.title}”?`,
    'The downloaded file is removed from this server.', { okLabel: 'Delete' });
  if (!ok) return;
  try {
    await apiJson('/api/mixes/library', { method: 'DELETE', body: { dj: m.dj, file: m.file } });
    showToast(`Deleted “${m.title}”`);
  } catch (e) {
    showToast('Delete failed: ' + (e.message || 'error'), true);
  }
  refreshMixLibrary();
}

// ── Page ──

function wire() {
  if (_wired) return;
  _wired = true;
  $('#mixSearchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#mixSearchInput');
    if (input) input.blur();   // close the phone keyboard over the results
    runSearch();
  });
  $$('#mixFilters .mix-chip').forEach((c) => c.addEventListener('click', () => {
    const s = c.dataset.mixSource;
    const on = _filters.sources.includes(s);
    if (on && _filters.sources.length === 1) return;   // at least one source
    _filters.sources = on ? _filters.sources.filter((x) => x !== s) : MIX_SOURCES.filter((x) => x === s || _filters.sources.includes(x));
    _saveFilters();
    syncFilterControls();
    // A source switched on that the last search did not ask: ask again.
    if (!on && _libView.last && !(_libView.last.sources || []).includes(s)) runSearch();
    else renderAll();
  }));
  const onSel = (id, key) => $(id).addEventListener('change', (e) => {
    _filters[key] = key === 'sort' ? e.target.value : Number(e.target.value);
    _saveFilters();
    renderAll();
  });
  onSel('#mixMinKbps', 'minKbps');
  onSel('#mixMinMinutes', 'minMinutes');
  onSel('#mixSort', 'sort');
  $('#mixCheckNow').addEventListener('click', (e) => checkNow(e.currentTarget));
  $('#mixLibRefresh').addEventListener('click', () => refreshMixLibrary());
  syncFilterControls();
}

export function loadMixesPage() {
  wire();
  loadFollows();
  refreshMixLibrary();
}

// ── The Search page's "Mixes" type ──
// Called by search.js only on an explicit submit. `isStale()` is its generation
// check: a search the user has since replaced must not paint over the newer one.

/** Search DJ sets into `box`, with the status line in `status`. */
export async function searchMixesInView(q, { box, status, signal, isStale, onOpenLib }) {
  const v = _searchView;
  v.onOpenLib = onOpenLib || null;
  v.gen++; v.last = null;
  status.style.display = '';
  status.innerHTML = '<div class="mix-count">Searching SoundCloud, YouTube, Mixcloud and hearthis.at…</div>';
  box.innerHTML = '<div class="skeleton" style="height:180px;"></div>';
  const sid = newSid();
  const params = new URLSearchParams({ q, sources: _filters.sources.join(','), sid });
  // The follows are drawn as "Following" on the rows: load them once, with the search.
  const follows = _followsLoaded ? null : loadFollows().catch(() => {});
  try {
    const data = await apiJson(`/api/mixes/search?${params}`, { signal });
    if (follows) await follows;
    if (isStale()) return;
    startView(v, q, data, sid);
    renderResults(v);
  } catch (e) {
    if (isStale()) return;
    box.innerHTML = '';
    status.innerHTML = `<div class="mix-err">${esc(e.message || 'Search failed')}</div>`;
  }
}

/** The Search page left the Mixes type (or searched anew): forget its answer. */
export function resetSearchView() {
  _searchView.gen++;                     // drops a page that is still on its way
  if (_searchView.observer) { try { _searchView.observer.disconnect(); } catch {} _searchView.observer = null; }
  _searchView.last = null;
  _searchView.loading = false;
}
