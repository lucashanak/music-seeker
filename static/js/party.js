// party.js — Continuous "party" song recognition.
//
// Turn it on at a party: it keeps the mic open and recognises the room every
// ~20s, collecting each unique match into a live, curated list (nothing is
// downloaded while it runs). When you stop, you tick the keepers and they are
// downloaded into an auto-created "Party <date>" playlist. Session is persisted
// to localStorage so an accidental reload / screen-off doesn't lose the finds.

import { $, showToast, escAttr } from './utils.js';
import { apiFetch, apiJson } from './api.js';

const SESSION_KEY = 'ms_party_session';
// 12s per clip: the server fingerprints up to _SEGMENT_SECONDS (12) of what it
// receives, so a 10s clip left 2s of that window unused. Matches the single-shot
// recorder in recognize.js. Measured: the extra audio recovered 2 of 16 tracks
// that a 10s fingerprint missed.
const CLIP_MS = 12000;
const GAP_MS = 5000;    // pause between attempts (one recognise per ~19-22s)

let active = false;
let starting = false;    // synchronous guard: getUserMedia is async, so a double-tap must not open two streams
let stream = null;
let session = [];        // [{name, artist, album, image, recognized_by, ts, keep}]
let seen = new Set();    // dedupe keys
let overlay = null;
let inFlight = null;      // AbortController for the current /api/recognize
let wakeLock = null;

const _key = (t) => `${(t.artist || '').toLowerCase().trim()}|${(t.name || '').toLowerCase().trim()}`;
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Android wrapper's JS bridge, when running inside the native app and the
// build is new enough to know about party sessions. In a plain browser this is
// null and every native path below falls back to the screen-wake-lock behaviour.
function _bridge() {
  try {
    const b = window.AndroidBridge;
    return (b && typeof b.onPartyStart === 'function') ? b : null;
  } catch { return null; }
}

function loadSession() {
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || '[]'); }
  catch { session = []; }
  if (!Array.isArray(session)) session = [];
  seen = new Set(session.map(_key));
}
function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}

// Music-appropriate capture (no speech DSP), progressive fallback — mirrors recognize.js.
async function requestMicStream() {
  const attempts = [
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } },
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    { audio: true },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch (e) { lastErr = e; if (e.name !== 'OverconstrainedError' && e.name !== 'TypeError') throw e; }
  }
  throw lastErr;
}

// Record one short clip off the persistent stream → { blob, ext } | null.
function recordClip() {
  return new Promise((resolve) => {
    if (!stream || typeof MediaRecorder === 'undefined') { resolve(null); return; }
    let mime = '';
    for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg']) {
      if (MediaRecorder.isTypeSupported(type)) { mime = type; break; }
    }
    let rec;
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch { resolve(null); return; }
    const chunks = [];
    let done = false;
    let fired = 0;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    rec.ondataavailable = (e) => {
      fired++;
      if (e.data && e.data.size > 0) chunks.push(e.data);
      // Clip length comes from the recorder's timeslice, not a setTimeout. To be precise
      // about why, since the two are easy to confuse: what actually keeps this loop alive
      // with the screen off is MainActivity.onPause() calling resumeTimers() while a party
      // runs — without it nothing here runs, timeslice included. This is belt-and-braces on
      // top of that, because resumeTimers() is a best-effort override of Chromium throttling
      // rather than a guarantee, and a stretched clip does not merely arrive late, it changes
      // what gets fingerprinted. The gap between clips (_sleep) is still a plain timer, which
      // is fine: a late gap only slows the cadence. Real screen-off cadence is unmeasured.
      //
      // Gated on the FIRE, not chunks.length: an empty first chunk would otherwise leave
      // chunks[] empty, skip the stop and run on to the next timeslice — a silent ~24s clip,
      // of which the server reads only the first 12s anyway. Worst case here is one skipped
      // round, which the loop retries. A throwing stop() must not finish(null): that sets
      // done and would deny onstop the chunks already in hand. Let the backstops decide.
      if (!done && fired === 1) {
        try { if (rec.state === 'recording') rec.stop(); } catch {}
      }
    };
    rec.onstop = () => finish(chunks.length
      ? { blob: new Blob(chunks, { type: mime || 'audio/webm' }), ext: mime.includes('ogg') ? 'clip.ogg' : 'clip.webm' }
      : null);
    rec.onerror = () => finish(null);
    try { rec.start(CLIP_MS); } catch { finish(null); return; }
    // Backstops only, for a recorder that emits no timeslice chunk at all. These are
    // the throttled timers, so with the screen off they fire late rather than never —
    // harmless, because the path above has normally already resolved the Promise.
    setTimeout(() => {
      try {
        if (rec.state === 'recording') rec.stop();
        else finish(null);
      } catch { finish(null); }
    }, CLIP_MS + 2000);
    setTimeout(() => {
      // Stop before resolving. Resolving alone would leave a wedged recorder running on
      // the shared stream while loop() builds the next one, and they would pile up over
      // a long party.
      try { if (rec.state === 'recording') rec.stop(); } catch {}
      finish(null);
    }, CLIP_MS + 5000);
  });
}

async function recognizeClip(clip) {
  const form = new FormData();
  form.append('audio', clip.blob, clip.ext);
  inFlight = new AbortController();
  const to = setTimeout(() => { try { inFlight.abort(); } catch {} }, 30000);
  try {
    const res = await apiFetch('/api/recognize', { method: 'POST', body: form, signal: inFlight.signal });
    clearTimeout(to);
    if (!res.ok) return null; // 404 no-match / 422 too-quiet / 503 — just skip this round
    const data = await res.json().catch(() => null);
    return (data && data.name) ? data : null;
  } catch { clearTimeout(to); return null; }
  finally { inFlight = null; }
}

function setStatus(text, listening) {
  const s = $('#partyStatus');
  if (s) s.textContent = text;
  const dot = $('#partyDot');
  if (dot) dot.classList.toggle('on', !!listening);
  const btn = $('#partyToggle');
  if (btn) {
    btn.textContent = active ? 'Stop' : (session.length ? 'Resume' : 'Start listening');
    btn.classList.toggle('active', active);
  }
  const cnt = $('#partyCount');
  if (cnt) cnt.textContent = session.length ? `${session.length} found` : '';
}

async function loop() {
  while (active) {
    setStatus('Listening…', true);
    const clip = await recordClip();
    if (!active) break;
    if (clip) {
      setStatus('Identifying…', true);
      const match = await recognizeClip(clip);
      if (!active) break;
      if (match) {
        const k = _key(match);
        if (!seen.has(k)) {
          seen.add(k);
          session.push({
            name: match.name, artist: match.artist || '', album: match.album || '',
            image: match.image || '', recognized_by: match.recognized_by || 'Shazam',
            ts: Date.now(), keep: true,
          });
          saveSession();
          renderList();
          setStatus(`Found: ${match.artist || ''} — ${match.name}`, true);
        }
      }
    }
    if (!active) break;
    await _sleep(GAP_MS);
  }
}

async function startParty() {
  if (active || starting) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Microphone needs HTTPS.'); return;
  }
  starting = true; // claim synchronously before the async getUserMedia so a double-tap can't open two streams
  setStatus('Requesting microphone…');
  // ORDER MATTERS: the mic must be acquired BEFORE the native party service starts.
  // Android 14+ throws SecurityException if a `microphone`-type foreground service is
  // started by a process that does not yet hold RECORD_AUDIO, and in the app that
  // permission is prompted for by wry's onPermissionRequest on this very call. Starting
  // the service first would therefore crash on a first run. Do not reorder these.
  try { stream = await requestMicStream(); }
  catch (e) { starting = false; setStatus('Mic error: ' + (e.message || e.name)); return; }
  active = true;
  starting = false;
  const nb = _bridge();
  if (nb) {
    // Native app: AudioService goes foreground with the `microphone` type (which is
    // what lets Android 14+ keep feeding mic audio to a backgrounded process at all)
    // and holds a PARTIAL_WAKE_LOCK, while MainActivity.onPause() keeps the WebView's
    // timers alive. Asking for a *screen* wake lock here would defeat the purpose —
    // the whole point is that the phone can sit in a pocket with the display off.
    try { nb.onPartyStart(); } catch {}
  } else {
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  renderList();
  setStatus('Listening…', true);
  loop();
}

function stopStream() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
}

// A screen wake lock is dropped whenever the page is hidden and is NOT restored on
// return, so in a browser one accidental screen-off used to leave the rest of the
// session unprotected. Re-take it when we come back. Native sessions never hold one.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !active || _bridge() || wakeLock) return;
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then((l) => { if (active) wakeLock = l; else l.release(); })
    .catch(() => {});
});

// Invoked from the "Stop" action on the native party notification. Routing it through
// the normal stop path means the bridge, the stream and the UI all unwind the same way
// they do when the button in the overlay is pressed.
window._partyStopFromNative = () => {
  if (active) { stopParty(); return; }
  // The service thinks a session is running but this page does not — it reloaded, or
  // it is a different page than the one that started it. Answer anyway, or the service
  // would sit there foreground with a wake lock behind a Stop button that does nothing.
  try { const b = _bridge(); if (b) b.onPartyStop(); } catch {}
};

function stopParty() {
  active = false;
  starting = false;
  if (inFlight) { try { inFlight.abort(); } catch {} }
  stopStream();
  const nb = _bridge();
  if (nb) { try { nb.onPartyStop(); } catch {} }
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  setStatus(session.length ? 'Stopped — review your finds below.' : 'Stopped.');
  renderList();
}

function renderList() {
  const list = $('#partyList');
  if (!list) return;
  if (!session.length) {
    list.innerHTML = `<div class="party-empty">Nothing yet. Start listening near the music.</div>`;
    return;
  }
  list.innerHTML = session.map((t, i) => `
    <label class="party-item">
      <input type="checkbox" data-i="${i}" ${t.keep ? 'checked' : ''}>
      ${t.image ? `<img src="${escAttr(t.image)}" alt="">` : `<div class="party-noart">&#9835;</div>`}
      <div class="party-meta">
        <div class="party-title">${_esc(t.name)}</div>
        <div class="party-artist">${_esc(t.artist)}</div>
      </div>
      <span class="party-src">${_esc(t.recognized_by)}</span>
    </label>`).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const i = parseInt(cb.dataset.i);
      if (session[i]) { session[i].keep = cb.checked; saveSession(); updateSaveBtn(); }
    });
  });
  updateSaveBtn();
}

function updateSaveBtn() {
  const n = session.filter((t) => t.keep).length;
  const btn = $('#partySave');
  if (btn) { btn.disabled = n === 0; btn.textContent = n ? `Save ${n} to playlist` : 'Save to playlist'; }
}

function _esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : s;
  return d.innerHTML;
}

async function saveKeepers() {
  const keepers = session.filter((t) => t.keep);
  if (!keepers.length) return;
  const btn = $('#partySave');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const d = new Date();
  const name = `Party ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    const created = await apiJson('/api/library/playlist', { method: 'POST', body: { name } });
    let plId = created && created.id;
    if (!plId) {
      const data = await apiJson('/api/library/playlists');
      const pl = (data.playlists || []).find((p) => p.name === name);
      plId = pl && pl.id;
    }
    if (!plId) throw new Error('Could not create playlist');
    const resp = await apiJson(`/api/library/playlist/${plId}/add-and-download-batch`, {
      method: 'POST',
      body: { tracks: keepers.map((t) => ({ name: t.name, artist: t.artist, album: t.album })) },
    });
    const parts = [];
    if (resp.added) parts.push(`${resp.added} added`);
    if (resp.queued) parts.push(`${resp.queued} downloading`);
    showToast(`${parts.join(', ') || 'Saved'} → ${name}`);
    // Clear the session now that the keepers are on their way to the playlist.
    session = []; seen = new Set(); saveSession();
    renderList(); setStatus('Saved. Ready for the next session.');
  } catch (e) {
    showToast('Save failed: ' + (e.message || ''), true);
    if (btn) { btn.disabled = false; }
    updateSaveBtn();
  }
}

function clearSession() {
  session = []; seen = new Set(); saveSession();
  renderList(); setStatus('Cleared.');
}

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'partyOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
  overlay.innerHTML = `
    <div class="party-modal" style="background:var(--bg-card);border-radius:18px;width:min(460px,94vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 18px 56px rgba(0,0,0,.55);overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border);">
        <span id="partyDot" class="party-dot"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:700;">Party recognition</div>
          <div id="partyStatus" style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Idle</div>
        </div>
        <span id="partyCount" style="font-size:12px;color:var(--accent);font-weight:600;"></span>
        <button id="partyClose" style="background:none;border:none;color:var(--text-muted);font-size:22px;cursor:pointer;line-height:1;">&times;</button>
      </div>
      <button id="partyToggle" style="margin:14px 18px 6px;padding:12px;border:none;border-radius:12px;background:var(--accent);color:#000;font-size:14px;font-weight:700;cursor:pointer;">Start listening</button>
      <div id="partyHint" style="font-size:11px;color:var(--text-muted);padding:0 18px 8px;"></div>
      <div id="partyList" style="flex:1;overflow-y:auto;padding:6px 12px;display:flex;flex-direction:column;gap:4px;"></div>
      <div style="display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--border);">
        <button id="partySave" style="flex:1;padding:11px;border:none;border-radius:11px;background:var(--accent);color:#000;font-size:13px;font-weight:700;cursor:pointer;" disabled>Save to playlist</button>
        <button id="partyClear" style="padding:11px 14px;border:1px solid var(--border);border-radius:11px;background:none;color:var(--text-muted);font-size:13px;cursor:pointer;">Clear</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Scoped styles (dot pulse, list rows). Injected once.
  const st = document.createElement('style');
  st.textContent = `
    #partyOverlay .party-dot{width:11px;height:11px;border-radius:50%;background:var(--border);flex-shrink:0;}
    #partyOverlay .party-dot.on{background:#e0245e;box-shadow:0 0 0 0 rgba(224,36,94,.6);animation:partyPulse 1.4s infinite;}
    @keyframes partyPulse{70%{box-shadow:0 0 0 8px rgba(224,36,94,0);}100%{box-shadow:0 0 0 0 rgba(224,36,94,0);}}
    #partyOverlay #partyToggle.active{background:var(--bg-elevated);color:var(--text);border:1px solid var(--border);}
    #partyOverlay .party-item{display:flex;align-items:center;gap:10px;padding:8px 8px;border-radius:10px;cursor:pointer;}
    #partyOverlay .party-item:hover{background:rgba(255,255,255,.05);}
    #partyOverlay .party-item input{width:18px;height:18px;accent-color:var(--accent);flex-shrink:0;}
    #partyOverlay .party-item img,#partyOverlay .party-noart{width:40px;height:40px;border-radius:7px;object-fit:cover;flex-shrink:0;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:18px;}
    #partyOverlay .party-meta{min-width:0;flex:1;}
    #partyOverlay .party-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #partyOverlay .party-artist{font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    #partyOverlay .party-src{font-size:10px;color:var(--text-muted);opacity:.7;flex-shrink:0;}
    #partyOverlay .party-empty{color:var(--text-muted);font-size:13px;text-align:center;padding:32px 12px;}`;
  document.head.appendChild(st);

  $('#partyToggle').addEventListener('click', () => { active ? stopParty() : startParty(); });
  $('#partySave').addEventListener('click', saveKeepers);
  $('#partyClear').addEventListener('click', clearSession);
  $('#partyClose').addEventListener('click', closeParty);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeParty(); });
}

function openParty() {
  if (!overlay) buildOverlay();
  // Decided on every open, not at build time: the native bridge is injected a few
  // hundred ms after load, so a hint fixed at build time could claim the wrong thing.
  const hint = $('#partyHint');
  if (hint) {
    hint.textContent = _bridge()
      ? 'Keeps listening with the screen off — you can put the phone in your pocket.'
      : 'Keep the screen on and this tab in front — mobile browsers pause the mic in the background.';
  }
  loadSession();
  overlay.style.display = 'flex';
  renderList();
  setStatus(active ? 'Listening…' : (session.length ? 'Review your finds, or resume.' : 'Idle'), active);
}

// Closing the panel does NOT stop an active session (so it keeps listening in
// the background tab if the OS allows) — but on mobile that's unreliable, so we
// leave the choice to the user via the Stop button; here we just hide the UI.
function closeParty() {
  if (overlay) overlay.style.display = 'none';
}

export function init() {
  const btn = $('#partyBtn');
  if (btn) btn.addEventListener('click', openParty);
}
