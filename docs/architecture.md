# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Clients                               │
│  Browser (SPA)  │  Tauri macOS  │  Tauri Android        │
└────────┬────────┴───────┬───────┴───────┬───────────────┘
         │                │               │
         │          HTTPS (remote URL)    │
         │                │               │
┌────────▼────────────────▼───────────────▼───────────────┐
│                  FastAPI Backend                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │  Auth    │ │  Search  │ │ Downloads│ │  Player  │   │
│  │  (JWT)   │ │ (multi)  │ │ (3 methods│ │ (stream) │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ Library  │ │ Discover │ │Favorites │ │ Podcasts │   │
│  │(Navidrome│ │ (Last.fm)│ │(releases)│ │  (subs)  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │  DLNA    │ │Recognize │ │  Radio   │                │
│  │  (cast)  │ │ (Shazam) │ │ (recs)   │                │
│  └──────────┘ └──────────┘ └──────────┘                │
└─────────┬──────────┬──────────┬──────────┬──────────────┘
          │          │          │          │
    ┌─────▼──┐ ┌─────▼──┐ ┌────▼───┐ ┌───▼────┐
    │Navidrome│ │ slskd  │ │ Lidarr │ │External│
    │(Subsonic│ │(Soulseek│ │(torrent│ │ APIs   │
    │  API)  │ │  P2P)  │ │  DL)   │ │        │
    └────────┘ └────────┘ └────────┘ └────────┘
                                      Spotify, Deezer,
                                      Last.fm, YouTube,
                                      AcoustID, Shazam
```

## Backend

- **Framework**: FastAPI (Python 3.11), single process via uvicorn
- **13 routers** with ~90 API endpoints
- **No database** — JSON file storage in `/app/data/` (users, settings, jobs, queue, favorites, subscriptions)
- **No build step** — frontend served as static files by FastAPI
- **Job queue** — in-memory with semaphore for concurrency control (configurable max concurrent downloads)

### Router → Service mapping

| Router | Service | External dependency |
|--------|---------|-------------------|
| `auth.py` | `auth.py` | — |
| `search.py` | `search_providers.py`, `spotify.py` | Deezer, YouTube Music, Spotify API |
| `downloads.py` | `downloader.py`, `jobs.py` | yt-dlp, slskd, Lidarr |
| `player.py` | `player.py`, `radio.py` | Navidrome, yt-dlp (stream proxy) |
| `library.py` | `library.py` | Navidrome (Subsonic API) |
| `discover.py` | `lastfm.py` | Last.fm API |
| `favorites.py` | `favorites.py` | Search providers (release check) |
| `podcasts.py` | `podcasts.py` | Spotify, RSS feeds |
| `settings.py` | `settings.py`, `recognize.py` | Shazam, AcoustID |
| `dlna.py` | `dlna.py` | UPnP/SSDP (LAN) |
| `admin.py` | — | Filesystem |
| `spotify.py` | `spotify.py` | Spotify Web API |

### Key design decisions

- **Multi-source streaming**: Player resolves streams in order: local file → Navidrome → YouTube proxy. Each source is tried and the first success is used. YouTube URLs are cached for 4 hours.
- **Per-user isolation**: Each user has their own download folder (`/music/{username}/`), queue state, Spotify credentials, and favorites.
- **Fuzzy library matching**: Navidrome library check uses normalized string comparison to handle variations (remasters, feat. tags, live versions).
- **Metadata embedding**: yt-dlp downloads raw audio, then metaflac (FLAC) or ffmpeg (MP3) embeds artist/title/album/artwork from the search provider (Deezer/Spotify), not from YouTube.

## Frontend

- **Single Page Application** — vanilla JavaScript, no framework, no build step
- **Single HTML file** (`static/index.html`) with modular JS (`static/js/*.js`)
- **ES modules** — `import`/`export` with dynamic imports for code splitting
- **CSS architecture** — separate files per component, CSS custom properties for theming
- **Responsive** — desktop top nav, mobile bottom tab bar with `env(safe-area-inset-*)` handling

### Pages

| Page | Module | Description |
|------|--------|-------------|
| Search | `search.js` | Multi-provider search with type tabs and infinite scroll |
| Discover | `discover.js` | Last.fm genre tags with content filtering |
| Library | `library.js` | Navidrome playlists with detail modal |
| My Spotify | `spotify.js` | Playlists, Liked Songs, Albums, Artists, Podcasts |
| My Podcasts | `podcasts.js` | Downloaded shows with episode management |
| Favorites | `favorites.js` | Followed artists with new release badges |
| Settings | `settings.js` | App config, user management, native app downloads |

### Shared components

- **Player** (`player.js`, `fullplayer.js`, `queue.js`) — mini bar, full player, queue sidebar
- **Download modal** (`downloads.js`) — method/format selection, downloads panel
- **Recommendations** (`recommendations.js`) — queue sidebar panel
- **Gestures** (`gestures.js`) — swipe handling for player, queue panels
- **Router** (`router.js`) — SPA navigation with history API

## Native Apps (Tauri)

- **macOS**: WebView wrapper with native menu (reload, cache clear)
- **Android**: WebView wrapper with:
  - `AndroidBridge` JavaScript interface for native callbacks
  - `AudioService` foreground service for background playback
  - `MediaSessionCompat` for notification controls
  - Edge-to-edge status bar handling

The native code is not in the repository as source files — it's generated by `tauri android init` and patched in CI via `sed` and `cat` commands in the GitHub Actions workflow.

## Data Storage

All data is stored as JSON files in `/app/data/`:

| File | Purpose |
|------|---------|
| `users.json` | User accounts, hashed passwords, permissions, Spotify tokens |
| `settings.json` | App configuration (search provider, Navidrome creds, etc.) |
| `jobs.json` | Download job history |
| `favorites.json` | Followed artists with auto-download settings |
| `podcast_subs.json` | Podcast subscriptions |
| `player/{username}.json` | Per-user queue state (tracks, position, volume, playlist mode) |
| `jwt_secret` | Persistent JWT signing secret |

## Docker

```dockerfile
FROM python:3.11-slim
# ffmpeg (audio conversion), chromaprint (AcoustID), flac (metaflac tagging)
RUN apt-get install ffmpeg libchromaprint-tools flac
COPY requirements.txt .
RUN pip install -r requirements.txt
WORKDIR /app
COPY . .
ENTRYPOINT ["/app/entrypoint.sh"]
```

`entrypoint.sh` replaces `__CACHE_BUST__` placeholders in HTML/JS with a Unix timestamp on every container start, ensuring clients always get fresh assets.

### Volume mounts

| Mount | Purpose |
|-------|---------|
| `/music` | Shared music directory (must match Navidrome's music volume) |
| `/app/data` | Persistent data (users, settings, jobs, queue) |

### Docker Compose stack

- `music-seeker` (port 8090) — the main app
- `navidrome` (port 4533) — music library server (shared `/music` volume)
- `slskd` (port 5030) — Soulseek P2P client (shared `/music` volume)
