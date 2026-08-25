// settings.js — Settings page, user management, disk usage

import { store } from './store.js';
import { $, $$, esc, escAttr, formatSize, showToast, showConfirmModal } from './utils.js';
import { apiJson, apiFetch } from './api.js';
import { switchPage } from './router.js';
import { getPlayerModule } from './player_active.js';

// ── Load Settings ──
export async function loadSettings() {
  try {
    const data = await apiJson('/api/settings');
    store.appSettings = data;
    // Show/hide Spotify option based on whether any creds exist
    const hasAnyCreds = store.spotifyAvailable || (store.currentUser && store.currentUser.has_spotify);
    // Distinguish "never configured" from "configured but the API is refusing
    // requests" — picking Spotify as a provider is wrong in both cases, but only
    // the first is fixed by entering credentials.
    const spDown = store.spotifyStatus && store.spotifyStatus.available === false;
    const spSuffix = spDown ? ' (unavailable)' : ' (no creds)';
    $$('#settingSearchProvider option[value="spotify"], #settingSearchFallback option[value="spotify"], #settingPodcastProvider option[value="spotify"]').forEach(opt => {
      opt.disabled = !hasAnyCreds || spDown;
      if ((!hasAnyCreds || spDown) && opt.textContent.indexOf('(') === -1) opt.textContent += spSuffix;
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
  // Load device settings for this device
  _loadDeviceSettings();
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

// ── Device Settings ──
async function _loadDeviceSettings() {
  try {
    const data = await apiJson('/api/user/device-settings');
    store.deviceName = data.name || '';
    store.deviceOutputMode = data.output_mode || 'default';
    store.deviceDlnaRendererUrl = data.dlna_renderer_url || '';
    const nameEl = $('#settingDeviceName');
    const modeEl = $('#settingOutputMode');
    const dlnaUrlEl = $('#settingDeviceDlnaUrl');
    if (nameEl) nameEl.value = store.deviceName;
    if (modeEl) modeEl.value = store.deviceOutputMode;
    if (dlnaUrlEl) dlnaUrlEl.value = store.deviceDlnaRendererUrl;
    // Player engine (stored in localStorage, per-device). The 'crossfade' engine
    // was removed — normalize any lingering value so the dropdown isn't left blank.
    const engineEl = $('#settingPlayerEngine');
    if (engineEl) {
      let eng = localStorage.getItem('ms_player_engine') || 'classic';
      if (eng === 'crossfade') { eng = 'classic'; localStorage.setItem('ms_player_engine', 'classic'); }
      engineEl.value = eng;
      if (!engineEl.dataset.bound) {
        engineEl.dataset.bound = '1';
        engineEl.addEventListener('change', _applyEngineChange);
      }
    }
    // Streaming quality (all engines; read by prefetch.streamQuality()).
    const sqEl = $('#settingStreamQuality');
    if (sqEl) {
      sqEl.value = localStorage.getItem('ms_stream_quality')
        || localStorage.getItem('ms_dj_quality') || 'standard';
      if (!sqEl.dataset.bound) {
        sqEl.dataset.bound = '1';
        sqEl.addEventListener('change', () => {
          localStorage.setItem('ms_stream_quality', sqEl.value);
          showToast('Streaming quality: ' + (sqEl.value === 'lossless' ? 'Lossless (FLAC)' : 'MP3 320k'));
        });
      }
    }
    _toggleDjSection();
    _loadDjSettings();
    _toggleDeviceDlnaRow();
  } catch {}
  _loadMyDevices();
}

function _toggleDeviceDlnaRow() {
  const row = $('#deviceDlnaRow');
  if (row) row.style.display = store.deviceOutputMode === 'dlna_only' ? '' : 'none';
}

async function _loadMyDevices() {
  const list = $('#myDevicesList');
  if (!list) return;
  try {
    const data = await apiJson('/api/user/devices');
    const devices = data.devices || {};
    const entries = Object.entries(devices);
    if (!entries.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No registered devices</div>';
      return;
    }
    const modeLabels = { 'default': 'Default', 'local': 'Local Only', 'dlna_only': 'DLNA Only' };
    list.innerHTML = entries.map(([id, d]) => {
      const isCurrent = id === store.deviceId;
      return `<div class="device-row${isCurrent ? ' current' : ''}" data-device-id="${esc(id)}">
        <span class="device-name">${esc(d.name || 'Unnamed')}${isCurrent ? ' (this device)' : ''}</span>
        <span class="device-mode">${modeLabels[d.output_mode] || d.output_mode}</span>
        ${!isCurrent ? `<button class="btn-delete-device" title="Remove device">&times;</button>` : ''}
      </div>`;
    }).join('');
    $$('.btn-delete-device', list).forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.device-row').dataset.deviceId;
        try {
          await apiJson(`/api/user/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
          _loadMyDevices();
        } catch {}
      });
    });
  } catch {}
}

// Engine change requires a reload (memoized module, different audio graph).
// Persist the active queue first, then reload with cache-bust + app_version.
async function _applyEngineChange() {
  const engineEl = $('#settingPlayerEngine');
  if (!engineEl) return;
  const prev = localStorage.getItem('ms_player_engine') || 'classic';
  const next = engineEl.value;
  if (next === prev) return;
  try {
    // Flush the current queue to the server on the OUTGOING engine module
    // (resolved BEFORE flipping ms_player_engine) so recent queue/position
    // changes are persisted before the reload unloads the page.
    const m = await getPlayerModule();
    await m.flushQueue?.();
  } catch {}
  localStorage.setItem('ms_player_engine', next);
  _toggleDjSection();
  showToast('Switching engine…');
  const av = new URLSearchParams(window.location.search).get('app_version')
    || localStorage.getItem('app_installed_version');
  const params = '_=' + Date.now() + (av ? '&app_version=' + av : '');
  window.location.href = window.location.origin + '/?' + params;
}

// ── DJ Mode Settings ──

function _toggleDjSection() {
  const engine = $('#settingPlayerEngine')?.value || localStorage.getItem('ms_player_engine') || 'classic';
  // The 'crossfade' engine was removed; DJ is the only engine with mix settings now.
  const isCf = engine === 'dj';
  // Engine selector lives inside #djModeSection now, so the section is always shown.
  $$('.dj-cf-only').forEach(el => { el.style.display = isCf ? '' : 'none'; });
  $$('.dj-v3-only').forEach(el => { el.style.display = engine === 'dj' ? '' : 'none'; });
  // Show prefetch toggle (in "Playback") only for Classic player
  $$('.classic-only').forEach(el => { el.style.display = engine === 'classic' ? '' : 'none'; });
  // Load prefetch setting (toggle; localStorage stays '1'/'0' strings for player code)
  const pfEl = $('#settingPrefetchEnabled');
  if (pfEl) {
    pfEl.checked = (localStorage.getItem('ms_prefetch_enabled') || '1') === '1';
    if (!pfEl.dataset.bound) {
      pfEl.dataset.bound = '1';
      pfEl.addEventListener('change', () => {
        localStorage.setItem('ms_prefetch_enabled', pfEl.checked ? '1' : '0');
        _prefSavedStatus('deviceSaveStatus');
      });
    }
  }
}

// Each entry: localStorage suffix (after `ms_dj_`) → { sel, def, badge?, fmt? }.
// IMPORTANT: the suffix is the EXACT key the engine reads via _djSetting(suffix).
// djmix.js selection knobs are read with a literal `dj_` prefix, e.g.
// _djSetting('dj_artist_window') → ms_dj_dj_artist_window — so those suffixes
// carry the double `dj_`. Verified against grep of _djSetting() in djmix/v2/v3.
const DJ_CONFIG = {
  // Engine group (cf+dj)
  smart_queue:        { sel: '#settingDjSmartQueue',        def: 'off' },
  tempo_pref:         { sel: '#settingDjTempoPref',         def: 'auto' },
  // Transitions (cf+dj)
  crossfade_beats:    { sel: '#settingDjCrossfadeBeats',    def: '16' },
  crossfade_sec:      { sel: '#settingDjCrossfadeSec',      def: '5',  badge: '#valDjCrossfadeSec',  fmt: v => v + 's' },
  transition_style:   { sel: '#settingDjTransitionStyle',   def: 'auto' },
  intro_skip:         { sel: '#settingDjIntroSkip',         def: 'auto' },
  outro_skip:         { sel: '#settingDjOutroSkip',         def: '0' }, // auto cut endings 5-13s early — opt-in since 2026-07
  outro_fade:         { sel: '#settingDjOutroFade',         def: '1', toggle: true },
  // Tempo flow (cf+dj, advanced) — selection knobs read by djmix with `dj_` prefix
  tempo_range:        { sel: '#settingDjTempoRange',        def: '8' },
  dj_tempo_band:      { sel: '#settingDjTempoBand',         def: '8',  badge: '#valDjTempoBand' },
  dj_tempo_oob_penalty:{ sel: '#settingDjTempoOobPenalty',  def: '3',  badge: '#valDjTempoOobPenalty' },
  dj_inband_bonus:    { sel: '#settingDjInbandBonus',       def: '2',  badge: '#valDjInbandBonus' },
  dj_bpm_conf_floor:  { sel: '#settingDjBpmConfFloor',      def: '0',  badge: '#valDjBpmConfFloor' },
  dj_tempo_ramp:      { sel: '#settingDjTempoRamp',         def: '1',  badge: '#valDjTempoRamp' },
  dj_tempo_peak:      { sel: '#settingDjTempoPeak',         def: '12', badge: '#valDjTempoPeak' },
  // Energy (cf+dj, advanced)
  dj_energy_weight:   { sel: '#settingDjEnergyWeight',      def: '10', badge: '#valDjEnergyWeight' },
  dj_energy_ramp:     { sel: '#settingDjEnergyRamp',        def: '0.0375', badge: '#valDjEnergyRamp' },
  dj_energy_peak:     { sel: '#settingDjEnergyPeak',        def: '0.30', badge: '#valDjEnergyPeak' },
  dj_energy_peak_at:  { sel: '#settingDjEnergyPeakAt',      def: '8',  badge: '#valDjEnergyPeakAt' },
  dj_energy_cooldown: { sel: '#settingDjEnergyCooldown',    def: '0.02', badge: '#valDjEnergyCooldown' },
  // Harmony (cf+dj, advanced)
  dj_key_weight:      { sel: '#settingDjKeyWeight',         def: '6',  badge: '#valDjKeyWeight' },
  // Variety (cf+dj, advanced)
  dj_artist_diversity:{ sel: '#settingDjArtistDiversity',   def: '6',  badge: '#valDjArtistDiversity' },
  dj_artist_window:   { sel: '#settingDjArtistWindow',      def: '3',  badge: '#valDjArtistWindow' },
  // EQ & Filters (dj only)
  bass_swap_point:    { sel: '#settingDjBassSwapPoint',     def: '50' },
  eq_kill_depth:      { sel: '#settingDjEqKillDepth',       def: '36' },
  filter_resonance:   { sel: '#settingDjFilterResonance',   def: '2' },
  rate_return_min:    { sel: '#settingDjRateReturnMin',     def: '15', badge: '#valDjRateReturnMin', fmt: v => v + 's' },
  rate_return_scale:  { sel: '#settingDjRateReturnScale',   def: '400', badge: '#valDjRateReturnScale' },
  // Buffering (cf+dj)
  prefetch_count:     { sel: '#settingDjPrefetchCount',     def: '3' },
  pre_analyze:        { sel: '#settingDjPreAnalyze',        def: '10' },
  // level_target handled specially (toggle reveals number; '' when off)
};

function _setBadge(cfg, val) {
  if (!cfg.badge) return;
  const b = $(cfg.badge);
  if (b) b.textContent = cfg.fmt ? cfg.fmt(val) : val;
}

function _loadDjSettings() {
  for (const [key, cfg] of Object.entries(DJ_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const stored = localStorage.getItem(`ms_dj_${key}`);
    const val = (stored != null && stored !== '') ? stored : cfg.def;
    if (cfg.toggle) {
      el.checked = val === '1';
    } else {
      el.value = val;
      _setBadge(cfg, val);
    }
    if (!el.dataset.djBound) {
      el.dataset.djBound = '1';
      const ev = (el.tagName === 'SELECT' || cfg.toggle) ? 'change' : 'input';
      el.addEventListener(ev, () => {
        if (!cfg.toggle) _setBadge(cfg, el.value);
        _autoSaveDj(key, cfg.toggle ? (el.checked ? '1' : '0') : el.value);
      });
    }
  }
  // Loudness: toggle + target LUFS (writes ms_dj_level_target; '' when off)
  const lvToggle = $('#settingDjLevelMatch');
  const lvTarget = $('#settingDjLevelTarget');
  const lvRow = $('#djLevelTargetRow');
  if (lvToggle && lvTarget) {
    const stored = localStorage.getItem('ms_dj_level_target');
    const on = stored != null && stored !== '';
    lvToggle.checked = on;
    if (on) lvTarget.value = stored;
    if (lvRow) lvRow.style.display = on ? '' : 'none';
    const writeLevel = () => {
      const enabled = lvToggle.checked;
      if (lvRow) lvRow.style.display = enabled ? '' : 'none';
      const val = enabled ? (lvTarget.value || '-14') : '';
      localStorage.setItem('ms_dj_level_target', val);
      _djSavedStatus();
      getPlayerModule().then(m => m.applyDjSettings?.());
    };
    if (!lvToggle.dataset.djBound) {
      lvToggle.dataset.djBound = '1';
      lvToggle.addEventListener('change', writeLevel);
    }
    if (!lvTarget.dataset.djBound) {
      lvTarget.dataset.djBound = '1';
      lvTarget.addEventListener('input', _debounce(writeLevel, 300));
    }
  }
}

let _djSaveTimer = null;
function _debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function _djSavedStatus() {
  const status = $('#djSaveStatus');
  if (status) {
    status.textContent = 'saved ✓';
    clearTimeout(_djSaveTimer);
    _djSaveTimer = setTimeout(() => { status.textContent = ''; }, 1500);
  }
}

const _saveDjKey = _debounce((key, val) => {
  localStorage.setItem(`ms_dj_${key}`, val);
  _djSavedStatus();
  getPlayerModule().then(m => m.applyDjSettings?.());
}, 300);

function _autoSaveDj(key, val) {
  _saveDjKey(key, val);
}

// ── Generalized preference auto-save ──
// Mirrors the DJ auto-save pattern: debounced PUT + a per-section `saved ✓`
// micro-status. Each status element auto-clears after 1.5s.
const _prefStatusTimers = {};
function _prefSavedStatus(statusId, text = 'saved ✓', isErr = false) {
  const el = $('#' + statusId);
  if (!el) return;
  el.textContent = text;
  el.style.color = isErr ? 'var(--red)' : 'var(--accent)';
  clearTimeout(_prefStatusTimers[statusId]);
  _prefStatusTimers[statusId] = setTimeout(() => { el.textContent = ''; }, 1500);
}

// Build the global-settings payload from the current form (NO credentials —
// those go through the Save & Test buttons with conditional-non-empty logic).
function _buildGlobalSettingsPayload() {
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
  const dlnaUrl = $('#settingDlnaUrl').value.trim();
  payload.dlna_renderer_url = dlnaUrl;
  return payload;
}

// Apply the side effects the old global Save did (search placeholder, store).
function _applyGlobalSettings(data) {
  store.appSettings = data;
  store.searchProvider = data.search_provider || 'deezer';
  store.podcastProvider = data.podcast_provider || 'itunes';
  const providerLabels = { deezer: 'Deezer', ytmusic: 'YouTube Music', apple: 'Apple Music', spotify: 'Spotify' };
  const si = $('#searchInput');
  if (si) si.placeholder = `Search for music (${providerLabels[store.searchProvider] || store.searchProvider})...`;
}

// Debounced auto-save for a global-settings field. Admin-only (backend enforces
// require_admin on PUT /api/settings); non-admins can view but not save, so we
// skip the PUT entirely for them (mirrors the old admin-gated Save button).
const _saveGlobalPref = _debounce((statusId) => {
  if (!(store.currentUser && store.currentUser.is_admin)) return;
  apiJson('/api/settings', { method: 'PUT', body: _buildGlobalSettingsPayload() })
    .then(data => { _applyGlobalSettings(data); _prefSavedStatus(statusId); })
    .catch(() => _prefSavedStatus(statusId, 'save failed', true));
}, 400);

function _autoSavePref(statusId) {
  _saveGlobalPref(statusId);
}

// Debounced auto-save for per-device fields (any user). Reuses the
// _saveDeviceSettings payload shape (name / output_mode / dlna_renderer_url).
const _saveDevicePref = _debounce(() => {
  const name = ($('#settingDeviceName')?.value || '').trim();
  const mode = $('#settingOutputMode')?.value || 'default';
  const dlnaUrl = ($('#settingDeviceDlnaUrl')?.value || '').trim();
  apiJson(`/api/user/devices/${encodeURIComponent(store.deviceId)}`, {
    method: 'PUT',
    body: { name, output_mode: mode, dlna_renderer_url: dlnaUrl },
  }).then(() => {
    store.deviceName = name;
    store.deviceOutputMode = mode;
    store.deviceDlnaRendererUrl = dlnaUrl;
    _prefSavedStatus('deviceSaveStatus');
    _loadMyDevices();
  }).catch(() => _prefSavedStatus('deviceSaveStatus', 'save failed', true));
}, 400);

// ── Credential Save & Test (conditional-non-empty) ──
// Builds a global-settings payload that NEVER PUTs an empty secret/key, then
// re-queries settings to refresh "(set)" placeholders and shows an inline pill.
async function _saveTestCredentials(btnId, statusId, fields) {
  const btn = $('#' + btnId);
  const status = $('#' + statusId);
  if (!(store.currentUser && store.currentUser.is_admin)) {
    if (status) { status.style.display = ''; status.textContent = 'Admin only'; status.className = 'conn-status err'; }
    return;
  }
  if (btn) btn.disabled = true;
  if (status) { status.style.display = ''; status.textContent = 'Saving…'; status.className = 'conn-status'; }
  const payload = _buildGlobalSettingsPayload();
  // Conditional-non-empty: only include secrets when the user typed something,
  // so stored credentials are never wiped by an empty value.
  for (const f of fields) {
    const v = $(f.sel).value;
    if (f.secret) { if (v) payload[f.key] = v; }
    else payload[f.key] = v;
  }
  try {
    const data = await apiJson('/api/settings', { method: 'PUT', body: payload });
    _applyGlobalSettings(data);
    if (status) { status.textContent = '✓ Saved'; status.className = 'conn-status ok'; }
    // Re-query to refresh "(set)" placeholders and clear typed secrets.
    loadSettings();
  } catch (e) {
    if (status) { status.textContent = e.message || 'Failed'; status.className = 'conn-status err'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Password reveal (eye) toggles ──
function _bindReveals() {
  $$('.btn-reveal').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const inp = $('#' + btn.dataset.reveal);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });
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
          loadDiskUsage();
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

// ── Feedback & Reports (admin triage) ──
let _fbObjectUrls = []; // screenshot blob URLs from the current render — revoked before the next one
let _fbGen = 0; // render-generation counter — guards against a stale thumbnail fetch
                // (from a previous loadFeedback() call) resolving after _fbObjectUrls
                // has been reset and assigning to a since-detached <img>.

function _revokeFeedbackThumbs() {
  _fbObjectUrls.forEach(u => URL.revokeObjectURL(u));
  _fbObjectUrls = [];
}

function _renderFeedbackRow(r, ghOk) {
  const kindPill = r.kind === 'feature'
    ? '<span class="fb-pill fb-pill-feature">Feature</span>'
    : '<span class="fb-pill fb-pill-bug">Bug</span>';
  const ctx = r.context || {};
  const when = r.created_at ? new Date(r.created_at * 1000).toLocaleString() : ''; // backend stores time.time() (Unix seconds)
  const metaParts = [];
  if (r.reporter) metaParts.push('by ' + esc(r.reporter));
  if (ctx.page) metaParts.push(esc(ctx.page));
  if (ctx.version) metaParts.push('v' + esc(ctx.version));
  if (when) metaParts.push(when);
  const thumb = r.has_screenshot
    ? `<img class="fb-thumb-sm" data-id="${escAttr(r.id)}" alt="Screenshot" title="Click to view full-size">`
    : '';
  let actions;
  // "promoted" no longer implies issue_url is present — a promote call can
  // succeed on GitHub's side but fail to record/read the resulting URL
  // (the `warning` case in _promoteFeedback), leaving status=promoted with
  // no link. Keep `promoted` keyed on status alone so that row still reads
  // as promoted (pill, non-clickable) instead of falling through to a
  // "Create issue" button that would 409 against the backend.
  const promoted = r.status === 'promoted';
  const promoting = r.status === 'promoting';
  if (promoted) {
    // issue_url only ever comes from GitHub's html_url today, but this is an
    // admin-session href — allowlist the scheme so a compromised/odd value
    // can't become a javascript: link.
    const safeUrl = /^https:\/\/github\.com\//.test(r.issue_url || '') ? r.issue_url : '';
    actions = `<span class="fb-pill fb-pill-promoted">Promoted</span>` +
      (safeUrl ? `<a class="fb-issue-link" href="${escAttr(safeUrl)}" target="_blank" rel="noopener">View issue</a>` : '');
  } else if (promoting) {
    // "promoting" is set while the GitHub call is in flight; the backend
    // treats claims older than 5 minutes as reclaimable (crashed/stuck
    // request), so only gate the Retry button on that same window.
    const ageSec = r.promoting_since ? (Date.now() / 1000 - r.promoting_since) : Infinity;
    const stale = ageSec > 300;
    actions = `<span class="fb-pill fb-pill-promoting">${stale ? 'Stuck' : 'In progress…'}</span>
      <button class="fb-btn fb-btn-promote" data-id="${escAttr(r.id)}" ${stale ? '' : 'disabled'}>Retry</button>`;
  } else if (!ghOk) {
    actions = `<span class="fb-gh-hint">Set GITHUB_TOKEN to enable</span>`;
  } else {
    actions = `<button class="fb-btn fb-btn-promote" data-id="${escAttr(r.id)}">Create issue</button>`;
  }
  return `
    <div class="fb-row" data-row-id="${escAttr(r.id)}">
      ${thumb}
      <div class="fb-row-main">
        <div class="fb-row-title-line">${kindPill} <span class="fb-title">${esc(r.title)}</span></div>
        <div class="fb-meta">${metaParts.join(' &middot; ')}</div>
        ${r.description ? `<div class="fb-desc fb-desc-clamp">${esc(r.description)}</div>` : ''}
      </div>
      <div class="fb-row-actions">
        ${actions}
        <button class="fb-btn fb-btn-delete" data-id="${escAttr(r.id)}" data-promoted="${promoted ? '1' : '0'}">Delete</button>
      </div>
    </div>`;
}

export async function loadFeedback() {
  const container = $('#feedbackList');
  if (!container) return;
  const gen = ++_fbGen; // this render's generation — see _fbGen declaration above
  container.innerHTML = '<div class="skeleton" style="height:80px;"></div>';
  _revokeFeedbackThumbs();
  try {
    const data = await apiJson('/api/feedback');
    if (gen !== _fbGen) return; // a newer loadFeedback() call superseded this one
    const reports = data.reports || [];
    if (!reports.length) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No reports yet.</div>';
      return;
    }
    const ghOk = !!data.github_configured;
    container.innerHTML = reports.map(r => _renderFeedbackRow(r, ghOk)).join('');
    // Lazy-load screenshot thumbnails as blobs — the endpoint requires the
    // Authorization header, so a plain <img src> would 401.
    $$('.fb-thumb-sm', container).forEach(img => {
      const id = img.dataset.id;
      if (!id) return;
      apiFetch(`/api/feedback/${id}/screenshot`)
        .then(res => (res.ok ? res.blob() : null))
        .then(blob => {
          if (!blob || gen !== _fbGen) return; // stale — a fresh render already reset _fbObjectUrls
          const url = URL.createObjectURL(blob);
          _fbObjectUrls.push(url);
          img.src = url;
          img._fbBlob = blob; // kept so a click can mint its own untracked URL — see below
        })
        .catch(() => {});
      // Click-to-enlarge: open the full-size screenshot in a new tab. Deliberately
      // mints a FRESH, untracked object URL rather than reusing img.src's — that
      // one gets revoked by the next _revokeFeedbackThumbs() (promote/delete both
      // call loadFeedback()), which would blank an already-open tab out from
      // under the admin mid-review. This one is intentionally never revoked; it
      // leaks until the tab is closed, which is the accepted tradeoff.
      img.addEventListener('click', () => { if (img._fbBlob) window.open(URL.createObjectURL(img._fbBlob), '_blank'); });
    });
    $$('.fb-btn-promote', container).forEach(btn => {
      btn.addEventListener('click', () => _promoteFeedback(btn, btn.dataset.id));
    });
    $$('.fb-btn-delete', container).forEach(btn => {
      btn.addEventListener('click', () => _deleteFeedback(btn, btn.dataset.id, btn.dataset.promoted === '1'));
    });
    $$('.fb-desc-clamp', container).forEach(el => {
      el.addEventListener('click', () => el.classList.toggle('fb-desc-open'));
    });
  } catch (e) {
    if (gen !== _fbGen) return;
    container.innerHTML = `<div style="color:#e74c3c;font-size:13px;">Failed to load: ${esc(e.message)}</div>`;
  }
}

async function _promoteFeedback(btn, id) {
  // Promotion is permanent and public: the description + screenshot get
  // committed to github.com/lucashanak/music-seeker and stay in git history
  // even if the report/issue is later deleted. Confirm before firing.
  const ok = await showConfirmModal(
    'Publish to the public GitHub repo?',
    'The description and any screenshot become permanently public at github.com/lucashanak/music-seeker and stay in git history even if the issue is deleted. Open the screenshot full-size and check it contains nothing private first.',
    { okLabel: 'Publish', danger: true }
  );
  if (!ok) return;
  const origLabel = btn ? btn.textContent : 'Create issue'; // "Create issue" or "Retry" — restore whichever on failure
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const resp = await apiJson(`/api/feedback/${id}/promote`, { method: 'POST', body: {} });
    if (resp && resp.warning) {
      // Issue was created on GitHub but we couldn't record/read its URL —
      // that's not a plain success, so surface it as an error-styled toast
      // instead of silently discarding it (loadFeedback() will still show
      // the row as promoted, just without a link — see _renderFeedbackRow).
      showToast(resp.warning, true);
    } else {
      showToast('Issue created');
    }
    loadFeedback();
  } catch (e) {
    showToast(e.message || 'Failed to create issue', true);
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
  }
}

async function _deleteFeedback(btn, id, promoted) {
  const msg = promoted
    ? 'This cannot be undone. The GitHub issue and screenshot commit will remain public.'
    : 'This cannot be undone.';
  const ok = await showConfirmModal('Delete report?', msg);
  if (!ok) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    await apiJson(`/api/feedback/${id}`, { method: 'DELETE' });
    showToast('Report deleted');
    loadFeedback();
  } catch (e) {
    showToast(e.message || 'Failed to delete', true);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}

// ── Init ──
export function init() {
  $('#settingSearchProvider').addEventListener('change', updateFallbackNote);
  $('#settingSearchFallback').addEventListener('change', updateFallbackNote);

  // ── Auto-save: global settings (admin-only; backend enforces require_admin) ──
  // Downloads section → #downloadsSaveStatus
  ['#settingSearchProvider', '#settingSearchFallback', '#settingPodcastProvider',
   '#settingMethod', '#settingFormat', '#settingMaxConcurrent'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => _autoSavePref('downloadsSaveStatus'));
  });
  // Recommendations section → #recommendationsSaveStatus
  $('#settingRecommendation')?.addEventListener('change', () => _autoSavePref('recommendationsSaveStatus'));
  // Casting: global DLNA renderer url → #castingSaveStatus
  $('#settingDlnaUrl')?.addEventListener('input', () => _autoSavePref('castingSaveStatus'));

  // ── Auto-save: per-device fields (any user) → #deviceSaveStatus ──
  $('#settingDeviceName')?.addEventListener('input', _saveDevicePref);
  $('#settingDeviceDlnaUrl')?.addEventListener('input', _saveDevicePref);

  // ── URL/user fields for Library and Download Sources (admin-gated auto-save) ──
  $('#settingNavidromeUrl')?.addEventListener('input', () => _autoSavePref('navidromeConnStatus'));
  $('#settingNavidromeUser')?.addEventListener('input', () => _autoSavePref('navidromeConnStatus'));
  $('#settingSlskdUrl')?.addEventListener('input', () => _autoSavePref('slskdConnStatus'));

  // ── Credential Save (conditional-non-empty) ──
  $('#saveTestNavidrome')?.addEventListener('click', () => _saveTestCredentials(
    'saveTestNavidrome', 'navidromeConnStatus',
    [{ sel: '#settingNavidromePass', key: 'navidrome_password', secret: true }]
  ));
  $('#saveTestSlskd')?.addEventListener('click', () => _saveTestCredentials(
    'saveTestSlskd', 'slskdConnStatus',
    [{ sel: '#settingSlskdKey', key: 'slskd_api_key', secret: true }]
  ));

  // Password reveal (eye) toggles
  _bindReveals();

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

  // Device settings — output mode toggles the DLNA row and auto-saves.
  // DJ settings auto-save (debounced) — bound per-control in _loadDjSettings().
  $('#settingOutputMode')?.addEventListener('change', () => {
    store.deviceOutputMode = $('#settingOutputMode').value;
    _toggleDeviceDlnaRow();
    _saveDevicePref();
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

  // Update checker is now in inline script in index.html (no module dependency)

  // Store version when downloading app from Settings links
  document.querySelectorAll('#desktopAppSection a[href*="/releases/"]').forEach(a => {
    a.addEventListener('click', async () => {
      try {
        const res = await fetch('https://api.github.com/repos/lucashanak/music-seeker/releases/latest');
        if (res.ok) {
          const r = await res.json();
          localStorage.setItem('app_version', r.tag_name.replace(/^v/, ''));
        }
      } catch(e) {}
    });
  });

  // Refresh (cache only, keep login) — preserve app_version param
  $('#refreshCacheBtn').addEventListener('click', async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch(e) {}
    const av = new URLSearchParams(window.location.search).get('app_version') || localStorage.getItem('app_installed_version');
    const params = '_=' + Date.now() + (av ? '&app_version=' + av : '');
    window.location.href = window.location.origin + '/?' + params;
  });

  // Clear All & Logout — preserve app installed version
  $('#clearCacheBtn').addEventListener('click', async () => {
    const appVer = localStorage.getItem('app_installed_version');
    const deviceId = localStorage.getItem('ms_device_id');
    try {
      localStorage.clear();
      sessionStorage.clear();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch(e) {}
    if (appVer) localStorage.setItem('app_installed_version', appVer);
    if (deviceId) localStorage.setItem('ms_device_id', deviceId);
    const params = '_=' + Date.now() + (appVer ? '&app_version=' + appVer : '');
    window.location.href = window.location.origin + '/?' + params;
  });

  // Disk Usage
  $('#refreshDiskUsage').addEventListener('click', loadDiskUsage);
  $('#diskUsageSection').addEventListener('toggle', (e) => {
    if (e.target.open) loadDiskUsage();
  });

  // Feedback & Reports
  $('#refreshFeedback')?.addEventListener('click', loadFeedback);
  $('#feedbackSection')?.addEventListener('toggle', (e) => {
    if (e.target.open) loadFeedback();
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
