# Oprava 5 / celek 4 — detail interpreta a alba

Worktree: `/home/lucas/music-seeker-wt/oprava-5-c4-detail`, vychází z `b1f6078` (1.26.0,
tedy po nasazené vlně 1). Necommitováno, nenasazováno.

Podklady v pořadí přednosti: `oprava-5-dodatek-po-kritice.md`, `oprava-5-zadani.md`,
`audit-2026-10/*.md`.

## Změněné soubory

| soubor | proč |
|---|---|
| `static/css/pages.css` | D1 — tvar sdílené hrdinky, velikost obalu, `.hero-ico` |
| `frontend/partials/30-search.html` | D3, D4, D7, D8, D9, D11 — markup |
| `static/js/spotify.js` | D2, D3, D4, D5, D8 — chování |
| `static/index.html` | **generovaný**; přepsán `scripts/build-index.sh`, `check-index.sh` prochází |
| `tests/e2e/audit/detail.mjs` | kontroly (nový soubor) |
| `docs/architecture.md` | dvě nové sekce ke změněnému chování |

## Orákulum

`tests/e2e/audit/detail.mjs`, tři rozlišení (`phone` 390x844, `tablet` 1024x768,
`desktop` 1280x900), účet `claude_test`, `ms_device_id` `e2e-autor-5-c4-*`.

Obě poloviny jedou přes sdílený postroj `tests/e2e/audit/helpers.mjs`:

* **červená** — `open()` bez worktree: nasazená produkce 1.26.0,
* **zelená** — `open({ worktree: … })`: postroj naservíruje skutečné soubory z tohohle
  stromu včetně `index.html` a doplní cache-bust razítko.

Žádný `page.addInitScript` ani `page.evaluate` s náhradou měřeného kódu. Jediné, co se
podstrkává, jsou **odpovědi serveru** (`page.route` na `/api/...`): zdržení, aby šel
změřit stav „požadavek ještě běží", a jeden seznam sledovaných interpretů (viz MEZ 2).

Surové běhy: `scratchpad/autor-5-c4/run-desktop2.out`, `run-tablet2.out`,
`run-phone2.out`, mutace `run-mutace.out`.

### Že zelená měří tenhle kód, ne postroj

Tři mutace do kopie stromu (`scratchpad/autor-5-c4/mutace/`), spuštěno přes
`MS_TREE=… node tests/e2e/audit/detail.mjs desktop D1 D4 D8` — všechny tři zčervenaly:

| mutace | padlo |
|---|---|
| `.playlist-hero-actions` zpět na `flex-direction: column` | D1-zelena (`info 661 column obal 180`) |
| `_isFullAlbum` vrací vždy `true` | D4-zelena („Albums" 39 + „" 0) |
| vypuštěné volání `_dressRadioButton()` | D8-zelena (`radio {"text":"📻 Radio","svg":false}`) |

## Bod → řádek → kontrola

### D1 — hrdinka je sloupec tlačítek vedle náhledu 100x100

* `static/css/pages.css:90-122` — `.playlist-hero { align-items: flex-end; flex-wrap: wrap }`,
  `.playlist-hero-actions { flex-direction: row; flex-wrap: wrap; flex-basis: 100%; flex-shrink: 1 }`,
  obal 180 px **jen** pod `@media (min-width: 641px)`.
* Kontrola `D1` (tablet, desktop) měří **všechny čtyři hrdinky** — interpreta, album,
  playlist z vyhledávání i knihovní playlist (fixtura `zz-audit-fixture`) — a žádá
  `scrollWidth <= clientWidth` na dokumentu i hrdince, `.playlist-hero-info > 120 px`,
  `flex-direction` akcí `row` a obal `180`.

| | produkce (červená) | worktree (zelená) |
|---|---|---|
| desktop | info 741/776/773/794, **column**, obal **100** | info 894 všude, **row**, obal **180**, přetok 0 |
| tablet | info 565/600/597/618, **column**, obal **100** | info 718 všude, **row**, obal **180**, přetok 0 |

* **Knihovní playlist zezelenal hned, bez K8.** Dodatek čekal, že sedm tlačítek zůstane
  červených až do celku 5; změřeno `doc+0 hero+0 info 894 row obal 180` na desktopu
  i `718` na tabletu. Důvod: akce mají vlastní řádek a samy se zalamují, takže sedmé
  tlačítko spadne pod ostatní místo aby roztáhlo hrdinku. Vedení to při merge nemusí
  hlídat jako podmíněné.
* `D1-telefon` je **stráž, ne orákulum** (`red: false`): telefon dělal správnou věc už
  před dávkou, takže proti produkci není co zčervenat. Měří, že obal zůstal **100 px**
  (past z dodatku: 329 → 409) a že nic nepřetéká: `doc+0 hero+0 … obal 100` na všech
  čtyřech hrdinkách.
* Přetok sám o sobě červenou nedělá — produkce 1.26.0 nepřetéká v žádném ze tří
  rozlišení (`doc+0 hero+0` všude). Číslo 1027/1167 z dodatku je měření *naivní* varianty
  (řada na místě sloupce), ne nasazeného stavu. V kontrole proto přetok drží jako
  podmínka vedle `row` a `180`, které rozhodují.

### D2 — hrdinka interpreta je vteřiny prázdná

* `static/js/spotify.js:480-500` — `loadArtistDetail(id, fromPage, opts)`, kde
  třetí argument je řetězec s providerem **nebo** `{ provider, name, image }` (týž tvar,
  jaký už bere `loadPlaylistDetail`). Jméno a obrázek se vykreslí **před** fetchem.
  **OPRAVENO V DRUHÉM KOLE.** Tady původně stálo „starší dvou- a tříargumentoví
  volající se chovají jako dřív". **To nebyla pravda** — vykreslení běželo bezpodmínečně,
  takže třem volajícím s řetězcem (`search.js:106`, `contextmenu.js:639`,
  `fullplayer.js:256`) se hrdinka **vyprazdňovala**. Platí to až od druhého kola, kde se
  píše jen to, co volající poslal. Viz sekce „Druhé kolo", bod R4.1.
* `static/js/spotify.js:184` — `searchForArtistDetail` předává `name` a `image` z odpovědi
  `/api/search`, kterou už drží v ruce.
* Kontrola zdrží `/api/artist/*/albums*` o 8 s a odečítá hrdinku, dokud seznam alb ještě
  běží. Jede na **jiném interpretovi** (Queen) než zbytek souboru a žádá přesnou shodu
  jména: pouhé „není prázdné" by na produkci prošlo na jménu, které v hrdince zbylo po
  předchozím bodu — na to se kontrola při prvním běhu chytila.
* červená: `jméno "Daft Punk" (čekáno "Queen"), alba ještě běží: true` ·
  zelená: `jméno "Queen", src "https://cdn-images.dzcdn.net/images/arti…"`.
* **Zbylí tři volající jsou samostatný bod pro vedení** (dodatek, sekce C): `favorites.js`
  a `contextmenu.js:639` patří celku 5, `search.js:106` (`_routeCardClick`) vlně 1.
  Dokud je nikdo nedoplní, chová se jejich cesta přesně jako dnes — **což od prvního kola
  neplatilo a od druhého zase platí**; doloženo kontrolou `D2-retezec`.

### D3 — Play naskočí pozdě a posune sloupec; chybí Shuffle

* `frontend/partials/30-search.html:76-77` — `#playArtistTop` je vykreslené od začátku
  a jen `disabled` (dřív `display:none`), vedle něj nové `#shuffleArtistTop`.
* `static/js/spotify.js:582-590` — `_renderArtistTop` přepíná `disabled`, ne `display`.
* `static/js/spotify.js:624-641` — `initArtistTopPlay` věší i Shuffle; promíchání jede
  přes `_shuffled()` (`:193-201`), což je jedna kopie Fisher-Yatese místo tří — album,
  playlist i interpret ji teď sdílejí.
* Kontrola zdrží `/api/artist/*/top*` o 9 s a odečítá dvakrát: během čekání a po něm.
  červená: `během {"play":{"vidi":false,…},"shuffle":null}` ·
  zelená: `během {"play":{"vidi":true,"zakazane":true},"shuffle":{"vidi":true,"zakazane":true}}`,
  `potom` obě povolená.
* Zdůvodnění podle dodatku: **stabilní rozměr hrdinky**, ne vnímané zpoždění (169 ms).

### D4 — diskografie je 39 nerozlišených dlaždic

* `static/js/spotify.js:434-468` — `_isFullAlbum` (`record_type === "album"`), `_albumKind`
  pro podtitulek, `_albumCard`.
* `frontend/partials/30-search.html:86-87` — druhá hlavička a druhá mřížka
  (`#artistSinglesHeader`, `#artistSingles`).
* `static/js/spotify.js:513-567` — jedna mřížka se rozpadla na dvě, ale **`data-album-idx`
  pořád indexuje `store.currentArtistAlbums`**, takže klik, kontextové menu i stahování
  zůstaly beze změny. `checkLibrary` dostává seznam karet explicitně — sama si ho hledá
  v jednom kontejneru a při dvou mřížkách by přiřadila odznaky vedle.
* Mapování je podle dodatku: `album` → Albums, **cokoli jiného včetně prázdna** →
  Singles and EPs — **ale až po druhém kole jen tam, kde odpověď druh vydání vůbec
  nese**; „natvrdo", jak tu původně stálo, rozbíjelo iTunes. Viz „Druhé kolo", bod R4.2. Do podtitulku **nikdy `total_tracks`** (u tohohle endpointu vždy 0);
  typ se jmenuje, jen když ho odpověď poslala.
* červená: `"Albums" 39 + "" 0`, podtitulky `["2013","2013"]` ·
  zelená: `"Albums" 15 + "Singles and EPs" 24`, podtitulky `["2013 · Album","2001 · Album"]`
  a `["2013 · Single","2000 · Single"]`. **15 + 24 sedí na očekávání z dodatku.**

### D5 — hlavička alba nemá rok ani délku

* `static/js/spotify.js:665-686` — `_albumRuntime` a `_albumMetaLine`.
* `static/js/spotify.js:712` — `#albumDetailCount` nese celý řádek.
* Součet se zobrazí **jen když má `duration_ms > 0` každá skladba** (dodatek: iTunes
  a podcastové cesty vracejí 0, součet nad nimi by album tiše zkrátil). Kontrola to měří
  z obou stran: vedle řádku čte i to, že v seznamu nechybí žádná délka.
* červená: `"13 tracks"` · zelená: `"Album · 2013 · 13 songs, 1 hr 14 min"`, 13 délek,
  všechny vyplněné.

### D6 — ŠKRTNUTO

Dodatek, sekce A: pruh na produkci není (`bpmFilter.present = false` ve všech třech
rozlišeních) a uvedená příčina je vyvrácená kódem. Nic se nedělalo.

### D7 — dvě soupeřící primární tlačítka na hrdince alba

* `frontend/partials/30-search.html:103` — `#downloadAlbum` dostal `btn-hero-secondary`
  a ztratil vlastní `style`, který tu třídu duplikoval.
* červená: `play rgb(162,230,64), add all rgb(28,28,46), download rgb(162,230,64)` ·
  zelená: `download rgb(28,28,46)`, tedy shodné s „+ Add All" a různé od „Play All".

### D8 — emoji 🔀 a 📻 na hrdince

* `frontend/partials/30-search.html:100` a `:77` — `#shuffleAlbum` i nové
  `#shuffleArtistTop` mají inline SVG, **tutéž značku, jakou používá přehrávačová lišta**
  (`80-player-bar.html:25`), ne nově vymyšlenou.
* `static/js/spotify.js:469-477` — `_dressRadioButton()`, volané z `loadArtistDetail`.
* **Rozpor se zadáním:** dodatek čekal `#radioArtist` v partialu („tentýž soubor"). Není
  tam — vkládá ho `radio.js:88`, což **není** přidělený soubor tohohle celku. Výměna se
  proto dělá ze `spotify.js`, tedy na stránce, která hrdinku vlastní, a vedle popisky
  `#followArtist`, kterou tenhle soubor už dnes udržuje (`updateFollowButton`). Funkce je
  idempotentní (vrací se, když už tlačítko SVG má). Posluchač z `radio.js:92` visí na
  **tlačítku**, ne na jeho obsahu, takže přepis `innerHTML` ho neodpojí — stejně jako ho
  dnes neodpojuje `updateFollowButton`. Kliknutí se neprovokovalo: spustilo by rádio
  a založilo dočasný playlist `__radio_` na produkci.
* červená: `shuffle {"text":"🔀 Shuffle","svg":false} · radio {"text":"📻 Radio","svg":false}` ·
  zelená: `shuffle {"text":"Shuffle","svg":true} · radio {"text":"Radio","svg":true}`.

### D9 — „Refresh app" pryč z hlavního chromu

* `frontend/partials/30-search.html` — `#appRefreshBtn` **jen odstraněn**, nikam
  nepřesunut (dodatek: dvojník `#refreshCacheBtn` už existuje a bydlí v
  `63-settings-account.html`, což je soubor vlny 1). `#micBtn` dostal `aria-label`.
* Do `search.js` se nesahalo. Handler se váže přes `$('#appRefreshBtn')`, takže po
  odstranění prvku tiše nic nenaváže — **vedení ať to při merge s celkem 1 vlny 1
  zkontroluje**, protože ten soubor patří jiné dávce.
* Kontrola jede na telefonu i desktopu a ověřuje i to, že dvojník v Nastavení existuje.
  červená: `#appRefreshBtn true, aria "", kulatých 3` ·
  zelená: `#appRefreshBtn false, aria "Identify song with microphone", kulatých 2,
  dvojník v Nastavení true`.

### D10 — taby přetékají na telefonu do dvou řádků — NEDĚLÁ SE TADY

Zadání: „pokud to jde udělat jen v CSS, nech to vlně 1 a sem napiš poznámku." Jde.
`.type-toggle` má `flex-wrap: wrap` v `static/css/search.css:70-72`, což je **soubor
celku 1 vlny 1**; markup `.type-toggle` měnit netřeba. Změřeno na telefonu nad tímhle
stromem: `řádků 2, výška 74 px, flex-wrap wrap`. Kontrola `D10` je v souboru jako
**měření** (`red: false` + `greenSkip`), aby číslo nezmizelo, ale nevydává se za opravu.

### D11 — popisky zpět nejsou jednotné

* `frontend/partials/30-search.html:52, 68` — `#backToSearch` a `#backFromArtist` z
  „← Back to results" na **„← Back"**, `#backFromAlbum` ho měl už dřív.
* Sjednoceno na „← Back", protože „Back to results" je u obou **nepravda**, kdykoli se
  detail otevřel z Knihovny: `closeArtistDetail` se vrací na `store.artistDetailSource`,
  který bývá `'playlists'`.
* „← Back to Podcasts" a „← Browse all" leží v partialech, které tenhle celek nevlastní.
* červená: `["← Back to results","← Back to results","← Back"]` ·
  zelená: `["← Back","← Back","← Back"]`.

## Přiznané meze

1. **D1-telefon a D10 nemají červenou polovinu.** U D1-telefon proto, že telefon dělal
   správnou věc už před dávkou (není co zčervenat) — je to stráž proti regresi, ne
   orákulum. U D10 proto, že se tady neopravuje. Obojí je v souboru označené `red: false`.
2. **D2 jede na podstrčené odpovědi `/api/spotify/artists`.** Jediný volající, kterého
   tenhle celek vlastní, je `searchForArtistDetail`, a ten se dá vyvolat jen kliknutím na
   kartu v Knihovna → Spotify → Artists. Spotify API je pro tenhle účet mrtvé (403 bez
   Premium), záložka hlásí „Failed to load artists". Podstrčí se tedy **vstup**
   (jeden interpret v seznamu); `searchForArtistDetail`, `/api/search`, `loadArtistDetail`
   i vykreslení hrdinky jsou skutečný kód té které poloviny.
3. **Hover a skutečné přehrání se neměří.** Kontrola tvrdí jen to, že Shuffle existuje,
   je vidět a je povolené/zakázané ve správný okamžik; že po kliknutí **skutečně zahraje
   promíchaně**, dokázané není — šlo by to jen spuštěním přehrávání, a to patří přejímce.
   `_shuffled()` je ale tatáž funkce, kterou po přepisu používá i album a playlist.
4. **`.hero-ico` se neověřuje opticky**, jen tím, že v tlačítku je `<svg>` a není tam
   emoji. Svislé usazení ikony je posouzené ze snímků
   (`scratchpad/autor-5-c4/shots/artist-desktop-wt.png`, `albumtop-desktop-wt.png`),
   ne změřené.
5. **Dlaždice Liked Songs v Knihovně** má místo obrázku `<div class="playlist-hero-img">`
   se srdcem `font-size: 48px`. Zvětšení obalu na 180 px se jí týká taky (srdce zůstane
   48px uprostřed většího čtverce). Markup je v `50-library.html`, tedy **celek 5** —
   nesaháno, jen hlášeno.
6. **`static/index.html` je v diffu**, i když není v přidělených souborech. Je generovaný;
   přepsal ho `scripts/build-index.sh` a `scripts/check-index.sh` prochází.
7. **`CLAUDE.md` neupraveno** (zadání, „Dokumentace po dávce", chce do něj past „hrdinka
   je sdílená čtyřmi stránkami"). Není v přidělených souborech a je v `.gitignore`.
   Obsah té pasti je napsaný v `docs/architecture.md`, sekce „One hero, four pages" —
   **vedení ať ho odtud do `CLAUDE.md` přenese.**

## Co jinak a proč

* **D1 nedostal `flex-shrink: 1` samotný ani prosté povýšení mobilního pravidla.** Obojí
  dodatek vyvrátil měřením; použit je nařízený tvar (zalomení + `flex-basis: 100%`).
  `responsive.css` se vůbec neotevřel — proto je obal 180 px pod `@media (min-width: 641px)`.
* **D2 nerozšiřuje signaturu na čtvrtý argument**, ale nechává třetí přijmout řetězec
  i objekt. Je to týž idiom, jaký `loadPlaylistDetail` používá od vlny 1, takže ostatní
  tři volající (dva z nich jiné celky) nemusí počítat argumenty.
* **D4 nerenderuje hlavičky dovnitř `#artistAlbums`.** Ta mřížka je `display: grid`;
  nadpis uvnitř by byl další buňka. Druhá hlavička a druhá mřížka jsou proto vedle sebe
  v partialu.
* **Podtitulek nepojmenuje neznámý typ.** `record_type` chodí i prázdný; napsat u něj
  „Single" by znamenalo tvrdit něco, co odpověď neřekla. Do skupiny Singles and EPs
  takový záznam spadne (podle dodatku), ale v podtitulku zůstane jen rok.
* **Tři kopie Fisher-Yatese se slily do `_shuffled()`.** Nebyla to nová abstrakce kvůli
  jednomu místu — Shuffle k interpretovi by byl čtvrtý opis téhož.
* **D8 u `#radioArtist` se dělá ze `spotify.js`**, ne z partialu, protože tam to tlačítko
  není (viz D8 výš).
* **D11 sjednotil na „← Back", ne na „← Back to results".** Delší tvar je u dvou ze tří
  cest nepravdivý.

## Sada

```
python3 -m pytest tests/ -q      → 82 passed, 3 skipped   (rc 0)
node --test tests/js/bpm_client.test.mjs → fail 0        (rc 0)
scripts/build-index.sh && scripts/check-index.sh         (rc 0)
node tests/e2e/audit/detail.mjs desktop → 18 prošlo, 0 padlo, 2 přeskočeno (rc 0)
node tests/e2e/audit/detail.mjs tablet  →  2 prošlo, 0 padlo, 10 přeskočeno (rc 0)
node tests/e2e/audit/detail.mjs phone   →  3 prošlo, 0 padlo, 9 přeskočeno (rc 0)
```

Na produkci se jen četlo: žádné stahování, mazání ani změna nastavení, modál zpětné
vazby neodeslán, kontextové menu se neotvíralo.

---

# Druhé kolo

Podklad: `notes/impl/oprava-5-dodatek-po-review.md`, sekce C (nálezy R4.1 a R4.2).
Kód prvního kola je zamrazený v `scratchpad/autor2-5-c4/kolo1/` a slouží jako padající
polovina orákula. Necommitováno, nenasazováno. Účet `claude_test`, `ms_device_id`
`e2e-autor2-5-c4-*`, na produkci se jen četlo.

## Jak vypadá orákulum u opravy regrese

Oba nálezy druhého kola jsou **regrese prvního kola**, ne vady produkce. Produkce se u
nich chová správně, takže ji nejde vydávat za červenou polovinu — kontrola, která by měla
„padat proti produkci", by u nich byla nesmysl. Orákulum má proto tři polohy:

| polovina | co běží | co se čeká |
|---|---|---|
| `-produkce` | nasazená 1.26.0 | **PROJDE** (`red: 'projde'` v `detail.mjs`) |
| strom prvního kola | `MS_TREE=…/scratchpad/autor2-5-c4/kolo1` | **PADÁ** |
| `-zelena` | tenhle strom | **PROJDE** |

Tvrzení „produkce je na téhle cestě lepší než první kolo" tím není napsané, ale **změřené
z obou stran**. Spuštění první a třetí polohy je v `detail.mjs`; druhá se pouští zvlášť
přes `MS_TREE` (výpisy níž).

## R4.1 — hrdinka se u volajícího s řetězcem vyprazdňovala

**Co bylo špatně.** `setArt(…, o.image || '')` a `textContent = o.name || ''` běžely
bezpodmínečně. Tři ze čtyř volajících posílají třetí argument jako řetězec, a
`search.js:106` (`_routeCardClick`) je **všední cesta** — klik na kartu interpreta ve
výsledcích hledání. Těm `o.name` i `o.image` chybí, takže se hrdinka na dobu požadavku
vymazala; nasazená verze tam přitom nechávala jméno, obal i počet alb předchozího
interpreta.

**Oprava.** `static/js/spotify.js:515-517` — píše se jen to, co volající poslal:

```js
if (o.image !== undefined) setArt($('#artistDetailImg'), o.image);
if (o.name !== undefined) $('#artistDetailName').textContent = o.name;
if (o.name !== undefined || o.image !== undefined) $('#artistDetailCount').textContent = '';
```

Třetí řádek je nutný a není v zadání: kdyby se počet alb nemazal **nikdy**, hrdinka
přemalovaná na „Queen" by pod sebou nesla „39 albums" po Daft Punkovi. Maže se tedy
přesně tehdy, když se něco přemalovalo. Volající s řetězcem nesahá na žádný ze tří prvků,
tedy přesně chování produkce.

**Kontrola `D2-retezec`** (`tests/e2e/audit/detail.mjs`), telefon 390x844 — všechny tři
věci, které review žádalo, jsou v ní naráz: **pomalá síť** (`+5 s` na `**/api/artist/**`),
**druhý otevřený interpret** (Daft Punk → Queen) a **volající, který posílá řetězec**
(klik na kartu ve výsledcích hledání, tedy `search.js:106`). Odečítá se 1,5 s po kliknutí
a vedle jména se čte i počet alb, obrázek a to, že požadavek na alba **opravdu ještě
běží**. Kontrola navíc žádá, aby se kliklo na **jiného** interpreta, než který je
v hrdince — jinak by „zůstalo jméno" nedokazovalo nic.

| poloha | naměřeno |
|---|---|
| produkce | PASS — kliknuto „Queen"; během `{jmeno:"Daft Punk", pocet:"39 albums", obrazek:"https://cdn-images.dzcdn.net/images/arti", cekaSeNaAlba:true}` |
| první kolo (`kolo1`) | **FAIL** — `{jmeno:"", pocet:"", obrazek:"", cekaSeNaAlba:true}` |
| tenhle strom | PASS — shodné s produkcí |

Výpisy: `scratchpad/autor2-5-c4/run-phone-final.out` (produkce i zelená),
`run-d2retezec-kolo1.out` (první kolo).

## R4.2 — u providera bez `record_type` mizela celá sekce Albums

**Co bylo špatně.** `_isFullAlbum` žádá `record_type == "album"`, jenže klíč skládá
**jediný** mapper: `grep -n record_type app/services/search_providers.py` → `115`, Deezer.
iTunes, YouTube Music ani Spotify ho neposílají. Uživatel s Apple Music tedy dostal
prázdnou hlavičku „Albums" a celou diskografii pod „Singles and EPs". Netýká se to jen
vědomé volby zdroje: `_DEFAULT_FALLBACK["deezer"] == "ytmusic"`.

**Oprava.** `static/js/spotify.js:442-452` + `:544-546` — nová `_splitsByKind(albums)`
(nese druh **aspoň jedno** vydání?) a dělení jen tehdy, když vrátí `true`; jinak všechno
do první mřížky pod „Albums" a druhá hlavička skrytá. Dělení tak zůstává tam, kde zdroj
druh vydání skutečně publikuje, a jinde se stránka chová jako před dávkou.

Mimochodem při tom vyšla najevo druhá, menší vada ze stejného místa: render schovává
prázdnou mřížku (`display:none`) a to na elementu **zůstane**, takže dalšímu interpretovi
by se skeletony načítaly neviditelně. `:523-525` to při psaní skeletonů vrací zpět.

**Kontrola `D4-itunes`**, desktop 1280x900. Tělo odpovědi není vymyšlené: stáhne ho **sama
přihlášená stránka** z nasazeného backendu (`/api/artist/{itunes_id}/albums?provider=itunes`,
id z téhož veřejného iTunes lookupu, jaký používá backend) a teprve to se podstrčí jako
**vstup** přes `page.route`. Měřený kód je na všech polohách ten pravý. Kontrola si navíc
ověřuje svůj vlastní předpoklad — že v té odpovědi `record_type` opravdu nikde není —
takže kdyby ho iTunes začalo posílat, nebude se tvářit, že něco dokázala.

| poloha | naměřeno |
|---|---|
| produkce | PASS — odpověď 96 alb, `record_type` u žádného; stránka „Albums" 96 + druhá hlavička nevidět / 0 karet |
| první kolo (`kolo1`) | **FAIL** — „" 0 + druhá hlavička vidět / **96 karet** |
| tenhle strom | PASS — „Albums" 96, druhá hlavička nevidět, 0 singlů |

96 alb sedí na číslo z review. Výpisy: `scratchpad/autor2-5-c4/run-d4-final.out`
(produkce i zelená), `run-d4itunes-kolo1.out` (první kolo).

## Že zelená měří tenhle kód (cílené mutace)

`kolo1` mění obě věty naráz. Aby bylo vidět, že se **každá** kontrola chytá své vlastní
věty a ne té druhé, běžely ještě dvě jednořádkové mutace do kopie stromu
(`scratchpad/autor2-5-c4/mutace/`):

| mutace | zčervenalo | zůstalo zelené |
|---|---|---|
| **A** — `_splitsByKind` vrací vždy `true` | `D4-itunes-zelena` (`"" 0 + 96 karet`) | `D4-zelena` (Deezer: Albums 15 + Singles and EPs 24) |
| **B** — hrdinka se zase kreslí bezpodmínečně | `D2-retezec-zelena` (`{jmeno:"", pocet:"", obrazek:""}`) | `D2-zelena` (volající s objektem: „Queen" před doručením alb) |

Výpisy: `run-mutace-A.out`, `run-mutace-B-phone.out`, `run-mutace-B-desktop.out`.

## Co se ukázalo mimo zadání

**Seznam alb od Deezeru občas nedojde.** V plném desktopovém běhu dvakrát selhal — jednou
zůstaly obě mřížky prázdné (`D4-zelena`), podruhé `page.click` nenašel kartu
(`D5-cervena`), pokaždé na jiném bodu a samostatně oba prošly. Nejde o dávku: padá to i na
produkční polovině. Rozestup mezi kontrolami proto vzrostl z 1 200 na 2 500 ms a `D4`
si do výpisu přidalo `ODPOVĚĎ PROVIDERA SELHALA` (čte `#artistAlbums .empty-state`), aby
se selhání providera nedalo splést s vadným rozdělením. Třetí plný běh je čistý.

**Hrdinka po neúspěšném požadavku.** Když seznam alb selže, u volajícího s řetězcem
v hrdince zůstane předchozí interpret. Je to **shodné s produkcí** (ta hrdinku taky nikdy
nemaže), tedy ne nová mez — ale stojí za zápis, protože to je přímý důsledek opravy R4.1.

## Přiznané meze druhého kola

1. **Žádná kontrola druhého kola nepadá proti produkci** a ani padat nemůže — obě opravují
   regresi prvního kola. Padající polovinu dodává zamrazený strom `kolo1` a dvě cílené
   mutace. Spouští se ručně přes `MS_TREE`, **nejsou součástí `node tests/e2e/audit/detail.mjs`**.
2. **R4.2 je změřené jen na iTunes.** YouTube Music a Spotify mají `record_type` chybějící
   ze stejného důvodu (mapper ho neskládá, ověřeno `grep`em), ale proměřený je iTunes;
   u zbylých dvou je to odvozené z kódu, ne z běhu.
3. **Doplnění tří volajících, aby posílali objekt, se tady nedělá** — `search.js`,
   `fullplayer.js` i `contextmenu.js` zůstaly nedotčené, jak review nařídilo. Do té doby
   má hrdinku předmalovanou jen cesta ze sledovaných interpretů.
4. **`total_tracks` u iTunes existuje** (`trackCount`), ale podtitulek ho dál netiskne —
   pravidlo z prvního kola („nikdy `total_tracks`") vzniklo nad Deezerem, kde je vždy 0.
   U iTunes je to tedy zahozená informace. Nesaháno: mění chování nad rámec R4.2.
5. **`scratchpad/` je ve stromu netrackovaný** (kopie stromu prvního kola, mutace, výpisy).
   **Necommitovat.**

## Sada po druhém kole

Všechno změřeno nad **konečnou** podobou stromu; mezi měřeními se už nesahalo do kódu.

```
python3 -m pytest tests/ -q                   → 82 passed, 3 skipped          (rc 0)
node --test tests/js/bpm_client.test.mjs      → 10 pass, 0 fail               (rc 0)
scripts/build-index.sh ; scripts/check-index.sh                               (rc 0, 0)
node tests/e2e/audit/detail.mjs desktop       → 20 prošlo, 0 padlo, 3 přeskočeno (rc 0)
node tests/e2e/audit/detail.mjs phone         →  5 prošlo, 0 padlo, 10 přeskočeno (rc 0)
node tests/e2e/audit/detail.mjs tablet        →  2 prošlo, 0 padlo, 12 přeskočeno (rc 0)
MS_TREE=…/kolo1   … desktop D4-itunes         → D4-itunes-zelena PADLO        (rc 1, čekáno)
MS_TREE=…/kolo1   … phone   D2-retezec        → D2-retezec-zelena PADLO       (rc 1, čekáno)
MS_TREE=…/mutace/A … desktop D4 D4-itunes     → padlo jen D4-itunes-zelena    (rc 1, čekáno)
MS_TREE=…/mutace/B … phone D2-retezec         → D2-retezec-zelena PADLO       (rc 1, čekáno)
MS_TREE=…/mutace/B … desktop D2               → D2-zelena PROŠLO              (rc 0)
```

Proti prvnímu kolu přibyly na desktopu dvě kontroly (`D4-itunes`) a na telefonu dvě
(`D2-retezec`); žádná stávající kontrola se nezměnila ve svém tvrzení.

## Soubory druhého kola

| soubor | co se změnilo |
|---|---|
| `static/js/spotify.js` | R4.1 (hrdinka jen podle volajícího), R4.2 (`_splitsByKind`), reset `display` u skeletonů |
| `tests/e2e/audit/detail.mjs` | `D2-retezec`, `D4-itunes`, `red: 'projde'`, rozestup 2 500 ms, `ODPOVĚĎ PROVIDERA SELHALA` ve výpisu `D4` |
| `docs/architecture.md` | „Only Deezer sends `record_type`" a „The artist hero paints only what the caller passed" |
| `notes/impl/oprava-5-rozhodnuti-c4.md` | tahle sekce + tři opravené věty v prvním kole |
| `static/index.html` | generovaný, přegenerován; `check-index.sh` prochází (partialy se neměnily) |
