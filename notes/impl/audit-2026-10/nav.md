# Audit: navigation, information architecture, Discover, Settings, modals
**MusicSeeker 1.24.3 — https://musicseeker.hanaktech.org**
Auditor: `audit-nav`. Date: 2026-10-21.

## Method

Code read first (`static/js/app.js`, `router.js`, `auth.js`, `discover.js`, `settings.js`,
`recognize.js`, `party.js`, `feedback.js`, `utils.js`, `static/css/nav.css`, `base.css`,
`responsive.css`, `login.css`, `settings.css`, `static/index.html`), then the live app was
driven with raw Playwright as `claude_test` with `localStorage.ms_device_id = 'e2e-audit-nav'`,
at **1280x900** and **390x844 (mobile emulation, touch)**.

Scripts and 25 screenshots live beside this file in
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/audit-nav/`.

Read-only: nothing was changed, downloaded, deleted, committed or edited. No setting was saved.
The microphone cannot work headless, so the mic/party flows were judged from the code plus what
the UI renders; that is marked per finding.

Every finding below is tagged **verified in browser** or **code-read only**.

## Verdict

The skeleton is Spotify-like and the Settings page is genuinely good — grouped, iconed,
collapsible, and it reads well on a phone. Three things break the illusion:

1. **The back button is not trustworthy.** Two independent bugs make Back either do nothing,
   skip a level, or leave the history position pointing at a page the screen isn't showing.
2. **The information architecture has two unrelated "browse by genre" surfaces** with different
   vocabularies and different behaviour, and no home/"For You" at all.
3. **Discover looks broken** because every single cover is Last.fm's grey placeholder star.

Plus one hard reachability failure: on a phone you cannot cleanly sign out, and you can never
see which account you are signed in as.

## Top 5

1. **#1** Mobile users can't log out and never see who they are — `high`
2. **#2** A detail view left open behind a nav switch corrupts the back stack — `high`
3. **#3** Ad-hoc modals eat a history entry and desync the nav — `high`
4. **#4** Every Discover card shows Last.fm's grey "no image" star — `high`
5. **#5** Half the "Browse all" genre tiles are in Czech — `high`

---

# Real defects

### #1 — No plain "Log out" on a phone; the signed-in username is invisible
**Severity: high** · **verified in browser**

**What a user sees.** On a phone there is no way to sign out except a button labelled
**"Clear All & Logout"**, buried in Settings -> App, sitting next to "Refresh". Nothing anywhere
shows which account is signed in. A user who wants to hand the phone to someone else, or who is
signed in as the wrong user, either stays signed in forever or wipes their caches to get out.

**Where it lives.**
- `static/css/responsive.css:30` — `nav { display: none; }` inside `@media (max-width: 640px)`
  hides the whole top bar on mobile.
- `static/index.html:140` — `#logoutBtn` lives only in that bar.
- `static/index.html:142` — `#navUsername` likewise.
- `static/index.html:1108` — `#clearCacheBtn`, text `Clear All & Logout`, the only remaining path.
- `static/js/auth.js:45` — `logout()`, the function that would be reused.

**Evidence.** On a 390x844 viewport I walked up the ancestor chain of every candidate element:
`logoutBtn -> hidden-by:NAV`, `navUsername -> hidden-by:NAV`, `nav` computed `display:none`.
Enumerating every `<button>/<a>` whose text matches `/log ?out|sign ?out|odhlas/i` returned exactly
two hits: the hidden `#logoutBtn`, and `#clearCacheBtn`. Searching the DOM for the string
`claude_test` found it only in `#navUsername`, measured `width = 0`.

**Smallest fix.** Add an `Account` row to the mobile Settings list showing the username plus a
plain `Log out` button bound to the existing `logout()` in `static/js/auth.js:45`. Leave
"Clear All & Logout" where it is as the nuclear option.

---

### #2 — Browser Back is swallowed, or skips a level, when a detail view was left open
**Severity: high** · **verified in browser (both variants)**

**What a user sees.** Open a detail view, then switch pages with the nav, then press Back. Either
nothing happens at all, or you are thrown two levels back with the detail silently discarded.
Measured, on the live app:

- *Dead press.* Discover -> open tag `zouk` -> click **Library** -> **Back**.
  Result: still showing `pageLibrary`, nav still on Library, `history.state` moved from
  `{page:'library'}` to `{layer:'tagDetail'}`, `#tagDetailView` silently set to `display:none`.
  The user pressed Back and the screen did not move. One history entry was consumed.
- *Skipped level.* Search -> open artist -> click **Settings** -> **Back**.
  Result: lands on **Search with the artist detail gone** (`#artistDetail` `display:none`),
  not on Settings' predecessor and not on the artist page the user came from.

**Where it lives.**
- `static/js/router.js:144-150` — `handlePopstate` decides what to close by reading
  `element.style.display`, not by whether the element is actually on screen. An element marked
  visible inside a hidden `<main>` still reads as `!== 'none'`.
- `static/js/router.js:76-86` — `switchPage` resets only `#showDetail` (on `search`) and
  `#libraryDetail` / `#likedSongsDetail` (on `library`). `#tagDetailView`, `#artistDetail`,
  `#albumDetail`, `#playlistDetail` and `#podcastEpisodes` are left marked visible when you
  navigate away from their page.

So the bug is generic across every detail layer, not specific to Discover.

**Smallest fix.** Either hide every known detail layer in `switchPage` when leaving a page, or —
cheaper and self-maintaining — change the `handlePopstate` guards from
`$('#x').style.display !== 'none'` to `$('#x') && $('#x').offsetParent !== null`, which is false
whenever an ancestor is hidden.

---

### #3 — The ad-hoc modals push no history entry, so Back dismisses them *and* consumes a page
**Severity: high** · **verified in browser**

**What a user sees.** With "New playlist", the feedback form, a confirm dialog or the playlist
picker open, pressing Back closes it — and silently moves the history position back one page while
the screen stays put. From then on the back/forward stack disagrees with what is displayed.
Measured twice:

- Library -> **+ New Playlist** -> **Back**: overlay gone; `history.state` went
  `{page:'library'}` -> `{page:'search'}` while the screen **still showed Library**.
- Search -> feedback FAB -> **Back**: overlay gone; `history.state` went
  `{page:'search'}` -> `{page:'library'}` while the screen **still showed Search** and the nav
  still highlighted Search.

**Where it lives.**
- `static/js/utils.js` — `showPlaylistPicker`, `showInputModal`, `showPlaylistFormModal`,
  `showConfirmModal` all build an overlay and never `pushState`.
- `static/js/feedback.js` — `_openModal()`, same.
- `static/js/router.js:138-139` — the catch-all that papers over it:
  `const epDialog = document.querySelector('.modal-overlay:not(#downloadModal)');`
  `if (epDialog) { epDialog.remove(); return; }`

**Second, quieter bug at the same two lines.** `overlay.remove()` destroys the DOM without ever
resolving the modal's Promise, so an `await showPlaylistPicker(...)` / `await showConfirmModal(...)`
caller is left suspended forever. The DOM looks clean; the calling flow is wedged.

**Smallest fix.** Give each of those modals a `history.pushState({ layer: 'dialog' }, '')` on open
and `historyBack()` on close (the same contract `openPanel` already uses, `static/js/downloads.js`),
and have the popstate branch invoke the modal's own cancel path — which resolves the Promise —
instead of `.remove()`.

---

### #4 — Every Discover result card shows Last.fm's grey "no image" star
**Severity: high** · **verified in browser**

**What a user sees.** The entire Discover tag page is a wall of identical grey tiles with a white
star. It reads as "the app failed to load" even though the titles and artists are correct and the
cards are fully functional. See `10-tag-detail.png` (desktop) and `22-m-tagdetail.png` (mobile).

**Where it lives.** `app/services/lastfm.py:39-44` — `_pick_image()` returns whatever URL Last.fm
sends, placeholder included:

```python
def _pick_image(images: list) -> str:
    for size in ("extralarge", "large", "medium"):
        for img in images:
            if img.get("size") == size and img.get("#text"):
                return img["#text"]
    return ""
```

**Evidence.** I read `src` off the first five `#tagResults .card-img` after loading the `zouk` tag.
All five were byte-identical, and they are Last.fm's universal placeholder asset:
`https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png`
(`naturalWidth: 300` — it loads fine, it just isn't artwork). Because `item.image` is non-empty,
`static/js/discover.js` emits a real `src=` and the card's own styled empty state never renders.

**Smallest fix.** In `_pick_image`, return `""` when the URL contains the placeholder hash
`2a96cbd8b46e442fc41c2b86b821562f`. One `if`. The cards then fall back to the app's own placeholder,
which already looks deliberate.

---

### #5 — Half the "Browse all" genre tiles are in Czech
**Severity: high** · **verified in browser**

**What a user sees.** On the empty Search page (the app's landing surface), the genre wall mixes
languages in the same grid: *Pop, Rock, R&B, Jazz, Country, Blues, Metal, Folk, Reggae,
Electro, Rap/Hip Hop, Soul & Funk* next to *Tanecni hudba, Alternativni hudba, Klasicka hudba,
Africka hudba, Asijska hudba, Brazilska hudba, Indicka hudba, Latinskoamericka hudba,
Filmy/videohry, Pro deti*. See `24-desktop-search-settled.png` and `20-m-search.png`.

**Where it lives.** `app/services/search_providers.py:340-344` — the Deezer genre list is fetched
with no `Accept-Language` header, so Deezer localises by the server's Czech IP:

```python
async with httpx.AsyncClient(timeout=10) as client:
    await _deezer_limit()
    resp = await client.get(f"{DEEZER_BASE}/genre")
```

(Served to the frontend via `app/routers/search.py:72-80` -> `static/js/search.js:351`.)

**Smallest fix.** `client.get(f"{DEEZER_BASE}/genre", headers={"Accept-Language": "en"})`.
Note the result is cached (`_GENRE_CACHE_TTL`), so a restart or cache bust is needed to see it.

---

### #6 — The confirm dialog defaults to the destructive action
**Severity: medium** · **verified in browser (live probe)**

**What a user sees.** A "Delete playlist?" dialog opens with the red **Delete** button already
focused, and a stray Enter press confirms it. There is no undo.

**Where it lives.**
- `static/js/utils.js:379` — `setTimeout(() => { modal.querySelector('.confirm-ok').focus(); }, 30);`
- `static/js/utils.js:373` — a *document-level* keydown handler:
  `else if (e.key === 'Enter') { e.preventDefault(); done(true); }`

**Evidence.** I imported `utils.js` in the page, called
`showConfirmModal('Delete playlist?', 'This cannot be undone.')`, inspected it, then dispatched a
synthetic `Enter`. Result: `{ focused: "Delete", btns: ["Delete","Cancel"], enterResult: true }`.

**Smallest fix.** Focus `.confirm-cancel` instead, and drop the `Enter` branch (or map it to
`done(false)`) whenever `danger` is true. Button *order* is already fine and consistent with every
other modal in the app (primary left, Cancel right).

---

### #7 — The Downloads tab never highlights while its panel is open
**Severity: medium** · **verified in browser**

**What a user sees.** On mobile, tapping **Downloads** in the bottom nav opens a full-screen panel,
but the Downloads tab stays grey and the *previous* tab stays highlighted — so the tab bar claims
you are still on Search while Downloads covers the screen. The tab reads as dead.

**Where it lives.** `static/js/router.js:17-21` — `switchPage('downloads')` toggles the panel and
`return`s before the active-class update at `router.js:40-47`.

**Evidence.** After `click('.bnav-btn[data-page="downloads"]')`:
`active = ['search']`, `document.querySelector('.downloads-panel.open')` truthy.

**Smallest fix.** Set/clear the `.active` class on `.bnav-btn[data-page="downloads"]` (and
`#downloadsToggle` on desktop) from `openPanel()` / `closePanel()` in `static/js/downloads.js`.

---

### #8 — Toasts cover the bottom nav on mobile
**Severity: medium** · **verified in browser**

**What a user sees.** A confirmation toast ("Added to playlist") lands directly on top of the
bottom navigation bar, obscuring two or three of its labels. See `71-m-toast.png`.

**Where it lives.** `static/js/utils.js:88` — the toast's geometry is hardcoded inline:
`'position:fixed;bottom:80px;left:50%;...'`. 80px predates the bottom nav
(`--bottom-nav-height: 72px`) and the mini player bar (68px), both of which stack below it.

**Evidence.** On 390x844 with `body.player-active`: toast `top=726, bottom=764`; bottom nav
`top=705`; player bar `top=776`. The toast sits inside the nav's box.

**Smallest fix.** Move the geometry into CSS as a `#toastMsg` rule and override it inside the
existing `@media (max-width: 640px)` block in `static/css/responsive.css`:
`bottom: calc(var(--bottom-nav-height) + 16px)`, and
`body.player-active #toastMsg { bottom: calc(var(--bottom-nav-height) + 68px + 16px); }` —
the same pattern `static/css/feedback.css:30-39` already uses for the FAB.

---

### #9 — The Party overlay ignores the Back button
**Severity: medium** · **verified in browser**

**What a user sees.** Party recognition opens as a full-screen sheet. Pressing Back (the hardware
button on Android) does nothing at all — the sheet stays up. The only way out is the small `x`.
Every other overlay in the app handles Back: the download modal, the queue panel, the full player
and the downloads panel all push a history layer and close on popstate.

**Where it lives.** `static/js/party.js:~340-375` — `openParty()` builds and shows the overlay
without `pushState`, and `handlePopstate` (`static/js/router.js:131-139`) has no branch for it.
Because no entry was pushed, the router's anti-exit guard (`router.js:152-155`) re-pushes and the
press is absorbed entirely.

**Evidence.** On 390x844, after opening Party: `history.state = {page:'search'}`, `history.length = 3`.
After `goBack()`: overlay still `display:flex`, `history.state` and `length` unchanged.

**Smallest fix.** `history.pushState({ layer: 'party' }, '')` in `openParty()`, `historyBack()` in
the close handler, and a `if (partyOpen) { closeParty(true); return; }` branch in `handlePopstate`
placed *above* the `epDialog` catch-all at `router.js:138`.

---

### #10 — "Hide 'My Spotify' from navigation" names a nav item that no longer exists
**Severity: medium** · **code-read only** (not toggled — the brief forbids changing settings)

**What a user sees.** A Settings toggle promising to hide a top-level nav entry that was removed
when Spotify became a Library sub-tab. The thing it actually controls — the Library -> Spotify
sub-tab — does not react until the page is reloaded.

**Where it lives.**
- `static/index.html:1068` — the label.
- `static/js/settings.js:994-1009` — the change handler. It PUTs `hide_spotify`, then toggles
  `.nav-btn[data-page="playlists"]` and `.bnav-btn[data-page="playlists"]` — which are the legacy
  stubs at `static/index.html:131` and `:159`, held permanently invisible by
  `static/css/nav.css:24` (`.nav-legacy-hidden { display: none !important; }`).
- `static/js/library.js:37-51` — `_spotifyHidden()` / `_syncSpotifyTab()`, the code that really
  shows or hides the Spotify sub-tab, reading the same `currentUser.hide_spotify`. The settings
  handler never calls it.

**Smallest fix.** Relabel to "Hide Spotify from my Library", and in the handler call
`import('./library.js').then(m => m._syncSpotifyTab && m._syncSpotifyTab())` (exporting it if
needed) instead of poking the dead stubs.

---

### #11 — The artist detail page has no title
**Severity: medium** · **verified in browser** · *flagging only — `audit-search` owns the internals*

**What a user sees.** Opening an artist from search results gives a hero with a blank grey circle,
four buttons, and no artist name anywhere. See `32-download-modal.png`.

**Where it lives.** `static/index.html:252` — `<h2 id="artistDetailName"></h2>`.

**Evidence.** `document.getElementById('artistDetailName').textContent === ""` after opening the
first result for "kaysha".

**Smallest fix.** Owned by `audit-search`; from the outside, whoever populates the artist hero
needs to set `#artistDetailName.textContent`.

---

### #12 — Party's "Save to playlist" looks enabled while it is disabled
**Severity: low** · **verified in browser**

**What a user sees.** The biggest, greenest, most prominent button in the Party sheet is the
primary call to action and does nothing when tapped, because the session is empty.

**Where it lives.** `static/js/party.js:350` — the button carries an inline
`background: var(--accent); color:#000; font-weight:700; cursor:pointer` and the `disabled`
attribute, with no `:disabled` rule anywhere (there is no `party.css`; the overlay is styled inline
from JS).

**Evidence.** Measured on the live overlay: `{ disabled: true, backgroundColor: "rgb(162, 230, 64)",
opacity: "1" }`. See `40-m-party.png`.

**Smallest fix.** Add `#partySave:disabled { opacity:.4; cursor:default; }` to a stylesheet
(inline styles don't cover pseudo-classes, so it has to live in CSS).

---

### #13 — Three stray Czech strings, and the document declares itself Czech
**Severity: low** · **code-read only** (the admin tooltips need an admin account; `claude_test` is not one)

**What a user sees.** An otherwise fully English UI with Czech in three places, and a page that
tells the browser it is Czech — which gives wrong hyphenation, the wrong screen-reader voice and
the wrong spellcheck dictionary throughout.

**Where it lives.**
- `static/index.html:1139-1141` and `static/js/settings.js:683-685` — admin user-permission
  tooltips: `"Stahuje audio z YouTube, metadata ze Spotify"`,
  `"P2P stahovani pres sit Soulseek, preferuje zvoleny format"`,
  `"Torrent stahovani pres Lidarr, monitoruje diskografie"`.
- `static/js/queue.js:422` — a toast: ``Playlist "${name}" uz existuje — zvol jiny nazev``.
- `static/index.html:3` — `<html lang="cs">`.

**Smallest fix.** Translate the four strings; change `lang="cs"` to `lang="en"`.

---

### #14 — "Refresh app (clear cache & reload)" sits in the primary chrome
**Severity: low** · **verified in browser**

**What a user sees.** Three unlabelled circular icon buttons sit immediately right of the search
box: a microphone (guessable), a party-popper (not guessable), and a circular arrow that silently
deletes every Cache Storage entry and hard-reloads the app. Developer plumbing occupying the most
valuable pixels on the landing page. No equivalent exists in Spotify.

**Where it lives.** `static/index.html:~175` (`#appRefreshBtn`), handler at
`static/js/search.js:954-963` (`caches.keys()` -> `caches.delete()` -> `location.href = ...`).
Related nit: `#micBtn` has only a `title`, while its two neighbours have `aria-label` as well.

**Smallest fix.** Move it into Settings -> App beside the existing "Refresh" button
(`static/index.html:1106`), and add `aria-label="Identify song with microphone"` to `#micBtn`.

---

### #15 — Tag detail stacks three unlabelled, identical-looking pill groups
**Severity: medium (on mobile)** · **verified in browser**

**What a user sees.** Three visually identical rows of pills with no captions explaining what any
of them do: *Tracks / Albums / Artists*, then *All / New to me / In library*, then
*Popular / Deeper cuts*, then a filter box. On a 390px viewport they wrap into three stacked rows
plus the filter, pushing the first result roughly 530px down — below the fold. See
`22-m-tagdetail.png`. (The groups also appear and disappear per result type —
`static/js/discover.js:68-71` hides novelty for artists and depth for non-tracks — so the row
count shifts under the user as they browse.)

**Where it lives.** `static/index.html:302-317`.

**Smallest fix.** Add tiny muted captions ("Show", "Novelty", "Depth") above each group, or on
mobile collapse the last two behind a single "Filters" disclosure.

---

### #16 — Mic errors surface raw browser strings
**Severity: low** · **verified in browser** (headless, so the specific error differs from a real denial)

**What a user sees.** `Mic error: Requested device not found` — and, for a real user who declines
the permission prompt, `Mic error: Permission denied`. Neither says what to do next.

**Where it lives.** `static/js/recognize.js` — the `getUserMedia` catch path passes `e.message`
straight into `micLog()`. (Note the *server-side* recognize failures are handled well:
`classifyRecognizeError` at `static/js/recognize.js:86-93` writes genuinely good copy.)

**Smallest fix.** Map `NotAllowedError` -> "Microphone blocked — allow it in your browser's site
settings" and `NotFoundError` -> "No microphone found" before falling back to `e.message`.

---

# Spotify parity gaps

### P1 — There are no URLs at all
**Severity: high (as a parity gap)** · **verified in browser + over HTTP**

**What a user sees.** The address bar never changes. You cannot bookmark, share or link to an
artist, an album, a playlist, a genre or even a tab. Any refresh dumps you back on Search and
throws away wherever you were. The browser's own back/forward long-press menu shows a column of
identical entries, so it is useless for jumping back several steps.

**Where it lives.** `static/js/router.js:17-57` — every state transition is
`history.pushState({ page }, '')` with **no URL argument**, so the path is never touched. Detail
layers push `{ layer: 'tagDetail' }`, `{ layer: 'artistDetail' }` etc., also URL-less.

**Evidence.** `curl` against the live instance: `/search`, `/discover`, `/library` and `/settings`
all return **404**. Only `/` serves the app.

**Smallest fix.** Full path routing needs a server catch-all. The cheap first step needs no server
change at all: pass a hash as the second `pushState` argument (`#/discover/zouk`,
`#/artist/<id>`) and parse `location.hash` once at boot. That alone buys bookmarking, sharing,
refresh-in-place, and a readable browser history menu.

---

### P2 — Two unrelated "browse by genre" surfaces
**Severity: medium** · **verified in browser**

**What a user sees.** The Search page's **"Browse all"** (Deezer genre tiles -> playable charts) and
the **Discover** page's **"Discover by Genre"** (Last.fm tag cloud -> tag results). Different
vocabularies, different result shapes, different card affordances, no cross-link, and no hint which
one to use for what. A new user has to try both to learn the difference, and will still not be able
to articulate it. Spotify has exactly one genre surface.

**Where it lives.** `static/js/search.js:351-359` (Deezer, `/api/genres`) versus
`static/index.html:288-296` + `static/js/discover.js:21-45` (Last.fm, `/api/discover/tags`).

**Smallest fix.** Pick one as canonical. The cheapest coherent story: keep Discover as the single
genre home, and on Search replace "Browse all" with the Discover tag cloud (or a link to it), so
"browse by genre" has one answer.

---

### P3 — "Discover by Genre" is mostly not genres
**Severity: medium** · **verified in browser**

**What a user sees.** Under a heading that promises genres, the live cloud serves
`seen live` (2.2M), `bookmark` (486k), `female vocalists` (1.6M), `japanese`, `german`, `90s`
interleaved with real genres. These are Last.fm *user library* tags, not genres; `seen live` and
`bookmark` return essentially random tracks. See `04-discover-full.png`.

**Where it lives.** `app/services/lastfm.py:47 get_top_tags()` returns Last.fm's top-tags list
unfiltered; `static/js/discover.js:31-38` renders it verbatim.

**Smallest fix.** A small denylist in `get_top_tags` for the known non-genre tags, or — better and
already proven in this codebase — a curated list, the way `ZOUK_PRESETS`
(`static/js/discover.js:14`) already works.

---

### P4 — There is no home / "For You"
**Severity: medium** · **verified in browser**

**What a user sees.** The landing surface immediately after login is an empty search box above a
wall of genre tiles. Nothing personal, nothing recent, nothing recommended. `01-search-desktop.png`
(captured right after login, before the genre grid resolves) is a literally blank page.

**Where it lives.** `static/js/app.js:41-43` registers page loaders for `discover`, `settings` and
`library` only; `search` is the implicit default (`static/js/router.js:167`). The recommendation
engine exists but renders *only* inside the full-player queue panel —
`static/js/recommendations.js:457,459` (`_ensureRecsIn($('#fpQueueList'))`,
`_ensureRecsIn($('#fpQueuePanelList'))`) — so it is invisible until you are already playing
something.

**Smallest fix.** Surface the existing recommendations on the empty-search state, above
"Browse all": a "Recently played" row and a "For you" row reusing `recommendations.js`. Spotify's
home is the front door; here it does not exist.

---

### P5 — The login screen is bare
**Severity: low** · **verified in browser**

**What a user sees.** Logo, two fields, Sign In. No autofocus (on desktop `document.activeElement`
is empty after load, so you must click into Username), no indication that the session lasts 30 days
(it does — see `project_login_and_engine`), no instance or server name, no recovery path.

**Where it lives.** `static/index.html:99-118` (login box), `static/js/auth.js:218-237` (`init`).
`static/js/utils.js:autoFocus` already exists and is applied to `#searchInput` *after* login
(`static/js/auth.js:194`) but never to `#loginUser`.

What is already right: the error copy is correct and non-leaky — "Invalid username or password",
verified identically on desktop and mobile — and `_offerServerSwitch()` (`static/js/auth.js:88-110`)
is a thoughtful native-app-only escape hatch that correctly renders nothing in a browser.

**Smallest fix.** `autoFocus($('#loginUser'))` at the end of `auth.js init()` when no token exists,
and a one-line subtitle naming the instance.

---

### P6 — Back-link labels differ per surface
**Severity: low** · **verified in browser**

**What a user sees.** `<- Back` on tag detail, `<- Back to results` on artist/album detail,
`<- Back to Podcasts` in podcasts. Three phrasings for one concept.

**Evidence.** Enumerating every button matching `/back/i` on the live app returned:
`["<- Back to results", "<- Back to results", "<- Back", "<- Back", "<- Back", "<- Back", "<- Back",
"<- Back to Podcasts", ...]`.

**Smallest fix.** Standardise on one. Spotify uses a bare chevron with no text; `<- Back` is the
closest existing match and is already the majority.

---

# Nice to have

- **Feedback FAB is faint and overlaps content.** `static/css/feedback.css:15` sets
  `opacity: .55`; it sits over the Library empty-state text and over a result card on tag detail
  (`21-m-library.png`, `22-m-tagdetail.png`). *Verified in browser.* Nudge the resting opacity up,
  or inset it when a page's content reaches it.
- **The feedback modal's title does not follow its own toggle.** It reads "Report a bug" even after
  you select **Feature** (`static/js/feedback.js:_openModal`, see `34-feedback-modal.png`).
  *Verified in browser.* Swap the heading with the toggle. Everything else about this modal is
  good — primary left, Cancel right, a live character counter, an opt-out screenshot thumbnail,
  and a genuinely careful secret-masking pass before capture (`feedback.js:_hideRevealedSecrets`).
- **Settings -> "Account" is Spotify-only.** `static/index.html:1029` — the section carries a
  Spotify glyph, is labelled "Account", and contains nothing but Spotify OAuth and credentials.
  Users will look there for their own username and password. *Code-read, confirmed visually in
  `60-m-settings-expanded.png`.* Rename it "Spotify" and put the real account controls under a new
  "Account" (which also solves finding #1).
- **Logout is instant with no confirmation** (`static/js/auth.js:199`, wired at `auth.js:221`).
  Acceptable — Spotify does the same — but worth one confirm now that the only mobile path is
  labelled "Clear All & Logout". *Code-read only.*
- **The admin "Admin" group label is correctly suppressed for non-admins**
  (`static/css/settings.css:58-61`, a `:has()` rule keyed off `#usersSection`). Noted as a positive;
  it is the kind of thing that usually leaks an empty heading.

**Deferred to other owners** — noted only because they are the first thing a navigation click
shows, both *verified in browser*:

- **Library landing is one enormous tile.** On 390x844 the "Liked Songs" card renders ~710px tall,
  filling the entire viewport, with the "No playlists yet" empty state wrapped into a 5-line narrow
  column beneath it (`21-m-library.png`; same at 1280x900 in `02-library-desktop.png`).
  -> `audit-library`.
- **Artist detail blank title** (finding #11). -> `audit-search`.

---

# Ranked list (all findings)

| # | Finding | Severity | Verified |
|---|---------|----------|----------|
| 1 | No plain Log out on mobile; username never shown | high | browser |
| 2 | Back stack corrupted by a detail view left open behind a nav switch | high | browser |
| 3 | Ad-hoc modals eat a history entry; Promise never resolves | high | browser |
| 4 | Every Discover cover is Last.fm's placeholder star | high | browser |
| 5 | "Browse all" genre tiles half in Czech | high | browser |
| P1 | No deep links / URLs anywhere | high (parity) | browser + HTTP |
| 6 | Confirm dialog focuses Delete and Enter confirms | medium | browser |
| 15 | Tag detail: three unlabelled filter groups, results below the fold on mobile | medium | browser |
| 7 | Downloads tab never highlights while its panel is open | medium | browser |
| 8 | Toasts cover the bottom nav on mobile | medium | browser |
| 9 | Party overlay ignores Back | medium | browser |
| 10 | "Hide My Spotify from navigation" controls a removed nav item | medium | code |
| 11 | Artist detail has no title | medium | browser |
| P2 | Two unrelated genre-browse surfaces | medium (parity) | browser |
| P3 | "Discover by Genre" serves non-genre Last.fm tags | medium (parity) | browser |
| P4 | No home / For You; recommendations hidden in the queue panel | medium (parity) | browser |
| 12 | Party "Save to playlist" looks enabled while disabled | low | browser |
| 13 | Czech strings + `lang="cs"` on an English page | low | code |
| 14 | "Refresh app" in the primary chrome | low | browser |
| 16 | Mic errors surface raw browser strings | low | browser |
| P5 | Login screen bare, no autofocus | low (parity) | browser |
| P6 | Three different back-link labels | low (parity) | browser |
| - | Feedback FAB faint / overlaps; modal title ignores its toggle | nice to have | browser |
| - | Settings -> "Account" is Spotify-only | nice to have | code |
| - | Logout has no confirmation | nice to have | code |

## What was verified in the browser vs read in code

**Verified by driving the live app:** findings 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16,
P1, P2, P3, P4, P5, P6, and the two deferred observations.

**Code-read only (not exercised):** finding 10 (would require saving a setting — forbidden by the
brief), finding 13's admin tooltips (needs an admin account; `claude_test` is not one — the
`lang="cs"` and `queue.js` strings are code-read but unambiguous), and the logout-confirmation and
Settings->Account notes.

**Judged from code plus rendered UI only, never exercised end-to-end:** the microphone and Party
recognition *capture* paths — `getUserMedia` cannot succeed headless. Their *navigation* behaviour
(finding 9, the Back handling) and their *rendered state* (finding 12, the disabled-looking-enabled
button; finding 16, the error copy) were measured in the real DOM and are verified.

## Screenshot index

| File | What it shows |
|---|---|
| `01-search-desktop.png` | Landing page immediately after login — blank |
| `02-*-desktop.png` | Desktop nav tour (discover / library / settings / search) |
| `03-settings-full.png`, `04-discover-full.png` | Full-page desktop captures |
| `05-after-6-backs.png` | End of the desktop back sequence |
| `10-tag-detail.png` | Discover tag detail — all placeholder stars (#4) |
| `11..14-*.png` | Tag-detail history layering, the swallowed Back (#2) |
| `20-m-search.png`, `21-m-*.png` | Mobile tour (search / discover / library / settings) |
| `22-m-tagdetail.png` | Mobile tag detail — stacked filters (#15) + placeholder stars (#4) |
| `23-m-nav-6items.png` | Bottom nav with Now Playing forced visible |
| `24-desktop-search-settled.png` | Genre wall, Czech tiles (#5) |
| `30..35-*.png` | Modal + back-button sequence (#3), feedback modal |
| `36-artist-detail.png`, `32-download-modal.png` | Artist detail with no title (#11) |
| `40-m-party.png`, `41-m-after-back-party.png` | Party overlay, Back ignored (#9), disabled green button (#12) |
| `42-m-mic-denied.png` | Raw mic error copy (#16) |
| `50/51-login-*.png` | Login screen + error state, both viewports (P5) |
| `60-m-settings-expanded.png`, `61-m-settings-app.png` | Mobile Settings, the "Clear All & Logout" path (#1) |
| `70-m-downloads-panel.png` | Downloads panel with the tab unhighlighted (#7) |
| `71-m-toast.png` | Toast covering the bottom nav (#8) |
