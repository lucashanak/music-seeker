// player.js — Audio playback, controls, media session, queue persistence

import { store } from './store.js';
import { $, $$, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderQueue } from './queue.js';
import { syncFullPlayer, syncMuteUI } from './fullplayer.js';
import { getCachedUrl, waitForCache, prefetchUpcoming, cleanup as prefetchCleanup, pausePrefetch, resumePrefetch, streamQuality } from './prefetch.js';
import * as cast from './cast.js';

const audio = $('#audioElement');
function _ab() { return window.AndroidBridge || null; }
let _lastAbUpdate = 0;

// Android native media action callback (notification buttons → WebView)
window._androidMediaAction = function(action) {
  switch (action) {
    case 'play': audio.play().catch(() => {}); break;
    case 'pause': audio.pause(); break;
    case 'next': nextTrack(); break;
    case 'prev': prevTrack(); break;
  }
};

// Remote control: apply a command from a controlling device to LOCAL playback
// (this device is the target). Mirrors window._androidMediaAction above.
export function applyRemoteCommand(action, value) {
  const a = getAudio();
  switch (action) {
    case 'play':  a.play().catch(() => {}); updatePlayPauseIcon(true); break;
    case 'pause': a.pause(); updatePlayPauseIcon(false); break;
    case 'next':  nextTrack(); break;
    case 'prev':  prevTrack(); break;
    case 'seek':  try { a.currentTime = Number(value) || 0; } catch {} break;
    case 'volume': {
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      store.playerVolume = v;
      const el = document.getElementById('playerVolume'); if (el) el.value = Math.round(v * 100);
      const fp = document.getElementById('fpVolume'); if (fp) fp.value = Math.round(v * 100);
      // Classic engine applies volume directly to the single <audio> element.
      a.volume = v;
      break;
    }
    case 'enqueue': addToQueue(Array.isArray(value) ? value : [value], false); break;
    case 'transfer':
      // Play through the full engine path (loadAndPlay) — not a raw deck.play() —
      // so engine features (DJ smart-queue/auto-mix on v3) are armed for a transfer,
      // matching what `next`/`prev` already get. loadQueueState only restores the
      // queue+index from the server; loadAndPlay actually starts it.
      loadQueueState().then(() => { loadAndPlay(); });
      break;
  }
}

// Called by native side when bridge is injected (may be after playback started)
window._androidBridgeReady = function() {
  if (!audio.paused && _ab()) {
    const item = store.playerQueue[store.playerIndex];
    if (item) _ab().onPlay(item.name || '', item.artist || '');
  }
};

// ── Helper: get duration with Safari fallback ──
function _getDuration() {
  let dur = audio.duration;
  if (dur && isFinite(dur) && dur > 0) return dur;
  const item = store.playerQueue[store.playerIndex] || _currentRecItem;
  if (item && item.duration_ms > 0) return item.duration_ms / 1000;
  return null;
}

// ── Play Track ──
export function playTrack(item) {
  store.radioMode = false;
  store.playerQueue = [item];
  store.playerIndex = 0;
  loadAndPlay();
}

// ── Add to Queue ──
export function addToQueue(items, playNow = false) {
  const startIdx = store.playerQueue.length;
  store.playerQueue = store.playerQueue.concat(items);
  if (playNow || store.playerIndex < 0) {
    store.playerIndex = startIdx;
    loadAndPlay();
  }
  renderQueue();
  saveQueueDebounced();
  showToast(`Added ${items.length} track${items.length > 1 ? 's' : ''} to playlist`);
  // Playlist mode: add tracks to Navidrome playlist (one batch call)
  if (store.playlistMode) {
    apiJson(`/api/library/playlist/${store.playlistMode.id}/add-and-download-batch`, {
      method: 'POST',
      body: { tracks: items.map(it => ({ name: it.name || '', artist: it.artist || '', album: it.album || '' })) },
    }).then(data => {
      const parts = [];
      if (data.added) parts.push(`${data.added} added`);
      if (data.queued) parts.push(`${data.queued} downloading`);
      if (parts.length) showToast(`${parts.join(', ')} → ${store.playlistMode.name}`);
    }).catch(() => {});
  }
  if (store.remoteTarget && !playNow && store.playerIndex >= 0) {
    document.dispatchEvent(new CustomEvent('remote:enqueue', { detail: items }));
  }
}

// ── Load and Play Current Track ──
export async function loadAndPlay() {
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) return;
  if (store.remoteTarget) { try { getAudio().currentTime = 0; } catch {} document.dispatchEvent(new Event('remote:play')); return; }
  // Stop any virtual rec playback — we're back in the real queue
  import('./recommendations.js').then(m => m.stopRecPlayback());
  _currentRecItem = null; // clear stale rec so "Add to playlist" targets the queue track
  const item = store.playerQueue[store.playerIndex];
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  const mode = store.deviceOutputMode || 'default';
  // DLNA Only mode: auto-connect to renderer on play
  if (mode === 'dlna_only' && !store.castDevice) {
    cast.autoCastAndPlay(item, cleanName, cleanArtist);
  // Cast mode: send to DLNA renderer (unless local-only)
  } else if (store.castDevice && mode !== 'local') {
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    const castBody = {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    };
    apiJson('/api/dlna/cast', { method: 'POST', body: castBody })
      .then(() => { /* cast started */ })
      .catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    let cached = getCachedUrl(cleanName, cleanArtist);
    // If prefetch is downloading this track, wait for it (avoids competing parallel stream)
    if (!cached && localStorage.getItem('ms_prefetch_enabled') !== '0') {
      const waited = await waitForCache(cleanName, cleanArtist, 2000);
      if (waited) cached = waited;
    }
    if (cached) {
      audio.src = cached;
    } else {
      const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) });
      audio.src = `/api/player/stream?${params}&quality=${streamQuality()}`;
    }
    audio.load();
    audio.play().catch(() => {});
    // Prefetch cleanup + starts on 'playing' event (if enabled)
    if (localStorage.getItem('ms_prefetch_enabled') !== '0') {
      prefetchCleanup(store.playerQueue, store.playerIndex);
    }
  }
  showPlayerBar();
  updatePlayPauseIcon(true);
  syncFullPlayer();
  updateDownloadButtons(item);
  renderQueue();
  saveQueueDebounced();
  updateMediaSession();
  resolveSource(item);
  updatePlaylistBadge();
}

function _decodeEntities(s) {
  if (!s || !s.includes('&')) return s;
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

function resolveSource(item) {
  const badge = $('#playerSourceBadge');
  const fpBadge = $('#fpSourceBadge');
  if (badge) { badge.textContent = ''; badge.className = 'source-badge'; }
  if (fpBadge) { fpBadge.textContent = ''; fpBadge.className = 'source-badge'; }
  const params = new URLSearchParams({ name: _decodeEntities(item.name || ''), artist: _decodeEntities(item.artist || '') });
  apiJson(`/api/player/resolve-source?${params}`).then(data => {
    const src = data.source || 'youtube';
    const labels = { local: 'LOCAL', navidrome: 'FLAC', youtube: 'YT' };
    const label = labels[src] || src.toUpperCase();
    if (badge) { badge.textContent = label; badge.className = `source-badge source-${src}`; }
    if (fpBadge) { fpBadge.textContent = label; fpBadge.className = `source-badge source-${src}`; }
  }).catch(() => {});
}

function updateDownloadButtons(item) {
  const inLib = !!item.inLibrary;
  const miniBtn = $('#playerDownloadBtn');
  const fpBtn = $('#fpDownload');
  if (miniBtn) {
    miniBtn.disabled = inLib;
    miniBtn.style.opacity = inLib ? '0.3' : '';
    miniBtn.title = inLib ? 'Already in library' : 'Download current track';
  }
  if (fpBtn) {
    fpBtn.disabled = inLib;
    fpBtn.style.opacity = inLib ? '0.3' : '';
    fpBtn.title = inLib ? 'Already in library' : 'Download';
  }
}

export function updatePlaylistBadge() {
  const badge = $('#fpPlaylistBadge');
  if (badge) {
    if (store.playlistMode) { badge.textContent = store.playlistMode.name; badge.style.display = ''; }
    else badge.style.display = 'none';
  }
  const show = store.playlistMode ? '' : 'none';
  const rm1 = $('#playerRemoveFromPlaylist');
  const rm2 = $('#fpRemoveFromPlaylist');
  if (rm1) rm1.style.display = show;
  if (rm2) rm2.style.display = show;
}

export function showPlayerBar() {
  $('#playerBar').classList.add('active');
  document.body.classList.add('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = '';
  // Hide cast button in local-only mode
  const mode = store.deviceOutputMode || 'default';
  const castBtn = $('#playerCastBtn');
  const fpCastBtn = $('#fpCastBtn');
  if (mode === 'local') {
    if (castBtn) castBtn.style.display = 'none';
    if (fpCastBtn) fpCastBtn.style.display = 'none';
  } else {
    if (castBtn) castBtn.style.display = '';
    if (fpCastBtn) fpCastBtn.style.display = '';
  }
}

export function hidePlayerBar() {
  $('#playerBar').classList.remove('active');
  document.body.classList.remove('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = 'none';
  // Stop Android foreground service when player is hidden
  if (_ab()) _ab().onStop();
}

// ── Next / Prev ──
let _lastNextTime = 0;
export function nextTrack() {
  // Throttle rapid advances (error/ended chain-skips) — matches crossfade/dj engines
  const now = Date.now();
  if (now - _lastNextTime < 500) return;
  _lastNextTime = now;
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, advance to next rec (both local and cast)
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      m.playNextRec().then(filled => {
        if (!filled) { audio.pause(); updatePlayPauseIcon(false); }
      });
      return;
    }
    _nextTrackInQueue();
  });
}

function _nextTrackInQueue() {
  if (store.shuffleEnabled && store.playerQueue.length > 1) {
    let next;
    do { next = Math.floor(Math.random() * store.playerQueue.length); } while (next === store.playerIndex);
    store.playerIndex = next;
    loadAndPlay();
  } else if (store.playerIndex < store.playerQueue.length - 1) {
    store.playerIndex++;
    loadAndPlay();
  } else if (store.repeatMode === 'all') {
    store.playerIndex = 0;
    loadAndPlay();
  } else if (store.radioMode && !store.radioLoading) {
    // Auto-fill queue with more radio tracks
    store.radioLoading = true;
    const seed = store.playerQueue[store.playerQueue.length - 1] || store.radioSeedTrack;
    if (seed) {
      showToast('Loading more similar tracks...');
      const params = new URLSearchParams({ track: seed.name || '', artist: seed.artist || '', artist_id: seed.id || store.currentArtistId || '' });
      apiJson(`/api/radio?${params}`).then(data => {
        const newTracks = (data.tracks || []).filter(t => {
          const key = (t.name || '').toLowerCase() + '|' + (t.artist || '').toLowerCase();
          return !store.playerQueue.some(q => (q.name || '').toLowerCase() + '|' + (q.artist || '').toLowerCase() === key);
        });
        if (newTracks.length) {
          store.playerQueue = store.playerQueue.concat(newTracks);
          store.playerIndex++;
          loadAndPlay();
          renderQueue();
          saveQueueDebounced();
          import('./upnext.js').then(u => u.mirrorAdd(newTracks));
        } else {
          showToast('No more similar tracks found');
          audio.pause();
          updatePlayPauseIcon(false);
        }
      }).catch(() => {
        showToast('Failed to load more tracks');
        audio.pause();
        updatePlayPauseIcon(false);
      }).finally(() => { store.radioLoading = false; });
    }
  } else {
    // Queue ended — continue with virtual recommendations
    import('./recommendations.js').then(m => {
      m.playNextRec().then(filled => {
        if (!filled) {
          audio.pause();
          updatePlayPauseIcon(false);
        }
      });
    });
  }
}

// ── Play a track from recommendations (virtual, not in queue) ──
let _currentRecItem = null;
export function playRecTrack(item) {
  if (store.remoteTarget) {
    store.playerQueue = store.playerQueue.concat([item]);
    store.playerIndex = store.playerQueue.length - 1;
    try { getAudio().currentTime = 0; } catch {}
    document.dispatchEvent(new Event('remote:play'));
    return;
  }
  _currentRecItem = item;
  $('#playerImg').src = item.image || '';
  $('#playerTitle').textContent = item.name || '';
  $('#playerArtist').textContent = item.artist || '';
  $('#playerProgressFill').style.width = '0%';
  $('#playerTimeCurrent').textContent = '0:00';
  $('#playerTimeTotal').textContent = '0:00';
  document.getElementById('playerBar').style.setProperty('--player-progress', '0%');
  const fpFill = $('#fpProgressFill');
  if (fpFill) fpFill.style.width = '0%';
  const fpCur = $('#fpTimeCurrent');
  if (fpCur) fpCur.textContent = '0:00';
  const fpTot = $('#fpTimeTotal');
  if (fpTot) fpTot.textContent = '0:00';
  const cleanName = _decodeEntities(item.name || '');
  const cleanArtist = _decodeEntities(item.artist || '');
  // Cast mode: send to DLNA renderer
  if (store.castDevice) {
    cast.castState.skipAutoAdvance = true;
    cast.castState.transitioning = true;
    apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }}).catch(e => { showToast('Cast failed: ' + (e.message || '')); cast.castState.transitioning = false; cast.castState.skipAutoAdvance = false; });
  } else {
    const cached = getCachedUrl(cleanName, cleanArtist);
    if (cached) {
      audio.src = cached;
    } else {
      const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: (store.streamToken || store.authToken) });
      audio.src = `/api/player/stream?${params}&quality=${streamQuality()}`;
    }
    audio.load();
    audio.play().catch(() => {});
  }
  showPlayerBar();
  updatePlayPauseIcon(true);
  // Sync full player directly
  const fpImg = $('#fpImg');
  if (fpImg) fpImg.src = item.image || '';
  const fpTitle = $('#fpTitle');
  if (fpTitle) fpTitle.textContent = item.name || '';
  const fpArtist = $('#fpArtist');
  if (fpArtist) fpArtist.textContent = item.artist || '';
  updateDownloadButtons(item);
  updateMediaSessionWith(item);
  resolveSource(item);
}

function updateMediaSessionWith(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } audio.play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } audio.pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

export function prevTrack() {
  if (store.castDevice) {
    cast.markCastTransition();
  }
  // If playing a virtual rec track, go to previous rec or back to queue
  import('./recommendations.js').then(m => {
    if (m.isPlayingRec()) {
      const went = m.playPrevRec();
      if (!went) {
        // Back to last track in queue
        if (store.playerIndex >= 0) loadAndPlay();
      }
      return;
    }
    // Normal queue navigation
    if (!store.castDevice && audio.currentTime > 3) {
      audio.currentTime = 0;
    } else if (store.playerIndex > 0) {
      store.playerIndex--;
      loadAndPlay();
    }
  });
}

// ── Play/Pause Icon ──
export function updatePlayPauseIcon(playing) {
  store.playerPlaying = playing;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  $('#playPauseIcon').innerHTML = playing ? pausePath : playPath;
  const fpIcon = $('#fpPlayPauseIcon');
  if (fpIcon) fpIcon.innerHTML = playing ? pausePath : playPath;
}

// ── Resolve Item Tracks (album/artist → track list) ──
export async function resolveItemTracks(item) {
  const type = item.type || 'track';
  if (type === 'album' && item.id) {
    const data = await apiJson(`/api/album/${item.id}/tracks`);
    return (data.tracks || []).map(t => ({ ...t, type: 'track' }));
  }
  if (type === 'artist' && item.id) {
    const data = await apiJson(`/api/artist/${item.id}/albums`);
    const albums = data.albums || [];
    const allTracks = [];
    for (const album of albums.slice(0, 10)) {
      try {
        const ad = await apiJson(`/api/album/${album.id}/tracks`);
        (ad.tracks || []).forEach(t => allTracks.push({ ...t, type: 'track' }));
      } catch {}
    }
    return allTracks;
  }
  return [item];
}

// ── Queue Persistence ──
export function saveQueueDebounced() {
  clearTimeout(store.playerSaveTimer);
  store.playerSaveTimer = setTimeout(saveQueueNow, 2000);
  // Trigger recommendations refresh
  import('./recommendations.js').then(m => m.onQueueChanged());
}

async function saveQueueNow() {
  if (!store.currentUser) return;
  try {
    return await apiJson('/api/player/queue', {
      method: 'PUT',
      body: {
        queue: store.playerQueue,
        current_index: store.playerIndex,
        position_seconds: audio.currentTime || 0,
        volume: store.playerVolume,
        playlist_mode: store.playlistMode,
      },
    });
  } catch {}
}

// Synchronous (awaitable) flush of the pending queue save — cancels the debounce
// timer and performs the PUT immediately. Used before engine-switch reloads so
// recent queue/position changes are persisted to the server before unload.
export async function flushQueue() {
  clearTimeout(store.playerSaveTimer);
  return saveQueueNow();
}

export async function loadQueueState() {
  try {
    const data = await apiJson('/api/player/queue');
    if (data.queue && data.queue.length) {
      store.playerQueue = data.queue;
      store.playerIndex = data.current_index >= 0 ? data.current_index : 0;
      store.playerVolume = data.volume ?? 1.0;
      audio.volume = store.playerVolume;
      $('#playerVolume').value = Math.round(store.playerVolume * 100);
      const item = store.playerQueue[store.playerIndex];
      if (item) {
        $('#playerImg').src = item.image || '';
        $('#playerTitle').textContent = item.name || '';
        $('#playerArtist').textContent = item.artist || '';
        // Pre-set audio source so play button works immediately
        const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: (store.streamToken || store.authToken) });
        audio.src = `/api/player/stream?${params}&quality=${streamQuality()}`;
        audio.preload = 'none';
        if (data.position_seconds > 0) {
          const restoreSrc = audio.src;
          audio.addEventListener('loadedmetadata', () => {
            // Only seek if still the restored track — the user may have switched tracks
            // before this one-shot metadata load fired.
            if (audio.src === restoreSrc) audio.currentTime = data.position_seconds;
          }, { once: true });
        }
        syncFullPlayer();
        updateDownloadButtons(item);
        showPlayerBar();
      }
      // Restore playlist mode
      if (data.playlist_mode) {
        store.playlistMode = data.playlist_mode;
        updatePlaylistBadge();
      }
      import('./queue.js').then(m => m.updateSaveButton());
    }
  } catch {}
}

// ── Media Session API ──
function updateMediaSession() {
  if (!('mediaSession' in navigator) || store.playerIndex < 0) return;
  const item = store.playerQueue[store.playerIndex];
  if (!item) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.name || '', artist: item.artist || '', album: item.album || '',
    artwork: item.image ? [{ src: item.image, sizes: '300x300', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'play' } })); return; } audio.play(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'pause' } })); return; } audio.pause(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'prev' } })); return; } prevTrack(); });
  navigator.mediaSession.setActionHandler('nexttrack', () => { if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'next' } })); return; } nextTrack(); });
}

// ── Audio Element Reference (exported for other modules) ──
export { audio };
export function getAudio() { return audio; }

// Fully stop local playback (used when handing off / controlling a remote device,
// so the source device doesn't keep playing alongside the target).
export function pauseLocal() { try { audio.pause(); } catch {} updatePlayPauseIcon(false); }

// ── Init ──
export function init() {
  // Audio events
  audio.addEventListener('play', () => {
    updatePlayPauseIcon(true);
    if (_ab()) {
      const item = store.playerQueue[store.playerIndex];
      if (item) _ab().onPlay(item.name || '', item.artist || '');
    }
  });
  // 'playing' fires after buffering — start prefetch if enabled
  audio.addEventListener('playing', () => {
    if (localStorage.getItem('ms_prefetch_enabled') !== '0') resumePrefetch();
  });
  audio.addEventListener('pause', () => {
    updatePlayPauseIcon(false);
    pausePrefetch();
    if (_ab()) _ab().onPause();
  });
  audio.addEventListener('ended', () => {
    if (store.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      nextTrack();
    }
  });
  audio.addEventListener('timeupdate', () => {
    const dur = _getDuration();
    if (!dur) return;
    const pct = (audio.currentTime / dur) * 100;
    $('#playerProgressFill').style.width = pct + '%';
    $('#playerTimeCurrent').textContent = fmtTime(audio.currentTime);
    $('#playerTimeTotal').textContent = fmtTime(dur);
    // Sync mini bar top progress line
    document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
    // Sync full player
    const fpFill = $('#fpProgressFill');
    if (fpFill) fpFill.style.width = pct + '%';
    const fpCur = $('#fpTimeCurrent');
    if (fpCur) fpCur.textContent = fmtTime(audio.currentTime);
    const fpTot = $('#fpTimeTotal');
    if (fpTot) fpTot.textContent = fmtTime(dur);
    // Update Android notification progress (throttled to ~1/sec)
    if (_ab() && Math.abs(audio.currentTime - (_lastAbUpdate || 0)) >= 1) {
      _lastAbUpdate = audio.currentTime;
      _ab().onProgress(Math.floor(audio.currentTime * 1000), Math.floor(dur * 1000));
    }
  });
  audio.addEventListener('error', (e) => {
    if (!audio.src) return; // ignore error from cleared src
    const code = audio.error?.code || '?';
    const msg = audio.error?.message || '';
    const src = audio.src?.substring(0, 60) || 'none';
    showToast(`Stream error (${code}): ${msg || src}`);
    // Don't chain-skip — wait 2s
    setTimeout(() => nextTrack(), 2000);
  });

  // Controls
  $('#playerPlayPause').addEventListener('click', () => {
    if (store.castDevice) {
      if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
      else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
    } else {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    }
  });
  $('#playerNext').addEventListener('click', nextTrack);
  $('#playerPrev').addEventListener('click', prevTrack);
  $('#playerVolume').addEventListener('input', (e) => {
    store.playerVolume = e.target.value / 100;
    if ($('#fpVolume')) $('#fpVolume').value = e.target.value;
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      audio.volume = store.playerVolume;
    }
    syncMuteUI();
  });
  async function _seekFromEvent(bar, e) {
    const dur = _getDuration();
    if (!dur) return;
    const rect = bar.getBoundingClientRect();
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    if (store.castDevice) {
      apiJson('/api/dlna/seek', { method: 'POST', body: { position_seconds: pct * dur } }).catch(() => {});
    } else {
      try { audio.currentTime = pct * dur; } catch {}
    }
  }
  const miniBar = $('#playerProgressBar');
  miniBar.addEventListener('click', (e) => _seekFromEvent(miniBar, e));
  miniBar.addEventListener('touchstart', (e) => { e.preventDefault(); _seekFromEvent(miniBar, e); }, { passive: false });

  // Add to playlist
  async function _addToPlaylist() {
    const item = (typeof _currentRecItem !== 'undefined' && _currentRecItem)
      ? _currentRecItem
      : (store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null);
    if (!item) return;
    try {
      const data = await apiJson('/api/library/playlists');
      const playlists = data.playlists || [];
      if (!playlists.length) { showToast('No playlists. Create one in Library first.'); return; }
      const { showPlaylistPicker } = await import('./utils.js');
      const picked = await showPlaylistPicker(playlists, { multi: false });
      if (!picked) return;
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${picked.id}/add-and-download`, {
        method: 'POST',
        body: { name: cleanName, artist: cleanArtist, album: item.album || '' },
      });
      showToast(`Added to ${picked.name}`);
      if (store.playlistMode && store.playlistMode.id === picked.id) {
        const key = (cleanName + '|' + cleanArtist).toLowerCase();
        const exists = store.playerQueue.some(t =>
          (_decodeEntities(t.name || '').toLowerCase() + '|' + _decodeEntities(t.artist || '').toLowerCase()) === key);
        if (!exists) {
          store.playerQueue.push({ ...item, name: cleanName, artist: cleanArtist });
          renderQueue();
          saveQueueDebounced();
        }
      }
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerAddToPlaylist').addEventListener('click', _addToPlaylist);
  if ($('#fpAddToPlaylist')) $('#fpAddToPlaylist').addEventListener('click', _addToPlaylist);

  async function _removeFromPlaylist() {
    const idx = store.playerIndex;
    const item = idx >= 0 ? store.playerQueue[idx] : null;
    if (!item || !store.playlistMode) return;
    try {
      const cleanName = _decodeEntities(item.name || '');
      const cleanArtist = _decodeEntities(item.artist || '');
      await apiJson(`/api/library/playlist/${store.playlistMode.id}/remove-by-name`, {
        method: 'POST', body: { name: cleanName, artist: cleanArtist, index: idx },
      });
      showToast(`Removed from ${store.playlistMode.name}`);
      // Mirror the backend removal in the local queue / now-playing UI.
      if (idx >= 0 && idx < store.playerQueue.length) {
        const wasCurrent = (idx === store.playerIndex);
        store.playerQueue.splice(idx, 1);
        if (idx < store.playerIndex) store.playerIndex--;
        else if (wasCurrent) {
          if (store.playerIndex >= store.playerQueue.length) store.playerIndex = store.playerQueue.length - 1;
          if (store.playerIndex >= 0) {
            try { if (audio) audio.pause(); } catch (e) {}
            loadAndPlay();
          } else {
            // Queue emptied: stop the track that was just removed.
            try { if (audio) audio.pause(); } catch (e) {}
          }
        }
        renderQueue();
        saveQueueDebounced();
      }
    } catch (e) { showToast('Failed: ' + (e.message || '')); }
  }
  $('#playerRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);
  if ($('#fpRemoveFromPlaylist')) $('#fpRemoveFromPlaylist').addEventListener('click', _removeFromPlaylist);

  // Download current track
  $('#playerDownloadBtn').addEventListener('click', async () => {
    const item = store.playerIndex >= 0 ? store.playerQueue[store.playerIndex] : null;
    if (!item) return;
    const btn = $('#playerDownloadBtn');
    btn.style.color = 'var(--accent)';
    try {
      await apiJson('/api/download', { method: 'POST', body: {
        url: item.url || '', title: `${item.artist || ''} - ${item.name || ''}`,
        method: store.appSettings.default_method || 'yt-dlp', format: store.appSettings.default_format || 'flac',
        type: item.type || 'track',
      }});
      showToast('Download started');
    } catch (e) { showToast('Download failed: ' + e.message); }
    finally { setTimeout(() => { btn.style.color = ''; }, 1000); }
  });

  // ── Cast (DLNA) — shared module (cast.js) ──
  cast.initCast({ getAudioEl: getAudio, nextTrack });
  cast.wireControls();

  // Play button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-play-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    const tracks = await resolveItemTracks(item);
    if (tracks.length) {
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    }
  });

  // Download button on cards (event delegation)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-dl-btn');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    // Artist detail album cards use data-album-idx
    if (card.dataset.albumIdx !== undefined) return; // handled locally
    const item = JSON.parse(card.dataset.item);
    openModal(item);
    if (!item.inLibrary) setTimeout(() => $('#modalDownload').click(), 100);
  });

  // Keyboard controls (when not in input)
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (!store.playerQueue.length && !audio.src) return;
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (store.remoteTarget) { document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'toggle' } })); return; }
        if (store.castDevice) {
          if (store.playerPlaying) apiJson('/api/dlna/pause', { method: 'POST' }).then(() => updatePlayPauseIcon(false)).catch(() => {});
          else apiJson('/api/dlna/play', { method: 'POST' }).then(() => updatePlayPauseIcon(true)).catch(() => {});
        } else {
          if (audio.paused) audio.play().catch(() => {}); else audio.pause();
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        nextTrack();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        prevTrack();
        break;
      case 'ArrowUp':
        e.preventDefault();
        store.playerVolume = Math.min(1, store.playerVolume + 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else audio.volume = store.playerVolume;
        syncMuteUI();
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else audio.volume = store.playerVolume;
        syncMuteUI();
        break;
    }
  });

  // Periodic save while playing
  setInterval(() => { if (store.playerPlaying && store.currentUser) saveQueueNow(); }, 30000);

  // Save on page unload (sync XHR since sendBeacon can't set auth headers)
  window.addEventListener('beforeunload', () => {
    if (store.playerQueue.length && store.currentUser) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/player/queue', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        const token = store.authToken;
        if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        xhr.send(JSON.stringify({
          queue: store.playerQueue, current_index: store.playerIndex,
          position_seconds: audio.currentTime || 0, volume: store.playerVolume,
          playlist_mode: store.playlistMode,
        }));
      } catch {}
    }
  });

  // ── Swipe up on mini player to open full player ──
  const playerBar = document.getElementById('playerBar');
  if (playerBar) {
    let sy = 0, tracking = false;
    playerBar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sy = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    playerBar.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const dy = sy - e.touches[0].clientY;
      if (dy > 40) {
        tracking = false;
        import('./fullplayer.js').then(m => m.openFullPlayer());
      }
    }, { passive: true });
    playerBar.addEventListener('touchend', () => { tracking = false; }, { passive: true });
    playerBar.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
  }
}
