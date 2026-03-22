// router.js — Page switching, searchFor, historyBack, popstate handler

import { store } from './store.js';
import { $, $$, historyBack } from './utils.js';
import { closeModal, closePanel, openPanel } from './downloads.js';
import { closeFullPlayer } from './fullplayer.js';
import { closeQueuePanel, closeFpQueuePanel } from './queue.js';
import { doSearch } from './search.js';

// ── Page Loader Registry ──
const pageLoaders = {};
export function registerPageLoader(page, loader) {
  pageLoaders[page] = loader;
}

// ── Switch Page ──
export function switchPage(page, fromPopstate) {
  if (page === 'downloads') {
    store.panelOpen ? closePanel() : openPanel();
    return;
  }
  if (page === store.currentPage) return;
  if (!fromPopstate) history.pushState({ page }, '');
  // Update desktop nav
  $$('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
  const deskBtn = $(`.nav-btn[data-page="${page}"]`);
  if (deskBtn) deskBtn.classList.add('active');
  // Update mobile nav
  $$('.bnav-btn[data-page]').forEach(b => b.classList.remove('active'));
  const mobBtn = $(`.bnav-btn[data-page="${page}"]`);
  if (mobBtn) mobBtn.classList.add('active');
  store.currentPage = page;
  $('#pageSearch').style.display = page === 'search' ? '' : 'none';
  $('#pageDiscover').style.display = page === 'discover' ? '' : 'none';
  $('#pagePlaylists').style.display = page === 'playlists' ? '' : 'none';
  $('#pagePodcasts').style.display = page === 'podcasts' ? '' : 'none';
  $('#pageFavorites').style.display = page === 'favorites' ? '' : 'none';
  $('#pageSettings').style.display = page === 'settings' ? '' : 'none';
  if (page === 'search') {
    $('#showDetail').style.display = 'none';
    $('#searchResults').style.display = '';
  }
  if (page === 'playlists') {
    $('#spotifyLibrary').style.display = '';
    $('#playlistDetail').style.display = 'none';
  }
  // Call registered page loaders
  if (pageLoaders[page]) pageLoaders[page]();
}

// ── Search For (used by clickable elements) ──
export function searchFor(query, type) {
  switchPage('search');
  $('#searchInput').value = query;
  $('#searchClear').style.display = 'block';
  store.searchType = type;
  $$('.type-btn[data-type]').forEach(b => b.classList.remove('active'));
  const btn = $(`.type-btn[data-type="${type}"]`);
  if (btn) btn.classList.add('active');
  doSearch();
}

// ── Clickable elements (artist/album links in cards) ──
function handleClickableSearch(e) {
  const el = e.target.closest('.clickable[data-search-type]');
  if (!el) return;
  e.stopPropagation();
  if ($('#downloadModal').classList.contains('open')) closeModal();
  searchFor(el.dataset.searchQ, el.dataset.searchType);
}

// ── Close sub-pages ──
// These are imported from their respective modules for popstate handling

let closePlaylistDetail, closeShowDetail, closePodcastShow, closeTagDetail, closeArtistDetail;

export function setCloseHandlers(handlers) {
  closePlaylistDetail = handlers.closePlaylistDetail;
  closeShowDetail = handlers.closeShowDetail;
  closePodcastShow = handlers.closePodcastShow;
  closeTagDetail = handlers.closeTagDetail;
  closeArtistDetail = handlers.closeArtistDetail;
}

// ── Popstate Handler ──
function handlePopstate(e) {
  if (store._ignorePopstate) { store._ignorePopstate = false; return; }
  const state = e.state;
  // Close overlays first (highest priority)
  if (store.fpQueuePanelOpen) { closeFpQueuePanel(true); return; }
  if (store.queuePanelOpen) { closeQueuePanel(true); return; }
  if (store.fullPlayerOpen) { closeFullPlayer(true); return; }
  if (store.modalItem) { closeModal(true); return; }
  if (store.panelOpen) { closePanel(true); return; }
  // Close any edit perms dialog
  const epDialog = document.querySelector('.modal-overlay:not(#downloadModal)');
  if (epDialog) { epDialog.remove(); return; }
  // Sub-page navigation
  if ($('#playlistDetail').style.display !== 'none' && closePlaylistDetail) { closePlaylistDetail(true); return; }
  if ($('#showDetail').style.display !== 'none' && closeShowDetail) { closeShowDetail(true); return; }
  if ($('#podcastEpisodes').style.display !== 'none' && closePodcastShow) { closePodcastShow(true); return; }
  if ($('#tagDetailView').style.display !== 'none' && closeTagDetail) { closeTagDetail(true); return; }
  if ($('#artistDetail').style.display !== 'none' && closeArtistDetail) { closeArtistDetail(true); return; }
  // Guard: prevent exiting the app
  if (!state || state.guard) {
    history.pushState({ page: store.currentPage }, '');
    return;
  }
  // Page navigation
  if (state.page) { switchPage(state.page, true); }
}

// ── Keyboard shortcuts ──
function handleKeydown(e) {
  if (e.key === '/' && !$('#loginScreen').style.display !== 'none' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    switchPage('search');
    $('#searchInput').focus();
    import('./utils.js').then(m => m.requestNotificationPermission());
  }
  if (e.key === 'Escape') {
    if (store.queuePanelOpen) { closeQueuePanel(); return; }
    if (store.fullPlayerOpen) { closeFullPlayer(); return; }
    closeModal();
    closePanel();
  }
}

// ── Init ──
export function init() {
  // Push a guard entry so back button never exits the app
  history.replaceState({ guard: true }, '');
  history.pushState({ page: 'search' }, '');

  document.addEventListener('click', handleClickableSearch);

  $$('.nav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });
  $$('.bnav-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  window.addEventListener('popstate', handlePopstate);
  document.addEventListener('keydown', handleKeydown);
}
