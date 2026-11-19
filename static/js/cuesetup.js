// cuesetup.js — the headphone cue settings dialog (dj-pult).
//
// Offers only the output modes this device really has (cueSupport().modes): a phone,
// the Android app and Safari see split cue and Off, nothing that cannot work.
// Volume and mix apply live while the dialog is open (so they can be set by ear) and
// Cancel puts them back; mode and device are applied on Save.
// The dialog is a layer like every other: it sits on store.dialogStack, Back and
// Escape close it, and the Promise resolves on every close path exactly once.

import { store } from './store.js';
import { historyBack, esc, escAttr } from './utils.js';
import {
  cueSupport, cueSettings, setCueSettings, listOutputs, cueGraph, isBluetoothLabel,
} from './cuebus.js';
import { isExplicitDevice, sameAsMainOutput } from './cuemath.js';

const MODE_TEXT = {
  devices: ['Separate output', 'Headphones on a second audio device; the main output keeps playing.'],
  multichannel: ['Multichannel sound card (experimental)', 'Master on outputs 1–2, cue on 3–4. Check it on your interface first.'],
  split: ['Split cue', 'Left ear master, right ear cue (both mono). Works with one output.'],
  off: ['Off', 'No headphone cue.'],
};

const BT_SENTENCE = 'Bluetooth adds 100–300 ms of delay: fine for choosing tracks, not for beatmatching by ear.';

let _open = null;

export function openCueSetup() {
  if (_open) return _open.promise;
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  _open = { promise };
  _build(resolveFn).catch((e) => { console.error('cue setup', e); });
  return promise;
}

async function _build(resolve) {
  const opening = document.activeElement;
  const orig = cueSettings();
  // The context has to exist to know the channel count; this runs from the opening tap.
  let graph = null;
  try { graph = await cueGraph(); } catch {}
  const mainSink = graph && graph.ctx && typeof graph.ctx.sinkId === 'string' ? graph.ctx.sinkId : '';
  const sup = cueSupport();
  const modes = sup.modes.length ? [...sup.modes, 'off'] : [];

  const ov = document.createElement('div');
  ov.className = 'cuesetup-ov';
  ov.innerHTML = `
    <div class="cuesetup" role="dialog" aria-modal="true" aria-labelledby="cuesetupTitle">
      <div class="cuesetup-head">
        <div class="cuesetup-title" id="cuesetupTitle">Headphone cue</div>
        <button type="button" class="cuesetup-x" data-r="x" aria-label="Close">&times;</button>
      </div>
      <div class="cuesetup-body" data-r="body"></div>
      <div class="cuesetup-foot">
        <button type="button" class="cuesetup-btn" data-r="cancel">Cancel</button>
        <button type="button" class="cuesetup-btn cuesetup-primary" data-r="save">Save</button>
      </div>
    </div>`;
  const R = {};
  ov.querySelectorAll('[data-r]').forEach((el) => { R[el.dataset.r] = el; });

  let closed = false;
  const close = (saved, fromPopstate) => {
    if (closed) return;
    const stack = store.dialogStack || [];
    const i = stack.lastIndexOf(entry);
    if (i === -1) return;
    closed = true;
    stack.splice(i, 1);
    if (!fromPopstate) historyBack();
    document.removeEventListener('keydown', onKey, true);
    if (!saved) setCueSettings({ volume: orig.volume, mix: orig.mix });   // live edits undone
    ov.remove();
    _open = null;
    if (opening && opening.isConnected) { try { opening.focus(); } catch {} }
    resolve(!!saved);
  };
  const entry = { kind: 'cuesetup', cancel: (fromPopstate) => close(false, fromPopstate) };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const stack = store.dialogStack || [];
    if (stack[stack.length - 1] !== entry) return;     // Escape belongs to the dialog on top
    e.preventDefault(); e.stopPropagation();
    close(false);
  };

  if (!sup.engineDj || sup.blocked) {
    R.body.innerHTML = `<p class="cuesetup-note">${
      !sup.engineDj ? 'Headphone cue works with the DJ player only. Turn it on in Settings → Player Engine → DJ Player.'
        : 'Headphone cue is not available while casting or controlling another device.'}</p>`;
    R.save.hidden = true;
    R.cancel.textContent = 'Close';
  } else {
    const cur = modes.includes(orig.mode) ? orig.mode : (orig.mode === 'off' ? 'off' : modes[0]);
    R.body.innerHTML = `
      <fieldset class="cuesetup-modes">
        <legend class="cuesetup-label">Output</legend>
        ${modes.map((m) => `
          <label class="cuesetup-mode">
            <input type="radio" name="cuesetupMode" value="${m}" ${m === cur ? 'checked' : ''}>
            <span><b>${MODE_TEXT[m][0]}</b><small>${MODE_TEXT[m][1]}</small></span>
          </label>`).join('')}
      </fieldset>
      <div class="cuesetup-dev" data-r="dev">
        <label class="cuesetup-label" for="cuesetupDevice">Headphone output</label>
        <select id="cuesetupDevice" data-r="device"></select>
        <button type="button" class="cuesetup-link" data-r="names" hidden>Show device names</button>
        <p class="cuesetup-err" data-r="err" role="alert" hidden></p>
        <p class="cuesetup-bt" data-r="bt" hidden>${BT_SENTENCE}</p>
      </div>
      <label class="cuesetup-label" for="cuesetupVol">Cue volume</label>
      <input type="range" id="cuesetupVol" data-r="vol" min="0" max="100" value="${Math.round(orig.volume * 100)}">
      <label class="cuesetup-label" for="cuesetupMix">Mix in headphones</label>
      <div class="cuesetup-mixrow"><span>Cue</span>
        <input type="range" id="cuesetupMix" data-r="mix" min="0" max="100" value="${Math.round(orig.mix * 100)}">
        <span>Master</span></div>`;
    ov.querySelectorAll('[data-r]').forEach((el) => { R[el.dataset.r] = el; });

    // No "System default" entry: a cue route to the default output is a pre-listen on
    // the main speakers. The headphones have to be named — which, while the browser
    // hides device names, takes the "Show device names" permission step first.
    let outputs = [];
    const fillDevices = () => {
      const want = R.device.value || orig.deviceId;
      const opts = outputs.filter((d) => isExplicitDevice(d.deviceId));
      const named = opts.some((d) => d.label);
      if (isExplicitDevice(orig.deviceId) && !opts.some((d) => d.deviceId === orig.deviceId)) {
        opts.push({ deviceId: orig.deviceId, label: `${orig.deviceLabel || 'Saved device'} (not connected)` });
      }
      const head = `<option value="" disabled>${named ? 'Choose the headphone output' : 'Show the device names first'}</option>`;
      R.device.innerHTML = head + opts.map((d, i) =>
        `<option value="${escAttr(d.deviceId)}">${esc(d.label || `Output ${i + 1}`)}</option>`).join('');
      R.device.value = opts.some((d) => d.deviceId === want) ? want : '';
      R.names.hidden = named;
      syncBt();
    };
    const showErr = (msg) => { R.err.textContent = msg || ''; R.err.hidden = !msg; };
    const selectedLabel = () => {
      const o = R.device.selectedOptions && R.device.selectedOptions[0];
      return o ? o.textContent : '';
    };
    const syncBt = () => { R.bt.hidden = !isBluetoothLabel(selectedLabel()); };
    const mode = () => (ov.querySelector('input[name="cuesetupMode"]:checked') || {}).value || 'off';
    const syncMode = () => { R.dev.hidden = mode() !== 'devices'; showErr(''); };

    R.device.addEventListener('change', () => { showErr(''); syncBt(); });
    ov.querySelectorAll('input[name="cuesetupMode"]').forEach((r) => r.addEventListener('change', syncMode));
    R.names.addEventListener('click', async () => {
      R.names.disabled = true;
      outputs = await listOutputs({ ask: true });     // from this tap: permission prompt allowed
      R.names.disabled = false;
      fillDevices();
    });
    R.vol.addEventListener('input', () => setCueSettings({ volume: R.vol.value / 100 }));
    R.mix.addEventListener('input', () => setCueSettings({ mix: R.mix.value / 100 }));
    R.save.addEventListener('click', () => {
      const m = mode();
      const patch = { mode: m, volume: R.vol.value / 100, mix: R.mix.value / 100 };
      if (m === 'devices') {
        const id = R.device.value;
        if (!isExplicitDevice(id)) {
          showErr(R.names.hidden ? 'Choose the headphone output first.'
            : 'Tap “Show device names”, then choose your headphones.');
          (R.names.hidden ? R.device : R.names).focus();
          return;
        }
        if (sameAsMainOutput(id, mainSink, outputs)) {
          showErr('That is the output the music plays on — the pre-listen would be heard on the speakers. Choose another device.');
          R.device.focus();
          return;
        }
        patch.deviceId = id;
        patch.deviceLabel = selectedLabel();
      }
      setCueSettings(patch);
      close(true);
    });
    syncMode();
    fillDevices();
    listOutputs().then((l) => { if (!closed) { outputs = l; fillDevices(); } }).catch(() => {});
  }

  R.x.addEventListener('click', () => close(false));
  R.cancel.addEventListener('click', () => close(false));
  ov.addEventListener('click', (e) => { if (e.target === ov) close(false); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
  (store.dialogStack || (store.dialogStack = [])).push(entry);
  history.pushState({ layer: 'dialog' }, '');
  try { R.x.focus(); } catch {}   // keyboard users land inside the dialog
}

export function init() {}
