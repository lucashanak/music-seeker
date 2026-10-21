# MusicSeeker — UX audit of the search / browse surfaces

Scope: Search page (input, type tabs, All view, recent chips, genre Browse-all + charts,
infinite scroll, empty/error/loading states), artist detail, album detail.
Playlist detail deliberately excluded.

## Method

Read `static/js/search.js`, `static/js/spotify.js`, `static/js/playcontext.js`,
`static/css/search.css`, `static/css/cards.css`, `static/index.html`
(`#pageSearch` / `#artistDetail` / `#albumDetail`), `app/routers/search.py`,
`app/services/search_providers.py`.

Then drove production (`https://musicseeker.hanaktech.org`, v1.24.3) with raw Playwright as
`claude_test`, device id `ms_device_id=e2e-audit-search`, at **1280x900** and **390x844**:
landing / Browse all, all six type tabs, the All aggregated view, genre charts, artist detail,
album detail, keyboard navigation, browser-back behaviour, and two stubbed failure payloads
(client-side `page.route` interception only — nothing sent to the server).

Scripts and ~30 screenshots live beside this file in
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/audit-search/`.

Read-only: nothing downloaded, no playlist created or deleted, no setting changed,
no file in the repo edited or committed.

---

## Top 5

1. **#1** — Artist/album hero is a vertical button column next to a 100px thumbnail (desktop).
2. **#2** — Type tabs stay live on detail pages, producing a silent dead-end state.
3. **#3** — Infinite scroll keeps firing while a detail page is open.
4. **#4** — Artist cards print the artist name twice.
5. **#5** — A provider failure renders as "No results found" / a blank page.

---

# Real defects

## 1. Detail hero: buttons stack vertically beside a 100px thumbnail (desktop) — HIGH

**What the user sees:** on the album page a 100px cover sits far left, the title next to it, and
five buttons stack down the right edge across ~250px of height, with ~300px of dead space in the
middle. Artist detail is the same with four buttons. Spotify shows a large cover, a display-size
title, a metadata line, then **one horizontal action row**.

**Where:** `static/css/pages.css:104` —
`.playlist-hero-actions { display: flex; flex-direction: column; align-items: flex-end; … }`;
art size at `static/css/pages.css:96` (`width: 100px; height: 100px`);
container at `static/css/pages.css:91-95`.

**Smallest fix:** the mobile override at `static/css/responsive.css:122-124` already does the right
thing (`flex-direction: row; flex-wrap: wrap; align-items: center`) and mobile looks fine. Promote
that to the base rule, bump `.playlist-hero-img` to ~180px, and set
`.playlist-hero { align-items: flex-end }`.

**Evidence:** verified in browser — `22-album-detail.png`, `51-tab-click-during-detail.png`
(desktop, broken) vs `44-m-artist-detail.png` (mobile, correct).

---

## 2. Type tabs stay clickable on a detail page and silently do nothing — HIGH

**What the user sees:** open Daft Punk's artist page, tap "Albums". The tab turns green, the artist
page stays. The search actually ran behind the overlay. The only way out is "← Back to results",
which then lands on Albums — results the user asked for three seconds earlier and never got. The
same happens if they type a new query into the (sticky, always visible) search box.

**Where:** `static/js/search.js:969-976` — the `.type-btn[data-type]` handler calls `doSearch()`
without closing any open detail layer. Same gap in the `#searchInput` input handler,
`static/js/search.js:940-946`.

**Smallest fix:** in both handlers, close whichever detail layer is visible first — call
`closeArtistDetail()` / `closeAlbumDetail()` / `closeShowDetail()` when the corresponding element's
computed display is not `none`.

**Evidence:** verified in browser — after clicking the Albums tab from artist detail,
`#artistDetail` = `block`, `#searchResults` = `none`; screenshot `51-tab-click-during-detail.png`
shows the Albums tab highlighted over the Daft Punk artist page.

---

## 3. Infinite scroll keeps firing while a detail page is open — HIGH

**What the user sees:** on the album detail page, scrolling to the bottom repeatedly fires the
*search's* paginator. Four scroll-to-bottom cycles issued
`/api/search?q=daft%20punk&type=album&limit=20&offset=20/40/60/80`, built 73 extra cards into the
hidden `#searchResults` (20 → 93), and made the load-more skeleton flash into view between the type
tabs and the detail hero.

**Where:** `static/js/search.js:979-986` — the scroll guard is only
`store.currentPage === 'search'`, which is still true on artist/album/show detail (they live inside
`#pageSearch`). `loadArtistDetail` / `loadAlbumDetail` hide `#searchLoadMore`
(`static/js/spotify.js:426`, `:575`), and then `static/js/search.js:628` un-hides it.

**Smallest fix:** add `&& $('#searchResults').style.display !== 'none'` to the scroll guard at
`static/js/search.js:983`.

**Evidence:** verified in browser — logged `search reqs fired while on album detail: [offset=20,
40, 60, 80]`, `loadMore skeleton became visible during album detail scroll: true`,
`cards in hidden #searchResults after: 93`.

---

## 4. Artist cards print the artist name twice — HIGH (cosmetic, 1-line fix)

**What the user sees:** every artist card reads its own name as its subtitle — "Daft Punk /
Daft Punk", "Linkin Park / Linkin Park", "Daft Punk - Stardust / Daft Punk - Stardust". Spotify's
artist-card subtitle is the word "Artist".

**Where:** `static/js/search.js:63` — `cardSubHtml` falls through to `return esc(artist)`, and for
artist items `item.artist === item.name` (set at `app/services/search_providers.py:374`).

**Smallest fix:** `if (type === 'artist') return 'Artist';` immediately before that fallback.

**Evidence:** verified in browser — `13-artists.png`, `43-m-artists.png`, `30-genre-chart.png`.

---

## 5. A provider failure is indistinguishable from an empty search — HIGH

**What the user sees:** two separate flavours.
(a) When every arm of the aggregated search fails, the page prints **"No results found"** with no
retry — identical to a genuinely empty query.
(b) When `/api/genres` fails, the whole search landing page is **completely blank, no message at
all**, and it never retries for the rest of the session.

**Where:**
- (a) `search_all` returns an `errors` map (`app/services/search_providers.py:1161-1182`) but
  `doSearchAll` never reads `data.errors` (`static/js/search.js:820-828`) and falls into the generic
  empty state at `static/js/search.js:896-897`.
- (b) `static/js/search.js:358` — `if (!_genreCache.length) { el.innerHTML = ''; return; }`, with
  the empty array latched into `_genreCache` at `static/js/search.js:352-353` and never cleared.
  `app/routers/search.py:74-80` deliberately swallows genre errors into `{genres: []}` ("others get
  nothing rather than an error"), so any Deezer outage lands here by design.

**Smallest fix:** in `doSearchAll`, when `data.errors` covers every type show
"Couldn't reach the music provider — Retry"; for a partial failure render the affected section as an
inline error strip instead of omitting it. In `renderBrowse`, leave `_genreCache = null` on failure
and render a short message plus a Retry button.

**Evidence:** both failure states verified in browser by stubbing the responses client-side —
`80-all-timeout.png` (UI text: `No results found`) and `81-genres-fail.png`
(`#searchResults` innerText `""`, and `after recovery, tiles: 0` once the stub was removed).
The *partial*-failure rendering (one section dropped, three fine) is **code-read only** — it shares
the verified code path.

---

## 6. Browser/system back does nothing in the genre chart view — MEDIUM

**What the user sees:** tap a genre tile ("Rock") and the chart renders. Press browser back, or the
Android back gesture, and you stay on the Rock chart. Worse, `history.length` grew to 3, so the
press is silently consumed and the *next* back press leaves the app entirely. Artist, album and show
detail all `pushState` correctly; the genre view is the one layer that doesn't.

**Where:** `static/js/search.js:392-434` (`openGenre`) — no `history.pushState`, and no entry in the
router's popstate layer handling. The only way back is the `#genreBack` button at
`static/js/search.js:401`.

**Smallest fix:** `history.pushState({ layer: 'genre' }, '')` in `openGenre`, and handle that layer
in the router's popstate by calling `renderBrowse()`.

**Evidence:** verified in browser on both viewports — `31-genre-after-back.png` and
`72-m-genre-after-back.png`, both logging `tiles: 0` and the chart headers still present after back.

---

## 7. The Artists tab is a wall of grey placeholder avatars and duplicates — MEDIUM

**What the user sees:** of the top 10 results for "daft punk", 8 have no image (the default grey
person icon), two cards are both named exactly "Daft Punk", and most are Deezer contributor-credit
pseudo-entities — "Daft Punk, Pharrell Williams", "Daft Punk, Panda Bear", "Daft Punk, Todd
Edwards", "Made famous by Daft Punk". The All view collapses these; the dedicated tab doesn't.

**Where:** `_dedupeByName` (`static/js/search.js:793`) is called only from `doSearchAll`
(`static/js/search.js:826`). `doSearch` (`static/js/search.js:597-657`) never calls it.

**Smallest fix:** apply `_dedupeByName` in `doSearch` when `store.searchType === 'artist'`, and drop
imageless artist results whose name contains a comma (the contributor-credit pattern).

**Evidence:** verified in browser — `13-artists.png`, `43-m-artists.png`.

---

## 8. "1 episodes" / "1 tracks" — LOW

**What the user sees:** five podcast cards in a row reading "1 episodes".

**Where:** `static/js/search.js:128` —
`${item.total_tracks} ${item.type === 'show' ? 'episodes' : 'tracks'}`, no singular branch.

**Smallest fix:** `${n} ${n === 1 ? 'episode' : 'episodes'}` (same treatment for tracks).

**Evidence:** verified in browser — `15-podcasts.png`.

---

## 9. Genre tiles are half in Czech — MEDIUM

**What the user sees:** "Pop, Rap/Hip Hop, Rock, R&B, Jazz, Blues, Metal, Folk, Reggae, Country,
Electro, Soul & Funk" sitting next to "Taneční hudba, Alternativní hudba, Klasická hudba,
Filmy/videohry, Africká hudba, Asijská hudba, Brazilská hudba, Indická hudba, Latinskoamerická
hudba, Pro děti". The rest of the UI is English. Deezer localises genre names by request IP. The
long Czech labels also wrap to two lines and collide with the tile artwork — "Latinskoamerická
hudba" runs under its image, "Alternativní hudba" sits on top of it.

**Where:** `deezer_genres()` called from `app/routers/search.py:77`; tile markup at
`static/js/search.js:360-365`.

**Smallest fix:** send `Accept-Language: en` on the Deezer genre request; cap `.genre-tile-name`
width and push `.genre-tile-img` behind the label (`z-index`).

**Evidence:** verified in browser — `01-landing.png` (desktop), `40-m-landing.png` (phone).

---

## 10. Genre charts return off-genre artists and albums — MEDIUM

**What the user sees:** on the "Rock" chart, Top songs are genuinely rock (Sweet Child O' Mine,
Livin' On A Prayer, Mr. Brightside, Eye of the Tiger) — but the **Artists** row is P T K,
Yzomandias, Linkin Park, Taylor Swift, Viktor Sheen, Tate McRae, and **Albums** are Limp Bizkit's
*Results May Vary*, Brixton's *LÍNEJ* and Helloween. Deezer's `/chart/{genre_id}` only scopes its
`tracks` arm reliably; the rest falls back to the regional chart.

**Where:** `app/services/search_providers.py:353-386` (`deezer_genre_chart`); rendered at
`static/js/search.js:426-428`.

**Smallest fix:** render only `tracks` and `playlists` for a genre (both were correct in the live
test), or derive the artist row from the chart tracks' own artists.

**Evidence:** verified in browser — `30-genre-chart.png`.

---

## 11. "In library" on song rows is a faint border with no label — MEDIUM

**What the user sees:** on the Tracks tab, four of ten rows carry a thin green outline that reads as
a hover or selection state, not as "you already own this". Grid cards get a clear "IN LIBRARY" pill;
the rows explicitly suppress it.

**Where:** `static/css/search.css:218` — `.song-list .song-row .in-library-badge { display: none; }`;
the only remaining cue is `static/css/cards.css:78`
(`.card.in-library { border-color: rgba(162, 230, 64, 0.2); }`). Badge is created at
`static/js/search.js:209-213`.

**Smallest fix:** replace the border cue on rows with a small accent dot or ✓ glyph in the row's
right-hand cluster next to the duration — where Spotify puts its saved state.

**Evidence:** verified in browser (`11-tracks.png`); the CSS rule confirms why no label ever
appears.

---

# Spotify parity gaps

## 12. No play button on artists anywhere, including the top-result hero — HIGH

**What the user sees:** searching an artist makes them the top result, and that hero carries only
⋯, ♡ and 📻 — no play. Artist grid cards are the same. On Spotify the top result *always* has the
big green play button, and it is the single most-used control on the search screen.

**Where:** `static/js/search.js:15` — `cardPlayBtn` returns `''` for
`playlist | show | artist`. Hero built at `static/js/search.js:662-698`.

**Smallest fix:** allow the play button for `artist` on the hero, and route its click to fetch
`/api/artist/{id}/top` (already used by the detail page, `static/js/spotify.js:524-535`) and hand the
result to `playTracks`.

**Evidence:** verified in browser — logged `hero has play btn: false`; `10-all-daftpunk.png`,
`41-m-all.png`.

---

## 13. Artist page has no Play until the Popular fetch lands, and no Shuffle — MEDIUM

**What the user sees:** the artist page opens with "Download All Albums" as the only prominent
action; a second or two later "▶ Play" pops in and shifts the whole button column. Album detail has
a Shuffle button; artist detail has none.

**Where:** `static/js/spotify.js:504` —
`if (playBtn) playBtn.style.display = _artistTopTracks.length ? '' : 'none';`, driven by the async
`_loadArtistTop`. Markup at `static/index.html:256-258`.

**Smallest fix:** render `#playArtistTop` visible-but-disabled from the start and enable it when the
tracks arrive; add a Shuffle button beside it reusing the album page's shuffle logic
(`static/js/spotify.js:702-712`).

**Evidence:** verified in browser — one run captured `'▶ Play|none'` alongside `popular rows: 0`.

---

## 14. Artist discography is 39 undifferentiated tiles — MEDIUM

**What the user sees:** 39 album cards in one flat grid with studio albums, singles, remix EPs and
live records interleaved; no grouping, no sort control, no "Appears on", no related artists. (The
*ordering* itself is a deliberate popularity ranking — `app/services/search_providers.py:205-210` —
and that part is fine.)

**Where:** `record_type` ("album" / "single" / "ep" / "compilation") is **already on the wire** at
`app/services/search_providers.py:113` and the frontend never reads it — card markup at
`static/js/spotify.js:444-453` only prints year and track count.

**Smallest fix:** put `record_type` in the card subtitle (`2001 · Album`) and split the grid into
"Albums" and "Singles and EPs" sections.

**Evidence:** the 39-tile flat grid is verified in browser (`20-artist-detail.png`, logged
`albums: 39`); that `record_type` is already fetched and unused is **code-read**.

---

## 15. Album header has no year or runtime — MEDIUM

**What the user sees:** `Discovery / Daft Punk / 14 tracks`. Spotify shows
`Album · 2001 · 14 songs, 1 hr 1 min`. Both missing values are already in hand: `album.year` is on
the item that opened the page, and `duration_ms` is on every track in the response.

**Where:** `static/js/spotify.js:595` (`$('#albumDetailCount').textContent = ...`), hero fields at
`static/js/spotify.js:582-584`, markup at `static/index.html:271-273`.

**Smallest fix:** build the line from `album.year` plus the summed track durations.

**Evidence:** verified in browser — `22-album-detail.png`, logged
`album: Discovery | Daft Punk | 14 tracks`.

---

## 16. Recent searches are a focus-only chip row — MEDIUM

**What the user sees:** a one-line row of bare text chips plus a "Clear" link, visible **only** while
the search input is focused and empty, and gone the moment it blurs. No heading, no thumbnails, no
per-item ×. On a phone it is only reachable with the keyboard up. Spotify's search landing screen
*is* the recent list — full rows with artwork and a per-row remove.

**Where:** `static/js/search.js:296-330` (`renderRecentSearches`, gated on
`document.activeElement === input`) and the blur handler at `static/js/search.js:949-952`. Styles are
inline at `static/index.html:79-91` — there are no `.recent-*` rules in any CSS file.

**Smallest fix:** render the list into `#searchResults` above the Browse-all wall whenever the input
is empty (regardless of focus), and add a per-chip × that removes one entry.

**Evidence:** verified in browser — `70-m-recents.png`, `02-recent-focused.png`; logged
`recent visible after blur: none` and `per-chip delete buttons: 0`.

---

## 17. Top result picks an exact-name artist over the obvious song — MEDIUM

**What the user sees:** searching `one more time` makes the hero an obscure artist literally named
"One More Time" rather than the Daft Punk track everyone means. The hero reads
`One More Time / Artist` and (per #12) has no play button either.

**Where:** `app/services/search_providers.py:1117-1142` (`_pick_top_result`) — rule (1) returns the
first exact artist-name match before anything else is considered, regardless of popularity.

**Smallest fix:** only let an exact artist match win when it also out-ranks the top track on
popularity — `nb_fan` is already fetched for artists
(`app/services/search_providers.py:376`).

**Evidence:** verified in browser — logged `hero: … One More Time | Artist`, `60-all-track-top.png`.

---

## 18. Mobile: the search field is squeezed to ~45% of the screen — MEDIUM

**What the user sees:** at 390px, three 52px round buttons (mic, party, **Refresh app**) plus gaps
eat roughly 180px of the 390px row, leaving the input so narrow that its placeholder truncates to
"Title, artist, …". `#appRefreshBtn` is a developer escape hatch that is already duplicated in
Settings.

**Where:** `static/index.html:185-193` (the three `.btn-mic` buttons); `.btn-mic` sizing at
`static/css/search.css:35` (52px), shrunk to 48px at `static/css/responsive.css:116`; refresh handler
at `static/js/search.js:929-938`.

**Smallest fix:** drop the Refresh button from the row on narrow viewports (keep it in Settings), or
collapse mic + party into a single control.

**Evidence:** verified in browser — `40-m-landing.png`, `41-m-all.png`.

---

## 19. Mobile: type tabs wrap to two rows — LOW

**What the user sees:** "All / Tracks / Albums / Artists" on one line and "Playlists / Podcasts" on
a second, costing ~40px above the fold on every search. Spotify scrolls its filter chips
horizontally in a single row.

**Where:** `.type-toggle` markup at `static/index.html:199-206`.

**Smallest fix:** `overflow-x: auto; flex-wrap: nowrap;` on `.type-toggle` at mobile widths.

**Evidence:** verified in browser — `40-m-landing.png`.

---

## 20. Nonsense queries return confident unrelated results — MEDIUM

**What the user sees:** searching `zzzqqqxyznotathing12345` returns a full page of real music —
"NO BATIDÃO (Slowed)", "MONTAGEM GUERREIRO (Slowed)", "NUMBER HARDTEKK" — presented as the answer,
with a top-result hero. The "No results found" branch is effectively unreachable with Deezer's fuzzy
matching, so a typo silently produces a wall of unrelated tracks instead of "No results for …".

**Where:** the only empty-state paths are `static/js/search.js:150-152` and
`static/js/search.js:896-897`, both of which require a literally empty provider response.

**Smallest fix:** when no result's normalised name or artist shares a token with the query, print a
"No results for *x*" line above the fuzzy matches rather than presenting them as matches.

**Evidence:** verified in browser — `50-noresults.png`, logged result text beginning
`📻 NO BATIDÃO (Slowed) / Song · ZXKAI, Slxughter`.

---

# Nice to have

## 21. Hero action buttons are positioned with inline pixel math — LOW

**What the user sees:** at 390px the 📻 and ＋ buttons on the top-result hero land in the middle of
the artwork, floating over the cover rather than sitting in a corner.

**Where:** `static/js/search.js:689-696` — the hero overrides the shared CSS with inline
`btn.style.right = right + 'px'` (52 / 8 plus 44 per button), which assumes the desktop hero size.

**Smallest fix:** move those offsets into a `.top-result-card .card-radio-btn` / `.card-addpl-btn`
CSS rule so the mobile breakpoint can override them.

**Evidence:** verified in browser — `41-m-all.png`.

---

## 22. Mixed icon set: SVGs next to emoji — LOW

**What the user sees:** play, download and add are crisp SVGs; Radio is the 📻 emoji and Shuffle is
🔀. Emoji render in a different style and weight on every platform and read as placeholder art.

**Where:** `static/js/search.js:28` (`cardRadioBtn`), `static/index.html:272` (`#shuffleAlbum`), plus
the `📻 Radio` / `♡ Follow` buttons injected by `radio.js` onto the artist hero.

**Smallest fix:** swap both for inline SVGs matching the existing set.

**Evidence:** verified in browser — `20-artist-detail.png`, `22-album-detail.png`.

---

## 23. Two competing primaries on the album hero — LOW

**What the user sees:** "▶ Play All" and "Download All" are both bright accent-green, so the eye has
no single obvious action.

**Where:** `static/index.html:275-279` — `#downloadAlbum` uses the bare `btn-download` class while
its siblings use `btn-hero-secondary`.

**Smallest fix:** give `#downloadAlbum` the `btn-hero-secondary` class.

**Evidence:** verified in browser — `22-album-detail.png`.

---

## 24. Inconsistent back-control labels and placement — LOW

**What the user sees:** "← Back to results" on artist and show detail, "← Back" on album detail, and
"← Browse all" **right-aligned inside the genre section header**, where it sits exactly where the
"Show all" links live elsewhere and reads as one.

**Where:** `static/index.html:248` (`#backFromArtist`), `:232` (`#backToSearch`), `:267`
(`#backFromAlbum`); genre control built at `static/js/search.js:401`.

**Smallest fix:** one left-aligned back control with one label; move `#genreBack` out of the section
header to the same position the detail pages use.

**Evidence:** verified in browser — `20-artist-detail.png`, `22-album-detail.png`,
`30-genre-chart.png`.

---

## 25. Dead tempo-filter bar above the album tracklist — LOW

**What the user sees:** a full row of greyed-out controls ("All / Slow <90 / Mid 90-110 / Fast 110+",
Min–Max boxes, two Play buttons) above the music, captioned "BPM known for 1/14 (13 no BPM)" and
"Tempo filter needs analyzed local tracks". For a Spotify-shaped album page this is a band of
non-functional chrome between the hero and the songs.

**Where:** `static/js/spotify.js:606` (`_mountTempoFilter(tracks, '#albumTracks')`), helper at
`static/js/spotify.js:17-24`.

**Smallest fix:** skip mounting (or render collapsed behind a disclosure) when coverage is below a
small threshold.

**Evidence:** verified in browser — `22-album-detail.png`.

---

## 26. Row action order differs from Spotify — LOW

**What the user sees:** each song row ends `duration, ⋯, ♡`. Spotify uses `♡, duration, ⋯`, so the
save control sits where returning users reach for it.

**Where:** `static/js/search.js:728-741` — duration is in the template, then `makeKebabButton` and
`makeHeartButton` are appended in that order.

**Smallest fix:** append the heart before the duration span.

**Evidence:** verified in browser — `11-tracks.png`.

---

## 27. `type=episode` is reachable but has no tab — LOW

**What the user sees:** nothing — it is simply unreachable from the UI.

**Where:** `app/routers/search.py:16` accepts `episode` in the pattern;
`static/index.html:199-206` exposes no button for it, and `_TOP_TYPE_LABEL`
(`static/js/search.js:660`) already has an "Episode" label waiting.

**Smallest fix:** either surface it under the Podcasts tab or drop it from the route's pattern.

**Evidence:** code-read only.

---

## 28. Album type and artist popularity are fetched but never shown — LOW

**What the user sees:** album cards never distinguish a single from an album (in the "daft punk"
Albums tab, the *Get Lucky (Radio Edit)* single is presented identically to *Discovery*), and artist
cards carry no popularity figure where Spotify shows monthly listeners.

**Where:** `record_type` mapped at `app/services/search_providers.py:113` and `fans` at
`:376` / `:112`; the card meta row that would show them is
`static/js/search.js:126-131`.

**Smallest fix:** add both to `.card-meta`.

**Evidence:** the absence is verified in browser (`12-albums.png`, `13-artists.png`); that the data
is already fetched and discarded is **code-read**.

---

# Verification summary

**Verified in the browser** (screenshot and/or logged DOM assertion):
#1, #2, #3, #4, #5(a and b — the total-failure cases), #6, #7, #8, #9, #10, #11, #12, #13,
#14 (the flat grid), #15, #16, #17, #18, #19, #20, #21, #22, #23, #24, #25, #26,
#28 (the absence).

**Code-read only:**
#5 partial-failure rendering (one section dropped while others succeed — same code path as the
verified total failure), #14 (`record_type` present but unused), #27, #28 (that the data is already
on the wire).
