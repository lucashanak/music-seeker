// app.js — Main entry point (type="module")
// Imports and initializes all modules.

import { init as initAuth } from './auth.js';
import { init as initRouter, registerPageLoader, setCloseHandlers } from './router.js';
import { init as initSearch } from './search.js';
import { init as initSpotify, loadPlaylists, closePlaylistDetail, closeShowDetail, closeArtistDetail, closeAlbumDetail } from './spotify.js';
import { init as initDiscover, loadTags, closeTagDetail } from './discover.js';
import { init as initDownloads } from './downloads.js';
// Dynamic player engine selection (classic/dj) — resolved via player_active.js
// so every cross-module caller shares this exact engine instance.
import { getPlayerModule } from './player_active.js';
const _playerModule = await getPlayerModule();
const { init: initPlayer, loadAndPlay, hidePlayerBar, saveQueueDebounced, nextTrack, prevTrack, updatePlayPauseIcon, audio, getAudio } = _playerModule;
import { init as initQueue, setPlayerRefs as setQueuePlayerRefs } from './queue.js';
import { init as initFullPlayer, setPlayerRefs as setFpPlayerRefs } from './fullplayer.js';
import { init as initRadio } from './radio.js';
import { init as initFavorites, loadFavorites } from './favorites.js';
import { init as initPodcasts, loadPodcasts, closePodcastShow } from './podcasts.js';
import { init as initSettings, loadSettings } from './settings.js';
import { init as initRecognize } from './recognize.js';
import { init as initLibrary, loadLibraryPage, closeLibraryDetail, closeLikedSongs } from './library.js';
import { init as initRecommendations } from './recommendations.js';
import { initVirtualKeyboard } from './utils.js';

// ── Wire up cross-module references ──

// Queue module needs player functions (avoids circular import)
setQueuePlayerRefs({ loadAndPlay, hidePlayerBar, saveQueueDebounced, audio, getAudio });

// Full player module needs player functions (avoids circular import)
setFpPlayerRefs({ nextTrack, prevTrack, loadAndPlay, hidePlayerBar, saveQueueDebounced, updatePlayPauseIcon, audio, getAudio });

// Router needs close handlers for popstate
setCloseHandlers({
  closePlaylistDetail,
  closeShowDetail,
  closePodcastShow,
  closeTagDetail,
  closeArtistDetail,
  closeAlbumDetail,
  closeLibraryDetail,
  closeLikedSongs,
});

// Register page loaders with router.
// playlists/podcasts/favorites are no longer standalone pages — they are Library
// sub-tabs driven by library.js (loaded lazily via switchLibraryTab). Their
// init()s below still run so their event wiring is set up at startup.
registerPageLoader('discover', loadTags);
registerPageLoader('settings', loadSettings);
registerPageLoader('library', loadLibraryPage);

// ── Initialize all modules ──
initRouter();
initSearch();
initSpotify();
initDiscover();
initDownloads();
initPlayer();
initQueue();
initFullPlayer();
initRadio();
initFavorites();
initPodcasts();
initSettings();
initRecognize();
initLibrary();
initRecommendations();
initVirtualKeyboard();

// Auth init last (triggers initApp which depends on everything above)
initAuth();
