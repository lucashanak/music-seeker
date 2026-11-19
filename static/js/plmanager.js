// plmanager.js — Library → Manager: two playlists side by side.
//
// Drag a row by its handle (or, with a mouse, by the row itself) to change its
// place in the playlist, or drop it into the other pane to move it there (Copy
// mode leaves the original). A click plays the playlist from that row.
//
// Every write is ONE call, POST /api/library/playlist-transfer, which names the
// row by (index, song id) and answers both playlists as they are afterwards; the
// server refuses (409) a row that no longer holds that song. The view updates
// at once and then takes the server's lists, so what is on screen is what
// Navidrome holds. Writes go out one at a time, in the order they were made.
//
// Loaded lazily by library.js switchLibraryTab; the first load builds the page.

import { store } from './store.js';
import { $, esc, escAttr, showToast, showInputModal, showConfirmModal, formatDuration } from './utils.js';
import { apiJson } from './api.js';
import { showContextMenu } from './contextmenu.js';
import { dropIndex } from './plmdrop.js';

const PANES_KEY = 'ms_plm_panes';
const MODE_KEY = 'ms_plm_mode';

let _built = false;
let _playlists = [];               // [{id, name, songCount, ...}] — the user's OWN playlists
const _tracks = new Map();         // playlist id -> [track] (both panes share one copy)
const _loadGen = new Map();        // playlist id -> generation of the last fetch
const _serverIds = new Map();      // playlist id -> song ids as the server last answered
const _panes = [{ id: null, filter: '' }, { id: null, filter: '' }];
let _mode = _loadMode();
let _writeChain = Promise.resolve();
let _pending = 0;
let _nowTimer = null;

function _loadMode() {
  try { return localStorage.getItem(MODE_KEY) === 'copy' ? 'copy' : 'move'; } catch { return 'move'; }
}

function _savePanes() {
  try { localStorage.setItem(PANES_KEY, JSON.stringify(_panes.map(p => p.id))); } catch {}
}

function _restoredPanes() {
  try { const v = JSON.parse(localStorage.getItem(PANES_KEY) || 'null'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function _plName(id) {
  const p = _playlists.find(x => String(x.id) === String(id));
  return p ? p.name : '';
}

function _paneEl(i) { return $(`#plmPanes .plm-pane[data-pane="${i}"]`); }

// ── Build ──

function _build() {
  const root = $('#pagePlManager');
  if (!root) return;
  root.innerHTML = `
    <div class="plm-head">
      <div>
        <h2 class="page-title" style="margin:0;">Playlist manager</h2>
        <p class="page-subtitle plm-sub">Drag a track by &#x2630; to reorder it, or into the other playlist. Click a track to play.</p>
      </div>
      <div class="plm-mode" role="group" aria-label="Dropping into the other playlist">
        <button type="button" class="mix-chip" data-plm-mode="move">Move</button>
        <button type="button" class="mix-chip" data-plm-mode="copy">Copy</button>
      </div>
    </div>
    <div class="plm-panes" id="plmPanes">
      ${[0, 1].map(i => `
      <section class="plm-pane" data-pane="${i}">
        <div class="plm-pane-head">
          <select class="plm-select" aria-label="Playlist ${i + 1}"></select>
          <button type="button" class="plm-play" title="Play this playlist" aria-label="Play this playlist">&#9654;</button>
        </div>
        <div class="plm-pane-tools">
          <input type="search" class="plm-filter" placeholder="Filter" aria-label="Filter tracks">
          <span class="plm-count"></span>
        </div>
        <div class="plm-list" tabindex="-1"></div>
      </section>`).join('')}
    </div>`;

  root.querySelectorAll('[data-plm-mode]').forEach(b => b.addEventListener('click', () => {
    _mode = b.dataset.plmMode;
    try { localStorage.setItem(MODE_KEY, _mode); } catch {}
    _renderMode();
  }));
  _renderMode();

  [0, 1].forEach(i => {
    const pane = _paneEl(i);
    pane.querySelector('.plm-select').addEventListener('change', (e) => _onSelect(i, e.target));
    pane.querySelector('.plm-play').addEventListener('click', () => _play(i, 0));
    pane.querySelector('.plm-filter').addEventListener('input', (e) => {
      _panes[i].filter = e.target.value;
      _renderPane(i);
    });
    const list = pane.querySelector('.plm-list');
    list.addEventListener('pointerdown', (e) => _onPointerDown(e, i));
    list.addEventListener('click', (e) => _onRowClick(e, i));
    list.addEventListener('contextmenu', (e) => {
      // Android fires contextmenu on a long press — also on a held drag handle.
      if (_drag || e.target.closest('.plm-handle')) { e.preventDefault(); return; }
      const row = e.target.closest('.plm-row');
      if (!row) return;
      e.preventDefault();
      _rowMenu(i, +row.dataset.idx, e.clientX, e.clientY);
    });
  });
  _built = true;
}

function _renderMode() {
  document.querySelectorAll('#pagePlManager [data-plm-mode]').forEach(b =>
    { b.setAttribute('aria-pressed', String(b.dataset.plmMode === _mode)); b.classList.toggle('active', b.dataset.plmMode === _mode); });
}

function _renderSelect(i) {
  const sel = _paneEl(i).querySelector('.plm-select');
  const cur = _panes[i].id;
  sel.innerHTML = '<option value="" disabled>Choose a playlist…</option>'
    + _playlists.map(p => `<option value="${escAttr(p.id)}">${esc(p.name)}</option>`).join('')
    + '<option value="__new">+ New playlist…</option>';
  sel.value = cur && _playlists.some(p => String(p.id) === String(cur)) ? String(cur) : '';
}

async function _onSelect(i, sel) {
  if (sel.value === '__new') {
    sel.value = _panes[i].id || '';
    const name = await showInputModal('New playlist', '', { okLabel: 'Create', placeholder: 'Playlist name' });
    if (!name || !name.trim()) return;
    if (_playlists.some(p => p.name.trim().toLowerCase() === name.trim().toLowerCase())) {
      showToast('A playlist with that name already exists', true);
      return;
    }
    try {
      const r = await apiJson('/api/library/playlist', { method: 'POST', body: { name: name.trim() } });
      await _loadPlaylists();
      _markLibraryStale();
      _setPane(i, r.id);
    } catch (e) { showToast('Could not create the playlist: ' + (e.message || ''), true); }
    return;
  }
  _setPane(i, sel.value);
}

function _setPane(i, id) {
  _panes[i].id = id || null;
  _panes[i].filter = '';
  const f = _paneEl(i).querySelector('.plm-filter');
  if (f) f.value = '';
  _savePanes();
  _renderSelect(i);
  _renderPane(i);
  if (id) _fetchTracks(id);
}

// ── Data ──

function _writeError(e) {
  if (e.status === 409) return 'The playlist changed elsewhere — reloaded';
  if (e.status === 403) return 'That playlist is not yours';
  return 'Failed: ' + (e.message || '');
}

async function _loadPlaylists() {
  const d = await apiJson('/api/library/playlists');
  // Only the user's own playlists: Navidrome also lists other users' public ones.
  _playlists = (d.playlists || []).filter(p => p.own).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}

// A fetch while writes are queued would draw a list that predates them; it is
// made once the queue drains instead.
const _refetch = new Set();

async function _fetchTracks(id) {
  if (_pending > 0) { _refetch.add(id); return; }
  const gen = (_loadGen.get(id) || 0) + 1;
  _loadGen.set(id, gen);
  try {
    const d = await apiJson(`/api/library/playlist/${encodeURIComponent(id)}`);
    if (_loadGen.get(id) !== gen) return;
    // A write queued while this was on its way is drawn into the view already;
    // this answer predates it.
    if (_pending > 0) { _refetch.add(id); return; }
    _tracks.set(id, d.tracks || []);
    _serverIds.set(id, (d.tracks || []).map(t => t.id));
  } catch (e) {
    if (_loadGen.get(id) !== gen) return;
    _tracks.set(id, null);
    showToast('Could not load the playlist: ' + (e.message || ''), true);
  }
  _renderPanesShowing(id);
}

function _renderPanesShowing(id) {
  [0, 1].forEach(i => { if (String(_panes[i].id) === String(id)) _renderPane(i); });
}

// ── Render ──

function _matches(t, q) {
  if (!q) return true;
  const hay = `${t.name || ''} ${t.artist || ''} ${t.album || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

function _renderPane(i) {
  // A pane redrawn mid-drag replaces the row being dragged; the drag goes on
  // (it is keyed by song id), and the new row gets the dragging look.
  const pane = _paneEl(i);
  if (!pane) return;
  const list = pane.querySelector('.plm-list');
  const count = pane.querySelector('.plm-count');
  const id = _panes[i].id;
  pane.classList.toggle('plm-empty-pane', !id);
  if (!id) {
    list.innerHTML = '<div class="plm-note">Choose a playlist above.</div>';
    count.textContent = '';
    return;
  }
  const tracks = _tracks.get(id);
  if (tracks === undefined) {
    list.innerHTML = Array(6).fill('<div class="skeleton skeleton-row"></div>').join('');
    count.textContent = '';
    return;
  }
  if (tracks === null) {
    list.innerHTML = '<div class="plm-note">Failed to load.</div>';
    count.textContent = '';
    return;
  }
  const q = _panes[i].filter.trim();
  const rows = [];
  tracks.forEach((t, idx) => {
    if (!_matches(t, q)) return;
    rows.push(`
      <div class="plm-row" data-idx="${idx}" data-id="${escAttr(t.id || '')}">
        <span class="plm-handle" title="Drag" aria-hidden="true">&#x2630;</span>
        <span class="plm-num">${idx + 1}</span>
        <img class="plm-thumb" draggable="false" ${t.image ? `src="${escAttr(t.image)}"` : ''} alt="" loading="lazy">
        <div class="plm-info">
          <div class="plm-title">${esc(t.name || '')}</div>
          <div class="plm-artist">${esc(t.artist || '')}</div>
        </div>
        <span class="plm-dur">${t.duration_ms ? formatDuration(t.duration_ms) : ''}</span>
        <button type="button" class="plm-more" aria-label="More">&#8943;</button>
      </div>`);
  });
  list.innerHTML = rows.join('') || `<div class="plm-note">${tracks.length ? 'No track matches the filter.' : 'Empty — drop tracks here.'}</div>`;
  count.textContent = q ? `${rows.length} of ${tracks.length}` : `${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
  if (_drag && _drag.started && String(_drag.fromId) === String(id)) {
    const at = tracks[_drag.fromIdx] && tracks[_drag.fromIdx].id === _drag.songId ? _drag.fromIdx
      : tracks.findIndex(x => x.id === _drag.songId);
    const nr = at >= 0 ? list.querySelector(`.plm-row[data-idx="${at}"]`) : null;
    if (nr) { _drag.row = nr; _drag.fromIdx = at; nr.classList.add('plm-dragging'); }
  }
  _markNowPlaying();
}

function _markNowPlaying() {
  // Under remote control the track that plays is the target's (it reports the id).
  const dev = store.remoteTarget ? (store.remoteDevices || {})[store.remoteTarget] : null;
  const cur = store.remoteTarget ? (dev && dev.track) : (store.playerQueue && store.playerQueue[store.playerIndex]);
  const curId = cur && cur.id ? String(cur.id) : '';
  document.querySelectorAll('#plmPanes .plm-row').forEach(r =>
    r.classList.toggle('plm-now', !!curId && r.dataset.id === curId));
}

// ── Play ──

async function _play(i, idx) {
  const id = _panes[i].id;
  const tracks = id && _tracks.get(id);
  if (!tracks || !tracks.length) { showToast('Empty playlist'); return; }
  try {
    // Same as Library → playlist → Play All: the named playlist becomes the
    // playback context (upnext.playTracks does not mirror into it).
    store.playlistMode = { id, name: _plName(id) };
    const u = await import('./upnext.js');
    await u.playTracks(tracks.slice(), idx);
    setTimeout(() => { _markNowPlaying(); _fit(); }, 300);
  } catch (e) {
    showToast('Failed: ' + (e.message || ''), true);
  }
}

let _suppressClick = false;

function _onRowClick(e, i) {
  if (_suppressClick) { _suppressClick = false; return; }
  const row = e.target.closest('.plm-row');
  if (!row) return;
  const idx = +row.dataset.idx;
  if (e.target.closest('.plm-more')) {
    const r = e.target.closest('.plm-more').getBoundingClientRect();
    _rowMenu(i, idx, r.left, r.bottom);
    return;
  }
  if (e.target.closest('.plm-handle')) return;
  _play(i, idx);
}

function _rowMenu(i, idx, x, y) {
  const id = _panes[i].id;
  const tracks = _tracks.get(id) || [];
  const t = tracks[idx];
  if (!t) return;
  const other = _panes[1 - i].id;
  const otherName = other ? _plName(other) : '';
  const sid = t.id;
  const acts = [
    { icon: '&#9654;', label: 'Play from here', onClick: () => _play(i, idx) },
    { icon: '&#8593;', label: 'Move to top', disabled: idx === 0, onClick: () => _transfer(id, idx, sid, id, 0, 'move') },
    { icon: '&#8595;', label: 'Move to bottom', disabled: idx === tracks.length - 1, onClick: () => _transfer(id, idx, sid, id, null, 'move') },
  ];
  if (other && String(other) !== String(id)) {
    acts.push({ divider: true });
    acts.push({ icon: '&#8594;', label: `Move to ${otherName}`, onClick: () => _transfer(id, idx, sid, other, null, 'move') });
    acts.push({ icon: '&#10697;', label: `Copy to ${otherName}`, onClick: () => _transfer(id, idx, sid, other, null, 'copy') });
  }
  acts.push({ divider: true });
  acts.push({ icon: '&#10005;', label: 'Remove from playlist', danger: true, onClick: () => _remove(id, idx, sid) });
  showContextMenu(x, y, acts, { title: `${t.artist ? t.artist + ' – ' : ''}${t.name || ''}` });
}

// ── Writes ──

function _enqueue(fn) {
  _pending++;
  _setBusy();
  const run = _writeChain.then(fn, fn);
  _writeChain = run.catch(() => {}).finally(() => {
    _pending--;
    _setBusy();
    if (_pending === 0 && _refetch.size) {
      const ids = [..._refetch];
      _refetch.clear();
      ids.forEach(_fetchTracks);
    }
  });
  return run;
}

// The server's list is the truth from here on: a fetch started earlier must not
// land on top of it.
function _takeServer(id, tracks) {
  _loadGen.set(id, (_loadGen.get(id) || 0) + 1);
  _tracks.set(id, tracks || []);
  _renderPanesShowing(id);
}

// Every answer of a write: remember what the server holds now, and bring the
// player along if it is playing this playlist.
function _onServer(id, tracks) {
  const prev = _serverIds.get(id);
  _serverIds.set(id, (tracks || []).map(t => t.id));
  _syncPlayingQueue(id, tracks || [], prev);
}

const _sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// The playlist that is playing changed here. In a named playlist the queue
// panel writes its copy back (a drag there replaces the playlist by the queue;
// its ✕ removes by queue index), so a copy left stale would undo this edit or
// remove the wrong row.
//
// The queue is rebuilt only when it IS that copy — the same songs in the same
// order as the server held before this write. `playlistMode` alone does not say
// so: Liked Songs, a card's play, "Shuffle All" all play something else and
// leave it set. Anything else (that, shuffle, a playing track that left the
// playlist) unties the queue from the playlist instead: playback goes on, and
// nothing the queue does is written into the playlist any more.
async function _syncPlayingQueue(id, tracks, prevIds) {
  if (store.remoteTarget) { _remotePlaying(id); return; }
  const mode = store.playlistMode;
  if (!mode || String(mode.id) !== String(id)) return;
  const q = store.playerQueue;
  if (!Array.isArray(q) || !q.length) return;
  const cur = q[store.playerIndex];
  let ni = -1;
  if (!store.shuffleEnabled && cur && cur.id && _sameIds(q.map(t => t.id), prevIds)) {
    // The same occurrence of the playing song (a playlist may hold it twice).
    let nth = 0;
    for (let i = 0; i < store.playerIndex; i++) if (q[i].id === cur.id) nth++;
    for (let i = 0, seen = 0; i < tracks.length; i++) {
      if (tracks[i].id !== cur.id) continue;
      if (seen === nth) { ni = i; break; }
      seen++;
    }
  }
  if (ni < 0) { _untieQueue(); return; }
  // In place: other modules hold this array (the queue contract is push, not a
  // new array).
  q.length = 0;
  tracks.forEach(t => q.push(t));
  store.playerIndex = ni;
  try { const qm = await import('./queue.js'); qm.renderQueue && qm.renderQueue(); } catch {}
  _saveQueue();
}

// Under remote control this device's queue is scratch, so there is nothing of its
// own to rebuild. The target may be playing this very playlist: it keeps its queue
// (playback goes on), and the edit lives in the playlist only — there is no command
// that rebuilds a target's queue from its playlist without restarting the track.
// Say so once per playlist and session, instead of leaving the queue panel and the
// playlist silently different.
const _remoteWarned = new Set();
function _remotePlaying(id) {
  const rq = store.remoteQueue;
  const pm = rq && rq.playlist_mode;
  if (!pm || String(pm.id) !== String(id)) return;
  const key = `${store.remoteTarget}|${id}`;
  if (_remoteWarned.has(key)) return;
  _remoteWarned.add(key);
  const dev = (store.remoteDevices || {})[store.remoteTarget];
  const name = (dev && dev.name) || 'the other device';
  showToast(`${name} keeps playing its queue — the change is in the playlist only`);
}

function _untieQueue() {
  // Not back to Up Next: initUpNext would adopt the server's Up Next, whose
  // contents are not this queue (Save as playlist would then save other tracks,
  // the ✕ would remove by an index that means nothing there).
  store.playlistMode = null;
  const badge = document.getElementById('fpPlaylistBadge');
  if (badge) badge.style.display = 'none';
  _saveQueue();
}

async function _saveQueue() {
  try {
    const { getPlayerModule } = await import('./player_active.js');
    const m = await getPlayerModule();
    m.saveQueueDebounced && m.saveQueueDebounced();
  } catch {}
}

function _setBusy() {
  const root = $('#pagePlManager');
  if (root) root.classList.toggle('plm-busy', _pending > 0);
}

function _markLibraryStale() {
  import('./library.js').then(m => m.markLibraryStale && m.markLibraryStale()).catch(() => {});
}

// Move/copy the row at `fromIdx` of `fromId` to `toIdx` of `toId` (null = end).
// For the same playlist, `toIdx` is the place in the list WITHOUT the row.
// `songId` is the song the user grabbed: the list may have been redrawn since
// (a write's answer, a reload), and an index alone would then name another row.
function _transfer(fromId, fromIdx, songId, toId, toIdx, mode) {
  const src = _tracks.get(fromId);
  if (!src || !songId) return;
  if (!src[fromIdx] || src[fromIdx].id !== songId) {
    // Nearest row holding that song (a playlist may hold it twice).
    let best = -1;
    src.forEach((x, i) => { if (x.id === songId && (best < 0 || Math.abs(i - fromIdx) < Math.abs(best - fromIdx))) best = i; });
    if (best < 0) { showToast('That track is no longer in the playlist'); return; }
    fromIdx = best;
  }
  const t = src[fromIdx];
  const same = String(fromId) === String(toId);
  const dst = same ? null : _tracks.get(toId);
  if (!same && !dst) return;

  if (same) {
    const next = src.slice();
    next.splice(fromIdx, 1);
    const at = toIdx == null ? next.length : Math.min(Math.max(0, toIdx), next.length);
    if (at === fromIdx) return;          // dropped where it already was
    next.splice(at, 0, t);
    _tracks.set(fromId, next);
  } else {
    const already = dst.some(x => x.id === t.id);
    if (!already) {
      const next = dst.slice();
      next.splice(toIdx == null ? next.length : Math.min(toIdx, next.length), 0, t);
      _tracks.set(toId, next);
    }
    if (mode === 'move') {
      const s = src.slice();
      s.splice(fromIdx, 1);
      _tracks.set(fromId, s);
    }
  }
  _renderPanesShowing(fromId);
  if (!same) _renderPanesShowing(toId);

  // The request carries the index the row had when the user grabbed it. Earlier
  // writes are applied to the view before this one is made, so after they land
  // the server's list matches that view again.
  const body = { from_id: fromId, from_index: fromIdx, song_id: t.id, to_id: toId, to_index: toIdx, mode };
  return _enqueue(async () => {
    try {
      const r = await apiJson('/api/library/playlist-transfer', { method: 'POST', body });
      // Take the server's lists only when nothing else is queued: a later write
      // is already drawn into the view, and this answer predates it.
      _onServer(fromId, r.from);
      if (!same) _onServer(toId, r.to);
      if (_pending === 1) {
        _takeServer(fromId, r.from);
        if (!same) _takeServer(toId, r.to);
      } else {
        // Later writes are drawn into the view already; once they have all
        // landed, both lists are read again so the view ends on the server's.
        _refetch.add(fromId);
        if (!same) _refetch.add(toId);
      }
      _markLibraryStale();
      const toName = _plName(toId);
      if (r.status === 'already') {
        showToast(mode === 'move' && r.removed ? `Already in ${toName} — removed from ${_plName(fromId)}` : `Already in ${toName}`);
      } else if (!same && mode === 'move' && !r.removed) {
        showToast(`Copied to ${toName}, but it could not be removed from ${_plName(fromId)}`, true);
      } else if (!r.placed) {
        showToast(`Added to the end of ${toName}`);
      }
    } catch (e) {
      showToast(_writeError(e), true);
      _refetch.add(fromId);
      if (!same) _refetch.add(toId);
    }
  });
}

async function _remove(id, idx, songId) {
  const t = (_tracks.get(id) || [])[idx];
  if (!t || t.id !== songId) return;
  const ok = await showConfirmModal('Remove from playlist?',
    `"${t.artist ? t.artist + ' - ' : ''}${t.name || ''}" stays in your library.`,
    { okLabel: 'Remove', danger: false });
  if (!ok) return;
  // The index may have moved while the dialog was open (a queued write landed).
  const now = _tracks.get(id) || [];
  const at = now[idx] && now[idx].id === songId ? idx : now.findIndex(x => x.id === songId);
  if (at < 0) return;
  const next = now.slice();
  next.splice(at, 1);
  _tracks.set(id, next);
  _renderPanesShowing(id);
  return _enqueue(async () => {
    try {
      // By (index, song id): the server removes that row or refuses (409) —
      // never "the first track with a similar name".
      const r = await apiJson('/api/library/playlist-remove', {
        method: 'POST', body: { playlist_id: id, index: at, song_id: songId },
      });
      _onServer(id, r.tracks);
      if (_pending === 1) _takeServer(id, r.tracks); else _refetch.add(id);
      _markLibraryStale();
    } catch (e) {
      showToast(_writeError(e), true);
      _refetch.add(id);
    }
  });
}

// ── Drag (Pointer Events: mouse, touch, pen) ──
// A touch drag starts on the handle only (the list must still scroll under a
// finger); a mouse drag starts anywhere on the row once it has moved 5 px, so a
// plain click still plays.

let _drag = null;

function _onPointerDown(e, i) {
  if (e.button !== 0 || _drag) return;
  const row = e.target.closest('.plm-row');
  if (!row || e.target.closest('.plm-more')) return;
  const onHandle = !!e.target.closest('.plm-handle');
  if (!onHandle && e.pointerType !== 'mouse') return;
  if (onHandle) e.preventDefault();
  _drag = {
    pane: i, fromId: _panes[i].id, fromIdx: +row.dataset.idx, songId: row.dataset.id, row,
    x0: e.clientX, y0: e.clientY, started: false, pointerId: e.pointerId,
    ghost: null, target: null, scrollRaf: 0, lastX: e.clientX, lastY: e.clientY,
  };
  // Even from the handle the drag starts only once the pointer has moved: a tap
  // on a handle near a list edge would otherwise auto-scroll and drop the row
  // a place or two away.
  document.addEventListener('pointermove', _onMove);
  document.addEventListener('pointerup', _onUp);
  document.addEventListener('pointercancel', _onCancel);
  document.addEventListener('keydown', _onKey, true);
}

function _startDrag() {
  const d = _drag;
  d.started = true;
  d.row.classList.add('plm-dragging');
  document.body.classList.add('plm-drag-active');
  const g = d.row.cloneNode(true);
  g.classList.add('plm-ghost');
  g.classList.remove('plm-dragging', 'plm-now');
  g.style.width = d.row.getBoundingClientRect().width + 'px';
  document.body.appendChild(g);
  d.ghost = g;
  _positionGhost();
  _autoScroll();
}

function _positionGhost() {
  const d = _drag;
  if (d && d.ghost) d.ghost.style.transform = `translate(${d.lastX + 8}px, ${d.lastY - 18}px)`;
}

function _onMove(e) {
  const d = _drag;
  if (!d || e.pointerId !== d.pointerId) return;
  d.lastX = e.clientX; d.lastY = e.clientY;
  if (!d.started) {
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 5) return;
    _startDrag();
  }
  e.preventDefault();
  _positionGhost();
  _updateTarget();
}

function _clearIndicator() {
  document.querySelectorAll('#plmPanes .plm-drop-before, #plmPanes .plm-drop-after, #plmPanes .plm-drop-into')
    .forEach(el => el.classList.remove('plm-drop-before', 'plm-drop-after', 'plm-drop-into'));
}

// Where a drop at the pointer would land: {pane, beforeIdx|null (= end)}.
function _updateTarget() {
  const d = _drag;
  _clearIndicator();
  d.target = null;
  const el = document.elementFromPoint(d.lastX, d.lastY);
  const paneEl = el && el.closest('#plmPanes .plm-pane');
  if (!paneEl) return;
  const pi = +paneEl.dataset.pane;
  const id = _panes[pi].id;
  if (!id || !Array.isArray(_tracks.get(id))) return;
  const list = paneEl.querySelector('.plm-list');
  const row = el.closest('.plm-row');
  if (row) {
    const r = row.getBoundingClientRect();
    const after = d.lastY > r.top + r.height / 2;
    if (after) {
      // Directly after the row the user sees — not before the next VISIBLE
      // row, which with a filter on can be many hidden rows further down.
      d.target = { pane: pi, beforeIdx: (+row.dataset.idx) + 1 };
      row.classList.add('plm-drop-after');
    } else {
      d.target = { pane: pi, beforeIdx: +row.dataset.idx };
      row.classList.add('plm-drop-before');
    }
  } else {
    // Over the pane but not a row: the end of the list (of the visible rows,
    // when filtered — the row after the last one shown).
    const rows = list.querySelectorAll('.plm-row');
    const last = rows[rows.length - 1];
    d.target = { pane: pi, beforeIdx: last ? (+last.dataset.idx) + 1 : null };
    if (last) last.classList.add('plm-drop-after'); else list.classList.add('plm-drop-into');
  }
}

// Scroll the list under the pointer while it is near its top/bottom edge.
function _autoScroll() {
  const d = _drag;
  if (!d || !d.started) return;
  const el = document.elementFromPoint(d.lastX, d.lastY);
  const list = el && el.closest('#plmPanes .plm-list');
  if (list) {
    const r = list.getBoundingClientRect();
    // A narrow band at the edge: a wide one scrolled the list under a drop
    // aimed at its last visible row.
    const edge = Math.min(24, r.height / 8);
    let dy = 0;
    if (d.lastY < r.top + edge) dy = -Math.ceil((r.top + edge - d.lastY) / 3);
    else if (d.lastY > r.bottom - edge) dy = Math.ceil((d.lastY - (r.bottom - edge)) / 3);
    if (dy) { list.scrollTop += dy; _updateTarget(); }
  }
  // The page too: a pane can sit partly off screen (small phones, landscape).
  const bottom = _bottomObstruction();
  let py = 0;
  if (d.lastY > bottom - 36) py = Math.ceil((d.lastY - (bottom - 36)) / 3);
  else if (d.lastY < 60 && window.scrollY > 0) py = -Math.ceil((60 - d.lastY) / 3);
  if (py) { window.scrollBy(0, py); _updateTarget(); }
  d.scrollRaf = requestAnimationFrame(_autoScroll);
}

function _endDrag() {
  const d = _drag;
  _drag = null;
  document.removeEventListener('pointermove', _onMove);
  document.removeEventListener('pointerup', _onUp);
  document.removeEventListener('pointercancel', _onCancel);
  document.removeEventListener('keydown', _onKey, true);
  if (!d) return null;
  cancelAnimationFrame(d.scrollRaf);
  _clearIndicator();
  if (d.ghost) d.ghost.remove();
  d.row.classList.remove('plm-dragging');
  document.body.classList.remove('plm-drag-active');
  return d;
}

function _onUp(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  // A redraw since the last move changed the indices: aim again.
  if (_drag.started) _updateTarget();
  const d = _endDrag();
  if (!d || !d.started) return;
  // The click that follows a mouse drag must not play the row.
  _suppressClick = true;
  setTimeout(() => { _suppressClick = false; }, 0);
  if (!d.target) return;
  const toId = _panes[d.target.pane].id;
  const before = d.target.beforeIdx;
  const same = String(toId) === String(d.fromId);
  const at = dropIndex({
    same, fromIdx: d.fromIdx, beforeIdx: before,
    fromLen: (_tracks.get(d.fromId) || []).length, toLen: (_tracks.get(toId) || []).length,
  });
  if (at === undefined) return;
  _transfer(d.fromId, d.fromIdx, d.songId, toId, at, same ? 'move' : _mode);
}

function _onCancel(e) {
  if (_drag && e.pointerId === _drag.pointerId) _endDrag();
}

function _onKey(e) {
  // Capture phase + stopImmediatePropagation: the router's own Escape handler
  // (also on document) would otherwise close the queue panel underneath.
  if (e.key === 'Escape' && _drag) { e.preventDefault(); e.stopImmediatePropagation(); _endDrag(); }
}

// ── Phone: both lists on one screen ──
// Stacked panes of a fixed height left the second list under the bottom nav
// and the player bar, where nothing can be dropped. Size each list so both
// panes end above whatever is fixed to the bottom of the screen.
const _phoneMq = window.matchMedia('(max-width: 640px)');

function _bottomObstruction() {
  let bottom = window.innerHeight;
  document.querySelectorAll('#playerBar, #bottomNav').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top > window.innerHeight / 2 && r.top < bottom) bottom = r.top;
  });
  return bottom;
}

function _fit() {
  const panes = $('#plmPanes');
  if (!panes || panes.offsetParent === null) return;
  if (!_phoneMq.matches) { panes.style.removeProperty('--plm-list-h'); return; }
  const lists = panes.querySelectorAll('.plm-list');
  if (lists.length !== 2) return;
  const top = panes.getBoundingClientRect().top + window.scrollY;   // at scroll 0
  const chrome = panes.getBoundingClientRect().height - lists[0].offsetHeight - lists[1].offsetHeight;
  const avail = _bottomObstruction() - top - chrome - 8;
  panes.style.setProperty('--plm-list-h', Math.max(150, Math.floor(avail / 2)) + 'px');
}

let _fitWired = false;
function _wireFit() {
  if (_fitWired) return;
  _fitWired = true;
  window.addEventListener('resize', _fit);
  if (_phoneMq.addEventListener) _phoneMq.addEventListener('change', _fit);
}

// ── Entry points (library.js) ──

// While the manager is on screen the body carries .plm-active: on a phone the
// feedback button would float over the ⋯ of the second list's last rows, so
// pages.css hides it there.
function _startNowTimer() {
  document.body.classList.add('plm-active');
  if (_nowTimer) return;
  _nowTimer = setInterval(() => {
    const root = $('#pagePlManager');
    if (!root || root.offsetParent === null) {
      clearInterval(_nowTimer); _nowTimer = null;
      document.body.classList.remove('plm-active');
      return;
    }
    _markNowPlaying();
  }, 500);
}

export async function loadPlManager() {
  if (!_built) _build();
  try {
    await _loadPlaylists();
  } catch (e) {
    showToast('Could not load playlists: ' + (e.message || ''), true);
    return;
  }
  const saved = _restoredPanes();
  const known = (id) => id && _playlists.some(p => String(p.id) === String(id));
  [0, 1].forEach(i => {
    let id = known(_panes[i].id) ? _panes[i].id : (known(saved[i]) ? saved[i] : null);
    if (!id) {
      const taken = _panes[1 - i].id || saved[1 - i];
      const pick = _playlists.find(p => String(p.id) !== String(taken)) || _playlists[0];
      id = pick ? pick.id : null;
    }
    _panes[i].id = id;
    _renderSelect(i);
  });
  _savePanes();
  // A revisit reloads both: the playlists may have changed in another view.
  const ids = new Set(_panes.map(p => p.id).filter(Boolean));
  [0, 1].forEach(_renderPane);
  ids.forEach(id => { if (_pending === 0) _fetchTracks(id); });
  _startNowTimer();
  _wireFit();
  requestAnimationFrame(_fit);
  setTimeout(_fit, 600);   // the player bar may appear once playback state loads
}

// Test hook — the e2e reads the model the view is drawn from.
export function _debugState() {
  return { panes: _panes.map(p => ({ ...p })), tracks: Object.fromEntries(_tracks), mode: _mode, pending: _pending };
}
