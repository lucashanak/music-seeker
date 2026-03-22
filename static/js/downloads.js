// downloads.js — Download modal (openModal/closeModal), downloads panel (openPanel/closePanel), refreshJobs, job management

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack } from './utils.js';
import { apiFetch, apiJson } from './api.js';

// ── Download Modal ──
export function openModal(item) {
  history.pushState({ layer: 'modal' }, '');
  store.modalItem = item;
  $('#modalImg').src = item.image || '';
  $('#modalTitle').textContent = item.name;
  const artistEl = $('#modalArtist');
  const artist = item.artist || '';
  const album = item.album || '';
  const type = item.type || 'track';
  if (type === 'track' && artist) {
    let html = `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
    if (album) html += ` · <span class="clickable" data-search-type="album" data-search-q="${esc(album)}">${esc(album)}</span>`;
    artistEl.innerHTML = html;
  } else if ((type === 'album' || type === 'episode') && artist) {
    artistEl.innerHTML = `<span class="clickable" data-search-type="artist" data-search-q="${esc(artist)}">${esc(artist)}</span>`;
  } else {
    artistEl.textContent = artist;
  }
  const allowedMethods = store.currentUser?.allowed_methods || ['yt-dlp', 'slskd', 'lidarr'];
  const allowedFormats = store.currentUser?.allowed_formats || ['mp3', 'flac'];
  const defMethod = store.appSettings.default_method || 'yt-dlp';
  const defFormat = store.appSettings.default_format || 'flac';
  const isPodcast = item.type === 'episode' || item.type === 'show';
  if (isPodcast) {
    store.selectedMethod = 'yt-dlp';
    store.selectedFormat = 'mp3';
  } else {
    store.selectedMethod = allowedMethods.includes(defMethod) ? defMethod : allowedMethods[0];
    store.selectedFormat = allowedFormats.includes(defFormat) ? defFormat : allowedFormats[0];
  }
  updateOptionGroups();
  // Hide method/format for podcasts (always yt-dlp + mp3)
  $$('.modal-section', $('#downloadModal')).forEach((s, i) => { if (i < 2) s.style.display = isPodcast ? 'none' : ''; });
  $('#modalLibraryNotice').style.display = item.inLibrary ? '' : 'none';
  const dlBtn = $('#modalDownload');
  dlBtn.disabled = false;
  dlBtn.textContent = 'Download';
  $('#downloadModal').classList.add('open');

  // Update radio/favorite buttons visibility
  const isRadioable = type === 'track' || type === 'album' || type === 'artist';
  $('#modalRadio').style.display = isRadioable ? '' : 'none';
  const isFavable = type === 'artist' || (type === 'album' && item.id) || type === 'track';
  $('#modalFavToggle').style.display = isFavable ? '' : 'none';
  // Show follow state for artists
  const isFollowed = type === 'artist' && item.id && store.favoritedArtistIds.has(item.id);
  if (isFollowed) {
    $('#modalFavToggle').innerHTML = '&#x2665; Unfollow';
    $('#modalFavToggle').style.color = '#ef4444';
  } else if (type === 'artist') {
    $('#modalFavToggle').innerHTML = '&#x2661; Follow';
    $('#modalFavToggle').style.color = '';
  } else {
    $('#modalFavToggle').style.display = 'none';
  }
  // Auto-download toggle (only for followed artists)
  const adLabel = $('#modalAutoDownload');
  const adCb = $('#modalAutoDownloadCb');
  if (isFollowed || item._isFavorite) {
    adLabel.style.display = '';
    adCb.checked = !!item._autoDownload;
    adCb.onchange = async () => {
      try {
        await apiJson(`/api/favorites/${item.id}`, { method: 'PUT', body: { auto_download: adCb.checked } });
        showToast(adCb.checked ? 'Auto-download enabled' : 'Auto-download disabled');
      } catch (e) {
        adCb.checked = !adCb.checked;
        showToast('Failed: ' + e.message);
      }
    };
  } else {
    adLabel.style.display = 'none';
  }

  // Last.fm items have no Spotify URL — resolve it (skip for playlists/podcasts)
  if (!item.url && item.type !== 'playlist' && !isPodcast) {
    dlBtn.disabled = true;
    dlBtn.textContent = 'Resolving...';
    apiJson('/api/discover/resolve', {
      method: 'POST',
      body: { name: item.name, artist: item.artist || '', type: item.type || 'track' },
    }).then(resolved => {
      if (!store.modalItem || store.modalItem.name !== item.name) return;
      store.modalItem.url = resolved.url;
      store.modalItem.id = resolved.id;
      if (resolved.image) $('#modalImg').src = resolved.image;
      dlBtn.disabled = false;
      dlBtn.textContent = 'Download';
    }).catch(() => {
      if (!store.modalItem || store.modalItem.name !== item.name) return;
      dlBtn.textContent = 'Not found on Spotify';
    });
  }
}

export function closeModal(fromPopstate) {
  if (!store.modalItem) return;
  $('#downloadModal').classList.remove('open');
  store.modalItem = null;
  if (!fromPopstate) historyBack();
}

function updateOptionGroups() {
  const allowedMethods = store.currentUser?.allowed_methods || ['yt-dlp', 'slskd', 'lidarr'];
  const allowedFormats = store.currentUser?.allowed_formats || ['mp3', 'flac'];
  $$('#methodGroup .option-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.value === store.selectedMethod);
    b.style.display = allowedMethods.includes(b.dataset.value) ? '' : 'none';
  });
  $$('#formatGroup .option-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.value === store.selectedFormat);
    b.style.display = allowedFormats.includes(b.dataset.value) ? '' : 'none';
  });
  $('#formatSection').style.display = store.selectedMethod === 'yt-dlp' ? '' : 'none';
}

// ── Downloads Panel ──
export function openPanel() {
  store.panelOpen = true;
  $('#downloadsPanel').classList.add('open');
  history.pushState({ layer: 'panel' }, '');
}

export function closePanel(fromPopstate) {
  if (!store.panelOpen) return;
  store.panelOpen = false;
  $('#downloadsPanel').classList.remove('open');
  if (!fromPopstate) historyBack();
}

// ── Jobs ──
export async function refreshJobs() {
  if (!store.authToken) {
    if (store.jobsInterval) { clearInterval(store.jobsInterval); store.jobsInterval = null; }
    return;
  }
  try {
    const data = await apiJson('/api/jobs');
    const jobs = data.jobs || [];
    checkJobCompletions(jobs);
    const active = jobs.filter(j => j.status === 'running' || j.status === 'queued').length;
    $('#jobsBadge').textContent = active || '';
    const mobileBadge = $('#jobsBadgeMobile');
    if (mobileBadge) mobileBadge.textContent = active || '';
    if (!jobs.length) { $('#jobsList').innerHTML = '<div class="empty-state"><p>No downloads yet</p></div>'; return; }
    $('#jobsList').innerHTML = jobs.map(j => `
      <div class="job-item">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="job-title" style="flex:1; min-width:0;">${esc(j.title)}</div>
          <span class="job-status ${j.status}">${j.status}</span>
        </div>
        <div class="job-meta">
          <span>${j.method} / ${j.format}</span>
          ${(j.status === 'running' || j.status === 'queued') ? `<button class="job-cancel" data-job-id="${j.id}">Cancel</button>` : ''}
          ${(j.status === 'failed' || j.status === 'cancelled') ? `<button class="job-retry" data-job-id="${j.id}">Retry</button>` : ''}
        </div>
        ${(j.status === 'running' || j.status === 'queued') ? `<div class="job-progress-bar"><div class="job-progress-fill" style="width:${j.progress}%"></div></div>` : ''}
        ${j.progress_text ? `<div class="job-progress-text">${esc(j.progress_text)}</div>` : ''}
        ${j.error ? `<div class="job-progress-text" style="color:var(--red)">${esc(j.error)}</div>` : ''}
      </div>
    `).join('');
    // Attach cancel/retry handlers
    $$('.job-cancel', $('#jobsList')).forEach(btn => {
      btn.addEventListener('click', () => cancelJob(btn.dataset.jobId));
    });
    $$('.job-retry', $('#jobsList')).forEach(btn => {
      btn.addEventListener('click', () => retryJob(btn.dataset.jobId));
    });
  } catch {}
}

async function cancelJob(id) {
  try { await apiFetch(`/api/jobs/${id}`, { method: 'DELETE' }); } catch {}
  refreshJobs();
}

async function retryJob(id) {
  try {
    await apiJson(`/api/jobs/${id}/retry`, { method: 'POST' });
    refreshJobs();
  } catch (e) { alert('Retry failed: ' + e.message); }
}

// ── Browser Notifications for Job Completions ──
function checkJobCompletions(jobs) {
  if (!store.notificationsEnabled) return;
  for (const j of jobs) {
    const prev = store.previousJobStates[j.id];
    if (prev && (prev === 'running' || prev === 'queued')) {
      if (j.status === 'done') {
        new Notification('MusicSeeker - Download Complete', {
          body: j.title,
          icon: '/static/icon.png',
          tag: 'ms-' + j.id,
        });
      } else if (j.status === 'failed') {
        new Notification('MusicSeeker - Download Failed', {
          body: j.title + (j.error ? ': ' + j.error : ''),
          icon: '/static/icon.png',
          tag: 'ms-' + j.id,
        });
      }
    }
    store.previousJobStates[j.id] = j.status;
  }
}

// ── Init ──
export function init() {
  $('#modalClose').addEventListener('click', closeModal);
  $('#downloadModal').addEventListener('click', e => { if (e.target === $('#downloadModal')) closeModal(); });

  $$('#methodGroup .option-btn').forEach(btn => {
    btn.addEventListener('click', () => { store.selectedMethod = btn.dataset.value; updateOptionGroups(); });
  });
  $$('#formatGroup .option-btn').forEach(btn => {
    btn.addEventListener('click', () => { store.selectedFormat = btn.dataset.value; updateOptionGroups(); });
  });

  $('#modalDownload').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const btn = $('#modalDownload');
    btn.disabled = true; btn.textContent = 'Starting...';
    try {
      const dlBody = { url: store.modalItem.url, title: `${store.modalItem.artist} - ${store.modalItem.name}`, method: store.selectedMethod, format: store.selectedFormat, type: store.modalItem.type || 'track' };
      if (store.modalItem.type === 'playlist' && store.currentPlaylistTracks.length) {
        dlBody.playlist_tracks = store.currentPlaylistTracks;
        if ($('#createPlaylistCheck').checked) {
          dlBody.playlist_name = store.modalItem.name;
        }
      }
      if (store.modalItem.type === 'show' && store.currentShowEpisodes.length) {
        dlBody.playlist_tracks = store.currentShowEpisodes;
      }
      await apiJson('/api/download', { method: 'POST', body: dlBody });
      closeModal();
      openPanel();
    } catch (e) {
      alert('Download failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Download';
    }
  });

  $('#downloadsToggle').addEventListener('click', () => store.panelOpen ? closePanel() : openPanel());
  $('#panelClose').addEventListener('click', closePanel);

  $('#clearHistory').addEventListener('click', async () => {
    try { await apiFetch('/api/jobs', { method: 'DELETE' }); refreshJobs(); } catch {}
  });

  // Modal play/queue buttons
  $('#modalPlay').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = { ...store.modalItem };
    closeModal();
    const { resolveItemTracks, loadAndPlay } = await import('./player.js');
    const tracks = await resolveItemTracks(item);
    if (tracks.length) { store.playerQueue = tracks; store.playerIndex = 0; loadAndPlay(); }
  });
  $('#modalAddQueue').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = { ...store.modalItem };
    closeModal();
    const { resolveItemTracks, addToQueue } = await import('./player.js');
    const tracks = await resolveItemTracks(item);
    if (tracks.length) addToQueue(tracks);
  });

  // Modal radio button
  $('#modalRadio').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = { ...store.modalItem };
    closeModal();
    const { startRadio } = await import('./radio.js');
    startRadio(item);
  });

  // Modal favorite toggle
  $('#modalFavToggle').addEventListener('click', async () => {
    if (!store.modalItem || store.modalItem.type !== 'artist') return;
    const item = { ...store.modalItem };
    const isFollowing = store.favoritedArtistIds.has(item.id);
    try {
      if (isFollowing) {
        await apiJson(`/api/favorites/${item.id}`, { method: 'DELETE' });
        store.favoritedArtistIds.delete(item.id);
        $('#modalFavToggle').innerHTML = '&#x2661; Follow';
        $('#modalFavToggle').style.color = '';
        showToast(`Unfollowed ${item.name}`);
      } else {
        await apiJson('/api/favorites', { method: 'POST', body: { artist_id: item.id, name: item.name, image: item.image || '' } });
        store.favoritedArtistIds.add(item.id);
        $('#modalFavToggle').innerHTML = '&#x2665; Unfollow';
        $('#modalFavToggle').style.color = '#ef4444';
        showToast(`Following ${item.name}`);
      }
    } catch (e) {
      showToast('Failed: ' + e.message);
    }
  });
}
