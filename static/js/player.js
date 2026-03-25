// player.js — Audio playback, controls, media session, queue persistence

import { store } from './store.js';
import { $, $$, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { renderQueue } from './queue.js';
import { syncFullPlayer } from './fullplayer.js';

const audio = $('#audioElement');

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
  showToast(`Added ${items.length} track${items.length > 1 ? 's' : ''} to queue`);
  // Playlist mode: add tracks to Navidrome playlist in background
  if (store.playlistMode) {
    for (const item of items) {
      apiJson(`/api/library/playlist/${store.playlistMode.id}/add-and-download`, {
        method: 'POST',
        body: { name: item.name || '', artist: item.artist || '', album: item.album || '' },
      }).then(data => {
        if (data.status === 'downloading') {
          showToast(`Downloading & adding to ${store.playlistMode.name}...`);
        } else if (data.status === 'added') {
          showToast(`Added to ${store.playlistMode.name}`);
        }
      }).catch(() => {});
    }
  }
}

// ── Load and Play Current Track ──
export function loadAndPlay() {
  if (store.playerIndex < 0 || store.playerIndex >= store.playerQueue.length) return;
  // Stop any virtual rec playback — we're back in the real queue
  import('./recommendations.js').then(m => m.stopRecPlayback());
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
  // Cast mode: send to DLNA renderer instead of local audio
  if (store.castDevice) {
    apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: store.castDevice.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }}).catch(() => showToast('Cast failed'));
  } else {
    const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
    audio.src = `/api/player/stream?${params}`;
    audio.load();
    audio.play().catch(() => {});
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
  if (!badge) return;
  if (store.playlistMode) {
    badge.textContent = store.playlistMode.name;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

export function showPlayerBar() {
  $('#playerBar').classList.add('active');
  document.body.classList.add('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = '';
}

export function hidePlayerBar() {
  $('#playerBar').classList.remove('active');
  document.body.classList.remove('player-active');
  const npBtn = $('#bnavNowPlaying');
  if (npBtn) npBtn.style.display = 'none';
}

// ── Next / Prev ──
export function nextTrack() {
  // If playing a virtual rec track, advance to next rec
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
  const params = new URLSearchParams({ name: cleanName, artist: cleanArtist, token: store.authToken });
  audio.src = `/api/player/stream?${params}`;
  audio.load();
  audio.play().catch(() => {});
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
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
}

export function prevTrack() {
  if (store.castDevice) {
    // In cast mode, always go to previous track
    if (store.playerIndex > 0) {
      store.playerIndex--;
      loadAndPlay();
    }
    return;
  }
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
  } else if (store.playerIndex > 0) {
    store.playerIndex--;
    loadAndPlay();
  }
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
    await apiJson('/api/player/queue', {
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
        const params = new URLSearchParams({ name: item.name || '', artist: item.artist || '', token: store.authToken });
        audio.src = `/api/player/stream?${params}`;
        audio.preload = 'none';
        if (data.position_seconds > 0) {
          audio.addEventListener('loadedmetadata', () => { audio.currentTime = data.position_seconds; }, { once: true });
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
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
}

// ── Audio Element Reference (exported for other modules) ──
export { audio };

// ── Init ──
export function init() {
  // Audio events
  audio.addEventListener('play', () => updatePlayPauseIcon(true));
  audio.addEventListener('pause', () => updatePlayPauseIcon(false));
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
  });
  audio.addEventListener('error', () => {
    showToast('Stream error, skipping...');
    setTimeout(() => nextTrack(), 1000);
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
    if (store.castDevice) {
      apiJson('/api/dlna/volume', { method: 'POST', body: { volume: parseInt(e.target.value) } }).catch(() => {});
    } else {
      audio.volume = store.playerVolume;
    }
  });
  function _seekFromEvent(bar, e) {
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

  // Cast button (mini + full player)
  async function _handleCastClick() {
    if (store.castDevice) {
      // Already casting — stop and return to local
      await apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
      store.castDevice = null;
      clearInterval(store.castPollTimer);
      store.castPollTimer = null;
      _syncCastButtons('');
      showToast('Cast stopped');
      return;
    }
    try {
      const data = await apiJson('/api/dlna/devices');
      const devices = data.devices || [];
      if (!devices.length) { showToast('No DLNA devices found. Configure in Settings.'); return; }
      // Auto-pick if only one device, or use the configured one from settings
      if (devices.length === 1) {
        _castToDevice(devices[0]);
      } else {
        // Try to match saved dlna_renderer_url from settings
        const savedUrl = store.appSettings.dlna_renderer_url || '';
        const savedDevice = savedUrl ? devices.find(d => d.location === savedUrl) : null;
        if (savedDevice) {
          _castToDevice(savedDevice);
        } else {
          // Fallback: use first device
          _castToDevice(devices[0]);
        }
      }
    } catch (e) {
      showToast('Cast failed: ' + (e.message || ''));
    }
  }
  $('#playerCastBtn').addEventListener('click', _handleCastClick);
  if ($('#fpCastBtn')) $('#fpCastBtn').addEventListener('click', _handleCastClick);

  function _syncCastButtons(color) {
    ['#playerCastBtn', '#fpCastBtn'].forEach(sel => {
      const btn = $(sel);
      if (btn) btn.style.color = color;
    });
  }

  async function _castToDevice(device) {
    const item = store.playerQueue[store.playerIndex];
    if (!item) return;
    try {
      await apiJson('/api/dlna/cast', { method: 'POST', body: {
        device_id: device.id, name: item.name || '', artist: item.artist || '',
        album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
      }});
      store.castDevice = device;
      audio.pause();
      _syncCastButtons('var(--accent)');
      showToast(`Casting to ${device.name}`);
      _startCastPoll();
    } catch (e) {
      showToast('Cast failed: ' + (e.message || ''));
    }
  }

  let _castLastState = '';
  function _startCastPoll() {
    clearInterval(store.castPollTimer);
    _castLastState = '';
    store.castPollTimer = setInterval(async () => {
      if (!store.castDevice) { clearInterval(store.castPollTimer); return; }
      try {
        const status = await apiJson('/api/dlna/status');
        if (!status.active) { store.castDevice = null; _syncCastButtons(''); clearInterval(store.castPollTimer); return; }
        const dur = status.duration_seconds || 0;
        const pos = status.position_seconds || 0;
        if (dur > 0) {
          const pct = (pos / dur) * 100;
          $('#playerProgressFill').style.width = pct + '%';
          document.getElementById('playerBar').style.setProperty('--player-progress', pct + '%');
          const fpFill = $('#fpProgressFill');
          if (fpFill) fpFill.style.width = pct + '%';
        }
        $('#playerTimeCurrent').textContent = fmtTime(pos);
        $('#playerTimeTotal').textContent = fmtTime(dur);
        const fpCur = $('#fpTimeCurrent');
        if (fpCur) fpCur.textContent = fmtTime(pos);
        const fpTot = $('#fpTimeTotal');
        if (fpTot) fpTot.textContent = fmtTime(dur);
        // Detect track end: state changed from playing to stopped/no_media
        const state = (status.state || '').toLowerCase();
        if (_castLastState.includes('playing') && (state.includes('stopped') || state.includes('no_media'))) {
          // Auto-advance to next track
          nextTrack();
        }
        _castLastState = state;
      } catch {}
    }, 2000);
  }

  // Play button on cards (event delegation)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.card-play-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.card');
    if (!card) return;
    const item = JSON.parse(card.dataset.item);
    const tracks = await resolveItemTracks(item);
    if (tracks.length) { store.playerQueue = tracks; store.playerIndex = 0; loadAndPlay(); }
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
        break;
      case 'ArrowDown':
        e.preventDefault();
        store.playerVolume = Math.max(0, store.playerVolume - 0.05);
        $('#playerVolume').value = Math.round(store.playerVolume * 100);
        if ($('#fpVolume')) $('#fpVolume').value = Math.round(store.playerVolume * 100);
        if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: Math.round(store.playerVolume * 100) } }).catch(() => {});
        else audio.volume = store.playerVolume;
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
