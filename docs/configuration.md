# Configuration

## Environment Variables

Set these in your `.env` file or pass directly to `docker run` / `docker-compose.yml`.

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_USER` | Yes | `admin` | Initial admin username |
| `ADMIN_PASS` | Yes | — | Initial admin password |
| `MUSIC_DIR` | No | `/music` | Music directory inside the container |
| `DATA_DIR` | No | `/app/data` | Data directory for JSON storage |
| `JWT_SECRET` | No | auto-generated | JWT signing secret (persistent file `/app/data/jwt_secret`) |

### Search

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_PROVIDER` | `deezer` | Primary search: `deezer`, `ytmusic`, or `spotify` |
| `SEARCH_FALLBACK` | — | Fallback provider if primary fails |
| `DEFAULT_FORMAT` | `flac` | Default download format: `flac` or `mp3` |
| `DEFAULT_METHOD` | `yt-dlp` | Default download method: `yt-dlp`, `slskd`, or `lidarr` |
| `MAX_CONCURRENT` | `10` | Maximum concurrent download jobs |
| `RECOMMENDATION_SOURCE` | `combined` | Recommendation engine: `lastfm`, `deezer`, `spotify`, or `combined` |

### Spotify

| Variable | Description |
|----------|-------------|
| `SPOTIFY_CLIENT_ID` | Spotify app Client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify app Client Secret |
| `SPOTIFY_REFRESH_TOKEN` | Global Spotify refresh token (per-user OAuth preferred) |

### Navidrome

| Variable | Default | Description |
|----------|---------|-------------|
| `NAVIDROME_URL` | `http://navidrome:4533` | Navidrome Subsonic API endpoint |
| `NAVIDROME_USER` | — | Navidrome username |
| `NAVIDROME_PASSWORD` | — | Navidrome password |

### Soulseek (slskd)

| Variable | Default | Description |
|----------|---------|-------------|
| `SLSKD_URL` | `http://slskd:5030` | slskd REST API endpoint |
| `SLSKD_API_KEY` | — | slskd API key |

### Lidarr

| Variable | Default | Description |
|----------|---------|-------------|
| `LIDARR_URL` | `http://lidarr:8686` | Lidarr API endpoint |
| `LIDARR_API_KEY` | — | Lidarr API key |
| `LIDARR_ROOT_FOLDER` | `{MUSIC_DIR}/_lidarr` | Root folder path as seen by Lidarr |

### Other

| Variable | Default | Description |
|----------|---------|-------------|
| `LASTFM_API_KEY` | — | Last.fm API key (for Discover tab) |
| `ACOUSTID_API_KEY` | — | AcoustID API key (recognition fallback) |
| `DLNA_SERVER_URL` | auto-detected | Server URL for DLNA metadata |
| `DLNA_RENDERER_URL` | — | Manual DLNA renderer description URL |
| `PODCAST_SYNC_HOURS` | `6` | Auto-sync interval for podcast subscriptions |

## In-App Settings

These are configured from the Settings page (admin only) and stored in `/app/data/settings.json`:

| Setting | Description |
|---------|-------------|
| Music Search | Primary search provider (Deezer / YouTube Music / Spotify) |
| Search Fallback | Fallback provider if primary returns no results |
| Podcast Search | Podcast search provider (iTunes / Spotify) |
| Download Method | Default download method per format |
| Max Concurrent | Number of simultaneous downloads |
| Recommendation Source | Engine for recommendations (Combined / Last.fm / Deezer / Spotify) |
| Navidrome URL/User/Password | Library integration settings |
| slskd URL/API Key | Soulseek integration settings |

## Per-User Settings

Each user can configure:

| Setting | Description |
|---------|-------------|
| Spotify OAuth | Per-user Spotify authorization (Settings > Spotify Account) |
| Hide Spotify | Hide My Spotify tab from navigation |
| Allowed formats | MP3, FLAC (admin-configurable per user) |
| Allowed methods | yt-dlp, slskd, Lidarr (admin-configurable per user) |
| Storage quota | Max disk usage in GB, 0 = unlimited (admin-configurable) |
