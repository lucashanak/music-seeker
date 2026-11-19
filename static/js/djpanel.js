// djpanel.js — Live DJ quick-control drawer inside the full player.
//
// Surfaces a CURATED subset of the Settings DJ knobs so a DJ mixing live can
// tweak them without leaving the player. SINGLE SOURCE OF TRUTH: every control
// reads from and writes to the SAME `ms_dj_*` localStorage keys the engine reads
// via _djSetting(), so the panel and Settings stay perfectly consistent.
//
// Only visible when the active engine is 'dj' (ms_player_engine === 'dj').
//
// Under remote control (store.remoteTarget) the panel is a READ-ONLY mirror of the
// target's DJ profile as it reports it (`dev.engine`, `dev.dj`): DJ settings belong to
// the device that plays, so knobs here would only change this device's profile. The
// one live control is the energy direction, sent as a playback command.

import { $, showToast } from './utils.js';
import { store } from './store.js';
import { getPlayerModule, getPlayerEngine } from './player_active.js';
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

// The target's report keys → the panel's keys (the report names them for what they
// mean, the panel for the localStorage suffix the engine reads).
const REMOTE_KEYS = {
  smart_queue: 'smart_queue',
  tempo_pref: 'tempo_pref',
  crossfade_beats: 'fade_beats',
  transition_style: 'transition_style',
  dj_energy_weight: 'energy_weight',
};
const ENERGY_DIRS = ['auto', 'up', 'hold', 'down'];

function _remoteDev() {
  return store.remoteTarget ? (store.remoteDevices[store.remoteTarget] || null) : null;
}

let _savedTimer = null;
function _savedStatus() {
  if (store.remoteTarget) return; // nothing here was saved — the knobs belong to the target
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
  if (store.remoteTarget) return; // read-only mirror; the controls are disabled anyway
  clearTimeout(_keyTimers.get(key));
  _keyTimers.set(key, setTimeout(() => {
    _keyTimers.delete(key);
    localStorage.setItem(`ms_dj_${key}`, val);
    _savedStatus();
    getPlayerModule().then(m => m.applyDjSettings?.());
  }, 300));
}

// A direction just sent to the target shows at once; the target's report confirms it
// within a few seconds. Until then a report still carrying the old value must not
// flip the control back.
let _pendingDir = null; // { v, until }

/** Reflect the energy direction in the segmented control — this device's stored
 *  value, or under remote control the target's reported one. */
export function syncEnergyDir() {
  const box = $('#fpDjEnergyDir');
  if (!box) return;
  let cur = 'auto';
  if (store.remoteTarget) {
    const dj = _remoteDev()?.dj;
    cur = (dj && dj.energy_dir) || 'auto';
    if (_pendingDir) {
      if (_pendingDir.v === cur || Date.now() > _pendingDir.until) _pendingDir = null;
      else cur = _pendingDir.v;
    }
  } else {
    _pendingDir = null;
    try { cur = localStorage.getItem('ms_dj_energy_dir') || 'auto'; } catch { /* default */ }
  }
  if (!ENERGY_DIRS.includes(cur)) cur = 'auto';
  for (const b of box.querySelectorAll('button[data-v]')) {
    b.setAttribute('aria-checked', String(b.dataset.v === cur));
    b.tabIndex = b.dataset.v === cur ? 0 : -1;
  }
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
  if (store.remoteTarget) return; // hidden under remote control: it would load THIS device's queue
  _preloadActive ? _stopPreload() : _startPreload();
}

/** Target side of an `energy_dir` command: what a press on the control here does,
 *  without the toasts (nobody may be looking at the target). */
export function setEnergyDirection(v) {
  if (!ENERGY_DIRS.includes(v)) return;
  try { localStorage.setItem('ms_dj_energy_dir', v); } catch { /* private mode */ }
  syncEnergyDir();
  getPlayerModule().then((m) => { try { m.repickNext?.(); } catch { /* classic engine */ } }).catch(() => {});
}

// Set a control to a value; a value the control has no option for (another client's
// profile) gets a marked option of its own rather than a blank select.
function _setControl(el, val) {
  el.value = val;
  if (el.tagName !== 'SELECT' || el.value === val) return;
  const opt = document.createElement('option');
  opt.value = val; opt.textContent = val; opt.dataset.remoteOpt = '1';
  el.appendChild(opt);
  el.value = val;
}

function _dropRemoteOptions(el) {
  if (el.tagName === 'SELECT') el.querySelectorAll('option[data-remote-opt]').forEach(o => o.remove());
}

// Pull current values into the panel controls: from localStorage (this device), or
// under remote control from the target's report. Called on every open so the panel
// reflects any change made in Settings since last time, and by remote.js on every
// state report of the target.
// remote.js calls syncDjPanel() every second while controlling; repaint only when
// the mirrored report (or the pending energy direction) changed.
let _remoteSyncKey = '';

export function syncDjPanel() {
  const remote = !!store.remoteTarget;
  const dj = remote ? (_remoteDev()?.dj || null) : null;
  if (remote) {
    const dev = _remoteDev();
    const key = JSON.stringify([store.remoteTarget, dev && dev.name, dev && dev.engine, dj,
      _pendingDir && _pendingDir.v, _pendingDir && Date.now() > _pendingDir.until]);
    if (key === _remoteSyncKey) return;
    _remoteSyncKey = key;
  } else {
    _remoteSyncKey = '';
  }
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    _dropRemoteOptions(el);
    let val;
    if (remote) {
      const rv = dj ? dj[REMOTE_KEYS[key]] : null;
      val = (rv != null && rv !== '') ? String(rv) : cfg.def;
    } else {
      const stored = localStorage.getItem(`ms_dj_${key}`);
      val = (stored != null && stored !== '') ? stored : cfg.def;
    }
    _setControl(el, val);
    el.disabled = remote;
    if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = val; }
  }
  const engEl = $('#fpPlayerEngine');
  if (engEl) engEl.value = getPlayerEngine();
  syncEnergyDir();
  _applyPanelMode();
}

// Switch the player engine (classic ↔ dj) straight from the live DJ panel.
// Mirrors the Settings flow: flush the queue on the OUTGOING engine, persist the
// choice, then reload (the engine module is memoized and owns a different audio
// graph, so a reload is required to swap it in).
async function _applyEngineChange() {
  const el = $('#fpPlayerEngine');
  if (!el || el.value === getPlayerEngine()) return;
  if (store.remoteTarget) { el.value = getPlayerEngine(); return; } // hidden under remote control
  const next = el.value;
  try { const m = await getPlayerModule(); await m.flushQueue?.(); } catch {}
  localStorage.setItem('ms_player_engine', next);
  showToast('Switching player…');
  const av = new URLSearchParams(window.location.search).get('app_version')
    || localStorage.getItem('app_installed_version');
  window.location.href = window.location.origin + '/?_=' + Date.now() + (av ? '&app_version=' + av : '');
}

function _isDjEngine() {
  return (localStorage.getItem('ms_player_engine') || 'classic') === 'dj';
}

// The engine whose controls the panel shows: under remote control the TARGET's.
function _panelIsDj() {
  if (!store.remoteTarget) return _isDjEngine();
  const eng = _remoteDev()?.engine;
  return eng === 'v3' || eng === 'dj';
}

// "Settings of <device> — change them on that device", above the rows. Built here,
// not in markup: it exists only for remote control.
function _remoteBanner() {
  let el = $('#fpDjRemoteBanner');
  if (el) return el;
  const body = document.querySelector('#fpDjPanel .fp-dj-body');
  if (!body) return null;
  el = document.createElement('div');
  el.id = 'fpDjRemoteBanner';
  el.className = 'fp-dj-remote-banner';
  el.setAttribute('role', 'note');
  el.style.cssText = 'display:none;font-size:12px;line-height:1.4;color:var(--text-muted);'
    + 'background:var(--bg-elevated);border:1px solid var(--border);'
    + 'border-radius:var(--radius-xs);padding:8px 10px;';
  body.prepend(el);
  return el;
}

let _isOpen = false;

// Synchronous flag read by router.js Esc handler BEFORE any async work.
// Set/cleared in open/close so the decision is always coherent with the DOM state.
export function isDjPanelOpen() { return _isOpen; }

function openDjPanel() {
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
  // The panel is available in BOTH engines now — it hosts the Player selector so
  // users can switch classic↔dj from the player. The dj-only mixing controls
  // (Smart Queue, crossfade, …) are hidden in classic via _applyPanelMode().
  const panelBtn = $('#fpDjPanelBtn');
  if (panelBtn) panelBtn.style.display = '';

  const cycleBtn = $('#fpDjMode');
  if (cycleBtn) cycleBtn.style.display = 'none';

  _applyPanelMode();
}

// Show the dj-only mixing controls only when the DJ engine is active; in classic
// the panel shows just the Player selector.
//
// The drawer is kept in classic on purpose — it is the only way from the classic
// engine into DJ without a detour through Settings. What it is NOT in classic is
// "DJ controls": the heading and the button both say so, or the user opens a drawer
// promising a mixing desk and finds a single dropdown.
function _applyPanelMode() {
  const remote = !!store.remoteTarget;
  const isDj = _panelIsDj();
  const rows = $('#fpDjOnlyRows');
  if (rows) rows.style.display = isDj ? '' : 'none';
  // "More in Settings" opens THIS device's Settings — not the target's.
  const more = $('#fpDjMoreSettings');
  if (more) more.style.display = (isDj && !remote) ? '' : 'none';
  // The engine selector and Preload set act on this device only: switching engines
  // reloads the page (and dropped remote mode), Preload downloads this device's queue.
  const engGroup = $('#fpPlayerEngine')?.closest('.setting-group');
  if (engGroup) engGroup.style.display = remote ? 'none' : '';
  const preload = document.querySelector('#fpDjPanel .fp-dj-preload-group');
  if (preload) preload.style.display = remote ? 'none' : '';
  if (remote) { const saved = $('#fpDjSavedStatus'); if (saved) saved.textContent = ''; }
  const banner = remote ? _remoteBanner() : $('#fpDjRemoteBanner');
  if (banner) {
    if (remote) {
      const name = _remoteDev()?.name || 'the other device';
      banner.textContent = `Settings of ${name} — change them on that device`
        + (isDj ? '' : `. ${name} uses the classic player (no DJ mixing).`);
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }
  const title = $('#fpDjPanelTitle');
  if (title) title.textContent = isDj ? '🎛 Live DJ Controls' : 'Player';
  const btn = $('#fpDjPanelBtn');
  if (btn) {
    const label = isDj ? 'DJ controls' : 'Player settings';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  const panel = $('#fpDjPanel');
  if (panel) panel.setAttribute('aria-label', isDj ? 'DJ quick controls' : 'Player settings');
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
  $('#fpPlayerEngine')?.addEventListener('change', _applyEngineChange);

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

  // Energy direction: applies to the very next track, so no debounce and a re-pick.
  const dirBox = $('#fpDjEnergyDir');
  if (dirBox) {
    dirBox.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      if (store.remoteTarget) {
        // Steering the energy is playback control: the TARGET applies it with its own
        // profile and re-picks its next track. This device's key stays untouched.
        const v = btn.dataset.v;
        const dev = _remoteDev();
        document.dispatchEvent(new CustomEvent('remote:cmd', { detail: { action: 'energy_dir', value: v } }));
        _pendingDir = { v, until: Date.now() + 5000 };
        syncEnergyDir();
        const dj = dev && dev.dj;
        if (v !== 'auto' && dj && (dj.smart_queue || 'off') === 'off') {
          showToast(`Smart Queue is off on ${dev.name || 'that device'} – the energy is not steered`);
        }
        return;
      }
      try { localStorage.setItem('ms_dj_energy_dir', btn.dataset.v); } catch { /* private mode */ }
      syncEnergyDir();
      _savedStatus();
      const smart = (localStorage.getItem('ms_dj_smart_queue') || 'off') !== 'off';
      if (btn.dataset.v !== 'auto' && !smart) { showToast('Turn Smart Queue on – in playlist order the energy is not steered'); return; }
      if (btn.dataset.v !== 'auto' && store.shuffleEnabled) { showToast('Shuffle is on – it decides the next track, not the energy'); return; }
      getPlayerModule().then((m) => { if (m.repickNext?.()) showToast('Next track re-picked'); });
    });
    // A radio group: arrows move the choice, one tab stop.
    dirBox.addEventListener('keydown', (e) => {
      const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const btns = [...dirBox.querySelectorAll('button[data-v]')];
      const next = btns[(btns.indexOf(document.activeElement) + step + btns.length) % btns.length];
      next.focus(); next.click();
    });
  }

  // Wire each control to the shared ms_dj_* key.
  for (const [key, cfg] of Object.entries(PANEL_CONFIG)) {
    const el = $(cfg.sel);
    if (!el) continue;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      if (store.remoteTarget) return; // disabled under remote control; belt and braces
      if (cfg.badge) { const b = $(cfg.badge); if (b) b.textContent = el.value; }
      _writeKey(key, el.value);
    });
  }
}
