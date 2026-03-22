// auth.js — Login, logout, initApp, checkVersion, token management

import { store } from './store.js';
import { $, $$ } from './utils.js';
import { apiJson } from './api.js';
import { showToast, historyBack } from './utils.js';
import { requestNotificationPermission } from './utils.js';
import { refreshJobs } from './downloads.js';
import { loadQueueState } from './player.js';
import { loadFavoritedArtistIds } from './favorites.js';
import { restoreSearch } from './search.js';

// ── Version Check ──
export async function checkVersion() {
  try {
    const r = await fetch('/api/version');
    const d = await r.json();
    store.searchProvider = d.search_provider || 'deezer';
    store.podcastProvider = d.podcast_provider || 'itunes';
    store.spotifyAvailable = d.spotify_available === true;
    store.spotifyUser = d.spotify_user !== false;
    const stored = localStorage.getItem('ms_version');
    if (stored && stored !== d.version) {
      localStorage.removeItem('ms_token');
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
  localStorage.removeItem('ms_token');
  $('#appContainer').style.display = 'none';
  $('#loginScreen').style.display = '';
  if (store.jobsInterval) clearInterval(store.jobsInterval);
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
    // Show settings save only for admins (others can view)
    $('#saveSettings').style.display = me.is_admin ? '' : 'none';

    // Load defaults
    try {
      const s = await apiJson('/api/settings');
      store.appSettings = s;
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

    // Restore player queue
    loadQueueState();

    // Load favorited artist IDs
    loadFavoritedArtistIds();

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
