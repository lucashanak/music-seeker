// auth.js — Login, logout, initApp, checkVersion, token management

import { store } from './store.js';
import { $, $$ } from './utils.js';
import { apiJson, refreshStreamToken } from './api.js';
import { showToast, historyBack } from './utils.js';
import { requestNotificationPermission } from './utils.js';
import { refreshJobs } from './downloads.js';
import { getPlayerModule } from './player_active.js';
import { initUpNext } from './upnext.js';
import { loadFavoritedArtistIds } from './favorites.js';
import { restoreSearch } from './search.js';
import { loadLikes } from './likes.js';
import { initRemote, stopRemote } from './remote.js';

// ── Version Check ──
export async function checkVersion() {
  try {
    const r = await fetch('/api/version');
    const d = await r.json();
    store.searchProvider = d.search_provider || 'deezer';
    store.podcastProvider = d.podcast_provider || 'itunes';
    store.spotifyAvailable = d.spotify_available === true;
    store.spotifyUser = d.spotify_user !== false;
    // Why Spotify is unavailable, when it is — credentials missing is a
    // different situation from the API refusing every request.
    store.spotifyStatus = d.spotify_status || null;
    const stored = localStorage.getItem('ms_version');
    if (stored && stored !== d.version) {
      // Reload to pick up new static assets, but KEEP the session token — the
      // server JWT secret persists across deploys, so the token stays valid and
      // the user stays logged in (persistent login).
      localStorage.setItem('ms_version', d.version);
      location.reload();
      return;
    }
    localStorage.setItem('ms_version', d.version);
  } catch {}
}

// ── Logout ──
export function logout() {
  store.authToken = '';
  store.currentUser = null;
  store.streamToken = null;
  localStorage.removeItem('ms_token');
  $('#appContainer').style.display = 'none';
  $('#loginScreen').style.display = '';
  if (store.jobsInterval) clearInterval(store.jobsInterval);
  if (store.streamTokenInterval) { clearInterval(store.streamTokenInterval); store.streamTokenInterval = null; }
  try { stopRemote(); } catch {}
}

// ── Login ──
export async function doLogin() {
  const u = $('#loginUser').value.trim();
  const p = $('#loginPass').value;
  if (!u || !p) return;

  $('#loginBtn').disabled = true;
  $('#loginError').textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Login failed');
    store.authToken = data.token;
    localStorage.setItem('ms_token', store.authToken);
    await initApp();
  } catch (e) {
    $('#loginError').textContent = e.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
}

// ── App Init ──
export async function initApp() {
  try {
    const me = await apiJson('/api/auth/me');
    store.currentUser = me;
    $('#navUsername').textContent = me.username;
    $('#loginScreen').style.display = 'none';
    $('#appContainer').style.display = '';

    // Show admin sections
    $('#usersSection').style.display = me.is_admin ? '' : 'none';
    $('#diskUsageSection').style.display = me.is_admin ? '' : 'none';
    $('#feedbackSection').style.display = me.is_admin ? '' : 'none';
    // Global-settings auto-saves and the credential Save & Test buttons write to
    // PUT /api/settings (require_admin). Non-admins can view but not save, so hide
    // the credential Save & Test buttons for them (the auto-save handlers also
    // short-circuit for non-admins). The Library/Download Sources sections still
    // render so non-admins can see current values.
    const adminOnly = me.is_admin ? '' : 'none';
    const stN = $('#saveTestNavidrome'); if (stN) stN.style.display = adminOnly;
    const stS = $('#saveTestSlskd'); if (stS) stS.style.display = adminOnly;

    // Load defaults
    try {
      const s = await apiJson('/api/settings');
      store.appSettings = s;
    } catch {}

    // Load per-device settings (output mode, device name)
    try {
      const ds = await apiJson('/api/user/device-settings');
      store.deviceName = ds.name || '';
      store.deviceOutputMode = ds.output_mode || 'default';
      store.deviceDlnaRendererUrl = ds.dlna_renderer_url || '';
      // Hide cast buttons immediately if local-only mode
      if (store.deviceOutputMode === 'local') {
        const cb = $('#playerCastBtn');
        const fb = document.getElementById('fpCastBtn');
        if (cb) cb.style.display = 'none';
        if (fb) fb.style.display = 'none';
      }
    } catch {}

    // Show/hide Spotify nav based on per-user settings
    const userHasSpotify = me.has_spotify || store.spotifyUser;
    const playlistsBtn = $('.nav-btn[data-page="playlists"]');
    const playlistsBnavBtn = $('.bnav-btn[data-page="playlists"]');
    if (me.hide_spotify) {
      playlistsBtn.style.display = 'none';
      if (playlistsBnavBtn) playlistsBnavBtn.style.display = 'none';
    } else if (!userHasSpotify) {
      playlistsBtn.style.opacity = '0.4';
      playlistsBtn.title = 'Spotify not connected — connect in Settings';
      if (playlistsBnavBtn) {
        playlistsBnavBtn.style.opacity = '0.4';
        playlistsBnavBtn.title = 'Spotify not connected';
      }
    } else {
      playlistsBtn.style.display = '';
      playlistsBtn.style.opacity = '';
      playlistsBtn.title = '';
      if (playlistsBnavBtn) {
        playlistsBnavBtn.style.display = '';
        playlistsBnavBtn.style.opacity = '';
        playlistsBnavBtn.title = '';
      }
    }
    // Search is always available (Deezer/YTMusic don't need credentials)
    const providerLabels = { deezer: 'Deezer', ytmusic: 'YouTube Music', apple: 'Apple Music', spotify: 'Spotify' };
    $('#searchInput').placeholder = `Search for music (${providerLabels[store.searchProvider] || store.searchProvider})...`;

    // Start jobs polling
    refreshJobs();
    store.jobsInterval = setInterval(refreshJobs, 2000);

    // Mint a stream-scoped token (kept out of the session JWT) and refresh before
    // its 6h TTL expires; await once so the first stream URL has it.
    refreshStreamToken();
    if (store.streamTokenInterval) clearInterval(store.streamTokenInterval);
    store.streamTokenInterval = setInterval(refreshStreamToken, 5 * 3600 * 1000);

    // Restore player queue + initialize Up Next temp playlist (unified queue model)
    // Sequence restore: load the saved queue/index BEFORE Up Next's empty-queue
    // hydration decides whether to overwrite it (was a non-deterministic boot race
    // that could clobber the restored track/position).
    await getPlayerModule().then(m => m.loadQueueState());
    initUpNext().catch(() => {});

    // Remote device control: connect SSE + start state reporting (needs the player
    // module + stream token, which exist by now).
    try { initRemote(); } catch {}

    // Load favorited artist IDs
    loadFavoritedArtistIds();

    // Load liked-songs set (drives every heart icon; re-fetched on each login)
    loadLikes(true).catch(() => {});

    // Restore previous search if any
    restoreSearch();

    $('#searchInput').focus();
    requestNotificationPermission();
  } catch {
    logout();
  }
}

// ── Init (called from app.js) ──
export function init() {
  // Run version check immediately (was an IIFE in original)
  checkVersion();

  $('#logoutBtn').addEventListener('click', logout);

  $('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); doLogin(); });
  $('#loginUser').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('#loginPass').focus(); }
  });

  // Listen for auth:logout event from api.js (avoids circular import)
  document.addEventListener('auth:logout', logout);

  // Auto-login if token exists
  if (store.authToken) {
    initApp();
  } else {
    $('#loginScreen').style.display = '';
  }
}
