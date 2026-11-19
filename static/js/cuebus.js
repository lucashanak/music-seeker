// cuebus.js — headphone cue routing for the DJ desk (dj-pult).
//
// The engine (player_v3.js) LENDS its idle deck to the desk: the lent deck keeps its
// crossfade `gain` at 0, so it is silent in the master. This module taps each deck
// BEFORE that gain (`levelGain`) into a cue bus and sends the bus to the headphones:
//
//   nodes[k].levelGain ─► pfl[k] ──┐
//   nodes[A|B].gain ───► masterTap ┴► sum ─► cueVol ─► limiter ─► output (by mode)
//
// The master tap is the decks' sum BEFORE the engine's limiter: compensating the master
// fader (1/volume) is exact only on a linear path. The cue has its own limiter, fed a
// level the master fader no longer moves.
//
// Isolation is THE property: nothing here is ever connected INTO `master` or into a
// deck's crossfade `gain`. Every connection made from an engine node is recorded and
// removed one by one (never a blanket disconnect of an engine node).
//
// Output modes (pure decisions in cuemath.js):
//  - devices:      cueVol → MediaStreamDestination → hidden <audio> with setSinkId
//                  (fallback: a second AudioContext with setSinkId). Master untouched.
//  - multichannel: destination gets 4 discrete channels; master → 1/2, cue → 3/4.
//  - split:        L = master (mono), R = cue (mono).
//  multichannel/split take master off ctx.destination; the last releaseCue puts it back
//  exactly as it was, destination channel settings included.
//
// The engine is reached ONLY through getPlayerModule() and only with the DJ engine —
// a static import of player_v3.js would start a second engine next to the classic one.

import { store } from './store.js';
import { showToast } from './utils.js';
import { getPlayerEngine, getPlayerModule } from './player_active.js';
import {
  readCueSettings, cueSettingsEntries, normalizeCueSettings, supportedCueModes,
  effectiveCueMode, configuredCueMode, isExplicitDevice, sameAsMainOutput, routingPlan, cueTapGains,
  isBluetoothLabel as _isBt, rms, sinkStillPresent,
} from './cuemath.js';

export const isBluetoothLabel = _isBt;

let _engineOverride = null;   // tests only (see _internals)
let _m = null;                // the engine module once resolved
let _graph = null;            // last deskGraph() answer
let _settings = null;
let _route = null;
let _routeError = null;
const _owners = new Set();
const _listeners = new Set();
let _chain = Promise.resolve();
let _pv = null;               // preview: { item, key, index, lentByUs, loading, el, off }
let _taps = null;             // { ctx, src, master, post: {A,B} } analysers, created lazily
let _listening = false;

// ── engine ──
async function _engine() {
  if (_engineOverride) return _engineOverride;
  if (getPlayerEngine() !== 'dj') return null;
  try {
    const m = await getPlayerModule();
    return m && typeof m.deskGraph === 'function' ? m : null;
  } catch { return null; }
}

function _deskGraph(m) {
  let g = null;
  try { g = m.deskGraph(); } catch { g = null; }
  if (g) _graph = g;
  return g;
}

function _info() {
  try { return (_m && _m.deskInfo && _m.deskInfo()) || {}; } catch { return {}; }
}

/** Make sure the engine's AudioContext exists (call from a user gesture). Graph or null. */
export async function cueGraph() {
  const m = await _engine();
  if (!m) return null;
  _m = m; _listen();
  return _deskGraph(m);
}

// ── support ──
export function cueSupport() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = nav.userAgent || '';
  const md = nav.mediaDevices;
  let coarse = false;
  try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch {}
  const s = {
    engineDj: !!_engineOverride || getPlayerEngine() === 'dj',
    devices: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    ctxSink: typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype,
    selectOutput: !!(md && md.selectAudioOutput),
    enumerate: !!(md && md.enumerateDevices),
    maxChannels: _graph && _graph.ctx && _graph.ctx.destination ? _graph.ctx.destination.maxChannelCount : null,
    split: true,
    mobile: coarse && /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
    // Same test as IS_WEBKIT in djmix.js (not imported: djmix pulls in bpm.js and the API).
    webkit: /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Android/.test(ua),
    androidApp: typeof window !== 'undefined' && !!window.AndroidBridge,
    blocked: store.castDevice ? 'cast' : (store.remoteTarget ? 'remote' : null),
  };
  s.modes = s.engineDj ? supportedCueModes(s) : [];
  return s;
}

// ── settings ──
function _getItem(k) { try { return localStorage.getItem(k); } catch { return null; } }

export function cueSettings() {
  if (!_settings) _settings = readCueSettings(_getItem);
  return { ..._settings, pfl: { ..._settings.pfl } };
}

export function setCueSettings(patch = {}) {
  const prev = cueSettings();
  const next = normalizeCueSettings({ ...prev, ...patch, pfl: { ...prev.pfl, ...(patch.pfl || {}) } });
  _settings = next;
  for (const [k, v] of cueSettingsEntries(next)) { try { localStorage.setItem(k, v); } catch {} }
  if (next.mode !== prev.mode || next.deviceId !== prev.deviceId) {
    if (_owners.size) _serial(() => _reroute());
  } else {
    _applyGains();
  }
  _notify('settings');
  return cueSettings();
}

export function setDeckCue(key, on) {
  if (key !== 'A' && key !== 'B') return;
  setCueSettings({ pfl: { [key]: !!on } });
}

// ── outputs ──
async function _readOutputs() {
  const md = navigator.mediaDevices;
  if (!md || !md.enumerateDevices) return [];
  const all = await md.enumerateDevices();
  return all.filter((d) => d.kind === 'audiooutput').map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
}

/**
 * Audio outputs. Without a permission browsers hide labels (and often the devices).
 * `{ ask: true }` — ONLY from a user gesture — asks the way the platform needs:
 * selectAudioOutput where it exists (Firefox), else a microphone grant whose tracks
 * are stopped at once (Chromium exposes output labels with it).
 */
export async function listOutputs({ ask = false } = {}) {
  let list = [];
  try { list = await _readOutputs(); } catch { return []; }
  const hidden = !list.length || list.every((d) => !d.label);
  const md = navigator.mediaDevices;
  if (hidden && ask && md) {
    try {
      if (md.selectAudioOutput) {
        const picked = await md.selectAudioOutput();
        list = await _readOutputs();
        if (picked && picked.deviceId && !list.some((d) => d.deviceId === picked.deviceId)) {
          list.push({ deviceId: picked.deviceId, label: picked.label || '' });
        }
      } else if (md.getUserMedia) {
        const st = await md.getUserMedia({ audio: true });
        st.getTracks().forEach((t) => t.stop());
        list = await _readOutputs();
      }
    } catch { /* refused: keep what we have */ }
  }
  return list.filter((d) => d.deviceId);
}

// ── route ──
function _serial(fn) {
  const p = _chain.then(fn, fn);
  _chain = p.catch(() => {});
  return p;
}

function _set(param, v) {
  if (!param) return;
  const ctx = _route && _route.g.ctx;
  if (ctx && typeof param.setTargetAtTime === 'function') {
    try { param.cancelScheduledValues?.(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, 0.015); return; } catch {}
  }
  param.value = v;
}

function _applyGains() {
  const r = _route;
  if (!r) return;
  const s = cueSettings();
  const pfl = { ...s.pfl };
  if (_pv) pfl[_pv.key] = true;          // a preview always cues its own deck (not persisted)
  const els = r.g.els || {};
  const info = _info();
  const vol = (el) => (el && Number.isFinite(el.volume) ? el.volume : 1);
  const masterVolume = Number.isFinite(info.volume) ? info.volume
    : (Number.isFinite(store.playerVolume) ? store.playerVolume : 1);
  const t = cueTapGains({ mix: s.mix, pfl, elVolume: { A: vol(els.A), B: vol(els.B) }, masterVolume });
  _set(r.masterTap.gain, t.master);
  _set(r.pfl.A.gain, t.A);
  _set(r.pfl.B.gain, t.B);
  _set(r.vol.gain, s.volume);
}

// Two ways to put a MediaStream on a chosen device. Chromium: a second AudioContext with
// setSinkId renders straight to the device and reports its own latency; the <audio>
// path adds the element's media-stream renderer, which has an open Chromium report of
// growing latency (issues.chromium.org/40160849). Firefox / Safari have no
// AudioContext.setSinkId, so there it is the element (the flow Firefox itself tests).
// Measured 2026-11-19 in headless Chromium: the stream hop alone is ~30 ms either way.
async function _openSink(stream, deviceId, sampleRate) {
  // Never a route to '' / 'default': that is the main speakers (see configuredCueMode).
  if (!isExplicitDevice(deviceId)) throw Object.assign(new Error('no headphone device chosen'), { name: 'NoDeviceError' });
  const sup = cueSupport();
  let firstErr = null;
  if (sup.ctxSink) {
    let c2 = null;
    try {
      c2 = new window.AudioContext({ latencyHint: 'interactive', sampleRate });
      await c2.setSinkId(deviceId);
      const src = c2.createMediaStreamSource(stream);
      src.connect(c2.destination);
      // Without a user activation resume() can stay pending for ever; never hang the route on it.
      await Promise.race([c2.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (c2.state !== 'running') throw Object.assign(new Error('output context not running'), { name: 'NotAllowedError' });
      return {
        variant: 'context', ctx: c2,
        latency: (c2.baseLatency || 0) + (c2.outputLatency || 0),
        close() { try { src.disconnect(); } catch {} try { c2.close(); } catch {} },
        onError(fn) { c2.addEventListener?.('error', fn); },
      };
    } catch (e) {
      try { c2 && c2.close(); } catch {}
      firstErr = e;
      if (e && e.name === 'NotFoundError') throw e;   // the device is gone; another path won't find it
    }
  }
  if (sup.devices) {
    const el = document.createElement('audio');
    el.autoplay = false;
    try {
      el.srcObject = stream;
      await el.setSinkId(deviceId);
      await el.play();
      return {
        variant: 'element', el, latency: null,
        close() { try { el.pause(); } catch {} try { el.srcObject = null; } catch {} },
        onError(fn) { el.addEventListener('error', fn); },
      };
    } catch (e) {
      try { el.pause(); el.srcObject = null; } catch {}
      throw firstErr || e;
    }
  }
  throw firstErr || new Error('This browser cannot choose an audio output');
}

function _sinkMessage(e) {
  if (e && e.name === 'NotFoundError') return 'The headphone output is not connected — cue is off';
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'The browser did not allow the headphone output — pick it again in cue settings';
  }
  return 'Could not open the headphone output — cue is off';
}

async function _build() {
  const m = _m || await _engine();
  if (!m) return { error: 'unavailable' };
  _m = m;
  const g = _deskGraph(m);
  if (!g || !g.ctx || !g.master || !g.nodes) return { error: 'unavailable' };
  const s = cueSettings();
  const mode = effectiveCueMode(s.mode, cueSupport().modes);
  if (mode === 'off') return { error: 'off' };
  const { ctx, master, nodes } = g;
  if (mode === 'devices') {
    if (configuredCueMode(s, [mode]) === 'off') {
      showToast('Choose the headphone output in the cue settings first', true);
      return { error: 'nodevice' };
    }
    let outs = null;
    try { outs = await _readOutputs(); } catch { outs = null; }
    const mainSink = typeof ctx.sinkId === 'string' ? ctx.sinkId : '';
    if (sameAsMainOutput(s.deviceId, mainSink, outs)) {
      showToast('The headphone output is the one the music plays on — choose another device in the cue settings', true);
      return { error: 'samedevice' };
    }
  }
  const dest = ctx.destination;
  const plan = routingPlan(mode, { maxChannels: dest.maxChannelCount });
  if (!plan) return { error: 'unsupported' };

  const r = { mode, plan, g, ext: [], own: [], out: null, destPrev: null, unlisten: [] };
  const own = (n) => { r.own.push(n); return n; };
  // An edge from an ENGINE node to one of ours: remembered so teardown removes exactly it.
  const tap = (src, dst, o, i) => {
    if (o == null) src.connect(dst); else src.connect(dst, o, i);
    r.ext.push([src, dst, o, i]);
  };

  r.sum = own(ctx.createGain());
  r.vol = own(ctx.createGain());
  r.vol.channelCount = 2; r.vol.channelCountMode = 'explicit'; r.vol.channelInterpretation = 'speakers';
  r.sum.connect(r.vol);
  // The cue's own safety limiter, set like the engine's: master and PFL summed in the
  // headphones can pass 0 dBFS. It also delays the cue by the same look-ahead the
  // master limiter adds, so master in the headphones stays in step with the speakers.
  r.out1 = r.vol;
  if (typeof ctx.createDynamicsCompressor === 'function') {
    const lim = own(ctx.createDynamicsCompressor());
    try {
      lim.threshold.value = -0.5; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.002; lim.release.value = 0.06;
    } catch {}
    r.vol.connect(lim);
    r.out1 = lim;
  }
  r.pfl = { A: own(ctx.createGain()), B: own(ctx.createGain()) };
  r.masterTap = own(ctx.createGain());
  for (const n of [r.pfl.A, r.pfl.B, r.masterTap]) { n.gain.value = 0; n.connect(r.sum); }
  _route = r;            // gains below need it; undone on failure
  _applyGains();

  const undoOwn = () => {
    for (const [src, dst, o, i] of r.ext) { try { o == null ? src.disconnect(dst) : src.disconnect(dst, o, i); } catch {} }
    for (const n of r.own) { try { n.disconnect(); } catch {} }
    _route = null;
  };

  try {
    tap(nodes.A.levelGain, r.pfl.A);
    tap(nodes.B.levelGain, r.pfl.B);
    // The master as the limiter receives it (see the header): both crossfade gains.
    tap(nodes.A.gain, r.masterTap);
    tap(nodes.B.gain, r.masterTap);
    if (plan.output === 'stream') {
      const msd = own(ctx.createMediaStreamDestination());
      r.msd = msd;
      r.out1.connect(msd);
      r.out = await _openSink(msd.stream, s.deviceId, ctx.sampleRate);
      r.out.onError(() => _sinkLost('The headphone output stopped — cue is off'));
      if (s.deviceId && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        const onChange = async () => {
          let list = null;
          try { list = await _readOutputs(); } catch { return; }
          if (_route === r && !sinkStillPresent(s.deviceId, list)) _sinkLost('The headphone output was disconnected — cue is off');
        };
        navigator.mediaDevices.addEventListener('devicechange', onChange);
        r.unlisten.push(() => navigator.mediaDevices.removeEventListener('devicechange', onChange));
      }
    } else {
      r.destPrev = {
        channelCount: dest.channelCount, channelCountMode: dest.channelCountMode,
        channelInterpretation: dest.channelInterpretation,
      };
      if (plan.mode === 'multichannel') {
        const merger = own(ctx.createChannelMerger(4));
        const mSt = own(ctx.createGain());          // a mono track still fills both master channels
        mSt.channelCount = 2; mSt.channelCountMode = 'explicit'; mSt.channelInterpretation = 'speakers';
        const mSplit = own(ctx.createChannelSplitter(2));
        const cSplit = own(ctx.createChannelSplitter(2));
        tap(master, mSt);
        mSt.connect(mSplit);
        mSplit.connect(merger, 0, plan.map.masterL);
        mSplit.connect(merger, 1, plan.map.masterR);
        r.out1.connect(cSplit);
        cSplit.connect(merger, 0, plan.map.cueL);
        cSplit.connect(merger, 1, plan.map.cueR);
        r.merger = merger;
      } else {
        const merger = own(ctx.createChannelMerger(2));   // each merger input is downmixed to mono
        tap(master, merger, 0, plan.map.masterMono);
        r.out1.connect(merger, 0, plan.map.cueMono);
        r.merger = merger;
      }
      // Switch in one task: master leaves the destination, the merger takes its place.
      try {
        dest.channelCount = plan.channelCount;
        dest.channelCountMode = 'explicit';
        dest.channelInterpretation = 'discrete';
      } catch (e) {
        Object.assign(dest, r.destPrev);
        throw e;
      }
      master.disconnect(dest);
      r.masterOff = true;
      r.merger.connect(dest);
    }
  } catch (e) {
    if (r.masterOff) { try { r.merger.disconnect(); } catch {} }
    undoOwn();
    _stopStream(r);
    if (r.destPrev) { try { Object.assign(dest, r.destPrev); } catch {} }
    if (r.masterOff) master.connect(dest);
    if (plan.output === 'stream') showToast(_sinkMessage(e), true);
    return { error: plan.output === 'stream' ? 'sink' : 'route', cause: e };
  }

  for (const k of ['A', 'B']) {
    const el = g.els && g.els[k];
    if (el && el.addEventListener) {
      el.addEventListener('volumechange', _applyGains);
      r.unlisten.push(() => el.removeEventListener('volumechange', _applyGains));
    }
  }
  try { if (ctx.state !== 'running' && ctx.resume) ctx.resume().catch(() => {}); } catch {}
  return { ok: true };
}

/** A MediaStreamDestination's track lives on after its node is disconnected: stop it. */
function _stopStream(r) {
  try { const st = r && r.msd && r.msd.stream; if (st && st.getTracks) st.getTracks().forEach((t) => t.stop()); } catch {}
}

function _teardown() {
  const r = _route;
  if (!r) return;
  _route = null;
  if (!_owners.size) _dropTaps();
  for (const u of r.unlisten) { try { u(); } catch {} }
  const { ctx, master } = r.g;
  const dest = ctx.destination;
  if (r.masterOff) {
    try { r.merger.disconnect(); } catch {}
    try { Object.assign(dest, r.destPrev); } catch {}
  }
  for (const [src, dst, o, i] of r.ext) { try { o == null ? src.disconnect(dst) : src.disconnect(dst, o, i); } catch {} }
  for (const n of r.own) { try { n.disconnect(); } catch {} }
  if (r.out) { try { r.out.close(); } catch {} }
  _stopStream(r);
  if (r.masterOff) master.connect(dest);       // exactly as the engine had it
}

async function _reroute() {
  if (!_owners.size) return;
  _teardown();
  const res = await _build();
  if (!res.ok) {
    // off: nothing to say; sink / nodevice / samedevice: _build said it already.
    const msg = ['off', 'sink', 'nodevice', 'samedevice'].includes(res.error) ? null : 'Headphone cue could not start';
    _forceOff(msg, res.error);
    return;
  }
  _notify('route');
}

function _sinkLost(msg) {
  if (!_route) return;
  _forceOff(msg, 'sink');
}

/** Cue off for everyone: preview stopped, route torn down, master left playing. */
function _forceOff(msg, reason = null) {
  if (_pv) _endPreviewNow(reason || 'off', true);
  _owners.clear();
  _teardown();
  _routeError = reason;
  if (msg) showToast(msg, true);
  _notify('route', { reason });
}

export function acquireCue(owner) {
  return _serial(async () => {
    const m = await _engine();
    if (!m) return { ok: false, error: 'unavailable' };
    _m = m; _listen();
    if (_route) { _owners.add(owner); return { ok: true }; }
    const res = await _build();
    if (!res.ok) { _routeError = res.error; return { ok: false, error: res.error }; }
    _owners.add(owner);
    _routeError = null;
    _notify('route');
    return { ok: true };
  });
}

function _dropOwner(owner) {
  _owners.delete(owner);
  if (!_owners.size && _route) { _teardown(); _notify('route'); }
}

export function releaseCue(owner) {
  return _serial(async () => { _dropOwner(owner); return { ok: true }; });
}

// The preview's hold, given back only if no newer preview took it over by the time the
// queued release runs (an old preview ending while a new one acquires must not tear
// the new one's route down).
function _releasePreviewHold() {
  return _serial(async () => { if (!_pv) _dropOwner('preview'); return { ok: true }; });
}

/** Extra (not in the contract): what is built right now — for the desk and the tests. */
export function cueStatus() {
  const r = _route;
  return {
    active: !!r, mode: r ? r.mode : null, owners: [..._owners],
    variant: r && r.out ? r.out.variant : null,
    latency: r && r.out ? r.out.latency : null,
    error: _routeError,
  };
}

// ── meters / taps ──
function _analyser(ctx) {
  const a = ctx.createAnalyser();
  a.fftSize = 2048;
  return a;
}

function _dropTaps() {
  const t = _taps;
  if (!t) return;
  _taps = null;
  for (const [src, an] of [[t.src.master, t.master], [t.src.A, t.post.A], [t.src.B, t.post.B]]) {
    try { src.disconnect(an); } catch {}
  }
}

function _ensureTaps() {
  const g = _graph || (_m && _deskGraph(_m));
  if (!g || !g.ctx) return null;
  // deskGraph() answers a fresh object every call: the same graph is the same context
  // and nodes, not the same wrapper (comparing wrappers added three analysers a call).
  if (_taps && (_taps.ctx !== g.ctx || _taps.src.master !== g.master
      || _taps.src.A !== g.nodes.A.gain || _taps.src.B !== g.nodes.B.gain)) _dropTaps();
  if (!_taps) {
    const t = {
      ctx: g.ctx, src: { master: g.master, A: g.nodes.A.gain, B: g.nodes.B.gain },
      master: _analyser(g.ctx), post: { A: _analyser(g.ctx), B: _analyser(g.ctx) },
    };
    g.master.connect(t.master);                  // post-limiter
    g.nodes.A.gain.connect(t.post.A);            // post-crossfade: the lent deck must read silence
    g.nodes.B.gain.connect(t.post.B);
    _taps = t;
  }
  const r = _route;
  if (r && !r.cueTap) {
    r.cueTap = _analyser(g.ctx);
    r.own.push(r.cueTap);
    (r.out1 || r.vol).connect(r.cueTap);         // what the headphones get: post volume, post limiter
  }
  return _taps;
}

function _rmsOf(an) {
  if (!an) return 0;
  const d = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(d);
  return rms(d);
}

export function cueLevels() {
  if (!_route) return { master: 0, cue: 0 };
  const t = _ensureTaps();
  if (!t) return { master: 0, cue: 0 };
  return { master: _rmsOf(t.master), cue: _rmsOf(_route && _route.cueTap) };
}

export function _debugTaps() {
  const t = _ensureTaps();
  if (!t) return null;
  return { master: t.master, cue: _route ? _route.cueTap : null, post: { ...t.post } };
}

// ── change notification ──
export function onCueChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function _notify(type, extra = {}) {
  const ev = { type, active: !!_route, mode: _route ? _route.mode : null, preview: previewState(), ...extra };
  for (const cb of [..._listeners]) { try { cb(ev); } catch (e) { console.error('cue listener', e); } }
}

function _onDeskEngine(e) {
  const d = (e && e.detail) || {};
  if (d.type === 'revoked') {
    if (_pv && (!d.key || d.key === _pv.key)) _endPreviewNow(d.reason || 'revoked', false);
    if (d.reason === 'cast' || d.reason === 'remote') {
      if (_owners.size || _route) _forceOff(null, d.reason);
      return;
    }
  }
  _applyGains();
}

function _listen() {
  if (_listening || typeof document === 'undefined' || !document.addEventListener) return;
  _listening = true;
  document.addEventListener('desk:engine', _onDeskEngine);
}

// ── preview (one cue track at a time) ──
function _previewEl() {
  return _pv && _graph && _graph.els ? _graph.els[_pv.key] : null;
}

export function previewState() {
  if (!_pv) return null;
  const el = _previewEl();
  let dur = 0;
  try { dur = (_m && _m.deskDur && _m.deskDur(_pv.key)) || 0; } catch { dur = 0; }
  if (!dur && el && Number.isFinite(el.duration)) dur = el.duration;
  return {
    item: _pv.item, key: _pv.key, loading: !!_pv.loading,
    playing: !!el && !el.paused && !_pv.loading,
    pos: el ? el.currentTime || 0 : 0, dur,
  };
}

function _detachPreviewEl(pv) {
  if (pv && pv.off) { pv.off(); pv.off = null; }
}

/** Synchronous part of ending a preview. `release`: give the deck back if we lent it. */
function _endPreviewNow(reason, release) {
  const pv = _pv;
  if (!pv) return;
  _pv = null;
  _detachPreviewEl(pv);
  if (release && _m) {
    const info = _info();
    if (info.loan === pv.key) {
      if (pv.lentByUs) { try { _m.deskRelease(); } catch {} }
      else { const el = _graph && _graph.els && _graph.els[pv.key]; try { el && el.pause(); } catch {} }
    }
  }
  _applyGains();
  _releasePreviewHold();
  _notify('preview', { reason });
}

function _lendRefusal() {
  const b = _info().blocked;
  if (b === 'rec') return 'Headphone cue is not available while a recommendation plays';
  if (b === 'cast' || b === 'remote') return 'Headphone cue is not available while casting or controlling another device';
  return 'Cue is not possible during a transition — try again in a moment';
}

/**
 * Take the deck for a new preview. Two taps in a row are put in order by acquireCue's
 * queue, and everything after it up to `_pv = pv` is synchronous: the later tap finds
 * the earlier one's preview and inherits its deck AND its ownership (lentByUs), so it
 * never mistakes the earlier tap's loan for the desk's. The latest tap wins.
 */
async function _claimPreview(m, item, index) {
  const res = await acquireCue('preview');
  if (!res.ok) {
    if (!['sink', 'nodevice', 'samedevice'].includes(res.error)) showToast('Headphone cue could not start', true);
    return null;
  }
  // From here on synchronous: nothing can take the deck between the check and _pv.
  let prev = _pv;
  const loan = _info().loan;
  if (prev && loan !== prev.key) { _endPreviewNow('revoked', false); prev = null; }
  let key = prev ? prev.key : loan;
  let lentByUs = prev ? prev.lentByUs : false;
  if (!key) {
    try { key = m.deskLend(); } catch { key = null; }
    lentByUs = !!key;
  }
  if (!key) {
    _releasePreviewHold();
    showToast(_lendRefusal(), true);
    return null;
  }
  if (prev) _detachPreviewEl(prev);               // same owner 'preview': the hold carries over
  const pv = { item, key, index, lentByUs, loading: true, off: null };
  _pv = pv;
  _applyGains();
  _notify('preview');
  return pv;
}

export async function previewItem(item, { startAt = 0, index = null } = {}) {
  if (!item) return false;
  const m = await _engine();
  if (!m) { showToast('Headphone cue needs the DJ player', true); return false; }
  _m = m; _listen();
  if (store.castDevice || store.remoteTarget) {
    showToast('Headphone cue is not available while casting or controlling another device', true);
    return false;
  }
  _deskGraph(m);                                     // the context, from this gesture
  if (configuredCueMode(cueSettings(), cueSupport().modes) === 'off') {
    const { openCueSetup } = await import('./cuesetup.js');
    const saved = await openCueSetup();
    if (!saved || configuredCueMode(cueSettings(), cueSupport().modes) === 'off') return false;
  }

  const pv = await _claimPreview(m, item, index);
  if (!pv) return false;

  let ok = false;
  // warm:false — a quick listen must not take a slot of the engine's own prefetch.
  try { ok = await m.deskLoad(item, { startAt, index, play: true, warm: false }); } catch { ok = false; }
  if (_pv !== pv) return false;                      // stopped, revoked or replaced: not a failure
  if (!ok) {
    _endPreviewNow('load-failed', true);
    showToast('Could not load the track for cue', true);
    return false;
  }
  pv.loading = false;
  const el = _previewEl();
  if (el && el.addEventListener) {
    const on = () => _notify('preview');
    // A preview that played to its end gives the deck and the cue back: in split mode
    // the master stays mono in one ear for as long as anyone holds the route.
    const onEnded = () => { if (_pv === pv) _endPreviewNow('ended', true); };
    for (const t of ['play', 'pause', 'durationchange']) el.addEventListener(t, on);
    el.addEventListener('ended', onEnded);
    pv.off = () => {
      for (const t of ['play', 'pause', 'durationchange']) el.removeEventListener(t, on);
      el.removeEventListener('ended', onEnded);
    };
  }
  _notify('preview');
  return true;
}

export function stopPreview() {
  if (_pv) _endPreviewNow('stop', true);
}

export function previewToggle() {
  const el = _previewEl();
  if (!el || _pv.loading) return;
  if (el.paused) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
  else el.pause();
}

export function previewSeek(t) {
  if (!_pv || !_m) return;
  const to = Math.max(0, Number(t) || 0);
  try { _m.deskSeek(_pv.key, to); } catch {}
  _notify('preview');
}

export function init() {}

// Tests: inject a fake engine and reset module state between cases.
export const _internals = {
  setEngine(m) { _engineOverride = m; _m = m; _graph = null; _taps = null; },
  reset() {
    _pv = null; _owners.clear(); _route = null; _settings = null; _routeError = null;
    _taps = null; _graph = null; _chain = Promise.resolve();
  },
  route: () => _route,
};
