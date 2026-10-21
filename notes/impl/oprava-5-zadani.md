# Oprava 5 — UX audit, vlna 2: detail interpreta a alba, knihovna, stahování, backend

Stav: zadání před kritikou. 21. 10. 2026. Navazuje na `oprava-4-zadani.md`
(vlna 1: vyhledávání, přehrávač, navigace) — stejné podklady, stejná pravidla,
stejný oracle.

Reporty: `notes/impl/audit-2026-10/{search,library,player,nav}.md`.

## Co platí beze změny z vlny 1

- **Oracle:** na produkci běží starý kód. Každý bod má kontrolu, která proti
  němu **padá**, a po nasazení prochází. Kontroly do `tests/e2e/audit/<celek>.mjs`
  nad sdíleným postrojem `tests/e2e/audit/helpers.mjs` (vlastní vedení,
  **needitovat**).
- **Tři rozlišení**, všechna povinná: 390x844 telefon, **1024x768 tablet na
  šířku** (nad breakpointem 640 — dostane desktopová pravidla na dotykovém
  zařízení), 1280x900 desktop.
- `static/index.html` se needituje — zdroj je `frontend/partials/*.html`.
- Účet `claude_test` / `TestPass2026!`, nikdy `lucas`. Na produkci nic nestahovat,
  nemazat, neměnit nastavení.
- Necommitovat, nepushovat, nenasazovat. Žádná stopa po AI.
- `app/services/radio.py`, `app/routers/player.py`, `static/js/recommendations.js`
  — nesahat.
- Sada: `python3 -m pytest tests/ -q` (78 passed, 3 skipped) a
  `node --test tests/js/bpm_client.test.mjs` (**cestou k souboru**, ne k adresáři).

---

# Celek 4 — Detail interpreta a alba

Soubory: `static/js/spotify.js`, `static/css/pages.css`,
`frontend/partials/30-search.html`, `tests/e2e/audit/detail.mjs`.
**Ne** `search.js`, **ne** `library.js`.

### D1 — hrdinka je na desktopu sloupec tlačítek vedle náhledu 100x100 (vysoká)

Na stránce alba sedí obal 100 px vlevo, titulek vedle a **pět tlačítek pod sebou**
u pravého okraje přes ~250 px výšky, mezi tím ~300 px prázdna. U interpreta totéž
se čtyřmi. Spotify má velký obal, titulek, řádek metadat a **jednu vodorovnou
řadu akcí**.

Mobilní pravidlo to přitom už dělá správně (`responsive.css:122-124`:
`flex-direction: row; flex-wrap: wrap`). Příčina je základní pravidlo
`pages.css:104` (`.playlist-hero-actions { flex-direction: column; align-items:
flex-end }`) a velikost obalu `pages.css:96`.

Oprava: povýšit mobilní chování na základní, obal na ~180 px,
`.playlist-hero { align-items: flex-end }`. **Pozor:** stejná hrdinka se používá
i pro playlist a knihovnu (celek 5) — změna se projeví všude. To je záměr, ale
musí se ověřit na všech čtyřech stránkách (interpret, album, playlist, knihovní
playlist) a ve všech třech rozlišeních. Na 1024x768 nesmí vzniknout vodorovný
přetok.

### D2 — hrdinka interpreta je vteřiny prázdná (vysoká)

`#artistDetailName` se plní až z odpovědi se seznamem alb, takže na začátku
koukáš na šedé kolečko bez jména. `loadPlaylistDetail` to řeší správně — dostane
jméno a obal z karty a vykreslí je hned (`_openPlaylistDetail`).

Oprava: `loadArtistDetail` přebírá `{ name, image }` z položky, která ho otevřela,
a vykreslí je před fetchem. Volající jsou v `search.js` (`_routeCardClick`) —
**ten soubor patří celku 1 vlny 1**, takže tenhle celek musí fungovat i bez něj:
parametr volitelný, chybí-li, chová se jako dnes. Do evidence napiš, že doplnění
volajícího je samostatný bod pro vedení.

### D3 — Play na interpretovi naskočí pozdě a posune sloupec; chybí Shuffle (střední)

`#playArtistTop` se zobrazí až po doběhnutí `_loadArtistTop` (`spotify.js:504`),
takže tlačítka poskočí. Album má Shuffle, interpret ne.

Oprava: vykreslit od začátku viditelné a **zakázané**, povolit po načtení; přidat
Shuffle vedle Play (logiku vzít z alba, `spotify.js:702-712`).

### D4 — diskografie je 39 nerozlišených dlaždic (střední)

Studiovky, singly, remix EP a živáky promíchané, bez řazení a bez „Appears on".
`record_type` ("album"/"single"/"ep"/"compilation") **už chodí po drátě**
(`search_providers.py:113`) a frontend ho zahazuje (`spotify.js:444-453` tiskne
jen rok a počet skladeb; počet je navíc u tohohle endpointu vždy 0).

Oprava: typ do podtitulku (`2001 · Album`) a mřížku rozdělit na „Albums" a
„Singles and EPs". Pořadí uvnitř skupin nech, jak je (je to záměrné řazení podle
oblíbenosti, `search_providers.py:205-210`).

### D5 — hlavička alba nemá rok ani délku (střední)

Dnes `Discovery / Daft Punk / 14 tracks`, Spotify `Album · 2001 · 14 songs,
1 hr 1 min`. Obě hodnoty jsou v ruce: `album.year` na položce, která stránku
otevřela, a `duration_ms` na každé skladbě v odpovědi.

### D6 — mrtvý pruh tempo filtru nad seznamem skladeb alba (nízká)

Pruh zašedlých ovládacích prvků s popiskou „BPM known for 1/14" a „Tempo filter
needs analyzed local tracks" mezi hrdinkou a hudbou. U playlistu to vlna 1.25.1
už vyřešila (`bpm.js` nemountuje filtr, když `allowAnalyze === false` a pokrytí je
nízké) — **u alba zůstal**, protože `_mountTempoFilter` se volá stejně, ale
`initTempoFilter` dostává jiné `opts`. Ověř, proč se podmínka u alba neuplatní, a
srovnej to.

### D7 — dvě soupeřící primární tlačítka na hrdince alba (nízká)

„▶ Play All" i „Download All" jsou akcentově zelené. `#downloadAlbum` v
`partials/30-search.html` používá holou třídu `btn-download`; dát mu
`btn-hero-secondary`.

### D8 — emoji 🔀 a 📻 na hrdince (nízká)

`#shuffleAlbum` v partialu. Nahradit inline SVG ve stylu ostatních ikon.
(Rádio na kartách řeší celek 1 vlny 1.)

### D9 — „Refresh app" pryč z hlavního chromu (nízká)

Tři kulatá tlačítka vedle pole hledání ukrajují na 390 px ~180 px z 390.
Prostřední (`#appRefreshBtn`) maže Cache Storage a tvrdě reloaduje — vývojářská
pojistka, která má dvojníka v Nastavení.

Oprava: přesunout **markup** z `partials/30-search.html` do
`partials/60-settings.html` k existujícímu tlačítku Refresh. Handler v
`search.js` se váže přes `id`, takže se nemění — **do `search.js` nesahej** a do
evidence napiš, že se na to vedení musí podívat při merge s celkem 1.
Při té příležitosti doplň `#micBtn` `aria-label` (sousedi ho mají, mikrofon ne).

### D10 — taby přetékají na telefonu do dvou řádků (nízká)

„All / Tracks / Albums / Artists" a pod tím „Playlists / Podcasts" ukrajují ~40 px
nad ohybem při každém hledání. Spotify filtry scrolluje vodorovně v jedné řadě.
Markup `partials/30-search.html` (`.type-toggle`); CSS k tomu **patří celku 1**
(`search.css`) — pokud to jde udělat jen v CSS, **nech to vlně 1** a sem napiš
poznámku. Když je potřeba sáhnout na markup, udělej to tady a napiš to.

### D11 — popisky zpět nejsou jednotné (nízká)

„← Back to results" (interpret, pořad), „← Back" (album), „← Back to Podcasts",
„← Browse all" vpravo v hlavičce sekce (to je celek 1). Sjednotit na jeden tvar
v partialech, které vlastní tenhle celek.

---

# Celek 5 — Knihovna a stahování

Soubory: `static/js/library.js`, `static/js/downloads.js`, `static/js/podcasts.js`,
`static/js/favorites.js`, `static/css/downloads.css`, `static/css/pages.css`
(**jen pravidla knihovny — hrdinku vlastní celek 4, domluvte se přes vedení**),
`frontend/partials/50-library.html`, `frontend/partials/95-panels.html`,
`tests/e2e/audit/knihovna.mjs`.

**Kolize:** `pages.css` chtějí celky 4 i 5. Rozhodnutí vedení: `pages.css` patří
**celku 4**. Celek 5 si potřebné pravidlo napíše do `downloads.css` nebo o změnu
v `pages.css` požádá vedení a do té doby pokračuje jinde.

### K1 — dlaždice „Liked Songs" je 1144 x 1209 px (vysoká)

Na desktopu zabere celou první obrazovku Knihovny; k nápisu se doscrolluje po
~1200 px. Na telefonu 358 x 413. Příčina: `partials/50-library.html` ji vykresluje
jako přímé dítě `#libraryList`, **mimo `#libraryGrid`**, a `.card-img` má
`aspect-ratio: 1/1`.

Oprava: dovnitř mřížky jako první položka (nebo vlastní jednosloupcová `.grid`).
Ověřit ve všech třech rozlišeních, že výška dlaždice odpovídá ostatním kartám.

### K2 — „Liked Songs" hlásí „0 songs", dokud je jednou neotevřeš (vysoká)

Změřeno dvakrát: po 6 s „0 songs", po odchodu a návratu „0 songs", po otevření a
zavření „8 songs". `loadLibrary()` volá `_refreshLikedCount()` synchronně
(`library.js:164`) dřív, než doběhne `loadLikes(true)` puštěné bez čekání z
`auth.js:205`; posluchač `likeschange` (`library.js:1026` → `_rerenderLikedSongs`,
`:968`) se vrátí hned, pokud není otevřený pohled, a návrat do Knihovny nepomůže,
protože `switchLibraryTab` na cachované záložce končí hned (`library.js:89`).

Oprava: `loadLikes().then(_refreshLikedCount)` a `_refreshLikedCount()` nad
strážce `_likedViewOpen`.

### K3 — Lidarr hlásí hotovo dřív, než cokoli stáhne (vysoká)

Zelený odznak **DONE** a notifikace „MusicSeeker - Download Complete", zatímco
Lidarr teprve začíná. Jediná věta, která to vysvětluje, je uťatá na jeden řádek:
„Search triggered in Lidarr, download will proceed in backgro…".

Příčina: `_run_lidarr` končí na progress 90 s tou větou
(`app/services/downloader.py:734-735`), pak `:99-101` nastaví pro libovolnou
metodu `status = DONE, progress = 100`. Badge `downloads.js:186`, notifikace
`downloads.js:217-240`, ořez `downloads.css:36`.

Oprava: vlastní koncový stav pro předání Lidarru (např. `handed-off`, text „Sent
to Lidarr"), notifikaci o dokončení u `method === 'lidarr'` přeskočit, vysvětlující
větu nechat zalomit.
**Pytest test povinný** (`tests/test_lidarr_handoff.py`): job s metodou lidarr
nekončí ve stavu DONE; job s yt-dlp končí. Mutace: vrátit `status = DONE` pro
všechny metody → test zčervená.

### K4 — stahování jedné skladby má ukazatel trvale na nule (vysoká)

Nejčastější případ vypadá zaseknutě: RUNNING, „1/1 — Downloading …", pruh prázdný
po celou dobu, pak skok na hotovo. `job.progress = int((i - 1) / total * 100)`
(`downloader.py:416`, stejně `:663` pro slskd) je pro `total == 1, i == 1` vždy 0.
Navíc je drážka `var(--bg-input)` na kartě `var(--bg-elevated)`, takže je prakticky
neviditelná (`downloads.css:34`).

Oprava: hlásit skutečný postup (yt-dlp procenta vypisuje), nebo minimálně
neurčitý/pruhovaný ukazatel, když `progress === 0 && status === 'running'`.
**Pytest test** na výpočet postupu u `total == 1`. Mutace: vrátit původní vzorec
→ zčervená.

### K5 — „Add to playlist" v hromadném výběru přidá do fronty (střední)

Ověř v `library.js` a oprav tak, aby dělalo, co slibuje; nebo přejmenuj, pokud je
záměrem fronta — rozhodni a zdůvodni.

### K6 — křížek u řádku maže bez potvrzení a bez undo; kebab maže podle jména (střední)

`_removeTrackFromPlaylist` jde přes `remove-by-name`, takže u duplicity odebere
první výskyt, ne ten, na který jsi klikl. Křížek jde přes index
(`downloads`/`library.js:896-917`) a nic se neptá.
Oprava: potvrzení (`showConfirmModal`, u `danger` fokus na Cancel — to řeší vlna 1,
tady na to jen navaž) a kebab srovnat na index.

### K7 — kliknutí na sledovaného interpreta otevře stahovací dialog (střední)

Místo stránky interpreta. `favorites.js` — poslat to na `loadArtistDetail`.

### K8 — hrdinka knihovního playlistu je 421 px se sedmi tlačítky pod sebou (střední)

Play All, + Add All, Edit, Change cover, Duplicate, Merge, **Delete** — červené
Delete není o nic méně výrazné než Edit. Oprava: v hrdince nechat Play (a Shuffle,
viz K9), zbytek do jednoho kebabu přes `makeKebabButton`; obsluhy už existují
(`library.js:1063-1161`). Markup `partials/50-library.html`.
Souvisí s D1 (celek 4 mění základní pravidlo hrdinky) — po merge ověřit společně.

### K9 — knihovní playlist nemá Shuffle (střední)

Liked Songs i playlist z vyhledávání ho mají.

### K10 — Liked Songs nemají délku skladby ani celkový čas (střední)

### K11 — slepé prázdné stavy (střední)

Podcasts, Favorites i Downloads napíšou „nic tu není" a nenabídnou cestu dál.
Favorites navíc radí „klikni na srdíčko u interpreta", které je na desktopu
`opacity: 0` do najetí myší (`cards.css:141-142`) — a na **tabletu na šířku** se
na něj nedá najet vůbec. Oprava: primární tlačítko, které skočí do vyhledávání
předvoleného na správný typ (`_searchFor` existuje, `contextmenu.js:624-633`);
u Favorites větu přepsat, aby platila i bez hoveru.

### K12 — stahovací dialog neumí přidat do playlistu ani lajknout (střední)

Tytéž dvě akce kebab má. `partials/70-download-modal.html` plus obsluhy z
`contextmenu.js` (`makeHeartButton`, `_addToNavidromePlaylist`).

### K13 — „Downloads" v navigaci se nepodbarví, když je panel otevřený (nízká)

`switchPage('downloads')` přepne panel a vrátí se dřív, než se nastaví aktivní
třída (`router.js:17-21`). **Router patří vlně 1** — udělej to z
`openPanel()`/`closePanel()` v `downloads.js` (tenhle celek) a do evidence napiš,
že se to s vlnou 1 nesmí porvat.

### K14 — karty knihovních playlistů nemají viditelný kebab (nízká)

Na dotyku je jediná cesta k přejmenování a smazání podržení 480 ms bez jakékoli
nápovědy; importované playlisty hned pod nimi kebab mají.
`renderLibraryGrid` (`library.js:341-347`) ho nepřidává, `renderImportedGrid`
(`:229`) ano.

### K15 — joby jsou jeden plochý seznam (nízká)

Bez dělení aktivní/hotové, bez souhrnu, bez ETA, bez zahození jednotlivé položky.
`downloads.js:178-193`.

### K16 — `refreshJobs` polyká všechny chyby (nízká)

Holý `catch {}` na `downloads.js:201`: když `/api/jobs` začne selhávat, panel tiše
ukazuje zastaralý stav. Tahle instance během auditu dvakrát vrátila 502 — není to
teoretické.

### K17 — nativní `confirm()` / `alert()` v podcastech a stahování (nízká)

Zbytek aplikace má vlastní modály.

### K18 — `#libBulkActions` deklaruje `display` dvakrát (nízká)

`partials/50-library.html`; totéž `#podcastBulkBar`. Neškodné, ale je to zbytek.

---

# Celek 6 — Backend

Soubory: `app/services/search_providers.py`, `app/routers/search.py`,
`app/services/lastfm.py` (**jen pokud to neudělal celek 3 vlny 1 — ověř v
`git log main`**), `tests/test_*.py`. **Ne** frontend.

Tenhle celek má jako jediný skutečnou sadu, takže tu platí mutace v plném znění:
ke každému bodu test, který **před opravou padá**, a pak mutace, které ho musí
rozsvítit červeně.

### B1 — dlaždice žánrů chodí česky (vysoká)

Deezer lokalizuje podle IP serveru, takže polovina dlaždic je česky na jinak
anglickém UI: „Taneční hudba", „Alternativní hudba", „Pro děti" vedle „Pop",
„Rock", „Jazz". `deezer_genres()` (`search_providers.py:340-344`) nepošle
`Accept-Language`.
Oprava: `headers={"Accept-Language": "en"}`. **Pozor:** výsledek je cachovaný
(`_GENRE_CACHE_TTL` = 86400), takže po nasazení se projeví až po restartu
kontejneru — nasazení ho dělá, ale napiš to do evidence.
Test: fake klient zachytí hlavičky → `Accept-Language: en`. Mutace: hlavičku
odebrat → zčervená.

### B2 — žánrový žebříček vrací mimo žánr (střední)

Pod „Rock" jsou skladby správně (Sweet Child O' Mine, Mr. Brightside), ale
interpreti jsou P T K, Yzomandias, Taylor Swift a alba Limp Bizkit *Results May
Vary*, Brixton *LÍNEJ*. Deezer u `/chart/{genre_id}` spolehlivě scopuje jen
`tracks`; zbytek padá zpátky na regionální žebříček.

Oprava (rozhodni a zdůvodni): buď posílat jen `tracks` a `playlists`, nebo řadu
interpretů odvodit z interpretů těch skladeb. Druhá varianta je hezčí a data už
máme — ale ověř na třech různých žánrech, že nedává nesmysl.
Test nad zaznamenanou odpovědí (fixtura ze skutečného volání, ne z hlavy — D18).

### B3 — top výsledek dá přednost přesnému jménu interpreta před zjevnou skladbou (střední)

„one more time" → neznámý interpret toho jména místo Daft Punk. `_pick_top_result`
(`search_providers.py:1117-1142`) vrací první přesnou shodu jména interpreta dřív,
než cokoli zváží. `nb_fan` je přitom u interpretů už načtený (`:376`).
Oprava: přesná shoda vyhraje, jen když interpret zároveň přebije skladbu
popularitou. Práh zdůvodni měřením na nejméně pěti dotazech, kde to dnes selhává,
a pěti, kde dnes rozhoduje správně (např. „adele", „queen", „creep",
„bohemian rhapsody", „nirvana").
Test s fixturami pro obě strany. Mutace: podmínku obrátit → zčervená.

### B4 — `/api/search` přijímá `type=episode`, ale UI pro něj nemá záložku (nízká)

`routers/search.py:16`. Buď zpřístupnit pod Podcasts (to je frontend, tedy jiná
dávka → sem napiš jen poznámku), nebo z pattern odebrat. Rozhodni a zdůvodni.

### B5 — placeholder Last.fm (vysoká, **jen pokud to nedoběhlo ve vlně 1**)

Viz N7 v `oprava-4-zadani.md`. Než začneš, ověř `git log main -- app/services/lastfm.py`.

---

## Dokumentace po dávce

- `docs/` — nový koncový stav jobu pro Lidarr, výpočet postupu, co se změnilo na
  hrdince, `Accept-Language` u Deezeru a jeho cache.
- `CLAUDE.md` — past „hrdinka je sdílená čtyřmi stránkami" a „genre cache přežije
  nasazení, ne restart".

## Přejímka

Stejná jako u vlny 1: tři rozlišení, běžící instance, důkaz u každého bodu,
report `prejimka-5.md`. Rozpočet placených volání: žádná.
**Stahování se při přejímce nespouští** — stav jobů se ověřuje nad historií a
nad fixturami, ne stažením skutečné skladby.
