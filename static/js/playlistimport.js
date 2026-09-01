// playlistimport.js — import a shared playlist/album link (or a pasted list of
// track links) and drop the user into the normal playlist detail view.
//
// The imported playlist is playable immediately WITHOUT downloading anything:
// queueing never downloads and the backend's stream resolver falls back to
// YouTube for tracks that aren't in the library. So this module only ever
// produces a track list — every download here is an explicit user action
// through the existing download job (the hero's "Download All" / a track's ⋮).

import { store } from './store.js';
import { $, esc, escAttr, showToast, autoFocus } from './utils.js';
import { apiJson } from './api.js';
import { openModal } from './downloads.js';
import { getPlayerModule } from './player_active.js';
import { showImportedPlaylist } from './spotify.js';

// ── Link sniffing ──
// Only playlist/album shapes count as a "collection link" — a bare track link
// must not fire an import banner (it belongs to the paste path instead).
const COLLECTION_RES = [
  // spotify:playlist:<id> / spotify:album:<id>
  { re: /spotify:(playlist|album):([A-Za-z0-9]+)/i, source: 'spotify' },
  // open.spotify.com/[intl-xx/]playlist|album/<id>
  { re: /open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?(playlist|album)\/([A-Za-z0-9]+)/i, source: 'spotify' },
  // [www.]deezer.com/[en/]playlist|album/<id>
  { re: /deezer\.com\/(?:[a-z]{2}\/)?(playlist|album)\/(\d+)/i, source: 'deezer' },
];

// Per-track links (or "Artist - Title" lines) go to /api/import/tracks instead.
const TRACK_LINK_RE = /(?:open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?track\/|spotify:track:|deezer\.com\/(?:[a-z]{2}\/)?track\/)[A-Za-z0-9]+/i;

// Returns { source, kind, id } for a playlist/album link found in `text`, else null.
export function parseCollectionLink(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const { re, source } of COLLECTION_RES) {
    const m = s.match(re);
    if (m) return { source, kind: m[1].toLowerCase(), id: m[2] };
  }
  return null;
}

const SOURCE_LABEL = { spotify: 'Spotify', deezer: 'Deezer' };

function sourceLabel(data) {
  const src = SOURCE_LABEL[data.source] || data.source || 'Import';
  const kind = data.kind === 'album' ? 'album' : 'playlist';
  return `${src} ${kind}`;
}

// ── Banner state ──
// Keyed by the parsed link so retyping the same URL doesn't re-import, and a
// stale response can't paint over a newer one.
let _bannerKey = '';
let _bannerGen = 0;
let _debounceTimer = null;

function bannerEl() { return $('#importBanner'); }

// While the banner owns the search page, the (inevitably empty) search results
// underneath it would read as "your search failed". Hide them — search.js still
// renders into #searchResults, we only toggle visibility, so nothing fights.
function _setResultsHidden(hidden) {
  const results = $('#searchResults');
  if (results) results.style.display = hidden ? 'none' : '';
  const more = $('#searchLoadMore');
  // Restore symmetrically: hiding it and never putting it back left load-more /
  // infinite scroll dead for the rest of the session after clearing the input.
  if (more) more.style.display = hidden ? 'none' : (store.searchHasMore ? '' : 'none');
}

// router.js resets `#searchResults` to display:'' whenever the search page is
// (re)shown — returning from the imported playlist's detail view, or navigating
// back to Search from the nav. Re-assert the hide so the banner doesn't end up
// stacked on top of the empty "no results" state for the pasted URL.
function reassertResultsHidden() {
  const el = bannerEl();
  if (el && el.style.display !== 'none' && _bannerKey) _setResultsHidden(true);
}

// Exported so router.js can dismiss the banner when it sets #searchInput
// programmatically (searchFor), which fires no `input` event.
export function hideBanner() {
  const el = bannerEl();
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
  _bannerKey = '';
  _setResultsHidden(false);
}

function renderBannerLoading(link) {
  const el = bannerEl();
  if (!el) return;
  el.innerHTML = `
    <div class="import-banner-thumb import-banner-thumb--empty"></div>
    <div class="import-banner-info">
      <div class="import-banner-title">Reading ${esc(SOURCE_LABEL[link.source] || link.source)} ${esc(link.kind)}…</div>
      <div class="import-banner-meta">Fetching the track list</div>
    </div>`;
  el.style.display = '';
  _setResultsHidden(true);
}

// A 400 means "not a playlist link" — a one-line hint, not a broken banner.
function renderBannerHint(msg) {
  const el = bannerEl();
  if (!el) return;
  el.innerHTML = `<div class="import-banner-hint">${esc(msg)}</div>`;
  el.style.display = '';
  _setResultsHidden(false);
}

function renderBanner(data) {
  const el = bannerEl();
  if (!el) return;
  const count = data.tracks ? data.tracks.length : 0;
  el.innerHTML = `
    ${data.image
      ? `<img class="import-banner-thumb" src="${escAttr(data.image)}" alt="" loading="lazy" onerror="this.removeAttribute('src');this.classList.add('import-banner-thumb--empty')">`
      : `<div class="import-banner-thumb import-banner-thumb--empty"></div>`}
    <div class="import-banner-info">
      <div class="import-banner-title">${esc(data.name || 'Imported playlist')}</div>
      <div class="import-banner-meta">${count} track${count === 1 ? '' : 's'} &middot; ${esc(sourceLabel(data))}</div>
      ${data.truncated && data.note
        ? `<div class="import-banner-note"><span>${esc(data.note)}</span><button type="button" class="import-banner-notebtn">Paste track links…</button></div>`
        : ''}
    </div>
    <div class="import-banner-actions">
      <button type="button" class="import-btn import-btn-primary" data-import-act="play">&#9654; Play all</button>
      <button type="button" class="import-btn" data-import-act="queue">+ Add to queue</button>
      <button type="button" class="import-btn" data-import-act="open">Open</button>
      <button type="button" class="import-btn" data-import-act="download">Download all</button>
    </div>`;
  el.style.display = '';
  _setResultsHidden(true);

  el.querySelectorAll('[data-import-act]').forEach(btn => {
    btn.addEventListener('click', () => runBannerAction(btn.dataset.importAct, data));
  });
  const noteBtn = el.querySelector('.import-banner-notebtn');
  if (noteBtn) noteBtn.addEventListener('click', () => openImportModalForTruncated(data));
}

// Player-shaped tracks. Nothing here downloads: playTracks / addToQueue only
// touch the queue, and the backend streams whatever isn't in the library.
function tracksFor(data) {
  return (data.tracks || []).map(t => ({
    name: t.name,
    artist: t.artist || '',
    album: t.album || '',
    image: t.image || '',
    duration_ms: t.duration_ms || 0,
    type: 'track',
  }));
}

async function runBannerAction(act, data) {
  const tracks = tracksFor(data);
  if (!tracks.length) { showToast('Nothing to play — the import came back empty'); return; }
  if (act === 'play') {
    const m = await import('./upnext.js');
    await m.playTracks(tracks);           // replaces the queue and starts playing
  } else if (act === 'queue') {
    const m = await getPlayerModule();
    m.addToQueue(tracks);                 // append; showToast comes from the player
  } else if (act === 'open') {
    openImported(data, 'search');
  } else if (act === 'download') {
    // The download modal builds its playlist job from store.currentPlaylistTracks
    // (see downloads.js #modalDownload), which is what the playlist detail view
    // publishes — so publish the imported list the same way before opening it.
    store.currentPlaylistTracks = tracks.map(t => ({ name: t.name, artist: t.artist, album: t.album, image: t.image }));
    openModal({
      name: data.name || 'Imported playlist',
      artist: 'Playlist',
      image: data.image || '',
      url: data.url || '',
      type: 'playlist',
    });
  }
}

// Render an import in the shared playlist detail view, wiring the truncation
// escape hatch so it's one click from there too.
function openImported(data, fromPage) {
  showImportedPlaylist({
    ...data,
    note: data.truncated ? data.note : '',
    onImportMore: data.truncated ? () => openImportModalForTruncated(data) : null,
    importMoreLabel: 'Paste track links…',
  }, fromPage);
}

// ── The "grab the whole playlist" helper ──
// A Spotify link alone can never give us more than 100 tracks: the public embed
// page carries only the first 100 and ignores offset/limit. The web player gets
// the rest from a private, TOTP-signed endpoint whose own response says using it
// is "not permitted under the Spotify Developer Terms" — so we don't replicate
// it server-side. Instead the USER runs this in their own browser, on the page
// they legitimately opened, and pastes the resulting links into the import box.
//
// Shipped as source text (via Function.prototype.toString) rather than a string
// literal so there is nothing to escape and `node --check` validates it. It runs
// on open.spotify.com, so it must stay 100% self-contained — no imports, no
// globals of ours, no throwing on a page that isn't a playlist.
async function harvestSpotifyPlaylist() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const seen = new Set();

  const grab = () => document.querySelectorAll('a[href*="/track/"]').forEach(a => {
    const m = (a.getAttribute('href') || '').match(/\/track\/([A-Za-z0-9]{22})/);
    if (m) seen.add('https://open.spotify.com/track/' + m[1]);
  });

  // The track list is virtualised: only the visible rows exist in the DOM, so
  // the tallest scrollable element has to be scrolled to page the rest in.
  const scroller = () => [...document.querySelectorAll('*')]
    .filter(e => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
    'padding:10px 14px;border-radius:10px;background:#1db954;color:#000;' +
    'font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
  const say = (text) => { hud.textContent = 'MusicSeeker: ' + text; };
  say('scanning…');
  document.body.appendChild(hud);

  grab();
  let stagnant = 0, prev = 0;
  for (let i = 0; i < 200 && stagnant < 8; i++) {
    const el = scroller();
    if (el) el.scrollTop += el.clientHeight * 0.85; else window.scrollBy(0, 900);
    await sleep(550);
    grab();
    if (seen.size === prev) stagnant++; else stagnant = 0;
    prev = seen.size;
    say('collected ' + seen.size + ' tracks…');
  }
  hud.remove();

  if (!seen.size) {
    alert('MusicSeeker: no track links found on this page.\n\n' +
      'Open a Spotify playlist or album page, let it load, then run this again.');
    return;
  }

  const list = [...seen].join('\n');
  // Clipboard fallback: a readonly textarea, focused and selected, so Ctrl+C works.
  const manualCopy = () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;padding:24px;' +
      'background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#121212;color:#fff;border-radius:12px;padding:16px;' +
      'width:640px;max-width:100%;font:13px/1.5 system-ui,sans-serif';
    const label = document.createElement('div');
    label.style.cssText = 'font-weight:600;margin-bottom:10px';
    label.textContent = 'MusicSeeker: ' + seen.size + ' track links. Press Ctrl+C ' +
      '(Cmd+C on a Mac) to copy, then click outside this box to close it.';
    const field = document.createElement('textarea');
    field.readOnly = true;
    field.value = list;
    field.style.cssText = 'width:100%;height:40vh;background:#000;color:#eee;' +
      'border:1px solid #333;border-radius:8px;padding:10px;font:12px/1.4 monospace';
    box.appendChild(label);
    box.appendChild(field);
    wrap.appendChild(box);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
    field.focus();
    field.select();
  };

  try {
    await navigator.clipboard.writeText(list);
    alert('MusicSeeker: copied ' + seen.size + ' track links to the clipboard.\n\n' +
      'Paste them into the MusicSeeker import box.');
  } catch (e) {
    manualCopy();
  }
}

// Console form: paste, press Enter. Bookmarklet form: `void` keeps the returned
// promise from replacing the page in browsers that navigate on a truthy result.
const HARVEST_SNIPPET = '(' + String(harvestSpotifyPlaylist) + ')();';
const HARVEST_BOOKMARKLET = 'javascript:' + encodeURIComponent('void (' + String(harvestSpotifyPlaylist) + ')();');

const HARVEST_STEPS = [
  'Copy the helper below.',
  'Open the playlist on open.spotify.com in a browser tab and let the page load.',
  'Open the browser console (F12 → Console), paste the helper and press Enter.',
  'Wait — it scrolls the list itself and reports how many tracks it found.',
  'Come back here and paste the copied links into the box above.',
];

// Reveal `field` with `text` pre-selected. The manual path for every clipboard
// refusal (no permission, no secure context, an older browser).
function revealForManualCopy(field, text) {
  field.value = text;
  field.style.display = '';
  autoFocus(field, { select: true });
}

async function copyHelper(text, label, field) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard API');
    await navigator.clipboard.writeText(text);
    field.style.display = 'none';
    showToast(`${label} copied to the clipboard`);
  } catch (e) {
    revealForManualCopy(field, text);
    showToast(`Couldn't reach the clipboard — the ${label.toLowerCase()} is selected below, press Ctrl+C`, true);
  }
}

// Built with DOM APIs on purpose: the snippet and the bookmarklet both contain
// quotes, so interpolating them into innerHTML would break out of the attribute.
function buildHarvestHelper() {
  const box = document.createElement('details');
  box.className = 'import-helper';

  const summary = document.createElement('summary');
  summary.className = 'import-helper-summary';
  summary.textContent = 'More than 100 tracks? Grab the whole list…';
  box.appendChild(summary);

  const why = document.createElement('p');
  why.className = 'import-helper-why';
  why.textContent = 'A Spotify playlist link alone gives at most 100 tracks. ' +
    'This helper grabs the whole list from the playlist page in your own browser.';
  box.appendChild(why);

  const steps = document.createElement('ol');
  steps.className = 'import-helper-steps';
  HARVEST_STEPS.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    steps.appendChild(li);
  });
  box.appendChild(steps);

  const field = document.createElement('textarea');
  field.className = 'import-helper-field';
  field.readOnly = true;
  field.rows = 4;
  field.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'import-helper-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'import-btn';
  copyBtn.textContent = 'Copy helper';
  copyBtn.addEventListener('click', () => copyHelper(HARVEST_SNIPPET, 'Helper', field));
  const markBtn = document.createElement('button');
  markBtn.type = 'button';
  markBtn.className = 'import-btn';
  markBtn.textContent = 'Copy as bookmarklet';
  markBtn.addEventListener('click', () => copyHelper(HARVEST_BOOKMARKLET, 'Bookmarklet', field));
  actions.appendChild(copyBtn);
  actions.appendChild(markBtn);
  box.appendChild(actions);

  const markHint = document.createElement('p');
  markHint.className = 'import-helper-why';
  markHint.textContent = 'The bookmarklet is the same helper as a bookmark: paste it as a ' +
    'new bookmark’s address, then it’s one click on the playlist page next time.';
  box.appendChild(markHint);

  box.appendChild(field);
  return box;
}

// ── Import modal (link OR pasted track links / "Artist - Title" lines) ──
// utils.js has no multi-line modal (showInputModal is single-line and
// showPlaylistFormModal is a name+description form), so this is a local one in
// the same overlay style.
function showImportModal({ hint = '', prefill = '' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);';
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-card);border-radius:16px;padding:20px;min-width:280px;max-width:460px;width:calc(100vw - 32px);display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,.5);';
    modal.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:10px;">Import playlist</div>
      <div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:10px;">
        ${hint ? `${esc(hint)}<br>` : ''}Paste a Spotify or Deezer playlist/album link — or the playlist's track links (in Spotify: select all &rarr; Copy links), one per line. Plain <em>Artist - Title</em> lines work too.
      </div>
      <textarea class="import-modal-field" rows="6" placeholder="https://open.spotify.com/playlist/…" style="padding:11px 12px;border:1px solid var(--border);background:var(--bg-elevated);color:var(--text);border-radius:10px;font-size:13px;outline:none;resize:vertical;font-family:inherit;"></textarea>
      <div class="import-modal-actions" style="display:flex;gap:8px;margin-top:14px;">
        <button class="import-modal-ok" style="flex:1;padding:10px;border:none;background:var(--accent);color:#000;border-radius:10px;cursor:pointer;font-size:13px;font-weight:600;">Import</button>
        <button class="import-modal-cancel" style="flex:1;padding:10px;border:1px solid var(--border);background:none;color:var(--text-muted);border-radius:10px;cursor:pointer;font-size:13px;">Cancel</button>
      </div>`;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    // Secondary and collapsed, but always available: the 100-track ceiling isn't
    // visible until after an import, and the user may want it before pasting.
    modal.insertBefore(buildHarvestHelper(), modal.querySelector('.import-modal-actions'));
    const field = modal.querySelector('.import-modal-field');
    field.value = prefill || '';
    const done = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const submit = () => { const v = field.value.trim(); done(v || null); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      // Enter inserts a newline (multi-line input); Ctrl/Cmd+Enter submits.
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    modal.querySelector('.import-modal-ok').addEventListener('click', submit);
    modal.querySelector('.import-modal-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    setTimeout(() => autoFocus(field), 30);
  });
}

// Entry point for the Library "Import playlist…" button and the truncation note.
export async function openImportModal(opts = {}) {
  const text = await showImportModal(opts);
  if (!text) return;
  await runImport(text);
}

function openImportModalForTruncated(data) {
  const total = data.total || (data.tracks || []).length;
  return openImportModal({
    hint: `Paste the playlist's track links to import all ${total > 0 ? 'of the ' : ''}tracks — the public page only gave us ${total}.`,
  });
}

// Sniff which endpoint the pasted blob wants: a playlist/album link anywhere in
// it → the collection import; anything else (track links, "Artist - Title"
// lines) → the per-track import.
export async function runImport(text) {
  const link = parseCollectionLink(text);
  showToast('Importing…');
  try {
    if (link) {
      const data = await apiJson('/api/import/playlist', { method: 'POST', body: { url: text.trim() } });
      openImported({ ...data, url: firstUrlIn(text) || '' }, store.currentPage);
      return data;
    }
    const data = await apiJson('/api/import/tracks', { method: 'POST', body: { text } });
    const tracks = data.tracks || [];
    if (!tracks.length) {
      showToast('Nothing recognised in that text', true);
      return data;
    }
    // Surface every way the backend can return less than what was pasted —
    // silently handing back a short list is the bug class this feature exists to
    // avoid. `capped` = the paste exceeded the per-request entry limit,
    // `timed_out` = the resolve deadline hit and these are partial results.
    if (data.capped || data.timed_out) {
      showToast(data.capped
        ? `Imported the first ${tracks.length} tracks — paste the rest separately`
        : `Imported ${tracks.length} of ${data.requested} tracks before timing out — try again for the rest`, true);
    } else if (data.failed) {
      showToast(`Imported ${tracks.length} of ${data.requested} tracks`);
    }
    const shortfall = data.capped || data.timed_out;
    openImported({
      source: 'paste',
      kind: 'playlist',
      id: 'paste',
      name: `Imported tracks (${tracks.length})`,
      image: tracks[0] ? tracks[0].image : '',
      tracks,
      total: tracks.length,
      truncated: !!shortfall,
      note: shortfall
        ? (data.capped
            ? `Only the first ${tracks.length} pasted entries were imported. Paste the remainder as a second import.`
            : `Resolving timed out after ${tracks.length} of ${data.requested} tracks. Paste the remainder as a second import.`)
        : '',
      url: '',
    }, store.currentPage);
    return data;
  } catch (e) {
    showToast(e.message || 'Import failed', true);
    return null;
  }
}

// The banner/detail "source link" we show and hand to the download job: the
// first http(s) URL in the pasted text, since the user may have pasted a whole
// sentence around it.
function firstUrlIn(text) {
  const m = String(text || '').match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[)\]}.,]+$/, '') : '';
}

// ── Paste-a-URL-into-search detection ──
// Our own listener on #searchInput. It never calls preventDefault and never
// clears or rewrites the input — search.js's listener keeps running exactly as
// before (it just searches for a URL and finds nothing, which is why the banner
// hides #searchResults while it's up).
function onSearchInputChanged() {
  const input = $('#searchInput');
  if (!input) return;
  const raw = input.value || '';
  const link = parseCollectionLink(raw);
  if (!link) {
    clearTimeout(_debounceTimer);
    // A track link pasted into search isn't a collection — point at the modal
    // rather than silently doing nothing.
    if (TRACK_LINK_RE.test(raw)) {
      _bannerKey = '';
      renderBannerHint('That\'s a track link — use Library → Import playlist… to import a list of them.');
      return;
    }
    hideBanner();
    return;
  }
  const key = `${link.source}:${link.kind}:${link.id}`;
  // Same link already shown or in flight — return WITHOUT touching the pending
  // timer. A real paste fires `input` and then `paste`, so this runs twice for
  // one action; clearing the timer here (as it used to) cancelled the scheduled
  // import and left the banner stuck on "Loading…" for every actual paste.
  if (key === _bannerKey) return;
  clearTimeout(_debounceTimer);
  // Cancel search.js's own debounced search for this value: it would run a real
  // query for the raw URL (finding nothing) and persist the whole link as a
  // recent-search chip. This is the one case where pre-empting it is correct.
  clearTimeout(store.searchTimeout);
  _bannerKey = key;
  renderBannerLoading(link);
  // Debounced: a URL typed (or dictated) character by character parses as soon
  // as the id is long enough, so only the settled value should hit the API.
  const gen = ++_bannerGen;
  _debounceTimer = setTimeout(() => importForBanner(raw.trim(), key, gen), 450);
}

async function importForBanner(url, key, gen) {
  try {
    const data = await apiJson('/api/import/playlist', { method: 'POST', body: { url } });
    if (gen !== _bannerGen || key !== _bannerKey) return;  // superseded
    renderBanner({ ...data, url });
  } catch (e) {
    if (gen !== _bannerGen || key !== _bannerKey) return;
    renderBannerHint(e.message || 'Not a playlist link');
  }
}

// ── Init (called from app.js) ──
export function init() {
  const input = $('#searchInput');
  if (input) {
    input.addEventListener('input', onSearchInputChanged);
    // 'paste' fires before the value updates, so read it on the next tick. The
    // browser also fires 'input' right after — onSearchInputChanged is
    // idempotent for an unchanged link, so the duplicate call is free.
    input.addEventListener('paste', () => setTimeout(onSearchInputChanged, 0));
  }
  const clear = $('#searchClear');
  if (clear) clear.addEventListener('click', hideBanner);

  // Both paths that re-show the search page (back out of the playlist detail
  // view, or tap Search in the nav) reset #searchResults' inline display.
  window.addEventListener('popstate', () => setTimeout(reassertResultsHidden, 0));
  document.addEventListener('click', (e) => {
    if (e.target.closest('.nav-btn[data-page="search"], .bnav-btn[data-page="search"]')) {
      setTimeout(reassertResultsHidden, 0);
    }
  });
}
