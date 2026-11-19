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
import { apiJson } from './api.js';
import { openPanel } from './downloads.js';
import {
  MIX_SOURCES, applyMixFilters, normalizeFilters, qualityClass, fmtMixDuration,
} from './mixfilter.js';

const FILTER_KEY = 'ms_mix_filters';
const SOURCE_LABEL = { soundcloud: 'SoundCloud', youtube: 'YouTube', mixcloud: 'Mixcloud', hearthis: 'hearthis.at' };

let _wired = false;
let _filters = _loadFilters();
let _last = null;          // last search answer
let _searchGen = 0;
let _follows = [];         // [{source, user_id, ...}]
let _followsGen = 0;
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
    <div class="mix-row" data-idx="${idx}">
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
        <button type="button" class="import-btn import-btn-primary mix-dl" data-act="download"${it.in_library || started ? ' disabled' : ''}>${started ? 'Downloading…' : '&#8681; Download'}</button>
        ${canFollow ? `<button type="button" class="import-btn mix-follow-btn" data-act="follow"${followed ? ' disabled' : ''}>${followed ? 'Following' : '+ Follow DJ'}</button>` : ''}
      </div>
    </div>`;
}

function wireRows(container, items) {
  $$('.mix-row', container).forEach((row) => {
    const it = items[Number(row.dataset.idx)];
    if (!it) return;
    const dl = row.querySelector('[data-act="download"]');
    if (dl) dl.addEventListener('click', () => downloadMix(it, dl));
    const fol = row.querySelector('[data-act="follow"]');
    if (fol) fol.addEventListener('click', () => followDj(it, fol));
  });
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

function renderResults() {
  const box = $('#mixResults');
  const status = $('#mixSearchStatus');
  if (!box || !status) return;
  if (!_last) { box.innerHTML = ''; status.innerHTML = ''; return; }
  const r = applyMixFilters(_last.results || [], _filters);
  const total = (_last.results || []).length;
  const hidden = [];
  if (r.hiddenQuality) hidden.push(`${r.hiddenQuality} hidden by quality`);
  if (r.hiddenLength) hidden.push(`${r.hiddenLength} hidden by length`);
  if (r.hiddenSource) hidden.push(`${r.hiddenSource} from switched-off sources`);
  const errs = Object.entries(_last.errors || {})
    .filter(([s]) => _filters.sources.includes(s))
    .map(([s, msg]) => `<div class="mix-err">${esc(SOURCE_LABEL[s] || s)}: ${esc(msg)}</div>`).join('');
  status.innerHTML = `
    <div class="mix-count"><span id="mixShownCount">${r.shown.length}</span> of ${total} shown${hidden.length ? ` · <span id="mixHiddenNote">${esc(hidden.join(' · '))}</span>` : ''}
      ${(r.hiddenQuality || r.hiddenLength) ? '<button type="button" class="mix-linkbtn" id="mixShowAll">Show all</button>' : ''}</div>
    ${errs}`;
  const all = $('#mixShowAll');
  if (all) all.addEventListener('click', () => {
    _filters.minKbps = 0;
    _filters.minMinutes = 0;
    _saveFilters();
    syncFilterControls();
    renderResults();
  });
  if (!r.shown.length) {
    box.innerHTML = `<div class="empty-state mix-empty"><p>${total ? 'Nothing passes the filters.' : 'No mixes found.'}</p></div>`;
    return;
  }
  box.innerHTML = r.shown.map((it, i) => resultRow(it, i)).join('');
  wireRows(box, r.shown);
}

async function runSearch() {
  const input = $('#mixSearchInput');
  const q = (input && input.value || '').trim();
  if (!q) return;
  const gen = ++_searchGen;
  const box = $('#mixResults');
  $('#mixSearchStatus').innerHTML = '<div class="mix-count">Searching SoundCloud, YouTube, Mixcloud and hearthis.at…</div>';
  box.innerHTML = '<div class="skeleton" style="height:180px;"></div>';
  const btn = $('#mixSearchBtn');
  if (btn) btn.disabled = true;
  try {
    const params = new URLSearchParams({ q, sources: _filters.sources.join(',') });
    const data = await apiJson(`/api/mixes/search?${params}`);
    if (gen !== _searchGen) return;
    _last = data;
    renderResults();
  } catch (e) {
    if (gen !== _searchGen) return;
    _last = null;
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
    renderResults();
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
  if (!box) return;
  const gen = ++_followsGen;
  let data;
  try {
    data = await apiJson('/api/mixes/follows');
  } catch (e) {
    if (gen !== _followsGen) return;
    box.innerHTML = `<div class="mix-err">${esc(e.message || 'Could not load followed DJs')}</div>`;
    return;
  }
  if (gen !== _followsGen) return;   // a newer load is on its way
  _follows = data.follows || [];
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
  renderResults();
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
    if (!on && _last && !(_last.sources || []).includes(s)) runSearch();
    else renderResults();
  }));
  const onSel = (id, key) => $(id).addEventListener('change', (e) => {
    _filters[key] = key === 'sort' ? e.target.value : Number(e.target.value);
    _saveFilters();
    renderResults();
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
