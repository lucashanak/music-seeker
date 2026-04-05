// app.js — Main entry point (type="module")
// Imports and initializes all modules.

import { init as initAuth } from './auth.js';
import { init as initRouter, registerPageLoader, setCloseHandlers } from './router.js';
import { init as initSearch } from './search.js';
import { init as initSpotify, loadPlaylists, closePlaylistDetail, closeShowDetail, closeArtistDetail } from './spotify.js';
import { init as initDiscover, loadTags, closeTagDetail } from './discover.js';
import { init as initDownloads } from './downloads.js';
// Dynamic player engine selection (classic or crossfade) — fallback to classic on error
let _playerModule;
try {
  const _playerEngine = localStorage.getItem('ms_player_engine') || 'classic';
  if (_playerEngine === 'dj') {
    _playerModule = await import('./player_v3.js');
  } else if (_playerEngine === 'crossfade') {
    _playerModule = await import('./player_v2.js');
  } else {
    _playerModule = await import('./player.js');
  }
} catch (e) {
  console.error('Player engine load failed, falling back to classic:', e);
  _playerModule = await import('./player.js');
}
const { init: initPlayer, loadAndPlay, hidePlayerBar, saveQueueDebounced, nextTrack, prevTrack, updatePlayPauseIcon, audio, getAudio } = _playerModule;
import { init as initQueue, setPlayerRefs as setQueuePlayerRefs } from './queue.js';
import { init as initFullPlayer, setPlayerRefs as setFpPlayerRefs } from './fullplayer.js';
import { init as initRadio } from './radio.js';
import { init as initFavorites, loadFavorites } from './favorites.js';
import { init as initPodcasts, loadPodcasts, closePodcastShow } from './podcasts.js';
import { init as initSettings, loadSettings } from './settings.js';
import { init as initRecognize } from './recognize.js';
import { init as initGestures } from './gestures.js';
import { init as initLibrary, loadLibrary, closeLibraryDetail } from './library.js';
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
  closeLibraryDetail,
});

// Register page loaders with router
registerPageLoader('discover', loadTags);
registerPageLoader('playlists', loadPlaylists);
registerPageLoader('podcasts', loadPodcasts);
registerPageLoader('favorites', loadFavorites);
registerPageLoader('settings', loadSettings);
registerPageLoader('library', loadLibrary);

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
initLibrary();
initRecommendations();
initVirtualKeyboard();

// Auth init last (triggers initApp which depends on everything above)
initAuth();
