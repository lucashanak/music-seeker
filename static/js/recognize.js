// recognize.js — Microphone recording, Shazam/AcoustID identification

import { store } from './store.js';
import { $ } from './utils.js';
import { apiFetch } from './api.js';
import { openModal } from './downloads.js';
import { doSearch } from './search.js';

function micLog(msg) {
  $('#micStatus').textContent = msg;
}

function stopMicStream() {
  if (store.micStream) {
    store.micStream.getTracks().forEach(t => t.stop());
    store.micStream = null;
  }
}

function resetMic() {
  store.micState = 'idle';
  stopMicStream();
  if (store.micTimer) { clearInterval(store.micTimer); store.micTimer = null; }
  if (store.mediaRecorder && store.mediaRecorder.state !== 'inactive') {
    try { store.mediaRecorder.stop(); } catch (_) {}
  }
  store.mediaRecorder = null;
  $('#micBtn').classList.remove('recording', 'identifying');
  $('#micBtn').title = 'Identify song with microphone';
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
      if (store.mediaRecorder && store.mediaRecorder.state === 'recording') store.mediaRecorder.stop();
      if (store.micTimer) clearInterval(store.micTimer);
      return;
    }
    if (store.micState === 'identifying') {
      resetMic();
      micLog('Cancelled');
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      micLog('Error: Microphone requires HTTPS');
      return;
    }

    stopMicStream();

    micLog('Requesting microphone...');

    try {
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          'Mic timed out (10s). Firefox: tap lock icon in URL bar → Clear site data, then reload and try again.'
        )), 10000)),
      ]);

      store.micStream = stream;
      const chunks = [];

      micLog('Mic active. Recording...');

      let mimeType = '';
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
        stopMicStream();
        if (store.micTimer) { clearInterval(store.micTimer); store.micTimer = null; }

        micLog('Captured ' + chunks.length + ' chunks (' + chunks.reduce((a, c) => a + c.size, 0) + ' bytes)');

        if (!chunks.length) {
          resetMic();
          micLog('No audio captured. Try again.');
          return;
        }

        store.micState = 'identifying';
        $('#micBtn').classList.remove('recording');
        $('#micBtn').classList.add('identifying');
        $('#micBtn').title = 'Identifying... (click to cancel)';

        const recMime = store.mediaRecorder.mimeType || 'audio/webm';
        const ext = recMime.includes('ogg') ? 'recording.ogg' : 'recording.webm';
        const blob = new Blob(chunks, { type: recMime });
        micLog('Sending ' + (blob.size / 1024).toFixed(0) + ' KB to server...');

        const form = new FormData();
        form.append('audio', blob, ext);

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          const res = await apiFetch('/api/recognize', {
            method: 'POST',
            body: form,
            signal: controller.signal,
          });
          clearTimeout(timeout);
          micLog('Server responded: ' + res.status);
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || 'Not recognized');
          micLog('Found: ' + data.artist + ' - ' + data.name);
          showRecognizeResult(data);
        } catch (e) {
          if (e.name === 'AbortError') {
            micLog('Timed out after 30s');
          } else if (e.message === 'Session expired') {
            micLog('Session expired, please log in again');
          } else {
            micLog('Error: ' + e.message);
          }
        } finally {
          resetMic();
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

      setTimeout(() => {
        if (store.micState === 'recording' && store.mediaRecorder && store.mediaRecorder.state === 'recording') {
          store.mediaRecorder.stop();
        }
      }, 12000);
    } catch (e) {
      resetMic();
      micLog('Mic error: ' + e.message);
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
