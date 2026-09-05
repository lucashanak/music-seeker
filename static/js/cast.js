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

// Resolve the renderer the user actually chose.
//
// The stored preference is a descriptor URL (the backend also accepts it as a manual
// renderer, so the field has to stay a URL) — and that URL embeds the renderer's IP.
// A DHCP lease change therefore invalidates the setting: the Onkyo moved from
// 192.168.1.95 to 192.168.1.45 and the saved URL matched nothing, so casting silently
// fell through to devices[0] — the projector. Picking a DIFFERENT device than the one
// the user chose is never a reasonable answer, so this resolves generously and then
// refuses rather than guessing.
//
// The per-device URL only counts in dlna_only mode: that is the only mode whose UI
// shows the field (#deviceDlnaRow is hidden otherwise), and an invisible value must not
// override the app-wide picker the user CAN see.
function _savedRendererPref() {
  const perDevice = store.deviceOutputMode === 'dlna_only' ? (store.deviceDlnaRendererUrl || '') : '';
  return perDevice || (store.appSettings && store.appSettings.dlna_renderer_url) || '';
}

function _resolveRenderer(devices, saved) {
  if (!saved) return null;
  // Stable UPnP UDN, if the preference was ever stored as an id.
  let d = devices.find(x => x.id === saved);
  if (d) return d;
  // Exact descriptor URL — the normal case, while the IP still holds.
  d = devices.find(x => x.location === saved);
  if (d) return d;
  // Same port and descriptor path on another host: the renderer moved to a new IP.
  // Only accept it when exactly one device matches, so a pair of identical renderers
  // can never be silently confused for one another.
  try {
    const want = new URL(saved);
    const hits = devices.filter(x => {
      try { const u = new URL(x.location); return u.port === want.port && u.pathname === want.pathname; }
      catch { return false; }
    });
    if (hits.length === 1) return hits[0];
  } catch { /* not a URL — nothing more to try */ }
  return null;
}

// ── Shared flags ──
// Set by the ENGINE's loadAndPlay/nextTrack/prevTrack cast branches and read by the
// poll. Must be a shared object (live binding) so cross-module writes are visible here.
export const castState = { skipAutoAdvance: false, transitioning: false };
let _castTransitionTimer = null;
// Cast-stall tracking: when the last cast was issued, and whether the renderer has
// actually reported PLAYING since. A renderer that silently never starts the track is
// the "DLNA stops between tracks" failure — the app told it to play and then waited
// forever, because BOTH latches below are only released by seeing PLAYING.
let _castIssuedAt = 0, _castSawPlaying = false, _castRetried = false;

// Suppress the disconnect branch for a window while a track change is in flight, and
// arm the stall clock. Both latches get a hard expiry: skipAutoAdvance in particular
// used to be released ONLY by a PLAYING state, so one track the renderer never started
// disabled auto-advance for the rest of the session — every later track then "ended"
// with nothing happening.
export function markCastTransition(ms = 20000) {
  castState.transitioning = true;
  _castIssuedAt = Date.now();
  _castSawPlaying = false;
  _castRetried = false;
  clearTimeout(_castTransitionTimer);
  _castTransitionTimer = setTimeout(() => {
    castState.transitioning = false;
    castState.skipAutoAdvance = false;
  }, ms);
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
    const savedUrl = _savedRendererPref();
    const device = savedUrl ? _resolveRenderer(devices, savedUrl) : devices[0];
    if (!device) {
      showToast('Chosen DLNA renderer not found on the network — check Settings');
      return;
    }
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
    const savedUrl = _savedRendererPref();
    if (savedUrl) {
      const savedDevice = _resolveRenderer(devices, savedUrl);
      if (!savedDevice) {
        showToast('Chosen DLNA renderer not found on the network — check Settings');
        return;
      }
      castToDevice(savedDevice);
    } else {
      // No stated preference — unchanged behaviour: take the first renderer found.
      castToDevice(devices[0]);
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
        _castSawPlaying = true;
        _castIssuedAt = 0;   // it started; the stall clock is done
        _castWasPlaying = true;
        if (dur > 0) _castLastDur = dur;
        if (pos > 0) _castLastPos = pos;
      }
      // A cast was issued and the renderer never reached PLAYING. Nothing else in the
      // poll reacts to that: end-of-track detection needs a preceding PLAYING, so the
      // session just sits there and the queue stops. Re-issue once (the renderer may
      // have dropped the SetAVTransportURI), then give the track up and move on.
      if (_castIssuedAt && !_castSawPlaying && store.castDevice) {
        const waited = Date.now() - _castIssuedAt;
        if (waited > 15000 && !_castRetried) {
          _castRetried = true;
          const it = store.playerQueue[store.playerIndex];
          if (it) {
            apiJson('/api/dlna/cast', { method: 'POST', body: {
              device_id: store.castDevice.id, name: it.name || '', artist: it.artist || '',
              album: it.album || '', image: it.image || '', duration_ms: it.duration_ms || 0,
            }}).catch(() => {});
          }
        } else if (waited > 30000) {
          _castIssuedAt = 0;
          _castWasPlaying = false; _castLastPos = 0; _castLastDur = 0;
          castState.skipAutoAdvance = false;
          _ctx.nextTrack();
          return;
        }
      }
      // Auto-advance on a real end-of-track: we were playing (possibly via TRANSITIONING),
      // now stopped/no_media, observed real progress, and reached near the end. If the
      // duration is unknown, advance on any playing→stopped after progress.
      const ended = _castWasPlaying && (state.includes('stopped') || state.includes('no_media'));
      const sawProgress = _castLastPos > 1;
      // "Near the end" has to tolerate a stale tail. The last position we can observe is
      // whatever the renderer reported on the last successful poll, and that sample can
      // be far from the real end: each status query makes three UPnP calls with 3s
      // timeouts, and a `stale` tick updates nothing at all — precisely what happens at
      // the end of a track, when the renderer is busy finishing and loading. A fixed 12s
      // window therefore missed real end-of-track stops and the queue simply halted.
      // A percentage floor covers the long gap; the absolute one still covers short
      // tracks. Stopping the renderer by hand inside the last 15% now advances instead
      // of stopping — a far cheaper mistake than silently ending the session.
      const nearEnd = _castLastDur === 0
        || _castLastPos >= _castLastDur - 12
        || _castLastPos >= _castLastDur * 0.85;
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
