// recognize.js — Microphone recording, Shazam identification

import { store } from './store.js';
import { $ } from './utils.js';
import { apiFetch } from './api.js';
import { openModal } from './downloads.js';
import { doSearch } from './search.js';

function micLog(msg) {
  $('#micStatus').textContent = msg;
}

// Peak RMS below this (out of a max of 1.0) is treated as "quiet" for the
// level-meter bar and the advisory hint appended to the result text.
// ADVISORY ONLY (never blocking) — this is far stricter than the server's own
// -60dBFS windowed-peak gate, so a client-side veto here would reject uploads
// Shazam could still have matched. See the meterActive gate at the upload
// site: the check is skipped entirely unless the meter actually produced
// real samples, so a failed/suspended AudioContext can never masquerade as
// "silence".
const SILENCE_THRESHOLD = 0.008;

function stopMicStream() {
  if (store.micStream) {
    store.micStream.getTracks().forEach(t => t.stop());
    store.micStream = null;
  }
}

// Tears down the level-meter AudioContext. Chrome caps concurrent contexts at
// ~6 and throws on the next `new AudioContext()` once exceeded, so every
// attempt (success, error, or cancel) must close the one it opened.
function teardownLevelMeter() {
  if (store.micLevelTimer) { clearInterval(store.micLevelTimer); store.micLevelTimer = null; }
  if (store.micAudioCtx) {
    try { store.micAudioCtx.close(); } catch (_) {}
    store.micAudioCtx = null;
  }
  const fill = $('#micLevelFill');
  if (fill) { fill.style.width = '0%'; fill.classList.remove('quiet'); }
  const level = $('#micLevel');
  if (level) level.classList.remove('active');
}

function resetMic() {
  store.micGen++; // invalidate any in-flight request/response tied to this attempt
  store.micState = 'idle';
  stopMicStream();
  teardownLevelMeter();
  if (store.micTimer) { clearInterval(store.micTimer); store.micTimer = null; }
  if (store.micStopTimer) { clearTimeout(store.micStopTimer); store.micStopTimer = null; }
  store.micAbort = null;
  if (store.mediaRecorder && store.mediaRecorder.state !== 'inactive') {
    try { store.mediaRecorder.stop(); } catch (_) {}
  }
  store.mediaRecorder = null;
  $('#micBtn').classList.remove('recording', 'identifying');
  $('#micBtn').title = 'Identify song with microphone';
}

// Requests a music-appropriate capture: no NS/AGC/AEC (they're speech-tuned
// DSP that mangles the sustained content a fingerprint is built from), mono.
// Only ever `ideal` values (the plain booleans/number below) — never
// exact/min/max: an unsupported ideal constraint is silently ignored, but an
// unsatisfiable exact one throws OverconstrainedError, and browsers differ on
// which of these they support. Falls back progressively on that error.
async function requestMicStream() {
  const attempts = [
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } },
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } },
    { audio: true },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
      if (e.name !== 'OverconstrainedError' && e.name !== 'TypeError') throw e;
      // else: this constraint shape isn't supported — retry with the next, looser one
    }
  }
  throw lastErr;
}

// The backend now classifies recognize failures instead of a flat 404;
// prefer its `detail` message (already tuned per status) and only fall back
// to a generic explanation if it's missing.
function classifyRecognizeError(status, detail) {
  if (detail) return detail;
  if (status === 404) return "No match. Shazam mostly knows commercially released recordings — covers, live versions and instrumentals often aren't in it.";
  if (status === 503) return 'Recognizer unavailable or timed out on the server. Try again in a moment.';
  if (status === 422) return 'No usable audio captured (silence or too short). Try again closer to the source.';
  return 'Not recognized.';
}

export function showRecognizeResult(data) {
  $('#rrLabel').textContent = (data.recognized_by || 'Shazam') + ' identified';
  store.recognizedItem = data;
  $('#rrImg').src = data.image || '';
  $('#rrTitle').textContent = data.name || 'Unknown';
  $('#rrArtist').textContent = data.artist || '';
  $('#recognizeResult').style.display = '';
  $('#searchInput').value = `${data.artist || ''} ${data.name || ''}`.trim();
  doSearch();
  $('#recognizeResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Init ──
export function init() {
  $('#micBtn').addEventListener('click', async () => {
    if (store.micState === 'recording') {
      // Manual stop: clear the pending 12s auto-stop timer too. Previously
      // this timer was left running (only guarded by micState === 'recording'),
      // so stopping early and retrying let the OLD attempt's timer fire into
      // the NEW attempt a few seconds in, truncating it right when the user
      // was trying to record a longer/better clip.
      if (store.micStopTimer) { clearTimeout(store.micStopTimer); store.micStopTimer = null; }
      if (store.micTimer) { clearInterval(store.micTimer); store.micTimer = null; }
      if (store.mediaRecorder && store.mediaRecorder.state === 'recording') store.mediaRecorder.stop();
      return;
    }
    if (store.micState === 'identifying') {
      if (store.micAbort) store.micAbort.abort();
      resetMic();
      micLog('Cancelled');
      return;
    }
    if (store.micState === 'starting') {
      // getUserMedia permission prompt already in flight — ignore repeat taps.
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micLog('Error: Microphone requires HTTPS');
      return;
    }

    // Claim the state synchronously, before any await, so a double-tap can't
    // re-enter this handler while getUserMedia is pending (which previously
    // stopped attempt #1's stream, leaked its setInterval, and overwrote
    // store.mediaRecorder with attempt #2's).
    store.micState = 'starting';
    const myGen = store.micGen;

    stopMicStream();
    micLog('Requesting microphone...');

    let stream;
    // Registered on the raw promise (before it's handed to Promise.race)
    // so this reaction runs first if/when it resolves. If by then the race
    // was already lost (timeout fired, or a newer attempt/cancel moved
    // micState/micGen on), the stream returned by a stale getUserMedia call
    // would otherwise never be stopped — the browser's mic-in-use indicator
    // stays lit until reload (Fix 6). The ladder can chain up to three
    // getUserMedia calls, making a late resolution more likely.
    const acquisition = requestMicStream();
    acquisition.then(s => {
      if (store.micState !== 'starting' || myGen !== store.micGen) {
        s.getTracks().forEach(t => t.stop());
      }
    }).catch(() => {}); // real failure is handled via the race below
    try {
      stream = await Promise.race([
        acquisition,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          'Mic timed out (30s). Firefox: tap lock icon in URL bar → Clear site data, then reload and try again.'
        )), 30000)),
      ]);
    } catch (e) {
      resetMic();
      micLog('Mic error: ' + e.message);
      return;
    }

    store.micStream = stream;
    const chunks = [];

    if (typeof MediaRecorder === 'undefined') {
      resetMic();
      micLog('Mic error: recording is not supported on this browser.');
      return;
    }

    // Log what the browser actually granted — whether these constraints are
    // honoured (especially in the Android WebView this app ships as) is
    // unverified, so surface it instead of assuming. (No user-facing DSP
    // warning here: Chrome on Android commonly reports echoCancellation:
    // true from getSettings() regardless of the requested constraint, and
    // Shazam has measured out as robust to it anyway.)
    const track = stream.getAudioTracks()[0];
    console.info('[mic] track settings', track ? track.getSettings() : {});
    micLog('Mic active. Recording...');

    // Everything below can throw (MediaRecorder constructor rejecting the
    // stream/mimeType, older Safari/WebView quirks, .start() failing, etc.).
    // Without this try/catch a throw here becomes an unhandled rejection
    // with micState stuck at 'starting' forever — the re-entrancy guard at
    // the top of this handler then makes every subsequent click a no-op,
    // bricking the button until reload while the mic and AudioContext both
    // leak (Fix 3).
    try {
      let mimeType = '';
      let peakLevel = 0;
      let meterActive = false; // only true once the meter has produced a real sample

      // ── Live level meter ── RMS sampled every ~100ms, rendered as a bar;
      // peak tracked to ADVISE (never block) on a quiet capture. Tap only —
      // never connect to ctx.destination, or the mic feeds back into the
      // speakers.
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        store.micAudioCtx = audioCtx;
        // A context constructed after an await is often handed back
        // *suspended* (reliably on iOS Safari) — sampling it would silently
        // read zeros forever, wrongly looking like silence (Fix 1).
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const levelData = new Float32Array(analyser.fftSize);
        const levelFill = $('#micLevelFill');
        const levelBar = $('#micLevel');
        if (levelBar) levelBar.classList.add('active');
        store.micLevelTimer = setInterval(() => {
          analyser.getFloatTimeDomainData(levelData);
          let sumSquares = 0;
          for (let i = 0; i < levelData.length; i++) sumSquares += levelData[i] * levelData[i];
          const rms = Math.sqrt(sumSquares / levelData.length);
          peakLevel = Math.max(peakLevel, rms);
          meterActive = true;
          if (levelFill) {
            levelFill.style.width = Math.min(100, rms * 400) + '%';
            levelFill.classList.toggle('quiet', rms < SILENCE_THRESHOLD);
          }
        }, 100);
      } catch (e) {
        // Meter setup failed (no AudioContext, Chrome's ~6-context cap
        // already hit, createMediaStreamSource failing, ...). meterActive
        // stays false, so the quiet-hint check below is skipped entirely
        // rather than misreading peakLevel's untouched 0 as measured
        // silence (Fix 1) — recognition still fails open onto the upload.
        console.info('[mic] level meter unavailable', e);
      }

      for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg']) {
        if (MediaRecorder.isTypeSupported(type)) { mimeType = type; break; }
      }
      store.mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      store.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

      store.mediaRecorder.onerror = (ev) => {
        resetMic();
        micLog('Recording error: ' + (ev.error?.message || 'unknown'));
      };

      store.mediaRecorder.onstop = async () => {
        teardownLevelMeter(); // stop the bar animating through the upload (Fix 7)
        stopMicStream();
        // Per spec a recorder error fires `error` then `stop`, and onerror already ran
        // resetMic() (which bumps micGen). Without this guard we'd overwrite its error
        // message, re-enter 'identifying', upload a truncated clip, and then skip the
        // final reset — leaving the button spinning forever.
        if (myGen !== store.micGen) return;
        if (store.micTimer) { clearInterval(store.micTimer); store.micTimer = null; }
        if (store.micStopTimer) { clearTimeout(store.micStopTimer); store.micStopTimer = null; }

        micLog('Captured ' + chunks.length + ' chunks (' + chunks.reduce((a, c) => a + c.size, 0) + ' bytes)');

        if (!chunks.length) {
          resetMic();
          micLog('No audio captured. Try again.');
          return;
        }

        // ADVISORY ONLY (Fix 2) — never veto an upload on a client-side
        // level reading. SILENCE_THRESHOLD is stricter than the server's
        // own -60dBFS windowed-peak gate, so a client-side block here would
        // reject clips Shazam could still match; when in doubt, upload and
        // let Shazam decide. Only surfaced when the meter actually ran
        // (meterActive) — a meter that never activated must never be
        // mistaken for measured silence.
        const quietHint = (meterActive && peakLevel < SILENCE_THRESHOLD)
          ? ' (input was very quiet — try holding the phone closer to the speaker)'
          : '';

        store.micState = 'identifying';
        $('#micBtn').classList.remove('recording');
        $('#micBtn').classList.add('identifying');
        $('#micBtn').title = 'Identifying... (click to cancel)';

        // mimeType is the closure local captured at MediaRecorder construction
        // time — store.mediaRecorder may already be null by the time an async
        // continuation below runs (e.g. resetMic() from a Cancel), so reading
        // store.mediaRecorder.mimeType here would throw.
        const ext = mimeType.includes('ogg') ? 'recording.ogg' : 'recording.webm';
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        micLog('Sending ' + (blob.size / 1024).toFixed(0) + ' KB to server...');

        const form = new FormData();
        form.append('audio', blob, ext);

        const controller = new AbortController();
        store.micAbort = controller;
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);

        try {
          const res = await apiFetch('/api/recognize', {
            method: 'POST',
            body: form,
            signal: controller.signal,
          });
          clearTimeout(timeout);
          // An nginx 502/504 (or any non-JSON error page) would otherwise
          // throw SyntaxError here and surface as "Unexpected token '<'",
          // bypassing classifyRecognizeError entirely (Fix 4).
          const data = await res.json().catch(() => ({}));
          if (myGen !== store.micGen) return; // superseded (e.g. cancelled) while the request was in flight
          if (!res.ok) {
            // 422 IS the server's own "too quiet / too short" verdict, so appending our
            // hint would just say the same thing twice — the meter almost always agrees.
            micLog(classifyRecognizeError(res.status, data.detail) + (res.status === 422 ? '' : quietHint));
            return;
          }
          micLog('Found: ' + data.artist + ' - ' + data.name + quietHint);
          showRecognizeResult(data);
        } catch (e) {
          clearTimeout(timeout);
          if (myGen !== store.micGen) return; // cancelled — the click handler already set the status text
          if (e.name === 'AbortError') {
            micLog(timedOut ? 'Timed out after 30s. Try again.' : 'Cancelled');
          } else if (e.message === 'Session expired') {
            micLog('Session expired, please log in again');
          } else {
            micLog('Error: ' + e.message);
          }
        } finally {
          if (myGen === store.micGen) resetMic();
        }
      };

      store.mediaRecorder.start(1000);
      store.micState = 'recording';
      $('#micBtn').classList.add('recording');
      $('#micBtn').title = 'Listening... Click to stop';

      let remaining = 12;
      micLog('Recording... ' + remaining + 's');
      store.micTimer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          micLog('Recording... ' + remaining + 's (' + chunks.length + ' chunks)');
        }
      }, 1000);

      store.micStopTimer = setTimeout(() => {
        store.micStopTimer = null;
        if (store.micState === 'recording' && store.mediaRecorder && store.mediaRecorder.state === 'recording') {
          store.mediaRecorder.stop();
        }
      }, 12000);
    } catch (e) {
      resetMic();
      micLog('Mic error: ' + e.message);
      return;
    }
  });

  $('#rrClose').addEventListener('click', () => { $('#recognizeResult').style.display = 'none'; });

  $('#rrDownload').addEventListener('click', () => {
    if (!store.recognizedItem) return;
    openModal({
      name: store.recognizedItem.name,
      artist: store.recognizedItem.artist,
      image: store.recognizedItem.image,
      url: store.recognizedItem.url || store.recognizedItem.spotify_url || '',
      type: 'track',
    });
  });

  $('#rrSearch').addEventListener('click', () => {
    if (!store.recognizedItem) return;
    $('#searchInput').value = `${store.recognizedItem.artist} ${store.recognizedItem.name}`;
    $('#recognizeResult').style.display = 'none';
    doSearch();
  });
}
