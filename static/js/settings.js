// settings.js — Settings page, user management, disk usage

import { store } from './store.js';
import { $, $$, esc, formatSize, showToast } from './utils.js';
import { apiJson } from './api.js';
import { switchPage } from './router.js';

// ── Load Settings ──
export async function loadSettings() {
  try {
    const data = await apiJson('/api/settings');
    store.appSettings = data;
    // Show/hide Spotify option based on whether any creds exist
    const hasAnyCreds = store.spotifyAvailable || (store.currentUser && store.currentUser.has_spotify);
    $$('#settingSearchProvider option[value="spotify"], #settingSearchFallback option[value="spotify"], #settingPodcastProvider option[value="spotify"]').forEach(opt => {
      opt.disabled = !hasAnyCreds;
      if (!hasAnyCreds && opt.textContent.indexOf('no creds') === -1) opt.textContent += ' (no creds)';
    });
    $('#settingSearchProvider').value = data.search_provider || 'deezer';
    $('#settingSearchFallback').value = data.search_fallback || '';
    $('#settingPodcastProvider').value = data.podcast_provider || 'itunes';
    const fbNote = $('#searchFallbackNote');
    const fb = data.search_fallback || '';
    const defaults = { deezer: 'YouTube Music', ytmusic: 'Deezer', apple: 'Deezer', spotify: 'none' };
    fbNote.textContent = fb ? '' : 'Auto: ' + (defaults[data.search_provider] || 'none');
    fbNote.style.color = 'var(--text-muted)';
    $('#settingMethod').value = data.default_method || 'yt-dlp';
    $('#settingFormat').value = data.default_format || 'flac';
    $('#settingMaxConcurrent').value = data.max_concurrent || 10;
    $('#settingRecommendation').value = data.recommendation_source || 'combined';
    $('#settingSlskdUrl').value = data.slskd_url || '';
    $('#settingSlskdKey').value = '';
    $('#settingSlskdKey').placeholder = data.slskd_api_key ? '(set) Enter new...' : 'Enter API key...';
    $('#settingNavidromeUrl').value = data.navidrome_url || '';
    $('#settingNavidromeUser').value = data.navidrome_user || '';
    $('#settingNavidromePass').value = '';
    $('#settingNavidromePass').placeholder = data.navidrome_password ? '(set) Enter new...' : 'Enter password...';
    $('#settingDlnaUrl').value = data.dlna_renderer_url || '';
    // Load DLNA devices into dropdown
    _loadDlnaDevices();
  } catch {}
  // Load per-user Spotify status
  try {
    const sp = await apiJson('/api/user/spotify');
    const ver = await apiJson('/api/version');
    const statusEl = $('#spotifyStatus');
    const hasGlobal = ver.spotify_user;
    if (sp.connected) {
      statusEl.innerHTML = '<span style="color:var(--accent);">&#x2713; Connected</span> — Your personal Spotify account is linked.';
      $('#spotifyClientId').value = sp.spotify_client_id || '';
      $('#spotifyClientId').placeholder = '(set)';
      $('#spotifyClientSecret').value = '';
      $('#spotifyClientSecret').placeholder = '(set) Enter new...';
      $('#spotifyRefreshToken').value = '';
      $('#spotifyRefreshToken').placeholder = '(set) Enter new...';
      $('#spotifyDisconnect').style.display = '';
      $('#spotifyOAuth').textContent = '\u266B Reconnect Spotify';
    } else if (hasGlobal) {
      statusEl.innerHTML = '<span style="color:var(--accent);">&#x2713; Connected</span> — Using shared Spotify account.';
      $('#spotifyDisconnect').style.display = '';
      $('#spotifyOAuth').textContent = '\u266B Reconnect Spotify';
    } else {
      statusEl.innerHTML = 'Not connected. Click "Authorize with Spotify" to link your account.';
      $('#spotifyClientId').value = '';
      $('#spotifyClientSecret').value = '';
      $('#spotifyRefreshToken').value = '';
      $('#spotifyDisconnect').style.display = 'none';
      $('#spotifyOAuth').textContent = '\u266B Authorize with Spotify';
    }
    $('#settingHideSpotify').checked = store.currentUser.hide_spotify || false;
  } catch {}
  if (store.currentUser && store.currentUser.is_admin) loadUsers();
}

export function updateFallbackNote() {
  const prov = $('#settingSearchProvider').value;
  const fb = $('#settingSearchFallback').value;
  const note = $('#searchFallbackNote');
  const defaults = { deezer: 'YouTube Music', ytmusic: 'Deezer', apple: 'Deezer', spotify: 'none' };
  note.textContent = fb ? '' : 'Auto: ' + (defaults[prov] || 'none');
}

// ── DLNA Device Picker ──
async function _loadDlnaDevices() {
  const sel = $('#settingDlnaDevice');
  if (!sel) return;
  try {
    const data = await apiJson('/api/dlna/devices');
    const devices = data.devices || [];
    sel.innerHTML = '<option value="">Disabled</option>' +
      devices.map(d => `<option value="${esc(d.location)}">${esc(d.name)} (${esc(d.ip)})</option>`).join('');
    // Select current renderer if set
    const currentUrl = $('#settingDlnaUrl').value;
    if (currentUrl) {
      const match = [...sel.options].find(o => o.value === currentUrl);
      if (match) match.selected = true;
    }
  } catch {
    sel.innerHTML = '<option value="">No devices found</option>';
  }
}

// ── Disk Usage ──
function confirmDeleteTypeName(name) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    const s = esc(name);
    overlay.innerHTML = '<div class="modal-content" style="max-width:420px"><button class="modal-close" style="position:absolute;top:12px;right:12px">&times;</button><div style="display:flex;flex-direction:column;gap:12px"><div style="font-weight:700;font-size:15px;color:#e74c3c">Delete "'+s+'"?</div><div style="font-size:13px;color:var(--text-muted)">This will permanently delete all files in this folder. This cannot be undone.</div><div style="font-size:13px;color:var(--text-muted)">Type <strong style="color:var(--text)">'+s+'</strong> to confirm:</div><input type="text" autocomplete="off" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:14px" placeholder="Type folder name..."><div style="display:flex;gap:8px;justify-content:flex-end"><button class="cd-cancel" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;color:var(--text);cursor:pointer">Cancel</button><button class="cd-confirm" disabled style="background:var(--border);color:var(--text-muted);border:none;border-radius:var(--radius);padding:8px 16px;font-weight:600;cursor:not-allowed;transition:all .2s">Delete</button></div></div></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    const btn = overlay.querySelector('.cd-confirm');
    const close = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.modal-close').onclick = close;
    overlay.querySelector('.cd-cancel').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    input.addEventListener('input', () => {
      if (input.value === name) { btn.disabled = false; btn.style.background = '#e74c3c'; btn.style.color = '#fff'; btn.style.cursor = 'pointer'; }
      else { btn.disabled = true; btn.style.background = 'var(--border)'; btn.style.color = 'var(--text-muted)'; btn.style.cursor = 'not-allowed'; }
    });
    btn.addEventListener('click', () => { if (!btn.disabled) { overlay.remove(); resolve(true); } });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) { overlay.remove(); resolve(true); } });
    setTimeout(() => input.focus(), 100);
  });
}

function confirmDeleteSimple(name, parent) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = '<div class="modal-content" style="max-width:400px"><button class="modal-close" style="position:absolute;top:12px;right:12px">&times;</button><div style="display:flex;flex-direction:column;gap:12px"><div style="font-weight:700;font-size:15px;color:#e74c3c">Delete "'+esc(name)+'"?</div><div style="font-size:13px;color:var(--text-muted)">from <strong>'+esc(parent)+'</strong></div><div style="font-size:13px;color:var(--text-muted)">This will permanently delete all files in this subfolder.</div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="cd-cancel" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:8px 16px;color:var(--text);cursor:pointer">No</button><button class="cd-confirm" style="background:#e74c3c;color:#fff;border:none;border-radius:var(--radius);padding:8px 16px;font-weight:600;cursor:pointer">Yes, delete</button></div></div></div>';
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.modal-close').onclick = close;
    overlay.querySelector('.cd-cancel').onclick = close;
    overlay.querySelector('.cd-confirm').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  });
}

export async function loadDiskUsage() {
  const container = $('#diskUsageList');
  container.innerHTML = '<div class="skeleton" style="height:80px;"></div>';
  try {
    const data = await apiJson('/api/admin/disk-usage');
    const items = data.usage || [];
    if (!items.length) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No data</div>';
      return;
    }
    const maxSize = Math.max(...items.map(i => i.size_bytes), 1);
    const totalSize = items.reduce((s, i) => s + i.size_bytes, 0);
    container.innerHTML = `<div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Total: ${formatSize(totalSize)}</div>` +
      items.map(item => {
        const quotaGb = item.quota_gb || 0;
        const usedGb = item.size_bytes / (1024**3);
        const pctOfMax = (item.size_bytes / maxSize * 100).toFixed(1);
        let quotaInfo = '';
        let barColor = 'var(--accent)';
        if (quotaGb > 0) {
          const pctUsed = Math.min(usedGb / quotaGb * 100, 100).toFixed(0);
          quotaInfo = ` / ${quotaGb} GB (${pctUsed}%)`;
          if (usedGb >= quotaGb) barColor = '#e74c3c';
          else if (usedGb >= quotaGb * 0.8) barColor = '#f39c12';
        }
        return `
        <div class="disk-usage-group" data-dir="${esc(item.name)}">
          <div class="disk-usage-row">
            <div class="disk-usage-name expandable">${esc(item.name)}</div>
            <div class="disk-usage-bar"><div class="disk-usage-bar-fill" style="width:${pctOfMax}%;background:${barColor}"></div></div>
            <div class="disk-usage-stats">${item.file_count} files &middot; ${formatSize(item.size_bytes)}${quotaInfo}</div>
            <button class="btn-delete-dir" title="Delete this directory">Delete</button>
          </div>
          <div class="disk-usage-subs"></div>
        </div>`;
      }).join('');
    $$('.disk-usage-name.expandable', container).forEach(name => {
      name.addEventListener('click', async () => {
        const group = name.closest('.disk-usage-group');
        const subsEl = group.querySelector('.disk-usage-subs');
        if (name.classList.toggle('expanded')) {
          subsEl.classList.add('open');
          subsEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">Loading...</div>';
          try {
            const data = await apiJson(`/api/admin/disk-usage/${encodeURIComponent(group.dataset.dir)}/subfolders`);
            const subs = data.subfolders || [];
            if (!subs.length) { subsEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">No subfolders</div>'; return; }
            const subMax = Math.max(...subs.map(s => s.size_bytes), 1);
            subsEl.innerHTML = subs.map(s => `
              <div class="disk-usage-row" data-sub="${esc(s.name)}">
                <div class="disk-usage-name">${esc(s.name)}</div>
                <div class="disk-usage-bar"><div class="disk-usage-bar-fill" style="width:${(s.size_bytes/subMax*100).toFixed(1)}%"></div></div>
                <div class="disk-usage-stats">${s.file_count} files &middot; ${formatSize(s.size_bytes)}</div>
                <button class="btn-delete-dir" title="Delete this subfolder">Delete</button>
              </div>`).join('');
            $$('.btn-delete-dir', subsEl).forEach(btn => {
              btn.addEventListener('click', async () => {
                const row = btn.closest('.disk-usage-row');
                const subName = row.dataset.sub;
                const ok = await confirmDeleteSimple(subName, group.dataset.dir);
                if (!ok) return;
                try {
                  await apiJson(`/api/admin/disk-usage/${encodeURIComponent(group.dataset.dir)}?subfolder=${encodeURIComponent(subName)}`, { method: 'DELETE' });
                  row.remove();
                  loadDiskUsage();
                } catch (e) { alert('Failed: ' + e.message); }
              });
            });
          } catch (e) { subsEl.innerHTML = `<div style="color:#e74c3c;font-size:12px;padding:6px 0;">Failed: ${e.message}</div>`; }
        } else {
          subsEl.classList.remove('open');
        }
      });
    });
    $$('.disk-usage-group > .disk-usage-row > .btn-delete-dir', container).forEach(btn => {
      btn.addEventListener('click', async () => {
        const group = btn.closest('.disk-usage-group');
        const dirName = group.dataset.dir;
        const ok = await confirmDeleteTypeName(dirName);
        if (!ok) return;
        try {
          await apiJson(`/api/admin/disk-usage/${encodeURIComponent(dirName)}`, { method: 'DELETE' });
          group.remove();
        } catch (e) { alert('Failed: ' + e.message); }
      });
    });
  } catch (e) {
    container.innerHTML = `<div style="color:#e74c3c;font-size:13px;">Failed to load: ${e.message}</div>`;
  }
}

// ── User Management ──
export async function loadUsers() {
  try {
    const [data, diskData] = await Promise.all([
      apiJson('/api/users'),
      apiJson('/api/admin/disk-usage').catch(() => ({ usage: [] }))
    ]);
    const diskMap = {};
    diskData.usage.forEach(d => { diskMap[d.name] = d; });
    $('#usersList').innerHTML = data.users.map(u => {
      const fmts = (u.allowed_formats || ['mp3', 'flac']).map(f => `<span class="user-perm-tag">${esc(f)}</span>`).join('');
      const methLabels = { 'yt-dlp': 'YouTube', 'slskd': 'Soulseek', 'lidarr': 'Torrent' };
      const meths = (u.allowed_methods || ['yt-dlp', 'slskd', 'lidarr']).map(m => `<span class="user-perm-tag">${esc(methLabels[m] || m)}</span>`).join('');
      const disk = diskMap[u.username];
      const usedBytes = disk ? disk.size_bytes : 0;
      const quotaGb = u.quota_gb || 0;
      let diskTag;
      if (quotaGb > 0) {
        const usedGb = usedBytes / (1024**3);
        const pct = Math.min(usedGb / quotaGb * 100, 100).toFixed(0);
        const color = usedGb >= quotaGb ? '#e74c3c' : usedGb >= quotaGb * 0.8 ? '#f39c12' : 'var(--accent)';
        diskTag = `<span class="user-perm-tag" style="background:var(--surface-light);border-left:3px solid ${color};">${formatSize(usedBytes)} / ${quotaGb} GB (${pct}%)</span>`;
      } else {
        diskTag = `<span class="user-perm-tag" style="background:var(--surface-light);">${formatSize(usedBytes)}</span>`;
      }
      return `<div class="user-row">
        <span class="user-name">${esc(u.username)}</span>
        ${u.is_admin ? '<span class="user-badge">Admin</span>' : ''}
        <button class="user-perm-edit" data-username="${esc(u.username)}">Edit</button>
        ${u.username !== store.currentUser.username ? `<button class="btn-delete-user" data-username="${esc(u.username)}">&times;</button>` : ''}
        <div class="user-perms">${fmts}${meths}${diskTag}</div>
      </div>`;
    }).join('');
    // Attach edit/delete handlers
    $$('.user-perm-edit', $('#usersList')).forEach(btn => {
      btn.addEventListener('click', () => editPerms(btn.dataset.username));
    });
    $$('.btn-delete-user', $('#usersList')).forEach(btn => {
      btn.addEventListener('click', () => deleteUser(btn.dataset.username));
    });
  } catch {}
}

export async function editPerms(username) {
  const data = await apiJson('/api/users');
  const u = data.users.find(x => x.username === username);
  if (!u) return;
  const fmts = u.allowed_formats || ['mp3', 'flac'];
  const meths = u.allowed_methods || ['yt-dlp', 'slskd', 'lidarr'];
  const quotaGb = u.quota_gb || 0;
  const html = `<div style="display:flex;flex-direction:column;gap:12px;">
    <div style="font-weight:700;font-size:15px;">Permissions for ${esc(username)}</div>
    <details class="perm-section" open>
      <summary class="perm-section-title">Formats</summary>
      <div class="perm-section-body">
        <label class="perm-check"><span>MP3</span> <input type="checkbox" id="ep_mp3" ${fmts.includes('mp3') ? 'checked' : ''}></label>
        <label class="perm-check"><span>FLAC</span> <input type="checkbox" id="ep_flac" ${fmts.includes('flac') ? 'checked' : ''}></label>
      </div>
    </details>
    <details class="perm-section" open>
      <summary class="perm-section-title">Methods</summary>
      <div class="perm-section-body">
        <label class="perm-check" title="Stahuje audio z YouTube, metadata ze Spotify"><span>YouTube</span> <input type="checkbox" id="ep_ytdlp" ${meths.includes('yt-dlp') ? 'checked' : ''}></label>
        <label class="perm-check" title="P2P stahování přes síť Soulseek, preferuje FLAC"><span>Soulseek</span> <input type="checkbox" id="ep_slskd" ${meths.includes('slskd') ? 'checked' : ''}></label>
        <label class="perm-check" title="Torrent stahování přes Lidarr, monitoruje diskografie"><span>Torrent</span> <input type="checkbox" id="ep_lidarr" ${meths.includes('lidarr') ? 'checked' : ''}></label>
      </div>
    </details>
    <details class="perm-section" open>
      <summary class="perm-section-title">Disk Quota</summary>
      <div class="perm-section-body" style="flex-direction:row;align-items:center;gap:8px;">
        <input type="number" id="ep_quota" value="${quotaGb}" min="0" step="1" style="width:80px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-size:14px;">
        <span style="color:var(--text-muted);font-size:13px;">GB (0 = unlimited)</span>
      </div>
    </details>
  </div>`;
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay open';
  dialog.innerHTML = `<div class="modal" style="max-width:340px;position:relative;">
    <button class="btn-close" style="position:absolute;top:12px;right:12px;">&times;</button>
    ${html}
    <button class="btn-save" style="margin-top:16px;width:100%;" id="epSave">Save</button>
  </div>`;
  document.body.appendChild(dialog);
  dialog.querySelector('.btn-close').onclick = () => dialog.remove();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
  dialog.querySelector('#epSave').onclick = async () => {
    const newFmts = [];
    if (dialog.querySelector('#ep_mp3').checked) newFmts.push('mp3');
    if (dialog.querySelector('#ep_flac').checked) newFmts.push('flac');
    const newMeths = [];
    if (dialog.querySelector('#ep_ytdlp').checked) newMeths.push('yt-dlp');
    if (dialog.querySelector('#ep_slskd').checked) newMeths.push('slskd');
    if (dialog.querySelector('#ep_lidarr').checked) newMeths.push('lidarr');
    const newQuota = parseFloat(dialog.querySelector('#ep_quota').value) || 0;
    if (!newFmts.length) { alert('Select at least one format'); return; }
    if (!newMeths.length) { alert('Select at least one method'); return; }
    try {
      await apiJson(`/api/users/${username}/perms`, { method: 'PUT', body: { allowed_formats: newFmts, allowed_methods: newMeths, quota_gb: newQuota } });
      dialog.remove();
      loadUsers();
    } catch (e) { alert('Failed: ' + e.message); }
  };
}

export async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    await apiJson(`/api/users/${username}`, { method: 'DELETE' });
    loadUsers();
  } catch (e) { alert('Failed: ' + e.message); }
}

// ── Init ──
export function init() {
  $('#settingSearchProvider').addEventListener('change', updateFallbackNote);
  $('#settingSearchFallback').addEventListener('change', updateFallbackNote);

  $('#saveSettings').addEventListener('click', async () => {
    const btn = $('#saveSettings');
    btn.disabled = true; $('#saveStatus').textContent = '';
    const payload = {
      search_provider: $('#settingSearchProvider').value,
      search_fallback: $('#settingSearchFallback').value,
      podcast_provider: $('#settingPodcastProvider').value,
      default_method: $('#settingMethod').value,
      default_format: $('#settingFormat').value,
      max_concurrent: parseInt($('#settingMaxConcurrent').value) || 10,
      recommendation_source: $('#settingRecommendation').value,
      slskd_url: $('#settingSlskdUrl').value,
      navidrome_url: $('#settingNavidromeUrl').value,
      navidrome_user: $('#settingNavidromeUser').value,
    };
    const slskdKey = $('#settingSlskdKey').value;
    if (slskdKey) payload.slskd_api_key = slskdKey;
    const pass = $('#settingNavidromePass').value;
    if (pass) payload.navidrome_password = pass;
    const dlnaUrl = $('#settingDlnaUrl').value.trim();
    if (dlnaUrl || dlnaUrl === '') payload.dlna_renderer_url = dlnaUrl;
    try {
      store.appSettings = await apiJson('/api/settings', { method: 'PUT', body: payload });
      store.searchProvider = store.appSettings.search_provider || 'deezer';
      store.podcastProvider = store.appSettings.podcast_provider || 'itunes';
      const providerLabels = { deezer: 'Deezer', ytmusic: 'YouTube Music', apple: 'Apple Music', spotify: 'Spotify' };
      $('#searchInput').placeholder = `Search for music (${providerLabels[store.searchProvider] || store.searchProvider})...`;
      $('#saveStatus').textContent = 'Saved!';
      setTimeout(() => { $('#saveStatus').textContent = ''; }, 2000);
    } catch (e) {
      $('#saveStatus').textContent = 'Failed to save';
      $('#saveStatus').style.color = 'var(--red)';
    } finally { btn.disabled = false; }
  });

  // Spotify OAuth
  $('#spotifyOAuth').addEventListener('click', async () => {
    const btn = $('#spotifyOAuth');
    btn.disabled = true;
    try {
      const data = await apiJson('/api/spotify/auth-url?origin=' + encodeURIComponent(window.location.origin));
      window.location.href = data.url;
    } catch (e) {
      $('#spotifyOAuthStatus').textContent = e.message || 'Failed';
      $('#spotifyOAuthStatus').style.color = 'var(--red)';
      btn.disabled = false;
    }
  });

  // Spotify Manual Connect/Disconnect
  $('#spotifyConnect').addEventListener('click', async () => {
    const btn = $('#spotifyConnect');
    const status = $('#spotifyConnStatus');
    btn.disabled = true; status.textContent = '';
    const cid = $('#spotifyClientId').value.trim();
    const csecret = $('#spotifyClientSecret').value.trim();
    const rt = $('#spotifyRefreshToken').value.trim();
    if (!cid || !csecret || !rt) {
      status.textContent = 'All three fields required';
      status.style.color = 'var(--red)';
      btn.disabled = false;
      return;
    }
    try {
      await apiJson('/api/user/spotify', { method: 'PUT', body: { client_id: cid, client_secret: csecret, refresh_token: rt } });
      status.textContent = 'Connected!';
      status.style.color = 'var(--accent)';
      store.currentUser.has_spotify = true;
      loadSettings();
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (e) {
      status.textContent = e.message || 'Failed to connect';
      status.style.color = 'var(--red)';
    } finally { btn.disabled = false; }
  });

  $('#spotifyDisconnect').addEventListener('click', async () => {
    if (!confirm('Disconnect your Spotify account?')) return;
    try {
      await apiJson('/api/user/spotify', { method: 'DELETE' });
      store.currentUser.has_spotify = false;
      loadSettings();
    } catch {}
  });

  $('#settingHideSpotify').addEventListener('change', async () => {
    const hide = $('#settingHideSpotify').checked;
    try {
      await apiJson('/api/user/settings', { method: 'PUT', body: { hide_spotify: hide } });
      store.currentUser.hide_spotify = hide;
      const playlistsBtn = $('.nav-btn[data-page="playlists"]');
      const playlistsBnavBtn = $('.bnav-btn[data-page="playlists"]');
      if (hide) {
        playlistsBtn.style.display = 'none';
        if (playlistsBnavBtn) playlistsBnavBtn.style.display = 'none';
      } else {
        playlistsBtn.style.display = '';
        if (playlistsBnavBtn) playlistsBnavBtn.style.display = '';
      }
    } catch {}
  });

  // DLNA scan button — active SSDP scan
  $('#dlnaScanBtn').addEventListener('click', async () => {
    const status = $('#dlnaScanStatus');
    const btn = $('#dlnaScanBtn');
    btn.disabled = true;
    status.textContent = 'Scanning LAN for DLNA devices...';
    try {
      await apiJson('/api/dlna/scan', { method: 'POST' });
      await _loadDlnaDevices();
      const sel = $('#settingDlnaDevice');
      const count = sel.options.length - 1;
      status.textContent = count > 0 ? `Found ${count} device(s)` : 'No devices found';
    } catch {
      status.textContent = 'Scan failed';
    }
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 5000);
  });
  // DLNA dropdown selects URL into manual field
  $('#settingDlnaDevice').addEventListener('change', () => {
    const val = $('#settingDlnaDevice').value;
    $('#settingDlnaUrl').value = val;
  });

  // App update checker — always runs when Settings loads
  (async function checkAppUpdate() {
    const installedVersion = localStorage.getItem('app_version');
    const versionEl = $('#appCurrentVersion');
    if (installedVersion && versionEl) {
      versionEl.textContent = `Installed: ${installedVersion}.`;
    }
    try {
      const res = await fetch('https://api.github.com/repos/lucashanak/music-seeker/releases/latest', {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });
      if (!res.ok) return;
      const release = await res.json();
      const latest = release.tag_name.replace(/^v/, '');
      if (versionEl) versionEl.textContent = installedVersion
        ? `Installed: ${installedVersion}. Latest: ${latest}.`
        : `Latest: ${latest}.`;
      if (installedVersion && latest !== installedVersion) {
        const banner = $('#appUpdateBanner');
        if (banner) {
          $('#appUpdateVersion').textContent = `${installedVersion} → ${latest}`;
          const isAndroid = /android/i.test(navigator.userAgent);
          const asset = release.assets.find(a => isAndroid ? a.name.endsWith('.apk') : a.name.endsWith('.dmg'));
          if (asset) {
            const linkEl = $('#appUpdateLink');
            linkEl.href = asset.browser_download_url;
            linkEl.addEventListener('click', () => localStorage.setItem('app_version', latest));
          }
          banner.style.display = 'block';
        }
      }
    } catch(e) {}
  })();

  // Store version when downloading app from Settings links
  document.querySelectorAll('#desktopAppSection a[href*="/releases/"]').forEach(a => {
    a.addEventListener('click', async () => {
      try {
        const res = await fetch('https://api.github.com/repos/lucashanak/music-seeker/releases/latest',
          { headers: { 'Accept': 'application/vnd.github.v3+json' } });
        if (res.ok) {
          const r = await res.json();
          localStorage.setItem('app_version', r.tag_name.replace(/^v/, ''));
        }
      } catch(e) {}
    });
  });

  // Refresh (cache only, keep login)
  $('#refreshCacheBtn').addEventListener('click', async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch(e) {}
    window.location.href = window.location.origin + '/?_=' + Date.now();
  });

  // Clear All & Logout
  $('#clearCacheBtn').addEventListener('click', async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch(e) {}
    // Force bypass cache by appending cache-busting param
    window.location.href = window.location.origin + '/?_=' + Date.now();
  });

  // Disk Usage
  $('#refreshDiskUsage').addEventListener('click', loadDiskUsage);
  $('#diskUsageSection').addEventListener('toggle', (e) => {
    if (e.target.open) loadDiskUsage();
  });

  // Add User
  $('#addUserBtn').addEventListener('click', async () => {
    const u = $('#newUsername').value.trim();
    const p = $('#newPassword').value;
    const admin = $('#newIsAdmin').checked;
    if (!u || !p) return;
    const allowed_formats = [];
    if ($('#newFmtMp3').checked) allowed_formats.push('mp3');
    if ($('#newFmtFlac').checked) allowed_formats.push('flac');
    const allowed_methods = [];
    if ($('#newMethYtdlp').checked) allowed_methods.push('yt-dlp');
    if ($('#newMethSlskd').checked) allowed_methods.push('slskd');
    if ($('#newMethLidarr').checked) allowed_methods.push('lidarr');
    if (!allowed_formats.length || !allowed_methods.length) { alert('Select at least one format and method'); return; }
    try {
      await apiJson('/api/users', { method: 'POST', body: { username: u, password: p, is_admin: admin, allowed_formats, allowed_methods } });
      $('#newUsername').value = ''; $('#newPassword').value = ''; $('#newIsAdmin').checked = false;
      $('#newFmtMp3').checked = true; $('#newFmtFlac').checked = true;
      $('#newMethYtdlp').checked = true; $('#newMethSlskd').checked = true; $('#newMethLidarr').checked = true;
      loadUsers();
    } catch (e) { alert('Failed: ' + e.message); }
  });

  // Handle OAuth callback redirect
  checkSpotifyCallback();
}

function checkSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('spotify_connected') === '1') {
    history.replaceState(null, '', '/');
    setTimeout(() => {
      switchPage('settings');
      showToast('Spotify connected successfully!');
    }, 500);
  } else if (params.get('spotify_error')) {
    const err = params.get('spotify_error');
    history.replaceState(null, '', '/');
    setTimeout(() => {
      switchPage('settings');
      showToast('Spotify connection failed: ' + err, true);
    }, 500);
  }
}
