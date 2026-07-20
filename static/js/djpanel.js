// djpanel.js — Live DJ quick-control drawer inside the full player.
//
// Surfaces a CURATED subset of the Settings DJ knobs so a DJ mixing live can
// tweak them without leaving the player. SINGLE SOURCE OF TRUTH: every control
// reads from and writes to the SAME `ms_dj_*` localStorage keys the engine reads
// via _djSetting(), so the panel and Settings stay perfectly consistent.
//
// Only visible when the active engine is 'dj' (ms_player_engine === 'dj').

import { $ } from './utils.js';
import { store } from './store.js';
import { getPlayerModule } from './player_active.js';
import { switchPage } from './router.js';
import { closeFullPlayer } from './fullplayer.js';
import { preloadSet, clearPreload, preloadStatus, cleanup as prefetchCleanup } from './prefetch.js';

// Curated controls. `key` is the EXACT localStorage suffix after `ms_dj_`
// (i.e. the literal _djSetting() argument the engine reads).
// NOTE the double `dj_` on energy: the engine reads it via
// _djSetting('dj_energy_weight') → localStorage key `ms_dj_dj_energy_weight`.
const PANEL_CONFIG = {
  smart_queue:      { sel: '#fpDjSmartQueue',      def: 'off' },
  tempo_pref:       { sel: '#fpDjTempoPref',       def: 'auto' },
  crossfade_beats:  { sel: '#fpDjCrossfadeBeats',  def: '16' },
  transition_style: { sel: '#fpDjTransitionStyle', def: 'auto' },
  dj_energy_weight: { sel: '#fpDjEnergyWeight',    def: '10', badge: '#fpValDjEnergyWeight' },
};

let _savedTimer = null;
function _savedStatus() {
  const el = $('#fpDjSavedStatus');
  if (!el) return;
  el.textContent = 'saved ✓';
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(() => { el.textContent = ''; }, 1500);
}

// Per-key debounce timers — each control debounces independently so rapid changes
// to different knobs never coalesce and no write is silently dropped.
const _keyTimers = new Map();
function _writeKey(key, val) {
  clearTimeout(_keyTimers.get(key));
  _keyTimers.set(key, setTimeout(() => {
    _keyTimers.delete(key);
    localStorage.setItem(`ms_dj_${key}`, val);
    _savedStatus();
    getPlayerModule().then(m => m.applyDjSettings?.());
  }, 300));
}

// ── Preload set ─────────────────────────────────────────────────────────────
// Download the whole forward queue into device memory (pinned) so the deck plays
// from memory and a flaky venue link can't interrupt the set. Polls preloadStatus()
// while active to show progress + a ~MB footprint estimate.
let _preloadActive = false;
let _preloadTimer = null;

function _fmtMB(bytes) { return (bytes / 1e6).toFixed(1); }

function _renderPreloadStatus() {
  const el = $('#fpDjPreloadStatus');
  const btn = $('#fpDjPreloadBtn');
  if (!el) return;
  const { total, done, bytes } = preloadStatus();
  if (!_preloadActive || total === 0) { el.textContent = ''; return; }
  const mb = _fmtMB(bytes);
  if (done >= total) {
    el.textContent = `Set ready ✓ · ~${mb} MB`;
    if (btn) btn.textContent = 'Clear ✕';
    // Done — stop polling but keep the pins (blobs stay in memory for the set).
    _stopPreloadPoll();
  } else {
    el.textContent = `Preloaded ${done}/${total} · ~${mb} MB`;
    if (btn) btn.textContent = 'Clear ✕';
  }
}

function _stopPreloadPoll() {
  if (_preloadTimer) { clearInterval(_preloadTimer); _preloadTimer = null; }
}

function _startPreload() {
  _preloadActive = true;
  preloadSet(store.playerQueue, store.playerIndex);
  _stopPreloadPoll();
  _preloadTimer = setInterval(_renderPreloadStatus, 500);
  _renderPreloadStatus();
}

function _stopPreload() {
  _preloadActive = false;
  _stopPreloadPoll();
  clearPreload();
  prefetchCleanup(store.playerQueue, store.playerIndex);
  const el = $('#fpDjPreloadStatus');
  if (el) el.textContent = '';
  const btn = $('#fpDjPreloadBtn');
  if (btn) btn.textContent = 'Preload set';
}

function _togglePreload() {
  _preloadActive ? _stopPreload() : _startPreload();
}

// Pull current values from localStorage into the panel controls. Called on every
// open so the panel reflects any change made in Settings since last time.
export function syncDjPanel() {
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const stored = localStorage.getItem(`ms_dj_${key}`);
    const val = (stored != null && stored !== '') ? stored : cfg.def;
    el.value = val;
    if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = val; }
  }
}

function _isDjEngine() {
  return (localStorage.getItem('ms_player_engine') || 'classic') === 'dj';
}

let _isOpen = false;

// Synchronous flag read by router.js Esc handler BEFORE any async work.
// Set/cleared in open/close so the decision is always coherent with the DOM state.
export function isDjPanelOpen() { return _isOpen; }

function openDjPanel() {
  if (!_isDjEngine()) return;
  syncDjPanel();
  $('#fpDjBackdrop')?.classList.add('open');
  const panel = $('#fpDjPanel');
  if (panel) { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); }
  const btn = $('#fpDjPanelBtn');
  if (btn) { btn.classList.add('active'); btn.setAttribute('aria-expanded', 'true'); }
  _isOpen = true;
  window.__djPanelOpen = true;
  // Resume preload status polling if a preload is still active from a prior open.
  if (_preloadActive) {
    _stopPreloadPoll();
    _preloadTimer = setInterval(_renderPreloadStatus, 500);
    _renderPreloadStatus();
  }
  // OPT: move focus to close button for keyboard accessibility
  setTimeout(() => $('#fpDjPanelClose')?.focus(), 50);
}

function closeDjPanel() {
  $('#fpDjBackdrop')?.classList.remove('open');
  const panel = $('#fpDjPanel');
  if (panel) { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); }
  const btn = $('#fpDjPanelBtn');
  if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false'); }
  _isOpen = false;
  window.__djPanelOpen = false;
  // Stop polling preloadStatus while the drawer is hidden — the preload itself
  // keeps running in prefetch.js (pins survive); we just pause the UI updates and
  // resume rendering on the next open.
  _stopPreloadPoll();
  // OPT: restore focus to trigger button
  $('#fpDjPanelBtn')?.focus();
}

// Exported so router.js can close the drawer after its synchronous flag check.
export function closeDjPanelFromRouter() { closeDjPanel(); }

function toggleDjPanel() {
  _isOpen ? closeDjPanel() : openDjPanel();
}

// Open Settings and expand+scroll the Playback (DJ) <details> section.
function openSettingsDjSection() {
  closeDjPanel();
  // The full player is a fixed full-screen overlay; close it too or the Settings
  // page switches UNDERNEATH it and stays invisible (this was the "More in Settings
  // does nothing" bug).
  try { closeFullPlayer(); } catch (e) {}
  switchPage('settings');
  setTimeout(() => {
    const sec = $('#djModeSection');
    if (sec) {
      sec.open = true;
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 60);
}

// Show or hide buttons based on the active engine. Safe to call anytime.
// The DJ engine's quick-control panel owns Smart Queue (ms_dj_smart_queue), so the
// legacy #fpDjMode cycle button is always hidden now — it only ever showed for the
// removed 'crossfade' engine.
export function refreshDjPanelVisibility() {
  const engine = localStorage.getItem('ms_player_engine') || 'classic';
  const isDj = engine === 'dj';

  const panelBtn = $('#fpDjPanelBtn');
  if (panelBtn) panelBtn.style.display = isDj ? '' : 'none';

  const cycleBtn = $('#fpDjMode');
  if (cycleBtn) cycleBtn.style.display = 'none';

  if (!isDj && _isOpen) closeDjPanel();
}

export function init() {
  const btn = $('#fpDjPanelBtn');
  if (!btn) return; // markup absent — nothing to wire

  refreshDjPanelVisibility();

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleDjPanel(); });
  $('#fpDjPanelClose')?.addEventListener('click', closeDjPanel);
  $('#fpDjBackdrop')?.addEventListener('click', closeDjPanel);
  $('#fpDjMoreSettings')?.addEventListener('click', openSettingsDjSection);
  $('#fpDjPreloadBtn')?.addEventListener('click', (e) => { e.stopPropagation(); _togglePreload(); });

  // Esc is owned exclusively by router.js (synchronous flag check via window.__djPanelOpen).
  // No local keydown listener here — avoids the race where djpanel's handler fires
  // after router's, flips _isOpen to false, then router's async callback sees false
  // and also closes the player.

  // FIX 3: re-sync panel controls when Settings changes a ms_dj_* key while the
  // drawer may be open. Two sources:
  // a) cross-tab: the 'storage' event fires when another tab writes localStorage.
  // b) same-tab: the page regains focus (user went to Settings page in a new tab,
  //    or returned focus to the window). document 'visibilitychange' covers this.
  //    openFullPlayer() in fullplayer.js also calls syncDjPanel() on re-entry for
  //    the in-app navigation case (Settings → back to full player).
  window.addEventListener('storage', (e) => {
    if (_isOpen && e.key && e.key.startsWith('ms_dj_')) syncDjPanel();
  });
  document.addEventListener('visibilitychange', () => {
    if (_isOpen && document.visibilityState === 'visible') syncDjPanel();
  });

  // Wire each control to the shared ms_dj_* key.
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = el.value; }
      _writeKey(key, el.value);
    });
  }
}
