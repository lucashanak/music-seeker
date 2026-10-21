# MusicSeeker — playback UX audit (mini player, full player, queues, DJ/radio entry)

**Scope:** mini player bar, full-screen player, both queue panels, queue reordering, Up Next
semantics, DJ panel, radio entry points, end-of-queue behaviour.
**App:** https://musicseeker.hanaktech.org — v1.24.3, account `claude_test`, device id
`e2e-audit-player`.
**Method:** read `static/js/player.js`, `player_v3.js`, `player_active.js`, `fullplayer.js`,
`queue.js`, `upnext.js`, `playcontext.js`, `prefetch.js`, `cast.js`, `remote.js`,
`static/css/player.css`, `static/css/responsive.css`, `static/index.html`; then drove the live
app with raw Playwright on **1280x900** and on a **Pixel 5 (393x727) with real CDP
`Input.dispatchTouchEvent` gestures**.
**Engine actually in use for this account: `classic` (`player.js`).** Where `player_v3.js` (the DJ
engine) carries the same defect, both line numbers are cited.
**Read-only:** nothing downloaded, no settings changed, no playlists deleted, no files edited.
The only side effect is that normal playback rewrote the test account's own
`__upnext_e2e-audit-player` temp playlist.

Scripts and screenshots:
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/audit-player/`

---

## Top 5

| # | Finding | Severity |
|---|---------|----------|
| 1 | Queue panel's backdrop blocks every playback control | high |
| 2 | Shuffle makes the queue panel lie about what plays next; Previous is broken under it | high |
| 3 | When the queue ends, an off-queue track starts and the queue marks the *wrong* row as playing | high |
| 4 | Next on the last queued track does nothing, silently | high |
| 5 | Mobile queue rows truncate titles to ~15 characters — rows become indistinguishable | medium |

---

# A. Real defects

## 1. While a queue panel is open you cannot play/pause/skip — HIGH
*Verified in browser (both viewports).*

**What a user sees:** they open the queue to check what's next, then reach for pause — and the
player bar is still visible (blurred) at the bottom but does nothing. Any tap on it just closes
the queue. On the phone the whole bottom bar is behind the blur.

**Evidence:** `document.elementFromPoint()` over the centre of `#playerPlayPause` returns
`queueBackdrop` with the queue open, on both 1280x900 and Pixel 5. Playwright refused an earlier
click outright: *"`<div id="queueBackdrop" class="queue-backdrop open">` intercepts pointer
events"*.

**Where it lives:** `static/css/player.css:166` — `.queue-backdrop { position: fixed; inset: 0;
z-index: 249; }` with `pointer-events: auto` when `.open` (`player.css:167`), against
`static/css/player.css:5` — `.player-bar { z-index: 99 }`.

**Smallest fix:** keep the bar above the backdrop while a panel is open —
`body.queue-open .player-bar { z-index: 251 }` (set the class in `openQueuePanel` /
`openFpQueuePanel`, `static/js/queue.js:213` and `:361`) — or give the backdrop
`inset: 0 0 var(--player-height) 0`.

---

## 2. Shuffle: the queue shows an order that is not the one that plays, and Previous is broken — HIGH
*Verified in browser.*

**What a user sees:** with shuffle on, the Up Next list still reads in playlist order, so the row
it labels "2" is not what plays next. Pressing Previous does not return to the track they just
heard. With repeat off, shuffle never finishes — it keeps picking forever and repeats tracks.

**Evidence (desktop):**
- Queue row #2 read `Get Lucky (Radio Edit...)` both before and after enabling shuffle; pressing
  Next played **`Solar Sailer`**.
- Four Nexts with shuffle on: `Solar Sailer -> Burnin' / Too Long -> End Of Line (feat. TRS-80) ->
  Digital Love` — none of it reflected in the panel.
- Two Prev presses from there landed on **`Something About Us`**, not `End Of Line`.

**Three distinct problems in one branch:**
1. the queue list is never reordered, so it is simply wrong about what is next;
2. selection is `Math.random()` **with replacement** (only the current index is excluded), so
   tracks repeat and the set never completes — Spotify plays each track once, then stops or
   repeats;
3. Previous is positional (`playerIndex--`), not playback history.

**Where it lives:**
- `static/js/player.js:333-338` and the identical `static/js/player_v3.js:1243-1247`
- Previous: `static/js/player.js:439-441`, `static/js/player_v3.js:1498-1500`
- art-swipe-right duplicates the positional Prev instead of calling `prevTrack()`:
  `static/js/fullplayer.js:466-468`
- render order comes from `store.playerQueue` as-is: `static/js/queue.js:91`

**Smallest fix:** on `toggleShuffle` (`static/js/fullplayer.js:33`) build a shuffled permutation
of indices once, walk it for Next, and render `renderQueueInto` in that order; push each played
index on a history stack that Prev pops.

---

## 3. When the last queued track ends, an off-queue track starts and the queue marks the wrong row as playing — HIGH
*Verified in browser.*

**What a user sees:** the queue finishes, music keeps going with a track they never queued, there
is no toast and no new queue row — and if they open the queue, the play marker sits on the
*previous* track while something else is audibly playing. There is no label saying this is
autoplay and no way to turn it off.

**Evidence:** trimmed the queue to 2 tracks (`Instant Crush`, `Get Lucky (Radio Edit)`), seeked the
last one to `duration - 5` and let it end. The player bar then showed **`One More Time` — Daft
Punk**, `paused: false`. The queue panel still listed only the two original tracks, with
**`Get Lucky` highlighted as now-playing** (screenshot `14-natural-end-queue.png`). Zero toasts
captured by a `MutationObserver` on `.toast`.

**Where it lives:** `static/js/player.js:375-381` (`_nextTrackInQueue` -> `playNextRec()`), same at
`static/js/player_v3.js:1364-1370`. The stale marker is `renderQueueInto` keying off
`store.playerIndex` (`static/js/queue.js:92`), which virtual rec playback never updates
(`playRecTrack`, `static/js/player.js:350-408`, paints the bar directly and leaves the queue
untouched).

**Smallest fix:** have the rec path append the track to `store.playerQueue` and advance
`playerIndex` (i.e. play it through `loadAndPlay`) instead of playing it virtually, plus a one-line
"Autoplay" divider row in `renderQueueInto`. Spotify appends autoplay picks to the queue under a
labelled header and offers a settings toggle.

---

## 4. Next on the last queued track does nothing, silently — HIGH
*Verified in browser.*

**What a user sees:** they press Next at the end of the queue and absolutely nothing happens —
same track keeps playing, no message, no pause. (Pressing it again later does work, because by
then the recommendations have loaded.)

**Evidence:** on the last of 2 tracks, clicking `#playerNext` fired `POST
/api/player/recommendations` and then nothing: identical `audio.src`, identical title,
`currentTime` 4.6s -> 16.7s over 12 s of waiting, `paused: false`. Note this contradicts #3 — the
natural `ended` path on the same track *does* advance, so the button and the end-of-track path
behave differently.

**Where it lives:** `static/js/player.js:375-381` — the `playNextRec()` promise only pauses on
`!filled`; nothing handles "the rec fetch hasn't returned yet".

**Smallest fix:** show a toast while the rec fetch is in flight ("Finding something to play
next...") and fall back to pausing with "End of queue" when it returns nothing.

---

## 5. Shuffle and repeat reset to off on every reload — MEDIUM
*Verified in browser.*

**What a user sees:** they set shuffle on and repeat-all, reload or come back later, and both are
silently off again — while the queue itself was faithfully restored, which makes it look like the
settings *should* have persisted too.

**Evidence:** set shuffle + repeat-all, waited 4 s for the queue save, reloaded. After reload:
queue intact (100 rows, now-playing index 2, correct title), but
`#playerShuffle.classList.contains('active') === false` and `#playerRepeat.title === 'Repeat off'`.

**Where it lives:** `static/js/store.js:138-139` (in-memory only); the save payload omits them
(`static/js/player.js:530-544`), and a repo-wide grep finds no `localStorage` or JSON persistence
for `shuffleEnabled` / `repeatMode`.

**Smallest fix:** add both to the `/api/player/queue` PUT body and restore in `loadQueueState`
(`static/js/player.js:554`), or simplest — mirror to `localStorage` inside `toggleShuffle` /
`toggleRepeat` (`static/js/fullplayer.js:33-42`) and read back in `syncShuffleRepeatUI`.

---

## 6. The full player is 99 % opaque — the page behind ghosts through — MEDIUM
*Verified in browser (both viewports; worst on mobile).*

**What a user sees:** the search results they came from are plainly legible *behind* the album art
and controls. It reads as a rendering bug.

**Evidence:** computed style is
`background-image: linear-gradient(rgba(28,28,40,0.99) 0%, rgba(10,10,16,0.99) 100%)` over
`background-color: rgba(0,0,0,0)`. Screenshot `21-m-fullplayer.png` (Pixel 5) shows the "daft
punk" search box, the type filter chips and several track rows through the overlay.

**Where it lives:** `static/css/player.css:42`.

**Smallest fix:** alpha `1` on both gradient stops, or add `background-color: var(--bg)` to
`.full-player`.

---

## 7. Mobile queue rows truncate titles to the point of ambiguity — MEDIUM
*Verified in browser (Pixel 5).*

**What a user sees:** `Instant...`, `Get Lucky ...`, `Lose Y...`, `Harder...`. Rows 2 and 5 are
*both* `Get Lucky ...` and genuinely cannot be told apart — one is the Radio Edit. The queue stops
being a usable answer to "what's coming".

**Evidence:** screenshot `24-m-queuepanel.png` at 393 px. Each row carries a 36 px thumbnail plus
five controls — drag handle, BPM badge, heart, kebab, remove — leaving `.qi-info` about 150 px.

**Where it lives:** row template `static/js/queue.js:91-103`; sizing
`static/css/player.css:181-189`.

**Smallest fix:** under `@media (max-width: 640px)` hide `.qi-bpm` and `.qi-remove` (the kebab
already offers Remove) and let `.qi-info` take the width.

---

## 8. The swipe-up-to-open-queue gesture is dead across the whole bottom of the full player — MEDIUM
*Verified in browser with real touch events.*

**What a user sees:** the natural Spotify gesture — swipe up from the bottom of the now-playing
screen to reveal Up Next — does nothing. The only reliable entry is the hamburger at the top
right, which is not where the queue lives.

**Evidence:** instrumented touch logging shows a swipe starting at 90 % of `#fpPlayerSide` height
resolves to `target=fpRemoveFromPlaylist, interactive=true` -> the handler bails immediately.
Swept 0.66 -> 0.99 of the panel height in fresh sessions:

| start | element hit | queue opened |
|---|---|---|
| 0.66 | `fpArtist` | **yes** |
| 0.70 | `.fp-progress` | no |
| 0.75 | `.fp-times` | no |
| 0.80 | `fpPlayPause` | no |
| 0.85 | `fpPlayPauseIcon` | no |
| 0.90 | `.fp-controls` (really `fpRemoveFromPlaylist`'s touch area) | no |
| 0.95 | SVG inside a button | no |
| 0.99 | `.fp-actions` | yes |

So the gesture works only over the artist text and the last few pixels.

**Where it lives:** `static/js/fullplayer.js:562-563` — the queue gesture reuses the
swipe-to-close guard `e.target.closest('button, input, .fp-progress-bar')`.

**Smallest fix:** drop the `button` term from the guard on *this* handler only (keep `input,
.fp-progress-bar`). The gesture commits only after >40 px of vertical travel, so it cannot steal a
tap. Better still, add a visible "Up next: <track>" peek strip at the bottom that is both tappable
and swipeable.

---

## 9. "Add to playlist" and "Remove from playlist" are adjacent, near-identical, unlabelled box icons — MEDIUM
*Verified in browser.*

**What a user sees:** a plus-in-a-box and a minus-in-a-box sitting side by side on the player bar
(and again in the full player). Nothing but a hover tooltip distinguishes them, and on mobile
there is no hover at all. The minus removes the now-playing track from the queue *and* from the
backing Navidrome playlist.

**Evidence:** `05-bar-shuffle-on.png` and `21-m-fullplayer.png` show both. The remove button is
visible for **every** user, always, because `initUpNext()` sets `store.playlistMode` to "Up Next"
at boot (`static/js/upnext.js:41-50`) and `updatePlaylistBadge` keys visibility off that
(`static/js/player.js:172-183`).

**Where it lives:** `static/index.html:1249-1250` (bar), `static/index.html:1301-1302` (full
player).

**Smallest fix:** give the remove button a distinct glyph (trash or minus-in-circle) and a red
hover state; consider hiding it entirely while the context is the implicit "Up Next", where
"remove from playlist" is meaningless to the user.

---

## 10. BPM badges land in the wrong slot as they lazy-load — LOW
*Verified in browser.*

**What a user sees:** rows visibly jump a second after the queue opens, and some rows end up with
the "no BPM" pill *after* the kebab instead of before the heart.

**Evidence:** `08-fullplayer.png`, row 11 (`Give Life Back to Music`) — heart, kebab and badge all
in different positions from rows 1-10.

**Where it lives:** `static/js/queue.js:63-78` inserts the badge `beforebegin` of `.qi-remove`, but
`static/js/queue.js:126-140` has already inserted the kebab and heart before `.qi-remove` on the
initial render.

**Smallest fix:** insert before `.like-btn` when it exists, else before `.qi-remove`.

---

## 11. Play/pause tooltip and accessible name never change — LOW
*Verified in browser.* `#playerPlayPause` and `#fpPlayPause` both report `title="Play"` while
audio is playing. The icon flips; the label does not.
**Where it lives:** `static/js/player.js:486-493` (`updatePlayPauseIcon` only swaps SVG paths);
markup `static/index.html:1232`, `:1289`.
**Smallest fix:** set `title` and `aria-label` in the same function.

---

## 12. "Added N tracks to playlist" when the user added them to the queue — LOW
*Code-read only.* `addToQueue` toasts the word "playlist" for a queue action, which in an app that
also has real playlists is actively misleading.
**Where it lives:** `static/js/player.js:91`, `static/js/player_v3.js:810`.
**Smallest fix:** say "to queue".

---

# B. Spotify parity gaps

## 13. There is no "Playing from ..." anywhere on mobile — MEDIUM
*Verified in browser.*

**What a user sees:** the full player header is a permanent `NOW PLAYING`. On a phone there is no
way to learn whether you are playing an album, a search page, Up Next or Radio.

**Evidence:** `.fp-source` text is the literal string "Now Playing" (`static/index.html:1267`).
The only context label, `#fpPlaylistBadge` (reads "Up Next"), is reported visible on desktop and
**`visible: false` on Pixel 5** — it lives inside `.fp-queue-side`, which is `display:none` below
641 px (`static/css/player.css:49`, `static/css/responsive.css:21`).

**Smallest fix:** render `store.playlistMode.name` into `.fp-source` instead of the literal
string — the data is already in the store.

---

## 14. Now-playing -> artist / album goes through a search, not to the page — MEDIUM
*Verified in browser.*

**What a user sees:** tapping the artist on the mini bar fills the search box with `Daft Punk` and
switches to the **Artists** filter — a grid of cards they must click again. Tapping the title in
the full player searches `Random Access Memories` with the **Albums** filter — eight album cards
to choose from, rather than the album they are listening to. There is also no affordance: cursor
is `pointer`, but no underline, no chevron, and on the mini bar the **title** and **artwork** are
not tappable for this at all (artwork opens the full player).

**Evidence:** screenshots `30-artist-nav.png` (search box = "Daft Punk", active chip = Artists) and
`31-album-nav.png` (search box = "Random Access Memories", active chip = Albums, 8 result cards).

**Where it lives:** `static/js/fullplayer.js:208-237`. Note the inconsistency: artist uses
`router.searchFor(item.artist, 'artist')` (`:215`) while album uses
`contextmenu.openAlbumByName(item.album)` (`:224`) — two different mechanisms for the same
gesture, and the weaker one is on the more common target.

**Smallest fix:** route the artist tap through `contextmenu.openArtistByName` the way the album tap
already does, and add an underline-on-hover to `#playerArtist`, `#fpArtist`, `#fpTitle`.

---

## 15. No "..." menu on the now-playing track — MEDIUM
*Verified in browser (absence).* Every queue row has a kebab (`static/js/queue.js:129`), but the
mini bar and the full player have none. On Spotify this is where "Go to artist / Go to album /
Go to radio / Share / Sleep timer" live. In particular **radio can only be started from a card**,
never from what you are currently listening to — the radio button on search/library cards
(`static/js/search.js:28`) or the card context menu (`static/js/contextmenu.js:676`,
`static/js/downloads.js:365-366`). "Start a radio from this song" is therefore unreachable from
the player.
**Smallest fix:** add a kebab to `.fp-actions` (`static/index.html:1299-1304`) reusing
`attachContextMenu` with the now-playing item.

---

## 16. The queue is one flat list — no "Now playing / Next in queue / Next from <context>" — MEDIUM
*Verified in browser (structure), code-read for the template.* 100 numbered rows, no section
headers, no track durations (`07-queue-panel.png`; a DOM query for `.queue-section, h3,
.queue-header` returns an empty array). Nothing tells the user *why* a track is next, and nothing
separates tracks they explicitly queued from the context that is simply playing on. Combined with
defects #2 and #3, the panel currently answers "what's next?" wrongly about as often as rightly.
**Where it lives:** `static/js/queue.js:85-103`.

---

## 17. "Save as playlist" is desktop-only — LOW
*Verified in browser.* On Pixel 5, `#fpSaveQueue` reports `visible: false` in both the mini-bar
queue panel and the full-player queue sheet; only **Clear** is offered. The button exists solely
in the desktop `.fp-queue-side` header (`static/index.html:1398`); the mobile sheets
(`static/index.html:1405-1417` and `:1420-1432`) never got one. Saving an ad-hoc queue is a
phone-first action.
**Smallest fix:** add the same button to both mobile panel headers and let `updateSaveButton`
(`static/js/queue.js:172`) drive all three.

---

## 18. A track can be dragged above the now-playing row — LOW
*Verified in browser with real touch.* Dragged row 4 (`One More Time`) by its drag handle to index
0 — above the playing track. Result: `["One More Time", "Instant Crush", "Get Lucky", "Veridis
Quo"]` with the marker correctly following to index 1, but the moved track will now never play
unless repeat-all is on. Spotify's Up Next only ever contains what is ahead.
**Where it lives:** target computation `static/js/queue.js:295-312`, commit
`static/js/queue.js:335-357`.
**Smallest fix:** clamp `target` to `> store.playerIndex` in both the pointer and the HTML5 drop
paths.

---

## 19. Shuffle silently disables Smart Queue (DJ engine) — LOW
*Code-read only.* In `player_v3.js` the shuffle branch precedes the smart-queue branch, so turning
shuffle on makes the DJ panel's "Smart Queue" setting a no-op — with both controls still lit and
no hint that one has cancelled the other.
**Where it lives:** `static/js/player_v3.js:1243-1248` (and the same precedence at `:547`, `:609`,
`:1695`).
**Smallest fix:** grey out / disable the Smart Queue select in the DJ panel while
`store.shuffleEnabled`.

---

# C. Nice to have

## 20. "DJ controls" button appears on the Classic engine and opens an empty drawer — LOW
*Verified in browser.* With the default `ms_player_engine = classic`, `#fpDjPanelBtn` is visible in
the full player and opens a drawer titled **"Live DJ Controls"** whose entire content is a single
Player dropdown — `#fpDjOnlyRows` computes to `display: none`. A prominent control that promises a
feature set and delivers one unrelated select.
**Where it lives:** `static/js/djpanel.js:210-230` (`refreshDjPanelVisibility` unconditionally sets
`panelBtn.style.display = ''`); markup `static/index.html:1296`, `:1324-1395`.
**Smallest fix:** hide the button when the engine is not `dj`, or retitle the drawer "Player" when
the DJ rows are hidden.

## 21. Unexplained badges on the now-playing line — LOW
*Verified in browser.* The source badge reads `YT` / `FLAC` / `LOCAL` (`static/js/player.js:149`)
sitting directly beside the artist name, and queue rows read bare numbers (`59`, `81`) or a
red-ish `no BPM` pill — unlabelled jargon on a surface deliberately aimed at a Spotify user, where
`no BPM` in particular reads as an error. A `title` on the source badge, and hiding BPM unless the
DJ engine is active, would cost nothing.
**Where it lives:** `static/js/player.js:142-154`, `static/js/queue.js:16-19`, `:100`.

## 22. The queue panel slides down from the top while the button that opens it is bottom-right — LOW
*Verified in browser.* `.queue-panel { top: 0; transform: translateY(-100%) }`
(`static/css/player.css:168`) opened by `#playerQueueBtn` in the bottom-right corner of the bar.
Spatially backwards; the full-player variant (`.fp-queue-panel`, `static/css/player.css:170`)
correctly rises from the bottom.

## 23. Duplicate swipe-up listener on the mini bar — LOW
*Code-read only.* `#playerBar` gets the same "swipe up -> openFullPlayer" handler twice, from
`static/js/player.js:903-922` and `static/js/fullplayer.js:244-257`. Harmless today (both call the
same idempotent `openFullPlayer`), but two copies of one gesture will drift.

---

# Verification ledger

**Verified in the browser:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15 (absence), 17, 18, 20,
21, 22.
**Code-read only:** 12, 16 (flat list, missing durations and absent section headers *were*
confirmed in the DOM; the "why is this next" reasoning gap is from the template), 19, 23.

**Key artefacts**
- `03-playing.png`, `05-bar-shuffle-on.png` — desktop bar, 13 icon-only buttons, plus/minus twins
- `07-queue-panel.png` — flat 100-row queue, no sections, no durations
- `08-fullplayer.png` — desktop split layout, ghosting, misplaced BPM badge on row 11
- `14-natural-end-queue.png` — **wrong row marked as playing after autoplay took over**
- `21-m-fullplayer.png` — mobile full player, search results visible through it
- `24-m-queuepanel.png` — mobile queue, titles truncated to ambiguity
- `30-artist-nav.png`, `31-album-nav.png` — now-playing -> search, not to the page
- `t5.mjs` (shuffle/prev), `t7.mjs` (dead Next at end), `t8.mjs` (natural end -> off-queue track),
  `m3.mjs`/`m4.mjs`/`m5.mjs` (swipe-zone sweep with instrumented touch), `m6.mjs` (mobile queue
  blocking + touch reorder)
