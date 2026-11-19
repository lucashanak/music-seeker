// djdesk.js — the DJ desk: two physical decks (left = A = #audioElement, right = B),
// headphone cue, crossfader, manual transitions, pitch / sync / nudge / cue points.
//
// The desk owns no audio. It reaches the DJ engine ONLY through the desk* exports of
// player_v3.js, resolved with getPlayerModule() and only when the DJ engine runs — a
// static import of player_v3.js would start a second engine beside the classic one.
// Headphone routing belongs to cuebus.js (imported as a namespace, so a missing export
// cannot break this module's linking). Pure maths live in deskmath.js.
//
// Layer contract: the desk is a fixed overlay (z-index 260, over the full player and
// both queue panels). It pushes one history entry; router.js closes it on Back and on
// Escape through closeDesk(); `store.deskOpen` is the visibility flag (offsetParent is
// always null for a fixed element). Manual mode lives only while the desk is open.

import { store } from './store.js';
import { $, esc, showToast, historyBack, setArt } from './utils.js';
import { apiJson } from './api.js';
import { getPlayerEngine, getPlayerModule } from './player_active.js';
import { playOrder } from './queue.js';
import { getCachedUrl } from './prefetch.js';
import { getDjData, displayBpm, energyLevel, hydrateBpmByName, fetchTrackBpm } from './bpm.js';
import * as cuebus from './cuebus.js';
import * as cuemath from './cuemath.js';
import * as dm from './deskmath.js';

const KEYS = ['A', 'B'];
const other = (k) => (k === 'A' ? 'B' : 'A');
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
const NUDGE = 0.03;            // ±3 % while a nudge is held
const PITCH_STEP = 0.001;      // keyboard pitch step: 0.1 %
const SYNC_MAX_PCT = 16;       // a sync further than this is refused
const INFO_MS = 200;           // deskInfo() refresh while open
const LIST_MS = 900;           // queue / suggestions refresh check
const WAVE_CACHE_MAX = 24;

let _eng = null;               // the DJ engine module, when it has the desk API
let _graph = null;             // last deskGraph()
let _djmix = null;             // djmix.js (pickSmartNext), loaded with the desk
let _info = null;              // last deskInfo()
let _raf = 0;
let _lastInfoAt = 0, _lastListAt = 0;
let _blocked = null;           // why the desk cannot be used right now, or null
let _mix = null;               // crossfader mix in progress: { from, to, t }
let _faderDrag = false;
let _phrase = null;            // armed "mix on phrase": { key, item, at, boundary, timer }
let _nudge = null;             // { key, base, via }
let _cueHeld = false;          // acquireCue('desk') succeeded and is held (resynced from cueStatus)
let _ramp = null;              // closing mid-mix: the fader glides to its end ({ timer })
let _listSig = '';
let _listDirty = true;        // something the lists show changed: redraw on the next check
let _hydratedFor = null;       // queue array the BPM cache was hydrated for
let _statusTimer = null;
let _dataAsked = new Set();    // tracks whose DJ data the desk asked the server for
const _ui = { A: null, B: null };
const _range = { A: 8, B: 8 }; // pitch slider range (± %)
const _cues = new Map();       // `${deck}|${track}` → seconds
const _wave = new Map();       // track → { state, peaks, rate, at }
const _barsOf = new WeakMap(); // DJ data → { beats, bars, to } over the whole track

const _ik = (item) => item ? `${(item.artist || '').toLowerCase().trim()}::${(item.name || '').toLowerCase().trim()}` : '';

export function isDeskOpen() { return !!store.deskOpen; }

// ───────────────────────── engine access ─────────────────────────

function _el(key) { return _graph && _graph.els ? _graph.els[key] || null : null; }

function _dur(key) {
  let d = 0;
  try { d = _eng && _eng.deskDur ? _eng.deskDur(key) : 0; } catch { d = 0; }
  if (!d) {
    const el = _el(key);
    if (el && fin(el.duration) && el.duration > 0) d = el.duration;
  }
  if (!d && _info) {
    const it = _info.items[key];
    if (it && it.duration_ms > 0) d = it.duration_ms / 1000;
  }
  return d || 0;
}

/** DJ data of what a deck holds: the engine's, else the BPM cache, else ask once. */
function _data(key) {
  if (!_info) return null;
  const d = _info.data && _info.data[key];
  if (d) return d;
  const it = _info.items[key];
  if (!it) return null;
  const c = getDjData(it.name, it.artist);
  if (c) return c;
  const k = _ik(it);
  if (!_dataAsked.has(k)) { _dataAsked.add(k); fetchTrackBpm(it.name, it.artist).catch(() => {}); }
  return null;
}

/** Queue index of what a deck holds (the lent deck: the engine knows it). */
function _indexOf(key) {
  if (!_info) return -1;
  if (key === _info.loan && Number.isInteger(_info.loanIndex)) return _info.loanIndex;
  const it = _info.items[key];
  return it ? store.playerQueue.indexOf(it) : -1;
}

async function _attach() {
  _eng = null;
  if (getPlayerEngine() !== 'dj') return;
  let m = null;
  try { m = await getPlayerModule(); } catch { m = null; }
  if (!m || typeof m.deskInfo !== 'function') return;
  _eng = m;
  try { _graph = m.deskGraph ? m.deskGraph() : null; } catch { _graph = null; }
}

function _blockReason() {
  if (getPlayerEngine() !== 'dj') return 'classic';
  if (!_eng) return 'noengine';
  if (store.castDevice || (_info && _info.blocked === 'cast')) return 'cast';
  if (store.remoteTarget || (_info && _info.blocked === 'remote')) return 'remote';
  if (_info && _info.blocked) return _info.blocked;
  return null;
}

const BLOCK_TEXT = {
  classic: ['The DJ desk needs the DJ player', 'Switch “Player” to DJ in the DJ controls of the full player, then open the desk again.'],
  noengine: ['The DJ desk is not available', 'This version of the player has no desk support.'],
  cast: ['Not available while casting', 'The desk and the headphone cue mix on this device only. Stop casting to use them.'],
  remote: ['Not available while controlling another device', 'The desk mixes on this device only. Stop the remote control to use it here.'],
  rec: ['Not available during a recommendation preview', 'A recommended track is playing outside the queue. The desk comes back when the queue plays again.'],
};

// ───────────────────────── open / close ─────────────────────────

export async function openDesk() {
  if (store.deskOpen) return;
  const root = $('#djDesk');
  if (!root) return;
  store.deskOpen = true;
  history.pushState({ layer: 'desk' }, '');
  root.classList.add('open');
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('dd-active');
  _listDirty = true;
  await _attach();
  if (!store.deskOpen) return;      // closed while the engine resolved
  try { _djmix = await import('./djmix.js'); } catch { _djmix = null; }
  _refreshInfo();
  _syncMode();
  _syncCueUi();
  _acquireCue();
  _hydrate();
  if (!_raf) _raf = requestAnimationFrame(_frame);
  setTimeout(() => { if (store.deskOpen) $('#ddMixNow')?.focus({ preventScroll: true }); }, 60);
}

export function closeDesk(fromPopstate) {
  if (!store.deskOpen) return;
  store.deskOpen = false;
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  _cancelPhrase();
  _nudgeEnd();
  if (_eng) {
    if (_mix) {
      // Settle the hand mix by where the fader is — gliding there, not jumping.
      _rampOut(_mix.t);
      _mix = null;
    }
    try { _eng.deskSetManual(false); } catch {}
    _releaseFreeDeck();
  }
  if (_cueHeld && typeof cuebus.releaseCue === 'function') { cuebus.releaseCue('desk'); }
  _cueHeld = false;
  _toggleHelp(false);
  const root = $('#djDesk');
  if (root) { root.classList.remove('open'); root.setAttribute('aria-hidden', 'true'); }
  document.body.classList.remove('dd-active');
  if (!fromPopstate) historyBack();
}

/** A track left on the free deck would keep playing in the headphones only; give the
 *  deck back — unless the cue preview (queue / context menu) is what holds it. */
function _releaseFreeDeck() {
  if (!_eng || store.deskOpen) return;
  try {
    const info = _eng.deskInfo();
    const pv = typeof cuebus.previewState === 'function' ? cuebus.previewState() : null;
    if (info.loan && !(pv && pv.key === info.loan)) _eng.deskRelease();
  } catch {}
}

const RAMP_MS = 300;

/** Glide the crossfader from t to the end it is nearer (≥ 0.5: the new deck), then end
 *  the mix there. Runs on timers: the desk is closed, and rAF stops in a hidden page. */
function _rampOut(t) {
  if (_ramp) { clearTimeout(_ramp.timer); _ramp = null; }
  const eng = _eng;
  const commit = t >= 0.5;
  const from = dm.clamp(Number(t) || 0, 0, 1), to = commit ? 1 : 0;
  const t0 = performance.now();
  const ramp = { timer: 0 };
  _ramp = ramp;
  const step = () => {
    if (_ramp !== ramp) return;
    const k = Math.min(1, (performance.now() - t0) / RAMP_MS);
    let ok = false;
    try { ok = eng.deskMixLevel(from + (to - from) * k); } catch { ok = false; }
    if (ok && k < 1) { ramp.timer = setTimeout(step, 16); return; }
    _ramp = null;
    if (ok) { try { eng.deskEndMix(commit); } catch {} }
    // Taken back, the new deck is lent again and still playing — into a cue the closed
    // desk no longer holds.
    _releaseFreeDeck();
    if (store.deskOpen) { _listDirty = true; _refreshInfo(); }
  };
  step();
}

// ───────────────────────── cue (headphones) ─────────────────────────

function _cueApi() {
  return typeof cuebus.cueSettings === 'function' && typeof cuebus.setDeckCue === 'function'
    && typeof cuebus.acquireCue === 'function';
}

/** The cue mode as it can be built — the same test cuebus and cuemini use
 *  (cuemath.configuredCueMode: 'devices' needs an explicit headphone device). */
function _cueMode() {
  if (!_cueApi()) return 'off';
  const sup = typeof cuebus.cueSupport === 'function' ? cuebus.cueSupport() : { modes: [] };
  return cuemath.configuredCueMode(cuebus.cueSettings(), sup.modes || []);
}

/** cuebus can drop every owner on its own (unplugged sink, sink error, cast / remote,
 *  a mode change that failed): believe its status, not our flag, and take the cue
 *  again when it can work — not after a failure of the route itself, which would only
 *  fail (and toast) again. */
function _onCueChange(ev) {
  if (!store.deskOpen) return;
  if (typeof cuebus.cueStatus === 'function') {
    let held = _cueHeld;
    try { held = cuebus.cueStatus().owners.includes('desk'); } catch {}
    const lost = _cueHeld && !held;
    _cueHeld = held;
    const failed = ev && ['sink', 'nodevice', 'samedevice', 'route', 'unsupported', 'unavailable'].includes(ev.reason);
    if (lost && !failed && !_blocked && _cueMode() !== 'off') _acquireCue();
  }
  _syncCueUi();
  _listDirty = true;
}

async function _acquireCue() {
  if (_cueHeld || !_cueApi() || _blocked || _cueMode() === 'off') return _cueHeld;
  let res = null;
  try { res = await cuebus.acquireCue('desk'); } catch { res = null; }
  if (!store.deskOpen) { if (res && res.ok) cuebus.releaseCue('desk'); return false; }
  _cueHeld = !!(res && res.ok);
  _syncCueUi(res && !res.ok ? res.error : null);
  return _cueHeld;
}

async function _openCueSetup() {
  try {
    const m = await import('./cuesetup.js');
    if (typeof m.openCueSetup !== 'function') { showToast('Headphone settings are not available', true); return; }
    await m.openCueSetup();
  } catch { showToast('Headphone settings are not available', true); return; }
  if (!store.deskOpen) return;
  if (!_cueHeld) await _acquireCue();
  _syncCueUi();
}

async function _togglePfl(key) {
  if (!_cueApi()) { showToast('Headphone cue is not available here', true); return; }
  if (_cueMode() === 'off') { await _openCueSetup(); if (_cueMode() === 'off') return; }
  if (!_cueHeld) await _acquireCue();
  const on = !cuebus.cueSettings().pfl[key];
  cuebus.setDeckCue(key, on);
  _syncCueUi();
}

function _syncCueUi(error) {
  const box = $('#ddCue');
  if (!box) return;
  const api = _cueApi();
  const mode = _cueMode();
  for (const k of KEYS) {
    const b = _ui[k] && _ui[k].pfl;
    if (!b) continue;
    const on = api && mode !== 'off' && !!cuebus.cueSettings().pfl[k];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.disabled = !api;
  }
  const note = $('#ddCueNote');
  if (!api) {
    box.classList.add('dd-cue-na');
    if (note) note.textContent = 'Headphone cue is not available in this browser.';
    return;
  }
  box.classList.remove('dd-cue-na');
  const s = cuebus.cueSettings();
  const vol = $('#ddCueVol'), mix = $('#ddCueMix');
  if (vol && document.activeElement !== vol) vol.value = Math.round((s.volume ?? 0.8) * 100);
  if (mix && document.activeElement !== mix) mix.value = Math.round((s.mix ?? 0) * 100);
  if (!note) return;
  if (mode === 'off') note.textContent = 'Headphone output is off. Set it up with the headphones button at the top.';
  else if (error) note.textContent = 'The headphone output could not start. Check it with the headphones button at the top.';
  else if (s.deviceLabel && typeof cuebus.isBluetoothLabel === 'function' && cuebus.isBluetoothLabel(s.deviceLabel)) {
    note.textContent = 'Bluetooth headphones lag 100–300 ms: fine for choosing a track, not for beatmatching by ear.';
  } else {
    const label = { devices: s.deviceLabel || 'second output', multichannel: 'channels 3–4', split: 'right channel (split)' }[mode] || mode;
    note.textContent = `Cue: ${label}`;
  }
}

// ───────────────────────── state refresh ─────────────────────────

function _refreshInfo() {
  let info = null;
  if (_eng) { try { info = _eng.deskInfo(); } catch { info = null; } }
  _info = info;
  if (_eng && !_graph && info && !store.castDevice && !store.remoteTarget) {
    try { _graph = _eng.deskGraph(); } catch { _graph = null; }
  }
  const reason = _blockReason();
  if (reason !== _blocked) {
    _blocked = reason;
    const b = $('#ddBlocked'), main = $('#ddMain');
    if (b) b.hidden = !reason;
    if (main) main.hidden = !!reason;
    if (reason) {
      const [t, m] = BLOCK_TEXT[reason] || ['The DJ desk is not available', ''];
      $('#ddBlockedTitle').textContent = t;
      $('#ddBlockedMsg').textContent = m;
      _cancelPhrase();
      _nudgeEnd();
      _mix = null;
    } else {
      _listDirty = true;
      _acquireCue();
    }
    $('#djDesk')?.classList.toggle('dd-is-blocked', !!reason);
  }
  if (reason || !info) return;
  // A mix the engine ended (or one this page did not start) must not be steered blindly.
  if (_mix && !info.mixing) _mix = null;
  if (!_mix && info.mixing && !_ramp) {
    const from = info.fading || other(info.active);
    _mix = { from, to: info.active, t: fin(info.mixLevel) ? info.mixLevel : 0.5 };
  }
  for (const k of KEYS) _syncDeckStatic(k);
  _syncMode();
  _syncTransport();
  _syncFader();
}

function _badgeFor(key) {
  const info = _info;
  if (_mix && key === _mix.from) return ['OUT', 'out'];
  if (key === info.active) return ['LIVE', 'live'];
  if (info.fading === key) return ['OUT', 'out'];
  if (info.loan === key) return info.items[key] ? ['CUE', 'cue'] : ['FREE', 'free'];
  return info.items[key] ? ['NEXT', 'next'] : ['FREE', 'free'];
}

function _energyHtml(level, energy) {
  if (level == null) return '';
  let bars = '';
  for (let i = 1; i <= 5; i++) bars += i <= level ? '<i class="on"></i>' : '<i></i>';
  const pct = fin(Number(energy)) ? Math.round(Number(energy) * 100) : null;
  return `<span class="energy-badge" data-level="${level}" title="${pct != null ? `Energy ${pct} %` : 'Energy'}" aria-label="Energy ${level} of 5">${bars}</span>`;
}

function _syncDeckStatic(key) {
  const ui = _ui[key];
  if (!ui) return;
  const info = _info;
  const item = info.items[key];
  const data = _data(key);
  const [badge, cls] = _badgeFor(key);
  const live = info.active;
  const rel = (key !== live && data && data.camelot) ? dm.camelotRelation(_data(live)?.camelot, data.camelot) : null;
  const sig = [_ik(item), item && item.image, badge, data ? `${data.bpm}|${data.tempo_feel}|${data.camelot}|${data.energy}|${data.feature_version}` : '-', rel, key === info.loan].join('§');
  ui.root.classList.toggle('is-live', cls === 'live');
  ui.root.classList.toggle('is-empty', !item);
  if (sig === ui.sig) return;
  ui.sig = sig;
  ui.badge.textContent = badge;
  ui.badge.className = 'dd-badge dd-badge-' + cls;
  ui.name.textContent = item ? (item.name || '') : (key === info.loan ? 'Free deck — load a track' : 'Free deck');
  ui.artist.textContent = item ? (item.artist || '') : '';
  setArt(ui.art, item ? item.image : '');
  ui.keyEl.textContent = data && data.camelot ? data.camelot : '';
  ui.keyEl.title = data && data.key ? `Key ${data.key}` : 'Key';
  ui.keyEl.className = 'dd-key' + (rel ? ' rel-' + rel : '');
  if (rel) ui.keyEl.title += ` · ${{ same: 'same key', relative: 'relative key', adjacent: 'next on the wheel', energy: 'two steps on the wheel', clash: 'clashes with the live track' }[rel]}`;
  ui.energy.innerHTML = data ? _energyHtml(energyLevel(data), data.energy) : '';
  ui.bpmBase = data && fin(Number(data.bpm)) ? Number(data.bpm) : null;
  const felt = data ? Number(displayBpm(data)) : NaN;
  ui.feltRatio = ui.bpmBase && fin(felt) && Math.abs(felt - ui.bpmBase) > 0.5 ? felt / ui.bpmBase : null;
}

function _syncMode() {
  const manual = !!(_info && _info.manual);
  for (const b of document.querySelectorAll('#ddMode button[data-v]')) {
    const on = (b.dataset.v === 'manual') === manual;
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }
  $('#djDesk')?.classList.toggle('dd-manual', manual);
}

function _syncTransport() {
  const info = _info;
  const next = $('#ddNext');
  if (next) {
    let txt = '';
    const loanIdx = info.loan && info.items[info.loan] ? _indexOf(info.loan) : -1;
    const ni = info.deskNext != null ? info.deskNext : info.next;
    if (_mix) txt = `Mixing ${_mix.from} → ${_mix.to} by hand`;
    else if (info.crossfading) txt = 'The player is mixing…';
    else if (loanIdx >= 0) txt = `Ready on ${info.loan}: ${info.items[info.loan].name || ''}`;
    else if (ni != null && store.playerQueue[ni]) txt = `Next: ${store.playerQueue[ni].name || ''}`;
    else txt = 'Nothing queued after this track';
    if (info.manual && !_mix && !info.crossfading) txt += ' · Manual';
    next.textContent = txt;
  }
  const mixNow = $('#ddMixNow');
  if (mixNow) mixNow.disabled = !!(info.crossfading || info.busy || _mix || info.playing === false);
  const ph = $('#ddMixPhrase');
  if (ph && !_phrase) ph.disabled = !!(info.crossfading || info.busy || _mix || info.playing === false);
}

function _syncFader() {
  const f = $('#ddXfader');
  if (!f) return;
  const info = _info;
  if (!_mix && !_faderDrag) f.value = String(dm.sideOf(info.active) * 1000);
  f.disabled = !!(info.crossfading && !info.mixing);
  const gains = $('#ddXfGains');
  if (gains) {
    let gA, gB;
    if (_mix) { const g = dm.faderGains(_mix.t); gA = _mix.from === 'A' ? g.out : g.in; gB = _mix.from === 'B' ? g.out : g.in; }
    else { gA = info.active === 'A' ? 1 : 0; gB = info.active === 'B' ? 1 : 0; }
    gains.children[0].style.width = `${Math.round(gA * 50)}%`;
    gains.children[1].style.width = `${Math.round(gB * 50)}%`;
  }
}

function _status(msg, ms = 3500) {
  const el = $('#ddStatus');
  if (!el) return;
  el.textContent = msg || '';
  clearTimeout(_statusTimer);
  if (msg && ms) _statusTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms);
}

// ───────────────────────── per frame ─────────────────────────

function _frame(ts) {
  _raf = store.deskOpen ? requestAnimationFrame(_frame) : 0;
  if (!_raf) return;
  if (ts - _lastInfoAt >= INFO_MS) { _lastInfoAt = ts; _refreshInfo(); }
  if (_blocked || !_info) return;
  if (ts - _lastListAt >= LIST_MS) { _lastListAt = ts; _renderLists(); }
  for (const k of KEYS) _drawDeck(k);
  _phraseTick();
  _meters();
}

function _meters() {
  if (typeof cuebus.cueLevels !== 'function' || !_cueHeld) return;
  let lv;
  try { lv = cuebus.cueLevels(); } catch { return; }
  const m = $('#ddMeterMaster'), c = $('#ddMeterCue');
  const pct = (v) => `${Math.round(Math.min(1, Math.sqrt(Math.max(0, v || 0)) * 1.6) * 100)}%`;
  if (m) m.style.width = pct(lv.master);
  if (c) c.style.width = pct(lv.cue);
}

function _fit(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const COL = {
  lane: 'rgba(255,255,255,0.035)', played: 'rgba(162,230,64,0.55)', rest: 'rgba(238,238,245,0.42)',
  beat: 'rgba(255,255,255,0.22)', bar: 'rgba(255,255,255,0.55)', phrase: '#A2E640', head: '#ffffff',
  cue: '#ff9f43', target: '#ffd24d',
};

function _drawDeck(key) {
  const ui = _ui[key];
  if (!ui) return;
  const info = _info;
  const el = _el(key);
  const item = info.items[key];
  const pos = item && el ? (el.currentTime || 0) : 0;
  const rate = el && el.playbackRate > 0 ? el.playbackRate : 1;
  const dur = item ? _dur(key) : 0;
  const data = item ? _data(key) : null;
  const wave = item ? _waveFor(item) : null;

  ui.elapsed.textContent = dm.formatTime(pos, { tenths: true });
  ui.remain.textContent = dm.formatRemaining(pos, dur, rate);
  ui.pitchRead.textContent = dm.formatPitch(rate);
  if (document.activeElement !== ui.pitch && !ui.pitchDrag) {
    const p = dm.rateToPct(rate);
    if (Math.abs(p) > _range[key]) _setRange(key, SYNC_MAX_PCT);
    ui.pitch.value = String(p);
  }
  if (ui.bpmBase) {
    const b = ui.bpmBase * rate;
    const felt = ui.feltRatio ? ` <small title="Felt tempo">felt ${Math.round(b * ui.feltRatio)}</small>` : '';
    const html = `<b>${b.toFixed(1)}</b> BPM${felt}`;
    if (ui.bpmHtml !== html) { ui.bpmHtml = html; ui.bpm.innerHTML = html; }
  } else if (ui.bpmHtml !== '') { ui.bpmHtml = ''; ui.bpm.innerHTML = item ? '<span class="dd-dim">no BPM</span>' : ''; }
  const playing = !!(item && el && !el.paused);
  if (ui.playing !== playing) {
    ui.playing = playing;
    ui.play.innerHTML = playing
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  const cue = item ? _cues.get(`${key}|${_ik(item)}`) : undefined;
  _drawZoom(ui, pos, data, wave, cue, key);
  _drawOverview(ui, pos, dur, wave, cue, key);
}

function _lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Beats and bars of a track over its whole length (the analysis often covers only part
 *  of it), cached per DJ-data object and rebuilt when the known length grows. */
function _gridOf(data, dur) {
  if (!data || !Array.isArray(data.beat_grid) || !data.beat_grid.length) return null;
  const to = Math.max(dur || 0, data.beat_grid[data.beat_grid.length - 1] + 30);
  let g = _barsOf.get(data);
  if (!g || g.to < to - 1) {
    const bpm = Number(data.bpm);
    g = { to, beats: dm.beatTimes(data.beat_grid, bpm, 0, to), bars: dm.barTimes(data.downbeats, data.beat_grid, bpm, 0, to) };
    _barsOf.set(data, g);
  }
  return g;
}

function _drawZoom(ui, pos, data, wave, cue, key) {
  const f = _fit(ui.zoom);
  if (!f) return;
  const { ctx, w, h } = f;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COL.lane;
  ctx.fillRect(0, 0, w, h);
  const span = w < 420 ? 8 : 12;                 // track seconds across the lane
  const t0 = pos - span / 2, t1 = pos + span / 2;
  const X = (t) => ((t - t0) / span) * w;
  if (wave && wave.state === 'ok') {
    const n = Math.max(1, Math.floor(w / 3));
    const bars = wave.barsFor(wave.peaks, wave.rate, t0, t1, n);
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = bars[i];
      if (!v) continue;
      const bh = Math.max(1, v * h * 0.92);
      ctx.fillStyle = (t0 + (i + 0.5) * (span / n)) < pos ? COL.played : COL.rest;
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
    }
  }
  const g = _gridOf(data, _dur(key));
  if (g) {
    for (let i = _lowerBound(g.beats, t0); i < g.beats.length && g.beats[i] <= t1; i++) {
      const x = X(g.beats[i]);
      ctx.fillStyle = COL.beat;
      ctx.fillRect(x, 0, 1, h * 0.18);
      ctx.fillRect(x, h * 0.82, 1, h * 0.18);
    }
    for (let i = _lowerBound(g.bars, t0); i < g.bars.length && g.bars[i] <= t1; i++) {
      const phrase = i % 8 === 0;   // bars count from the first bar of the track, as nextPhrase does
      ctx.fillStyle = phrase ? COL.phrase : COL.bar;
      ctx.fillRect(X(g.bars[i]) - (phrase ? 1 : 0.5), 0, phrase ? 2 : 1, h);
    }
  } else if (!wave || wave.state !== 'ok') {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(_info.items[key] ? 'No waveform or beat grid for this track' : '', w / 2, h / 2 + 4);
  }
  if (_phrase && _phrase.key === key && _phrase.boundary >= t0 && _phrase.boundary <= t1) {
    ctx.fillStyle = COL.target;
    ctx.fillRect(X(_phrase.boundary) - 1.5, 0, 3, h);
  }
  if (fin(cue) && cue >= t0 && cue <= t1) {
    const x = X(cue);
    ctx.fillStyle = COL.cue;
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = COL.head;
  ctx.fillRect(w / 2 - 1, 0, 2, h);
}

function _drawOverview(ui, pos, dur, wave, cue, key) {
  const f = _fit(ui.over);
  if (!f) return;
  const { ctx, w, h } = f;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COL.lane;
  ctx.fillRect(0, 0, w, h);
  const total = dur || (wave && wave.duration) || 0;
  if (!total) return;
  const px = Math.min(w, (pos / total) * w);
  if (wave && wave.state === 'ok') {
    const n = Math.max(1, Math.floor(w / 2));
    const bars = wave.barsFor(wave.peaks, wave.rate, 0, total, n);
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(1, bars[i] * h);
      ctx.fillStyle = i * bw < px ? COL.played : COL.rest;
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
    }
  } else {
    ctx.fillStyle = COL.played;
    ctx.fillRect(0, h - 3, px, 3);
  }
  if (_phrase && _phrase.key === key) { ctx.fillStyle = COL.target; ctx.fillRect((_phrase.boundary / total) * w - 1, 0, 2, h); }
  if (fin(cue)) { ctx.fillStyle = COL.cue; ctx.fillRect((cue / total) * w - 1, 0, 2, h); }
  ctx.fillStyle = COL.head;
  ctx.fillRect(px - 1, 0, 2, h);
}

// ───────────────────────── waveform data ─────────────────────────

function _waveFor(item) {
  const k = _ik(item);
  let w = _wave.get(k);
  if (w && w.state === 'none' && Date.now() - w.at > 120000) { _wave.delete(k); w = null; }
  if (w) return w;
  if (_wave.size >= WAVE_CACHE_MAX) _wave.delete(_wave.keys().next().value);
  w = { state: 'loading', at: Date.now() };
  _wave.set(k, w);
  _loadWave(item, w);
  return w;
}

async function _loadWave(item, w) {
  try {
    const mc = await import('./mixcut.js');
    const q = new URLSearchParams({ name: item.name || '', artist: item.artist || '' });
    const d = await apiJson(`/api/desk/waveform?${q}`);
    if (d && d.peaks) {
      w.peaks = mc.decodePeaks(d.peaks);
      w.rate = 1 / (Number(d.step) || 0.1);
      w.duration = Number(d.duration) || w.peaks.length / w.rate;
      w.barsFor = mc.barsFor;
      w.state = w.peaks.length ? 'ok' : 'none';
      w.at = Date.now();
      return;
    }
  } catch { /* no endpoint / no audio: the lane shows the beat grid only */ }
  w.state = 'none';
  w.at = Date.now();
}

// ───────────────────────── deck actions ─────────────────────────

/** A deck the desk may drive: the live one, the lent one, or either side of its own mix. */
function _canDrive(key, what) {
  const info = _info;
  if (!info || _blocked) return false;
  if (info.crossfading && !info.mixing) { showToast('Wait until the player finishes its transition', true); return false; }
  if (!info.items[key]) { showToast(`Deck ${key} is empty — load a track from the queue`, true); return false; }
  if (key !== info.active && key !== info.loan && !(_mix && key === _mix.from)) {
    showToast(`Deck ${key} is the player's — ${what || 'try again'} after its transition`, true);
    return false;
  }
  return true;
}

function _togglePlay(key) {
  if (!_canDrive(key, 'play it')) return;
  const el = _el(key);
  if (!el) return;
  try { if (_graph && _graph.ctx && _graph.ctx.state !== 'running') _graph.ctx.resume(); } catch {}
  if (key === _info.active) {
    // The live deck goes through the player's own play / pause: it settles a running
    // transition, stops a pending retry, and tells the Android shell and the media
    // session — a bare el.pause() mid-mix said "paused" while the other deck played.
    const b = document.getElementById('playerPlayPause');
    if (b) b.click();
    return;
  }
  if (_mix && key === _mix.from) {
    // Stopping the outgoing deck of a hand mix = finishing the mix on the new deck.
    const to = _mix.to;
    _mix = null;
    try { _eng.deskEndMix(true); } catch {}
    const f = $('#ddXfader');
    if (f) f.value = String(dm.sideOf(to) * 1000);
    _status(`Deck ${to} is live`);
    _listDirty = true;
    _refreshInfo();
    return;
  }
  if (el.paused) el.play().catch(() => {}); else el.pause();     // the lent deck: the desk's own
}

function _setCue(key) {
  const item = _info && _info.items[key];
  const el = _el(key);
  if (!item || !el) { showToast(`Deck ${key} is empty`, true); return; }
  const t = el.currentTime || 0;
  _cues.set(`${key}|${_ik(item)}`, t);
  _status(`Cue ${key} set at ${dm.formatTime(t, { tenths: true })}`);
}

function _jumpCue(key) {
  const item = _info && _info.items[key];
  if (!item) { showToast(`Deck ${key} is empty`, true); return; }
  const t = _cues.get(`${key}|${_ik(item)}`);
  if (!fin(t)) { _setCue(key); return; }
  if (!_canDrive(key, 'jump')) return;
  if (!_eng.deskSeek(key, t)) showToast('The player cannot move this deck right now', true);
}

function _setRate(key, rate, quiet) {
  if (!_eng) return false;
  let ok = false;
  try { ok = _eng.deskSetRate(key, rate); } catch { ok = false; }
  if (!ok && !quiet) showToast('The player owns the tempo during its transition', true);
  return ok;
}

function _setRange(key, r) {
  _range[key] = r;
  const ui = _ui[key];
  if (!ui) return;
  ui.pitch.min = String(-r);
  ui.pitch.max = String(r);
  ui.rangeBtn.textContent = `±${r}`;
}

function _pitchBy(key, delta) {
  if (!_canDrive(key, 'change its tempo')) return;
  const el = _el(key);
  const rate = dm.clamp((el ? el.playbackRate : 1) + delta, 1 - SYNC_MAX_PCT / 100, 1 + SYNC_MAX_PCT / 100);
  _setRate(key, rate);
}

function _nudgeStart(key, dir, via) {
  if (_nudge) _nudgeEnd();
  if (!_info || !_info.items[key]) return;
  if (key !== _info.active && key !== _info.loan) return;
  const el = _el(key);
  if (!el) return;
  const base = el.playbackRate || 1;
  if (_setRate(key, base * (1 + dir * NUDGE), true)) _nudge = { key, base, via };
}

function _nudgeEnd(via) {
  if (!_nudge || (via && _nudge.via !== via)) return;
  const { key, base } = _nudge;
  _nudge = null;
  _setRate(key, base, true);
}

function _sync(slave) {
  const master = other(slave);
  const info = _info;
  if (!info || _blocked) return;
  if (!info.items[slave] || !info.items[master]) { showToast('Load a track on both decks first', true); return; }
  if (!_canDrive(slave, 'sync it')) return;
  const ds = _data(slave), dmst = _data(master);
  if (!ds || !ds.bpm || !dmst || !dmst.bpm) { showToast('One of the tracks has no BPM yet', true); return; }
  const es = _el(slave), em = _el(master);
  if (!es || !em) return;
  const r = dm.syncRate(Number(dmst.bpm), em.playbackRate || 1, Number(ds.bpm));
  if (!r) return;
  const pct = dm.rateToPct(r.rate);
  if (Math.abs(pct) > SYNC_MAX_PCT) { showToast(`Tempos too far apart to sync (${dm.formatPitch(r.rate)})`, true); return; }
  if (!_setRate(slave, r.rate)) return;
  if (Math.abs(pct) > _range[slave]) _setRange(slave, SYNC_MAX_PCT);
  if (slave === info.active) { _status('Tempo synced. The beat is moved only on the deck that is not live.'); return; }
  if (es.paused || em.paused) { _status('Tempo synced. Play both decks to line up the beat.'); return; }
  const shift = dm.phaseShift(
    { grid: dmst.beat_grid, pos: em.currentTime, rate: em.playbackRate || 1, bpm: Number(dmst.bpm) },
    { grid: ds.beat_grid, pos: es.currentTime, rate: r.rate, bpm: Number(ds.bpm) },
  );
  if (shift != null && Math.abs(shift) > 0.004) _eng.deskSeek(slave, Math.max(0, es.currentTime + shift));
  _status(`Deck ${slave} synced to deck ${master}`);
}

function _seekFraction(key, frac) {
  if (!_canDrive(key, 'seek')) return;
  const dur = _dur(key);
  if (!dur) return;
  if (!_eng.deskSeek(key, dm.clamp(frac, 0, 1) * dur)) showToast('The player cannot move this deck right now', true);
}

// ───────────────────────── transport ─────────────────────────

function _mixNow() {
  const info = _info;
  if (!_eng || !info || _blocked) return false;
  if (_mix) { showToast('Finish the crossfader mix first', true); return false; }
  // Ask the engine as it is NOW (the cached info is up to 200 ms old): a refused mix
  // must not leave the deck's track bound as next behind the user's back.
  let fresh = info;
  try { fresh = _eng.deskInfo() || info; } catch {}
  if (fresh.blocked || fresh.crossfading || fresh.busy || fresh.mixing || fresh.playing === false) {
    showToast(fresh.playing === false && !fresh.crossfading && !fresh.busy ? 'The live deck is not playing' : 'The player cannot mix right now', true);
    return false;
  }
  let startAt = null;
  let rebound = false;
  let fromStart = false;      // the cue position cannot be used (see below)
  const prevNext = fresh.deskNext;
  const prep = fresh.loan;
  if (prep && fresh.items[prep]) {
    _info = fresh;
    const idx = _indexOf(prep);
    if (idx >= 0 && idx !== fresh.index) {
      try { rebound = !!_eng.deskSetNext(idx); } catch { rebound = false; }
      const el = _el(prep);
      if (el && el.currentTime > 0.5) startAt = el.currentTime;
      // The engine starts the incoming track at startAt only from a downloaded copy. A
      // headphone preview does not download (warm:false); Load does.
      const it = fresh.items[prep];
      if (startAt != null && !getCachedUrl(_decode(it.name || ''), _decode(it.artist || ''), it.id)) fromStart = true;
    }
  }
  let ok = false;
  try { ok = _eng.deskMixNow(startAt != null ? { startAt } : {}); } catch { ok = false; }
  if (!ok) {
    if (rebound) { try { _eng.deskSetNext(prevNext ?? null); } catch {} }
    showToast(fresh.next == null && !rebound ? 'Nothing to mix into — the queue ends here' : 'The player cannot mix right now', true);
    return false;
  }
  _status(fromStart ? 'Mixing in from the track’s start — the cue position needs the track downloaded (Load downloads it)'
    : 'Mixing into the next track…', fromStart ? 6000 : 3500);
  _listDirty = true;
  return true;
}

/** The engine keys its download cache by the decoded name (player_v3 _decodeEntities). */
function _decode(s) {
  if (!s || !s.includes('&')) return s;
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function _togglePhrase() {
  if (_phrase) { _cancelPhrase('Phrase mix cancelled'); return; }
  const info = _info;
  if (!info || _blocked) return;
  if (_mix || info.crossfading) { showToast('A transition is already running', true); return; }
  const key = info.active;
  const el = _el(key);
  const d = _data(key);
  if (!el || el.paused) { showToast('The live deck is not playing', true); return; }
  const p = d ? dm.nextPhrase(el.currentTime, { downbeats: d.downbeats, beatGrid: d.beat_grid, bpm: Number(d.bpm) }) : null;
  if (!p) { showToast('No beat grid for the live track — use Mix now', true); return; }
  const dur = _dur(key);
  if (dur && p.at >= dur - 1) { showToast('The track ends before its next phrase — use Mix now', true); return; }
  _phrase = { key, item: info.items[key], at: p.at, boundary: p.boundary, timer: setInterval(_phraseTick, 50) };
  $('#ddMixPhrase')?.classList.add('armed');
  _phraseTick();
}

function _cancelPhrase(msg) {
  if (!_phrase) return;
  clearInterval(_phrase.timer);
  _phrase = null;
  const b = $('#ddMixPhrase');
  if (b) { b.classList.remove('armed'); b.textContent = 'Mix on phrase'; }
  if (msg) _status(msg);
}

function _phraseTick() {
  const p = _phrase;
  if (!p || !store.deskOpen) return;
  let info = _info;
  if (_eng) { try { info = _eng.deskInfo(); } catch {} }
  if (!info || info.active !== p.key || info.items[p.key] !== p.item || info.crossfading || _blocked) {
    _cancelPhrase('Phrase mix cancelled — the live track changed');
    return;
  }
  const el = _el(p.key);
  if (!el) return;
  const pos = el.currentTime || 0;
  const rate = el.playbackRate > 0 ? el.playbackRate : 1;
  const d = _data(p.key);
  if (pos >= p.at) {
    if (pos - p.at < 1.5) {
      _cancelPhrase();
      _info = info;
      _mixNow();
      return;
    }
    // A seek jumped over the trigger: aim at the phrase after it instead.
    const n = d ? dm.nextPhrase(pos, { downbeats: d.downbeats, beatGrid: d.beat_grid, bpm: Number(d.bpm) }) : null;
    if (!n) { _cancelPhrase('Phrase mix cancelled'); return; }
    p.at = n.at; p.boundary = n.boundary;
  } else if (d && p.at - pos > 60) {
    // A seek back: the nearest phrase may be much closer now.
    const n = dm.nextPhrase(pos, { downbeats: d.downbeats, beatGrid: d.beat_grid, bpm: Number(d.bpm) });
    if (n && n.at < p.at) { p.at = n.at; p.boundary = n.boundary; }
  }
  const b = $('#ddMixPhrase');
  if (b) b.textContent = `Mix in ${((p.at - pos) / rate).toFixed(1)} s · cancel`;
}

function _setManual(on) {
  if (!_eng || _blocked) return;
  try { _eng.deskSetManual(!!on); } catch {}
  _refreshInfo();
  _status(on ? 'Manual: only you start a transition. A track that ends still goes on to the next one.' : 'Auto: the player mixes into the next track by itself.', 5000);
}

// ───────────────────────── crossfader ─────────────────────────

function _onFader(x) {
  const info = _info;
  const f = $('#ddXfader');
  if (!_eng || !info || _blocked) return;
  if (!_mix) {
    const live = info.active;
    const t = dm.mixAmount(x, live);
    if (t < 0.02) return;
    const prep = info.loan;
    const snap = (msg) => { if (f) f.value = String(dm.sideOf(live) * 1000); _faderDrag = false; if (msg) showToast(msg, true); };
    if (info.crossfading) { snap('Wait until the player finishes its transition'); return; }
    if (!prep || !info.items[prep] || _indexOf(prep) < 0) { snap('Load a track from the queue onto the free deck first'); return; }
    const el = _el(prep);
    if (el && el.paused) { el.play().catch(() => {}); }
    let ok = false;
    try { ok = _eng.deskBeginMix(); } catch { ok = false; }
    if (!ok) { snap(el && el.paused ? 'Press play on the free deck first' : 'The player cannot start a mix right now'); return; }
    _cancelPhrase();
    _mix = { from: live, to: prep, t };
    _eng.deskMixLevel(t);
    _status(`Mixing ${live} → ${prep}`);
    _listDirty = true;
    _refreshInfo();
    return;
  }
  const t = dm.mixAmount(x, _mix.from);
  _mix.t = t;
  if (t >= 0.995) {
    const to = _mix.to;
    _mix = null;
    _eng.deskEndMix(true);
    if (f) f.value = String(dm.sideOf(to) * 1000);
    _status(`Deck ${to} is live`);
    _listDirty = true;
    _refreshInfo();
  } else if (t <= 0.005) {
    const from = _mix.from;
    _mix = null;
    _eng.deskEndMix(false);
    if (f) f.value = String(dm.sideOf(from) * 1000);
    _status('Mix taken back');
    _listDirty = true;
    _refreshInfo();
  } else {
    _eng.deskMixLevel(t);
    _syncFader();
  }
}

function _faderStep(dir) {
  const f = $('#ddXfader');
  if (!f || f.disabled) return;
  const v = dm.clamp(Number(f.value) + dir * 100, 0, 1000);
  f.value = String(v);
  _onFader(v / 1000);
}

// ───────────────────────── lists ─────────────────────────

async function _hydrate() {
  const q = store.playerQueue;
  if (!q.length || _hydratedFor === q) return;
  _hydratedFor = q;
  try { await hydrateBpmByName(q); } catch {}
  _listDirty = true;
}

const HP_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg>';

function _rowHtml(i, pos, { now, next, deck, smart, reason }) {
  const it = store.playerQueue[i];
  const d = getDjData(it.name, it.artist);
  const bpm = d ? displayBpm(d) : null;
  const tags = [];
  if (now) tags.push('<span class="dd-chip dd-chip-live">LIVE</span>');
  if (deck) tags.push(`<span class="dd-chip dd-chip-cue">ON ${deck}</span>`);
  if (next) tags.push('<span class="dd-chip dd-chip-next">NEXT</span>');
  if (smart) tags.push('<span class="dd-chip dd-chip-smart" title="What Smart Queue would pick">Smart pick</span>');
  if (reason) tags.push(reason);
  const meta = [
    bpm != null ? `<span class="dd-row-bpm">${Math.round(Number(bpm))}</span>` : '<span class="dd-row-bpm dd-dim">–</span>',
    `<span class="dd-row-key">${d && d.camelot ? esc(d.camelot) : ''}</span>`,
    d ? _energyHtml(energyLevel(d), d.energy) : '',
  ].join('');
  const acts = now ? '' : `
      <button class="dd-btn dd-mini" type="button" data-act="load" title="Load onto the free deck">Load</button>
      <button class="dd-btn dd-mini dd-ic" type="button" data-act="cue" title="Listen in the headphones" aria-label="Listen in the headphones">${HP_SVG}</button>
      <button class="dd-btn dd-mini" type="button" data-act="next" title="Play this next">Next</button>`;
  return `<div class="dd-row${now ? ' is-now' : ''}${next ? ' is-next' : ''}${deck ? ' is-loaded' : ''}" role="listitem" data-qi="${i}">
    <span class="dd-row-pos">${pos}</span>
    <div class="dd-row-main"><div class="dd-row-name">${esc(it.name || '')}</div><div class="dd-row-sub">${esc(it.artist || '')}${tags.length ? ' ' + tags.join('') : ''}</div></div>
    <span class="dd-row-meta">${meta}</span>
    <span class="dd-row-acts">${acts}</span>
  </div>`;
}

function _renderLists(force) {
  const info = _info;
  const q = store.playerQueue;
  if (!info) return;
  if (_hydratedFor !== q) _hydrate();
  const order = playOrder();
  const curPos = order.indexOf(info.index);
  const upcoming = curPos >= 0 ? order.slice(curPos) : order;
  const nextIdx = info.deskNext != null ? info.deskNext : info.next;
  const loaded = {};
  for (const k of KEYS) { const i = _indexOf(k); if (i >= 0 && k !== info.active) loaded[i] = k; }
  const liveData = _data(info.active);
  const sig = [q.length, info.index, nextIdx, JSON.stringify(loaded), upcoming.slice(0, 200).join(','),
    liveData ? liveData.bpm + liveData.camelot : '-'].join('|');
  if (!force && !_listDirty && sig === _listSig) return;
  _listDirty = false;
  _listSig = sig;

  const qEl = $('#ddQueue');
  if (qEl) {
    const rows = upcoming.slice(0, 200).map((i, n) => _rowHtml(i, n === 0 ? '▶' : n, {
      now: i === info.index, next: i === nextIdx, deck: loaded[i] || null,
    }));
    qEl.innerHTML = rows.length ? rows.join('') : '<p class="dd-empty">The queue is empty.</p>';
    const sub = $('#ddQueueSub');
    if (sub) sub.textContent = upcoming.length ? `${upcoming.length - 1} to come${store.shuffleEnabled ? ' · shuffle' : ''}` : '';
  }

  const sEl = $('#ddSuggest');
  if (!sEl) return;
  const live = liveData && liveData.bpm ? {
    bpm: Number(liveData.bpm), camelot: liveData.camelot,
    energy: _djmix ? _djmix.usableEnergy(liveData) : NaN,
  } : null;
  if (!live) {
    sEl.innerHTML = '<p class="dd-empty">The live track has no BPM yet, so there is nothing to match against.</p>';
    return;
  }
  const cands = upcoming.slice(1).filter(i => i !== info.index).map(i => {
    const it = q[i];
    const d = getDjData(it.name, it.artist);
    return { idx: i, data: d && d.bpm ? { bpm: Number(d.bpm), camelot: d.camelot, energy: _djmix ? _djmix.usableEnergy(d) : NaN } : null };
  });
  let smart = null;
  if (_djmix && typeof _djmix.pickSmartNext === 'function') {
    const mode = (() => { try { const v = localStorage.getItem('ms_dj_smart_queue'); return v && v !== 'off' ? v : 'bpm_key'; } catch { return 'bpm_key'; } })();
    // repeatAll=false: pickSmartNext is side-effect free on this path (it only clears its
    // played set when repeat-all has used up the queue).
    try { smart = _djmix.pickSmartNext(q, info.index, liveData, mode, false); } catch { smart = null; }
  }
  const ranked = dm.rankSuggestions(live, cands.filter(c => c.data), { limit: 8 });
  // Only a pick the player can still reach counts (Smart Queue off: it knows nothing of
  // what has been played and may name a track from before the current one).
  if (smart != null && smart !== info.index && cands.some(c => c.idx === smart)) {
    const at = ranked.findIndex(r => r.idx === smart);
    const entry = at >= 0 ? ranked.splice(at, 1)[0] : { idx: smart, bpmDist: null, relation: null };
    ranked.unshift(entry);
    if (ranked.length > 8) ranked.length = 8;
  }
  const relTxt = { same: 'same key', relative: 'relative', adjacent: 'key ±1', energy: 'key ±2', clash: 'key clash' };
  const rows = ranked.filter(r => q[r.idx]).map((r, n) => {
    const chips = [];
    if (r.bpmDist != null) chips.push(`<span class="dd-chip">Δ${r.bpmDist < 10 ? r.bpmDist.toFixed(1) : Math.round(r.bpmDist)} BPM</span>`);
    if (r.relation) chips.push(`<span class="dd-chip rel-${r.relation}">${relTxt[r.relation]}</span>`);
    return _rowHtml(r.idx, n + 1, { next: r.idx === nextIdx, deck: loaded[r.idx] || null, smart: r.idx === smart && n === 0, reason: chips.join('') });
  });
  sEl.innerHTML = rows.length ? rows.join('') : '<p class="dd-empty">No upcoming track has DJ data yet.</p>';
  const sub = $('#ddSuggestSub');
  if (sub) sub.textContent = 'from the upcoming queue';
}

async function _loadToFree(idx) {
  const info = _info;
  const item = store.playerQueue[idx];
  if (!_eng || !info || _blocked || !item) return;
  if (idx === info.index) { showToast('That track is playing', true); return; }
  if (_mix) { showToast('Finish the crossfader mix first', true); return; }
  let key = info.loan;
  if (!key) { try { key = _eng.deskLend(); } catch { key = null; } }
  if (!key) {
    let b = null;
    try { b = _eng.deskInfo().blocked; } catch {}
    showToast(b === 'rec' ? 'Not available while a recommendation plays' : 'The free deck is busy — try again after the transition', true);
    return;
  }
  // A cue preview that sat on this deck is replaced by the desk's own load.
  try { const pv = cuebus.previewState && cuebus.previewState(); if (pv && pv.key === key) cuebus.stopPreview(); } catch {}
  if (!_eng.deskInfo().loan) { try { key = _eng.deskLend(); } catch { key = null; } if (!key) return; }
  if (_cueApi() && _cueMode() !== 'off') {
    if (!_cueHeld) await _acquireCue();
    cuebus.setDeckCue(key, true);
    _syncCueUi();
  }
  _status(`Loading on deck ${key}…`, 0);
  let ok = false;
  // warm: this track is prepared to be MIXED — its file is fetched whole for the transition.
  try { ok = await _eng.deskLoad(item, { index: idx, play: true, warm: true }); } catch { ok = false; }
  if (!store.deskOpen) return;
  _status(ok ? `Deck ${key}: ${item.name || ''}` : '');
  if (!ok) showToast('Could not load the track', true);
  _listDirty = true;
  _refreshInfo();
}

async function _cueRow(idx) {
  const item = store.playerQueue[idx];
  if (!item) return;
  if (typeof cuebus.previewItem !== 'function') { _loadToFree(idx); return; }
  const pv = cuebus.previewState ? cuebus.previewState() : null;
  if (pv && pv.item === item) { cuebus.stopPreview(); _listDirty = true; return; }
  if (_mix) { showToast('Finish the crossfader mix first', true); return; }
  await cuebus.previewItem(item, { index: idx });
  _listDirty = true;
}

function _setNext(idx) {
  if (!_eng || _blocked) return;
  const item = store.playerQueue[idx];
  let ok = false;
  try { ok = _eng.deskSetNext(idx); } catch { ok = false; }
  if (ok) _status(`Plays next: ${item ? item.name || '' : ''}`); else showToast('Cannot set that as next', true);
  _listDirty = true;
}

function _onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.dd-row');
  const idx = row ? parseInt(row.dataset.qi, 10) : NaN;
  if (!Number.isInteger(idx)) return;
  const act = btn.dataset.act;
  if (act === 'load') _loadToFree(idx);
  else if (act === 'cue') _cueRow(idx);
  else if (act === 'next') _setNext(idx);
}

// ───────────────────────── keyboard ─────────────────────────

function _typing(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes(el.type);
  return false;
}

function _toggleHelp(on) {
  const h = $('#ddHelp');
  if (!h) return;
  const show = on == null ? h.hidden : !!on;
  h.hidden = !show;
  $('#ddHelpBtn')?.setAttribute('aria-expanded', show ? 'true' : 'false');
}

const KEYMAP = {
  KeyQ: ['pfl', 'A'], KeyP: ['pfl', 'B'],
  KeyW: ['cue', 'A'], KeyO: ['cue', 'B'],
  KeyE: ['sync', 'A'], KeyI: ['sync', 'B'],
  KeyD: ['pitch', 'A', -1], KeyF: ['pitch', 'A', 1], KeyH: ['pitch', 'B', -1], KeyJ: ['pitch', 'B', 1],
  KeyA: ['nudge', 'A', -1], KeyS: ['nudge', 'A', 1], KeyK: ['nudge', 'B', -1], KeyL: ['nudge', 'B', 1],
  KeyC: ['fader', null, -1], KeyV: ['fader', null, 1],
  KeyM: ['mode'], KeyN: ['phrase'],
};

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

function _onKey(e) {
  if (!store.deskOpen) return;
  if (ARROWS.includes(e.key)) {
    // The player's global arrows (next / previous track, master volume) must not fire
    // under the desk. A slider or select keeps its own arrows (the global handler skips
    // those anyway), and so does the Auto / Manual radio group, which handles them on
    // its own element — a stop here, in the capture phase, would never let them reach it.
    const a = document.activeElement;
    const own = a && (['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) || a.isContentEditable || a.closest?.('#ddMode'));
    if (!own) e.stopPropagation();       // no preventDefault: the lists still scroll
    return;
  }
  if (store.dialogStack && store.dialogStack.length) return;   // a dialog on top owns the keys
  if (_typing(document.activeElement)) return;
  const help = $('#ddHelp');
  if (e.key === 'Escape' && help && !help.hidden) { e.preventDefault(); e.stopPropagation(); _toggleHelp(false); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === '?') { stop(); _toggleHelp(); return; }
  if (e.key === '/') { stop(); return; }                      // the global search jump would land under the desk
  if (_blocked) return;
  const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
  // Space / Enter on a focused desk button press that button, and only that: the global
  // Space (play / pause) must not fire as well.
  if (onButton && !e.shiftKey && (e.code === 'Space' || e.key === 'Enter') && $('#djDesk').contains(document.activeElement)) {
    e.stopPropagation();
    return;
  }
  if (e.key === 'Enter') {
    stop();
    if (e.repeat) return;
    if (e.shiftKey) _togglePhrase(); else _mixNow();
    return;
  }
  const m = KEYMAP[e.code];
  if (!m) return;
  stop();
  const [act, key, dir] = m;
  if (act === 'nudge') { if (!e.repeat) _nudgeStart(key, dir, 'key:' + e.code); return; }
  if (act === 'pitch') { _pitchBy(key, dir * PITCH_STEP); return; }
  if (act === 'fader') { _faderStep(dir); return; }
  if (e.repeat) return;
  if (act === 'pfl') _togglePfl(key);
  else if (act === 'cue') { if (e.shiftKey) _setCue(key); else _jumpCue(key); }
  else if (act === 'sync') _sync(key);
  else if (act === 'mode') _setManual(!(_info && _info.manual));
  else if (act === 'phrase') _togglePhrase();
}

function _onKeyUp(e) {
  if (_nudge && _nudge.via === 'key:' + e.code) { e.stopPropagation(); _nudgeEnd(); }
}

// ───────────────────────── build + init ─────────────────────────

function _buildDeck(key) {
  const root = $('#ddDeck' + key), tpl = $('#ddDeckTpl');
  if (!root || !tpl) return;
  root.appendChild(tpl.content.cloneNode(true));
  const q = (s) => root.querySelector(s);
  const ui = {
    root, art: q('.dd-art'), name: q('.dd-name'), artist: q('.dd-artist'), badge: q('.dd-badge'),
    bpm: q('.dd-bpm'), keyEl: q('.dd-key'), energy: q('.dd-energy'), pitchRead: q('.dd-pitch-read'),
    zoom: q('.dd-zoom'), over: q('.dd-over'), elapsed: q('.dd-elapsed'), remain: q('.dd-remain'),
    pitch: q('.dd-pitch-range'), rangeBtn: q('[data-act="range"]'), pfl: q('[data-act="pfl"]'),
    play: q('[data-act="play"]'), sig: '', bpmHtml: null, playing: null, pitchDrag: false,
  };
  q('.dd-letter').textContent = key;
  // A cover URL that fails: the app's srcless placeholder (base.css img:not([src])).
  ui.art.addEventListener('error', () => ui.art.removeAttribute('src'));
  _ui[key] = ui;

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !root.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'play') _togglePlay(key);
    else if (act === 'cue') _jumpCue(key);
    else if (act === 'setcue') _setCue(key);
    else if (act === 'pfl') _togglePfl(key);
    else if (act === 'sync') _sync(key);
    else if (act === 'pitch0') { if (_canDrive(key, 'change its tempo')) _setRate(key, 1); }
    else if (act === 'range') _setRange(key, _range[key] === 8 ? 16 : 8);
  });
  for (const b of root.querySelectorAll('.dd-nudge')) {
    const dir = b.dataset.act === 'nudge+' ? 1 : -1;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch {}
      _nudgeStart(key, dir, 'ptr');
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, () => _nudgeEnd('ptr'));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const pitch = ui.pitch;
  pitch.addEventListener('pointerdown', () => { ui.pitchDrag = true; });
  pitch.addEventListener('input', () => {
    if (!_canDrive(key, 'change its tempo')) return;
    _setRate(key, dm.pctToRate(Number(pitch.value)));
  });
  const endPitch = () => { ui.pitchDrag = false; pitch.blur(); };
  pitch.addEventListener('pointerup', endPitch);
  pitch.addEventListener('pointercancel', endPitch);
  pitch.addEventListener('dblclick', () => { if (_canDrive(key, 'change its tempo')) _setRate(key, 1); });
  ui.over.addEventListener('click', (e) => {
    const r = ui.over.getBoundingClientRect();
    if (r.width > 0) _seekFraction(key, (e.clientX - r.left) / r.width);
  });
}

export function init() {
  const root = $('#djDesk');
  if (!root) return;
  _buildDeck('A');
  _buildDeck('B');

  $('#ddClose')?.addEventListener('click', () => closeDesk());
  $('#ddHelpBtn')?.addEventListener('click', () => _toggleHelp());
  $('#ddHelpClose')?.addEventListener('click', () => _toggleHelp(false));
  $('#ddCueSetupBtn')?.addEventListener('click', () => _openCueSetup());
  $('#ddMixNow')?.addEventListener('click', () => _mixNow());
  $('#ddMixPhrase')?.addEventListener('click', () => _togglePhrase());

  const mode = $('#ddMode');
  mode?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) _setManual(b.dataset.v === 'manual');
  });
  mode?.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const manual = !(_info && _info.manual);
    _setManual(manual);
    mode.querySelector(`button[data-v="${manual ? 'manual' : 'auto'}"]`)?.focus();
  });

  const f = $('#ddXfader');
  if (f) {
    f.addEventListener('pointerdown', () => { _faderDrag = true; });
    f.addEventListener('input', () => _onFader(Number(f.value) / 1000));
    const end = () => { _faderDrag = false; f.blur(); };
    f.addEventListener('pointerup', end);
    f.addEventListener('pointercancel', end);
    f.addEventListener('change', () => { _faderDrag = false; });
  }
  $('#ddCueVol')?.addEventListener('input', (e) => { if (_cueApi()) cuebus.setCueSettings({ volume: Number(e.target.value) / 100 }); });
  $('#ddCueMix')?.addEventListener('input', (e) => { if (_cueApi()) cuebus.setCueSettings({ mix: Number(e.target.value) / 100 }); });
  for (const id of ['#ddCueVol', '#ddCueMix']) $(id)?.addEventListener('pointerup', (e) => e.target.blur());

  $('#ddQueue')?.addEventListener('click', _onListClick);
  $('#ddSuggest')?.addEventListener('click', _onListClick);

  // Entry points: the full player's action row and the DJ controls drawer (DJ engine only;
  // switching the engine reloads the page, so this is decided once).
  const isDj = getPlayerEngine() === 'dj';
  const fpBtn = $('#fpDeskBtn');
  if (fpBtn) { fpBtn.style.display = isDj ? '' : 'none'; fpBtn.addEventListener('click', () => openDesk()); }
  const drawerBtn = $('#fpDjDeskOpen');
  if (drawerBtn) {
    drawerBtn.addEventListener('click', () => {
      import('./djpanel.js').then(m => m.closeDjPanelFromRouter && m.closeDjPanelFromRouter()).catch(() => {});
      openDesk();
    });
  }

  document.addEventListener('desk:engine', (e) => {
    if (!store.deskOpen) return;
    const d = (e && e.detail) || {};
    if (d.type === 'revoked' && d.reason && !['release', 'mixnow', 'advance'].includes(d.reason)) {
      _status(`Deck ${d.key || ''} went back to the player (${d.reason})`);
    }
    if (d.type === 'mixend' || d.type === 'revoked' || d.type === 'swap') { _mix = (d.type === 'mixend') ? null : _mix; _listDirty = true; }
    _refreshInfo();
  });
  if (typeof cuebus.onCueChange === 'function') cuebus.onCueChange(_onCueChange);

  window.addEventListener('keydown', _onKey, true);
  window.addEventListener('keyup', _onKeyUp, true);
  window.addEventListener('blur', () => _nudgeEnd());
}
