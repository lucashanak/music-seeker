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
| Track metadata for yt-dlp | App token | `spotify.py:get_track_metadata()` | None |
| Album tracks for yt-dlp | App token | `spotify.py:get_album_tracks()` | None |
| Browse **your** playlists (`me/playlists`) | **User token** | `spotify.py:get_user_playlists()` | Low — read-only, legit API |
| Get playlist tracks | App token (fallback to user if 403) | `spotify.py:get_playlist_tracks()` | Low |
| yt-dlp download | None (searches YouTube) | `downloader.py:_run_ytdlp()` | None |
| Soulseek download | None (P2P via slskd) | `downloader.py:_run_slskd()` | None |
| Lidarr download | None (Lidarr has its own) | `downloader.py:_run_lidarr()` | None |

## Key points

- **Downloads do NOT use your Spotify account.** yt-dlp downloads audio from YouTube. slskd downloads from Soulseek P2P network. Lidarr uses torrent indexers. No Spotify audio is ever downloaded.
- **Spotify is only used for metadata.** Track names, artists, albums, and cover art are fetched via app-level API calls and embedded into downloaded files.
- **Your Spotify user account (refresh token) is only used for browsing your personal playlists.** This is a legitimate, read-only API call.
- **Search, Discover, and all downloads work without your Spotify account.** Only Client ID + Secret needed.

## Spotify API changes (February 2026)

- Dev Mode now requires Premium account, max 1 Client ID per developer, max 5 authorized users
- Our setup is compliant: own Client ID, single user
- Some endpoints were removed/restricted — monitor for future changes

## Alternative search providers (added March 2026)

Due to Spotify requiring Premium for Developer API access, MusicSeeker now supports multiple search providers:

| Provider | Auth Required | Fallback | Notes |
|----------|--------------|----------|-------|
| **Deezer** (default) | None | YouTube Music | Free public API, no key needed, good catalog |
| **YouTube Music** | None | Deezer | Uses `ytmusicapi` library, no key needed |
| **Spotify** | Client ID + Secret | None | Requires Premium for Dev API access |

- Search provider is configurable in **Settings → Downloads → Search Provider**
- Podcast search (shows/episodes) always uses Spotify regardless of chosen provider
- Discover resolve uses the configured search provider
- Deezer URL parsing supported for download metadata resolution
