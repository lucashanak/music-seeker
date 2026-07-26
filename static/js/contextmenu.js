// contextmenu.js — Universal right-click / long-press menu
//
// Usage:
//   import { attachContextMenu } from './contextmenu.js';
//   attachContextMenu(rootEl, {
//     getItem: (targetEl) => ({ item: {...}, type: 'track', context: {...} }) | null
//   });
//
// The getItem callback receives the deepest element with `data-ctx-item` (or a
// fallback selector). Returning null cancels the menu.

import { $, esc, showToast, showPlaylistPicker } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { store } from './store.js';
import { getPlayerModule } from './player_active.js';
import { isLiked, toggleLike } from './likes.js';

const LONG_PRESS_MS = 480;
const MOVE_THRESHOLD = 10; // px
const SUPPRESS_MS = 600;

let _menuEl = null;
let _onDocClick = null;
let _suppressClickUntil = 0;
let _suppressTarget = null;

// Click suppression flag exported so card handlers can skip click after a long-press.
// Scoped: only suppresses on the element where the long-press fired.
export function wasLongPress(targetEl) {
  if (Date.now() >= _suppressClickUntil) return false;
  if (!_suppressTarget || !targetEl) return Date.now() < _suppressClickUntil;
  return _suppressTarget === targetEl || _suppressTarget.contains(targetEl) || targetEl.contains(_suppressTarget);
}

function _onScrollOrMove() { hideContextMenu(); }

// ── Public: show menu at coords with arbitrary actions ──
export function showContextMenu(x, y, actions, opts = {}) {
  hideContextMenu();
  if (!actions || !actions.length) return;
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  if (opts.title) {
    const h = document.createElement('div');
    h.className = 'ctx-menu-title';
    h.textContent = opts.title;
    menu.appendChild(h);
  }
  actions.forEach(a => {
    if (a.divider) {
      const d = document.createElement('div');
      d.className = 'ctx-menu-divider';
      menu.appendChild(d);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-menu-item' + (a.danger ? ' ctx-menu-danger' : '') + (a.disabled ? ' ctx-menu-disabled' : '');
    btn.disabled = !!a.disabled;
    btn.innerHTML = `<span class="ctx-menu-icon">${a.icon || ''}</span><span class="ctx-menu-label">${esc(a.label || '')}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideContextMenu();
      try { a.onClick && a.onClick(); } catch (err) { console.error(err); showToast('Action failed'); }
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);

  // Position with viewport clamping
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  let px = Math.min(x, vw - w - 8);
  let py = Math.min(y, vh - h - 8);
  if (px < 8) px = 8;
  if (py < 8) py = 8;
  menu.style.left = px + 'px';
  menu.style.top = py + 'px';
  _menuEl = menu;

  _onDocClick = (e) => {
    if (!_menuEl) return;
    if (e.target === _menuEl || _menuEl.contains(e.target)) return;
    hideContextMenu();
  };
  // Listen on capture so we close before underlying click fires
  setTimeout(() => {
    document.addEventListener('click', _onDocClick, true);
    document.addEventListener('contextmenu', _onDocClick, true);
    document.addEventListener('scroll', _onScrollOrMove, true);
    document.addEventListener('wheel', _onScrollOrMove, true);
    document.addEventListener('touchmove', _onScrollOrMove, { capture: true, passive: true });
    window.addEventListener('resize', hideContextMenu);
    document.addEventListener('keydown', _onEsc);
  }, 0);
}

function _onEsc(e) { if (e.key === 'Escape') hideContextMenu(); }

export function hideContextMenu() {
  if (_menuEl) {
    _menuEl.remove();
    _menuEl = null;
  }
  if (_onDocClick) {
    document.removeEventListener('click', _onDocClick, true);
    document.removeEventListener('contextmenu', _onDocClick, true);
    document.removeEventListener('scroll', _onScrollOrMove, true);
    document.removeEventListener('wheel', _onScrollOrMove, true);
    document.removeEventListener('touchmove', _onScrollOrMove, { capture: true });
    window.removeEventListener('resize', hideContextMenu);
    document.removeEventListener('keydown', _onEsc);
    _onDocClick = null;
  }
}

// ── Attach: per-container right-click + long-press ──
//
// opts.getItem(targetEl, event) → { item, type, context } | null
// opts.selector — CSS selector for clickable items (default looks for data-ctx-item)
export function attachContextMenu(rootEl, opts) {
  if (!rootEl || rootEl.__ctxAttached) return;
  rootEl.__ctxAttached = true;
  const selector = opts.selector || '[data-ctx-item]';

  const _resolveAndShow = (coords, targetEl, srcEvent) => {
    if (!targetEl || !rootEl.contains(targetEl)) return;
    const info = opts.getItem ? opts.getItem(targetEl, srcEvent) : null;
    if (!info) return;
    // Allow consumers to pass a custom action list directly
    const actions = info.actions || (info.item ? buildActionsFor(info.item, info.type || 'track', info.context || {}) : null);
    if (!actions || !actions.length) return;
    const title = info.title || (info.item && info.item.name) || '';
    showContextMenu(coords.x, coords.y, actions, { title });
  };

  // Desktop right-click
  rootEl.addEventListener('contextmenu', (e) => {
    const target = e.target.closest(selector);
    if (!target || !rootEl.contains(target)) return;
    // Ignore on form inputs
    if (e.target.closest('input, textarea, select, button[data-ctx-skip]')) return;
    e.preventDefault();
    _resolveAndShow({ x: e.clientX, y: e.clientY }, target, e);
  });

  // Touch long-press
  let pressTimer = null;
  let pressTarget = null;
  let startX = 0, startY = 0;
  let moved = false;

  rootEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const target = e.target.closest(selector);
    if (!target || !rootEl.contains(target)) return;
    // Skip on form inputs, drag handles, and explicit buttons (so checkboxes, removes, action buttons keep working)
    if (e.target.closest('input, textarea, select, button, .qi-drag, [data-ctx-skip]')) return;
    pressTarget = target;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved = false;
    const capturedTarget = target;
    pressTimer = setTimeout(() => {
      // Re-validate: element may have been re-rendered (innerHTML replaced)
      if (!moved && capturedTarget && rootEl.contains(capturedTarget)) {
        try { navigator.vibrate && navigator.vibrate(15); } catch {}
        _suppressClickUntil = Date.now() + SUPPRESS_MS;
        _suppressTarget = capturedTarget;
        _resolveAndShow({ x: startX, y: startY }, capturedTarget, null);
      }
      pressTimer = null;
      pressTarget = null;
    }, LONG_PRESS_MS);
  }, { passive: true });

  rootEl.addEventListener('touchmove', (e) => {
    if (!pressTimer) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_THRESHOLD) {
      moved = true;
      clearTimeout(pressTimer);
      pressTimer = null;
      pressTarget = null;
    }
  }, { passive: true });

  const _cancel = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
      // Press released before timer fired → no long-press, no suppression
      _suppressClickUntil = 0;
      _suppressTarget = null;
    }
    pressTarget = null;
  };
  rootEl.addEventListener('touchend', _cancel, { passive: true });
  rootEl.addEventListener('touchcancel', _cancel, { passive: true });
}

// ── Standard action set per item-type ──
//
// item: object with at least {name, artist, type?, id?, album?}
// type: 'track' | 'album' | 'artist' | 'playlist' | 'show' | 'episode' | 'queue-track' | 'recommendation'
// context: { queueIndex?, recIndex?, inLibrary?, playlistId?, ... }
export function buildActionsFor(item, type, context = {}) {
  const actions = [];
  const it = item || {};

  // ── Track-like items (track, queue-track, recommendation, episode) ──
  const isTracklike = (type === 'track' || type === 'queue-track' || type === 'recommendation' || type === 'episode' || it.type === 'track');

  // "Add to playlist" vs "Add to Up Next": _addToQueue appends to the in-memory
  // queue, which only persists as a real playlist when playlistMode is set.
  const addLabel = store.playlistMode ? 'Add to playlist' : 'Add to Up Next';

  if (type === 'queue-track') {
    actions.push({
      label: 'Play now', icon: '&#9654;',
      onClick: () => _playQueueIndex(context.queueIndex),
    });
    actions.push({
      label: 'Play next', icon: '&#8595;',
      onClick: () => _moveQueueAfterCurrent(context.queueIndex),
    });
    actions.push({ divider: true });
  } else if (type === 'recommendation') {
    actions.push({
      label: 'Play', icon: '&#9654;',
      onClick: () => import('./recommendations.js').then(m => m.playRecIndex && m.playRecIndex(context.recIndex)),
    });
    actions.push({
      label: addLabel, icon: '+',
      onClick: () => _addToQueue([it]),
    });
    actions.push({
      label: 'Play next', icon: '&#8595;',
      onClick: () => _playNext(it),
    });
    actions.push({ divider: true });
  } else if (isTracklike) {
    actions.push({
      label: 'Play', icon: '&#9654;',
      onClick: () => _playNow(it),
    });
    actions.push({
      label: 'Play next', icon: '&#8595;',
      onClick: () => _playNext(it),
    });
    actions.push({
      label: addLabel, icon: '+',
      onClick: () => _addToQueue([it]),
    });
    actions.push({
      label: 'More like this', icon: '&#128251;',
      onClick: () => import('./radio.js').then(m => m.startTrackRadio(it)),
    });
    actions.push({
      label: 'More like this (calm)', icon: '&#127769;',
      onClick: () => import('./radio.js').then(m => m.startTrackRadio(it, { vibe: 'calm' })),
    });
    actions.push({ divider: true });
  } else if (type === 'album') {
    actions.push({
      label: 'Open album', icon: '&#128194;',
      onClick: () => openModal(it),
    });
    actions.push({
      label: 'Play all (replace Up Next)', icon: '&#9654;',
      onClick: () => _playAlbumReplace(it),
    });
    actions.push({
      label: 'Add all to queue', icon: '+',
      onClick: () => _addAlbumToQueue(it),
    });
    actions.push({
      label: 'Add all to playlist…', icon: '&#9776;',
      onClick: () => _addAlbumToNavidromePlaylist(it),
    });
    actions.push({ divider: true });
  } else if (type === 'artist') {
    actions.push({
      label: 'Open artist', icon: '&#128100;',
      onClick: () => _openArtist(it),
    });
    actions.push({
      label: 'Play radio', icon: '&#128251;',
      onClick: () => _playArtistRadio(it),
    });
    // Derive follow state from the loaded favorites set so search-result cards
    // get the action too — callers used to have to pass `canFollow`, which
    // nothing ever set. The favorites page's explicit isFavorite still wins.
    const following = context.isFavorite === true || (!!it.id && store.favoritedArtistIds.has(it.id));
    actions.push({ divider: true });
    if (following) {
      actions.push({
        label: 'Unfollow', icon: '&#x2661;', danger: true,
        onClick: () => import('./favorites.js').then(m => m.toggleFavoriteArtist(it).then(() => import('./favorites.js').then(f => f.loadFavorites && f.loadFavorites()))),
      });
    } else {
      actions.push({
        label: 'Follow', icon: '&#x2665;',
        onClick: () => import('./favorites.js').then(m => m.toggleFavoriteArtist(it)),
      });
    }
    actions.push({ divider: true });
  } else if (type === 'playlist') {
    // Where "back" should return to. Search results want the search page (the
    // default); a menu opened from a page that already hosts the detail view
    // passes detailSource: null so closing it stays put.
    const detailSource = context.detailSource !== undefined ? context.detailSource : 'search';
    actions.push({
      label: 'Open', icon: '&#128194;',
      onClick: () => _openItem(it, detailSource),
    });
    actions.push({
      label: 'Play all (replace Up Next)', icon: '&#9654;',
      onClick: () => _playPlaylistReplace(it),
    });
    actions.push({
      label: 'Add all to queue', icon: '+',
      onClick: () => _addPlaylistToQueue(it),
    });
    actions.push({
      label: 'Add all to playlist…', icon: '&#9776;',
      onClick: () => _addPlaylistToNavidromePlaylist(it),
    });
    actions.push({ divider: true });
  } else if (type === 'show') {
    actions.push({
      label: 'Open', icon: '&#128194;',
      onClick: () => _openItem(it, context.detailSource !== undefined ? context.detailSource : 'search'),
    });
    actions.push({ divider: true });
  }

  // ── Like / Unlike (track-like) — label reflects current state ──
  if (isTracklike) {
    const liked = isLiked(it);
    actions.push({
      label: liked ? 'Unlike' : 'Like', icon: liked ? '&#9829;' : '&#9825;',
      onClick: () => toggleLike(it),
    });
  }

  // ── Add to Navidrome playlist (track-like) ──
  if (isTracklike) {
    actions.push({
      label: 'Add to other playlist…', icon: '&#9776;',
      onClick: () => _addToNavidromePlaylist(it),
    });
  }

  // ── Download (track / album / episode) ──
  if (isTracklike || type === 'album') {
    const dl = {
      label: 'Download', icon: '&#11015;',
      onClick: () => openModal(it),
    };
    if (context.inLibrary || it.inLibrary) {
      dl.label = 'Already in library';
      dl.disabled = true;
    }
    actions.push(dl);
  }

  // ── Show artist/album from a track ──
  if (isTracklike) {
    if (it.artist) {
      actions.push({
        label: 'Show artist', icon: '&#128100;',
        onClick: () => _searchFor('artist', it.artist),
      });
    }
    if (it.album) {
      actions.push({
        label: 'Show album', icon: '&#128189;',
        onClick: () => _searchFor('album', it.album),
      });
    }
  }

  // ── Copy info ──
  // Only tracks/albums have a meaningful "Artist - Title"; on an artist the two
  // fields are the same string and on a playlist `artist` is the owner, so those
  // copy just the name.
  if (it.name) {
    const copyBoth = (isTracklike || type === 'album') && !!it.artist && it.artist !== it.name;
    if (!actions[actions.length - 1]?.divider) actions.push({ divider: true });
    actions.push({
      label: copyBoth ? 'Copy "Artist - Title"' : 'Copy name', icon: '&#128203;',
      onClick: () => _copyInfo(it, copyBoth),
    });
  }

  // ── Destructive: remove / dismiss ──
  if (type === 'queue-track' && typeof context.queueIndex === 'number') {
    actions.push({ divider: true });
    actions.push({
      label: 'Remove from queue', icon: '&times;', danger: true,
      onClick: () => _removeFromQueue(context.queueIndex),
    });
    // When the queue is backed by a real (named) Navidrome playlist, also offer
    // removing the track from that playlist (not just the in-memory queue).
    if (store.playlistMode && store.playlistMode.name !== 'Up Next') {
      actions.push({
        label: 'Remove from playlist', icon: '&times;', danger: true,
        onClick: () => _removeFromQueue(context.queueIndex, true),
      });
    }
  }
  if (type === 'recommendation' && typeof context.recIndex === 'number') {
    actions.push({ divider: true });
    actions.push({
      label: 'Dismiss', icon: '&times;', danger: true,
      onClick: () => import('./recommendations.js').then(m => m.dismissRec && m.dismissRec(context.recIndex)),
    });
  }

  return actions;
}

// ── Action implementations ────────────────────────────────────────
function _addToQueue(items) {
  // No toast here — the player's addToQueue already shows its own confirmation
  // (and a playlist-mode add toast), so emitting one here would double-toast.
  getPlayerModule().then(m => m.addToQueue(items));
}

function _playNow(item) {
  getPlayerModule().then(m => m.addToQueue([item], true));
}

function _playNext(item) {
  // Insert at current index + 1 — or play now if nothing is currently playing.
  const playing = store.playerIndex >= 0;
  const idx = (playing ? store.playerIndex : -1) + 1;
  store.playerQueue.splice(idx, 0, item);
  import('./queue.js').then(m => m.renderQueue());
  if (!playing) store.playerIndex = idx;
  getPlayerModule().then(m => {
    if (!playing && m.loadAndPlay) m.loadAndPlay();
    m.saveQueueDebounced && m.saveQueueDebounced();
  });
  showToast(playing ? 'Will play next' : 'Playing');
}

function _playQueueIndex(idx) {
  if (typeof idx !== 'number' || idx < 0 || idx >= store.playerQueue.length) return;
  store.playerIndex = idx;
  getPlayerModule().then(m => m.loadAndPlay && m.loadAndPlay());
}

function _moveQueueAfterCurrent(idx) {
  if (typeof idx !== 'number' || idx < 0 || idx >= store.playerQueue.length) return;
  const [item] = store.playerQueue.splice(idx, 1);
  let dest = (store.playerIndex >= 0 ? store.playerIndex : -1) + 1;
  if (idx < store.playerIndex) {
    store.playerIndex--;
    dest = store.playerIndex + 1;
  }
  store.playerQueue.splice(dest, 0, item);
  import('./queue.js').then(m => m.renderQueue());
  getPlayerModule().then(m => m.saveQueueDebounced && m.saveQueueDebounced());
}

function _removeFromQueue(idx, fromPlaylist) {
  if (typeof idx !== 'number' || idx < 0 || idx >= store.playerQueue.length) return;
  const removed = store.playerQueue[idx];
  store.playerQueue.splice(idx, 1);
  if (idx < store.playerIndex) store.playerIndex--;
  else if (idx === store.playerIndex) {
    if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
    if (store.playerIndex >= 0) getPlayerModule().then(m => {
      // Hard cut: pause the active deck so crossfade/dj engines don't crossfade
      // out of the track that was just removed.
      try { const a = m.getAudio && m.getAudio(); if (a) a.pause(); } catch (e) {}
      m.loadAndPlay && m.loadAndPlay();
    });
  }
  import('./queue.js').then(m => m.renderQueue());
  getPlayerModule().then(m => m.saveQueueDebounced && m.saveQueueDebounced());
  // "Remove from playlist": also drop it from the backing Navidrome playlist
  // (mirrors the queue row's ✕ button when in playlist mode).
  if (fromPlaylist && store.playlistMode && removed) {
    import('./api.js').then(m => m.apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
      method: 'POST', body: { name: removed.name || '', artist: removed.artist || '', index: idx },
    })).catch(() => {});
  }
}

async function _fetchAlbumTracks(album) {
  // Pass the item's provider through: album ids are provider-scoped, and without
  // it the backend assumes the configured search provider — which is wrong for
  // Spotify-library cards and for results served by the search fallback.
  const qs = album.provider ? `?provider=${encodeURIComponent(album.provider)}` : '';
  const data = await apiJson(`/api/album/${encodeURIComponent(album.id || '')}/tracks${qs}`);
  return (data.tracks || []).map(t => ({ ...t, album: album.name, image: t.image || album.image }));
}

async function _addAlbumToQueue(album) {
  try {
    showToast('Loading album…');
    const tracks = await _fetchAlbumTracks(album);
    if (!tracks.length) { showToast('No tracks found'); return; }
    _addToQueue(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to load album');
  }
}

async function _playAlbumReplace(album) {
  try {
    showToast('Loading album…');
    const tracks = await _fetchAlbumTracks(album);
    if (!tracks.length) { showToast('No tracks found'); return; }
    const u = await import('./upnext.js');
    u.playTracks(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to load album');
  }
}

// Playlist equivalents of the album helpers above. Tracks come from the
// provider-aware endpoint in spotify.js (dynamic import: spotify.js imports this
// module, so a static import would be a cycle).
async function _fetchPlaylistTracks(playlist) {
  const sp = await import('./spotify.js');
  const data = await sp.fetchPlaylistTracks(playlist.id || '', playlist.url || '', playlist.provider);
  return (data.tracks || []).map(t => ({ ...t, type: 'track', image: t.image || playlist.image || '' }));
}

async function _addPlaylistToQueue(playlist) {
  try {
    showToast('Loading playlist…');
    const tracks = await _fetchPlaylistTracks(playlist);
    if (!tracks.length) { showToast('No tracks found'); return; }
    _addToQueue(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to load playlist');
  }
}

async function _playPlaylistReplace(playlist) {
  try {
    showToast('Loading playlist…');
    const tracks = await _fetchPlaylistTracks(playlist);
    if (!tracks.length) { showToast('No tracks found'); return; }
    const u = await import('./upnext.js');
    u.playTracks(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to load playlist');
  }
}

async function _addPlaylistToNavidromePlaylist(playlist) {
  try {
    showToast('Loading playlist…');
    const tracks = await _fetchPlaylistTracks(playlist);
    if (!tracks.length) { showToast('No tracks found'); return; }
    await addTracksToNavidromePlaylist(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to add playlist tracks');
  }
}

export async function _addToNavidromePlaylist(item) {
  try {
    const data = await apiJson('/api/library/playlists');
    // No early bail on an empty list — the picker's "+ New playlist" row is the
    // only way a user with zero playlists can create one from here.
    const playlists = data.playlists || [];
    const picked = await showPlaylistPicker(playlists);
    if (!picked || !picked.length) return;
    for (const pl of picked) {
      await apiJson(`/api/library/playlist/${pl.id}/add-and-download`, {
        method: 'POST',
        body: { name: item.name, artist: item.artist || '', album: item.album || '' },
      });
    }
    showToast(`Added to ${picked.map(p => p.name).join(', ')}`);
  } catch (e) {
    showToast(e.message || 'Failed to add to playlist');
  }
}

// Run the picker + batch add-and-download flow for a pre-loaded track list.
// Shared by the card context menu (album) and the album/playlist detail heroes.
export async function addTracksToNavidromePlaylist(tracks) {
  try {
    if (!tracks || !tracks.length) { showToast('No tracks found'); return; }
    const data = await apiJson('/api/library/playlists');
    // See _addToNavidromePlaylist: an empty list still opens the picker so the
    // "+ New playlist" row is reachable.
    const playlists = data.playlists || [];
    const picked = await showPlaylistPicker(playlists);
    if (!picked || !picked.length) return;
    const payload = tracks.map(t => ({ name: t.name, artist: t.artist || '', album: t.album || '' }));
    for (const pl of picked) {
      await apiJson(`/api/library/playlist/${pl.id}/add-and-download-batch`, {
        method: 'POST', body: { tracks: payload },
      });
    }
    showToast(`Added ${payload.length} tracks to ${picked.map(p => p.name).join(', ')}`);
  } catch (e) {
    showToast(e.message || 'Failed to add to playlist');
  }
}

async function _addAlbumToNavidromePlaylist(album) {
  try {
    showToast('Loading album…');
    const tracks = await _fetchAlbumTracks(album);
    if (!tracks.length) { showToast('No tracks found'); return; }
    await addTracksToNavidromePlaylist(tracks);
  } catch (e) {
    showToast(e.message || 'Failed to add album to playlist');
  }
}

function _searchFor(searchType, q) {
  const input = $('#searchInput');
  if (!input) return;
  input.value = q;
  store.searchType = searchType;
  document.querySelectorAll('.type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === searchType));
  // Navigate to search page
  import('./router.js').then(m => m.switchPage && m.switchPage('search'));
  import('./search.js').then(m => m.doSearch && m.doSearch());
}

function _openArtist(item) {
  if (item.id) {
    // Pass the item's provider: artist ids are provider-scoped, and the search
    // fallback can serve items from a provider other than the configured one.
    import('./spotify.js').then(m => m.loadArtistDetail && m.loadArtistDetail(item.id, 'search', item.provider));
  } else if (item.name) {
    _searchFor('artist', item.name);
  }
}

// ── Public navigation helpers (reused by the now-playing UI) ──
// Mirror the "Show artist" / "Show album" context-menu actions: navigate by
// id when available, otherwise fall back to a name search (same as the menu).
export function openArtistByName(name) {
  if (name) _searchFor('artist', name);
}
export function openAlbumByName(album) {
  if (album) _searchFor('album', album);
}

function _openItem(item, fromPage = 'search') {
  if (item.type === 'playlist' && item.id) {
    import('./spotify.js').then(m => m.loadPlaylistDetail && m.loadPlaylistDetail(item.id, item.url, fromPage,
      { provider: item.provider, name: item.name, image: item.image }));
  } else if (item.type === 'show' && item.id) {
    import('./spotify.js').then(m => m.loadShowDetail && m.loadShowDetail(item.id, item.url, fromPage, item.feed_url));
  } else {
    openModal(item);
  }
}

async function _playArtistRadio(item) {
  try {
    const params = new URLSearchParams({
      artist: item.name || item.artist || '',
      artist_id: item.id || '',
      limit: '25',
    });
    const data = await apiJson(`/api/radio?${params}`);
    const tracks = data.tracks || [];
    if (!tracks.length) { showToast('No radio tracks'); return; }
    store.radioMode = true;
    store.radioSeedTrack = tracks[0];
    _addToQueue(tracks);
  } catch (e) {
    showToast(e.message || 'Radio failed');
  }
}

function _copyInfo(item, withArtist = true) {
  const text = (withArtist && item.artist ? `${item.artist} - ${item.name || ''}` : (item.name || '')).trim();
  try {
    navigator.clipboard.writeText(text).then(() => showToast('Copied'));
  } catch {
    showToast('Copy failed');
  }
}

// ── Visible kebab (⋯) button ──
// Creates a discoverable button that opens the SAME context menu as
// right-click / long-press. `resolveInfo()` must return the same shape as an
// attachContextMenu getItem result: { item, type, context } or { title, actions }.
// The menu is anchored at the button's on-screen position.
export function makeKebabButton(resolveInfo, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'kebab-btn' + (opts.className ? ' ' + opts.className : '');
  btn.type = 'button';
  btn.title = 'More';
  btn.setAttribute('data-ctx-skip', '');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  // Prevent the row/card click (play / open) from firing.
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const info = resolveInfo();
    if (!info) return;
    const actions = info.actions || (info.item ? buildActionsFor(info.item, info.type || 'track', info.context || {}) : null);
    if (!actions || !actions.length) return;
    const title = info.title || (info.item && info.item.name) || '';
    const rect = btn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4, actions, { title });
  });
  return btn;
}

export function init() {
  // No global init needed — modules call attachContextMenu after rendering.
}
