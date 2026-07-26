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
- **15 routers** with ~90 API endpoints
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
| `settings.py` | `settings.py` | — |
| `recognize.py` | `recognize.py` | Shazam, AcoustID |
| `dlna.py` | `dlna.py` | UPnP/SSDP (LAN), Onkyo eISCP |
| `remote.py` | `remote.py` | — (device→device remote control, SSE) |
| `bpm.py` | `bpm.py` | — (BPM detection for DJ mode) |
| `admin.py` | — | Filesystem |
| `spotify.py` | `spotify.py` | Spotify Web API |

### Key design decisions

- **Multi-source streaming**: Player resolves streams in order: local file → Navidrome → YouTube proxy. Each source is tried and the first success is used. YouTube URLs are cached for 4 hours.
- **Per-user isolation**: Each user has their own download folder (`/music/{username}/`), queue state, Spotify credentials, and favorites.
- **Multi-device support**: Each device sends a UUID via `X-Device-ID` header. Queues are stored per-device (`player/{username}_{device_id}.json`), DLNA cast sessions are keyed by `{username}:{device_id}`, and device settings (name, output mode, renderer URL) are stored in `users.json`.
- **Fuzzy library matching**: Navidrome library check uses normalized string comparison to handle variations (remasters, feat. tags, live versions).
- **Queueing never downloads**: adding tracks to the queue only mirrors them into the Up Next playlist (`download: false`); tracks missing from the library stream on demand. Downloads happen only through explicit actions (Download, Add to playlist, per-artist auto-download). Historically queueing pulled every missing track into the library via yt-dlp, which filled the shared library as a side effect of pressing play.
- **Metadata embedding**: yt-dlp downloads raw audio, then metaflac (FLAC) or ffmpeg (MP3) embeds artist/title/album/artwork from the search provider (Deezer/Spotify), not from YouTube.

### Per-user Navidrome accounts

MusicSeeker talks to Navidrome as the **logged-in user**, not as one shared account,
so playlists, likes, stars and play counts are isolated while the music library stays
shared. (With a single shared account every MusicSeeker user saw the admin's playlists.)

- **Provisioning** — `navidrome_admin.py` drives Navidrome's *native* REST API (the one
  its web UI uses; Subsonic has no user management): `POST /auth/login` → token, then
  `GET/POST/PUT/DELETE /api/user` with the **`x-nd-authorization: Bearer <token>`**
  header (the standard `Authorization` header returns 401). Accounts are created lazily
  on first use with a random password stored in `users.json`; new Navidrome users
  inherit the shared library automatically. Deleting a MusicSeeker user tears its
  Navidrome account down too.
- **Request binding** — `library.py` holds a `ContextVar` with the current request's
  credentials; `_params()` signs every Subsonic call with them and falls back to the
  admin/service account when unbound (system paths, admin, provisioning failure). The
  `bind_navidrome_creds` dependency sets it per request. `asyncio.create_task` copies
  the context, so download jobs keep the requesting user's identity.
- **The native API is private and unversioned.** `tests/test_navidrome_admin.py` is an
  API canary: it exercises login → header → user CRUD against a live Navidrome so a
  Navidrome upgrade that changes the contract fails loudly instead of silently breaking
  provisioning. It skips when `NAVIDROME_PASSWORD` is unset.
- **`GET /api/library/cover/{id}` must stay public.** `<img>` tags cannot send the
  `Authorization` header (the SPA keeps its token in localStorage), so auth is applied
  **per endpoint** in the library router — never router-wide. Adding a router-level
  dependency silently 401s all album art; the breakage only shows on clients with a
  cold cache.

## Frontend

- **Single Page Application** — vanilla JavaScript, no framework, no build step
- **Single HTML file** (`static/index.html`) with modular JS (`static/js/*.js`)
- **ES modules** — `import`/`export` with dynamic imports for code splitting
- **CSS architecture** — separate files per component, CSS custom properties for theming
- **Responsive** — desktop top nav, mobile bottom tab bar with `env(safe-area-inset-*)` handling

### Pages

| Page | Module | Description |
|------|--------|-------------|
| Search | `search.js` | Multi-provider search with aggregated "All" tab and per-type tabs (tracks/albums/artists/playlists/podcasts) |
| Discover | `discover.js` | Last.fm genre tags with content filtering |
| Library | `library.js` | Tabbed interface: Downloaded (Navidrome playlists + Liked Songs), Spotify (read-only mirror with Playlists/Albums/Artists/Shows segmented control), Podcasts, Favorites |
| Settings | `settings.js` | App config grouped into "Playback & Sound", "Library & Downloads", "Account & App", "Admin", user management, native app downloads |

### Shared components

- **Player** (`player.js`, `fullplayer.js`, `queue.js`) — mini bar with essentials (play/pause, like, queue), full player with grouped action row (DJ / track / output), queue sidebar with drag-to-reorder
- **Download modal** (`downloads.js`) — primary actions (Play Now, Add to Queue, Radio) separated from library download (Method + Format picker)
- **Playlist modals** (`playlists.js`) — inline playlist creation with name/description, cover image URL, and undo on delete
- **Recommendations** (`recommendations.js`) — queue sidebar panel
- **Gestures** (`gestures.js`) — swipe handling for player, queue panels, touch-optimized queue reorder
- **Router** (`router.js`) — SPA navigation with history API, support for Library tabs (Downloaded / Spotify / Podcasts / Favorites)

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
| `users.json` | User accounts, hashed passwords, permissions, Spotify tokens, per-user Navidrome credentials, device settings |
| `settings.json` | App configuration (search provider, Navidrome creds, etc.) |
| `jobs.json` | Download job history |
| `favorites.json` | Followed artists with auto-download settings |
| `podcast_subs.json` | Podcast subscriptions |
| `player/{username}.json` | Default queue state (legacy fallback) |
| `player/{username}_{device_id}.json` | Per-device queue state (tracks, position, volume, playlist mode) |
| `jwt_secret` | Persistent JWT signing secret |

Because `jwt_secret` lives in the data volume, recreating the container keeps
everyone logged in. Only losing or **switching** the data volume logs users out.

> **One data path, always.** Everything above is keyed to whatever host directory is
> mounted at `/app/data`. Mounting a different directory does not migrate anything — the
> app simply reads an empty one, and accounts, likes and favourites appear to have
> vanished. This bit us for real: a container recreated via compose picked up the
> compose-defined data path while accounts had been created against an older manually
> mounted path, and newly created users disappeared overnight. Pin exactly one host path
> per deployment, deploy the same way every time (see
> [YAMS Integration](setup-guides.md#yams-integration)), and never run an ad-hoc
> `docker run -v <other-path>:/app/data` against a live install.

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

### Memory limits

BPM/key analysis runs **in-process** (thread pool) on native audio libraries
(librosa, essentia, madmom, numpy). glibc keeps their freed buffers in per-thread
arenas instead of returning them to the OS, so RSS ratchets up with every analysis
and never comes back down. Unbounded, this reached **6.2 GB** — enough to exhaust the
8 GB LXC the stack runs in, so the OOM killer took the whole server down (SSH
included), not just the app.

Three guards, all required:

| Guard | Where | Purpose |
|-------|-------|---------|
| `gc.collect()` + `malloc_trim(0)` after each analysis | `bpm.py` (`_run_in_pool`) | Hands freed pages back to the OS |
| `MALLOC_ARENA_MAX=2` | container env | Caps glibc arena fragmentation |
| `mem_limit: 2g` | compose service | Contains a runaway process — it is OOM-killed alone and restarted by `restart: unless-stopped`; the host survives |

Measured effect: ~2 GB with OOM kills every few minutes → **~740 MB steady over hours**.

If the ratchet ever returns, move analysis to a recycling `ProcessPoolExecutor`
(`max_tasks_per_child`) — the native heap then dies with the worker. Both entry
points (`compute_features_only`, `_analyze_or_read_tag`) are module-level and take
only a path, so they are already picklable.

Diagnose with `dmesg -T | grep -i "killed process"` and `docker stats`.
