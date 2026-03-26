# Setup Guides

## Spotify

Search works without Spotify (Deezer is the default). Spotify credentials are needed for:
- Using Spotify as search provider
- Browsing personal playlists, Liked Songs, followed artists
- Podcast search via Spotify
- Spotify-based recommendations

### Easy way (recommended)

1. Create an app at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Set Redirect URI to `https://your-domain/api/spotify/callback`
3. In MusicSeeker Settings, enter Client ID and Client Secret
4. Click "Authorize with Spotify" and follow the OAuth flow
5. Per-user tokens are stored automatically

### Manual token (global fallback)

1. Create a Spotify app (same as above)
2. Open this URL (replace `YOUR_CLIENT_ID`):
   ```
   https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost:8888/callback&scope=user-read-private%20playlist-read-private%20playlist-read-collaborative%20user-library-read
   ```
3. After authorizing, copy the `code` from the redirect URL
4. Exchange for tokens:
   ```bash
   curl -X POST https://accounts.spotify.com/api/token \
     -d "grant_type=authorization_code&code=CODE&redirect_uri=http://localhost:8888/callback&client_id=ID&client_secret=SECRET"
   ```
5. Put the `refresh_token` in your `.env` as `SPOTIFY_REFRESH_TOKEN`

## slskd (Soulseek)

slskd is a self-hosted Soulseek client included in docker-compose.

### 1. Configure credentials

Create `slskd-data/slskd.yml`:

```yaml
soulseek:
  username: your_soulseek_username
  password: your_soulseek_password

directories:
  incomplete: /music/.slskd-incomplete
  downloads: /music/.slskd-downloads

web:
  authentication:
    api_keys:
      - key: your-api-key-here
        role: administrator
```

### 2. Create directories

```bash
mkdir -p music/.slskd-incomplete music/.slskd-downloads
```

### 3. Start slskd

```bash
docker compose up -d slskd
```

### 4. Configure in MusicSeeker

Go to Settings and paste your slskd API key.

## Navidrome

Navidrome is included in docker-compose for library detection and playlist management.

### 1. Start Navidrome

```bash
docker compose up -d navidrome
```

### 2. Initial setup

Open `http://localhost:4533` and create an admin account.

### 3. Configure in MusicSeeker

In Settings, enter the Navidrome URL, username, and password.

**Important**: MusicSeeker and Navidrome must share the same music volume. Both containers must mount the same host directory to `/music`.

## Last.fm

Needed for the Discover tab (genre-based browsing) and Last.fm-based recommendations.

1. Create an API account at [last.fm/api](https://www.last.fm/api/account/create)
2. Set `LASTFM_API_KEY` in your `.env`

## Lidarr

For torrent-based downloads with artist monitoring.

1. Set up Lidarr with your preferred torrent indexers
2. Configure `LIDARR_URL` and `LIDARR_API_KEY` in `.env`
3. Ensure Lidarr's root folder matches MusicSeeker's music directory

## DLNA Casting

MusicSeeker auto-discovers DLNA renderers on your LAN via SSDP.

- Renderers appear in the cast menu in the player bar
- For renderers that don't respond to SSDP, configure the description URL manually in Settings
- The server URL for stream metadata is auto-detected, or set `DLNA_SERVER_URL` if behind a proxy

## YAMS Integration

If using [YAMS](https://yams.media), add MusicSeeker to `docker-compose.custom.yaml`:

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
      - LIDARR_URL=http://lidarr:8686
      - LIDARR_API_KEY=${LIDARR_API_KEY}
      - NAVIDROME_URL=http://navidrome:4533
      - NAVIDROME_USER=your_user
      - NAVIDROME_PASSWORD=${NAVIDROME_PASSWORD}
      - LASTFM_API_KEY=${LASTFM_API_KEY}
      - SLSKD_URL=http://slskd:5030
      - SLSKD_API_KEY=${SLSKD_API_KEY}
      - ADMIN_USER=admin
      - ADMIN_PASS=${ADMIN_PASS}
      - DLNA_SERVER_URL=http://your-server-ip:8090
    volumes:
      - /mnt/nas/Media/_Music:/music
      - ${INSTALL_DIRECTORY}/config/music-seeker:/app/data
```
