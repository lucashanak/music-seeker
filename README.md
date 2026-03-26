# MusicSeeker

A self-hosted web app for searching, downloading, and playing music. Think Jellyseerr, but for music.

Built with FastAPI + vanilla JS. Runs as a single Docker container. Native apps for macOS and Android.

![Search results](screenshots/search-tracks.png)

## Features

### Search & Discovery
- **Multi-provider search** — Deezer (default, no API key), YouTube Music, or Spotify with automatic fallback
- **Search types** — tracks, albums, artists, playlists, podcasts
- **Discover** — genre-based browsing via Last.fm tags with infinite scroll
- **Artist detail** — discography, radio, follow, bulk download

### Downloads
- **yt-dlp** — YouTube audio in FLAC/MP3 with embedded metadata and album art
- **Soulseek (slskd)** — P2P downloads, auto-selects best quality
- **Lidarr** — torrent-based with artist monitoring
- **Smart downloads** — skips tracks already in your Navidrome library
- **Job management** — real-time progress, retry, cancel, history

### Player
- **Multi-source streaming** — local file > Navidrome > YouTube proxy (4h URL cache)
- **Full-screen player** — album art, seek bar, shuffle, repeat (off/all/one)
- **Queue** — drag & drop reorder, per-user persistent, save as Navidrome playlist
- **Playlist Mode** — queue linked to Navidrome playlist with auto-sync
- **Multi-device** — separate queue and play progress per device, with device naming
- **Output modes** — Default (local + cast), Local Only, DLNA Only (auto-connects on play)
- **Source badge** — shows LOCAL / FLAC / YT on mini and full player
- **Swipe gestures** — expand player, next/prev track, tap to play/pause
- **Keyboard shortcuts** — Space (play/pause), arrows (skip, volume)

### Recommendations & Radio
- **Smart recommendations** — context-aware suggestions from Last.fm + Deezer + Spotify
- **Virtual playback** — play recommendations without adding to queue
- **Artist radio** — auto-generated stations with configurable source

### Spotify Integration
- **Per-user OAuth** — authorize directly from Settings
- **Browse** — playlists, Liked Songs, saved albums, followed artists, podcasts
- **Download & sync** — download Spotify playlists to Navidrome

### Library & Navidrome
- **Playlist management** — create, rename, duplicate, merge, delete, reorder
- **Library detection** — "In Library" badge with fuzzy matching
- **Track/album deletion** — with confirmation showing affected playlists
- **Song recognition** — Shazam + AcoustID fingerprinting via microphone

### Favorites & New Releases
- **Follow artists** — heart icon from search or artist detail
- **New release detection** — automatic background checks with "NEW" badges
- **Auto-download** — optional per-artist toggle for new albums

### Podcasts
- **Search & download** — individual episodes or entire shows
- **Subscriptions** — auto-sync new episodes on configurable interval

### DLNA/UPnP Cast
- **Cast to network speakers** — auto-discovers renderers via SSDP
- **Full control** — play, pause, stop, seek, volume from MusicSeeker UI
- **Per-device sessions** — each device has its own independent cast session
- **Metadata** — sends title, artist, album art to renderer display

### Native Apps
- **macOS** — standalone window with dock icon, keyboard shortcuts for reload/cache clear
- **Android** — background audio playback, media notification with play/pause/skip controls and progress bar, microphone access for Shazam
- **Auto-update** — checks for new versions, shows update banner in Settings
- [Full native apps documentation](docs/native-apps.md)

### User Management
- **JWT auth** — admin and user roles
- **Per-user permissions** — restrict formats (MP3/FLAC), methods (yt-dlp/slskd/Lidarr), storage quotas
- **Per-user folders** — downloads go to `/music/{username}/` with disk usage tracking
- **Device management** — register, name, and configure devices per user

### UI
- **Dark theme** — Spotify-inspired with lime green accent
- **Responsive** — desktop top nav, mobile bottom tab bar
- **No build step** — single HTML file, vanilla JS modules

## Screenshots

| Search Results | Download Modal | Discover |
|----------------|----------------|----------|
| ![Search](screenshots/search-tracks.png) | ![Modal](screenshots/download-modal.png) | ![Discover](screenshots/discover.png) |

| Full Player (Desktop) | My Spotify Library | Mobile |
|-----------------------|-------------------|--------|
| ![Player](screenshots/full-player.png) | ![Spotify](screenshots/my-spotify.png) | ![Mobile](screenshots/mobile.png) |

| Login | Podcasts | Settings |
|-------|----------|----------|
| ![Login](screenshots/login.png) | ![Podcasts](screenshots/podcasts.png) | ![Settings](screenshots/settings.png) |

## Quick Start

### 1. Clone

```bash
git clone https://github.com/lucashanak/music-seeker.git
cd music-seeker
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
ADMIN_USER=admin
ADMIN_PASS=your_secure_password

# Optional — see docs/configuration.md for all options
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
LASTFM_API_KEY=your_lastfm_key
```

### 3. Start

```bash
docker compose up -d --build
```

This starts MusicSeeker (`:8090`), Navidrome (`:4533`), and slskd (`:5030`).

### 4. Log in

Use the admin credentials from `.env`. Create additional users in Settings.

> **Note:** Search works out of the box with Deezer — no API keys required. Spotify credentials are only needed for personal playlists, Liked Songs, and podcasts.

## Requirements

- Docker & Docker Compose
- *(Optional)* [Spotify Developer App](https://developer.spotify.com/dashboard)
- *(Optional)* [Last.fm API key](https://www.last.fm/api/account/create)
- *(Optional)* [AcoustID API key](https://acoustid.org/my-applications)
- *(Optional)* Lidarr instance

## Documentation

| Document | Description |
|----------|-------------|
| [Configuration](docs/configuration.md) | All environment variables and in-app settings |
| [Setup Guides](docs/setup-guides.md) | Spotify, slskd, Navidrome, Last.fm, Lidarr, DLNA, YAMS |
| [Architecture](docs/architecture.md) | Backend structure, frontend modules, data storage, Docker |
| [API Reference](docs/api-reference.md) | All ~90 REST API endpoints |
| [Native Apps](docs/native-apps.md) | macOS & Android apps — installation, features, building, auto-update |
