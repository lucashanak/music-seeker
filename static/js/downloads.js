// downloads.js — Download modal (openModal/closeModal), downloads panel (openPanel/closePanel), refreshJobs, job management

import { store } from './store.js';
import { $, $$, esc, showToast, historyBack, setArt, showConfirmModal } from './utils.js';
import { apiFetch, apiJson } from './api.js';
import { getPlayerModule } from './player_active.js';
import { forgetBpmUnavailable } from './bpm.js';

// ── Download Modal ──
export function openModal(item) {
  history.pushState({ layer: 'modal' }, '');
  store.modalItem = item;
  setArt($('#modalImg'), item.image);
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
  // Hide the whole download-options panel for podcasts (always yt-dlp + mp3).
  // Format's own visibility (yt-dlp only) is otherwise owned by updateOptionGroups().
  $('#methodSection').style.display = isPodcast ? 'none' : '';
  if (isPodcast) $('#formatSection').style.display = 'none';
  $('#modalLibraryNotice').style.display = item.inLibrary ? '' : 'none';
  const dlBtn = $('#modalDownload');
  if (item.inLibrary) {
    dlBtn.disabled = true;
    dlBtn.textContent = 'Already in library';
  } else {
    dlBtn.disabled = false;
    dlBtn.textContent = 'Download';
  }
  // Show delete button for tracks/albums already in library
  const delBtn = $('#modalDeleteTrack');
  if (delBtn) {
    const showDel = item.inLibrary && (type === 'track' || type === 'album');
    delBtn.style.display = showDel ? '' : 'none';
    delBtn.disabled = false;
    delBtn.textContent = type === 'album' ? 'Delete Album from Library' : 'Delete from Library';
  }
  $('#downloadModal').classList.add('open');

  _syncModalTrackActions(item, type);

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

// Like + "Add to playlist" live beside Radio and Follow in the quick row. They
// are built here rather than in the partial because they need the modal's
// current item, and the heart has to repaint when the like state changes.
let _modalLikeBtn = null;
let _modalPlaylistBtn = null;

async function _buildModalTrackActions() {
  const row = $('#downloadModal .modal-quick-row');
  if (!row || _modalLikeBtn) return;
  const { makeHeartButton } = await import('./likes.js');
  // Plain `like-btn`: the heart rule in the head's <style> comes after
  // modal.css, so a `modal-chip` here would be overridden into a heart anyway.
  _modalLikeBtn = makeHeartButton(() => store.modalItem || {});
  _modalLikeBtn.title = 'Like this track';
  _modalPlaylistBtn = document.createElement('button');
  _modalPlaylistBtn.type = 'button';
  _modalPlaylistBtn.className = 'modal-chip';
  _modalPlaylistBtn.title = 'Add to a playlist in your library';
  _modalPlaylistBtn.innerHTML = '&#9776; Playlist';
  _modalPlaylistBtn.addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = { ...store.modalItem };
    const m = await import('./contextmenu.js');
    m._addToNavidromePlaylist(item);
  });
  row.insertBefore(_modalLikeBtn, $('#modalRadio'));
  row.appendChild(_modalPlaylistBtn);
}

// Both actions are track-only: a playlist row takes a track id, and a like is
// keyed by artist + title.
function _syncModalTrackActions(item, type) {
  _buildModalTrackActions().then(() => {
    const show = type === 'track';
    if (_modalLikeBtn) {
      _modalLikeBtn.style.display = show ? '' : 'none';
      if (show && _modalLikeBtn._refreshLike) _modalLikeBtn._refreshLike();
    }
    if (_modalPlaylistBtn) _modalPlaylistBtn.style.display = show ? '' : 'none';
  });
}

const METHOD_HINTS = {
  'yt-dlp': 'Downloads from YouTube. Choose audio quality below.',
  slskd: 'Searches the Soulseek network. Prefers the format you pick; if no peer has it, takes the best other copy available.',
  lidarr: 'Hands off to Lidarr, which finds and downloads this in the background. Check the Downloads panel for progress.',
};

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
  $('#formatSection').style.display = (store.selectedMethod === 'yt-dlp' || store.selectedMethod === 'slskd') ? '' : 'none';
  const hintEl = $('#modalMethodHint');
  if (hintEl) hintEl.textContent = METHOD_HINTS[store.selectedMethod] || '';
}

// ── Downloads Panel ──

// Which nav entries wear `.active` while the panel is up. The panel is not a
// page, so nothing else sets or clears this for it.
function _markNavActive(on) {
  $$('.nav-btn[data-page], .bnav-btn[data-page]').forEach(b => b.classList.remove('active'));
  const downloads = [$('#downloadsToggle'), $('#bnavDownloads')];
  if (on) {
    downloads.forEach(b => b && b.classList.add('active'));
    return;
  }
  downloads.forEach(b => b && b.classList.remove('active'));
  // Back to whichever page is actually showing underneath.
  const page = store.currentPage;
  if (!page) return;
  [$(`.nav-btn[data-page="${page}"]`), $(`.bnav-btn[data-page="${page}"]`)]
    .forEach(b => b && b.classList.add('active'));
}

export function openPanel() {
  store.panelOpen = true;
  $('#downloadsPanel').classList.add('open');
  _markNavActive(true);
  history.pushState({ layer: 'panel' }, '');
}

export function closePanel(fromPopstate) {
  if (!store.panelOpen) return;
  store.panelOpen = false;
  $('#downloadsPanel').classList.remove('open');
  _markNavActive(false);
  if (!fromPopstate) historyBack();
}

// ── Jobs ──

const _ACTIVE = new Set(['running', 'queued']);

// A job handed to Lidarr finishes here and starts there. `handed_off` is a flag
// beside the status, not a status of its own: a new enum value would have to be
// taught to three filters in jobs.py, and an unknown one raises on history load.
function _jobIsHandedOff(j) {
  return !!j.handed_off;
}

function _jobCard(j) {
  const active = _ACTIVE.has(j.status);
  const handed = _jobIsHandedOff(j);
  // No percentage exists for a single-track download, so show that it is moving
  // rather than a bar frozen at zero.
  const unknownProgress = j.status === 'running' && !(j.progress > 0);
  return `
      <div class="job-item">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div class="job-title" style="flex:1; min-width:0;">${esc(j.title)}</div>
          <span class="job-status ${j.status}${handed ? ' handed-off' : ''}">${handed ? 'Sent to Lidarr' : esc(j.status)}</span>
        </div>
        <div class="job-meta">
          <span>${esc(j.method || '')} / ${esc(j.format || '')}</span>
          ${active ? `<button class="job-cancel" data-job-id="${esc(j.id)}">Cancel</button>` : ''}
          ${(j.status === 'failed' || j.status === 'cancelled') ? `<button class="job-retry" data-job-id="${esc(j.id)}">Retry</button>` : ''}
        </div>
        ${active ? `<div class="job-progress-bar${unknownProgress ? ' indeterminate' : ''}"><div class="job-progress-fill" style="width:${unknownProgress ? 40 : (j.progress || 0)}%"></div></div>` : ''}
        ${j.progress_text ? `<div class="job-progress-text">${esc(j.progress_text)}</div>` : ''}
        ${j.error ? `<div class="job-progress-text" style="color:var(--red)">${esc(j.error)}</div>` : ''}
      </div>`;
}

function _jobsGroup(title, list) {
  if (!list.length) return '';
  return `<div class="jobs-group"><div class="jobs-group-title">${esc(title)} &middot; ${list.length}</div>${list.map(_jobCard).join('')}</div>`;
}

function _renderJobsEmpty() {
  $('#jobsList').innerHTML = `
    <div class="empty-state">
      <p>No downloads yet. Find a track, album or playlist and it will show up here while it downloads.</p>
      <button class="btn-check-new empty-state-cta" id="jobsEmptyFind">Find something to download</button>
    </div>`;
  const btn = $('#jobsEmptyFind');
  if (btn) btn.addEventListener('click', () => {
    closePanel();
    import('./contextmenu.js').then(m => m.searchForType('track', ''));
  });
}

// A failing /api/jobs used to leave the panel showing a stale list with no hint
// that it had stopped updating — this instance returned 502 twice during the
// audit. Say so, above whatever was last rendered.
function _showJobsError(message) {
  const list = $('#jobsList');
  if (!list) return;
  let box = list.querySelector('.jobs-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'jobs-error';
    list.prepend(box);
  }
  box.textContent = `Downloads list is out of date — ${message}`;
}

function _clearJobsError() {
  const box = $('#jobsList') && $('#jobsList').querySelector('.jobs-error');
  if (box) box.remove();
}

export async function refreshJobs() {
  if (!store.authToken) {
    if (store.jobsInterval) { clearInterval(store.jobsInterval); store.jobsInterval = null; }
    return;
  }
  let jobs;
  try {
    const data = await apiJson('/api/jobs');
    jobs = data.jobs || [];
  } catch (e) {
    _showJobsError(e && e.message ? e.message : 'the server did not answer');
    return;
  }
  _clearJobsError();
  checkJobCompletions(jobs);
  const active = jobs.filter(j => _ACTIVE.has(j.status));
  $('#jobsBadge').textContent = active.length || '';
  const mobileBadge = $('#jobsBadgeMobile');
  if (mobileBadge) mobileBadge.textContent = active.length || '';
  if (!jobs.length) { _renderJobsEmpty(); return; }
  const finished = jobs.filter(j => !_ACTIVE.has(j.status));
  $('#jobsList').innerHTML = _jobsGroup('In progress', active) + _jobsGroup('Finished', finished);
  // Attach cancel/retry handlers
  $$('.job-cancel', $('#jobsList')).forEach(btn => {
    btn.addEventListener('click', () => cancelJob(btn.dataset.jobId));
  });
  $$('.job-retry', $('#jobsList')).forEach(btn => {
    btn.addEventListener('click', () => retryJob(btn.dataset.jobId));
  });
}

async function cancelJob(id) {
  try { await apiFetch(`/api/jobs/${id}`, { method: 'DELETE' }); } catch {}
  refreshJobs();
}

async function retryJob(id) {
  try {
    await apiJson(`/api/jobs/${id}/retry`, { method: 'POST' });
    refreshJobs();
  } catch (e) { showToast('Retry failed: ' + e.message, true); }
}

// A download landed (GitHub #12). Navidrome sees the file only after its scan,
// which the job starts as it ends, so the open page asks twice: soon, and once
// the scan has surely finished. Several jobs ending together share the passes.
let _regrowTimers = [];
function _libraryGrew() {
  _regrowTimers.forEach(clearTimeout);
  _regrowTimers = [5000, 20000].map(ms => setTimeout(() => {
    import('./search.js').then(m => m.recheckVisibleLibrary()).catch(() => {});
    // A download into a playlist adds its tracks when it finishes.
    window.dispatchEvent(new CustomEvent('librarychange', { detail: { url: '', method: 'job' } }));
  }, ms));
}

// ── Browser Notifications for Job Completions ──
export function checkJobCompletions(jobs) {
  for (const j of jobs) {
    const prev = store.previousJobStates[j.id];
    const wasActive = prev === 'running' || prev === 'queued';
    // A finished download may be a track the queue marked "no BPM"; ask again.
    if (wasActive && j.status === 'done') {
      forgetBpmUnavailable();
      if (!_jobIsHandedOff(j)) _libraryGrew();
    }
    if (store.notificationsEnabled && wasActive) {
      if (j.status === 'done' && _jobIsHandedOff(j)) {
        // Nothing has downloaded yet — the panel says where it went.
      } else if (j.status === 'done') {
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
      showToast('Download failed: ' + e.message, true);
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
    const { resolveItemTracks } = await getPlayerModule();
    const tracks = await resolveItemTracks(item);
    if (tracks.length) {
      const u = await import('./upnext.js');
      u.playTracks(tracks);
    }
  });
  $('#modalAddQueue').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = { ...store.modalItem };
    closeModal();
    const { resolveItemTracks, addToQueue } = await getPlayerModule();
    const tracks = await resolveItemTracks(item);
    if (tracks.length) addToQueue(tracks);
  });

  // Modal delete track/album
  $('#modalDeleteTrack').addEventListener('click', async () => {
    if (!store.modalItem) return;
    const item = store.modalItem;
    const isAlbum = (item.type || 'track') === 'album';
    const btn = $('#modalDeleteTrack');
    const resetLabel = isAlbum ? 'Delete Album from Library' : 'Delete from Library';
    btn.disabled = true;

    if (isAlbum) {
      const ok = await showConfirmModal('Delete album?',
        `"${item.artist} - ${item.name}" and all its tracks will be removed from the library.`,
        { okLabel: 'Delete' });
      if (!ok) { btn.disabled = false; return; }
      btn.textContent = 'Deleting...';
      try {
        await apiJson('/api/library/album/delete', {
          method: 'POST',
          body: { artist: item.artist || '', album: item.name || '' },
        });
        showToast('Album deleted');
        closeModal();
      } catch (e) {
        showToast(e.message || 'Failed to delete');
        btn.disabled = false;
        btn.textContent = resetLabel;
      }
    } else {
      btn.textContent = 'Checking...';
      try {
        const check = await apiJson('/api/library/track/check-playlists', {
          method: 'POST',
          body: { name: item.name || '', artist: item.artist || '' },
        });
        let msg = 'This removes it from the library permanently.';
        if (check.in_playlists && check.in_playlists.length) {
          msg += `\n\nThis track is in ${check.in_playlists.length} playlist(s):\n` +
            check.in_playlists.map(p => `• ${p.name}`).join('\n');
        }
        const ok = await showConfirmModal(`Delete "${item.artist} - ${item.name}"?`, msg, { okLabel: 'Delete' });
        if (!ok) { btn.disabled = false; btn.textContent = resetLabel; return; }
        btn.textContent = 'Deleting...';
        await apiJson('/api/library/track/delete', {
          method: 'POST',
          body: { name: item.name || '', artist: item.artist || '' },
        });
        showToast('Track deleted');
        closeModal();
      } catch (e) {
        showToast(e.message || 'Failed to delete');
        btn.disabled = false;
        btn.textContent = resetLabel;
      }
    }
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
