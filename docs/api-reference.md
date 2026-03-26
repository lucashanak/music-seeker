# API Reference

All endpoints (except login and version) require `Authorization: Bearer <token>` header.

## Auth

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login, returns JWT token |
| `GET` | `/api/auth/me` | Get current user info |
| `PUT` | `/user/spotify` | Connect Spotify account |
| `GET` | `/user/spotify` | Get Spotify connection status |
| `DELETE` | `/user/spotify` | Disconnect Spotify |
| `PUT` | `/user/settings` | Update user settings |
| `PUT` | `/users/:username/password` | Change password |

## Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/search?q=...&type=track&offset=0` | Search music (via configured provider) |
| `GET` | `/api/artist/:id/albums` | Get artist albums |
| `GET` | `/api/album/:id/tracks` | Get album tracks |

## Spotify

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/spotify/playlists` | User's playlists |
| `GET` | `/api/spotify/liked` | Liked Songs |
| `GET` | `/api/spotify/playlist/:id/tracks` | Playlist tracks |
| `GET` | `/api/spotify/albums` | Saved albums |
| `GET` | `/api/spotify/artists` | Followed artists |
| `GET` | `/api/spotify/shows` | Saved podcasts |
| `GET` | `/api/spotify/show/:id/episodes` | Show episodes |
| `GET` | `/api/spotify/auth-url` | OAuth URL |
| `GET` | `/api/spotify/callback?code=...` | OAuth callback |

## Downloads

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/download` | Start a download job |
| `GET` | `/api/jobs` | List all jobs |
| `GET` | `/api/jobs/:id` | Get job status |
| `DELETE` | `/api/jobs/:id` | Cancel a job |
| `POST` | `/api/jobs/:id/retry` | Retry a failed job |
| `DELETE` | `/api/jobs` | Clear download history |

## Player

Queue endpoints use `X-Device-ID` header for per-device isolation. Missing header defaults to `"default"`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/player/stream?name=..&artist=..` | Stream audio (local > Navidrome > YouTube) |
| `HEAD` | `/api/player/stream?name=..&artist=..` | Stream metadata (for DLNA) |
| `GET` | `/api/player/queue` | Get player queue (per-device via `X-Device-ID`) |
| `PUT` | `/api/player/queue` | Save player queue state (per-device) |
| `POST` | `/api/player/queue/add` | Add tracks to queue (per-device) |
| `DELETE` | `/api/player/queue` | Clear player queue (per-device) |
| `GET` | `/api/player/recommendations` | Get recommendations from queue |
| `POST` | `/api/player/recommendations` | Get recommendations from track list |
| `GET` | `/api/player/resolve-source?name=..&artist=..` | Resolve stream source type |
| `GET` | `/api/radio?track=..&artist=..` | Get radio tracks |

## Library & Navidrome

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/library/check` | Check if items exist in Navidrome |
| `GET` | `/api/library/playlists` | List Navidrome playlists |
| `GET` | `/api/library/playlist/:id` | Get playlist with tracks |
| `POST` | `/api/library/playlist` | Create new playlist |
| `PUT` | `/api/library/playlist/:id/rename` | Rename playlist |
| `PUT` | `/api/library/playlist/:id/tracks` | Add tracks by song IDs |
| `PUT` | `/api/library/playlist/:id/reorder` | Reorder playlist tracks |
| `POST` | `/api/library/playlist/:id/add-by-name` | Add track by name/artist |
| `POST` | `/api/library/playlist/:id/add-and-download` | Add track (download if needed) |
| `POST` | `/api/library/playlist/:id/remove-by-name` | Remove track by name |
| `DELETE` | `/api/library/playlist/:id/tracks` | Remove tracks by indices |
| `DELETE` | `/api/library/playlist/:id` | Delete playlist |
| `POST` | `/api/library/track/delete` | Delete track file from disk |
| `POST` | `/api/library/track/check-playlists` | Check which playlists contain track |
| `POST` | `/api/library/album/delete` | Delete album files from disk |
| `GET` | `/api/library/cover/:id` | Proxy Navidrome cover art |

## Discover

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/discover/tags?limit=50` | Get popular Last.fm genre tags |
| `GET` | `/api/discover/tag/:tag?type=track` | Get top items for a tag |
| `POST` | `/api/discover/resolve` | Resolve Last.fm item via search provider |

## Favorites

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/favorites` | List followed artists |
| `POST` | `/api/favorites` | Follow an artist |
| `DELETE` | `/api/favorites/:id` | Unfollow artist |
| `PUT` | `/api/favorites/:id` | Update artist settings (auto-download) |
| `POST` | `/api/favorites/:id/clear` | Clear new release badge |
| `POST` | `/api/favorites/check` | Check for new releases now |

## Podcasts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/podcasts` | List downloaded podcast shows |
| `GET` | `/api/podcasts/:show` | List episodes for a show |
| `DELETE` | `/api/podcasts/:show` | Delete entire show |
| `DELETE` | `/api/podcasts/:show/:episode` | Delete single episode |
| `GET` | `/api/podcasts/rss-episodes` | Get RSS episodes |
| `GET` | `/api/podcasts/subs` | List podcast subscriptions |
| `POST` | `/api/podcasts/subs` | Subscribe to a podcast |
| `DELETE` | `/api/podcasts/subs/:id` | Unsubscribe from a podcast |
| `PUT` | `/api/podcasts/subs/:id` | Update subscription settings |
| `POST` | `/api/podcasts/sync` | Manually sync all subscriptions |

## Song Recognition

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/recognize` | Identify song from audio (multipart upload) |

## DLNA/UPnP Cast

Cast control uses `X-Device-ID` header for per-device sessions. Each device has its own independent cast session keyed by `{username}:{device_id}`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/dlna/devices` | List discovered DLNA renderers |
| `POST` | `/api/dlna/scan` | Active SSDP scan |
| `POST` | `/api/dlna/cast` | Cast track to a DLNA renderer (per-device session) |
| `POST` | `/api/dlna/play` | Resume playback on renderer (per-device session) |
| `POST` | `/api/dlna/pause` | Pause playback on renderer (per-device session) |
| `POST` | `/api/dlna/stop` | Stop casting (per-device session) |
| `POST` | `/api/dlna/seek` | Seek to position (seconds) |
| `POST` | `/api/dlna/volume` | Set renderer volume (0-100) |
| `GET` | `/api/dlna/status` | Get cast status (per-device session) |

## Device Management

Each client generates a UUID stored in `localStorage` and sends it as `X-Device-ID` header. Device IDs must match `^[a-zA-Z0-9_-]{1,64}$`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/user/devices` | List registered devices for current user |
| `PUT` | `/api/user/devices/:device_id` | Register or update device (name, output_mode, dlna_renderer_url) |
| `DELETE` | `/api/user/devices/:device_id` | Remove a device and its queue file |
| `GET` | `/api/user/device-settings` | Get settings for current device (from `X-Device-ID` header) |

**Output modes**: `default` (local playback + cast button), `local` (no casting), `dlna_only` (auto-connect to DLNA renderer on play).

## Settings & Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/version` | Get app version and feature flags (public, no auth) |
| `GET` | `/api/settings` | Get app settings |
| `PUT` | `/api/settings` | Update settings (admin only) |
| `GET` | `/api/users` | List users (admin only) |
| `POST` | `/api/users` | Create user (admin only) |
| `DELETE` | `/api/users/:username` | Delete user (admin only) |
| `PUT` | `/api/users/:username/perms` | Update user permissions (admin only) |
| `GET` | `/api/admin/disk-usage` | Get per-folder disk usage (admin) |
| `GET` | `/api/admin/disk-usage/:dirname/subfolders` | Get subfolder sizes |
| `DELETE` | `/api/admin/disk-usage/:dirname` | Delete a download folder (admin) |
