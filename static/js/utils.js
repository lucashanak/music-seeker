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

// ── Virtual keyboard: keep bottom nav visible ──
export function initVirtualKeyboard() {
  if (window.visualViewport) {
    const bn = $('#bottomNav');
    function adjustBottomNav() {
      const offset = window.innerHeight - visualViewport.height - visualViewport.offsetTop;
      if (bn) bn.style.transform = offset > 50 ? `translateY(-${offset}px)` : '';
    }
    visualViewport.addEventListener('resize', adjustBottomNav);
    visualViewport.addEventListener('scroll', adjustBottomNav);
  }
}
