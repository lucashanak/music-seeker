// androidbridge.js — the page's only door to the native Android shell.
//
// `window.AndroidBridge` is injected by the Android app (a WebView wrapper around this
// same page). In a browser it does not exist and every call here is a no-op.
//
// onPause() is not just a notification update: AudioService releases its
// PARTIAL_WAKE_LOCK on it and schedules the foreground service to stop. That makes a
// pause report far more consequential than it looks, because a TRACK CHANGE pauses the
// media element too — assigning .src runs the element's load algorithm, which pauses a
// playing element and fires 'pause'. Reporting that verbatim dropped the CPU lock in
// the exact window where the page still has work to do (swap the source, call play()),
// so a phone with the screen off could suspend between two tracks and only resume when
// the user woke it. The DJ engine's crossfade pauses the outgoing deck mid-transition
// and hit the same thing.
//
// So a pause is reported only once it has outlived the gap a transition needs; anything
// that starts playing again cancels it. A real pause reaches the notification a moment
// late, which costs nothing — the music stopping does.
const PAUSE_GRACE_MS = 2500;
let _pauseTimer = null;

function _cancelPendingPause() {
  if (_pauseTimer) { clearTimeout(_pauseTimer); _pauseTimer = null; }
}

export function ab() { return window.AndroidBridge || null; }

export function abPlay(title, artist) {
  _cancelPendingPause();
  const b = ab();
  if (!b) return;
  try { b.onPlay(title || '', artist || ''); } catch {}
}

export function abPause() {
  if (!ab()) return;
  _cancelPendingPause();
  _pauseTimer = setTimeout(() => {
    _pauseTimer = null;
    const b = ab();
    if (!b) return;
    try { b.onPause(); } catch {}
  }, PAUSE_GRACE_MS);
}

// Stop is deliberate and final — report it at once, and drop any pause still waiting.
export function abStop() {
  _cancelPendingPause();
  const b = ab();
  if (!b) return;
  try { b.onStop(); } catch {}
}

// Exposed for tests only.
export const _internals = { PAUSE_GRACE_MS, pending: () => _pauseTimer !== null };
