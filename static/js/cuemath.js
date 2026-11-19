// cuemath.js — the pure half of the headphone cue (dj-pult). No DOM, no Web Audio:
// everything here takes plain values and is tested in tests/js/cue_routing.test.mjs.
//
// The cue bus itself lives in cuebus.js. What it needs to decide — which output modes a
// device can offer, how a mode re-routes the master, how loud each tap into the
// headphones is — is decided here, so the decisions can be checked without a browser.

export const CUE_MODES = ['devices', 'multichannel', 'split'];

// Below this the master volume is treated as this value when compensating: dividing by
// a volume near 0 would turn the headphone taps into a x1000 amplifier of noise.
export const VOLUME_FLOOR = 0.05;
export const MAX_COMPENSATION = 1 / VOLUME_FLOOR;

const DEFAULTS = Object.freeze({
  mode: 'off', deviceId: '', deviceLabel: '', volume: 0.8, mix: 0, pfl: { A: false, B: false },
});

const clamp01 = (v, dflt) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
};

/** Settings as cuebus keeps them, whatever was stored or patched in. */
export function normalizeCueSettings(raw = {}) {
  const r = raw || {};
  const mode = r.mode === 'off' || CUE_MODES.includes(r.mode) ? r.mode : DEFAULTS.mode;
  const pfl = r.pfl && typeof r.pfl === 'object' ? r.pfl : {};
  return {
    mode,
    deviceId: typeof r.deviceId === 'string' ? r.deviceId : '',
    deviceLabel: typeof r.deviceLabel === 'string' ? r.deviceLabel : '',
    volume: clamp01(r.volume, DEFAULTS.volume),
    mix: clamp01(r.mix, DEFAULTS.mix),
    pfl: { A: pfl.A === true, B: pfl.B === true },
  };
}

// localStorage keys. PFL is stored as the letters of the decks that have it on ("AB").
export const STORAGE_KEYS = Object.freeze({
  mode: 'ms_cue_mode', deviceId: 'ms_cue_device', deviceLabel: 'ms_cue_device_label',
  volume: 'ms_cue_volume', mix: 'ms_cue_mix', pfl: 'ms_cue_pfl',
});

/** Read settings through a getItem(key) → string|null function. */
export function readCueSettings(getItem) {
  const raw = {};
  for (const [field, key] of Object.entries(STORAGE_KEYS)) {
    let v = null;
    try { v = getItem(key); } catch { v = null; }
    if (v == null) continue;
    raw[field] = field === 'pfl' ? { A: v.includes('A'), B: v.includes('B') } : v;
  }
  return normalizeCueSettings(raw);
}

/** The [key, value] pairs that store normalised settings. */
export function cueSettingsEntries(settings) {
  const s = normalizeCueSettings(settings);
  return [
    [STORAGE_KEYS.mode, s.mode],
    [STORAGE_KEYS.deviceId, s.deviceId],
    [STORAGE_KEYS.deviceLabel, s.deviceLabel],
    [STORAGE_KEYS.volume, String(s.volume)],
    [STORAGE_KEYS.mix, String(s.mix)],
    [STORAGE_KEYS.pfl, (s.pfl.A ? 'A' : '') + (s.pfl.B ? 'B' : '')],
  ];
}

/**
 * Which output modes this device can really offer. `split` works everywhere Web Audio
 * does. Phones, the Android app's WebView and WebKit get ONLY split: there is no second
 * output to pick there (setSinkId is missing or the OS routes all audio to one place),
 * and a button that cannot work must not be shown.
 */
export function supportedCueModes(s = {}) {
  if (s.mobile || s.androidApp || s.webkit) return ['split'];
  const modes = [];
  if ((s.devices || s.ctxSink) && s.enumerate !== false) modes.push('devices');
  if (Number(s.maxChannels) >= 4) modes.push('multichannel');
  modes.push('split');
  return modes;
}

/** The mode to build: the stored one if this device offers it, otherwise off. */
export function effectiveCueMode(mode, modes) {
  return mode !== 'off' && Array.isArray(modes) && modes.includes(mode) ? mode : 'off';
}

/**
 * A device id that names ONE output. '' and 'default' (and Chromium's 'communications')
 * follow the system default — on most machines exactly the speakers the master already
 * plays on, so a pre-listen routed there is heard on the dance floor.
 */
export function isExplicitDevice(id) {
  return typeof id === 'string' && id !== '' && id !== 'default' && id !== 'communications';
}

/**
 * The mode the cue can really be built in — THE one test of "is the cue set up", shared
 * by cuebus (build), cuemini (entry points) and the desk. effectiveCueMode, and
 * 'devices' only with an explicit device: a devices route to the system default would
 * play the pre-listen on the main speakers.
 */
export function configuredCueMode(settings, modes) {
  const s = settings || {};
  const mode = effectiveCueMode(s.mode, modes);
  if (mode === 'devices' && !isExplicitDevice(s.deviceId)) return 'off';
  return mode;
}

/**
 * Is `deviceId` the output the master plays on — or can we not rule it out? true =
 * refuse. `mainSinkId` is the engine context's sinkId ('' = it follows the system
 * default). Chromium lists the default as id 'default', in the same group (groupId) as
 * the real device and labelled "Default - <its label>"; either links the two ids.
 *
 * When in doubt this answers TRUE (refuse): a wrong refusal costs one tap on "Show
 * device names" (which gives labels and lifts the doubt), a wrong acceptance plays the
 * pre-listen on the dance floor. "In doubt" = the list is empty or unlabelled, so the
 * default cannot be told apart from the chosen id. A labelled list that names no
 * default at all (Firefox lists no 'default' alias) and a device absent from a
 * labelled list (unplugged: opening it fails on its own) are not doubt. A labelled
 * default that matches neither by group nor by label (Linux's bare "Default" with
 * distinct groups) is taken as another device.
 */
export function sameAsMainOutput(deviceId, mainSinkId, outputs) {
  if (!isExplicitDevice(deviceId)) return true;
  if (isExplicitDevice(mainSinkId)) return deviceId === mainSinkId;
  const list = (Array.isArray(outputs) ? outputs : []).filter((o) => o && o.deviceId);
  if (!list.length || !list.some((o) => o.label)) return true;            // cannot tell
  const def = list.find((o) => o.deviceId === 'default');
  const mine = list.find((o) => o.deviceId === deviceId);
  if (!def || !mine) return false;
  if (def.groupId && mine.groupId && def.groupId === mine.groupId) return true;
  if (!def.label || !mine.label) return true;                              // cannot tell
  return def.label === mine.label || def.label.endsWith(' - ' + mine.label);
}

/**
 * How each mode is wired. `touchesMaster` = the master leaves ctx.destination while the
 * route lives (and must be put back exactly as it was). Channel indices are merger inputs.
 * null = the mode cannot be built here.
 */
export function routingPlan(mode, { maxChannels = null } = {}) {
  if (mode === 'devices') return { mode, touchesMaster: false, output: 'stream' };
  if (mode === 'multichannel') {
    if (!(Number(maxChannels) >= 4)) return null;
    return { mode, touchesMaster: true, output: 'destination', channelCount: 4,
             map: { masterL: 0, masterR: 1, cueL: 2, cueR: 3 } };
  }
  if (mode === 'split') {
    return { mode, touchesMaster: true, output: 'destination', channelCount: 2,
             map: { masterMono: 0, cueMono: 1 } };
  }
  return null;
}

/** 1 / volume, floored and capped: undoes what a fader did to a signal tapped after it. */
export function compensationGain(volume) {
  const v = Number(volume);
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_COMPENSATION, 1 / Math.max(VOLUME_FLOOR, Math.min(1, v)));
}

/** Equal-power cue/master mix. mix 0 = cue only, 1 = master only. */
export function mixGains(mix) {
  const m = clamp01(mix, 0);
  return { cue: Math.cos(m * Math.PI / 2), master: Math.sin(m * Math.PI / 2) };
}

/**
 * Gains of the three taps into the cue sum.
 *  - master tap: the decks' crossfade gains BEFORE the limiter (their sum is what the
 *    limiter gets). They are after the element volume of the playing deck, so the
 *    master fader would move the headphones too — compensated by the master volume.
 *    Tapping after the limiter made that compensation wrong: at full volume the limiter
 *    takes peaks down, at 0.3 it does nothing, so 1/volume over-corrected.
 *  - deck taps (PFL): a deck's element carries its own volume (the LIVE deck carries the
 *    master volume, the lent deck 1), so each is compensated by its own element volume.
 * The cue volume is applied after the sum, not here.
 */
export function cueTapGains({ mix = 0, pfl = {}, elVolume = {}, masterVolume = 1 } = {}) {
  const g = mixGains(mix);
  const deck = (k) => (pfl[k] ? g.cue * compensationGain(elVolume[k] ?? 1) : 0);
  return { master: g.master * compensationGain(masterVolume), A: deck('A'), B: deck('B') };
}

/**
 * Does the output label look like Bluetooth? Then the setup dialog says once that it
 * lags 100–300 ms. "Headset"/"Hands-Free" are how Windows and Linux name the Bluetooth
 * HFP profile; a wired USB "headset" is a false positive we accept (the sentence is
 * advice, it blocks nothing).
 */
export function isBluetoothLabel(label) {
  if (!label || typeof label !== 'string') return false;
  return /bluetooth|airpods|buds|headset|hands[\s-]?free|\bbt\b|a2dp|\bhfp\b|bluez/i.test(label);
}

/** Root mean square of a sample block (meters). */
export function rms(samples) {
  if (!samples || !samples.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

/**
 * Is the device a route plays to still connected? A device id we cannot see because
 * labels/ids are hidden (empty ids) is not evidence that it is gone. No explicit device
 * ('' / 'default') is never "present": a cue route is never built to one.
 */
export function sinkStillPresent(deviceId, outputs) {
  if (!isExplicitDevice(deviceId)) return false;
  if (!Array.isArray(outputs)) return true;
  const ids = outputs.map((o) => o && o.deviceId).filter(Boolean);
  if (!ids.length) return true;
  return ids.includes(deviceId);
}
