// app.js — Main entry point (type="module")
// Imports and initializes all modules.

import { init as initAuth } from './auth.js';
import { init as initRouter, registerPageLoader, setCloseHandlers } from './router.js';
import { init as initSearch } from './search.js';
import { init as initSpotify, loadPlaylists, closePlaylistDetail, closeShowDetail, closeArtistDetail } from './spotify.js';
import { init as initDiscover, loadTags, closeTagDetail } from './discover.js';
import { init as initDownloads } from './downloads.js';
import { init as initPlayer, loadAndPlay, hidePlayerBar, saveQueueDebounced, nextTrack, prevTrack, updatePlayPauseIcon, audio } from './player.js';
import { init as initQueue, setPlayerRefs as setQueuePlayerRefs } from './queue.js';
import { init as initFullPlayer, setPlayerRefs as setFpPlayerRefs } from './fullplayer.js';
import { init as initRadio } from './radio.js';
import { init as initFavorites, loadFavorites } from './favorites.js';
import { init as initPodcasts, loadPodcasts, closePodcastShow } from './podcasts.js';
import { init as initSettings, loadSettings } from './settings.js';
import { init as initRecognize } from './recognize.js';
import { init as initGestures } from './gestures.js';
import { initVirtualKeyboard } from './utils.js';

// ── Wire up cross-module references ──

// Queue module needs player functions (avoids circular import)
setQueuePlayerRefs({ loadAndPlay, hidePlayerBar, saveQueueDebounced, audio });

// Full player module needs player functions (avoids circular import)
setFpPlayerRefs({ nextTrack, prevTrack, loadAndPlay, hidePlayerBar, saveQueueDebounced, updatePlayPauseIcon, audio });

// Router needs close handlers for popstate
setCloseHandlers({
  closePlaylistDetail,
  closeShowDetail,
  closePodcastShow,
  closeTagDetail,
  closeArtistDetail,
});

// Register page loaders with router
registerPageLoader('discover', loadTags);
registerPageLoader('playlists', loadPlaylists);
registerPageLoader('podcasts', loadPodcasts);
registerPageLoader('favorites', loadFavorites);
registerPageLoader('settings', loadSettings);

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
initGestures();
initVirtualKeyboard();

// Auth init last (triggers initApp which depends on everything above)
initAuth();
