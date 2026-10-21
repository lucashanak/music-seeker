# MusicSeeker — Library & Downloads UX audit

Scope: Library page and its sub-tabs (playlists / Spotify / podcasts / favorites / liked songs), library
playlist detail, playlist picker and creation flows, Liked Songs, Favorites, podcast show/episode views,
Downloads page/panel and the download modal. The Spotify-playlist detail (`#playlistDetail` in
`static/js/spotify.js`) was skipped as briefed.

## Method

Read the in-scope files, then drove the live app (`https://musicseeker.hanaktech.org`, version 1.24.3) as
`claude_test` with `localStorage.ms_device_id = 'e2e-audit-library'`, at 1280x900 and 390x844.
Scripts and screenshots live beside this file.
No downloads started, nothing deleted, no settings changed, no project files edited.

Two things shape this report:

- **The library / Liked-Songs row rewrite is already live.** `static/js/library.js` now calls
  `renderSongList` (numbered rows), not `renderResults` (card grid). I diffed the deployed `library.js`
  against the working tree — byte-identical modulo `?v=` import suffixes. So "playlist tracks are a wall
  of album-art tiles" is **not** a finding; it is fixed. Several findings below are *regressions from
  that rewrite*.
- **`claude_test` has no playlists, no podcasts, no favourites, and 8 liked songs** (all `E2E_NP_*` junk
  from a prior e2e run). I was told to create nothing, so for the playlist-detail view I rendered the
  real `renderSongList` plus the exact three elements `library.js` appends (`.lib-bulk-cb` prepended,
  `.card-drag-handle` and `.lib-track-remove` appended) into the real `#libraryTracks` with the real CSS,
  client-side only, no API writes. Layout/CSS findings from that are faithful; they are flagged
  **simulated** rather than observed on real data.

Legend:

- **[B]** verified in the browser on real data
- **[S]** verified in the browser against a faithful client-side simulation (real renderer, real CSS,
  real DOM additions; synthetic track data)
- **[C]** read in code only

Tool-level caveat: the app's module imports are rewritten server-side to carry a `?v=<cachebust>` query,
so a `page.evaluate` that does `import('/static/js/store.js')` gets a *second* module instance. Any
reading of `store.*` taken that way is meaningless and none is relied on below.

---

## Top 5

1. **#1** — Liked Songs tile renders as a 1142px green slab
2. **#2** — Library playlist rows are unreadable on a phone (title collapses to ~42px)
3. **#3** — Liked Songs tile says "0 songs" when you have songs
4. **#4** — A Lidarr job reports DONE + "Download Complete" before anything has downloaded
5. **#5** — Single-track downloads show a progress bar that never moves

---

## Real defects

### 1. The Liked Songs tile renders as a full-width 1142px square — **high** — [B]

**What the user sees.** Opening Library, the entire first screen is one unlabeled green rectangle. The
words "Liked Songs" and the song count are ~1200px below the fold. On mobile the tile is 358 x 413 px and
still eats half the screen.

**Where.** `static/index.html:346` — `<div class="card lib-card" id="likedSongsTile">` is a direct child
of `#libraryList`, *outside* `#libraryGrid` (`static/index.html:353`). `.card-img` is `aspect-ratio: 1/1`
(`static/css/cards.css`), so the tile takes the full container width and squares itself.

**Evidence.** Measured live: tile 1144 x 1209 px, `.card-img` 1142 x 1142, while grid cards are 212.8px
wide. Screenshots `02-library-viewport.png`, `01-library-downloaded.png`, `03-mobile-library.png`.

**Smallest fix.** Move the tile inside `#libraryGrid` as its first child so it sizes like every other
card — or, if it must stay above the grid, wrap it in its own single-column `.grid`.

---

### 2. Library playlist rows: the track title collapses to ~42px on a phone — **high** — [S]

**What the user sees.** At 390px, every row in a library playlist reads `Inst...` / `Daft ...`. Titles and
artists are unreadable; the row is almost entirely buttons.

**Where.** Each row carries, in order: `.lib-bulk-cb`, `.song-num`, 44px `.song-thumb`, `.song-info`,
`.song-duration`, `.card-play-btn`, `.kebab-btn`, `.like-btn`, `.card-drag-handle`, `.lib-track-remove`.
Added by `static/js/library.js:853-871` (`_addBulkCheckboxes`), `static/js/library.js:898-917`
(`_addRemoveButtons`), `static/js/library.js:509-522` (`_addDragHandles`), on top of what
`renderSongRows` already appends (`static/js/search.js:702+`).

**Evidence.** Measured: `song-info` **42px** wide at 390px (884px at 1280px). ~232px of the 390px row is
fixed-width chrome plus gaps. Screenshots `17-liked-rows-m.png`, `22-libdetail-m.png`.

**Smallest fix.** Under the mobile breakpoint in `static/css/search.css`, hide `.lib-bulk-cb`,
`.card-drag-handle` and `.lib-track-remove` on `#libraryTracks .song-row` — all three actions are already
reachable from the kebab / long-press menu (`_libraryTrackInfo`, `static/js/library.js:608-633`) — and
give `.song-info` `min-width: 0; flex: 1`.

---

### 3. The Liked Songs tile shows "0 songs" until you open the view — **high** — [B]

**What the user sees.** Open Library: the tile reads "0 songs". Wait, navigate away, come back: still
"0 songs". Open Liked Songs — the header says "8 songs". Press Back — the tile now reads "8 songs".
Your liked music looks empty until you happen to tap into it.

**Where.** `static/js/library.js:164` — `loadLibrary()` calls `_refreshLikedCount()` synchronously, before
the fire-and-forget `loadLikes(true)` from `static/js/auth.js:205` has resolved. The `likeschange`
listener (`static/js/library.js:1026` -> `_rerenderLikedSongs`, `static/js/library.js:968-971`)
early-returns unless `_likedViewOpen`. Re-entering Library cannot help either, because
`switchLibraryTab` early-returns on a cached tab (`static/js/library.js:89`).

**Evidence.** Reproduced twice live: `A after 6s on library: 0 songs` / `B after leaving+returning:
0 songs` / `C after opening+closing liked: 8 songs`.

**Smallest fix.** `static/js/library.js:164` -> `loadLikes().then(_refreshLikedCount)`, and move
`_refreshLikedCount()` above the `_likedViewOpen` guard in `_rerenderLikedSongs`.

---

### 4. Lidarr jobs report DONE and fire a "Download Complete" notification before anything downloads — **high** — [C]

**What the user sees.** Hand a job to Lidarr and the Downloads panel shows a green **DONE** badge plus a
browser notification "MusicSeeker - Download Complete". No file exists yet; Lidarr is still working. The
only text that says so is clipped mid-sentence: "Search triggered in Lidarr, download will proceed in
backgro...".

**Where.** `app/services/downloader.py:734-735` ends `_run_lidarr` at progress 90 with that message;
`app/services/downloader.py:99-101` then sets `status = DONE, progress = 100` for any method.
`static/js/downloads.js:186` renders the status badge; `static/js/downloads.js:217-240`
(`checkJobCompletions`) fires the notification on `done`. `static/css/downloads.css:36` clips the
explanatory line to one line.

**Evidence.** Code-read, plus a faithful replay of `refreshJobs`'s own markup into the real panel —
`27-jobs-states.png`, row 4.

**Smallest fix.** Give Lidarr hand-offs a distinct terminal state (e.g. `handed-off`, rendered "Sent to
Lidarr") and skip the completion notification when `j.method === 'lidarr'`.

---

### 5. Single-track downloads show a progress bar stuck at 0% — **high** — [C/S]

**What the user sees.** The most common download — one track — shows a RUNNING badge, "yt-dlp / flac",
a Cancel link and "1/1 — Downloading Artist - Title", with a progress bar that stays empty for the whole
download, then jumps to done. No percentage, no ETA, no motion. It reads as stuck.

**Where.** `app/services/downloader.py:416` — `job.progress = int((i - 1) / total * 100)`; with
`total == 1, i == 1` that is **0** for the entire job (identical at `:663` for slskd).
`static/js/downloads.js:189` renders `width: 0%`, and the groove `.job-progress-bar` is `var(--bg-input)`
on a `var(--bg-elevated)` card (`static/css/downloads.css:34`), so it is effectively invisible.

**Evidence.** Code-read, plus `27-jobs-states.png` — compare row 1 (single track, 0%) with row 2
(13-track album, 38%).

**Smallest fix.** Report real progress on the single-track path (yt-dlp already emits percentages), or at
minimum render an indeterminate/striped bar when `progress === 0 && status === 'running'`.

---

### 6. Heart button on library playlist rows sits 16px above the row — **medium** — [S]

**What the user sees.** In a library playlist, the heart on every row floats visibly higher than the
kebab, the track number and the title — it overhangs the top edge of its own row.

**Where.** `static/index.html:77` still carries the card-era rule
`#libraryTracks .card .like-btn { top:50%; bottom:auto; right:52px; transform: translateY(-50%); }`.
`static/css/search.css:207` resets `position: static` for `.song-list .song-row .like-btn` but **not**
`transform`, so the -50% shift survives the rewrite.

**Evidence.** Measured: row top 674, height 62 (centre 705); every child centres at 705 except
`.like-btn`, whose top is 673 — one pixel above the row's own top. Visible in `22-libdetail-d.png`.
Scoped to `#libraryTracks`, so Liked Songs (`#likedSongsTracks`) is unaffected — this is a fresh
regression from the row rewrite.

**Smallest fix.** Delete `static/index.html:77`, or add `transform: none` to the
`.song-list .song-row .like-btn` rule at `static/css/search.css:207`.

---

### 7. "No playlists yet" empty state is squeezed into one grid column — **medium** — [B]

**What the user sees.** An empty library shows a ragged four-line paragraph hugging the far-left edge of
an otherwise empty 1144px page. On mobile it wraps to five short lines.

**Where.** `static/js/library.js:329` writes `.empty-state` into `#libraryGrid`, which is a `.grid`
(`static/index.html:353`, `static/css/cards.css:14`), so the message becomes a single grid item.
Same pattern at `static/js/library.js:174` (library load error) and `static/js/library.js:481`
(playlist load error).

**Evidence.** Measured: empty state **213px** wide inside a **1144px** grid. Screenshots
`23-empty-library-desktop.png` (tile temporarily hidden so the state is visible at all) and
`03-mobile-library.png`.

**Smallest fix.** One rule in `static/css/pages.css`: `.grid > .empty-state { grid-column: 1 / -1; }`.

---

### 8. "Add to playlist" in the multi-select menu adds to the queue, not a playlist — **medium** — [C/B]

**What the user sees.** Multi-select tracks in a playlist, open the menu: "+ Add to playlist" and, right
below it, "Add to other playlist...". The first silently appends to the in-memory queue and toasts
"Added N to playlist". The second is the one that opens the picker and writes to a real Navidrome
playlist. Nothing distinguishes them.

**Where.** `static/js/library.js:782-789` — label `Add to playlist`, handler
`m.addToQueue(selectedItems)`, toast `Added ${count} to playlist`; the real action is at
`static/js/library.js:791`. The same ambiguity exists in the generic menu:
`static/js/contextmenu.js:218` chooses the label `'Add to playlist'` whenever `store.playlistMode` is
set, and `static/js/upnext.js:46-47` sets it to the auto-created "Up Next" playlist on boot.

**Evidence.** Code-read for the multi-select menu; the generic case verified live — a plain search-result
kebab shows both "+Add to playlist" and "Add to other playlist..." (`08-ctx-track.png`).

**Smallest fix.** Label the queue action "Add to queue" (or "Add to Up Next") and rename the picker action
to plain "Add to playlist...".

---

### 9. The per-row remove button deletes a track with no confirmation and no undo — **medium** — [S]

**What the user sees.** A 30px x on every playlist row that deletes the track from the playlist the
instant it is tapped. Deleting a whole *playlist* gets both a confirm modal and a 5-second undo; removing
a track gets neither. On mobile that button sits 24px from the drag handle in a row whose title is 42px
wide — a mis-tap silently removes a track.

**Where.** `static/js/library.js:898-917` (`_addRemoveButtons`) fires
`DELETE /api/library/playlist/{id}/tracks` immediately. The undo pattern it should use already exists at
`static/js/library.js:410-444` (`_schedulePlaylistDelete`).

**Smallest fix.** Route row removal through the same optimistic-remove + "Undo" toast, and hide the
button on narrow viewports (see #2).

---

### 10. "Clear History" wipes all job history with no confirmation — **medium** — [B/C]

**What the user sees.** A small chip immediately left of the Downloads panel's close button. One tap
irreversibly deletes every finished/failed/cancelled job record. Easy to hit while reaching for close.

**Where.** `static/index.html:1439` (position) and `static/js/downloads.js:282-284` — `DELETE /api/jobs`
with no confirm and no undo; `app/services/jobs.py:129-140` removes the records server-side.

**Evidence.** Button position verified live (`05-downloads-panel.png`, `15-mobile-downloads.png`); the
button was **not** clicked.

**Smallest fix.** Wrap it in `showConfirmModal`, as the library's destructive actions already are.

---

### 11. Download errors are truncated to one line with no way to read the rest — **medium** — [S]

**What the user sees.** A failed job shows
`ERROR: [youtube] Sign in to confirm you are not a bot. Use -...` — the actionable half is gone. No
tooltip, no expand, no wrap.

**Where.** `static/js/downloads.js:191` renders `j.error` into `.job-progress-text`, which is
`white-space: nowrap; overflow: hidden; text-overflow: ellipsis` (`static/css/downloads.css:36`).

**Evidence.** `27-jobs-states.png`, row 5.

**Smallest fix.** Let the error line wrap (`white-space: normal` with a 2-3 line clamp) and add
`title="${esc(j.error)}"` to the element.

---

### 12. Tapping a followed artist opens a download dialog, not the artist — **medium** — [C]

**What the user sees.** In Favorites, tapping an artist you follow opens the download modal (method,
format, Download) instead of the artist's page.

**Where.** `static/js/favorites.js:63-69` -> `openFavoriteModal` (`static/js/favorites.js:85-95`) ->
`openModal({type:'artist'})` in `static/js/downloads.js:10`. The artist page exists and is reachable —
the context menu's "Open artist" calls `loadArtistDetail` (`static/js/contextmenu.js:635-643`) — just not
from the tap.

**Evidence.** Code-read only; `claude_test` has no favourites.

**Smallest fix.** Make the card click call the same `_openArtist` path and leave downloading to the kebab.

---

### 13. Kebab "Remove from <playlist>" removes by name, not index — **low** — [C]

**What the user sees.** With the same track twice in a playlist, the wrong copy can disappear.

**Where.** `static/js/library.js:660-671` posts `/remove-by-name` with only `{name, artist}`, while the
backend accepts an exact `index` (`app/routers/library.py:277-283`) and the queue path does pass it
(`static/js/contextmenu.js:490`). Three removal paths in the same view disagree: kebab is by name, the
inline remove button and the bulk action are by index.

**Smallest fix.** Pass `index: idx` — it is already in scope at `static/js/library.js:660`.

---

### 14. Native `confirm()` / `alert()` in podcasts and downloads — **low** — [C]

**What the user sees.** Destructive podcast actions and download errors pop OS-native dialogs, while
everything in Library uses the app's own styled modals and toasts. Inside the Android WebView and on
mobile these read as a different application.

**Where.** `static/js/podcasts.js:40, 144, 202, 233, 265, 274` (and more);
`static/js/downloads.js:213, 273`. Contrast `showConfirmModal` / `showToast` throughout
`static/js/library.js`.

**Smallest fix.** Swap for `showConfirmModal` / `showToast` from `static/js/utils.js`.

---

### 15. "Downloads" in the bottom nav never takes the active state — **low** — [B]

**What the user sees.** On mobile, open Downloads: the panel fills the screen but the highlighted
bottom-nav tab is still whatever you were on.

**Where.** `static/js/router.js:18-21` toggles the panel and returns before any nav bookkeeping.

**Evidence.** Measured live with the panel open: `activeNav: ['search']`. `15-mobile-downloads.png`.

**Smallest fix.** Toggle the `active` class on `.bnav-btn[data-page="downloads"]` alongside
`openPanel()` / `closePanel()`.

---

## Spotify parity gaps

### 16. The playlist hero is a 421px box holding seven stacked buttons — **high** — [S]

**What the user sees.** Opening a library playlist: a mostly empty 421px-tall card with the cover and
title floating mid-left and a vertical stack of seven right-aligned buttons — Play All, + Add All, Edit,
Change cover, Duplicate, Merge, Delete — with a red **Delete** no less prominent than Edit. Spotify shows
a cover, a title, one green play button, and everything else behind a kebab.

**Where.** `static/index.html:386-394`, with `.playlist-hero-actions { flex-direction: column }`
(`static/css/pages.css:106`).

**Evidence.** Measured hero height **421px** desktop, **353px** mobile. `22-libdetail-d.png`,
`22-libdetail-m.png`.

**Smallest fix.** Keep Play All (and Shuffle, see #17) in the hero; move Edit / Change cover / Duplicate /
Merge / Delete into one kebab via the existing `makeKebabButton` and the handlers already wired in
`static/js/library.js:1063-1161`.

---

### 17. No Shuffle on a library playlist — **medium** — [B/C]

**What the user sees.** Liked Songs has Play All + Shuffle and the Spotify playlist detail has
Play All + Shuffle, but a library playlist offers only Play All. Shuffle is the most-used control on a
Spotify playlist.

**Where.** `static/index.html:386-394` has no shuffle button for `#libraryDetail`; compare
`#shuffleLikedSongs` (`static/index.html:374`) and `#shufflePlaylist`.

**Smallest fix.** Add a Shuffle button beside `#playLibPlaylist`, reusing the
`playLikedSongs` / `shuffleLikedSongs` pair at `static/js/library.js:1028-1039` against
`getLibTracksForPlayer()`.

---

### 18. Liked Songs rows show no duration, and the header no total time — **medium** — [B]

**What the user sees.** Every Liked Songs row has an empty gap where the duration should be, and the
header says only "8 songs" — no total running time. The library playlist detail does both correctly.

**Where.** `static/js/likes.js:87` never stores `duration_ms` when a track is liked, and the server-side
liked set does not carry it; `static/js/library.js:954` sets `#likedDetailCount` to a bare count. Contrast
`_setLibDetailCount` (`static/js/library.js:133-138`), which sums `duration_ms` and renders
"N tracks - 1 h 38 min".

**Evidence.** Measured live: `song-duration` width **0** on every Liked Songs row.
`18-liked-real-d.png`, `20-liked-desktop.png`.

**Smallest fix.** Persist `duration_ms` on like (`static/js/likes.js:73-88` already builds the body) and
compute the hero total the way `_setLibDetailCount` does.

---

### 19. No filter or sort inside a playlist or Liked Songs — **medium** — [B]

**What the user sees.** Podcast episodes get a filter box and playlists get a BPM filter, but there is no
"Search in playlist" and no sort (title / artist / album / date added) anywhere in Library. On a long
playlist the only way to find a track is to scroll.

**Where.** `#podcastEpFilter` (`static/index.html:489`) exists; `#libraryDetail` and `#likedSongsDetail`
have no equivalent.

**Smallest fix.** Reuse the podcast filter pattern (`static/js/podcasts.js:242-248`) — a single input
that toggles `row.style.display` — above `#libraryTracks` and `#likedSongsTracks`. Note `Play All` already
respects hidden rows (`getLibTracksForPlayer`, `static/js/library.js:1274-1279`), so it composes cleanly.

---

### 20. Dead-end empty states — **medium** — [B]

**What the user sees.** Podcasts: "No downloaded podcasts yet" under a bare "Downloaded" heading, beside a
"Sync All" button that does nothing when there are no subscriptions. Favorites: "No favorite artists yet.
Click the heart icon on any artist to follow them" — accurate, but that heart is `opacity: 0` until hover
on desktop (`static/css/cards.css:141-142`). Downloads: "No downloads yet". None of the three offers a
route to the thing that would fill it.

**Where.** `static/js/podcasts.js:70`, `static/index.html:508-510`, `static/js/downloads.js:177`.

**Evidence.** `11-podcasts.png`, `12-favorites.png`, `05-downloads-panel.png`.

**Smallest fix.** Give each a primary CTA that jumps to Search pre-set to the right type — `_searchFor`
already exists (`static/js/contextmenu.js:624-633`).

---

### 21. The download modal cannot add to a playlist or like the track — **medium** — [B]

**What the user sees.** The track sheet offers Play Now, + Add to Queue, Radio, Follow and Download. The
two actions a Spotify user expects — "Add to playlist" and the heart — are only in the kebab menu, so the
same track offers different options depending on how it was opened.

**Where.** `static/index.html:1168-1221` (modal markup); the actions exist in
`buildActionsFor` (`static/js/contextmenu.js:341-355`).

**Evidence.** `10-download-modal.png`.

**Smallest fix.** Add a heart (`makeHeartButton`, `static/js/likes.js:124`) and an "Add to playlist..."
chip (`_addToNavidromePlaylist`, `static/js/contextmenu.js:570`) to `.modal-quick-row`.

---

### 22. Library playlist cards have no visible kebab — **low** — [C]

**What the user sees.** On touch, the only way to rename or delete a playlist from the grid is a 480ms
long-press with nothing hinting that it exists. The imported-playlist cards right below *do* show one.

**Where.** `renderLibraryGrid` (`static/js/library.js:341-347`) binds a click handler plus
`attachContextMenu` but never appends a kebab; `renderImportedGrid` does
(`static/js/library.js:229`).

**Smallest fix.** `card.appendChild(makeKebabButton(() => ...))` in `renderLibraryGrid`, mirroring
`renderImportedGrid` — the action list is already built in the `getItem` at
`static/js/library.js:350-364`.

---

### 23. Jobs are one flat chronological list — **low** — [S]

**What the user sees.** No "Active / Completed" split, no aggregate ("3 downloading"), no ETA, speed or
size, and no per-job dismiss — only Clear-all. A long-running job started before several quick ones sinks
below them.

**Where.** `static/js/downloads.js:178-193` renders a flat `map`; `app/services/jobs.py:111` sorts by
`started_at` descending with no cap and no grouping.

**Smallest fix.** Partition the array into active and finished before rendering, and put a count in the
panel header.

---

## Nice to have

- **"Select all" is permanently visible above every playlist** (`static/index.html:398-403`). Spotify has
  no persistent multi-select; a kebab "Select tracks" entry would reclaim the row. [B]
- **`libBulkToggle` and the BPM filter disagree.** `static/js/library.js:1170` selects only visible cards,
  but `_updateBulkUI` compares `_selectSet.size` against *all* cards
  (`static/js/library.js:882`), so with a filter active "Select all" leaves the master checkbox stuck
  indeterminate. [C]
- **`#libBulkActions` declares `display` twice** (`static/index.html:401`:
  `style="display:none;gap:8px;display:none;align-items:center;"`). Harmless — JS sets `flex` — but it
  reads as a leftover. Same shape at `#podcastBulkBar` (`static/index.html:497`). [C]
- **Modal title has no tooltip.** `#modalTitle` is single-line ellipsised (`static/css/modal.css`), so
  "Instant Crush (feat. Julia..." cannot be read in full. Add `title` from `item.name`. [B]
- **`refreshJobs` swallows every error** (`static/js/downloads.js:201`, bare `catch {}`): if `/api/jobs`
  starts failing the panel silently shows stale state forever. Not theoretical — this host returned
  transient 502s twice during the audit. [C]
- **The imported-playlist section's copy is the best in the app** — "These stream — they aren't in
  Navidrome until you download them" (`static/index.html:357`). Worth copying that tone into the
  Podcasts/Favorites/Downloads empty states. [B]

---

## Not verified

- **Playlist detail on real data** — drag-to-reorder, bulk copy/remove, merge, duplicate, cover change.
  The test account has no playlists and I was told to create nothing. Findings 2, 6, 9 and 16 come from
  the real renderer and real CSS with `library.js`'s exact DOM additions injected client-side; the
  behavioural parts of 9 and 13 are code-read.
- **Any live download.** Findings 4, 5 and 11 are from `app/services/downloader.py` /
  `static/js/downloads.js` plus a faithful replay of `refreshJobs`'s own markup into the real panel
  (`27-jobs-states.png`).
- **Favorites and Podcasts with data** — both empty on `claude_test`, so finding 12 and part of 20 are
  code-read.
- **The Spotify sub-tab is hidden on this account** (`store.spotifyStatus.available === false`,
  `static/js/library.js:42`), so Library shows three tabs, not four. The Spotify sub-view was therefore
  not exercised.

## Housekeeping note

`claude_test`'s Liked Songs currently holds 8 `E2E_NP_*` rows left over from an earlier e2e run
(`20-liked-desktop.png`). Worth clearing before the next audit so counts mean something.

---

## Screenshot index

| File | What |
|---|---|
| `01-library-downloaded.png` | Library, full page, desktop |
| `02-library-viewport.png` | Library first screen, desktop — finding #1 |
| `03-mobile-library.png` | Library, 390x844 — findings #1, #7 |
| `05-downloads-panel.png` | Downloads panel empty, desktop — findings #10, #20 |
| `08-ctx-track.png` | Track context menu — finding #8 |
| `09-playlist-picker.png` | Playlist picker with zero playlists |
| `10-download-modal.png` | Download modal — finding #21 |
| `11-podcasts.png` | Podcasts empty — finding #20 |
| `12-favorites.png` | Favorites empty — finding #20 |
| `13-new-playlist-modal.png` | New playlist form |
| `14-import-modal.png` | Import playlist form |
| `15-mobile-downloads.png` | Downloads panel, mobile — findings #10, #15 |
| `17-liked-rows-m.png` | Simulated library rows, mobile — finding #2 |
| `18-liked-real-*.png`, `20-liked-desktop.png` | Real Liked Songs — findings #3, #18 |
| `22-libdetail-d.png`, `22-libdetail-m.png` | Simulated playlist detail — findings #2, #6, #16 |
| `23-empty-library-desktop.png` | Empty library with the tile hidden — finding #7 |
| `27-jobs-states.png` | All six job states replayed — findings #4, #5, #11, #23 |
