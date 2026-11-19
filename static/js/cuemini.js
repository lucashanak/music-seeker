// cuemini.js — headphone-cue entry points (dj-pult): the button on queue rows, the
// mini preview bar, and the visibility rules shared with the context menu.
// Never imports player_v3.js statically (a second engine instance would start).
import { store } from './store.js';
import { showToast } from './utils.js';
import { getPlayerEngine, getPlayerModule } from './player_active.js';
import { configuredCueMode } from './cuemath.js';

let bus = null;        // cuebus.js namespace once it has real exports
let setup = null;      // cuesetup.js namespace
let nextIdx = null;    // queue index of the track that plays next (dj engine)
let bar = null;
let raf = 0;
let dragging = false;
let poll = 0;          // the 1.5 s check; runs only while there is something to keep up to date
let badArt = '';       // a cover URL that failed to load: not asked for again
const POLL_MS = 1500;
const QUEUE_LISTS = '#queueList, #fpQueuePanelList, #fpQueueList';

const HEADPHONES = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';

// ── Visibility: one place, used by every entry point ──
export function cueAvailable() {
  if (!bus || typeof bus.cueSupport !== 'function' || typeof bus.previewItem !== 'function') return false;
  if (getPlayerEngine() !== 'dj') return false;
  if (store.castDevice || store.remoteTarget) return false;
  try { const s = bus.cueSupport(); if (!s || s.engineDj === false || s.blocked || !(s.modes && s.modes.length)) return false; } catch { return false; }
  return true;
}

// The same test the cue bus builds by (cuemath.configuredCueMode): 'devices' without an
// explicit device is NOT set up — it would pre-listen on the main speakers.
function configured() {
  try { return configuredCueMode(bus.cueSettings(), bus.cueSupport().modes) !== 'off'; } catch { return false; }
}

// Preview a track; opens the setup dialog first when no output is chosen yet.
export async function previewFromUi(item, index) {
  if (!cueAvailable() || !item) return false;
  const st = bus.previewState && bus.previewState();
  if (st && sameItem(st.item, item)) { bus.stopPreview(); return true; }
  if (!configured()) {
    if (!setup) { try { setup = await import('./cuesetup.js'); } catch {} }
    if (!setup || typeof setup.openCueSetup !== 'function') { showToast('Headphone cue is not available', true); return false; }
    if (!(await setup.openCueSetup())) return false;
  }
  // previewItem says why itself when it fails; a false from a preview that a newer tap
  // replaced, or from a cancelled setup, is not a failure to report.
  return bus.previewItem(item, index == null ? undefined : { index });
}

function sameItem(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return (a.name || '') === (b.name || '') && (a.artist || '') === (b.artist || '');
}

// ── Queue rows ──
// Called by queue.js after it builds rows. Button on every row, always visible on the
// next-up row, revealed on hover for the rest (CSS), and reachable from the kebab menu.
export function decorateQueueRows(root) {
  if (decorate(root, cueAvailable())) ensurePoll();   // a queue list is on screen: keep it current
  paintRows();
}

// Buttons on one list's rows, without painting; true when the list has rows.
function decorate(root, avail) {
  if (!root) return false;
  const rows = root.querySelectorAll('.queue-item');
  for (const row of rows) {
    const old = row.querySelector('.cue-btn');
    if (!avail) { if (old) old.remove(); continue; }
    if (old) continue;
    const qi = parseInt(row.dataset.qi);
    const btn = document.createElement('button');
    btn.className = 'cue-btn qi-cue';
    btn.type = 'button';
    btn.innerHTML = HEADPHONES;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      previewFromUi(store.playerQueue[qi], qi);
    });
    const anchor = row.querySelector('.like-btn') || row.querySelector('.kebab-btn') || row.querySelector('.qi-remove');
    if (anchor) row.insertBefore(btn, anchor); else row.appendChild(btn);
  }
  return rows.length > 0;
}

function paintRows() {
  const st = bus && bus.previewState ? bus.previewState() : null;
  const rows = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('.queue-item') : [];
  for (const row of rows) {
    const btn = row.querySelector('.cue-btn');
    if (!btn) continue;
    const qi = parseInt(row.dataset.qi);
    const item = store.playerQueue[qi];
    const active = !!(st && item && sameItem(st.item, item));
    btn.classList.toggle('active', active);
    btn.classList.toggle('is-next', qi === nextIdx);
    btn.title = active ? 'Stop preview' : (qi === nextIdx ? 'Preview next track in headphones' : 'Preview in headphones');
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

async function refreshNext() {
  let n = null;
  if (getPlayerEngine() === 'dj') {
    try {
      const m = await getPlayerModule();
      const info = m.deskInfo && m.deskInfo();
      n = info && info.next != null ? info.next : null;
    } catch {}
    if (n == null && store.playerQueue.length && store.playerIndex + 1 < store.playerQueue.length) n = store.playerIndex + 1;
  }
  if (n !== nextIdx) { nextIdx = n; paintRows(); }
}

// ── Mini bar ──
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

function buildBar() {
  bar = document.createElement('div');
  bar.id = 'cueMini';
  bar.hidden = true;
  bar.addEventListener('error', (e) => {
    // A cover URL that fails to load: the app's srcless placeholder, not a broken image.
    if (e.target && e.target.classList && e.target.classList.contains('cm-img')) {
      badArt = e.target.getAttribute('src') || '';
      e.target.removeAttribute('src');
    }
  }, true);
  bar.innerHTML = `
    <img class="cm-img" alt="">
    <div class="cm-info"><div class="cm-title"></div><div class="cm-artist"></div></div>
    <button type="button" class="cm-btn cm-play" aria-label="Play or pause preview"></button>
    <span class="cm-time cm-pos">0:00</span>
    <input type="range" class="cm-seek" min="0" max="1000" value="0" aria-label="Preview position">
    <span class="cm-time cm-dur">0:00</span>
    <button type="button" class="cm-btn cm-desk" aria-label="Open DJ desk" title="Open DJ desk">Open desk</button>
    <button type="button" class="cm-btn cm-stop" aria-label="Stop preview" title="Stop preview">&times;</button>`;
  document.body.appendChild(bar);
  const seek = bar.querySelector('.cm-seek');
  seek.addEventListener('pointerdown', () => { dragging = true; });
  seek.addEventListener('change', () => {
    const st = bus.previewState();
    if (st && st.dur) bus.previewSeek(seek.value / 1000 * st.dur);
    dragging = false;
  });
  bar.querySelector('.cm-play').addEventListener('click', () => bus.previewToggle());
  bar.querySelector('.cm-stop').addEventListener('click', () => bus.stopPreview());
  bar.querySelector('.cm-desk').addEventListener('click', () => {
    import('./djdesk.js').then(m => m.openDesk && m.openDesk()).catch(() => showToast('Could not open the DJ desk', true));
  });
}

function updateBar() {
  const st = cueAvailable() && bus.previewState ? bus.previewState() : null;
  const show = !!st && !store.deskOpen;
  if (!show) {
    if (bar) bar.hidden = true;
    document.body.classList.remove('cue-mini-active');
    cancelAnimationFrame(raf); raf = 0;
    return;
  }
  if (!bar) buildBar();
  bar.hidden = false;
  document.body.classList.add('cue-mini-active');
  const it = st.item || {};
  const img = bar.querySelector('.cm-img');
  const src = it.image && it.image !== badArt ? it.image : '';
  if ((img.getAttribute('src') || '') !== src) { if (src) img.setAttribute('src', src); else img.removeAttribute('src'); }
  bar.querySelector('.cm-title').textContent = it.name || '';
  bar.querySelector('.cm-artist').textContent = it.artist || '';
  const play = bar.querySelector('.cm-play');
  play.innerHTML = st.playing ? '&#10074;&#10074;' : '&#9654;';
  play.title = st.playing ? 'Pause' : 'Play';
  tick();
}

function tick() {
  cancelAnimationFrame(raf); raf = 0;
  if (!bar || bar.hidden || !bus) return;
  const st = bus.previewState();
  if (!st) return;
  bar.querySelector('.cm-pos').textContent = fmt(st.pos);
  bar.querySelector('.cm-dur').textContent = st.dur ? fmt(st.dur) : '–:––';
  if (!dragging) bar.querySelector('.cm-seek').value = st.dur ? Math.min(1000, st.pos / st.dur * 1000) : 0;
  raf = requestAnimationFrame(tick);
}

function onChange() {
  updateBar();
  paintRows();
  ensurePoll();
}

// cast / remote / engine switches carry no event of their own, so a check runs — but
// only while a preview plays or a queue list is open; otherwise it stops itself.
function wanted() {
  if (!cueAvailable()) return false;          // classic engine, cast, remote, no cue here
  const pv = !!(bus.previewState && bus.previewState());
  return pv || !!(store.queuePanelOpen || store.fpQueuePanelOpen || store.fullPlayerOpen);
}

function refreshLists() {
  const avail = cueAvailable();
  for (const l of document.querySelectorAll(QUEUE_LISTS)) decorate(l, avail);
  paintRows();                                // once, over every list
}

function ensurePoll() {
  if (poll || !bus || !wanted()) return;
  poll = setInterval(() => {
    if (!wanted()) {
      clearInterval(poll); poll = 0;
      refreshLists();                         // cue just went away: take the buttons off
      updateBar();
      return;
    }
    refreshNext();
    refreshLists();
    updateBar();
  }, POLL_MS);
}

export async function init() {
  try {
    const m = await import('./cuebus.js');
    if (typeof m.cueSupport !== 'function') return;
    bus = m;
  } catch (e) { return; }
  try { setup = await import('./cuesetup.js'); } catch {}
  if (typeof bus.onCueChange === 'function') bus.onCueChange(onChange);
  document.addEventListener('desk:engine', () => { refreshNext(); onChange(); });
  window.addEventListener('storage', onChange);
  refreshNext();
  refreshLists();
  ensurePoll();
}
