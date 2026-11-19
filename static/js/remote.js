// remote.js — Spotify-Connect-style device→device remote control.
//
// One device (controller) drives another device's playback over SSE. Both belong
// to the same user. This module:
//   - reports THIS tab's playback state (3 s while another device of the user is
//     online, 15 s otherwise, at once after a command or a `remote:report`),
//   - listens on an SSE stream for `devices` snapshots and `command` events,
//   - applies inbound commands to LOCAL playback when THIS tab is the target,
//   - lets the user pick another device to control and intercepts the existing
//     player-bar controls so they drive the remote device instead.
//
// The binding protocol is notes/impl/remote-opravy-kontrakt.md. In short:
//   * the controller is a remote, not a player: it never makes sound, never saves
//     its queue, never mirrors into a Navidrome playlist — every change is a
//     command the target carries out with its own functions;
//   * everything the controller paints comes from the target's report;
//   * engines stay decoupled: they talk to this module through DOM events
//     (`remote:play`, `remote:enqueue`, `remote:cmd`, `remote:report`,
//     `remote:queue-saved`) and never import it.

import { store, newTabId } from './store.js';
import { $, $$, esc, fmtTime, showToast, setArt } from './utils.js';
import { apiJson, refreshStreamToken } from './api.js';
import { getPlayerModule } from './player_active.js';

// Modules owned by other files are loaded lazily and called through optional
// chaining, so an export that is missing (or renamed) degrades instead of throwing,
// and importing them here does not change the app's module evaluation order.
// app.js has already loaded all three, so these resolve immediately.
const _mods = { queue: null, fp: null, dj: null };
function _loadMods() {
  import('./queue.js').then(m => { _mods.queue = m; }).catch(() => {});
  import('./fullplayer.js').then(m => { _mods.fp = m; }).catch(() => {});
  import('./djpanel.js').then(m => { _mods.dj = m; }).catch(() => {});
}
const _queue = () => _mods.queue ? Promise.resolve(_mods.queue) : import('./queue.js').then(m => (_mods.queue = m));
const _fp = () => _mods.fp ? Promise.resolve(_mods.fp) : import('./fullplayer.js').then(m => (_mods.fp = m));
const _dj = () => _mods.dj ? Promise.resolve(_mods.dj) : import('./djpanel.js').then(m => (_mods.dj = m));

const OFFLINE_GRACE_MS = 15000;   // B9: a target that dropped its SSE gets this long to come back
const STALE_AFTER_S = 10;         // B20: no state report for this long → "isn't responding"
const COMMAND_MAX_AGE_S = 5;      // B20: a command older than this is not applied
const SKIP_LOCK_MS = 2000;        // B12: Next/Prev ignore presses until the target moved
const OPTIMISTIC_MS = 2500;       // B12: optimistic play/pause icon without an ack
const VOLUME_THROTTLE_MS = 150;   // B22
const VOLUME_HOLD_MS = 2000;      // B22: no slider repaint this long after the last touch
const QUEUE_REFETCH_LATER_MS = 2500; // the target saves its queue 2 s after a change

let _stopped = false;  // set by stopRemote() to kill any in-flight reconnect after logout

// ── Server clock (B20) ──
// offset = server_time − local time (s). The first event after a (re)connect sets it.
// After that a HIGHER sample is taken at once: an event delivered late makes the
// offset look smaller, so the largest sample is the least-delayed estimate.
// A LOWER sample is not trusted on its own — a backlog delivered after a frozen tab
// looks exactly like that, and taking it would make the stale commands in the same
// backlog look fresh. But this device's clock can also step FORWARD (NTP, a manual
// change); kept, the old offset would make every command look that much older, and
// a step over 5 s dropped every command until the next reconnect. So a lower offset
// is accepted once LOWER_RUN samples in a row agree on it within LOWER_AGREE_S and
// span at least LOWER_SPAN_MS of this device's time — a backlog flush cannot do that
// (its events arrive together and their offsets differ by their own spacing).
const LOWER_RUN = 3;
const LOWER_AGREE_S = 1;
const LOWER_SPAN_MS = 20000;
let _offset = null;
let _offsetFresh = true;
let _lastServerTime = null;
let _lowRun = [];   // [{o, at}] consecutive samples lower than _offset

function _noteServerTime(t) {
  if (typeof t !== 'number' || !isFinite(t)) return;
  _lastServerTime = t;
  const now = Date.now();
  const o = t - now / 1000;
  if (_offset === null || _offsetFresh || o >= _offset - LOWER_AGREE_S) {
    if (_offset === null || _offsetFresh || o > _offset) _offset = o;
    _offsetFresh = false;
    _lowRun = [];
    return;
  }
  if (_lowRun.length && Math.abs(o - _lowRun[0].o) > LOWER_AGREE_S) _lowRun = [];
  _lowRun.push({ o, at: now });
  if (_lowRun.length >= LOWER_RUN && now - _lowRun[0].at >= LOWER_SPAN_MS) {
    _offset = Math.max(..._lowRun.map(x => x.o));
    _lowRun = [];
  }
}

function _nowServer() { return Date.now() / 1000 + (_offset ?? 0); }

/** Seconds since the device last reported, or 0 when that cannot be told. */
function _reportAge(dev) {
  // updated_at 0 = the device never reported: unknown, not stale.
  if (!dev || typeof dev.updated_at !== 'number' || !(dev.updated_at > 0)) return 0;
  if (_offset !== null) return Math.max(0, _nowServer() - dev.updated_at);
  const st = typeof dev.server_time === 'number' ? dev.server_time : _lastServerTime;
  return typeof st === 'number' ? Math.max(0, st - dev.updated_at) : 0;
}

function _isStale(dev) { return !!(dev && dev.online) && _reportAge(dev) > STALE_AFTER_S; }

function _devName(id) {
  const dev = store.remoteDevices[id];
  return (dev && dev.name) || (id ? `Device ${String(id).slice(0, 6)}` : 'device');
}

function _targetDev() {
  return store.remoteTarget ? (store.remoteDevices[store.remoteTarget] || null) : null;
}

// ── Tab identity (B3) ──
// A duplicated browser tab copies sessionStorage, so two tabs can start with the same
// `ms_tab_id`; the broker would then keep closing one connection for the other. A tab
// that announces itself and hears its id is taken takes a new one.
let _tabChannel = null;
let _helloAt = 0;

function _setupTabChannel() {
  if (_tabChannel || typeof BroadcastChannel === 'undefined') return;
  try {
    _tabChannel = new BroadcastChannel('ms_remote_tab');
    _tabChannel.onmessage = (e) => {
      const d = e.data || {};
      if (d.id !== store.tabId) return;
      if (d.t === 'hello') {
        _tabChannel.postMessage({ t: 'taken', id: d.id });
      } else if (d.t === 'taken' && Date.now() - _helloAt < 3000) {
        store.tabId = newTabId();
        try { sessionStorage.setItem('ms_tab_id', store.tabId); } catch {}
        _reconnectNow();
      }
    };
    _helloAt = Date.now();
    _tabChannel.postMessage({ t: 'hello', id: store.tabId });
  } catch { _tabChannel = null; }
}

// Without BroadcastChannel (old Safari) a duplicated tab cannot be told by the
// hello/taken exchange; two tabs on one id then keep replacing each other's stream —
// each connects, the server closes the other, which reconnects 5 s later. Three
// connections that each lived under 20 s within a minute → take a new tab id, once.
let _quickDrops = [];
let _tabIdRegenerated = false;
function _noteQuickDrop(openedAt) {
  if (_tabChannel || _tabIdRegenerated || typeof BroadcastChannel !== 'undefined') return;
  const now = Date.now();
  if (now - openedAt > 20000) { _quickDrops = []; return; }
  _quickDrops = _quickDrops.filter(t => now - t < 60000);
  _quickDrops.push(now);
  if (_quickDrops.length >= 3) {
    _tabIdRegenerated = true;
    _quickDrops = [];
    store.tabId = newTabId();
    try { sessionStorage.setItem('ms_tab_id', store.tabId); } catch {}
  }
}

// ── SSE connection ──
// Connections that failed before delivering anything (no token, 401, 429 "Too many
// devices online", server down) back off 5 → 10 → 20 → 40 → 60 s; an EventSource
// cannot read the status, so a 429 is not told apart — it just ends up at 60 s
// instead of hammering every 5 s. A connection that worked and then dropped (token
// expiry after 1 h, a deploy) comes back after 5 s.
let _connFails = 0;
function _scheduleReconnect() {
  clearTimeout(store.remoteReconnectTimer);
  if (_stopped) return;
  const delay = Math.min(60000, 5000 * 2 ** Math.max(0, _connFails - 1));
  store.remoteReconnectTimer = setTimeout(connectSSE, delay);
}

/** A token for /api/remote/events, minted fresh for every (re)connect: the server
 *  closes the stream when it expires (1 h) and the reconnect then needs a new one. */
async function _mintRemoteToken() {
  try {
    const d = await apiJson(`/api/remote/token?device_id=${encodeURIComponent(store.deviceId || '')}`);
    if (d && typeof d.token === 'string' && d.token) {
      return { token: d.token, expiresIn: Number(d.expires_in) > 0 ? Number(d.expires_in) : 0 };
    }
  } catch (err) {
    if (!(err && err.status === 404)) return null;   // offline, 401, 5xx: try again later
  }
  // A server without the endpoint (an old backend during a deploy) still takes the
  // stream-scoped token there. Never the session JWT: query strings leak into logs.
  await refreshStreamToken();
  return store.streamToken ? { token: store.streamToken, expiresIn: 0 } : null;
}

// N8: the server closes the stream when its token expires (1 h); commands sent in the
// gap until the reconnect answered 404. So 5 min before expiry a new connection is
// opened BEFORE the old one goes: the server, seeing the same tab register again,
// closes the old one and moves its pending commands over. Until then the old
// (`_retiring`) still delivers commands — a command it carries is applied once (ids
// are de-duplicated) — and its end is not a reason to reconnect.
const ROTATE_BEFORE_S = 300;
let _rotateTimer = null;
let _retiring = null;

function _armRotation(expiresIn) {
  clearTimeout(_rotateTimer); _rotateTimer = null;
  if (!(expiresIn > 0)) return;
  _rotateTimer = setTimeout(_rotateConnection, Math.max(60, expiresIn - ROTATE_BEFORE_S) * 1000);
}

function _rotateConnection() {
  _rotateTimer = null;
  if (_stopped || !store.remoteEventSource) return;
  _retiring = store.remoteEventSource;
  connectSSE();
}

function _closeRetiring() {
  const old = _retiring;
  _retiring = null;
  if (old && old !== store.remoteEventSource) { try { old.close(); } catch {} }
}

function _reconnectNow() {
  if (_stopped) return;
  clearTimeout(store.remoteReconnectTimer);
  const es = store.remoteEventSource;
  store.remoteEventSource = null;
  if (es) { try { es.close(); } catch {} }
  connectSSE();
}

let _connGen = 0;

async function connectSSE() {
  if (_stopped) return;
  const gen = ++_connGen;   // a later connect (new tab id, reconnect) supersedes this one
  if (!store.deviceId) { _connFails++; _scheduleReconnect(); return; }
  const minted = await _mintRemoteToken();
  if (_stopped || gen !== _connGen) return;
  if (!minted) {
    // A rotation that could not mint keeps the old connection, which still works
    // until its token expires; try again in a minute.
    if (_retiring && _retiring === store.remoteEventSource) { _retiring = null; _armRotation(60 + ROTATE_BEFORE_S); return; }
    _connFails++; _scheduleReconnect(); return;
  }
  const token = minted.token;
  try {
    const url = `/api/remote/events?token=${encodeURIComponent(token)}`
      + `&device_id=${encodeURIComponent(store.deviceId)}`
      + `&tab_id=${encodeURIComponent(store.tabId)}`;
    const es = new EventSource(url);
    store.remoteEventSource = es;
    _armRotation(minted.expiresIn);
    _offsetFresh = true;
    _lowRun = [];
    let delivered = false;   // the server's first event arrived: this connection works

    es.addEventListener('devices', e => {
      if (store.remoteEventSource !== es) return;
      try {
        const d = JSON.parse(e.data);
        if (!delivered && _retiring) _closeRetiring();   // the new connection is live
        delivered = true; _connFails = 0;
        _noteServerTime(d.server_time);
        store.remoteDevices = d.devices || {};
        _onDevices();
        _reportIfDue();
      } catch {}
    });

    es.addEventListener('command', e => {
      if (store.remoteEventSource !== es && _retiring !== es) return;
      let c = null;
      try { c = JSON.parse(e.data); } catch { return; }
      _onCommand(c);
    });

    es.addEventListener('ping', e => {
      if (store.remoteEventSource !== es) return;
      try { _noteServerTime(JSON.parse(e.data || '{}').server_time); } catch {}
      _reportIfDue();
    });

    const openedAt = Date.now();
    es.onerror = () => {
      // A socket already replaced: close it, or EventSource reconnects it by itself and
      // the server, seeing the same tab twice, closes the CURRENT one in its favour.
      if (store.remoteEventSource !== es) {
        try { es.close(); } catch {}
        if (_retiring === es) _retiring = null;
        return;
      }
      _noteQuickDrop(openedAt);
      if (!delivered) _connFails++;
      es.close();
      store.remoteEventSource = null;
      // Reconnect with a fresh token (connectSSE re-mints it) unless we've stopped.
      _scheduleReconnect();
    };
  } catch {
    _connFails++;
    _scheduleReconnect();
  }
}

// ── Inbound commands (this tab is the target) ──
let _lastAck = 0;     // number (old server) or "<epoch>:<id>"
const _seenIds = [];  // epoch+id+ts of commands already applied (a replay must not apply twice)

/** The ack as reported: "<epoch>:<id>" when the server stamps an epoch (ids restart
 *  from 1 with every server process), the bare id otherwise. */
function _ackOf(c) {
  return c.epoch !== undefined && c.epoch !== null ? `${c.epoch}:${c.id}` : c.id;
}

function _onCommand(c) {
  if (!c || typeof c.action !== 'string') return;
  // B20: a tab frozen in the background gets its queued commands in one burst when it
  // wakes; "pause, play, next, next" from minutes ago must not all happen now.
  // The offset is never unknown here in practice: the server's first event on every
  // connection is `devices` with server_time, and a connection's events arrive in
  // order. Only a server that sends no server_time leaves it null — then the server's
  // own rule (a command queued > 5 s is not sent) is the protection.
  if (typeof c.ts === 'number' && _offset !== null && _nowServer() - c.ts > COMMAND_MAX_AGE_S) return;
  if (typeof c.id === 'number') {
    // With epoch and timestamp: ids restart from 1 when the server restarts.
    const key = `${c.epoch ?? ''}:${c.id}:${c.ts}`;
    if (_seenIds.includes(key)) return;
    _seenIds.push(key);
    if (_seenIds.length > 50) _seenIds.shift();
  }
  // B2: a device that is itself controlling another one would relay the command
  // (its engine turns a load into `remote:play`) — and two devices controlling each
  // other would ping-pong forever. Being controlled ends controlling.
  if (store.remoteTarget) exitRemoteMode();
  _applyInbound(c.action, c.value)
    .catch(() => {})
    .finally(() => {
      if (typeof c.id === 'number') _lastAck = _ackOf(c);
      reportState();
    });
}

async function _applyInbound(action, value) {
  switch (action) {
    case 'mute': {
      const fp = await _fp();
      if (fp.setMuted) fp.setMuted(!!value);
      else if (fp.toggleMute && (store.playerVolume <= 0) !== !!value) fp.toggleMute();
      return;
    }
    case 'shuffle': {
      const fp = await _fp();
      if (fp.setShuffle) fp.setShuffle(!!value);
      else if (fp.toggleShuffle && store.shuffleEnabled !== !!value) fp.toggleShuffle();
      return;
    }
    case 'repeat': {
      if (!['off', 'all', 'one'].includes(value)) return;
      const fp = await _fp();
      if (fp.setRepeat) fp.setRepeat(value);
      else if (fp.toggleRepeat) for (let i = 0; i < 3 && store.repeatMode !== value; i++) fp.toggleRepeat();
      return;
    }
    case 'queue_op': {
      const q = await _queue();
      try { await q.applyQueueOp?.(value); } finally {
        // Applied or refused, the controller refetches (M4). applyQueueOp flushes the
        // save before it resolves, so the file already holds the result.
        _queueRev++;
        _queueSig = _queueSignature();
      }
      return;
    }
    case 'energy_dir': {
      const dj = await _dj();
      await dj.setEnergyDirection?.(value);
      return;
    }
    default: {
      // play, pause, toggle, next, prev, seek, volume, enqueue, transfer
      const m = await getPlayerModule();
      await m.applyRemoteCommand?.(action, value);
    }
  }
}

// ── State reporting (this tab → server) ──
// queue_rev tells a controller when to refetch this device's saved queue (up to 5000
// rows), so it changes only when what a controller draws changed: the rows, their
// order, the current index, shuffle. Measured by a cheap signature:
//   * on `remote:queue-saved` (the engine's PUT landed — the file now holds it) the
//     rev grows only if the signature differs from the one at the last bump; the
//     periodic 30 s save of an unchanged queue leaves it alone;
//   * an engine that never sends that event: the rev grows when the signature
//     changes, and the controller fetches once more 2.5 s later, after the debounced
//     save has landed;
//   * after an inbound queue_op, applied or refused, it grows regardless — the
//     controller drew an optimistic edit that must be replaced either way.
let _queueRev = Math.floor(Date.now() / 1000);  // unique per page load: a reload never repeats a rev
let _queueSig = '';          // signature at the last bump
let _sawSaveEvent = false;   // the engine reports its saves; the fallback stands down
let _lastReportAt = 0;
let _reportTimer = null;

function _queueSignature() {
  const q = Array.isArray(store.playerQueue) ? store.playerQueue : [];
  let h = 2166136261;
  for (const it of q) {
    const s = `${(it && it.name) || ''}\u0001${(it && it.artist) || ''}\u0002`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  }
  return `${q.length}:${h >>> 0}:${store.shuffleEnabled ? 1 : 0}:${store.playerIndex}`;
}

/** Bump queue_rev if the queue differs from the one at the last bump. */
function _bumpIfQueueChanged() {
  const sig = _queueSignature();
  if (sig === _queueSig) return false;
  if (_queueSig) _queueRev++;
  _queueSig = sig;
  return true;
}

function _noteQueueSignature() {
  if (!_sawSaveEvent) _bumpIfQueueChanged();
}

function _trackOf(item) {
  if (!item) return null;
  return {
    name: item.name || '',
    artist: item.artist || '',
    album: item.album || '',
    image: item.image || '',
    duration_ms: item.duration_ms || 0,
    id: item.id || '',
  };
}

/** State from an engine that does not export getRemoteState() yet. */
function _legacyEngineState(m) {
  const a = m.getAudio ? m.getAudio() : null;
  const item = store.playerQueue[store.playerIndex] || null;
  const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
  return {
    playing: a ? !a.paused : false,
    position_seconds: a ? (a.currentTime || 0) : 0,
    duration: dur,
    volume: store.playerVolume,
    index: store.playerIndex,
    queue_len: store.playerQueue.length,
    track: _trackOf(item),
    next: null,
    engine: null,
    dj: null,
    blocked: false,
    casting: store.castDevice ? (store.castDevice.name || null) : null,
  };
}

async function reportState() {
  clearTimeout(_reportTimer); _reportTimer = null;
  if (!store.authToken || _stopped) return;
  _lastReportAt = Date.now();
  let st = {};
  try {
    const m = await getPlayerModule();
    st = (m.getRemoteState ? m.getRemoteState() : _legacyEngineState(m)) || {};
  } catch {}
  _noteQueueSignature();
  let muted = store.playerVolume <= 0;
  try { const fp = await _fp(); if (fp.isMuted) muted = !!fp.isMuted(); } catch {}
  const body = {
    ...st,
    tab_id: store.tabId,
    muted,
    shuffle: !!store.shuffleEnabled,
    repeat: store.repeatMode || 'off',
    queue_rev: _queueRev,
    controlling: store.remoteTarget || null,
    radio: !!store.radioMode,
    ack: _lastAck || 0,
  };
  apiJson('/api/remote/state', { method: 'POST', body }).catch(() => {});
}

/** Report soon, coalescing a burst of changes into one POST. */
function _reportSoon() {
  if (_reportTimer || _stopped) return;
  _reportTimer = setTimeout(reportState, 120);
}

function _otherDeviceOnline() {
  const devs = store.remoteDevices || {};
  return Object.keys(devs).some(id => id !== store.deviceId && devs[id] && devs[id].online);
}

// One 1 s tick drives the report cadence (B23) and, while controlling, the
// interpolated position, the offline grace (B9), staleness (B20) and lock expiry.
let _staleKey = '';
/** Report when the cadence says so: 3 s while another device of the user is online,
 *  15 s otherwise (B23). */
function _reportIfDue() {
  if (_stopped) return;
  const every = _otherDeviceOnline() ? 3000 : 15000;
  if (Date.now() - _lastReportAt >= every) reportState();
}

// N2: the tick is a timer, and Chrome throttles the timers of a hidden tab to about
// one a minute — a backgrounded target then looked stale and lost the delivery
// ranking to an idle visible tab. The SSE `ping` and `devices` handlers call
// _reportIfDue too: network events are not throttled, and the same cadence check
// keeps it at most one report per 3 s.
function _tick() {
  if (_stopped) return;
  _reportIfDue();
  _maybeRestoreTarget();
  // Re-render the devices popover only when a row's greyness changed — a rebuild
  // every second would swap the buttons out from under a press.
  const key = Object.keys(store.remoteDevices || {}).filter(id => _isStale(store.remoteDevices[id])).join(',');
  if (key !== _staleKey) { _staleKey = key; renderDevicesPanel(); }
  if (store.remoteTarget) {
    _checkTarget();
    if (store.remoteTarget) { showControllingBanner(); renderRemoteNowPlaying(); }
  }
}

// ── Remote command sending (controller → target) ──
/** POST a command. Resolves to `{id, epoch}` (id 0 when the server does not return
 *  one, epoch null from a server without epochs), or null when it failed — then the
 *  user has already been told. */
async function sendCommand(action, value, target = store.remoteTarget) {
  if (!target) return null;
  try {
    const body = { target_device_id: target, action };
    if (value !== undefined) body.value = value;
    const r = await apiJson('/api/remote/command', { method: 'POST', body });
    return {
      id: r && typeof r.id === 'number' ? r.id : 0,
      epoch: r && r.epoch !== undefined && r.epoch !== null ? r.epoch : null,
    };
  } catch (err) {
    _commandFailed(err);
    return null;
  }
}

function _parseAck(ack) {
  if (typeof ack === 'number') return ack > 0 ? { epoch: null, id: ack } : null;
  if (typeof ack !== 'string' || !ack) return null;
  const i = ack.lastIndexOf(':');
  if (i < 0) { const n = Number(ack); return n > 0 ? { epoch: null, id: n } : null; }
  const id = Number(ack.slice(i + 1));
  return id > 0 ? { epoch: ack.slice(0, i), id } : null;
}

/** Whether the target's reported ack covers a command we sent (`sent` = {id, epoch}).
 *  After a server restart ids start from 1 again, so an id from another epoch never
 *  counts; a bare-id ack counts only when our command had no epoch either. */
function _ackCovers(ack, sent) {
  if (!sent || !(sent.id > 0)) return false;
  const a = _parseAck(ack);
  if (!a) return false;
  if (sent.epoch !== null && sent.epoch !== undefined) {
    if (a.epoch === null || String(a.epoch) !== String(sent.epoch)) return false;
  } else if (a.epoch !== null) {
    return false;
  }
  return a.id >= sent.id;
}

function _commandFailed(err) {
  if (err && err.status === 409) showToast('That device is controlling another device', true);
  else showToast('Device offline', true);
}

function _localPosition(m) {
  try {
    if (m.getRemoteState) return Number(m.getRemoteState()?.position_seconds) || 0;
    const a = m.getAudio ? m.getAudio() : null;
    return a ? (a.currentTime || 0) : 0;
  } catch { return 0; }
}

/** The transfer payload, built from THIS tab's store (never from a saved file). */
function _transferPayload(positionSeconds) {
  let shuffleOrder = null;
  try { shuffleOrder = _mods.queue?.serializeShuffleOrder?.() ?? null; } catch {}
  return {
    // A copy, taken now: search.js keeps pushing into the same array.
    queue: Array.isArray(store.playerQueue) ? store.playerQueue.slice() : [],
    current_index: store.playerIndex,
    position_seconds: positionSeconds > 0 ? positionSeconds : 0,
    shuffle_order: shuffleOrder,
    playlist_mode: store.playlistMode || null,
    radio_mode: !!store.radioMode,
    radio_seed: store.radioSeedTrack || null,
  };
}

/** What "Send to" would send from here: while controlling X, X's queue (what is
 *  actually playing), else this device's own. null = nothing to send. */
function _sendToPayload() {
  if (store.remoteTarget) {
    const rq = store.remoteQueue;
    const dev = _targetDev();
    if (!rq || !Array.isArray(rq.queue) || !rq.queue.length || !dev) return null;
    const idx = Number.isInteger(dev.index) && dev.index >= 0 && dev.index < rq.queue.length
      ? dev.index : (rq.current_index >= 0 ? rq.current_index : 0);
    const dur = _remoteDuration(dev);
    const playing = _effectivePlaying(dev);
    return {
      queue: rq.queue.slice(),
      current_index: idx,
      position_seconds: Math.max(0, _remotePosition(dev, dur, playing && dev.online && !_isStale(dev))),
      shuffle_order: rq.shuffle_order || null,
      playlist_mode: rq.playlist_mode || null,
      radio_mode: !!rq.radio_mode,
      radio_seed: rq.radio_seed || null,
    };
  }
  if (!Array.isArray(store.playerQueue) || !store.playerQueue.length) return null;
  return _transferPayload(0);
}

async function transferTo(targetId) {
  if (!targetId || targetId === store.deviceId) return;
  // Refused up front: the server would answer 409 — after X had been paused below,
  // leaving nothing playing anywhere.
  const tdev = store.remoteDevices[targetId];
  if (tdev && tdev.controlling) { showToast('That device is controlling another device', true); return; }
  // The list is taken before any await (search.js keeps pushing into the array).
  const value = _sendToPayload();
  if (!value) { showToast('Nothing to send', true); return; }
  const from = store.remoteTarget;   // controlling X: X's music moves to the new device
  const fromDev = from ? _targetDev() : null;
  const fromWasPlaying = !!(fromDev && _effectivePlaying(fromDev));
  let pausedFrom = false;
  try {
    if (!from) {
      const m = await getPlayerModule();
      value.position_seconds = Math.max(0, _localPosition(m));
    } else {
      // X stops first, or X and the new device play at once. Best effort: an X that
      // has gone away is not a reason to keep the music from the new device.
      pausedFrom = await apiJson('/api/remote/command', {
        method: 'POST', body: { target_device_id: from, action: 'pause' },
      }).then(() => true, () => false);
    }
    await apiJson('/api/remote/command', {
      method: 'POST',
      body: { target_device_id: targetId, action: 'transfer', value },
    });
    showToast('Transferred');
    toggleDevicesPanel(false);
    // Switch into remote-control mode for the target so the local controls now drive
    // it (no local+remote overlap). enterRemoteMode silences local audio.
    enterRemoteMode(targetId, { transferred: !from });
  } catch (err) {
    // The new device did not take it: X carries on, as it was before the press.
    if (pausedFrom && fromWasPlaying && store.remoteTarget === from) {
      apiJson('/api/remote/command', {
        method: 'POST', body: { target_device_id: from, action: 'play' },
      }).catch(() => {});
    }
    if (err && err.status === 409) showToast('That device is controlling another device', true);
    else if (err && err.status === 400) showToast('Nothing to send', true);
    else showToast('Transfer failed', true);
  }
}

// ── Controller-side intents ──
// Optimistic play/pause (B12): the icon flips at the press; the target's report wins
// once it acknowledges the command (or after OPTIMISTIC_MS).
let _optimistic = null;   // { playing, sent: {id, epoch} | null, until }
let _skipLock = null;     // { index, key, sent: {id, epoch} | null, until }

function _trackKey(dev) {
  const t = dev && dev.track;
  return t ? `${t.id || ''}|${t.name || ''}|${t.artist || ''}` : '';
}

function _effectivePlaying(dev) {
  if (_optimistic) {
    const acked = dev && _ackCovers(dev.ack, _optimistic.sent);
    if (!acked && Date.now() < _optimistic.until) return _optimistic.playing;
    _optimistic = null;
  }
  return !!(dev && dev.playing);
}

function _skipReleased(dev) {
  const l = _skipLock;
  if (!l) return true;
  if (Date.now() >= l.until) return true;
  if (dev && (dev.index !== l.index || _trackKey(dev) !== l.key)) return true;
  if (dev && _ackCovers(dev.ack, l.sent)) return true;
  return false;
}

function _paintSkipLock() {
  const on = !!_skipLock;
  for (const sel of ['#playerNext', '#playerPrev', '#fpNext', '#fpPrev']) {
    const el = $(sel); if (el) el.classList.toggle('remote-pending', on);
  }
}

function _playIntent(action) {
  const dev = _targetDev();
  if (!dev) return;
  const want = action === 'toggle' ? !_effectivePlaying(dev) : action === 'play';
  const o = { playing: want, sent: null, until: Date.now() + OPTIMISTIC_MS };
  _optimistic = o;
  renderRemoteNowPlaying();
  sendCommand(action).then(sent => {
    if (_optimistic !== o) return;
    if (sent === null) { _optimistic = null; renderRemoteNowPlaying(); } else o.sent = sent;
  });
}

function _skipIntent(action) {
  const dev = _targetDev();
  if (!_skipReleased(dev)) return;   // B12: one press per move of the target
  const l = { index: dev ? dev.index : undefined, key: _trackKey(dev), sent: null, until: Date.now() + SKIP_LOCK_MS };
  _skipLock = l;
  _paintSkipLock();
  setTimeout(() => { if (_skipLock === l) { _skipLock = null; _paintSkipLock(); } }, SKIP_LOCK_MS + 50);
  sendCommand(action).then(sent => {
    if (_skipLock !== l) return;
    if (sent === null) { _skipLock = null; _paintSkipLock(); } else l.sent = sent;
  });
}

function _remoteDuration(dev) {
  if (!dev) return 0;
  const d = Number(dev.duration);
  if (d > 0 && isFinite(d)) return d;
  const ms = dev.track && Number(dev.track.duration_ms);
  return ms > 0 ? ms / 1000 : 0;
}

function _remotePosition(dev, dur, playing) {
  let pos = Number(dev && dev.position_seconds) || 0;
  // Between reports, a playing target moves on; reports come every 3 s.
  if (playing && _offset !== null && typeof dev.updated_at === 'number') {
    pos += Math.min(Math.max(0, _nowServer() - dev.updated_at), STALE_AFTER_S);
  }
  return dur > 0 ? Math.min(pos, dur) : pos;
}

function _seekPctIntent(pct) {
  const dev = _targetDev();
  if (!dev) return;
  const dur = _remoteDuration(dev);
  if (!(dur > 0)) { showToast("Can't seek: track length unknown", true); return; }
  const sec = Math.max(0, Math.min(1, Number(pct) || 0)) * dur;
  dev.position_seconds = sec;          // optimistic, replaced by the next report
  if (_offset !== null) dev.updated_at = _nowServer();
  renderRemoteNowPlaying();
  sendCommand('seek', sec);
}

// Volume (B22): at most one command per 150 ms, the last value always sent, and the
// slider is not repainted from reports while the finger is on it.
let _volPending = null;
let _volTimer = null;
let _volLastSent = 0;
let _volDragging = false;
let _volHoldUntil = 0;

function _volumeIntent(v) {
  const dev = _targetDev();
  if (!dev) return;
  v = Math.max(0, Math.min(1, Number(v) || 0));
  dev.volume = v;                      // optimistic
  _volHoldUntil = Date.now() + VOLUME_HOLD_MS;
  _volPending = v;
  const wait = VOLUME_THROTTLE_MS - (Date.now() - _volLastSent);
  if (wait <= 0) _flushVolume();
  else if (!_volTimer) _volTimer = setTimeout(_flushVolume, wait);
}

function _flushVolume() {
  clearTimeout(_volTimer); _volTimer = null;
  if (_volPending === null) return;
  const v = _volPending;
  _volPending = null;
  _volLastSent = Date.now();
  sendCommand('volume', v);
}

function _paintVolume(dev) {
  if (_volDragging || Date.now() < _volHoldUntil) return;
  if (typeof dev.volume !== 'number') return;
  const pct = Math.round(dev.volume * 100);
  const a = $('#playerVolume'); if (a && Number(a.value) !== pct) a.value = pct;
  const b = $('#fpVolume'); if (b && Number(b.value) !== pct) b.value = pct;
}

/** One entry point for every controller intent (contract: `remote:cmd`). */
function _handleCmd(action, value) {
  if (!store.remoteTarget) return;
  const dev = _targetDev() || {};
  switch (action) {
    case 'toggle': case 'play': case 'pause':
      _playIntent(action); break;
    case 'next': case 'prev':
      _skipIntent(action); break;
    case 'seek_pct':
      _seekPctIntent(value); break;
    case 'seek': {
      const dur = _remoteDuration(dev);
      if (!(dur > 0)) { showToast("Can't seek: track length unknown", true); break; }
      _seekPctIntent((Number(value) || 0) / dur);
      break;
    }
    case 'volume':
      _volumeIntent(value); break;
    case 'volume_step': {
      let d = Number(value);
      if (!d) break;
      if (Math.abs(d) >= 1) d = Math.sign(d) * 0.05;
      const base = typeof dev.volume === 'number' ? dev.volume : store.playerVolume;
      _volumeIntent(base + d);
      renderRemoteNowPlaying();
      break;
    }
    case 'mute': {
      const v = value === undefined || value === null ? !dev.muted : !!value;
      dev.muted = v;
      renderRemoteNowPlaying();
      sendCommand('mute', v);
      break;
    }
    case 'shuffle': {
      const v = value === undefined || value === null ? !dev.shuffle : !!value;
      dev.shuffle = v;
      renderRemoteNowPlaying();
      sendCommand('shuffle', v);
      break;
    }
    case 'repeat': {
      const modes = ['off', 'all', 'one'];
      const cur = modes.includes(dev.repeat) ? dev.repeat : 'off';
      const v = modes.includes(value) ? value : modes[(modes.indexOf(cur) + 1) % 3];
      dev.repeat = v;
      renderRemoteNowPlaying();
      sendCommand('repeat', v);
      break;
    }
    case 'queue_op':
      // queue.js edits store.remoteQueue optimistically; a refused command must not
      // leave that edit on screen.
      if (value && typeof value === 'object') {
        sendCommand('queue_op', value).then(sent => { if (sent === null) _maybeFetchRemoteQueue(true); });
      }
      break;
    case 'energy_dir':
      if (['auto', 'up', 'hold', 'down'].includes(value)) {
        if (dev.dj && typeof dev.dj === 'object') dev.dj.energy_dir = value;
        sendCommand('energy_dir', value);
      }
      break;
  }
}

// ── Devices popover ──
function toggleDevicesPanel(forceState) {
  const panel = $('#remoteDevicesPanel');
  if (!panel) return;
  const willOpen = typeof forceState === 'boolean' ? forceState : panel.style.display === 'none';
  if (willOpen) {
    // Seed from REST if the SSE snapshot hasn't arrived yet.
    if (!Object.keys(store.remoteDevices).length) {
      apiJson('/api/remote/devices').then(d => {
        _noteServerTime(d && d.server_time);
        store.remoteDevices = (d && d.devices) || {};
        renderDevicesPanel();
      }).catch(() => {});
    }
    panel.style.display = '';
    _panelHtml = '';   // a freshly opened popover is always drawn
    renderDevicesPanel();
  } else {
    panel.style.display = 'none';
  }
}

let _panelHtml = '';

function renderDevicesPanel() {
  const panel = $('#remoteDevicesPanel');
  if (!panel || panel.style.display === 'none') return;
  const devices = store.remoteDevices || {};
  const ids = Object.keys(devices);
  // "Send to" needs something to send: this device's queue, or — while controlling —
  // the target's queue once it has been fetched.
  const canSend = !!_sendToPayload();
  let html = '<div class="rdp-title">Devices</div>';
  if (!ids.length) {
    html += '<div class="remote-device-row"><div class="rdr-info"><div class="rdr-track">No devices found</div></div></div>';
  }
  for (const id of ids) {
    const dev = devices[id] || {};
    const isThis = id === store.deviceId;
    const isTarget = store.remoteTarget === id;
    const online = !!dev.online;
    const stale = !isThis && _isStale(dev);
    const rawName = dev.name || `Device ${id.slice(0, 6)}`;
    const name = esc(rawName) + (isThis ? ' (this device)' : '');
    const tr = dev.track;
    let line = '';
    if (stale) line = `<div class="rdr-track">${esc(rawName)} isn't responding</div>`;
    else if (tr) line = `<div class="rdr-track">${dev.playing ? '▶' : '❚❚'} ${esc(tr.name || '')} — ${esc(tr.artist || '')}</div>`;
    let actions = '';
    if (!isThis && online && !isTarget && dev.controlling) {
      // Neither Control nor Send to would be accepted (409); say why instead.
      actions = `<span class="rdr-hint">Controlling another device</span>`;
    } else if (!isThis && online) {
      if (isTarget) {
        actions = `<button class="rdr-btn" data-remote-action="stop">Stop controlling</button>`;
      } else {
        actions = `<button class="rdr-btn" data-remote-action="control" data-remote-id="${esc(id)}">Control</button>`
          + (canSend ? `<button class="rdr-btn" data-remote-action="transfer" data-remote-id="${esc(id)}">Send to</button>` : '');
      }
    }
    html += `<div class="remote-device-row${isTarget ? ' controlling' : ''}${stale ? ' stale' : ''}">`
      + `<span class="rdr-dot${online && !stale ? ' online' : ''}"></span>`
      + `<div class="rdr-info"><div class="rdr-name">${name}</div>${line}</div>`
      + `<div class="rdr-actions">${actions}</div>`
      + `</div>`;
  }
  // Every devices event (a state report from any device, every few seconds) lands
  // here; rebuilding unchanged rows swapped the buttons out from under a tap.
  if (html === _panelHtml) return;
  _panelHtml = html;
  panel.innerHTML = html;
  $$('[data-remote-action]', panel).forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-remote-action');
      const id = btn.getAttribute('data-remote-id');
      if (act === 'control') enterRemoteMode(id);
      else if (act === 'transfer') transferTo(id);
      else if (act === 'stop') exitRemoteMode();
    });
  });
}

// ── Remote mode (controlling another device) ──
// The controller's own queue state is put aside on entry and given back on exit
// (B4/B7). While controlling, store.playerQueue is only a workspace that playTracks,
// album cards etc. fill so a transfer can carry the new list; nothing saves it.
let _snapshot = null;
let _offlineSince = 0;
let _rqKey = '';
let _rqGen = 0;
let _rqLater = null;
let _lastPaintedKey = null;

function _takeSnapshot() {
  let shuffleOrder = null;
  try { shuffleOrder = _mods.queue?.serializeShuffleOrder?.() ?? null; } catch {}
  return {
    // The ORIGINAL array, given back on exit: search.js recognises its list by the
    // array's own non-enumerable `_src` tag; a copy would end its top-up for good.
    queue: Array.isArray(store.playerQueue) ? store.playerQueue : [],
    index: store.playerIndex,
    shuffleOrder,
    playlistMode: store.playlistMode,
    radioMode: store.radioMode,
    radioSeedTrack: store.radioSeedTrack,
  };
}

function _restoreSnapshot(s) {
  store.playerQueue = s.queue;
  store.playerIndex = s.index;
  store.playlistMode = s.playlistMode;
  store.radioMode = s.radioMode;
  store.radioSeedTrack = s.radioSeedTrack;
  // After the queue, never before: the saved order is positions into it.
  try { _mods.queue?.restoreShuffleOrder?.(s.shuffleOrder); } catch {}
}

/** A copy of a queue array that keeps search.js's top-up tags (`_src`, `_srcLen`). */
function _copyTagged(q) {
  const c = q.slice();
  if (q._src !== undefined) {
    Object.defineProperty(c, '_src', { value: q._src });
    Object.defineProperty(c, '_srcLen', { value: q._srcLen, writable: true });
  }
  return c;
}

function enterRemoteMode(targetId, { transferred = false } = {}) {
  if (!targetId || targetId === store.deviceId) return false;
  // M7: a device that is itself controlling (another device, or this one) would
  // answer every command with 409 — and two devices controlling each other would
  // each refuse the other's for good.
  const tdev = store.remoteDevices[targetId];
  if (tdev && tdev.controlling) {
    showToast('That device is controlling another device', true);
    return false;
  }
  // Switching from one target to another keeps the FIRST snapshot: that one is
  // this device's real state, the later one would be the workspace.
  if (!_snapshot) {
    _snapshot = _takeSnapshot();
    // The workspace is a copy, so nothing done under remote can change the array
    // given back on exit. It keeps the search top-up tags only when this queue was
    // just SENT to the target ("Send to"): then growing it there is right. Under a
    // plain Control the target never got this list.
    const q = _snapshot.queue;
    store.playerQueue = transferred ? _copyTagged(q) : q.slice();
  }
  // The workspace starts without this device's playlist / radio context: otherwise
  // its own named playlist (say MyZouk) rides along in the first transfer, the target
  // adopts it, and a later ✕ or drag there rewrites MyZouk with an unrelated queue.
  // Library "Play all" / the manager set playlistMode right before playTracks, so a
  // deliberate choice still travels.
  store.playlistMode = null;
  store.radioMode = false;
  store.radioSeedTrack = null;
  store.remoteTarget = targetId;
  store.remoteQueue = null;
  _rqKey = ''; _rqGen++;
  _offlineSince = 0;
  _optimistic = null; _skipLock = null; _paintSkipLock();
  _lastPaintedKey = null;
  try { sessionStorage.setItem('ms_remote_target', targetId); } catch {}
  document.body.classList.add('remote-active');
  // Fully stop local playback so we don't run two streams at once, and reveal the
  // player bar so the remote now-playing is visible even if we never played locally.
  // silenceForRemote also cancels a pending error retry, voids a load in flight and
  // pauses a DLNA renderer this device was casting to; pauseLocal only the decks.
  getPlayerModule().then(async m => {
    try { if (m.silenceForRemote) await m.silenceForRemote(); else m.pauseLocal?.(); } catch {}
    try { m.showPlayerBar?.(); } catch {}
    // Pausing paints this device's play icon; the target's state goes back on top.
    if (store.remoteTarget === targetId) renderRemoteNowPlaying();
  }).catch(() => {});
  _installMediaSession();
  showControllingBanner();
  renderRemoteNowPlaying();
  _maybeFetchRemoteQueue(true);
  _queue().then(q => q.renderQueue?.()).catch(() => {});
  _dj().then(dj => dj.syncDjPanel?.()).catch(() => {});
  renderDevicesPanel();
  toggleDevicesPanel(false);
  // Tell the server at once that this tab now controls (a counter-control gets 409).
  reportState();
  return true;
}

function exitRemoteMode() {
  const wasControlling = !!store.remoteTarget;
  store.remoteTarget = null;
  store.remoteQueue = null;
  _rqGen++;
  clearTimeout(_rqLater); _rqLater = null;
  _offlineSince = 0;
  _optimistic = null; _skipLock = null; _paintSkipLock();
  clearTimeout(_volTimer); _volTimer = null; _volPending = null;
  try { sessionStorage.removeItem('ms_remote_target'); } catch {}
  document.body.classList.remove('remote-active');
  const banner = $('#remoteControllingBanner');
  if (banner) banner.remove();
  if (_snapshot) { _restoreSnapshot(_snapshot); _snapshot = null; }
  renderDevicesPanel();
  if (!wasControlling) return;
  _clearMediaSession();
  // Paint the bar and the full player from this device again.
  getPlayerModule().then(m => {
    if (m.repaintLocal) m.repaintLocal();
    else _paintLocalFallback(m);
  }).catch(() => {});
  const fp = _mods.fp;
  try { fp?.syncShuffleRepeatUI?.(); fp?.syncMuteUI?.(); fp?.syncLikeUI?.(); } catch {}
  const pv = Math.round((store.playerVolume ?? 1) * 100);
  const a = $('#playerVolume'); if (a) a.value = pv;
  const b = $('#fpVolume'); if (b) b.value = pv;
  _queue().then(q => { q.renderQueue?.(); q.updateSaveButton?.(); }).catch(() => {});
  _dj().then(dj => dj.syncDjPanel?.()).catch(() => {});
  // Promptly: the server answers 409 to anyone controlling a device whose last
  // report says it controls.
  reportState();
}

/** Only for an engine without repaintLocal(): the local track, paused. */
function _paintLocalFallback(m) {
  const item = store.playerQueue[store.playerIndex];
  const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  setArt($('#playerImg'), item ? item.image : ''); setArt($('#fpImg'), item ? item.image : '');
  setText('#playerTitle', item ? item.name || '' : ''); setText('#fpTitle', item ? item.name || '' : '');
  setText('#playerArtist', item ? item.artist || '' : ''); setText('#fpArtist', item ? item.artist || '' : '');
  const a = m.getAudio ? m.getAudio() : null;
  const pos = a ? (a.currentTime || 0) : 0;
  const dur = a && isFinite(a.duration) && a.duration > 0 ? a.duration : (item && item.duration_ms ? item.duration_ms / 1000 : 0);
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const mf = $('#playerProgressFill'); if (mf) mf.style.width = pct + '%';
  const ff = $('#fpProgressFill'); if (ff) ff.style.width = pct + '%';
  const bar = $('#playerBar'); if (bar) bar.style.setProperty('--player-progress', pct + '%');
  setText('#playerTimeCurrent', fmtTime(pos)); setText('#fpTimeCurrent', fmtTime(pos));
  setText('#playerTimeTotal', fmtTime(dur)); setText('#fpTimeTotal', fmtTime(dur));
  try { m.updatePlayPauseIcon?.(a ? !a.paused : false); } catch {}
}

/** B9: a target that dropped its connection keeps the controller in remote mode for
 *  OFFLINE_GRACE_MS ("Reconnecting to …"); only then does the controller give up. */
function _checkTarget() {
  const id = store.remoteTarget;
  if (!id) return;
  const dev = store.remoteDevices[id];
  if (dev && dev.online) {
    if (_offlineSince) { _offlineSince = 0; showControllingBanner(); }
    return;
  }
  if (!_offlineSince) { _offlineSince = Date.now(); showControllingBanner(); return; }
  if (Date.now() - _offlineSince >= OFFLINE_GRACE_MS) {
    const name = _devName(id);
    exitRemoteMode();
    showToast(`${name} went offline`, true);
  }
}

function showControllingBanner() {
  if (!store.remoteTarget) return;
  let banner = $('#remoteControllingBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'remoteControllingBanner';
    banner.className = 'remote-controlling-banner';
    banner.innerHTML = '<span class="rcb-text"></span><span class="rcb-next"></span>'
      + '<button type="button" title="Stop controlling" aria-label="Stop controlling">⨯</button>';
    banner.querySelector('button').addEventListener('click', exitRemoteMode);
    const bar = $('#playerBar');
    if (bar && bar.parentNode) bar.parentNode.insertBefore(banner, bar);
    else document.body.appendChild(banner);
  }
  const dev = _targetDev();
  const name = _devName(store.remoteTarget);
  let text, warn = true;
  if (_offlineSince || !dev || !dev.online) text = `Reconnecting to ${name}…`;
  else if (_isStale(dev)) text = `${name} isn't responding`;
  else if (dev.blocked) text = `Tap ${name} once to allow playback`;
  else { text = `Controlling ${name}`; warn = false; }
  const t = banner.querySelector('.rcb-text');
  if (t && t.textContent !== text) t.textContent = text;
  banner.classList.toggle('warn', warn);
  // The target's own prediction (shuffle, Smart Queue), not the next row of a list.
  const nx = banner.querySelector('.rcb-next');
  const next = !warn && dev && dev.next && dev.next.name
    ? `Next: ${dev.next.name}${dev.next.artist ? ' — ' + dev.next.artist : ''}` : '';
  if (nx && nx.textContent !== next) nx.textContent = next;
}

/** Fetch the target's saved queue when its queue_rev / queue_len changed. */
function _maybeFetchRemoteQueue(force) {
  const dev = _targetDev();
  if (!store.remoteTarget) return;
  const key = dev ? `${dev.queue_rev ?? ''}:${dev.queue_len ?? ''}` : '';
  if (!force && key === _rqKey) return;
  _rqKey = key;
  _fetchRemoteQueue();
  clearTimeout(_rqLater);
  _rqLater = setTimeout(_fetchRemoteQueue, QUEUE_REFETCH_LATER_MS);
}

async function _fetchRemoteQueue() {
  const target = store.remoteTarget;
  if (!target) return;
  const gen = ++_rqGen;
  try {
    const d = await apiJson(`/api/remote/queue?device=${encodeURIComponent(target)}`);
    if (gen !== _rqGen || store.remoteTarget !== target) return;
    store.remoteQueue = {
      queue: Array.isArray(d && d.queue) ? d.queue : [],
      current_index: d && typeof d.current_index === 'number' ? d.current_index : -1,
      shuffle_order: (d && d.shuffle_order) || null,
      playlist_mode: (d && d.playlist_mode) || null,
      radio_mode: !!(d && d.radio_mode),
      radio_seed: (d && d.radio_seed) || null,
    };
    renderDevicesPanel();   // "Send to" appears once there is a queue to send
    const q = await _queue();
    q.renderQueue?.();
  } catch {
    // Never leave the panel on "Loading <device>'s queue…".
    if (gen === _rqGen && store.remoteTarget === target && !store.remoteQueue) {
      store.remoteQueue = { queue: [], current_index: -1, shuffle_order: null, playlist_mode: null, radio_mode: false };
      _queue().then(q => q.renderQueue?.()).catch(() => {});
    }
  }
}

// Paint the player bar and the full player from the target's reported state.
function renderRemoteNowPlaying() {
  if (!store.remoteTarget) return;
  const dev = _targetDev();
  if (!dev) return;
  const tr = dev.track || {};
  const playing = _effectivePlaying(dev);
  const durSec = _remoteDuration(dev);
  const pos = _remotePosition(dev, durSec, playing && dev.online && !_isStale(dev));
  const pct = durSec > 0 ? Math.max(0, Math.min(100, (pos / durSec) * 100)) : 0;
  const playPath = '<path d="M8 5v14l11-7z"/>';
  const pausePath = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  const iconHtml = playing ? pausePath : playPath;

  const setText = (sel, v) => { const el = $(sel); if (el && el.textContent !== v) el.textContent = v; };
  // Compared with the element, not with what was painted last: the full player
  // paints this device's own art when it opens.
  const setImg = (sel, url) => { const el = $(sel); if (el && (el.getAttribute('src') || '') !== url) setArt(el, url); };
  const img = tr.image || '';
  setImg('#playerImg', img); setImg('#fpImg', img);
  setText('#playerTitle', tr.name || ''); setText('#fpTitle', tr.name || '');
  setText('#playerArtist', tr.artist || ''); setText('#fpArtist', tr.artist || '');

  const miniFill = $('#playerProgressFill'); if (miniFill) miniFill.style.width = pct + '%';
  const fpFill = $('#fpProgressFill'); if (fpFill) fpFill.style.width = pct + '%';
  const bar = $('#playerBar'); if (bar) bar.style.setProperty('--player-progress', pct + '%');
  setText('#playerTimeCurrent', fmtTime(pos)); setText('#fpTimeCurrent', fmtTime(pos));
  setText('#playerTimeTotal', fmtTime(durSec)); setText('#fpTimeTotal', fmtTime(durSec));

  const miniIcon = $('#playPauseIcon'); if (miniIcon) miniIcon.innerHTML = iconHtml;
  const fpIcon = $('#fpPlayPauseIcon'); if (fpIcon) fpIcon.innerHTML = iconHtml;

  _paintVolume(dev);
  // Like, mute, shuffle, repeat and the "Next" row belong to the full player.
  try { _mods.fp?.paintRemoteState?.({ ...dev, playing }); } catch {}
  _paintMediaSession(dev, playing);

  // The DJ drawer mirrors the target's engine and settings read-only.
  try { _mods.dj?.syncDjPanel?.(); } catch {}
  // The queue panel follows the target: current row, order, length.
  const qKey = `${dev.index}|${dev.shuffle ? 1 : 0}|${_trackKey(dev)}|${dev.queue_len}`;
  if (qKey !== _lastPaintedKey) {
    _lastPaintedKey = qKey;
    try { _mods.queue?.renderQueue?.(); } catch {}
  }
}

function _onDevices() {
  if (_skipLock && _skipReleased(_targetDev())) { _skipLock = null; _paintSkipLock(); }
  renderDevicesPanel();
  _maybeRestoreTarget();
  if (store.remoteTarget) {
    _checkTarget();
    if (!store.remoteTarget) return;
    showControllingBanner();
    renderRemoteNowPlaying();
    _maybeFetchRemoteQueue(false);
  }
}

// ── Restore after a reload (sessionStorage `ms_remote_target`) ──
let _restoreWanted = null;
let _restoreUntil = 0;

function _maybeRestoreTarget() {
  if (!_restoreWanted) return;
  if (store.remoteTarget) { _restoreWanted = null; return; }
  if (Date.now() > _restoreUntil) {
    _restoreWanted = null;
    try { sessionStorage.removeItem('ms_remote_target'); } catch {}
    return;
  }
  const dev = store.remoteDevices[_restoreWanted];
  if (_restoreWanted !== store.deviceId && dev && dev.online) {
    const id = _restoreWanted;
    _restoreWanted = null;
    enterRemoteMode(id);
  }
}

// ── Media Session (B21) ──
// The engines register their handlers only once a local track has loaded; a device
// that never played locally had no media keys under remote control.
let _msInstalled = false;
let _msTitle = null;

function _installMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const h = (action) => () => {
    if (store.remoteTarget) { _handleCmd(action); return; }
    // Not controlling any more: these handlers stay until the engine replaces them
    // on its next load, so act like the engine's own would.
    getPlayerModule().then(m => {
      if (action === 'play' || action === 'pause') m.applyRemoteCommand?.(action);
      else if (action === 'next') m.nextTrack?.();
      else if (action === 'prev') m.prevTrack?.();
    }).catch(() => {});
  };
  try {
    navigator.mediaSession.setActionHandler('play', h('play'));
    navigator.mediaSession.setActionHandler('pause', h('pause'));
    navigator.mediaSession.setActionHandler('previoustrack', h('prev'));
    navigator.mediaSession.setActionHandler('nexttrack', h('next'));
    _msInstalled = true;
  } catch {}
  _msTitle = null;
}

function _paintMediaSession(dev, playing) {
  if (!_msInstalled || !('mediaSession' in navigator)) return;
  const tr = dev.track || {};
  const key = `${tr.name || ''}|${tr.artist || ''}|${tr.image || ''}`;
  try {
    if (key !== _msTitle && typeof MediaMetadata !== 'undefined') {
      _msTitle = key;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: tr.name || '', artist: tr.artist || '', album: tr.album || '',
        artwork: tr.image ? [{ src: tr.image, sizes: '300x300', type: 'image/jpeg' }] : [],
      });
    }
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch {}
}

function _clearMediaSession() {
  if (!_msInstalled || !('mediaSession' in navigator)) return;
  _msTitle = null;
  try { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'paused'; } catch {}
}

// ── Capture-phase control interceptors ──
// When controlling a remote device, the existing player-bar controls must drive
// the REMOTE device instead of local audio. Capture-phase listeners run before the
// engine's bubble-phase handlers, so we stop propagation and send a remote command.
function installInterceptors() {
  // Bound for BOTH the mini player bar and the full player — same remote-mode guard.
  const onClick = (sel, fn) => {
    const el = $(sel);
    if (el) el.addEventListener('click', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      fn(e, el);
    }, true);
  };

  onClick('#playerPlayPause', () => _handleCmd('toggle'));
  onClick('#fpPlayPause', () => _handleCmd('toggle'));
  onClick('#playerNext', () => _handleCmd('next'));
  onClick('#fpNext', () => _handleCmd('next'));
  onClick('#playerPrev', () => _handleCmd('prev'));
  onClick('#fpPrev', () => _handleCmd('prev'));
  // Mute, shuffle, repeat and like are NOT intercepted here: fullplayer.js routes
  // them itself under remote (`remote:cmd` with the wanted new state). The transport
  // interceptors above call preventDefault, which fullplayer.js's own remote branches
  // check, so a press sends exactly one command.

  // Seek (B6): from the target's duration. Touch too — the engines preventDefault
  // their touchstart, which suppresses the click, so a click-only interceptor never
  // ran on a phone and the controller seeked its own paused deck.
  const pctOf = (bar, x) => {
    const rect = bar.getBoundingClientRect();
    return rect.width > 0 ? Math.max(0, Math.min(1, (x - rect.left) / rect.width)) : 0;
  };
  for (const sel of ['#playerProgressBar', '#fpProgressBar']) {
    const bar = $(sel);
    if (!bar) continue;
    bar.addEventListener('click', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      _handleCmd('seek_pct', pctOf(bar, e.clientX ?? 0));
    }, true);
    bar.addEventListener('touchstart', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      const t = e.touches && e.touches[0];
      if (t) _handleCmd('seek_pct', pctOf(bar, t.clientX));
    }, { capture: true, passive: false });
  }

  // Volume — range inputs fire 'input', not 'click' (B22: throttled, no repaint
  // under the finger).
  for (const sel of ['#playerVolume', '#fpVolume']) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('input', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation(); e.preventDefault();
      _handleCmd('volume', e.target.value / 100);
    }, true);
    el.addEventListener('change', e => {
      if (!store.remoteTarget) return;
      e.stopImmediatePropagation();
      _flushVolume();
    }, true);
    const down = () => { if (store.remoteTarget) _volDragging = true; };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('touchstart', down, { capture: true, passive: true });
  }
  const up = () => {
    if (!_volDragging) return;
    _volDragging = false;
    _volHoldUntil = Date.now() + VOLUME_HOLD_MS;
    _flushVolume();
  };
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('touchend', up, true);
  window.addEventListener('touchcancel', up, true);
}

let _docClickBound = false;
function bindOutsideClick() {
  if (_docClickBound) return;
  _docClickBound = true;
  document.addEventListener('click', e => {
    const panel = $('#remoteDevicesPanel');
    if (!panel || panel.style.display === 'none') return;
    if (panel.contains(e.target)) return;
    if (e.target.closest && e.target.closest('#playerDevicesBtn, #fpDevicesBtn')) return;
    panel.style.display = 'none';
  });
}

// ── Engine playback events → remote commands ──
// Engines stay decoupled from this module: when controlling a remote target they
// dispatch DOM events instead of importing remote.js. We translate them here.
function installPlaybackBridge() {
  // A load under remote control (playTracks, an album card, Play now…) — the
  // workspace store.playerQueue is what the user just chose; send it as the queue.
  document.addEventListener('remote:play', async () => {
    if (!store.remoteTarget) return;
    const target = store.remoteTarget;
    // Built synchronously, before any await: the list must be the one the user just
    // chose, not one a search top-up has meanwhile grown (queue.js is loaded by now).
    const value = _transferPayload(0);
    try {
      await apiJson('/api/remote/command', {
        method: 'POST',
        body: { target_device_id: target, action: 'transfer', value },
      });
    } catch (err) { _commandFailed(err); }
  });
  document.addEventListener('remote:enqueue', e => {
    if (!store.remoteTarget) return;
    const items = Array.isArray(e.detail) ? e.detail : (e.detail ? [e.detail] : []);
    if (!items.length) return;
    sendCommand('enqueue', items.slice(0, 200));
  });
  // Transport and the rest of the controller's intents (keyboard, media keys, the
  // full player, queue panel, DJ panel) — see the contract's `remote:cmd`.
  document.addEventListener('remote:cmd', e => {
    if (!store.remoteTarget) return;
    const d = e.detail || {};
    if (typeof d.action === 'string') _handleCmd(d.action, d.value);
  });
  // The engine changed the queue, the track or play/pause: report at once.
  document.addEventListener('remote:report', () => _reportSoon());
  // A queue edit the target refused (queue.js, after its own optimistic edit).
  document.addEventListener('remote:refetch-queue', () => { if (store.remoteTarget) _maybeFetchRemoteQueue(true); });
  // The engine's queue PUT landed: a controller may refetch now.
  document.addEventListener('remote:queue-saved', () => {
    _sawSaveEvent = true;
    if (_bumpIfQueueChanged()) _reportSoon();
  });
}

let _wired = false;
function wireUI() {
  if (_wired) return;
  _wired = true;
  const btn = $('#playerDevicesBtn');
  if (btn) btn.addEventListener('click', () => toggleDevicesPanel());
  const fpBtn = $('#fpDevicesBtn');
  if (fpBtn) fpBtn.addEventListener('click', () => toggleDevicesPanel());
  installInterceptors();
  installPlaybackBridge();
  bindOutsideClick();
}

// ── Lifecycle ──
export function initRemote() {
  _stopped = false;
  _connFails = 0;
  _loadMods();
  _setupTabChannel();
  try { _restoreWanted = sessionStorage.getItem('ms_remote_target') || null; } catch { _restoreWanted = null; }
  _restoreUntil = Date.now() + OFFLINE_GRACE_MS;
  connectSSE();
  reportState();
  if (store.remoteStateTimer) clearInterval(store.remoteStateTimer);
  store.remoteStateTimer = setInterval(_tick, 1000);
  wireUI();
}

export function stopRemote() {
  _stopped = true;
  clearTimeout(_rotateTimer); _rotateTimer = null;
  if (_retiring) { try { _retiring.close(); } catch {} _retiring = null; }
  // Closed, so the next initRemote (logout → login) opens it again and announces
  // the tab id once more.
  if (_tabChannel) { try { _tabChannel.onmessage = null; _tabChannel.close(); } catch {} _tabChannel = null; }
  if (store.remoteEventSource) { try { store.remoteEventSource.close(); } catch {} store.remoteEventSource = null; }
  if (store.remoteStateTimer) { clearInterval(store.remoteStateTimer); store.remoteStateTimer = null; }
  if (store.remoteReconnectTimer) { clearTimeout(store.remoteReconnectTimer); store.remoteReconnectTimer = null; }
  clearTimeout(_reportTimer); _reportTimer = null;
  _restoreWanted = null;
  exitRemoteMode();
  _snapshot = null;
  store.remoteDevices = {};
  try { sessionStorage.removeItem('ms_remote_target'); } catch {}
  const panel = $('#remoteDevicesPanel');
  if (panel) panel.style.display = 'none';
}

/** Repaint the bar / full player from the target's report — for a module that has
 *  just painted the controller's own track over it (e.g. opening the full player). */
export function repaintRemote() {
  if (!store.remoteTarget) return;
  showControllingBanner();
  renderRemoteNowPlaying();
}

/** Whether this tab is controlling another device, and which. */
export function remoteTargetName() {
  return store.remoteTarget ? _devName(store.remoteTarget) : null;
}
