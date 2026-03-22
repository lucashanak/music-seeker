// store.js — Shared application state
// All global variables extracted from the monolithic script block.

export const store = {
  // ── Version / Providers ──
  APP_VERSION: '1.8.0',
  searchProvider: 'deezer',
  podcastProvider: 'itunes',
  spotifyAvailable: false,
  spotifyUser: true,

  // ── Auth ──
  authToken: localStorage.getItem('ms_token') || '',
  currentUser: null,

  // ── App Init ──
  jobsInterval: null,

  // ── Page / UI State ──
  currentPage: 'search',
  searchType: 'track',
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

  // ── Full Player ──
  fullPlayerOpen: false,
  shuffleEnabled: false,
  repeatMode: 'off', // 'off' | 'all' | 'one'
  fpQueuePanelOpen: false,
};
