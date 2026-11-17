// mixlink.js — a Mixcloud / SoundCloud / hearthis.at mix link pasted into Search.
// (A YouTube link is left to the ordinary search: every pasted video is not a mix.)
//
// Why Search and not the Import modal: the Import modal turns a pasted LIST into
// a playlist to play; a mix is ONE recording the user wants to own, and Search is
// where people paste links (playlistimport.js already listens there). The banner
// shows what the link is and offers one action — download that exact file, in the
// quality the site serves (no YouTube search, no conversion).
//
// Recognition mirrors app/services/mixes.parse_mix_url; the server is the judge
// (POST /api/mix/info answers 400 with the reason for anything it refuses).

import { $, esc, escAttr, showToast } from './utils.js';
import { apiJson } from './api.js';
import { openPanel } from './downloads.js';
import { qualityClass } from './mixfilter.js';

const MIXCLOUD_RE = /^https?:\/\/(?:www\.|m\.)?mixcloud\.com\/([^/?#\s]+)\/([^/?#\s]+)\/?(?:[?#]\S*)?$/i;
const SOUNDCLOUD_RE = /^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([^/?#\s]+)\/([^/?#\s]+)(?:\/s-[A-Za-z0-9]+)?\/?(?:[?#]\S*)?$/i;
const SC_SHORT_RE = /^https?:\/\/on\.soundcloud\.com\/[A-Za-z0-9]+\/?(?:[?#]\S*)?$/i;
const HEARTHIS_RE = /^https?:\/\/(?:www\.)?hearthis\.at\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?(?:[?#]\S*)?$/i;

const MIXCLOUD_NOT_USERS = new Set(['discover', 'live', 'upload', 'uploads', 'dashboard', 'settings',
  'select', 'pro', 'categories', 'tag', 'tags', 'search', 'player', 'widget', 'about', 'jobs', 'help']);
const MIXCLOUD_USER_PAGES = new Set(['uploads', 'favorites', 'listens', 'playlists', 'stream',
  'followers', 'following', 'posts', 'reposts', 'shows', 'hosts', 'live', 'select', 'history']);
const SOUNDCLOUD_NOT_USERS = new Set(['discover', 'search', 'you', 'stream', 'charts', 'upload',
  'pages', 'settings', 'messages', 'notifications', 'feed', 'people']);
const SOUNDCLOUD_USER_PAGES = new Set(['sets', 'tracks', 'albums', 'likes', 'reposts', 'followers',
  'following', 'popular-tracks', 'comments', 'spotlight', 'toptracks', 'playlists']);

const HEARTHIS_NOT_USERS = new Set(['search', 'categories', 'category', 'charts', 'live', 'upload',
  'settings', 'messages', 'notifications', 'feed', 'stream', 'explore', 'labels', 'podcasts',
  'playlists', 'set', 'sets', 'login', 'register', 'signup', 'about', 'faq', 'help', 'imprint',
  'terms', 'privacy', 'pro', 'shop', 'api', 'app', 'embed', 'events', 'radio', 'genres', 'tags',
  'maps', 'discover']);
const HEARTHIS_USER_PAGES = new Set(['likes', 'playlists', 'set', 'sets', 'followers', 'following',
  'reshares', 'tracks', 'albums', 'events', 'about', 'comments', 'listen', 'download', 'embed',
  'fans', 'podcast']);

const LABEL = { mixcloud: 'Mixcloud', soundcloud: 'SoundCloud', hearthis: 'hearthis.at' };

/** { source, url } for a single-mix link (the first URL in `text`), else null. */
export function parseMixLink(text) {
  const m = String(text || '').match(/https?:\/\/\S+/);
  if (!m) return null;
  const url = m[0].replace(/[)\]}.,>"']+$/, '');
  let r = url.match(MIXCLOUD_RE);
  if (r) {
    if (MIXCLOUD_NOT_USERS.has(r[1].toLowerCase()) || MIXCLOUD_USER_PAGES.has(r[2].toLowerCase())) return null;
    return { source: 'mixcloud', url };
  }
  r = url.match(SOUNDCLOUD_RE);
  if (r) {
    if (SOUNDCLOUD_NOT_USERS.has(r[1].toLowerCase()) || SOUNDCLOUD_USER_PAGES.has(r[2].toLowerCase())) return null;
    return { source: 'soundcloud', url };
  }
  if (SC_SHORT_RE.test(url)) return { source: 'soundcloud', url };
  r = url.match(HEARTHIS_RE);
  if (r) {
    if (HEARTHIS_NOT_USERS.has(r[1].toLowerCase()) || HEARTHIS_USER_PAGES.has(r[2].toLowerCase())) return null;
    return { source: 'hearthis', url };
  }
  return null;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** Banner while /api/mix/info runs (yt-dlp needs a few seconds). */
export function renderMixLoading(el, link) {
  el.innerHTML = `
    <div class="import-banner-thumb import-banner-thumb--empty"></div>
    <div class="import-banner-info">
      <div class="import-banner-title">Reading ${esc(LABEL[link.source] || 'mix')} mix…</div>
      <div class="import-banner-meta">Fetching the mix details</div>
    </div>`;
}

/** Banner for a resolved mix, with the one action it offers. The quality is
 * what the download will get, known before anything is downloaded. */
export function renderMixBanner(el, info) {
  const meta = [info.uploader, fmtDuration(info.duration), info.source_label].filter(Boolean).join(' · ');
  const kbps = Number(info.kbps) || 0;
  const badge = info.quality_label
    ? `<span class="mix-q ${qualityClass(kbps)}" data-mix-quality>${esc(info.quality_label)}${info.quality_known === false ? '<span class="mix-q-typ">typ.</span>' : ''}</span>`
    : '';
  const low = kbps && kbps < 128
    ? ` ${esc(info.source_label)} offers this mix only at ${esc(info.quality_label)} — there is no better copy there.`
    : '';
  el.innerHTML = `
    ${info.thumbnail
      ? `<img class="import-banner-thumb" src="${escAttr(info.thumbnail)}" alt="" loading="lazy" onerror="this.removeAttribute('src');this.classList.add('import-banner-thumb--empty')">`
      : `<div class="import-banner-thumb import-banner-thumb--empty"></div>`}
    <div class="import-banner-info">
      <div class="import-banner-title">${esc(info.title || 'Mix')}</div>
      <div class="import-banner-meta">${esc(meta)}${badge ? ` ${badge}` : ''}</div>
      <div class="import-banner-note"><span>${info.in_library
        ? 'Already in your library.'
        : `Saved as the ${esc(info.source_label)} file, in the quality ${esc(info.source_label)} serves — no conversion.${low}`}</span></div>
    </div>
    <div class="import-banner-actions">
      <button type="button" class="import-btn import-btn-primary" data-mix-act="download"${info.in_library ? ' disabled' : ''}>&#8681; Download mix</button>
    </div>`;
  const btn = el.querySelector('[data-mix-act="download"]');
  if (btn) btn.addEventListener('click', () => startMixDownload(info, btn));
}

async function startMixDownload(info, btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    await apiJson('/api/download', {
      method: 'POST',
      body: { url: info.url, title: `${info.uploader} - ${info.title}`, type: 'mix', method: 'yt-dlp' },
    });
    btn.textContent = 'Downloading…';
    openPanel();
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = '&#8681; Download mix';
    showToast('Download failed: ' + (e.message || 'error'), true);
  }
}

export async function fetchMixInfo(url) {
  return apiJson('/api/mix/info', { method: 'POST', body: { url } });
}
