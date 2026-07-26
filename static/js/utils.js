// utils.js — DOM helpers, formatting, notifications

import { store } from './store.js';
// apiJson is safe to import here: api.js only imports store.js (no util→api→util
// cycle), so the "+ New playlist" picker row can create a playlist inline.
import { apiJson } from './api.js';

// ── DOM Query Helpers ──
export const $ = (s, p) => (p || document).querySelector(s);
export const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

// ── HTML Escaping ──
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// Escape for use inside an HTML attribute value (also handles quotes, which esc() does not).
export function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Time / Duration Formatting ──
export function formatDuration(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── File Size Formatting ──
export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// ── Toast Notification ──
// Optional opts: { actionLabel, onAction, duration } — when actionLabel + onAction
// are given, render an inline action button (e.g. "Undo") and keep the toast up
// for `duration` ms (default 2000). Clicking the action fires onAction and hides.
export function showToast(msg, isError = false, opts = {}) {
  const { actionLabel, onAction, duration } = opts;
  let toast = $('#toastMsg');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastMsg';
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:20px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s;';
    document.body.appendChild(toast);
  }
  // Honor the error flag with a distinct (red) style; default is the neutral elevated style.
  if (isError) {
    toast.style.background = 'var(--error, #d33)';
    toast.style.color = '#fff';
    toast.style.border = '1px solid var(--error, #d33)';
  } else {
    toast.style.background = 'var(--bg-elevated)';
    toast.style.color = 'var(--text)';
    toast.style.border = '1px solid var(--border)';
  }
  clearTimeout(toast._timer);
  if (actionLabel && typeof onAction === 'function') {
    toast.textContent = '';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    const span = document.createElement('span');
    span.textContent = msg;
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.style.cssText = 'margin-left:16px;background:none;border:none;color:var(--accent);font-weight:600;font-size:13px;cursor:pointer;padding:0;';
    btn.addEventListener('click', () => {
      clearTimeout(toast._timer);
      toast.style.opacity = '0';
      onAction();
    });
    toast.appendChild(span);
    toast.appendChild(btn);
  } else {
    toast.style.display = '';
    toast.textContent = msg;
  }
  toast.style.opacity = '1';
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration || 2000);
}

// ── Browser Notifications ──
export function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    store.notificationsEnabled = true;
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { store.notificationsEnabled = p === 'granted'; });
  }
}

// ── History Navigation Helper ──
export function historyBack() {
  store._ignorePopstate = true;
  history.back();
}

// ── Virtual keyboard: hide bottom nav + player bar when keyboard is open ──
export function initVirtualKeyboard() {
  const inputTags = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
  const app = document.getElementById('appContainer');

  if (window.visualViewport) {
    function adjust() {
      const offset = window.innerHeight - visualViewport.height - visualViewport.offsetTop;
      // Only consider keyboard open if viewport shrank significantly AND an input is focused
      const active = document.activeElement;
      const inputFocused = active && inputTags.has(active.tagName) && app && app.contains(active);
      document.body.classList.toggle('keyboard-open', offset > 150 && inputFocused);
    }
    visualViewport.addEventListener('resize', adjust);
    visualViewport.addEventListener('scroll', adjust);
  }
}

// ── Playlist Picker Modal ──
export function showPlaylistPicker(playlists, { multi = true } = {}) {
  return new Promise((resolve) => {
    const selected = new Set();
    // Zero playlists is a supported state: the "+ New playlist" row is the whole
    // point of opening the picker then, so show a hint and drop the multi-select
    // "Add" button (it could never leave its disabled state).
    const isEmpty = !playlists.length;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:400px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:${isEmpty ? '8px' : '14px'};">Add to playlist${multi && !isEmpty ? 's' : ''}</div>
      ${isEmpty ? `<div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">You have no playlists yet — create one to add this to.</div>` : ''}
      <div style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:4px;">
        <div class="pl-pick-new" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:none;background:none;color:var(--text);border-radius:10px;cursor:pointer;text-align:left;transition:background .15s;">
          <div style="width:36px;height:36px;border-radius:6px;border:2px dashed var(--border);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--text-muted);flex-shrink:0;">+</div>
          <div style="min-width:0;flex:1;"><div style="font-size:13px;font-weight:500;">New playlist</div></div>
        </div>
        ${playlists.map((p, i) => `
          <label class="pl-pick-btn" data-pl-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:none;background:none;color:var(--text);border-radius:10px;cursor:pointer;text-align:left;transition:background .15s;">
            ${multi ? `<input type="checkbox" data-pl-idx="${i}" style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;">` : ''}
            ${p.image ? `<img src="${escAttr(p.image)}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:16px;">&#9835;</div>`}
            <div style="min-width:0;flex:1;">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${p.songCount || 0} tracks</div>
            </div>
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        ${multi && !isEmpty ? `<button class="pl-pick-add" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;" disabled>Add</button>` : ''}
        <button class="pl-pick-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const addBtn = modal.querySelector('.pl-pick-add');

    // "+ New playlist" row — create-and-pick-immediately in both modes. A
    // cancelled name modal keeps the picker open; a successful create closes it
    // and resolves with the fresh playlist (object in single mode, array of one
    // in multi mode).
    const newRow = modal.querySelector('.pl-pick-new');
    if (newRow) newRow.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = await showInputModal('New playlist', '', { okLabel: 'Create', placeholder: 'Playlist name' });
      if (!name) return; // cancelled → leave picker open
      try {
        const res = await apiJson('/api/library/playlist', { method: 'POST', body: { name } });
        const newPl = { id: res && res.id, name, songCount: 0 };
        overlay.remove();
        resolve(multi ? [newPl] : newPl);
      } catch (err) {
        showToast(err.message || 'Failed to create playlist');
      }
    });

    if (multi) {
      // Checkbox logic
      modal.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = parseInt(cb.dataset.plIdx);
          if (cb.checked) selected.add(idx); else selected.delete(idx);
          if (addBtn) addBtn.disabled = selected.size === 0;
        });
      });
      if (addBtn) addBtn.addEventListener('click', () => {
        overlay.remove();
        resolve([...selected].map(i => playlists[i]));
      });
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.pl-pick-cancel')) {
        overlay.remove();
        resolve(multi ? [] : null);
      }
      // Single-select fallback (non-multi mode)
      if (!multi) {
        const btn = e.target.closest('.pl-pick-btn');
        if (btn) {
          overlay.remove();
          resolve(playlists[parseInt(btn.dataset.plIdx)]);
        }
      }
    });
    // Hover style
    modal.querySelectorAll('.pl-pick-btn, .pl-pick-new').forEach(b => {
      b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,.06)');
      b.addEventListener('mouseleave', () => b.style.background = 'none');
    });
  });
}

// Inline text-input modal — a reliable replacement for window.prompt(), which
// browsers suppress after repeated dialogs ("don't allow this site to prompt").
// Resolves to the trimmed string, or null on cancel / empty.
export function showInputModal(title, defaultValue = '', { okLabel = 'OK', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:420px;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:14px;">${esc(title)}</div>
      <input type="text" class="input-modal-field" placeholder="${esc(placeholder)}" style="padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:14px;outline:none;">
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="input-modal-ok" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;">${esc(okLabel)}</button>
        <button class="input-modal-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const input = modal.querySelector('.input-modal-field');
    input.value = defaultValue || '';
    const done = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const submit = () => { const v = input.value.trim(); done(v || null); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.input-modal-ok').addEventListener('click', submit);
    modal.querySelector('.input-modal-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// Richer playlist form modal: name input + description textarea. Resolves to
// { name, description } (description may be ""), or null on cancel / empty name.
// Enter in the name field submits; the textarea keeps normal newline behavior.
export function showPlaylistFormModal({ title = 'Playlist', name = '', description = '', okLabel = 'Save' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:420px;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:14px;">${esc(title)}</div>
      <input type="text" class="pl-form-name" placeholder="Playlist name" style="padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:14px;outline:none;">
      <textarea class="pl-form-desc" rows="3" placeholder="Description (optional)" style="margin-top:10px;padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:14px;outline:none;resize:vertical;font-family:inherit;"></textarea>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="pl-form-ok" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;">${esc(okLabel)}</button>
        <button class="pl-form-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const nameEl = modal.querySelector('.pl-form-name');
    const descEl = modal.querySelector('.pl-form-desc');
    nameEl.value = name || '';
    descEl.value = description || '';
    const done = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const submit = () => {
      const n = nameEl.value.trim();
      if (!n) { nameEl.focus(); return; } // name is required — keep the modal open
      done({ name: n, description: descEl.value.trim() });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && e.target === nameEl) { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.pl-form-ok').addEventListener('click', submit);
    modal.querySelector('.pl-form-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 30);
  });
}

// Confirmation modal — replaces window.confirm(). Resolves true (OK) / false
// (cancel/escape/backdrop). The OK button uses the danger (red) style by default.
export function showConfirmModal(title, message = '', { okLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:420px;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    const okBg = danger ? 'var(--red)' : 'var(--accent)';
    const okColor = danger ? '#fff' : '#000';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:${message ? '10px' : '14px'};">${esc(title)}</div>
      ${message ? `<div style="font-size:13px;color:var(--text-muted);line-height:1.5;white-space:pre-line;">${esc(message)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="confirm-ok" style="flex:1;padding:10px;border:none;background:${okBg};color:${okColor};border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;">${esc(okLabel)}</button>
        <button class="confirm-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const done = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.confirm-ok').addEventListener('click', () => done(true));
    modal.querySelector('.confirm-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    setTimeout(() => { modal.querySelector('.confirm-ok').focus(); }, 30);
  });
}
