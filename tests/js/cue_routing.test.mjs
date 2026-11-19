// Headphone cue routing (dj-pult). Run: node --test tests/js/cue_routing.test.mjs
//
// Two halves:
//  1. cuemath.js — the pure decisions (modes per device, routing plan, compensation,
//     Bluetooth labels, settings).
//  2. cuebus.js over a FAKE Web Audio graph that records every connection. The key
//     property is isolation: the cue bus may READ from the decks (levelGain) and from
//     the master, but nothing may ever be connected INTO the master or into a deck's
//     crossfade gain — the lent deck would then be heard on the dance floor. And the
//     master must end up wired to the destination exactly as before.
//     The real cuebus.js runs here; only the browser and the engine are faked.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../static/js/cuemath.js';

// ── 1. pure ────────────────────────────────────────────────────────────────

test('modes: a desktop Chromium with setSinkId offers devices and split; 4+ channels add multichannel', () => {
  assert.deepEqual(M.supportedCueModes({ devices: true, ctxSink: true, maxChannels: 2 }), ['devices', 'split']);
  assert.deepEqual(M.supportedCueModes({ devices: true, maxChannels: 6 }), ['devices', 'multichannel', 'split']);
  assert.deepEqual(M.supportedCueModes({ devices: false, ctxSink: true, maxChannels: null }), ['devices', 'split']);
  assert.deepEqual(M.supportedCueModes({ devices: false, ctxSink: false, maxChannels: 2 }), ['split']);
  assert.deepEqual(M.supportedCueModes({ devices: true, enumerate: false }), ['split']);
});

test('modes: phone, Android app and WebKit get split only — no dead buttons', () => {
  const rich = { devices: true, ctxSink: true, maxChannels: 8 };
  assert.deepEqual(M.supportedCueModes({ ...rich, mobile: true }), ['split']);
  assert.deepEqual(M.supportedCueModes({ ...rich, androidApp: true }), ['split']);
  assert.deepEqual(M.supportedCueModes({ ...rich, webkit: true }), ['split']);
});

test('effective mode: a stored mode this device cannot do falls back to off, never to another route', () => {
  assert.equal(M.effectiveCueMode('devices', ['split']), 'off');
  assert.equal(M.effectiveCueMode('split', ['devices', 'split']), 'split');
  assert.equal(M.effectiveCueMode('off', ['split']), 'off');
  assert.equal(M.effectiveCueMode('multichannel', null), 'off');
});

test('routing plan: devices never touches the master; multichannel needs 4 channels; split maps L/R', () => {
  assert.equal(M.routingPlan('devices').touchesMaster, false);
  assert.equal(M.routingPlan('multichannel', { maxChannels: 2 }), null);
  const mc = M.routingPlan('multichannel', { maxChannels: 4 });
  assert.equal(mc.touchesMaster, true);
  assert.equal(mc.channelCount, 4);
  assert.deepEqual(mc.map, { masterL: 0, masterR: 1, cueL: 2, cueR: 3 });
  const sp = M.routingPlan('split');
  assert.deepEqual(sp.map, { masterMono: 0, cueMono: 1 });
  assert.equal(sp.channelCount, 2);
  assert.equal(M.routingPlan('off'), null);
});

test('compensation undoes the master fader, floored at 0.05', () => {
  assert.equal(M.compensationGain(1), 1);
  assert.equal(M.compensationGain(0.5), 2);
  assert.equal(M.compensationGain(0), 20);
  assert.equal(M.compensationGain(0.01), 20);
  assert.equal(M.compensationGain(NaN), 1);
  assert.equal(M.compensationGain(3), 1);
});

test('tap gains: the master fader does not move the headphone level', () => {
  for (const v of [1, 0.6, 0.25]) {
    // What reaches the headphones = tap gain × (signal already scaled by the element volume).
    const t = M.cueTapGains({ mix: 1, masterVolume: v, pfl: { A: true }, elVolume: { A: v, B: 1 } });
    assert.ok(Math.abs(t.master * v - 1) < 1e-9, `master tap at volume ${v}`);
  }
  // The LIVE deck carries the master volume, the lent deck carries 1.
  const t = M.cueTapGains({ mix: 0, masterVolume: 0.5, pfl: { A: true, B: true }, elVolume: { A: 0.5, B: 1 } });
  assert.ok(Math.abs(t.A * 0.5 - t.B * 1) < 1e-9, 'both decks equally loud in the headphones');
  assert.equal(M.cueTapGains({ mix: 0, pfl: { A: false } }).A, 0);
  assert.ok(Math.abs(M.cueTapGains({ mix: 0 }).master) < 1e-9, 'mix 0 = cue only');
  const half = M.mixGains(0.5);
  assert.ok(Math.abs(half.cue - half.master) < 1e-9 && Math.abs(half.cue ** 2 + half.master ** 2 - 1) < 1e-9);
});

test('Bluetooth labels', () => {
  for (const l of ['AirPods Pro', 'Galaxy Buds2', 'Headset (WH-1000XM4 Hands-Free AG Audio)', 'Bluetooth Speaker',
    'JBL Tune BT', 'bluez_output.00_1A_7D.a2dp-sink', 'Pixel Buds', 'Hands Free']) {
    assert.ok(M.isBluetoothLabel(l), l);
  }
  for (const l of ['', null, 'Speakers (Realtek(R) Audio)', 'Default - Built-in Output', 'Scarlett 2i2 USB',
    'HDMI Output', 'Fake Default Audio Output', 'Behringer UMC404HD']) {
    assert.ok(!M.isBluetoothLabel(l), String(l));
  }
});

test('settings: normalised, stored and read back', () => {
  const s = M.normalizeCueSettings({ mode: 'nonsense', volume: 7, mix: -1, pfl: { A: 1, B: true } });
  assert.deepEqual(s, { mode: 'off', deviceId: '', deviceLabel: '', volume: 1, mix: 0, pfl: { A: false, B: true } });
  const store = new Map(M.cueSettingsEntries({ mode: 'split', deviceId: 'x1', volume: 0.3, mix: 0.25, pfl: { A: true } }));
  const back = M.readCueSettings((k) => (store.has(k) ? store.get(k) : null));
  assert.deepEqual(back, { mode: 'split', deviceId: 'x1', deviceLabel: '', volume: 0.3, mix: 0.25, pfl: { A: true, B: false } });
  assert.deepEqual(M.readCueSettings(() => { throw new Error('blocked'); }), M.normalizeCueSettings({}));
  assert.equal(M.normalizeCueSettings({ volume: '' }).volume, 0.8);
});

test('sink presence: hidden ids are not evidence a device is gone', () => {
  assert.equal(M.sinkStillPresent('abc', [{ deviceId: 'default' }, { deviceId: 'abc' }]), true);
  assert.equal(M.sinkStillPresent('abc', [{ deviceId: 'default' }, { deviceId: 'zzz' }]), false);
  assert.equal(M.sinkStillPresent('abc', [{ deviceId: '' }]), true);
  // No explicit device is never "present": no route is ever built to one.
  assert.equal(M.sinkStillPresent('', []), false);
  assert.equal(M.sinkStillPresent('default', [{ deviceId: 'default' }]), false);
});

test('devices needs an explicit device: "" / default / communications are the main speakers', () => {
  for (const id of ['', 'default', 'communications', null, undefined]) {
    assert.equal(M.isExplicitDevice(id), false, String(id));
    assert.equal(M.configuredCueMode({ mode: 'devices', deviceId: id }, ['devices', 'split']), 'off', String(id));
  }
  assert.equal(M.configuredCueMode({ mode: 'devices', deviceId: 'phones' }, ['devices', 'split']), 'devices');
  assert.equal(M.configuredCueMode({ mode: 'devices', deviceId: 'phones' }, ['split']), 'off');
  assert.equal(M.configuredCueMode({ mode: 'split', deviceId: '' }, ['split']), 'split');
  assert.equal(M.configuredCueMode(null, ['split']), 'off');
});

test('same as the main output: an explicit main sink by id, the system default by its label', () => {
  const outs = [
    { deviceId: 'default', label: 'Default - Speakers (Realtek(R) Audio)' },
    { deviceId: 'spk', label: 'Speakers (Realtek(R) Audio)' },
    { deviceId: 'usb', label: 'Headphones (USB Audio)' },
  ];
  assert.equal(M.sameAsMainOutput('spk', '', outs), true, 'the default device under its own id');
  assert.equal(M.sameAsMainOutput('usb', '', outs), false);
  assert.equal(M.sameAsMainOutput('usb', 'usb', outs), true, 'the context was moved onto it');
  assert.equal(M.sameAsMainOutput('spk', 'usb', outs), false);
  assert.equal(M.sameAsMainOutput('', 'usb', outs), true, 'no device = the default = never a cue output');
  assert.equal(M.sameAsMainOutput('spk', '', [{ deviceId: 'default', label: 'Default' }, { deviceId: 'spk', label: 'X' }]), false, 'unknown is not refused');
  assert.equal(M.sameAsMainOutput('spk', '', []), false);
});

// ── 2. cuebus over a fake graph ────────────────────────────────────────────

let B, store;
let edges;           // Set of "srcId>dstId:o:i"
let nodeSeq = 0;
let ctx, engine, deskEvents, sinkFail;
let streamTracks = [];
const toastText = () => toasts.map((t) => t.textContent).filter(Boolean);

function param(v) {
  return { value: v, setTargetAtTime(x) { this.value = x; }, cancelScheduledValues() {} };
}
function node(kind, extra = {}) {
  const n = {
    id: `${kind}#${++nodeSeq}`, kind, channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers',
    gain: param(1),
    connect(dst, o = 0, i = 0) { edges.add(`${n.id}>${dst.id}:${o}:${i}`); return dst; },
    disconnect(dst, o, i) {
      for (const e of [...edges]) {
        const [src, rest] = e.split('>');
        if (src !== n.id) continue;
        const [d, eo, ei] = rest.split(':');
        if (dst && d !== dst.id) continue;
        if (o != null && Number(eo) !== o) continue;
        if (i != null && Number(ei) !== i) continue;
        edges.delete(e);
      }
    },
    ...extra,
  };
  return n;
}
function fakeEl(volume) {
  const ls = {};
  return {
    volume, paused: true, currentTime: 0, duration: 200,
    addEventListener(t, f) { (ls[t] ||= new Set()).add(f); }, removeEventListener(t, f) { ls[t]?.delete(f); },
    fire(t) { for (const f of ls[t] || []) f(); },
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; },
  };
}
function makeEngine({ maxChannels = 2 } = {}) {
  edges = new Set();
  const dest = node('destination', { maxChannelCount: maxChannels, channelCountMode: 'explicit' });
  ctx = {
    destination: dest, currentTime: 0, sampleRate: 48000, state: 'running', resume: async () => {},
    createGain: () => node('gain'),
    createAnalyser: () => node('analyser', { fftSize: 2048, getFloatTimeDomainData(a) { a.fill(0); } }),
    createChannelMerger: (n) => node(`merger${n}`),
    createChannelSplitter: (n) => node(`splitter${n}`),
    createMediaStreamDestination: () => {
      const track = { stopped: false, stop() { this.stopped = true; } };
      streamTracks.push(track);
      return node('msd', { stream: { id: 'stream', getTracks: () => [track] } });
    },
    createDynamicsCompressor: () => node('limiter', {
      threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25),
    }),
  };
  const deck = (k) => ({ low: node(`low${k}`), mid: node(`mid${k}`), high: node(`high${k}`), sweep: node(`sweep${k}`),
    levelGain: node(`level${k}`), gain: node(`xfade${k}`) });
  const nodes = { A: deck('A'), B: deck('B') };
  const master = node('master');
  for (const k of ['A', 'B']) {
    const d = nodes[k];
    d.low.connect(d.mid); d.mid.connect(d.high); d.high.connect(d.sweep); d.sweep.connect(d.levelGain);
    d.levelGain.connect(d.gain); d.gain.connect(master);
  }
  master.connect(dest);
  const els = { A: fakeEl(0.5), B: fakeEl(0.5) };
  const st = { active: 'A', loan: null, volume: 0.5, blocked: null };
  engine = {
    deskGraph: () => ({ ctx, master, nodes, els }),
    deskInfo: () => ({ ready: true, active: st.active, loan: st.loan, volume: st.volume, fading: null, blocked: st.blocked }),
    deskLend: () => { if (st.loan || st.blocked) return null; st.loan = st.active === 'A' ? 'B' : 'A'; els[st.loan].volume = 1; nodes[st.loan].gain.gain.value = 0; return st.loan; },
    deskLoad: async (item, opts) => { engine.loads.push({ item, opts }); if (item.fail) return false; els[st.loan].paused = false; return true; },
    deskRelease: () => { if (st.loan) { els[st.loan].paused = true; els[st.loan].volume = st.volume; } st.loan = null; engine.released++; },
    deskSeek: (k, t) => { els[k].currentTime = t; },
    deskDur: () => 200,
    loads: [], released: 0, st, master, nodes, els,
  };
  return engine;
}

const snapshot = () => new Set(edges);
const added = (before) => [...edges].filter((e) => !before.has(e));
const removed = (before) => [...before].filter((e) => !edges.has(e));
const dstOf = (e) => e.split('>')[1].split(':')[0];

function reachable(fromId) {
  const out = new Map();
  for (const e of edges) { const [s, r] = e.split('>'); const d = r.split(':')[0]; (out.get(s) || out.set(s, []).get(s)).push(d); }
  const seen = new Set([fromId]); const q = [fromId];
  while (q.length) { for (const d of out.get(q.shift()) || []) if (!seen.has(d)) { seen.add(d); q.push(d); } }
  return seen;
}

function assertIsolated(before) {
  const forbidden = new Set([engine.master.id, engine.nodes.A.gain.id, engine.nodes.B.gain.id]);
  for (const e of added(before)) {
    assert.ok(!forbidden.has(dstOf(e)), `cue bus connected INTO an engine bus: ${e}`);
  }
  // The lent deck's pre-fader signal must not reach the master through anything we built.
  const r = reachable(engine.nodes.B.levelGain.id);
  const viaEngine = [...r].some((id) => id === engine.nodes.B.gain.id);
  assert.ok(viaEngine, 'the engine path itself is intact');
  for (const e of added(before)) {
    const [s] = e.split('>');
    if (s === engine.nodes.B.levelGain.id || s === engine.nodes.A.levelGain.id) {
      const tapReach = (() => {
        const seen = new Set([dstOf(e)]); const q = [dstOf(e)];
        const out = new Map();
        for (const x of edges) { const [ss, rr] = x.split('>'); (out.get(ss) || out.set(ss, []).get(ss)).push(rr.split(':')[0]); }
        while (q.length) { for (const d of out.get(q.shift()) || []) if (!seen.has(d)) { seen.add(d); q.push(d); } }
        return seen;
      })();
      assert.ok(!tapReach.has(engine.master.id), `a PFL tap reaches the master: ${e}`);
      assert.ok(!tapReach.has(engine.nodes.A.gain.id) && !tapReach.has(engine.nodes.B.gain.id), `a PFL tap reaches a crossfade gain: ${e}`);
    }
  }
}

let toasts = [];
before(async () => {
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), _m: ls };
  const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, setAttribute() {}, querySelector: () => null });
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, f) { if (t === 'desk:engine') deskEvents.push(f); }, dispatchEvent() {},
    createElement: (t) => {
      if (t === 'audio') return sinkEl();
      const e = el();
      if (t === 'div') toasts.push(e);            // showToast builds its box as a div
      return e;
    }, body: el(),
  };
  globalThis.window = globalThis;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.history = { pushState() {}, back() {} };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', mediaDevices: { enumerateDevices: async () => [], addEventListener() {}, removeEventListener() {} } }, configurable: true });
  globalThis.HTMLMediaElement = function () {}; globalThis.HTMLMediaElement.prototype.setSinkId = function () {};
  globalThis.AudioContext = function () {};
  deskEvents = [];
  B = await import('../../static/js/cuebus.js');
  ({ store } = await import('../../static/js/store.js'));
  const utils = await import('../../static/js/utils.js');
  void utils;
});

let sinks = [];
function sinkEl() {
  const ls = {};
  const s = {
    srcObject: null, sinkId: '', paused: true,
    async setSinkId(id) { if (sinkFail) { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } s.sinkId = id; },
    async play() { s.paused = false; }, pause() { s.paused = true; },
    addEventListener(t, f) { (ls[t] ||= []).push(f); }, fire(t) { for (const f of ls[t] || []) f(); },
    style: {}, dataset: {}, classList: { add() {}, remove() {} },
  };
  sinks.push(s);
  return s;
}

beforeEach(() => {
  B._internals.reset();
  globalThis.localStorage._m.clear();
  makeEngine();
  B._internals.setEngine(engine);
  sinks = []; sinkFail = false; toasts = []; streamTracks = [];
  navigator.mediaDevices.enumerateDevices = async () => [];
  store.castDevice = null; store.remoteTarget = null;
});

for (const mode of ['split', 'devices', 'multichannel']) {
  test(`${mode}: the cue bus never feeds the master or a crossfade gain, and release restores the graph`, async () => {
    if (mode === 'multichannel') { makeEngine({ maxChannels: 6 }); B._internals.setEngine(engine); }
    const before = snapshot();
    const destBefore = { c: ctx.destination.channelCount, m: ctx.destination.channelCountMode, i: ctx.destination.channelInterpretation };
    B.setCueSettings(mode === 'devices' ? { mode, deviceId: 'phones' } : { mode });
    const res = await B.acquireCue('desk');
    assert.deepEqual(res, { ok: true });
    assertIsolated(before);
    const masterToDest = `${engine.master.id}>${ctx.destination.id}:0:0`;
    if (mode === 'devices') {
      assert.ok(edges.has(masterToDest), 'devices mode leaves master → destination alone');
      assert.deepEqual(removed(before), [], 'devices mode removes no engine connection');
      assert.equal(sinks.length, 1); assert.equal(sinks[0].paused, false);
    } else {
      assert.ok(!edges.has(masterToDest), `${mode} takes master off the destination`);
      assert.deepEqual(removed(before), [masterToDest], 'and removes nothing else');
      assert.equal(ctx.destination.channelCount, mode === 'split' ? 2 : 4);
      assert.equal(ctx.destination.channelInterpretation, 'discrete');
    }
    // PFL taps hang off levelGain, before the crossfade gain.
    assert.ok(added(before).some((e) => e.startsWith(`${engine.nodes.A.levelGain.id}>`)));
    assert.ok(added(before).some((e) => e.startsWith(`${engine.nodes.B.levelGain.id}>`)));

    // A second owner keeps the route; only the last release takes it down.
    await B.acquireCue('preview');
    await B.releaseCue('desk');
    assert.equal(B.cueStatus().active, true);
    await B.releaseCue('preview');
    assert.equal(B.cueStatus().active, false);
    assert.deepEqual([...edges].sort(), [...before].sort(), 'graph exactly as before');
    assert.deepEqual({ c: ctx.destination.channelCount, m: ctx.destination.channelCountMode, i: ctx.destination.channelInterpretation }, destBefore);
    if (mode === 'devices') assert.equal(sinks[0].paused, true);
  });
}

test('multichannel is refused on a stereo output, without touching the master', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'multichannel' });
  const res = await B.acquireCue('desk');
  assert.equal(res.ok, false);
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('a missing headphone device: cue off with a toast, master untouched', async () => {
  const before = snapshot();
  sinkFail = true;
  B.setCueSettings({ mode: 'devices', deviceId: 'gone' });
  const res = await B.acquireCue('desk');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sink');
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('a sink that dies mid-route turns the cue off and leaves the master playing', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'devices', deviceId: 'phones' });
  await B.acquireCue('desk');
  const seen = [];
  const off = B.onCueChange((e) => seen.push(e));
  sinks[0].fire('error');
  off();
  assert.equal(B.cueStatus().active, false);
  assert.deepEqual([...edges].sort(), [...before].sort());
  assert.ok(seen.some((e) => e.type === 'route' && e.active === false && e.reason === 'sink'));
});

test('gains: the live deck is compensated by the master volume, the lent deck is not', async () => {
  B.setCueSettings({ mode: 'split', mix: 0, volume: 0.7, pfl: { A: true, B: true } });
  await B.acquireCue('desk');
  engine.deskLend();                                  // B lent: element volume 1
  engine.els.B.fire('volumechange');
  const r = B._internals.route();
  assert.ok(Math.abs(r.pfl.A.gain.value - 2) < 1e-9, `live A at volume 0.5 → ×2 (${r.pfl.A.gain.value})`);
  assert.ok(Math.abs(r.pfl.B.gain.value - 1) < 1e-9, `lent B at element volume 1 → ×1 (${r.pfl.B.gain.value})`);
  assert.ok(Math.abs(r.vol.gain.value - 0.7) < 1e-9);
  B.setDeckCue('A', false);
  assert.equal(r.pfl.A.gain.value, 0);
  B.setCueSettings({ mix: 1 });
  assert.ok(Math.abs(r.masterTap.gain.value - 2) < 1e-9, 'master tap compensated by master volume 0.5');
});

test('preview: lends, loads, cues the lent deck; stop gives it back and releases the route', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  const ok = await B.previewItem({ name: 'x', artist: 'y' }, { startAt: 30, index: 4 });
  assert.equal(ok, true);
  assert.equal(engine.st.loan, 'B');
  // warm:false — a quick listen does not take a slot of the engine's own prefetch.
  assert.deepEqual(engine.loads[0].opts, { startAt: 30, index: 4, play: true, warm: false });
  const r = B._internals.route();
  assert.ok(r.pfl.B.gain.value > 0, 'the preview deck is in the headphones even with PFL B off in settings');
  assert.equal(B.cueSettings().pfl.B, false, 'and the setting was not changed');
  const st = B.previewState();
  assert.equal(st.key, 'B'); assert.equal(st.playing, true); assert.equal(st.dur, 200);
  B.previewSeek(42);
  assert.equal(engine.els.B.currentTime, 42);
  B.previewToggle();
  assert.equal(engine.els.B.paused, true);
  B.stopPreview();
  await B.releaseCue('nobody');                       // let the queued release run
  assert.equal(engine.st.loan, null);
  assert.equal(engine.released, 1);
  assert.equal(B.previewState(), null);
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('preview: the engine taking the deck back clears the state without releasing it twice', async () => {
  B.setCueSettings({ mode: 'split' });
  await B.previewItem({ name: 'x', artist: 'y' });
  const seen = [];
  B.onCueChange((e) => seen.push(e));
  engine.st.loan = null;                              // engine took it
  for (const f of deskEvents) f({ detail: { type: 'revoked', reason: 'load', key: 'B' } });
  await B.releaseCue('nobody');
  assert.equal(B.previewState(), null);
  assert.equal(engine.released, 0);
  assert.equal(B.cueStatus().active, false);
  assert.ok(seen.some((e) => e.type === 'preview' && e.preview === null && e.reason === 'load'));
});

test('preview: a load that fails gives the deck back', async () => {
  B.setCueSettings({ mode: 'split' });
  const ok = await B.previewItem({ name: 'x', fail: true });
  await B.releaseCue('nobody');
  assert.equal(ok, false);
  assert.equal(engine.st.loan, null);
  assert.equal(B.cueStatus().active, false);
});

test('preview: a second track reuses the lent deck (one cue track at a time)', async () => {
  B.setCueSettings({ mode: 'split' });
  await B.previewItem({ name: 'one' });
  await B.previewItem({ name: 'two' });
  assert.equal(engine.loads.length, 2);
  assert.equal(engine.released, 0);
  assert.equal(B.previewState().item.name, 'two');
  assert.equal(B.cueStatus().active, true);
  B.stopPreview();
  await B.releaseCue('nobody');
  assert.equal(B.cueStatus().active, false);
});

test('cast: the route comes down and the master goes back to the destination', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  await B.acquireCue('desk');
  for (const f of deskEvents) f({ detail: { type: 'revoked', reason: 'cast', key: null } });
  assert.equal(B.cueStatus().active, false);
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('changing the mode while held rebuilds the route', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  await B.acquireCue('desk');
  B.setCueSettings({ mode: 'devices', deviceId: 'phones' });
  await B.releaseCue('nobody');                       // wait for the queued reroute
  assert.equal(B.cueStatus().mode, 'devices');
  assert.ok(edges.has(`${engine.master.id}>${ctx.destination.id}:0:0`));
  await B.releaseCue('desk');
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('without the DJ engine nothing is offered', async () => {
  B._internals.setEngine(null);
  globalThis.localStorage.setItem('ms_player_engine', 'classic');
  assert.deepEqual(B.cueSupport().modes, []);
  const res = await B.acquireCue('desk');
  assert.equal(res.ok, false);
});

test('devices: a second AudioContext with setSinkId is preferred where it exists, the element otherwise', async () => {
  const made = [];
  class FakeAC {
    constructor(opts) { this.opts = opts; this.state = 'suspended'; this.baseLatency = 0.01; this.outputLatency = 0.02; this.destination = { id: 'dest2' }; made.push(this); }
    async setSinkId(id) { if (id === 'gone') { const e = new Error('nf'); e.name = 'NotFoundError'; throw e; } this.sinkId = id; }
    createMediaStreamSource(stream) { this.stream = stream; return { connect() {}, disconnect() {} }; }
    async resume() { this.state = 'running'; }
    close() { this.closed = true; }
    addEventListener() {}
  }
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = FakeAC;
  try {
    B.setCueSettings({ mode: 'devices', deviceId: 'phones' });
    assert.deepEqual(await B.acquireCue('desk'), { ok: true });
    const st = B.cueStatus();
    assert.equal(st.variant, 'context');
    assert.ok(Math.abs(st.latency - 0.03) < 1e-9);
    assert.equal(made[0].sinkId, 'phones');
    assert.equal(made[0].opts.latencyHint, 'interactive');
    assert.equal(sinks.length, 0, 'no <audio> element when the context path works');
    await B.releaseCue('desk');
    assert.equal(made[0].closed, true);
    // A device that is gone is not retried through the element.
    const before = snapshot();
    B.setCueSettings({ deviceId: 'gone' });
    const res = await B.acquireCue('desk');
    assert.equal(res.ok, false);
    assert.equal(sinks.length, 0);
    assert.deepEqual([...edges].sort(), [...before].sort());
  } finally { globalThis.AudioContext = saved; }
});

// ── review fixes (2026-11-19) ──────────────────────────────────────────────

for (const id of ['', 'default']) {
  test(`devices with deviceId ${JSON.stringify(id)} is refused: no route, master untouched, a toast`, async () => {
    const before = snapshot();
    B.setCueSettings({ mode: 'devices', deviceId: id });
    const res = await B.acquireCue('desk');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'nodevice');
    assert.equal(sinks.length, 0, 'no output element was opened');
    assert.deepEqual([...edges].sort(), [...before].sort());
    assert.ok(toastText().some((t) => /choose the headphone output/i.test(t)), toastText().join(' | '));
  });
}

test('devices onto the output the master plays on is refused with a clear message', async () => {
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers (Realtek(R) Audio)' },
    { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers (Realtek(R) Audio)' },
    { kind: 'audiooutput', deviceId: 'usb', label: 'Headphones (USB)' },
  ];
  const before = snapshot();
  B.setCueSettings({ mode: 'devices', deviceId: 'spk' });
  const res = await B.acquireCue('desk');
  assert.equal(res.error, 'samedevice');
  assert.deepEqual([...edges].sort(), [...before].sort());
  assert.ok(toastText().some((t) => /the music plays on/i.test(t)));
  B.setCueSettings({ deviceId: 'usb' });
  assert.deepEqual(await B.acquireCue('desk'), { ok: true });
  await B.releaseCue('desk');
});

test('switching a held route to devices without a device takes the cue down, master back on the speakers', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  await B.acquireCue('desk');
  B.setCueSettings({ mode: 'devices', deviceId: '' });
  await B.releaseCue('nobody');
  assert.equal(B.cueStatus().active, false);
  assert.deepEqual(B.cueStatus().owners, []);
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('the master tap is taken BEFORE the limiter (from both crossfade gains), so 1/volume is exact', async () => {
  B.setCueSettings({ mode: 'split', mix: 1 });
  const before = snapshot();
  await B.acquireCue('desk');
  const r = B._internals.route();
  const add = added(before);
  assert.ok(add.includes(`${engine.nodes.A.gain.id}>${r.masterTap.id}:0:0`));
  assert.ok(add.includes(`${engine.nodes.B.gain.id}>${r.masterTap.id}:0:0`));
  assert.ok(!add.some((e) => e.startsWith(`${engine.master.id}>${r.masterTap.id}`)), 'not from the limiter output');
  // The cue has its own limiter between the cue volume and the output.
  assert.ok(add.some((e) => e.startsWith(`${r.vol.id}>limiter#`)));
  assert.ok(!add.some((e) => e.startsWith(`${r.vol.id}>merger`)), 'nothing bypasses it');
  // What reaches the headphones from the master no longer depends on the master fader.
  for (const v of [1, 0.3]) {
    engine.st.volume = v; engine.els.A.volume = v; engine.els.A.fire('volumechange');
    assert.ok(Math.abs(r.masterTap.gain.value * v - 1) < 1e-9, `volume ${v}`);
  }
  await B.releaseCue('desk');
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('meter taps: one set per context however often they are read, and gone with the route', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  await B.acquireCue('desk');
  // cueGraph() takes a fresh deskGraph() wrapper each time, as every preview / setup does.
  for (let i = 0; i < 4; i++) { B._debugTaps(); B.cueLevels(); await B.cueGraph(); }
  const fromMaster = [...edges].filter((e) => e.startsWith(`${engine.master.id}>analyser#`));
  assert.equal(fromMaster.length, 1, fromMaster.join(' '));
  await B.releaseCue('desk');
  assert.deepEqual([...edges].sort(), [...before].sort(), 'no analyser left hanging off the engine');
});

test('devices: the MediaStream track is stopped when the route comes down', async () => {
  B.setCueSettings({ mode: 'devices', deviceId: 'phones' });
  await B.acquireCue('desk');
  assert.equal(streamTracks.length, 1);
  assert.equal(streamTracks[0].stopped, false);
  await B.releaseCue('desk');
  assert.equal(streamTracks[0].stopped, true);
});

test('preview: a track that plays to its end gives the deck and the cue back', async () => {
  const before = snapshot();
  B.setCueSettings({ mode: 'split' });
  assert.equal(await B.previewItem({ name: 'x' }), true);
  engine.els.B.fire('ended');
  await B.releaseCue('nobody');
  assert.equal(B.previewState(), null);
  assert.equal(engine.st.loan, null);
  assert.equal(engine.released, 1);
  assert.equal(B.cueStatus().active, false, 'split no longer holds the master mono');
  assert.deepEqual([...edges].sort(), [...before].sort());
});

test('preview: two quick taps — the latest wins, the first is no failure, the deck keeps its owner', async () => {
  B.setCueSettings({ mode: 'split' });
  const gates = [];
  engine.deskLoad = (item, opts) => {
    engine.loads.push({ item, opts });
    return new Promise((res) => gates.push(() => { engine.els[engine.st.loan].paused = false; res(true); }));
  };
  const p1 = B.previewItem({ name: 'one' });
  const p2 = B.previewItem({ name: 'two' });
  for (let i = 0; i < 20 && gates.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(gates.length, 2, 'both loads started on the one lent deck');
  gates[0](); gates[1]();
  assert.deepEqual([await p1, await p2], [false, true]);
  assert.equal(toastText().length, 0, `no toast: ${toastText().join(' | ')}`);
  assert.equal(B.previewState().item.name, 'two');
  assert.equal(engine.st.loan, 'B');
  B.stopPreview();
  await B.releaseCue('nobody');
  assert.equal(engine.released, 1, 'the deck the first tap lent was given back by the second');
  assert.equal(B.cueStatus().active, false);
});

test('preview refused by a recommendation says so, not "during a transition"', async () => {
  B.setCueSettings({ mode: 'split' });
  engine.st.blocked = 'rec';
  assert.equal(await B.previewItem({ name: 'x' }), false);
  await B.releaseCue('nobody');
  assert.ok(toastText().some((t) => /recommendation/i.test(t)), toastText().join(' | '));
  assert.ok(!toastText().some((t) => /transition/i.test(t)));
  assert.equal(B.cueStatus().active, false, 'the route taken for the preview was given back');
});
