// cast.js — shared DLNA cast cluster for all three player engines.
//
// This logic was triplicated byte-for-byte across player.js / player_v2.js /
// player_v3.js (the only per-engine difference was the active audio element). It now
// lives here once. Engines inject their specifics via initCast({ getAudioEl, nextTrack })
// and call wireControls() in init(). cast.js imports only leaf utils (no engine import),
// so there is no circular dependency.

import { store } from './store.js';
import { $, fmtTime, showToast } from './utils.js';
import { apiJson } from './api.js';

// ── Engine-injected context ──
let _ctx = { getAudioEl: () => null, nextTrack: () => {} };
export function initCast(ctx) { _ctx = { ..._ctx, ...ctx }; }

// Fetch known renderers; if none are known yet (cold start / no prior scan), kick a
// one-shot LAN scan so casting works without the user opening Settings → Scan first.
// The backend also runs a periodic background scan, so this is usually a no-op.
async function _getDevicesOrScan() {
  const data = await apiJson('/api/dlna/devices');
  let devices = data.devices || [];
  if (!devices.length) {
    try {
      const scan = await apiJson('/api/dlna/scan', { method: 'POST' });
      devices = scan.devices || [];
    } catch { /* fall through with empty list */ }
  }
  return devices;
}

// ── Shared flags ──
// Set by the ENGINE's loadAndPlay/nextTrack/prevTrack cast branches and read by the
// poll. Must be a shared object (live binding) so cross-module writes are visible here.
export const castState = { skipAutoAdvance: false, transitioning: false };
let _castTransitionTimer = null;
// Suppress the disconnect branch for a window while a track change is in flight.
export function markCastTransition(ms = 20000) {
  castState.transitioning = true;
  clearTimeout(_castTransitionTimer);
  _castTransitionTimer = setTimeout(() => { castState.transitioning = false; }, ms);
}

// ── Private poll state ──
let _castLastState = '';
let _castLastDur = 0;     // last non-zero duration seen while casting (renderers zero it at STOP)
let _castLastPos = 0;     // last non-zero position seen while casting
let _castWasPlaying = false; // latched true while playing; survives the TRANSITIONING blip before STOP
let _castPollFails = 0;      // consecutive cast-status poll failures (teardown after a few)
let _castVolTimer = null;    // debounce timer for the cast volume slider

export function syncCastButtons(color) {
  ['#playerCastBtn', '#fpCastBtn'].forEach(sel => {
    const btn = $(sel);
    if (btn) btn.style.color = color;
  });
  // Toggle volume sliders: show DLNA volume in cast mode, local volume otherwise
  const isCasting = color && color !== '';
  const castVol = $('#fpCastVol');
  if (castVol) castVol.style.display = isCasting ? '' : 'none';
  const localVol = document.querySelector('.fp-vol-wrap');
  if (localVol) localVol.style.display = isCasting ? 'none' : '';
}

// DLNA Only mode: auto-connect to a renderer and cast the current item.
export async function autoCastAndPlay(item, cleanName, cleanArtist) {
  try {
    const devices = await _getDevicesOrScan();
    if (!devices.length) { showToast('No DLNA devices found. Configure in Settings.'); return; }
    const savedUrl = store.deviceDlnaRendererUrl || store.appSettings.dlna_renderer_url || '';
    const device = (savedUrl && devices.find(d => d.location === savedUrl)) || devices[0];
    store.castDevice = device;
    castState.skipAutoAdvance = true;
    markCastTransition(); // arms a 20s safety clear so a stuck transition can't block forever
    await apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: device.id, name: cleanName, artist: cleanArtist,
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }});
    _ctx.getAudioEl()?.pause();
    syncCastButtons('var(--accent)');
    startCastPoll();
  } catch (e) {
    castState.transitioning = false;
    showToast('DLNA auto-cast failed: ' + (e.message || ''));
  }
}

export async function castToDevice(device) {
  const item = store.playerQueue[store.playerIndex];
  if (!item) return;
  try {
    await apiJson('/api/dlna/cast', { method: 'POST', body: {
      device_id: device.id, name: item.name || '', artist: item.artist || '',
      album: item.album || '', image: item.image || '', duration_ms: item.duration_ms || 0,
    }});
    store.castDevice = device;
    _ctx.getAudioEl()?.pause();
    syncCastButtons('var(--accent)');
    showToast(`Casting to ${device.name}`);
    startCastPoll();
  } catch (e) {
    showToast('Cast failed: ' + (e.message || ''));
  }
}

export async function stopCast() {
  await apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
  store.castDevice = null;
  clearInterval(store.castPollTimer);
  store.castPollTimer = null;
  syncCastButtons('');
}

async function handleCastClick() {
  if (store.deviceOutputMode === 'local') return;
  if (store.castDevice) {
    await stopCast();
    showToast('Cast stopped');
    return;
  }
  try {
    showToast('Searching for cast devices…');
    const devices = await _getDevicesOrScan();
    if (!devices.length) { showToast('No DLNA devices found. Configure in Settings.'); return; }
    if (devices.length === 1) {
      castToDevice(devices[0]);
    } else {
      const savedUrl = store.deviceDlnaRendererUrl || store.appSettings.dlna_renderer_url || '';
      const savedDevice = savedUrl ? devices.find(d => d.location === savedUrl) : null;
      castToDevice(savedDevice || devices[0]);
    }
  } catch (e) {
    showToast('Cast failed: ' + (e.message || ''));
  }
}

export function startCastPoll() {
  clearInterval(store.castPollTimer);
  _castLastState = '';
  _castLastDur = 0;
  _castLastPos = 0;
  _castWasPlaying = false;
  _castPollFails = 0;
  store.castPollTimer = setInterval(async () => {
    if (!store.castDevice) { clearInterval(store.castPollTimer); return; }
    if (store.deviceOutputMode === 'local') {
      // User switched to local output mid-cast — stop the renderer and end the poll.
      store.castDevice = null; syncCastButtons(''); clearInterval(store.castPollTimer);
      apiJson('/api/dlna/stop', { method: 'POST' }).catch(() => {});
      return;
    }
    try {
      const status = await apiJson('/api/dlna/status');
      if (status.stale) return; // transient backend query failure — skip tick, keep last state
      if (!status.active && !castState.transitioning) {
        if (status.state === 'TRANSITIONING') return;
        store.castDevice = null; syncCastButtons(''); clearInterval(store.castPollTimer); return;
      }
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
      // Sync cast volume slider
      if (status.volume !== undefined) {
        const cvs = $('#fpCastVolume');
        const cvl = $('#fpCastVolLabel');
        if (cvs && !cvs.matches(':active')) { cvs.value = status.volume; }
        if (cvl) cvl.textContent = status.volume + '%';
      }
      // Detect track end. The Onkyo goes PLAYING → TRANSITIONING → STOPPED and zeros
      // position (keeps duration) at STOP, so we (a) LATCH "was playing" across the
      // TRANSITIONING blip and (b) compare against the last good position/duration
      // captured while playing — never the zeroed stopped frame.
      const state = (status.state || '').toLowerCase();
      if (state.includes('playing')) {
        castState.skipAutoAdvance = false;
        castState.transitioning = false;
        _castWasPlaying = true;
        if (dur > 0) _castLastDur = dur;
        if (pos > 0) _castLastPos = pos;
      }
      // Auto-advance on a real end-of-track: we were playing (possibly via TRANSITIONING),
      // now stopped/no_media, observed real progress, and reached near the end. If the
      // duration is unknown, advance on any playing→stopped after progress.
      const ended = _castWasPlaying && (state.includes('stopped') || state.includes('no_media'));
      const sawProgress = _castLastPos > 1;
      const nearEnd = _castLastDur === 0 || _castLastPos >= _castLastDur - 12;
      if (!castState.skipAutoAdvance && ended && sawProgress && nearEnd) {
        _castWasPlaying = false; _castLastPos = 0; _castLastDur = 0;
        _ctx.nextTrack();
      }
      _castLastState = state;
      _castPollFails = 0;
    } catch {
      // Tolerate transient status errors; tear down only after sustained failure.
      if (++_castPollFails >= 5) {
        _castPollFails = 0; store.castDevice = null; syncCastButtons('');
        clearInterval(store.castPollTimer);
      }
    }
  }, 2000);
}

// Wire the cast button(s) and the cast volume slider. Call once from each engine's init().
export function wireControls() {
  const castBtn = $('#playerCastBtn');
  if (castBtn) castBtn.addEventListener('click', handleCastClick);
  if ($('#fpCastBtn')) $('#fpCastBtn').addEventListener('click', handleCastClick);

  const castVolSlider = $('#fpCastVolume');
  if (castVolSlider) {
    castVolSlider.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value);
      const label = $('#fpCastVolLabel');
      if (label) label.textContent = vol + '%';
      if (store.castDevice) {
        clearTimeout(_castVolTimer);
        _castVolTimer = setTimeout(() => { if (store.castDevice) apiJson('/api/dlna/volume', { method: 'POST', body: { volume: vol } }).catch(() => {}); }, 150);
      }
    });
  }
}
