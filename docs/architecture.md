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

### The queue panel is the contract for what plays next

Everything the panel draws has to be what the engine will actually do. Four rules keep
it that way; all four are in `queue.js` and shared by both engines.

**Shuffle is a permutation, not a dice roll.** `shuffleNext()` walks a Fisher-Yates
permutation of the queue indices and pushes each index it leaves onto a stack;
`shufflePrev()` pops that stack, so Previous retraces the path the listener took rather
than stepping one row up. The old branch picked `Math.random()` *with replacement* every
time, so tracks repeated, a set never finished, and Up Next named a track the engine
would not pick. `playOrder()` returns the permutation and the panel renders in it.

- The order is held over the queue's **items**, not their positions, and reconciled on
  every read: rows that left are dropped, rows that arrived are dealt into the tail,
  everything else keeps its place. Eight places in four modules append to, splice from or
  replace the queue, and positions shift under all of them — an order kept over positions
  names other tracks without noticing. Reconciling on a **length** change alone was worse
  still: one ✕ re-dealt the whole tail, so 49 of 50 rows changed place, while a drag
  changed no length and left the order stale.
- **`data-qi` stays the index into `store.playerQueue`.** The permutation changes the
  order rows are emitted in, never that attribute. This is a safety rule, not a tidiness
  one: a row's ✕ sends its index to the server as a position in the user's Navidrome
  playlist, so a permuted value would delete a different track.
- Shuffle keeps precedence over Smart Queue in the DJ engine. Both want to choose the
  next track and only one can.

**Autoplay goes into the queue.** When the queue runs out, the recommender's pick is
appended to `store.playerQueue` behind an `Autoplay` divider and `playerIndex` moves onto
it, instead of playing beside the queue as it used to — which left the panel marking the
previous track as playing and the title bar showing something no row contained.

- There is no seam inside `recommendations.js` to take the track from: `playNextRec()`
  starts playback itself. The hand-off is marked before that call and consumed in
  `playRecTrack`, which is where the module finally hands the track over. A pick the user
  starts from the recommendations panel is not part of the tail, so a click on a rec row
  or a context menu **voids** the pending hand-off — otherwise a tap landing in the
  network round trip would pin the user's own choice behind the divider. The cancel is on
  the click, not in `playNextRec`'s `.then()`: `getPlayerModule()` is a cached, already
  resolved promise, so the `playRecTrack` it schedules runs *before* that promise settles.
- The recommender's cursor survives a load for as long as the queue carries a tail
  (`loadAndPlay` skips `stopRecPlayback`). Dropping it made the station serve its first
  pick again on the next Next — and append it a second time.
- The append uses `store.playerQueue.push`, **never `concat`**. `search.js` grows the live
  queue only while the array it handed out is still the same object
  (`store.playerQueue !== ctx`), so swapping the array in would silently switch that off.
- The tail is capped at 20 tracks; beyond that the oldest autoplay entries are spliced off
  and `playerIndex` shifts with them. Unbounded, the queue grows for as long as the app is
  open and `saveQueueNow` PUTs the whole thing on every change.
- The divider's position is remembered by object identity, not by index: `upnext.playTracks`
  replaces the whole array, and a remembered index would point into a queue the user has
  since started over. The queue saved to the server carries no divider, so a reload drops it.
- Previous is queue history only. It no longer walks the recommendation list backwards —
  with the picks in the queue, that would step outside what the panel shows. "A track is
  playing virtually" is `_currentRecItem`, not `isPlayingRec()`: the cursor stays set all
  through the tail, and keying on it made Previous restart the tail track instead of
  stepping back. With shuffle on, Previous falls back to the linear step whenever the
  shuffle history is empty — which it is right after the toggle and after every page
  load, because the order is module memory.

**The player bar stays reachable while the queue is open.** `.queue-backdrop` is
`z-index: 249` against the bar's `99`, so the bar was visible through the blur but every
tap on it only closed the queue. `openQueuePanel` adds `queue-open` to `#playerBar` and
`closeQueuePanel` removes it; the class raises the bar to 250. The rule is deliberately
**not** keyed off the backdrop — `#queueBackdrop` is shared with the queue panel inside the
full player, and the bar must stay under that one. Because the lifted bar is now tappable,
`openFullPlayer` closes the small panel first: bar (250) and panel (250) would otherwise
stay on top of the full player (201) and the user would see two players at once. The panel
already owns a history entry, so the full player takes it over with `replaceState` instead
of stacking a second one.

**Remove-from-playlist is offered only in a named playlist.** It deletes the track from the
Navidrome playlist, not just from the queue, and it sits one glyph away from Add. In Up
Next — the implicit queue every ad-hoc session runs in — that distinction means nothing to
the user, so the button is hidden there. Where it does show, it has its own glyph and a red
hover: a tooltip is no warning on a touch device.

Two smaller invariants in the same area:

- **Shuffle and repeat are per-device settings**, mirrored into `ms_shuffle` and
  `ms_repeat_mode`. They live in `store`, which is memory only, and the saved queue carries
  neither — so both silently reverted to off on every reload while the queue came back intact.
- **Below 640 px a queue row hides its tempo badge and its ✕.** The row carries a 36 px
  thumbnail and five controls and leaves `.qi-info` about 150 px, which truncates two
  different tracks to the same string. The kebab removes as well; the elements stay in the DOM.
- **A track cannot be dropped above the one playing.** Playback only moves forward from
  `playerIndex`, so such a move drops the track from the set without saying so.

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

## Back is one level, and every overlay is a level

The whole app is one document, so the browser's Back button is the only way the
system has of saying "the thing I was looking at before". Three rules keep that
honest; all three exist because a press used to do nothing, or two things.

### A layer is visible when `offsetParent !== null`, never when `style.display !== 'none'`

The detail views (`#playlistDetail`, `#showDetail`, `#podcastEpisodes`,
`#tagDetailView`, `#artistDetail`, `#albumDetail`, `#libraryDetail`,
`#likedSongsDetail`) live *inside* a page, not beside it. Switching pages hides
the page, not the layer, so the layer stays marked visible on a screen nobody is
looking at — and `handlePopstate` would close *that* instead of acting on the
page. `offsetParent` is null as soon as any ancestor is hidden, so it answers the
question that was actually being asked.

**The one case where it is wrong:** `offsetParent` is null for every
`position: fixed` element, visible or not. Those (the bottom nav, the player bar,
the queue panel, the full player) are tracked by their own flag in `store`
instead — `store.queuePanelOpen`, `store.fullPlayerOpen`, `store.partyOpen`,
`store.genreOpen`. `position: sticky` is fine.

`switchPage` also hides all eight layers on every page change (`LAYER_IDS` in
`router.js`). Both halves are needed: the test stops a hidden layer from eating
a press, the reset stops it reappearing over the results when the page comes
back.

### A spent `{layer}` entry is stepped over, not swallowed

Each overlay pushes `history.pushState({ layer: '…' })` when it opens. If the
overlay is already gone by the time its entry is popped (the usual case after a
page switch), nothing above claims it and the press would do nothing. The
handler calls `history.back()` again instead, at most `MAX_LAYER_HOPS` times;
past that it lands on the current page and writes a matching `history.state`
rather than risk walking out of the app.

### Every dialog pushes a layer and settles its own Promise

`store.dialogStack` is a LIFO of `{ kind, cancel }`. A dialog registers itself
when it opens (`pushDialog` in `utils.js`, which also pushes the history entry)
and removes itself when it closes (`popDialog`, which calls `historyBack()`
unless the close came *from* a popstate). The Back branch for dialogs is the
**first** thing `handlePopstate` does, above every other overlay flag: a modal is
always the topmost thing on screen, and Back used to close the queue panel
underneath it and leave the modal hanging.

Why a stack and not `document.querySelector('.modal-overlay')`: `querySelector`
returns the **oldest** overlay, which with the playlist picker underneath its own
"New playlist" name modal is exactly the wrong one. The old code also called
`overlay.remove()`, which destroys the DOM but never resolves the Promise — an
`await showPlaylistPicker(...)` hung forever.

**Writing a new dialog:** give it a `kind`, build a `done(value, fromPopstate)`
that goes through `popDialog` first (which makes it idempotent), register
`{ kind, cancel: fp => done(<cancel value>, fp) }`, call `pushDialog` once the
DOM is in place, and short-circuit the opener with `dialogOpen(kind)` so a second
copy cannot stack a second history entry. `showPlaylistPicker`, `showInputModal`,
`showPlaylistFormModal`, `showConfirmModal` and the feedback form all follow this.

Still outside it: `.ctx-menu` (`contextmenu.js`) and the dialogs in `settings.js`
and `playlistimport.js`, which are still caught by the `.modal-overlay` fallback.
That fallback sits **above** the eight in-page detail layers and below the
overlay flags that are painted over it (full player 201, queue panels 249/250,
party 1000). It has to: `.modal-overlay` is `z-index: 200`, so one of these is
over any detail behind it, and testing the details first closed the detail at
the back, switched the page, and left the dialog hanging over a screen it no
longer belonged to. The fallback only ever `remove()`s, so it still does not
settle the dialog's Promise — the fix for that is to bring those four into
`dialogStack`, not to reorder the handler.

## Signing out

`logout()` (`auth.js`) does not hide the app — it reloads the document. Hiding it
left the audio playing, the `mediaSession` notification showing the signed-out
user's track, and every module holding its own copy of their state.

The order matters: `flushQueue()` is awaited **before** `store.currentUser` is
cleared, because the queue save is debounced and is attributed to whoever is
signed in. Then the account's own keys go (`ms_token`, `ms_party_session`,
`ms_recs_feedback_v1`, anything starting `ms_recent_searches`), then
`location.href = '/'`. `ms_device_id`, `ms_player_engine` and `ms_dj_*` describe
the device and stay.

There are three ways out, and they are deliberately not the same:

| control | where | what it does |
|---|---|---|
| `#logoutBtn` | top bar, hidden below 640px | the path above |
| `#accountLogoutBtn` | Settings → Account (open by default) | the same path |
| `#clearCacheBtn` | Settings → App, drawn in `--red` | also wipes caches and every local setting |

The Account section exists because below 640px the entire top bar is
`display: none`, which left "Clear All & Logout" as the only reachable exit — a
destructive reset in place of signing out.

## Provider placeholder images

A provider's "no artwork" image is a **valid URL that loads**. It cannot be
detected by testing for an empty field; it is recognised by the shape of the
address. Last.fm answers with one universal grey star
(`…/2a96cbd8b46e442fc41c2b86b821562f.png`), which `_pick_image`
(`app/services/lastfm.py`) now skips — skips, not returns on, so a placeholder in
`extralarge` cannot hide a real cover in `large`. Dropping it lets the card draw
its own empty state. The same rule applies to Deezer's empty-hash artist avatar.
