# Oprava 4 — UX audit, vlna 1: vyhledávání, přehrávač, globální navigace

Stav: zadání před kritikou. 21. 10. 2026.

## Odkud to je

Čtyři agenti prošli 21. 10. 2026 celou aplikaci proti produkci (v1.24.3, u části
nálezů 1.25.2): četli kód a pak ji **doopravdy proklikali** headless Chromiem na
1280x900 a 390x844, u přehrávače se skutečnými dotykovými událostmi přes CDP.
Plné reporty včetně důkazů a odkazů na snímky:

- `notes/impl/audit-2026-10/search.md` (28 nálezů)
- `notes/impl/audit-2026-10/player.md` (23)
- `notes/impl/audit-2026-10/nav.md` (25)
- `notes/impl/audit-2026-10/library.md` (23)

Snímky zůstaly ve scratchpadu session:
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/audit-*/`.

Tahle dávka bere **vlnu 1** — tři celky, které spolu nesdílí jediný soubor.
Vlna 2 (detail interpreta a alba, knihovna, stahování, backend) jde zvlášť jako
`oprava-5`; nálezy, které se jí týkají, jsou tady vypsané jen jako „mimo dávku".

## Čím se tu nahrazují mutace

Repo nemá `tsc` ani `vitest`; `package.json` má jen Playwright. Sada je
**78 pytest testů (3 skipped)** a `node --test tests/js/bpm_client.test.mjs`, obě
jen backend/BPM — frontendu se nedotknou. Viz `project_poctiva_adaptace`.

Oracle pro tuhle dávku je jiný a je **silnější než mutace**: na produkci běží
**starý kód** (1.25.2). Ke každému bodu patří kontrola v Playwrightu, která

1. **proti produkci PŘED nasazením padá** (dokládá, že měří ten nález), a
2. po nasazení prochází.

Bod bez „padá na starém" se nepočítá za hotový — je to D18 ve tvaru, který tenhle
repozitář umožňuje. Kontroly se ukládají do `tests/e2e/audit/<celek>.mjs`, pouští
se proti `https://musicseeker.hanaktech.org` účtem `claude_test` / `TestPass2026!`
(**nikdy `lucas`**), každý agent s vlastním `ms_device_id`.

Přihlašovací vzor, který funguje (`waitUntil: 'load'` + 3 s usazení, jinak klik
předběhne navěšení handleru):
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/helpers.mjs`

**Tři rozlišení, všechna povinná** (Lukášův výslovný požadavek):

| režim | rozměr | poznámka |
|---|---|---|
| telefon | 390 x 844 | pod hranicí 640 px, spodní navigace, horní lišta skrytá |
| tablet na šířku | 1024 x 768 | **nad** 640 px — mobilní pravidla NEplatí, desktopová ano |
| desktop | 1280 x 900 | |

Tablet na šířku je past: je nad breakpointem, takže dostane desktopové chování
(skryté hover-only ovládání, sloupce tlačítek) na dotykovém zařízení. Každá
kontrola, která se týká rozložení, musí běžet ve všech třech.

## Co se v téhle dávce nesmí

- `static/index.html` se needituje. Zdroj je `frontend/partials/*.html`, generuje
  jen `scripts/build-index.sh`. Autor ho ve svém worktree spustit smí; **vedení
  ho po merge přestaví znovu** a hlídá `scripts/check-index.sh`.
  (17. 10. jiná session editovala `index.html` přímo a hradlo bylo tiše červené —
  viz `predavka-oprava-2-3.md`.)
- Necommitovat, nepushovat, nenasazovat. Nasazuje vedení.
- Žádná stopa po AI v kódu, commitech ani dokumentaci.
- Na produkci jen číst a přehrávat: **nestahovat, nemazat, neměnit nastavení**,
  nezakládat playlisty. Výjimka je povolená jen celku 2 a jen takhle: dočasný
  playlist se jménem začínajícím `zz-` se smí založit, musí se **smazat ve stejném
  skriptu** a jeho jméno se napíše do evidence.
- `app/services/radio.py`, `app/routers/player.py`, `static/js/recommendations.js`
  jsou rozdělaná cizí práce — **nesahat**. Celek 2 se jich dotýká jen tím, co se
  s *výsledkem* `playNextRec()` stane ve frontě (soubor `player.js` / `player_v3.js`),
  dovnitř doporučovače nezasahuje.

---

# Celek 1 — Vyhledávání

Soubory, které smí měnit: `static/js/search.js`, `static/css/search.css`,
`tests/e2e/audit/search.mjs`. **Nic jiného.** Zejména ne `frontend/partials/*`
(markup tabů a tlačítek patří vlně 2) a ne `static/js/spotify.js`.

### S1 — taby a psaní do pole nezavřou otevřený detail (vysoká)

Otevři interpreta, klikni na tab „Albums": tab zezelená, stránka interpreta
zůstane, hledání proběhlo **za** překryvem. Jediná cesta ven je „← Back to
results", která pak přistane na Albums. Totéž při psaní nového dotazu — pole je
sticky a pořád viditelné.

Příčina: handler `.type-btn[data-type]` (`search.js:969-976`) a `#searchInput`
(`:940-946`) volají `doSearch()` a nikdo nezavře otevřenou vrstvu detailu.

Oprava: v obou handlerech nejdřív zavřít tu vrstvu, která je vidět
(`closeArtistDetail()` / `closeAlbumDetail()` / `closeShowDetail()` ze
`spotify.js`; importuj, neduplikuj). Pozor na cyklický import — `spotify.js` už
importuje ze `search.js`; použij dynamický `import()` jako jinde v souboru.

Kontrola: otevřít interpreta → kliknout „Albums" → `#artistDetail` je skrytý a
`#searchResults` viditelný s kartami alb. Na starém kódu je to obráceně.

### S2 — nekonečný scroll střílí přes otevřený detail (vysoká)

Na stránce alba čtyři doscrollování vyvolala `/api/search?...&offset=20/40/60/80`
a napekla 73 karet do skrytého `#searchResults`; kostra „načítám další" probliká
mezi taby a hrdinkou.

Příčina: strážce v `search.js:979-986` testuje jen
`store.currentPage === 'search'`, což na detailu interpreta/alba/pořadu pořád
platí (žijí uvnitř `#pageSearch`).

Oprava: přidat podmínku, že `#searchResults` je skutečně vidět.
**Nepoužívat `style.display`** — vrstvy detailu bydlí uvnitř stejné stránky a
`style.display` o skutečné viditelnosti nevypovídá (stejná past jako N1 v celku 3).
Použij `offsetParent !== null`.

Kontrola: na detailu alba 4x doscrollovat na konec, počítat požadavky na
`/api/search` → 0. Na starém kódu 4.

### S3 — karta interpreta píše jeho jméno jako podtitulek (vysoká)

„Daft Punk / Daft Punk". Spotify tam má slovo „Artist".

Příčina: `cardSubHtml` (`search.js:63`) propadne na `return esc(artist)` a u
interpreta je `item.artist === item.name`.

Oprava: pro `type === 'artist'` vracet `'Artist'`.

Kontrola: v tabu Artists žádná karta nemá `.card-sub` shodný s `.card-title`.

### S4 — výpadek providera vypadá jako prázdný výsledek (vysoká)

Dvě podoby. (a) Když spadnou všechny větve agregovaného hledání, napíše to
„No results found" bez možnosti opakovat. (b) Když spadne `/api/genres`, je
**úvodní stránka prázdná bez jediného slova** a do konce sezení se to nezkusí
znovu, protože prázdné pole se uloží do `_genreCache` (`search.js:352-353`) a
`:358` na něj odpoví `innerHTML = ''`.

Oprava: `doSearchAll` čte `data.errors` (backend ho posílá,
`search_providers.py:1161-1182`) a když pokrývá všechny typy, vypíše hlášku
s tlačítkem Zkusit znovu; při částečném výpadku vykreslí dotčenou sekci jako
proužek s chybou místo toho, aby ji vynechal. `renderBrowse` při chybě
**necachuje** (nechá `_genreCache = null`) a vypíše hlášku + Zkusit znovu.

Kontrola: `page.route` podstrčí 502 na `/api/genres` → stránka není prázdná a
obsahuje tlačítko; po odstranění stubu a kliknutí na Zkusit znovu se dlaždice
objeví. Na starém kódu je `#searchResults` prázdný a zůstane prázdný.

### S5 — zpět v žánrovém žebříčku nic nedělá (střední)

`openGenre` (`search.js:392-434`) jako jediná vrstva nezakládá položku historie.
Stisk Zpět se spotřebuje a další už vyskočí z aplikace.

Oprava: `history.pushState({ layer: 'genre' }, '')` v `openGenre`; v routeru
přibude větev, která na tu vrstvu zavolá `renderBrowse()`. **Router patří celku
3** — proto to tady udělej tak, že `openGenre` navěsí vlastní `popstate` handler
na tu jednu vrstvu a při odchodu ho sundá, nebo exportuj `closeGenre()` a napiš
do evidence, že větev v routeru doplní celek 3. Rozhodni a zdůvodni; kritika to
posoudí.

Kontrola: dlaždice → žebříček → `goBack()` → dlaždice jsou zpátky.

### S6 — tab Artists je stěna šedých avatarů a duplicit (střední)

Z deseti výsledků pro „daft punk" je 8 bez obrázku, dva se jmenují stejně a
většina jsou Deezerovy credit-entity („Daft Punk, Pharrell Williams", „Made famous
by Daft Punk"). Agregovaný pohled je slučuje, samostatný tab ne —
`_dedupeByName` (`search.js:793`) volá jen `doSearchAll`.

Oprava: v `doSearch` pro `store.searchType === 'artist'` projet `_dedupeByName`
a zahodit bezobrázkové interprety, jejichž jméno obsahuje čárku.
**Pozor:** filtr nesmí zahodit legitimního interpreta s čárkou v názvu, který
obrázek má. Pravidlo = „bez obrázku **a zároveň** s čárkou".

Kontrola: „daft punk" v tabu Artists → první karta má obrázek, žádné dvě karty
nemají stejný normalizovaný název. Na starém kódu obě tvrzení padají.

### S7 — nesmyslný dotaz vrátí sebevědomě cizí hudbu (střední)

„zzzqqqxyznotathing12345" vrátí plnou stránku skladeb včetně hrdinky. Větev
„No results found" je s fuzzy Deezerem prakticky nedosažitelná.

Oprava: když **žádný** výsledek nesdílí normalizované slovo s dotazem, vypsat nad
výsledky řádek „No results for *dotaz*" a výsledky nechat pod ním jako návrhy.
Normalizace přes existující `_normName`.

Kontrola: nesmyslný dotaz → ten řádek existuje; „daft punk" → neexistuje.

### S8 — „In library" je na řádcích jen slabý rámeček (střední)

Karty dostanou pilulku „IN LIBRARY", řádky ji mají schovanou
(`search.css:218`) a zbyde jen zelený obrys, který vypadá jako výběr.

Oprava: na řádku ukázat malou značku (tečka nebo ✓) v pravém clusteru vedle
délky. Nesmí přibýt šířka na telefonu — viz pravidla pro 390 px níž.

Kontrola: řádek s `.in-library` má viditelný prvek s nenulovou šířkou, který na
starém kódu neexistuje; na 390 px se název skladby nezkracuje víc než předtím.

### S9 — poslední hledání jsou čipy jen při fokusu (střední)

`renderRecentSearches` (`search.js:296-330`) je podmíněné
`document.activeElement === input` a blur je po 150 ms schová. Na telefonu je
tedy vidíš jen s vytaženou klávesnicí. Spotify má recent jako hlavní obsah úvodní
obrazovky.

Oprava: když je pole prázdné, vykreslit seznam **do `#searchResults` nad dlaždice
žánrů**, bez ohledu na fokus, a dát každé položce křížek, který ji smaže.
Čipy při fokusu si nech, nebo je zruš — rozhodni a zdůvodni.
CSS patří do `search.css` (nová pravidla); `.recent-*` dnes bydlí inline
v `frontend/partials/00-head.html`, **na ten nesaháš**.

Kontrola: po `blur()` je seznam pořád vidět; klik na křížek zkrátí seznam o jednu
položku a po reloadu zůstane zkrácený.

### S10 — „1 episodes" (nízká)

`search.js:128`. Jednotné číslo pro 1 u episodes i tracks.

### S11 — pořadí ovládání na řádku (nízká)

Dnes `délka, ⋯, ♡`; Spotify má `♡, délka, ⋯`. `search.js:728-741` — srdce
připoj před element délky.

### S12 — tlačítka hrdinky se umisťují inline pixelovou matematikou (nízká)

`search.js:689-696` přepisuje sdílené CSS (`right = 52/8 + 44*n`) podle
desktopové velikosti hrdinky; na 390 px pak 📻 a ＋ plavou přes obal.
Oprava: přesunout do CSS pravidel `.top-result-card .card-radio-btn` /
`.card-addpl-btn` v `search.css`, aby je mohl mobilní breakpoint přebít.

Kontrola: na 390 px leží obě tlačítka uvnitř spodních 56 px obalu, ne přes jeho
střed. Ověřit i na 1024x768.

### S13 — emoji vedle SVG (nízká)

`cardRadioBtn` (`search.js:28`) je 📻. Nahradit inline SVG ve stylu ostatních
ikon. (Shuffle 🔀 je v partialu → vlna 2.)

### Mimo tenhle celek, ale ze stejného reportu

Hrdinka interpreta a alba (sloupec tlačítek, velikost obalu, rok a délka alba,
`record_type`), „Refresh app" v hlavním chromu, taby přetékající do dvou řádků
(markup v partialu), top výsledek dává přednost jménu interpreta před hitem
(backend) — **vlna 2**.

---

# Celek 2 — Přehrávač a fronta

Soubory: `static/js/player.js`, `static/js/player_v3.js`, `static/js/queue.js`,
`static/js/fullplayer.js`, `static/js/djpanel.js`, `static/css/player.css`,
`frontend/partials/80-player-bar.html`, `frontend/partials/90-full-player.html`,
`frontend/partials/95-panels.html`, `tests/e2e/audit/player.mjs`.
**Nic jiného** — zejména ne `recommendations.js`, `radio.py`, `routers/player.py`.

Pro `claude_test` je aktivní **klasický engine** (`player.js`). Kde `player_v3.js`
nese tutéž vadu, oprav obě a v evidenci to napiš; kde se liší, zdůvodni.

### P1 — s otevřenou frontou nejde pustit, pozastavit ani přeskočit (vysoká)

`elementFromPoint` nad `#playerPlayPause` vrací `queueBackdrop`; Playwright klik
odmítne. Lišta je přitom pod rozostřením **vidět**, takže vypadá živá; každý klik
na ni jen zavře frontu.

Příčina: `.queue-backdrop { inset: 0; z-index: 249 }` (`player.css:166`) proti
`.player-bar { z-index: 99 }` (`player.css:5`).

Oprava: lištu nad backdrop, dokud je fronta otevřená, nebo backdrop odsadit o
výšku lišty. Vyber a zdůvodni; nesmí přitom jít klepnout „skrz" na obsah stránky.

Kontrola: s otevřenou frontou `document.elementFromPoint(stred #playerPlayPause)`
je uvnitř `#playerBar`, klik přehraje/pozastaví a fronta zůstane otevřená.
Všechna tři rozlišení.

### P2 — shuffle lže a Previous je rozbité (vysoká)

Se zapnutým shuffle ukazuje panel fronty jiné pořadí, než co se hraje (řádek 2
„Get Lucky", zahraje „Solar Sailer"). Tři vady v jedné větvi
(`player.js:333-338`, `player_v3.js:1243-1247`):

1. Up Next se nikdy nepřeskládá, takže o dalším kusu tvrdí nepravdu.
2. Výběr je `Math.random()` **s vracením** (vyloučen jen právě hrající index), tedy
   se skladby opakují a set nikdy nedojede.
3. Previous je poziční (`playerIndex--`, `player.js:439-441`,
   `player_v3.js:1498-1500`), ne historický — po čtyřech přeskocích se vrátí jinam,
   než odkud přišel.

Oprava: při zapnutí shuffle postavit **permutaci indexů** (Fisher–Yates), chodit
po ní, panel vykreslovat v ní; každý přehraný index tlačit na zásobník, který
Previous odebírá. Vypnutí shuffle vrací původní pořadí a index na právě hrající
skladbu. Na konci permutace platí `repeatMode` (off = konec, all = nová permutace).

Kontrola: 100 skladeb, shuffle on, 5x Next → pět různých skladeb, každá je ta,
kterou panel v řádku `now-playing` ukazuje; 5x Prev → přesně obrácené pořadí.
Na starém kódu padá už první porovnání.

### P3 — po konci fronty hraje něco, co ve frontě není (vysoká)

Fronta zkrácená na 2 skladby, poslední dohraje → začne hrát „One More Time", ve
frontě není, žádný popisek, a panel dál značí jako hrající tu předchozí
(`queue.js:92` čte `store.playerIndex`, který se u přehrávání doporučení nemění).

Příčina: `_nextTrackInQueue` → `playNextRec()` (`player.js:375-381`,
`player_v3.js:1364-1370`) hraje mimo frontu.

Oprava: doporučenou skladbu **přidat do `store.playerQueue`** a posunout
`playerIndex`, aby fronta nelhala; do `renderQueueInto` přidat oddělovací řádek
„Autoplay", od kterého jsou skladby doplněné automaticky. Do doporučovače
nezasahuj — bereš jen jeho výsledek.

Kontrola: fronta 2 skladby, počkat na konec → hrající skladba je poslední položkou
fronty a `now-playing` značka je na ní; oddělovač existuje.

### P4 — Next na poslední skladbě tiše nic (vysoká)

Pošle `POST /api/player/recommendations` a tím to skončí: stejný `audio.src`,
stejný titulek, čas běží dál. Vyřeš společně s P3 (to samé místo) a doplň, co se
stane, když doporučení nic nevrátí — hláška, ne ticho.

### P5 — shuffle a repeat se po reloadu vypnou (střední)

Fronta se obnoví věrně, obě nastavení ne (`store.js:138-139` jen v paměti, do
ukládané fronty nejdou — `player.js:530-544`).
Oprava: ukládat a obnovovat (mirror do `localStorage` v `toggleShuffle`/
`toggleRepeat`, `fullplayer.js:33-42`, číst v `syncShuffleRepeatUI`).

### P6 — velký přehrávač je průhledný na 99 % (střední)

`player.css:42` — gradient `rgba(…,0.99)` nad průhledným pozadím; za obalem jsou
čitelné výsledky hledání. Dát alfu 1 nebo `background-color: var(--bg)`.
Kontrola: screenshot diff nebo `getComputedStyle` + kontrola, že pod overlayem
není viditelný text (měř na 390 px, tam je to nejhorší).

### P7 — řádky fronty jsou na telefonu uťaté na ~15 znaků (střední)

„Get Lucky …" dvakrát, nerozeznatelné. Řádek nese 36px náhled a pět ovládacích
prvků, na `.qi-info` zbude ~150 px.
Oprava: pod 640 px skrýt `.qi-bpm` a `.qi-remove` (odebrat umí kebab).
**Na 1024x768 to platit nesmí** — tam je místa dost; ověř obojí.

### P8 — gesto „švihni nahoru pro frontu" je ve spodní části mrtvé (střední)

Měřeno po 5 % výšky: funguje jen nad jménem interpreta (0,66) a v posledních
pixelech (0,99); mezi tím ho spolkne strážce
`e.target.closest('button, input, .fp-progress-bar')` (`fullplayer.js:562-563`),
protože tam jsou ovládací tlačítka.
Oprava: z tohohle jednoho handleru vypustit `button` (gesto se stejně potvrdí až
po 40 px svislé dráhy, takže klepnutí neukradne). `input` a `.fp-progress-bar`
nech.
Kontrola: swipe z 0,80 a z 0,90 výšky otevře frontu; krátké klepnutí na
`#fpPlayPause` pořád pauzuje (to je ta regrese, kterou hlídáme).

### P9 — „přidat do playlistu" a „odebrat z playlistu" jsou k nerozeznání (střední)

Plus v rámečku a minus v rámečku vedle sebe, rozliší je jen tooltip, který na
dotyku není. Minus navíc odebere skladbu i z playlistu na Navidrome. Viditelný je
**vždy**, protože `initUpNext()` nastaví `playlistMode` na „Up Next"
(`upnext.js:41-50`) a viditelnost se řídí tím (`player.js:172-183`).
Oprava: jiný glyf + červený hover; v režimu „Up Next" (implicitní fronta) ho
skrýt, protože „odebrat z playlistu" tam pro uživatele nic neznamená.

### P10 — nikde není „Playing from …" (střední)

`.fp-source` je natvrdo „NOW PLAYING" (`partials/90-full-player.html`), jediný
kontextový štítek `#fpPlaylistBadge` je na telefonu neviditelný (bydlí v
`.fp-queue-side`, která je pod 641 px `display:none`).
Oprava: vypsat do `.fp-source` `store.playlistMode.name` (data už v store jsou).

### P11 — z hrající skladby na interpreta se jde přes vyhledávání (střední)

Klepnutí na interpreta vyplní hledání a přepne na tab Artists — mřížka karet,
na kterou musíš klikat znovu. Album přitom jde správně přes `openAlbumByName`
(`fullplayer.js:224`), interpret přes `router.searchFor` (`:215`).
Oprava: sjednotit na `openArtistByName`; přidat podtržení při hoveru na
`#playerArtist`, `#fpArtist`, `#fpTitle`, aby bylo vidět, že to jde klepnout.

### P12 — hrající skladba nemá ⋯ menu (střední)

Každý řádek fronty kebab má, lišta ani velký přehrávač ne — takže „pusť rádio od
týhle skladby" je z přehrávače nedosažitelné.
Oprava: kebab do `.fp-actions` přes `attachContextMenu` s právě hrající položkou.

### P13 — skladbu jde přetáhnout nad právě hrající (nízká)

Přesunutá položka se pak nikdy nepřehraje. Omezit cíl na `> store.playerIndex`
v obou cestách (`queue.js:295-312`, `:335-357`).

### P14 — „Save as playlist" je jen na desktopu (nízká)

`#fpSaveQueue` existuje jen v desktopové hlavičce `.fp-queue-side`; mobilní
panely (`partials/95-panels.html`) mají jen Clear. Ukládání ad-hoc fronty je
přitom typicky telefonní akce. Doplnit do obou a nechat je řídit
`updateSaveButton` (`queue.js:172`).

### P15 — „DJ controls" v klasickém enginu otevře prázdnou zásuvku (nízká)

`refreshDjPanelVisibility` (`djpanel.js:210-230`) tlačítko ukáže vždy; s
`ms_player_engine = classic` je obsah `#fpDjOnlyRows` skrytý a zbude jeden select.
Skrýt tlačítko, když engine není `dj`.

### P16 — BPM odznaky skáčou do špatného slotu (nízká)

`addBpmBadges` je doplní po načtení a část skončí za kebabem místo před srdcem.
Srovnej vkládací bod v řádku fronty.

### P17 — česká hláška v anglickém UI (nízká)

`queue.js:422`: ``Playlist "${name}" už existuje — zvol jiný název``. Přeložit.

---

# Celek 3 — Globální navigace, historie, chrome

Soubory: `static/js/router.js`, `static/js/utils.js`, `static/js/auth.js`,
`static/js/party.js`, `static/js/feedback.js`, `static/js/recognize.js`,
`static/css/responsive.css`, `static/css/login.css`, `static/css/feedback.css`,
`frontend/partials/00-head.html`, `frontend/partials/10-login.html`,
`frontend/partials/63-settings-account.html`,
`frontend/partials/64-settings-admin.html`, `tests/e2e/audit/nav.mjs`.
**Nic jiného** — zejména ne `search.js`, `library.js`, `downloads.js`,
`player*.js`, `queue.js`.

### N1 — Zpět je spolknuté nebo přeskočí úroveň (vysoká)

Dvě změřené podoby:
- Discover → otevřít tag `zouk` → Library → Zpět: **nestane se nic**, nav zůstane
  na Library, jedna položka historie je pryč.
- Search → interpret → Settings → Zpět: přistane na Search a detail interpreta je
  zahozený (dvě úrovně jedním stiskem).

Příčina: `handlePopstate` (`router.js:144-150`) se rozhoduje podle
`element.style.display`, ne podle toho, jestli je prvek na obrazovce — prvek
označený jako viditelný uvnitř skryté `<main>` pořád čte `!== 'none'`.
`switchPage` (`router.js:76-86`) resetuje jen `#showDetail`, `#libraryDetail`,
`#likedSongsDetail`; `#tagDetailView`, `#artistDetail`, `#albumDetail`,
`#playlistDetail`, `#podcastEpisodes` zůstanou označené jako viditelné.

Oprava: strážce přepsat na `offsetParent !== null` (je nepravdivý, jakmile je
předek skrytý, takže se to samo udržuje). Zvaž, jestli navíc v `switchPage`
nezhasnout známé vrstvy — pokud ano, zdůvodni, proč obojí.

Kontrola: obě sekvence výš; po Zpět je na obrazovce ta stránka, ze které se šlo,
a `history.state` s ní souhlasí. Obě padají na starém kódu.

### N2 — modály nezakládají historii a nikdy nevyřeší svůj Promise (vysoká)

`showPlaylistPicker`, `showInputModal`, `showPlaylistFormModal`,
`showConfirmModal` (`utils.js`) a modál zpětné vazby (`feedback.js`) staví
překryv bez `pushState`. Zpět je zavře **a zároveň posune historii o stránku** —
změřeno: `{page:'library'}` → `{page:'search'}`, zatímco obrazovka dál ukazuje
Library. Druhá, tišší vada na stejném místě: `router.js:138-139` dělá
`epDialog.remove()`, čímž zahodí DOM, ale **nevyřeší Promise** — volající
`await showPlaylistPicker(...)` visí navždy.

Oprava: každému z těch modálů `history.pushState({ layer: 'dialog' }, '')` při
otevření a `historyBack()` při zavření (stejný kontrakt, jaký už má `openPanel`);
větev v popstate ať volá **vlastní cancel cestu modálu**, která Promise vyřeší,
ne `remove()`.

Kontrola: otevřít „New playlist", Zpět → překryv pryč **a** `history.state` i
obrazovka pořád Library; `await` se vyřeší (zjistitelné tak, že navazující kód
proběhne). Na starém kódu se stav rozejde.

### N3 — na telefonu se nedá odhlásit a není vidět, kdo je přihlášený (vysoká)

Pod 640 px je celá horní lišta `display:none` (`responsive.css:30`) i s
`#logoutBtn` a `#navUsername` (`partials/20-nav.html`). Jediná cesta ven je
**„Clear All & Logout"** v Nastavení → App, tedy destruktivní reset vedle tlačítka
Refresh. Hledání řetězce `claude_test` v DOM ho najde jen v `#navUsername`
o šířce 0.

Oprava: v Nastavení sekce **Account** se jménem účtu a prostým **Log out**
navázaným na stávající `logout()` (`auth.js:45`). „Clear All & Logout" zůstává
jako jaderná varianta. Sekce `#settings-account` dnes obsahuje jen Spotify —
přejmenuj ji na Spotify a Account založ vedle (`partials/63-settings-account.html`).

Kontrola: na 390 px existuje viditelné tlačítko s textem „Log out" a prvek
s uživatelským jménem; klik odhlásí (objeví se `#loginScreen`). Ověřit i na
1024x768 (tam je horní lišta vidět — nesmí tam vzniknout dvě odhlašovací tlačítka
vedle sebe, nebo to zdůvodni).

### N4 — Party ignoruje Zpět (střední)

Překryv na celou obrazovku, hardwarové Zpět nedělá nic, ven jen křížkem
(`party.js` `openParty()` bez `pushState`; router pro něj nemá větev, takže
anti-exit pojistka `router.js:152-155` stisk spolkne).
Oprava: `pushState` + `historyBack()` + větev v `handlePopstate` **nad** catch-all
na `.modal-overlay`.

### N5 — toast překrývá spodní navigaci (střední)

Geometrie je inline `bottom:80px` (`utils.js:88`), což předchází spodní liště
(72 px) i liště přehrávače (68 px). Změřeno na 390 px: toast 726–764, nav od 705.
Oprava: do CSS a v mobilním breakpointu
`bottom: calc(var(--bottom-nav-height) + 16px)`, s přehrávačem o 68 px víc —
stejný vzor, jaký už má `feedback.css:30-39`.
Kontrola na všech třech rozlišeních; na 1024x768 spodní nav není, takže se toast
nesmí posunout zbytečně vysoko.

### N6 — potvrzovací dialog má fokus na „Delete" a Enter ho potvrdí (střední)

`utils.js:379` fokusuje `.confirm-ok`, `:373` mapuje Enter na `done(true)`.
U mazání playlistu bez undo.
Oprava: u `danger` fokusovat Cancel a Enter buď zrušit, nebo mapovat na
`done(false)`. Pořadí tlačítek je v pořádku, neměň ho.

### N7 — každý obal v Discoveru je šedá hvězda Last.fm (vysoká)

Celá stránka tagu je mřížka identických šedých dlaždic s bílou hvězdou — vypadá
to, že se nenačetla. Jde o univerzální placeholder Last.fm
(`…/2a96cbd8b46e442fc41c2b86b821562f.png`), který `_pick_image`
(`app/services/lastfm.py:39-44`) vrací jako platnou adresu, takže se nikdy
neuplatní vlastní (hezčí) prázdný stav karty.

Oprava: v `_pick_image` vracet `""`, když adresa obsahuje ten hash.
**Tohle je jediný backendový soubor téhle dávky** a patří celku 3. Napiš k němu
pytest test (`tests/test_lastfm_image.py`): placeholder → `""`, skutečný obal →
beze změny, prázdný seznam → `""`. Mutace: odstranit podmínku → test musí
zčervenat; obrátit ji → zčervenat.

Kontrola v prohlížeči: na stránce tagu `zouk` není `src` žádné karty roven
placeholder adrese.

### N8 — stránka se hlásí jako česká (nízká)

`<html lang="cs">` (`partials/00-head.html`) na jinak anglickém UI — špatné
dělení slov, špatný hlas čtečky, špatný slovník kontroly pravopisu. Změnit na
`en` a přeložit tři administrátorské tooltipy
(`partials/64-settings-admin.html`). Hlášku v `queue.js` řeší celek 2.

### N9 — přihlašovací obrazovka (nízká)

Bez autofokusu (po načtení je `document.activeElement` prázdný), bez zmínky, že
sezení drží 30 dní, bez názvu instance. `autoFocus` už existuje a používá se na
`#searchInput` po přihlášení (`auth.js:194`).
Oprava: `autoFocus($('#loginUser'))` na konci `auth.js init()`, když není token,
plus jednořádkový podtitulek s názvem instance.
Chybová hláška je správná a neúnosná — **neměnit**.

### N10 — chyby mikrofonu ukazují syrové hlášky prohlížeče (nízká)

`recognize.js` posílá `e.message` rovnou do `micLog()`.
Mapovat `NotAllowedError` → „Microphone blocked — allow it in your browser's site
settings", `NotFoundError` → „No microphone found", jinak původní hláška.
Serverové chyby rozpoznávání (`classifyRecognizeError`, `recognize.js:86-93`) mají
dobré texty — **neměnit**.

### N11 — Party: „Save to playlist" vypadá aktivně, i když je zakázané (nízká)

`party.js:350` dává inline zelené pozadí a `disabled` zároveň; `:disabled` se
inline stylem napsat nedá, takže vizuálně nic. Pravidlo do CSS.

### N12 — titulek modálu zpětné vazby neposlouchá vlastní přepínač (nízká)

Zůstane „Report a bug", i když přepneš na Feature. Zbytek modálu je dobrý —
neměň ho.

### N13 — plovoucí tlačítko zpětné vazby je bledé a leží na obsahu (nízká)

`feedback.css:15` má `opacity:.55`; překrývá prázdný stav knihovny a kartu na
stránce tagu. Zvednout klidovou průhlednost nebo tlačítko odsadit, když obsah
sahá až k němu.

### Mimo tenhle celek

Hluboké odkazy (URL/hash routing), „Downloads se v navigaci nepodbarví" (sahá na
`downloads.js`), sjednocení popisků Zpět (partialy vlny 2), dvě konkurenční
„procházení podle žánru", „Discover by Genre" vrací neštítkové tagy, domovská
stránka / „For You" — **vlna 2 nebo samostatná dávka**.

---

## Co se po dávce musí objevit v dokumentaci

- `docs/` — změněné chování: nové chování Zpět, kontrakt modálů (pushState +
  cancel cesta), permutace shuffle a historie Previous, co znamená oddělovač
  Autoplay ve frontě, nová sekce Account v Nastavení.
- `CLAUDE.md` / `docs/architecture.md` — nové místo pravdy pro viditelnost vrstev
  (`offsetParent`, ne `style.display`) a pravidlo „každý nový překryv zakládá
  vrstvu historie a vyřeší svůj Promise". To je past, na kterou tahle dávka
  narazila třikrát.

## Přejímka (po merge a nasazení)

Proti běžící instanci, účtem `claude_test`, ve **všech třech rozlišeních**
(390x844, 1024x768, 1280x900), se sledováním sítě a snímky. Rozpočet placených
volání: žádná — všechno jsou volání vlastního backendu a Deezeru zdarma.
Každý bod výš má v reportu `prejimka-4.md` řádek s důkazem (hodnota z DOM, počet
požadavků, snímek), nebo poznámku „neprovokováno" s důvodem.
