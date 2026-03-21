# Spotify API Usage in MusicSeeker

## Two types of tokens

### App Token (Client Credentials)
- Uses: `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET`
- No user account involved — anonymous, app-level
- Safe, no ban risk

### User Token (Refresh Token)
- Uses: `SPOTIFY_REFRESH_TOKEN` (linked to your Spotify account)
- Needed only for user-specific endpoints

## Where each token is used

| Feature | Token | File | Risk |
|---------|-------|------|------|
| Search (track/album/artist/playlist) | App token | `spotify.py:search()` | None |
| Discover / Resolve (Last.fm → Spotify) | App token | `spotify.py:resolve_url()` | None |
| Browse **your** playlists (`me/playlists`) | **User token** | `spotify.py:get_user_playlists()` | Low — read-only, legit API |
| Get playlist tracks | App token (fallback to user if 403) | `spotify.py:get_playlist_tracks()` | Low |
| spotDL download | spotDL's own credentials OR app token (setting) | `downloader.py:_run_spotdl()` | None for Spotify (downloads from YouTube) |
| Lidarr download | None (Lidarr has its own) | `downloader.py` | None |

## Key points

- **spotDL does NOT use your Spotify account.** It reads metadata from Spotify API (via app token or its own credentials), then searches and downloads audio from **YouTube**. No Spotify audio is ever downloaded.
- **Your Spotify user account (refresh token) is only used for browsing your personal playlists.** This is a legitimate, read-only API call.
- **Search, Discover, and downloads all work without your Spotify account.** Only Client ID + Secret needed.

## Spotify API changes (February 2026)

- Dev Mode now requires Premium account, max 1 Client ID per developer, max 5 authorized users
- spotDL's built-in shared credentials stopped working (rate limit 86400s)
- Our setup is compliant: own Client ID, single user
- Some endpoints were removed/restricted — monitor for future changes

## Alternatives to spotDL (if Spotify API becomes too restrictive)

- **yt-dlp**: Direct YouTube download, no Spotify API needed for download step
- **slskd**: Self-hosted Soulseek client with REST API, P2P, better for FLAC/lossless
