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
                                      Shazam
```

## Backend

- **Framework**: FastAPI (Python 3.11), single process via uvicorn
- **16 routers** with ~95 API endpoints
- **No database** — JSON file storage in `/app/data/` (users, settings, jobs, queue, favorites, subscriptions, feedback)
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
| `recognize.py` | `recognize.py` | Shazam |
| `dlna.py` | `dlna.py` | UPnP/SSDP (LAN), Onkyo eISCP |
| `remote.py` | `remote.py` | — (device→device remote control, SSE) |
| `bpm.py` | `bpm.py` | — (BPM detection for DJ mode) |
| `admin.py` | — | Filesystem |
| `feedback.py` | `feedback.py`, `github.py` | GitHub REST API |
| `spotify.py` | `spotify.py` | Spotify Web API |

### Key design decisions

- **Multi-source streaming**: Player resolves streams in order: local file → Navidrome → YouTube proxy. Each source is tried and the first success is used. YouTube URLs are cached for 4 hours.
- **Per-user isolation**: Each user has their own download folder (`/music/{username}/`), queue state, Spotify credentials, and favorites.
- **Multi-device support**: Each device sends a UUID via `X-Device-ID` header. Queues are stored per-device (`player/{username}_{device_id}.json`), DLNA cast sessions are keyed by `{username}:{device_id}`, and device settings (name, output mode, renderer URL) are stored in `users.json`.
- **Fuzzy library matching**: Navidrome library check uses normalized string comparison to handle variations (remasters, feat. tags, live versions).
- **Queueing never downloads**: adding tracks to the queue only mirrors them into the Up Next playlist (`download: false`); tracks missing from the library stream on demand. Downloads happen only through explicit actions (Download, Add to playlist, per-artist auto-download). Historically queueing pulled every missing track into the library via yt-dlp, which filled the shared library as a side effect of pressing play.
- **Metadata embedding**: yt-dlp downloads raw audio, then metaflac (FLAC) or ffmpeg (MP3) embeds artist/title/album/artwork from the search provider (Deezer/Spotify), not from YouTube.
- **In-app feedback**: Reports are collected locally and privately first (`/app/data/feedback/`), then reviewed by an admin in Settings. Only on explicit admin action are they promoted to a public GitHub issue. This two-phase design prevents spam on a public tracker, keeps screenshots private until reviewed, and allows the entire feature to degrade gracefully when `GITHUB_TOKEN` is unset — capture, submit, and triage still work; only promotion is disabled.

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
- **Generated HTML shell** — `static/index.html` is built from `frontend/partials/*.html`
  (see below); JS stays modular (`static/js/*.js`)
- **ES modules** — `import`/`export` with dynamic imports for code splitting
- **CSS architecture** — separate files per component, CSS custom properties for theming
- **Responsive** — desktop top nav, mobile bottom tab bar with `env(safe-area-inset-*)` handling

### `static/index.html` is generated

`static/index.html` is the concatenation of `frontend/partials/*.html` in glob order.
The prefixes are always two digits (`00-head.html`, `10-login.html`, …) because a
single-digit prefix sorts *after* `10-`, and a name starting with punctuation sorts
above `00-head.html` — its markup would land before `<!DOCTYPE html>` and drop the
browser into quirks mode. Both of those would satisfy the gate, so the two-digit
prefix is **enforced** by the build and the check, not merely recommended: a partial
not matching `[0-9][0-9]-*.html` is an error. The partials are a line-for-line
decomposition of the document, so the build adds nothing of its own — it is `cat`,
no templating, no dependency, nothing at runtime.

- **Edit a partial, then run `scripts/build-index.sh`.** Both the partials and the
  generated `static/index.html` are committed; the generated file carries a
  `GENERATED FILE` comment on its second line.
- **`scripts/check-index.sh`** verifies the two are in sync, and separately that
  `frontend/partials/` holds only plain `*.html` files, each ending in a newline. It
  builds into a temporary file and never writes `static/index.html`.
- To run that check before every commit: `git config core.hooksPath .githooks`. Git does
  not do this for you after `git clone`. The hook checks the *staged* content, and does
  nothing on a commit with no partials staged (an older branch, a `git bisect` checkout).
- The partials sit outside `static/` on purpose — that directory is mounted by
  `StaticFiles` without authentication, so partials under it would be served as a
  second, broken copy of the markup.
- Only plain `*.html` files directly inside `frontend/partials/` are built. A
  subdirectory, a symlink, a dotfile or a `.HTML` typo is a hard error rather than a
  file the glob quietly skips — silently dropping markup is the failure mode worth
  being loud about.

#### What a green `check-index.sh` proves

It proves the partials and `static/index.html` **agree**. It does **not** prove the
document is intact. Delete a partial, run `build-index.sh`, and the gate is green again
on the shorter page — `#fullPlayer` can be gone and both sides still agree about it.

Once the two sides match, no comparison between them can report that a third thing is
missing. What catches a deleted partial is the diff: a file disappears and ~157 lines
vanish from `static/index.html`. That is loud in review, which is where it belongs. A
manifest of expected partials was considered and rejected — it would be a third copy of
the same truth, and would drift from the other two.

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
| `feedback/<id>.json` + `<id>.jpg`/`.png` | In-app feedback reports awaiting admin triage (private; capped at 200 reports / 200 MB) |

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
# ffmpeg (audio conversion), flac (metaflac tagging)
RUN apt-get install ffmpeg flac
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

## BPM only exists for tracks with audio on hand

`GET /api/bpm/track` decides ownership on the server, with the same two sources
the analysis uses: a Navidrome song id (`find_song_id`) or a local file
(`find_track_file`). A track with neither gets `200 {"owned": false}` and no work
is started; before this it got a 404 "audio not available". Only those two sources
count: audio the player holds in its YouTube cache (`ms-yt-cache`) is not consulted
by the analysis, so such a track is still answered `owned:false`. An owned track
whose analysis fails still returns 404.

- **Server negative cache** (`app/routers/bpm.py`): `owned:false` is remembered
  300 s per lowercased (name, artist) truncated to 200 characters each, at most 2000
  entries. `force=true` skips it. A track that already has a cached BPM is answered
  with that entry, never `owned:false`, and is not remembered as unowned. A `song_id`
  query parameter does not skip the ownership check (the server looks the track up
  itself). Analysis failures are not cached. A Navidrome error is not read as "not owned" and is not cached.
- **Client** (`static/js/bpm.js`): `fetchTrackBpm` remembers `owned:false` for
  10 min and does not ask again; a finished download job clears that memory; `isBpmUnavailable()` exposes it. The client does
  not guess ownership from `inLibrary` (a DOM-only flag, not the same set as what
  analysis can reach). Playlist entries from `library.get_playlist` carry
  `owned: true`; nothing gates on it.
- **DJ mode**: a track without BPM has no tempo grid, so the transition falls back
  to the crossfade length setting and Smart Queue is not consulted for it (with
  shuffle on the next track is random regardless). The queue
  panel marks such tracks "no BPM" and the Smart Queue help text says so.

Known limits: the "no BPM" badge appears only after the server has answered for
that track in this session; `POST /api/bpm/lookup-by-name?analyze=true` and the
playlist scan are not covered by the negative cache; the tag write into the analysed
file (`write_tags`) is a separate hazard, described in the next section.

## BPM tag writes and live streams

mutagen rewrites a file in place (same inode), and a `FileResponse` holds its
descriptor for the whole body, so a tag block that grows lands inside a running
response. `bpm.write_tags` has three layers:

- **Skip.** It does not write a library file pinned raw by `player.raw_pinned`, nor
  anything inside `ms-nav-cache`. This is not exhaustive: the router serves a local
  `.mp3` and every `quality=lossless` request via `FileResponse` with no pin, and the
  check cannot see those. The pin is also set by the router after the check, so a
  request arriving in between is not seen either.
- **Replace.** Tags are saved into a copy in the same directory which then replaces the
  file with `os.replace`. A descriptor opened before the write keeps the old bytes
  (covered by `test_open_reader_keeps_original_bytes`). What this does not cover: a
  later Range request of the same play lands on the new file, whose offsets may have
  moved. That case was not measured.
- **Lock.** One process-wide lock serialises the read-modify-write, because two
  writers on one file otherwise lose the tag block of one of them.

A skipped write is not queued and the result stays in `bpm_analysis.json`. A pinned
library file gets its tags only from a later analysis that runs the full path (a forced
one, or after `bpm_analysis.json` is lost): `analyze_track` short-circuits on the cache
otherwise. A file in `ms-nav-cache` never gets tags, and is analysed again after a
restart. `write_tags` also skips the save when no tag value changes, so the file's
mtime (the key of the MP3 transcode cache) stays put.

The pin lives in `player._raw_pins`, a dict in this process. If analysis ever moves to
a `ProcessPoolExecutor` (see Memory limits), the child sees an empty dict and the pin
check stops working; the replace and lock layers would then have to carry it, and the
lock would have to become a file lock.

## The search page: layers, the empty state, and provider noise

### Artist, album and show detail are layers *inside* the search page

`#artistDetail`, `#albumDetail` and `#showDetail` are children of `#pageSearch`, so
`store.currentPage` stays `'search'` while one of them is open. Two things follow and
both were live bugs:

- Anything on the search page that reacts to "we are on Search" has to ask whether the
  result list is *actually on screen*, not which page is selected. **The test is
  `#searchResults.offsetParent !== null`, never `style.display`** — the layer is a
  sibling, so the list's own `display` says nothing about whether a layer covers it.
  Infinite scroll uses this; without it, scrolling an album detail paged the hidden list
  underneath and baked dozens of stale cards into it.
- Starting a new search has to close the open layer first. Switching a type tab or
  typing a new query calls `closeArtistDetail()` / `closeAlbumDetail()` /
  `closeShowDetail()` through the **static** import from `spotify.js`. The import cycle
  between the two modules is fine (neither is read during the other's evaluation), and a
  dynamic `import()` would make closing asynchronous — the search would then start
  behind the layer again.

The genre chart is a layer too, but it has no element of its own: it repaints
`#searchResults`. The router cannot see it by visibility, so `openGenre` pushes
`{ layer: 'genre' }` and sets `store.genreOpen`; `closeGenre(fromPopstate)` is exported
for the router's popstate branch and calls `historyBack()` only when the close did not
come from one.

### The empty box is a screen, not a blank

`renderBrowse()` is the **only** renderer of `#searchResults` in the empty state: recent
searches first, genre tiles under them. Recent searches used to be a second renderer —
chips that appeared only while the input was focused, which on a phone meant only with
the keyboard up, and that hid themselves 150 ms after blur. Two renderers of one list
have to agree on the state after a delete, so there is now one.

- The list is stored per account under `ms_recent_searches_${username}`. The old global
  key handed one user's search history to whoever logged in next in the same browser,
  and the list is now visible without any interaction at all. The legacy key is dropped
  on init.
- Emptying the input calls `_cancelSearch()`. Without it an older request still in
  flight comes back and paints results over the screen we just drew.

A failed `/api/genres` is **not** cached. It used to be stored as an empty list and
answered with a blank page for the rest of the session; the cache now stays `null` and
the page offers Try again.

### A provider that fell over is not an empty result

`/api/search/all` returns an `errors` map keyed by `track|artist|album|playlist`. All
four down → one message with a retry button instead of "No results found"; some down →
the affected section renders as an error strip rather than being left out, so a partial
outage does not read as "there simply are no albums".

**`errors` is part of the emptiness test, not just of the rendering.** Three branches
down and the fourth legitimately empty would otherwise fall into "nothing was found" and
throw the fragment away — strips, Try again buttons and every trace of the outage with
it, replaced by the one sentence that claims the opposite. The branch therefore reads
`… && !Object.keys(errors).length`: whenever anything errored, the fragment is rendered
even when it holds nothing but strips.

The single-type path `/api/search` (the Songs/Artists/Albums/Playlists tabs) does **not**
return `errors`, so an outage there still ends on "Search failed". Adding it is backend
work and is deliberately out of this change.

### Placeholder covers are valid URLs

Deezer answers credit entities ("Daft Punk, Pharrell Williams", "Made famous by …") with
a placeholder cover whose path carries an empty hash:
`/images/artist//500x500-000000-80-0-0.jpg`. It loads, `naturalWidth` is 500, and the
`image` field is not empty — so **a placeholder is detected by the shape of the address,
not by the field being empty**. The same holds for Last.fm's universal star. The Artists
tab drops entries that have both a placeholder cover and a comma in the name, and runs
the same `_dedupeByName` the aggregated view already used.

Fuzzy matching also means a nonsense query comes back as a confident page of somebody
else's music. When no result shares a word with the query, a line says so and the
results stay below it as suggestions.

"Shares a word" is **the first four characters, not the whole word**, and both sides go
through the same normalisation. Whole-word equality put "No results for beyonse" above
eighteen cards headed by Beyoncé, and did the same for "thriler" over Thriller and
"michaell jacksonn" over Michael Jackson — a typo keeps the opening of a word but not
the whole of it. Four characters still separates real queries from
`zzzqqqxyznotathing12345`; words shorter than that are compared whole.

The top result is **not** a second test on top of that. `_pick_top_result`
(`search_providers.py`) returns nothing only at its last step, when all four branches
came back empty — and then there is nothing to put the line above either. Measured, the
nonsense query above still gets a `top`, because the picker falls through to `tracks[0]`
when nothing matches the query exactly. Gating the line on "the answer has no top" would
therefore make it dead code; the top is one of the items the single test above already
covers.

### Hero actions are positioned against the artwork

The top-result hero's play / add / radio buttons used to be placed by inline pixel
arithmetic computed from the desktop artwork size, which the mobile breakpoint had no
way to override — at 390px they ended up beside the cover instead of on it. The geometry
is CSS now (`.hero-act-0/1/2` anchored to `--hero-art`, which the breakpoint redefines);
JS only says which button is how many places from the right. An artist hero carries a
play button that fetches `/api/artist/{id}/top` and hands it to `playTracks`; the artist
cards in the grid do not, because each tap there would pay for its own request.
