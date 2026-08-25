// store.js — Shared application state
// All global variables extracted from the monolithic script block.

export const store = {
  // ── Version / Providers ──
  APP_VERSION: '1.8.0',
  searchProvider: 'deezer',
  podcastProvider: 'itunes',
  spotifyAvailable: false,
  spotifyStatus: null,
  spotifyUser: true,

  // ── Auth ──
  authToken: localStorage.getItem('ms_token') || '',
  streamToken: null,            // short-lived, stream-scoped token used in stream URLs
  streamTokenInterval: null,
  currentUser: null,

  // ── App Init ──
  jobsInterval: null,

  // ── Page / UI State ──
  currentPage: 'search',
  searchType: 'all',
  searchTimeout: null,
  modalItem: null,
  selectedMethod: 'yt-dlp',
  selectedFormat: 'flac',
  panelOpen: false,

  // ── Playlists ──
  currentPlaylistId: null,
  currentPlaylistUrl: null,
  currentPlaylistTracks: [],
  playlistDetailSource: null,

  // ── Discover ──
  currentTag: null,
  discoverTagType: 'track',
  tagPage: 1,
  tagLoading: false,
  tagHasMore: true,
  allTagResults: [],
  tagNovelty: '',
  tagDepth: '',

  // ── Search ──
  searchOffset: 0,
  searchLoading: false,
  searchHasMore: true,
  searchQuery: '',

  // ── Settings ──
  appSettings: {
    default_format: 'flac',
    default_method: 'yt-dlp',
    search_provider: 'deezer',
    search_fallback: '',
    podcast_provider: 'itunes',
    max_concurrent: 10,
    recommendation_source: 'combined',
  },

  // ── Radio ──
  radioMode: false,
  radioSeedTrack: null,
  radioLoading: false,

  // ── Favorites ──
  favoritedArtistIds: new Set(),
  currentArtistId: null,

  // ── Microphone Recognition ──
  mediaRecorder: null,
  micState: 'idle',
  micStream: null,
  micTimer: null,
  micStopTimer: null,       // handle for the 12s auto-stop timeout (must be cleared on manual stop/reset)
  micAbort: null,           // AbortController for the in-flight /api/recognize request, so Cancel can abort it
  micGen: 0,                // bumped by resetMic(); lets an in-flight attempt detect it has been superseded
  micAudioCtx: null,        // AudioContext backing the live level meter; must be closed in resetMic (Chrome caps ~6 concurrent)
  micLevelTimer: null,      // handle for the RMS level-meter sampling interval

  // ── Recognized Item ──
  recognizedItem: null,

  // ── Spotify Library ──
  spCache: { playlists: null, albums: null, artists: null, podcasts: null },
  activeSpTab: 'playlists',

  // ── Show (Podcast) Detail ──
  currentShowEpisodes: [],
  showDetailSource: null,
  currentShowSpotifyId: '',
  currentShowFeedUrl: '',

  // ── Artist Detail ──
  artistDetailSource: null,
  currentArtistAlbums: [],

  // ── Browser Notifications ──
  notificationsEnabled: false,
  previousJobStates: {},

  // ── Back button / popstate ──
  _ignorePopstate: false,

  // ── Player ──
  playerQueue: [],
  playerIndex: -1,
  playerPlaying: false,
  playerVolume: 1.0,
  queuePanelOpen: false,
  playerSaveTimer: null,

  // ── Playlist Mode ──
  playlistMode: null, // { id, name } or null

  // ── Device Identity ──
  deviceId: localStorage.getItem('ms_device_id') || (() => { const id = crypto.randomUUID?.() || ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); localStorage.setItem('ms_device_id', id); return id; })(),
  deviceName: '',
  deviceOutputMode: 'default', // 'default' | 'local' | 'dlna_only'
  deviceDlnaRendererUrl: '',

  // ── DLNA Cast ──
  castDevice: null, // { id, name } or null
  castPollTimer: null,

  // ── Remote Control ──
  remoteEventSource: null,
  remoteStateTimer: null,
  remoteDevices: {},
  remoteTarget: null,
  remoteReconnectTimer: null,

  // ── Full Player ──
  fullPlayerOpen: false,
  shuffleEnabled: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  fpQueuePanelOpen: false,
};
