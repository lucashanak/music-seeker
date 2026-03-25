// utils.js — DOM helpers, formatting, notifications

import { store } from './store.js';

// ── DOM Query Helpers ──
export const $ = (s, p) => (p || document).querySelector(s);
export const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

// ── HTML Escaping ──
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
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
export function showToast(msg) {
  let toast = $('#toastMsg');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastMsg';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--bg-elevated);color:var(--text);padding:10px 20px;border-radius:20px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s;border:1px solid var(--border);';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
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
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:400px;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:14px;">Add to playlist${multi ? 's' : ''}</div>
      <div style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:4px;">
        ${playlists.map((p, i) => `
          <label class="pl-pick-btn" data-pl-idx="${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:none;background:none;color:var(--text);border-radius:10px;cursor:pointer;text-align:left;transition:background .15s;">
            ${multi ? `<input type="checkbox" data-pl-idx="${i}" style="width:16px;height:16px;accent-color:var(--accent);flex-shrink:0;">` : ''}
            ${p.image ? `<img src="${p.image}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;">` : `<div style="width:36px;height:36px;border-radius:6px;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:16px;">&#9835;</div>`}
            <div style="min-width:0;flex:1;">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${p.songCount || 0} tracks</div>
            </div>
          </label>`).join('')}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        ${multi ? `<button class="pl-pick-add" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;" disabled>Add</button>` : ''}
        <button class="pl-pick-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const addBtn = modal.querySelector('.pl-pick-add');

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
    modal.querySelectorAll('.pl-pick-btn').forEach(b => {
      b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,.06)');
      b.addEventListener('mouseleave', () => b.style.background = 'none');
    });
  });
}
