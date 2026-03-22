// podcasts.js — Podcasts page, subscriptions, episodes, bulk actions, sync

import { store } from './store.js';
import { $, $$, esc, formatSize, historyBack } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';

// ── Load Podcast Subscriptions ──
export async function loadPodcastSubs() {
  const container = $('#podcastSubsList');
  try {
    const data = await apiJson('/api/podcasts/subs');
    if (!data.subs.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = '<h3 style="font-size:15px;font-weight:600;margin:0 0 12px;color:var(--text-muted);">Subscriptions</h3>' +
      data.subs.map(sub => `
        <div class="podcast-sub-card" data-sid="${esc(sub.spotify_id)}">
          <img src="${esc(sub.image || '')}" alt="" onerror="this.style.display='none'">
          <div class="podcast-sub-info">
            <div class="podcast-sub-name">${esc(sub.show_name)}</div>
            <div class="podcast-sub-meta">Max episodes: ${sub.max_episodes || 'Unlimited'}</div>
          </div>
          <div class="podcast-sub-actions">
            <select class="sub-max-ep" title="Max episodes to keep">
              <option value="0" ${!sub.max_episodes ? 'selected' : ''}>All</option>
              ${[5, 10, 20, 50, 100].map(n => `<option value="${n}" ${sub.max_episodes === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
            <button class="btn-unsub" title="Unsubscribe">Unsub</button>
          </div>
        </div>
      `).join('');
    // Unsub buttons
    $$('.btn-unsub', container).forEach(btn => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.podcast-sub-card');
        const sid = card.dataset.sid;
        if (!confirm('Unsubscribe from this podcast?')) return;
        try { await apiJson(`/api/podcasts/subs/${encodeURIComponent(sid)}`, { method: 'DELETE' }); }
        catch (e) { alert('Failed: ' + e.message); return; }
        card.remove();
      });
    });
    // Max episodes change
    $$('.sub-max-ep', container).forEach(sel => {
      sel.addEventListener('change', async () => {
        const card = sel.closest('.podcast-sub-card');
        const sid = card.dataset.sid;
        try { await apiJson(`/api/podcasts/subs/${encodeURIComponent(sid)}`, { method: 'PUT', body: { max_episodes: parseInt(sel.value) } }); }
        catch (e) { alert('Failed: ' + e.message); }
      });
    });
  } catch (e) { container.innerHTML = ''; }
}

// ── Load Podcasts Page ──
export async function loadPodcasts() {
  const list = $('#podcastsList');
  const epView = $('#podcastEpisodes');
  epView.style.display = 'none';
  list.style.display = '';
  list.innerHTML = '<div class="skeleton" style="height:200px;"></div>';
  loadPodcastSubs();
  try {
    const data = await apiJson('/api/podcasts');
    $('#podcastsTotalSize').textContent = data.shows.length ? `Total: ${formatSize(data.total_size)}` : '';
    if (!data.shows.length) {
      list.innerHTML = '<div class="empty-state"><p>No downloaded podcasts yet</p></div>';
      return;
    }
    list.innerHTML = data.shows.map(show => `
      <div class="podcast-show-card" data-show="${esc(show.name)}">
        <div class="podcast-show-info">
          <div class="podcast-show-name">${esc(show.name)}</div>
          <div class="podcast-show-meta">${show.count} episode${show.count !== 1 ? 's' : ''} &middot; ${formatSize(show.total_size)}</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `).join('');
    $$('.podcast-show-card', list).forEach(card => {
      card.addEventListener('click', () => openPodcastShow(card.dataset.show));
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><p>Failed to load podcasts</p></div>`;
  }
}

// ── Open Podcast Show ──
export async function openPodcastShow(showName) {
  $('#podcastsList').style.display = 'none';
  const epView = $('#podcastEpisodes');
  epView.style.display = '';
  history.pushState({ layer: 'podcastShow' }, '');
  $('#podcastShowName').textContent = showName;
  $('#podcastEpFilter').value = '';
  $('#podcastBulkToggle').checked = false;
  $('#podcastBulkBar').style.display = 'none';
  $('#podcastMissing').innerHTML = '';
  const epList = $('#podcastEpisodesList');
  epList.innerHTML = '<div class="skeleton" style="height:150px;"></div>';
  try {
    const data = await apiJson('/api/podcasts');
    const show = data.shows.find(s => s.name === showName);
    if (!show || !show.episodes.length) {
      epList.innerHTML = '<div class="empty-state"><p>No episodes</p></div>';
      $('#podcastEpCount').textContent = '';
      return;
    }
    $('#podcastEpCount').textContent = `${show.episodes.length} episode${show.episodes.length !== 1 ? 's' : ''}`;
    epList.innerHTML = show.episodes.map(ep => `
      <div class="podcast-ep-row" data-show="${esc(showName)}" data-file="${esc(ep.filename)}">
        <input type="checkbox" class="ep-check">
        <span class="ep-name" title="${esc(ep.name)}">${esc(ep.name)}</span>
        <span class="ep-date">${new Date(ep.modified * 1000).toLocaleDateString()}</span>
        <span class="ep-size">${formatSize(ep.size)}</span>
        <button class="btn-delete-ep" title="Delete episode">Delete</button>
      </div>
    `).join('');
    // Individual delete
    $$('.btn-delete-ep', epList).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.podcast-ep-row');
        if (!confirm(`Delete "${row.querySelector('.ep-name').textContent}"?`)) return;
        try {
          await apiJson(`/api/podcasts/${encodeURIComponent(row.dataset.show)}/${encodeURIComponent(row.dataset.file)}`, { method: 'DELETE' });
          row.remove();
          updateBulkBar();
          if (!epList.querySelectorAll('.podcast-ep-row').length) {
            closePodcastShow();
            loadPodcasts();
          }
        } catch (err) { alert('Delete failed: ' + err.message); }
      });
    });
    // Checkbox change -> update bulk bar
    $$('.ep-check', epList).forEach(cb => {
      cb.addEventListener('change', updateBulkBar);
    });
  } catch (e) {
    epList.innerHTML = `<div class="empty-state"><p>Failed to load episodes</p></div>`;
    $('#podcastEpCount').textContent = '';
  }
}

export function closePodcastShow(fromPopstate) {
  $('#podcastEpisodes').style.display = 'none';
  $('#podcastMissing').innerHTML = '';
  $('#podcastsList').style.display = '';
  if (!fromPopstate) historyBack();
}

export function updateBulkBar() {
  const checked = $$('.ep-check:checked', $('#podcastEpisodesList'));
  const bar = $('#podcastBulkBar');
  if (checked.length > 0) {
    bar.style.display = 'flex';
    $('#podcastBulkCount').textContent = `${checked.length} selected`;
  } else {
    bar.style.display = 'none';
  }
}

// ── Init ──
export function init() {
  $('#backToPodcasts').addEventListener('click', () => closePodcastShow());
  $('#deleteShowBtn').addEventListener('click', async () => {
    const showName = $('#podcastShowName').textContent;
    if (!confirm(`Delete ALL episodes of "${showName}"?`)) return;
    try {
      await apiJson(`/api/podcasts/${encodeURIComponent(showName)}`, { method: 'DELETE' });
      closePodcastShow();
      loadPodcasts();
    } catch (e) { alert('Delete failed: ' + e.message); }
  });

  // Filter episodes
  $('#podcastEpFilter').addEventListener('input', () => {
    const q = $('#podcastEpFilter').value.toLowerCase().trim();
    $$('.podcast-ep-row', $('#podcastEpisodesList')).forEach(row => {
      const name = row.querySelector('.ep-name').textContent.toLowerCase();
      row.style.display = !q || name.includes(q) ? '' : 'none';
    });
  });

  // Bulk select toggle
  $('#podcastBulkToggle').addEventListener('change', () => {
    const checked = $('#podcastBulkToggle').checked;
    $$('.podcast-ep-row', $('#podcastEpisodesList')).forEach(row => {
      if (row.style.display !== 'none') {
        row.querySelector('.ep-check').checked = checked;
      }
    });
    updateBulkBar();
  });

  // Bulk delete
  $('#podcastBulkDelete').addEventListener('click', async () => {
    const rows = $$('.podcast-ep-row', $('#podcastEpisodesList')).filter(row => row.querySelector('.ep-check').checked);
    if (!rows.length) return;
    if (!confirm(`Delete ${rows.length} selected episode${rows.length !== 1 ? 's' : ''}?`)) return;
    let failed = 0;
    for (const row of rows) {
      try {
        await apiJson(`/api/podcasts/${encodeURIComponent(row.dataset.show)}/${encodeURIComponent(row.dataset.file)}`, { method: 'DELETE' });
        row.remove();
      } catch { failed++; }
    }
    updateBulkBar();
    if (failed) alert(`${failed} episode(s) failed to delete`);
    if (!$('#podcastEpisodesList').querySelectorAll('.podcast-ep-row').length) {
      closePodcastShow();
      loadPodcasts();
    }
  });

  // Check new episodes
  $('#checkNewBtn').addEventListener('click', async () => {
    const showName = $('#podcastShowName').textContent;
    const missing = $('#podcastMissing');
    missing.innerHTML = '<div class="skeleton" style="height:60px;"></div>';
    try {
      const searchData = await apiJson(`/api/search?q=${encodeURIComponent(showName)}&type=show&limit=5`);
      const shows = searchData.results || [];
      const match = shows.find(s => s.name.toLowerCase() === showName.toLowerCase()) || shows[0];
      if (!match) { missing.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">Show not found on Spotify</div>'; return; }
      const showData = await apiJson(`/api/spotify/show/${match.id}/episodes`);
      const spotifyEps = showData.episodes || [];
      const localNames = new Set();
      $$('.podcast-ep-row .ep-name', $('#podcastEpisodesList')).forEach(el => localNames.add(el.textContent.toLowerCase().trim()));
      const missingEps = spotifyEps.filter(ep => !localNames.has(ep.name.toLowerCase().trim()));
      if (!missingEps.length) {
        missing.innerHTML = '<div style="color:var(--accent);font-size:13px;padding:8px 0;">All episodes downloaded!</div>';
        return;
      }
      missing.innerHTML = `
        <div class="missing-section-header">
          <span>Missing episodes <span class="missing-count">(${missingEps.length} of ${spotifyEps.length})</span></span>
          <button class="btn-dl-missing" id="dlAllMissing">Download All Missing</button>
        </div>
        ${missingEps.map(ep => `
          <div class="missing-ep-row" data-ep-id="${esc(ep.id)}" data-ep-name="${esc(ep.name)}" data-show-name="${esc(showData.name)}" data-ep-image="${esc(ep.image || showData.image || '')}" data-ep-url="${esc(ep.url || '')}">
            <span class="ep-name" title="${esc(ep.name)}">${esc(ep.name)}</span>
            <span class="ep-date">${ep.release_date || ''}</span>
            <button class="btn-dl-missing" title="Download this episode">Download</button>
          </div>
        `).join('')}
      `;
      // Single episode download
      $$('.missing-ep-row .btn-dl-missing', missing).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.missing-ep-row');
          openModal({
            id: row.dataset.epId,
            name: row.dataset.epName,
            artist: row.dataset.showName,
            image: row.dataset.epImage,
            url: row.dataset.epUrl,
            type: 'episode',
          });
        });
      });
      // Download all missing
      $('#dlAllMissing').addEventListener('click', () => {
        openModal({
          name: showData.name,
          artist: showData.name,
          image: showData.image || '',
          url: '',
          type: 'show',
          total_tracks: missingEps.length,
        });
        store.currentShowEpisodes = missingEps.map(ep => ({
          name: ep.name,
          artist: showData.name,
          album: showData.name,
          image: ep.image || showData.image || '',
          url: ep.url || '',
        }));
      });
      // Add subscribe button if not already subscribed
      try {
        const subsData = await apiJson('/api/podcasts/subs');
        const alreadySubbed = subsData.subs.some(s => s.spotify_id === match.id);
        if (!alreadySubbed) {
          const subBtn = document.createElement('button');
          subBtn.className = 'btn-check-new';
          subBtn.textContent = 'Subscribe';
          subBtn.style.marginLeft = '8px';
          missing.querySelector('.missing-section-header')?.appendChild(subBtn);
          subBtn.addEventListener('click', async () => {
            try {
              await apiJson('/api/podcasts/subs', { method: 'POST', body: {
                show_name: showData.name, spotify_id: match.id, image: showData.image || '', feed_url: showData.feed_url || ''
              }});
              subBtn.textContent = 'Subscribed';
              subBtn.disabled = true;
              subBtn.style.opacity = '0.5';
            } catch (e) { alert('Failed: ' + e.message); }
          });
        }
      } catch {}
    } catch (e) {
      missing.innerHTML = `<div style="color:#e74c3c;font-size:13px;padding:8px 0;">Failed to check: ${e.message}</div>`;
    }
  });

  // Sync All button
  $('#syncPodcastsBtn').addEventListener('click', async () => {
    const btn = $('#syncPodcastsBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    try {
      const data = await apiJson('/api/podcasts/sync', { method: 'POST' });
      btn.textContent = data.synced ? `${data.synced} new` : 'Up to date';
      setTimeout(() => { btn.textContent = 'Sync All'; btn.disabled = false; }, 3000);
    } catch (e) {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Sync All'; btn.disabled = false; }, 3000);
    }
  });
}
