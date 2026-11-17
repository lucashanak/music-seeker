// router.js — Page switching, searchFor, historyBack, popstate handler

import { store } from './store.js';
import { $, $$, historyBack } from './utils.js';
import { closeModal, closePanel, openPanel } from './downloads.js';
import { closeFullPlayer } from './fullplayer.js';
import { closeQueuePanel, closeFpQueuePanel } from './queue.js';
import { doSearch } from './search.js';
import { closeParty } from './party.js';

// ── Page Loader Registry ──
const pageLoaders = {};
export function registerPageLoader(page, loader) {
  pageLoaders[page] = loader;
}

// Overlay layers that live inside a page rather than beside it. Both the page
// switch (which hides them) and the Back handler (which closes the visible one)
// work from this one list, so neither can quietly fall behind the other.
const LAYER_IDS = [
  '#playlistDetail', '#showDetail', '#podcastEpisodes', '#tagDetailView',
  '#artistDetail', '#albumDetail', '#libraryDetail', '#likedSongsDetail',
];

// ── Switch Page ──
export function switchPage(page, fromPopstate) {
  if (page === 'downloads') {
    store.panelOpen ? closePanel() : openPanel();
    return;
  }
  // Backward-compat: the former "My Spotify", "My Podcasts" and "Favorites"
  // pages are now sub-tabs inside Library. Redirect any legacy switchPage call
  // to Library and select the matching sub-tab.
  const legacyLibTab = { playlists: 'spotify', podcasts: 'podcasts', favorites: 'favorites' };
  if (legacyLibTab[page]) {
    switchPage('library', fromPopstate);
    import('./library.js').then(m => m.switchLibraryTab && m.switchLibraryTab(legacyLibTab[page]));
    return;
  }
  if (page === store.currentPage) {
    // Opening a playlist from search reveals #playlistDetail *inside* Library and
    // sets currentPage='library', so a later "Library" nav click used to hit this
    // early return and do nothing — the button looked dead. Dismiss that overlay
    // and re-run the page loader instead. We deliberately don't call
    // closePlaylistDetail(): that would navigate back to the detail's source page
    // (e.g. Search), which is not what clicking "Library" asks for.
    const pd = $('#playlistDetail');
    if (page === 'library' && pd && pd.offsetParent !== null) {
      pd.style.display = 'none';
      if ($('#spotifyLibrary')) $('#spotifyLibrary').style.display = '';
      store.playlistDetailSource = null;
      // Consume the detail's pushed {layer:'playlistDetail'} entry. Without this
      // the next Back press lands on it, finds the overlay already closed and
      // does nothing — i.e. one swallowed Back.
      history.replaceState({ page }, '');
      if (pageLoaders[page]) pageLoaders[page]();
    }
    return;
  }
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
  $('#pageSettings').style.display = page === 'settings' ? '' : 'none';
  // #pagePlaylists / #pagePodcasts / #pageFavorites are now sub-views inside
  // #pageLibrary, toggled by library.js switchLibraryTab — not at page level.
  if ($('#pageLibrary')) $('#pageLibrary').style.display = page === 'library' ? '' : 'none';
  // Every one of these layers lives *inside* a page, so hiding the page leaves
  // it marked visible. Leaving it that way is how Back used to skip a level:
  // the popstate handler found a layer that was still "open" on a page nobody
  // was looking at, closed that instead, and the press never reached the page.
  LAYER_IDS.forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
  if (page === 'search') {
    $('#searchResults').style.display = '';
  }
  if (page === 'library') {
    if ($('#libraryList')) $('#libraryList').style.display = '';
  }
  // Call registered page loaders
  if (pageLoaders[page]) pageLoaders[page]();
}

// ── Search For (used by clickable elements) ──
export function searchFor(query, type) {
  switchPage('search');
  // switchPage no-ops if already on search; explicitly reset detail sub-views
  // so an open artist/album/show detail doesn't cover the fresh results.
  $('#showDetail').style.display = 'none';
  if ($('#artistDetail')) $('#artistDetail').style.display = 'none';
  if ($('#albumDetail')) $('#albumDetail').style.display = 'none';
  $('#searchResults').style.display = '';
  $('#searchInput').value = query;
  // Setting .value fires no `input` event, so the playlist-import banner would
  // otherwise stay up (with live Play/Download buttons for the old import)
  // above these unrelated results.
  import('./playlistimport.js').then(m => m.hideBanner && m.hideBanner()).catch(() => {});
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

let closePlaylistDetail, closeShowDetail, closePodcastShow, closeTagDetail, closeArtistDetail, closeAlbumDetail, closeLibraryDetail, closeLikedSongs;

export function setCloseHandlers(handlers) {
  closePlaylistDetail = handlers.closePlaylistDetail;
  closeShowDetail = handlers.closeShowDetail;
  closePodcastShow = handlers.closePodcastShow;
  closeTagDetail = handlers.closeTagDetail;
  closeArtistDetail = handlers.closeArtistDetail;
  closeAlbumDetail = handlers.closeAlbumDetail;
  closeLibraryDetail = handlers.closeLibraryDetail;
  closeLikedSongs = handlers.closeLikedSongs;
}

// ── Popstate Handler ──

// How many spent {layer} entries a single Back press may step over before we
// stop and put the user on a page instead. One per layer that can push an entry
// (eight details, dialog, party, genre, and the five overlay flags) plus slack.
const MAX_LAYER_HOPS = 16;
let layerHops = 0;

// Is this in-page layer actually on screen? offsetParent goes null the moment
// any ancestor is hidden, which style.display cannot see: a detail marked
// visible inside a hidden <main> still reads `!== 'none'` and used to eat the
// Back press meant for the page the user was looking at.
const onScreen = (sel) => { const el = $(sel); return !!el && el.offsetParent !== null; };

function handlePopstate(e) {
  if (store._ignorePopstate) { store._ignorePopstate = false; return; }
  const hops = layerHops;  // consumed here; only the spent-entry branch re-arms it
  layerHops = 0;
  const state = e.state;
  // Dialogs first: they sit on top of every other overlay, so Back has to reach
  // them first. Closing goes through the dialog's own cancel path, which also
  // settles the Promise its caller is awaiting.
  const dialogs = store.dialogStack;
  if (dialogs && dialogs.length) { dialogs[dialogs.length - 1].cancel(true); return; }
  // Close overlays next
  if (store.fpQueuePanelOpen) { closeFpQueuePanel(true); return; }
  if (store.queuePanelOpen) { closeQueuePanel(true); return; }
  if (store.fullPlayerOpen) { closeFullPlayer(true); return; }
  if (store.modalItem) { closeModal(true); return; }
  if (store.panelOpen) { closePanel(true); return; }
  if (store.partyOpen) { closeParty(true); return; }
  // Any remaining overlay that keeps no flag of its own (the three settings
  // dialogs, playlist import). It is a .modal-overlay, so it is painted at
  // z-index 200 — over every in-page layer below. That is why the test has to
  // stand here and not under them: with a detail open behind it, Back used to
  // close the detail at the back, switch the page, and leave the dialog
  // hanging over a screen it no longer belonged to.
  // Only #downloadModal exists in the static markup (and is excluded); every
  // other .modal-overlay is built when it opens and removed when it closes, so
  // finding one means one is genuinely up.
  const epDialog = document.querySelector('.modal-overlay:not(#downloadModal)');
  if (epDialog) { epDialog.remove(); return; }
  // Sub-page navigation
  if (onScreen('#playlistDetail') && closePlaylistDetail) { closePlaylistDetail(true); return; }
  if (onScreen('#showDetail') && closeShowDetail) { closeShowDetail(true); return; }
  if (onScreen('#podcastEpisodes') && closePodcastShow) { closePodcastShow(true); return; }
  if (onScreen('#tagDetailView') && closeTagDetail) { closeTagDetail(true); return; }
  if (onScreen('#artistDetail') && closeArtistDetail) { closeArtistDetail(true); return; }
  if (onScreen('#albumDetail') && closeAlbumDetail) { closeAlbumDetail(true); return; }
  if (onScreen('#libraryDetail') && closeLibraryDetail) { closeLibraryDetail(true); return; }
  if (onScreen('#likedSongsDetail') && closeLikedSongs) { closeLikedSongs(true); return; }
  // The genre chart replaces the contents of #searchResults instead of having an
  // element of its own, so there is nothing to measure — its own flag is the
  // only record that it is up.
  if (store.genreOpen) { import('./search.js').then(m => m.closeGenre && m.closeGenre(true)); return; }
  // Guard: prevent exiting the app
  if (!state || state.guard) {
    history.pushState({ page: store.currentPage }, '');
    return;
  }
  // A layer's own entry that nothing above claimed: the layer is already closed,
  // so this entry is spent and stopping here would make the press do nothing.
  // Step over it. The counter is the floor under a corrupt history: rather than
  // walk out of the app we land on the current page and make the entry say so.
  if (state.layer && !state.page) {
    if (hops < MAX_LAYER_HOPS) { layerHops = hops + 1; history.back(); return; }
    history.replaceState({ page: store.currentPage }, '');
    switchPage(store.currentPage, true);
    return;
  }
  // Page navigation
  if (state.page) { switchPage(state.page, true); }
}

// ── Keyboard shortcuts ──
function handleKeydown(e) {
  if (e.key === '/' && $('#loginScreen').style.display === 'none' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    switchPage('search');
    $('#searchInput').focus();
    import('./utils.js').then(m => m.requestNotificationPermission());
  }
  if (e.key === 'Escape') {
    // A dialog on the stack owns Escape (each one has its own document listener): without
    // this the clip editor opened from the queue / full player closed that layer too, and
    // Escape in its time field — which only leaves the field — closed the panel underneath.
    if (store.dialogStack && store.dialogStack.length) return;
    if (store.queuePanelOpen) { closeQueuePanel(); return; }
    if (store.fullPlayerOpen) {
      // Synchronous flag check — decided before any microtask can flip it.
      // Drawer open → close ONLY the drawer; second Esc closes the player.
      if (window.__djPanelOpen) {
        import('./djpanel.js').then(m => m.closeDjPanelFromRouter());
        return;
      }
      closeFullPlayer();
      return;
    }
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
