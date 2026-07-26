// feedback.js — Floating "report a bug / request a feature" button.
// Captures a screenshot of the app (before opening the modal, so the modal
// itself isn't in the shot), lets the user describe the issue, and POSTs it.

import { store } from './store.js';
import { apiJson } from './api.js';
import { $, showToast } from './utils.js';

let _lastScreenshot = ''; // data:image/jpeg;base64,... or '' if capture failed/unchecked
let _busy = false; // re-entrancy guard — capture can take seconds; ignore taps while in flight

// ── FAB ──
function _buildFab() {
  const app = $('#appContainer');
  if (!app || $('#feedbackFab')) return;
  const fab = document.createElement('button');
  fab.id = 'feedbackFab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Report a bug or request a feature');
  fab.title = 'Report a bug or request a feature';
  fab.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/></svg>`;
  fab.addEventListener('click', _onFabClick);
  app.appendChild(fab);
}

async function _onFabClick() {
  if (_busy) return; // ignore double-taps while a capture is already in flight
  _busy = true;
  const fab = $('#feedbackFab');
  // The FAB stays visible (snapdom's `exclude` option keeps it out of the shot)
  // and gets a busy state so a slow capture doesn't look like a dead button.
  if (fab) { fab.disabled = true; fab.classList.add('fb-busy'); }
  let thumb = '';
  let captureFailed = false;
  try {
    thumb = await _captureScreenshot();
  } catch (e) {
    console.warn('Feedback screenshot capture failed:', e);
    captureFailed = true;
    thumb = '';
  } finally {
    if (fab) { fab.disabled = false; fab.classList.remove('fb-busy'); }
    _busy = false;
  }
  _lastScreenshot = thumb;
  _openModal({ captureFailed });
}

// Any input currently revealed (type=text) via a .btn-reveal control (Navidrome
// password, slskd key, Spotify client secret/refresh token — see settings.js)
// is a live secret. snapdom clones input values into the capture, so a revealed
// secret would otherwise be captured as plaintext pixels — and this screenshot
// can later be promoted into a public GitHub repo. Flip it back to password for
// the duration of the capture; restore afterwards.
function _hideRevealedSecrets() {
  // Capture is multi-second; the user can click a .btn-reveal eye icon again
  // while it's running. That click is a live, intentional toggle — if we then
  // unconditionally force type back to 'text' on restore, we'd re-reveal a
  // field the user had just re-masked (or mask one they'd just re-revealed).
  // So: only restore inputs nobody touched while we had them hidden; anything
  // touched keeps whatever state the user's own toggle left it in.
  const revealed = [];
  document.querySelectorAll('.btn-reveal[data-reveal]').forEach(btn => {
    const input = document.getElementById(btn.dataset.reveal);
    if (input && input.type === 'text') {
      input.type = 'password';
      const entry = { input, touched: false };
      const onToggle = () => { entry.touched = true; };
      btn.addEventListener('click', onToggle, { once: true });
      entry.cleanup = () => btn.removeEventListener('click', onToggle);
      revealed.push(entry);
    }
  });
  return () => revealed.forEach(({ input, touched, cleanup }) => {
    cleanup();
    if (!touched) input.type = 'text'; // prior type — only what we ourselves changed
  });
}

// Captures the full document.body via the vendored snapdom (so the player bar,
// full player, download modal, toasts and context menus — all appended outside
// #appContainer — can actually show up in a report), then downscales to a
// bounded JPEG (q=0.8) so payloads stay in the ~100-300 KB range instead of
// multi-MB PNGs. dpr is pinned to 1 (default is devicePixelRatio, which would
// allocate a 2-3x oversized intermediate canvas — this project has a
// documented OOM history with native memory blowups).
async function _captureScreenshot() {
  const { snapdom } = await import('./vendor/snapdom.mjs');
  const restoreSecrets = _hideRevealedSecrets();
  try {
    const result = await snapdom(document.body, {
      backgroundColor: '#0a0a0f',
      scale: 1,
      dpr: 1,
      exclude: ['#feedbackFab'],
      // Default excludeMode 'hide' replaces the excluded node with an in-flow
      // `<div style="display:inline-block;width:44px;height:44px;visibility:hidden">`
      // placeholder. The FAB is position:fixed, so that placeholder doesn't
      // belong in flow at all — it can add a ~44px blank strip to the capture.
      // 'remove' drops the clone entirely instead.
      excludeMode: 'remove',
    });
    const canvas = await result.toCanvas();
    return _downscaleToJpeg(canvas, 1280, 2400, 0.8);
  } finally {
    restoreSecrets();
  }
}

// Caps width by scaling and caps height by CROPPING (not scaling) — a long
// Library/Discover page (infinite scroll) can make #appContainer/body 10-30k px
// tall. Scaling to fit both constraints used to let height be the tighter one
// on such pages, which dragged width down with it (well under 640px) and made
// text illegible. Instead: scale by width only, then take just the top
// maxHeight px of the scaled image — long pages get truncated, not shrunk.
// An unbounded-height canvas can also exceed Safari/iOS's ~16.7M-pixel canvas
// limit; when that happens toDataURL() returns the literal string "data:,"
// WITHOUT throwing, which is truthy — so the caller must validate the result
// rather than trust it.
function _downscaleToJpeg(canvas, maxWidth, maxHeight, quality) {
  const { width, height } = canvas;
  const scale = Math.min(1, maxWidth / width);
  const scaledWidth = Math.round(width * scale);
  const scaledHeight = Math.round(height * scale);
  const outHeight = Math.min(maxHeight, scaledHeight);
  // Source slice sized so that, after the same `scale` factor, it maps onto
  // outHeight — i.e. the top slice of the source, not a squeezed full image.
  const srcHeight = scale > 0 ? outHeight / scale : 0;
  const out = document.createElement('canvas');
  out.width = scaledWidth;
  out.height = outHeight;
  out.getContext('2d').drawImage(canvas, 0, 0, width, srcHeight, 0, 0, scaledWidth, outHeight);
  const url = out.toDataURL('image/jpeg', quality);
  return (url && url.startsWith('data:image/')) ? url : '';
}

// ── Modal ──
function _openModal({ captureFailed = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  // position/inset/display/align-items/justify-content/backdrop-filter all
  // match .modal-overlay's own rules already, so they're not repeated here.
  // z-index is NOT set inline: .modal-overlay is 200 (modal.css), which sits
  // below toasts (999, utils.js) — an inline 1000 used to invert that and hide
  // showToast() error messages (e.g. HTTP 413/429) behind this overlay.
  // No inline `background` here either — it used to hardcode rgba(0,0,0,.6),
  // overriding .modal-overlay's own rgba(0,0,0,.75) and making this the one
  // visibly-lighter modal in the app. overflow-y + padding let the card scroll
  // within the overlay on short viewports instead of clipping.
  overlay.style.cssText = 'overflow-y:auto;padding:16px 0;';
  const modal = document.createElement('div');
  // max-height + overflow-y: on a short viewport (phone landscape, or portrait
  // with the iOS soft keyboard open) the ~460px-tall card used to have no
  // height cap, clipping the heading off the top and the Send/Cancel buttons
  // off the bottom — with the overlay itself having no overflow, those buttons
  // were unreachable. dvh accounts for mobile browser chrome resizing the
  // viewport.
  modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:420px;max-height:calc(100dvh - 32px);overflow-y:auto;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';

  const hasThumb = !!_lastScreenshot;
  modal.innerHTML = `
    <div class="fb-heading" style="font-size:15px;font-weight:600;margin-bottom:14px;">Report a bug</div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <button type="button" class="fb-kind-btn fb-kind-bug" data-kind="bug" style="flex:1;padding:9px;border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;background:var(--accent);color:#000;">&#128030; Bug</button>
      <button type="button" class="fb-kind-btn fb-kind-feature" data-kind="feature" style="flex:1;padding:9px;border:1px solid var(--border);border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;background:none;color:var(--text-muted);">&#10024; Feature</button>
    </div>
    <input type="text" class="fb-title" placeholder="Short summary" maxlength="120" style="padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:14px;outline:none;font-family:inherit;">
    <textarea class="fb-desc" rows="4" placeholder="What happened? What did you expect?" maxlength="5000" style="margin-top:10px;padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:14px;outline:none;resize:vertical;font-family:inherit;"></textarea>
    <div class="fb-desc-counter" style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:2px;">0 / 5000</div>
    ${hasThumb ? `
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
      <img class="fb-thumb" src="${_lastScreenshot}" style="max-height:120px;border-radius:8px;object-fit:contain;border:1px solid var(--border);">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer;">
        <input type="checkbox" class="fb-attach" checked style="accent-color:var(--accent);"> Attach screenshot
      </label>
    </div>` : `
    <div style="margin-top:10px;font-size:12px;color:var(--text-muted);">${captureFailed ? 'Screenshot could not be captured — sending without one.' : 'No screenshot attached.'}</div>`}
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="fb-submit" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;">Send</button>
      <button class="fb-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let kind = 'bug';
  let submitting = false; // Enter key calls submit() directly — this guards it too
  const heading = modal.querySelector('.fb-heading');
  const titleEl = modal.querySelector('.fb-title');
  const descEl = modal.querySelector('.fb-desc');
  const counterEl = modal.querySelector('.fb-desc-counter');
  const attachEl = modal.querySelector('.fb-attach');
  const submitBtn = modal.querySelector('.fb-submit');

  // Live counter so a long paste (e.g. a console log) doesn't silently get
  // truncated by maxlength without the user noticing — maxlength itself is
  // what actually prevents the 422, this is just visibility.
  const updateCounter = () => { counterEl.textContent = `${descEl.value.length} / 5000`; };
  descEl.addEventListener('input', updateCounter);
  updateCounter();

  const setKind = (k) => {
    kind = k;
    heading.textContent = k === 'bug' ? 'Report a bug' : 'Request a feature';
    modal.querySelectorAll('.fb-kind-btn').forEach(btn => {
      const active = btn.dataset.kind === k;
      btn.style.background = active ? 'var(--accent)' : 'none';
      btn.style.color = active ? '#000' : 'var(--text-muted)';
    });
  };
  modal.querySelectorAll('.fb-kind-btn').forEach(btn => {
    btn.addEventListener('click', () => setKind(btn.dataset.kind));
  });

  const done = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    else if (e.key === 'Enter' && e.target === titleEl) { e.preventDefault(); submit(); }
  };
  document.addEventListener('keydown', onKey);

  async function submit() {
    if (submitting) return; // Enter key (repeat) bypasses submitBtn.disabled — guard here too
    const title = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; } // required — keep the modal open
    submitting = true;
    const screenshot = (hasThumb && attachEl && attachEl.checked) ? _lastScreenshot : '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      const resp = await apiJson('/api/feedback', {
        method: 'POST',
        body: {
          kind,
          title,
          description: descEl.value.trim(),
          screenshot,
          context: {
            page: store.currentPage || '',
            version: localStorage.getItem('ms_version') || '',
            user_agent: navigator.userAgent,
            url: location.href,
          },
        },
      });
      done();
      if (resp && resp.screenshot_rejected) {
        showToast('Report sent, but the screenshot could not be attached.', true);
      } else {
        showToast('Thanks! Report sent.');
      }
    } catch (err) {
      showToast(err.message || 'Failed to send report', true);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send';
      submitting = false;
      // keep the modal open so the user doesn't lose their text
    }
  }

  submitBtn.addEventListener('click', submit);
  modal.querySelector('.fb-cancel').addEventListener('click', done);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
  setTimeout(() => titleEl.focus(), 30);
}

export function init() {
  _buildFab();
}
