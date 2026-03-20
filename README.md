# MusicSeeker

A self-hosted web app for searching and downloading music. Think Jellyseerr, but for music.

Built with FastAPI + vanilla JS. Runs as a single Docker container.

![Search results](screenshots/search-results.png)

## Features

- **Spotify Search** — Search tracks, albums, and artists via Spotify's catalog
- **Two download methods:**
  - **spotDL** — Direct download in FLAC or MP3 (runs as a sidecar Docker container)
  - **Lidarr** — Torrent-based downloads with automatic artist monitoring
- **Shazam Recognition** — Identify songs via your microphone, then download them instantly
- **Spotify Playlists** — Browse your Spotify playlists and download individual tracks or full playlists
- **Library Detection** — Shows "In Library" badge for tracks already in your Navidrome collection
- **Download Management** — Real-time progress tracking, retry failed downloads, cancel running downloads
- **Browser Notifications** — Get notified when downloads complete (even in background tabs)
- **User Management** — JWT authentication with admin/user roles
- **Dark UI** — Clean, responsive dark theme with lime green accent

## Screenshots

| Login | Search | Download Modal | Settings |
|-------|--------|---------------|----------|
| ![Login](screenshots/login.png) | ![Search](screenshots/search-results.png) | ![Modal](screenshots/download-modal.png) | ![Settings](screenshots/settings.png) |

## Requirements

- Docker & Docker Compose
- [Spotify Developer App](https://developer.spotify.com/dashboard) (Client ID, Client Secret, Refresh Token)
- [spotDL Docker image](https://github.com/spotDL/spotify-downloader) built locally as `spotdl-local`
- *(Optional)* Lidarr instance for torrent-based downloads
- *(Optional)* Navidrome instance for library detection

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/lucashanak/music-seeker.git
cd music-seeker
```

### 2. Build the spotDL sidecar image

MusicSeeker spawns spotDL containers for each download. You need to build the image locally:

```bash
docker pull spotdl/spotify-downloader
docker tag spotdl/spotify-downloader spotdl-local
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REFRESH_TOKEN=your_refresh_token
HOST_MUSIC_DIR=/path/to/your/music
ADMIN_USER=admin
ADMIN_PASS=your_secure_password

# Optional (for Lidarr integration)
LIDARR_URL=http://lidarr:8686
LIDARR_API_KEY=your_api_key

# Optional (for "In Library" detection)
NAVIDROME_URL=http://navidrome:4533
NAVIDROME_USER=your_user
NAVIDROME_PASSWORD=your_password

# If running on the same Docker network as other services
DOCKER_NETWORK=your_network_name
```

### 4. Start the app

```bash
docker compose up -d --build
```

The app will be available at `http://localhost:8090`.

### 5. Log in

Use the admin credentials you set in `.env`. You can create additional users from the Settings page.

## Getting a Spotify Refresh Token

MusicSeeker needs a long-lived Spotify refresh token to access the API. Here's how to get one:

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app
2. Set the Redirect URI to `http://localhost:8888/callback`
3. Note your **Client ID** and **Client Secret**
4. Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost:8888/callback&scope=user-read-private%20playlist-read-private%20playlist-read-collaborative
```

5. After authorizing, you'll be redirected to `http://localhost:8888/callback?code=AUTHORIZATION_CODE`
6. Copy the `code` parameter and exchange it for tokens:

```bash
curl -X POST https://accounts.spotify.com/api/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:8888/callback" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

7. The response will contain a `refresh_token` — put it in your `.env` file.

## Integration with YAMS

If you're running [YAMS](https://yams.media) (Yet Another Media Server), add MusicSeeker to your `docker-compose.custom.yaml`:

```yaml
services:
  music-seeker:
    build: /path/to/music-seeker
    container_name: music-seeker
    restart: unless-stopped
    ports:
      - "8090:8090"
    environment:
      - SPOTIFY_CLIENT_ID=${SPOTIFY_CLIENT_ID}
      - SPOTIFY_CLIENT_SECRET=${SPOTIFY_CLIENT_SECRET}
      - SPOTIFY_REFRESH_TOKEN=${SPOTIFY_REFRESH_TOKEN}
      - LIDARR_URL=http://lidarr:8686
      - LIDARR_API_KEY=${LIDARR_API_KEY}
      - MUSIC_DIR=/music
      - HOST_MUSIC_DIR=/mnt/nas/Media/_Music
      - NAVIDROME_URL=http://navidrome:4533
      - NAVIDROME_USER=your_user
      - NAVIDROME_PASSWORD=${NAVIDROME_PASSWORD}
      - DOCKER_NETWORK=yams-server_default
      - ADMIN_USER=admin
      - ADMIN_PASS=${ADMIN_PASS}
    volumes:
      - /mnt/nas/Media/_Music:/music
      - /var/run/docker.sock:/var/run/docker.sock
      - ${INSTALL_DIRECTORY}/config/music-seeker:/app/data
```

## Architecture

```
┌──────────────────────────────┐
│        Browser (SPA)         │
│   Vanilla JS + Dark Theme    │
└────────────┬─────────────────┘
             │ HTTP/JSON
┌────────────▼─────────────────┐
│     FastAPI (main.py)        │
│  Auth, Search, Downloads,    │
│  Recognition, Settings       │
├──────────────────────────────┤
│ spotify.py  │ Spotify Web API│
│ downloader.py │ Docker API   │
│ library.py  │ Subsonic API   │
│ recognize.py│ shazamio       │
│ auth.py     │ HMAC tokens    │
│ jobs.py     │ Job queue      │
└──────┬───────────────────────┘
       │ Unix Socket
┌──────▼───────────────────────┐
│    Docker Engine             │
│  Spawns spotdl-local         │
│  containers per download     │
└──────────────────────────────┘
```

- **No database** — users and history stored as JSON files in `/app/data`
- **No build step** — frontend is a single HTML file served by FastAPI
- **Docker-in-Docker** — downloads run in isolated spotDL containers via the Docker socket

## API Reference

All endpoints (except login) require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login, returns JWT token |
| `GET` | `/api/auth/me` | Get current user info |
| `GET` | `/api/search?q=...&type=track` | Search Spotify |
| `POST` | `/api/download` | Start a download job |
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/:id` | Get job status |
| `DELETE` | `/api/jobs/:id` | Cancel a job |
| `POST` | `/api/jobs/:id/retry` | Retry a failed job |
| `DELETE` | `/api/jobs` | Clear download history |
| `POST` | `/api/library/check` | Check if items exist in Navidrome |
| `POST` | `/api/recognize` | Identify song from audio (multipart) |
| `GET` | `/api/spotify/playlists` | Get user's Spotify playlists |
| `GET` | `/api/spotify/playlist/:id/tracks` | Get playlist tracks |
| `GET` | `/api/settings` | Get app settings |
| `PUT` | `/api/settings` | Update settings (admin only) |
| `GET` | `/api/users` | List users (admin only) |
| `POST` | `/api/users` | Create user (admin only) |
| `DELETE` | `/api/users/:username` | Delete user (admin only) |
| `PUT` | `/api/users/:username/password` | Change password |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPOTIFY_CLIENT_ID` | Yes | — | Spotify app Client ID |
| `SPOTIFY_CLIENT_SECRET` | Yes | — | Spotify app Client Secret |
| `SPOTIFY_REFRESH_TOKEN` | Yes | — | Spotify OAuth refresh token |
| `ADMIN_USER` | Yes | `admin` | Initial admin username |
| `ADMIN_PASS` | Yes | — | Initial admin password |
| `HOST_MUSIC_DIR` | Yes | — | Absolute path to music dir on the host |
| `MUSIC_DIR` | No | `/music` | Music dir inside the container |
| `LIDARR_URL` | No | `http://lidarr:8686` | Lidarr API URL |
| `LIDARR_API_KEY` | No | — | Lidarr API key |
| `NAVIDROME_URL` | No | `http://navidrome:4533` | Navidrome URL |
| `NAVIDROME_USER` | No | `lucas` | Navidrome username |
| `NAVIDROME_PASSWORD` | No | — | Navidrome password |
| `DOCKER_NETWORK` | No | — | Docker network for spotDL containers |
| `JWT_SECRET` | No | auto-generated | Secret for signing auth tokens |

## License

MIT
