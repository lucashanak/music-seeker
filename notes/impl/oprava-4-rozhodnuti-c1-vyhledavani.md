# Oprava 4 — celek 1 (vyhledávání): rozhodnutí a doklady

Worktree: `/home/lucas/music-seeker-wt/oprava-4-c1-vyhledavani`, větev `main`, základ
`5c5ffd6`. Měněné soubory produktu: `static/js/search.js`, `static/css/search.css`.
Kontroly: `tests/e2e/audit/search.mjs`. Dál `docs/architecture.md` (změněné chování)
a tenhle zápis. Necommitováno, nepushováno, nenasazováno.

Produkce v okamžiku měření: `GET /api/version` → **1.25.2** (starý kód).
Účet `claude_test`, `ms_device_id` `autor-4-c1-{phone,tablet,desktop}`.
Na produkci se jen četlo: hledalo, otevíraly se detaily a žánrový žebříček, S14 zelená
vystřelila jeden `GET /api/artist/{id}/top`. Nic se nepřehrávalo, nestahovalo, nemazalo,
nenastavovalo a nezakládaly se playlisty. V kontextovém menu se neklikalo vůbec.

## Jak se měřilo

> **Překonáno druhým kolem.** Postup níž popisuje PRVNÍ kolo a review ho zamítlo:
> zelená polovina měřila náhradu vloženou do stránky, ne tenhle kód. V souboru už
> takhle nevypadá — platný popis je v sekci A druhého kola. Zůstává tu kvůli
> dohledatelnosti, co se čím měřilo při prvním odevzdání.

`node tests/e2e/audit/search.mjs <phone|tablet|desktop> [S…]` nad sdíleným postrojem
`tests/e2e/audit/helpers.mjs` (needitován). Každý bod projde třemi kroky v jednom běhu:

1. **červená** — kontrola proti živé produkci padá,
2. **zelená** — do téže stránky se přes `page.evaluate` / `page.addStyleTag` vloží
   navrhované chování (náhradní posluchač v záchytné fázi, přepsaný kus DOM, podstrčené
   CSS) a tatáž kontrola projde,
3. kontrola zůstává v souboru.

Logy níž leží v
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/autor-4-c1/`.
Běhy (návratový kód čten samostatným během, ne přes rouru):

| běh | výsledek | log |
|---|---|---|
| `search.mjs desktop` | **32 prošlo, 0 padlo** | `scratchpad/autor-4-c1/desktop-final.txt` |
| `search.mjs tablet` | **20 prošlo, 0 padlo**, 6 přeskočeno | `scratchpad/autor-4-c1/tablet.txt` |
| `search.mjs phone` | **18 prošlo, 0 padlo**, 7 přeskočeno | `scratchpad/autor-4-c1/phone.txt` |
| `python3 -m pytest tests/ -q` | 78 passed, 3 skipped, rc=0 | `scratchpad/autor-4-c1/pytest.txt` |
| `node --test tests/js/bpm_client.test.mjs` | 10/10, rc=0 | `scratchpad/autor-4-c1/nodetest.txt` |
| `scripts/build-index.sh` + `scripts/check-index.sh` | rc=0, „agrees with 16 partials" | `scratchpad/autor-4-c1/check2.txt` |

`static/index.html` se nezměnil — partialy jsem nesahal, CSS i JS jsou samostatné
soubory, hradlo je po přestavění zelené a `git status` je nevypisuje.

Přeskočené kombinace a proč: S10, S13, S7, S7b, S4, S4b jsou textové/logické a běží
jen na desktopu (nic z nich nezávisí na rozložení). S11 se na 390 px neměří — srdce je
tam podle `search.css:245` skryté, takže pořadí v pravém clusteru není co měřit.

## Bod po bodu

| bod | místo zásahu (HEAD → po opravě) | kontrola | červená na produkci | zelená s opravou |
|---|---|---|---|---|
| S1 | import `search.js:7` → `:7-14`; tab `:994-1001` → `:1200-1211`; input `:965-971` → `:1167-1183` | otevřít interpreta → tab Albums | `detailVisible:true, resultsVisible:false` | `detailVisible:false, resultsVisible:true, cards:20` |
| S2 | scroll `:1004-1011` → `:1215-1227` | 4× doscrollovat na detailu alba | 4 požadavky na `/api/search` | 0 požadavků, detail pořád vidět |
| S3 | `cardSubHtml` `:63` → `:83` | podtitulek ≠ název | 16 karet má podtitulek == název | 0 |
| S4 | `renderBrowse` `:344-369` (cache `:351-353`, `:358`) → `:385-427` | 502 na `/api/genres` | `#searchResults` prázdný, bez tlačítka | text + tlačítko; po odebrání 502 a kliknutí 22 dlaždic |
| S4b | `doSearchAll` `:830-947` → `:996-1104` | `errors` na všech čtyřech větvích | „No results found", bez tlačítka | „Search is unavailable right now." + tlačítko |
| S5 | `openGenre` `:392-434` → `:467-521` (+ `closeGenre` `:456`) | dlaždice → žebříček → Zpět | 0 dlaždic, žebříček otevřený | 22 dlaždic, žebříček zavřený |
| S6 | `_dedupeByName` `:818`, `doSearch` `:597-657` → filtr `:711-713`, `_dropCreditEntities` `:948` | duplicity + credit-entity v tabu Artists | 16 karet, 1 duplicita, 7 credit-entity | 8 karet, 0 duplicit, 0 credit-entity |
| S7 | `doSearch` / `doSearchAll` → `_noteIfNothingMatches` `:963`, voláno `:727` a `:1107` | nesmyslný dotaz | řádek chybí (5 karet pod ním) | řádek je |
| S7b | — | „daft punk" | (bez červené, viz meze) | řádek není |
| S8 | `search.css:218` → `search.css:228-247` | značka „v knihovně" na řádku | šířka značky 0 px | 16 px, šířka názvu beze změny (856/680/152 px) |
| S9 | `renderRecentSearches` `:296-330`, klíč `:271` → `:300-380`, vstup `:1167-1183` | seznam bez fokusu + křížek | 0 položek v `#searchResults` | 3 položky, po křížku 2 v DOM i v localStorage |
| S10 | `:128` → `countLabel` `:88`, použití `:154` | pořad s jednou epizodou | „1 episodes" | „1 episode" |
| S11 | `:742-745` → `:857` | pořadí ♡ / délka / ⋯ | x: 1171 / 1003 / 1127 | 1003 / 1047 / 1171 |
| S12 | `:689-696` + `search.css:143-148`, `:237-239` → `search.css:134-160`, JS `:816-821` | akce hrdinky uvnitř obalu | obě tlačítka vedle obalu (390: 241–321 vs. obal 37–177) | obě uvnitř (45–125) |
| S13 | `cardRadioBtn` `:28` → `:46` | ikona místo emoji | `svg:false`, text „📻" | `svg:true`, text prázdný |
| S14 | `cardPlayBtn` `:13-17` → `:24-35`, `_wireHeroArtistPlay` `:787` | hrdinka interpreta má ▶ | tlačítko neexistuje | tlačítko je, klik volá `/api/artist/{id}/top` |

Citace ze zadání jsem před zásahem ověřoval proti HEAD; **šest z nich neseděla**
(`S1 969-976/940-946`, `S2 979-986`, `S6 793`, `S11 728-741` — čísla byla razítkovaná
proti staršímu stavu). Sedí `S3:63`, `S4:352-358`, `S5:392-434`, `S9:296-330`,
`S10:128`, `S12:689-696`, `S13:28`, `S14:15`.

## Přiznané meze

1. **S5 zůstává po merge celku 1 červená.** Oprava vystavuje `closeGenre(fromPopstate)`
   a `store.genreOpen`, ale větev v `handlePopstate` dělá celek 3 jako N14. Dokud
   nepřistane, Zpět na žánrovém žebříčku pořád nic neudělá. Zelená výš je doložená
   náhradním posluchačem, který dělá přesně to, co má dělat ta větev.
2. **`store.genreOpen` není deklarované v `store.js`.** Ten soubor nemám na seznamu;
   `store` není zapečetěné, takže to funguje, ale jeden řádek `genreOpen: false,`
   k ostatním příznakům vrstev patří. Prosím vedení o doplnění při merge.
3. **S6: „žádná z prvních pěti karet nemá zástupnou adresu" splnit nejde** a kontrola to
   netvrdí. Pravidlo z dodatku zahazuje položku se zástupnou adresou **a zároveň** čárkou
   v názvu; na dnešních datech pro „daft punk" ale zbydou tři položky se zástupnou
   adresou bez čárky („Daft Punk - Stardust", „Made famous by Daft Punk", „Daft Punk's
   Karaoke Band") a dvě z nich jsou mezi prvními pěti. Kontrola proto měří to, co z
   pravidla skutečně plyne a co měřitelně padá na starém kódu: **0 duplicit, 0
   credit-entity, první karta se skutečným obrázkem**. Zahozených celkem 8 z 16.
4. **S4 se netýká jednotypových tabů.** `errors` vrací jen `search_all`; `/api/search`
   ho nemá, takže v tabech Songs/Artists/Albums/Playlists výpadek providera i po téhle
   dávce skončí na „Search failed". Je to záměr, ne nedodělek — doplnění je vlna 2.
5. **S14 zelená nedokládá přehrání, jen natažení.** Náhradní tlačítko v živé stránce
   nedosáhne na `playTracks` (je v modulu), takže kontrola měří, že klik vystřelí
   `GET /api/artist/{id}/top`. Vlastní přehrání ověří přejímka po nasazení.
6. **S9: „čipy se ruší" nemá vlastní červenou.** Odebrání prvku se proti starému kódu
   nedá vyjádřit jako padající tvrzení — kontrola proto měří druhou polovinu („seznam je
   vidět bez fokusu, křížek maže"), která padá. `#recentSearches` v
   `frontend/partials/30-search.html:30` zůstává v DOM prázdný a skrytý; markup patří
   vlně 2 a inline `.recent-*` pravidla v `00-head.html:80-93` maže celek 3 (sdílený
   kontrakt 3) — nové `.recent-list/.recent-item*` jsou v `search.css`.
7. **S6 dedupe neběží napříč stránkami.** Nekonečný scroll v tabu Artists prochází
   každou stránku zvlášť, takže duplicita rozdělená mezi první a druhou stránku projde.
   Stránkování se drží syrové délky odpovědi (offset serveru počítá, co poslal), takže
   to je výměnou za to, že filtr nerozhodí paging.
8. **S10 měří na podstrčené odpovědi.** Pořad s jedinou epizodou se na produkci
   spolehlivě najít nedá, takže `page.route` podstrčí jeden výsledek s `total_tracks: 1`.
   Měří se vykreslení, ne provider.
9. **S8 na produkci nenašel řádek z knihovny** pro měřený dotaz, takže si ho kontrola
   vyrobí přesně tak, jak to dělá `checkLibrary()` (třída `in-library` na řádku +
   pilulka `.in-library-badge` v něm). Měření šířky je tím nedotčené.
10. **Nález #19 a spol. se tady neřeší** — tenhle celek se nedotkl ničeho mimo
    `search.js` / `search.css`.

## Co jinak a proč

- **S1 — statický import, ne dynamický.** Zadání varovalo před cyklem a doporučovalo
  `import()`; dodatek to obrátil a má pravdu: cyklus `search.js:7 ↔ spotify.js:7` už
  existuje a funguje, protože se obě strany volají až z obsluhy události. Dynamický
  import by navíc udělal zavření asynchronním a `doSearch()` by běželo dřív. Ošetřen
  i `#showDetail`. Viditelnost vrstvy se testuje `offsetParent !== null` (sdílený
  kontrakt 1), takže se `close*()` nevolá naprázdno a nepopuje cizí položku historie.
- **S5 — `closeGenre()`, ne vlastní `popstate` posluchač.** Vlastní posluchač se
  zakazuje: `handlePopstate` spotřebuje `store._ignorePopstate` na `router.js:129`
  dřív, než se k němu kterýkoli pozdější posluchač dostane.
- **S8 — značka jde na roh obalu, ne do pravého clusteru.** Zadání navrhovalo „tečku
  nebo ✓ vedle délky", ale tatáž kontrola zároveň žádá, aby se název na 390 px
  nezkrátil. V pravém clusteru je značka v toku a 16 px + mezera by z názvu ubraly;
  na 390 px má název 152 px, takže je to měřitelná ztráta. Značka je proto
  `position: absolute` na rohu `.song-thumb` — vidět ve všech třech rozlišeních,
  nulová šířka v toku (naměřeno: 856 / 680 / 152 px před i po). Číslované seznamy
  (album, playlist, knihovna) si nechávají dosavadní značku, obarvené číslo stopy.
- **S11 — přesun v DOM, ne `order` v CSS.** `order` by bylo kratší, ale řádky knihovny
  nesou další prvky bez vlastního `order` (`lib-bulk-cb`, `card-drag-handle`,
  `lib-track-remove`, `bpm-badge`), které by se tím přeskládaly taky. `insertBefore`
  před `.song-duration` hýbe jedním prvkem.
- **S12 — sloty v CSS, pořadí v JS.** Které tlačítko je kolikáté zprava závisí na typu
  položky, takže to musí říct JS; geometrie ale patří do CSS, jinak ji breakpoint
  nepřebije. Výsledek: třídy `.hero-act-0/1/2` navázané na `--hero-art`, které mobilní
  breakpoint přepisuje na 140 px. Zmizely tím i dvě magické konstanty — `top: 156px`
  a `top: 116px` jsou teď jeden výpočet z téhož `--hero-art`, takže se nemůžou rozejít.
- **S14 — hrdince jsem navíc nechal tlačítko vidět.** `.card-play-btn` se jinde odkrývá
  až při hoveru, což na tabletu (1024×768, nad breakpointem, bez hoveru) znamená
  neviditelné. Hrdinka je jeden prvek a smysl S14 je, aby šla pustit, takže má
  `opacity: 1`. Na kartách v mřížce zůstává všechno jak bylo.
- **S9 — klíč `ms_recent_searches_${user}` a zahození starého.** Bez toho by dávka
  vystavila historii hledání předchozího uživatele komukoli, kdo se přihlásí ve stejném
  prohlížeči — a nově bez jakékoli interakce.
- **S4 — výpadek `/api/genres` se necachuje vůbec**, ani jako prázdné pole. Prázdná
  odpověď se teď považuje za selhání: na starém kódu právě ta uložená prázdná pole
  držela úvodní obrazovku prázdnou do konce sezení.
- **S7 — řádek je v obou cestách**, v agregovaném i jednotypovém hledání. Vada je
  v obou stejná a sdílí jednu funkci.

## Pro vedení při merge

- Doplnit `genreOpen: false,` do `static/js/store.js` k ostatním příznakům vrstev.
- Celek 3 doplní N14 (větev `store.genreOpen` → `closeGenre(true)` v `handlePopstate`),
  teprve pak S5 zezelená (druhé kolo ji nechává jako SKIP, viz R1.3).
- Celek 3 při své úpravě `frontend/partials/00-head.html` maže inline `.recent-searches`,
  `.recent-chip` a `.recent-clear` (řádky 80–93) — po téhle dávce je nic nepoužívá.
- `#recentSearches` v `frontend/partials/30-search.html:30` zůstává prázdný a skrytý;
  odstranění markupu patří vlně 2.

---

# Druhé kolo — po review

Review vrátilo celek 1 ve dvou drahách ze tří. Nejzávažnější nález nebyl v kódu, ale
v tom, čím se kód měřil (sekce A dodatku), a platí pro mě bez výjimky.

## A. Orákulum: zelenou dělá worktree, ne náhrada

V prvním kole si kontroly zelenou vyrobily samy — `page.evaluate` vložilo do živé
stránky náhradní posluchač, přepsalo DOM nebo podstrčilo CSS. **Měřily tu náhradu.**
Dráha testů to doložila nejtvrději: `search.mjs` neodkazoval na jediný soubor ze
stromu, takže žádná změna v `search.js` ani `search.css` ho nemohla zčervenat a všech
13 mutací mého kódu zůstalo kontrolám neviditelných.

Celý `tests/e2e/audit/search.mjs` je proto přepsaný. Z definic bodů **zmizel klíč
`patch`** (i `redo` a `skipRed`, které bez něj nedávají smysl) a běh otevírá dvě sezení
vedle sebe — na desktopu tři, protože body R1.1 potřebují třetí orákulum (viz C):

| polovina | čím se otevírá | co pod kontrolou běží |
|---|---|---|
| červená | `open({ viewport, device })` | nasazená produkce, 1.25.2 |
| zelená | `open({ viewport, device, worktree: ROOT })` | **skutečné soubory z tohohle stromu**, včetně `index.html` |

Stejná `prep`, stejná `assert`, jiný kód pod nimi. Do stránky se nevkládá nic.

**Nový bod `W0` hlídá samotné orákulum**, protože tiché selhání servírování by vrátilo
přesně stav prvního kola. Měří, že se na zelené straně `/static/js/search.js` nese
obě opravy druhého kola a na červené ne, a že se **žádný modul nenačetl dvakrát a
žádný bez cache-bust razítka** — to je ta past, na které v prvním kole skončil celek 2
se dvěma instancemi `store`/`queue`/`player`. Naměřeno: 33 modulů, dvakrát žádný,
bez razítka žádný.

Co se do stránky pořád podstrkává, jsou **odpovědi serveru** (`page.route` na
`/api/genres`, `/api/search/all`, `/api/search?type=show`) u stavů, které se na
produkci vyvolat nedají — výpadek providera, pořad s jedinou epizodou. To je vstup,
ne náhrada měřeného kódu: pod podstrčenou odpovědí běží v každé polovině kód té
které strany, a právě proto R1.2 na jedné straně padá a na druhé prochází.

## B. Co se tím rozpadlo

Přepsání zčervenalo čtyři věci. Všechny byly vady **v kontrolách**, ne v produktu:

1. **S14 měřil viditelnost lišty přehrávače přes `offsetParent`.** `.player-bar` je
   `position: fixed` (`player.css:5`), a u fixed prvku je `offsetParent` null
   i tehdy, když je prvek vidět. Kontrola tedy hlásila „lišta: false" nad hrajícím
   přehrávačem. Sdílený kontrakt o `offsetParent` platí na vrstvy v toku, ne na tuhle.
   Opraveno na `display` + skutečnou výšku — a S14 tím **poprvé dokládá přehrání**,
   ne jen natažení: `hraje: "Instant Crush (feat. Julian Casablancas)"`.
2. **S4 a S4b tvrdily jen „něco tam je a je tam tlačítko".** To splní i seznam
   posledních hledání sám o sobě (což se po S9 skutečně stalo — v dokladu je vidět
   „Recent searches CLEAR daft punk ✕ Could not load the genre list. Try again").
   Obojí teď žádá vlastní hlášku a vlastní `#browseRetry`.
3. **S8 si značku „v knihovně" vyráběl v DOM**, protože knihovna `claude_test` měřený
   dotaz nepokrývala. Fixtura `zz-audit-fixture` drží „One More Time" od Daft Punk,
   takže se hledá `daft punk one more time` a značku navěsí **skutečné
   `checkLibrary()`**. V DOM se nevyrábí nic.
4. **S1 měřil rychlost providera.** Po kliknutí na tab čekal pevných 3,5 s; na
   390 px karty dorazily později a zelená padla na `cards: 0`, přestože detail
   zavřený byl a výsledky vidět byly (`detailVisible:false, resultsVisible:true`).
   Místo pevného čekání se teď čeká na kartu — `state: 'attached'`, protože na
   nasazeném kódu se karty vykreslují do seznamu schovaného pod detailem, takže
   `visible` by červenou polovinu utnulo timeoutem.

Žádná z těch čtyř vad nebyla v produktu. Stojí ale za zaznamenání, že tři z nich
(S14, S4/S4b, S1) by v prvním kole nemohly vyjít najevo: pod náhradou vloženou do
stránky se neměřila ani lišta přehrávače, ani hláška, ani doba odpovědi providera.

## C. R1.1 — „No results for X" nad správnými výsledky

**Opraveno.** Shoda celého slova prohlásila překlep za nenalezeno: `beyonse` dostalo
pruh nad 18 kartami, z nichž první byla Beyoncé.

Pravidlo je teď **shoda prvních čtyř znaků slova** (`_sharesOpening`), ne shoda celého;
slova kratší než čtyři znaky se porovnávají celá. Čtyři znaky drží
`zzzqqqxyznotathing12345` stranou od všeho, co provider vrací.

**Dvě upřesnění proti zadání dodatku, obě doložená:**

- **Diakritika za to nemohla.** Dodatek píše, že `_normName` shodí háčky z výsledku,
  ale ne z dotazu. Kód prvního kola ale začínal `_normName(q)` — obě strany
  normalizované byly. Je to vidět přímo v tabulce `PRED_OPRAVOU` v `search.mjs`, která
  ten starý tvar drží doslova: `new Set(_normName(q).split(' ')…)`. Jedinou příčinou
  byla shoda celého slova; normalizace obou stran týmž `_normName` samozřejmě zůstává.
- **Podmínku „a zároveň odpověď nemá `top`" splnit nejde, udělala by z hlášky mrtvý
  kód.** `_pick_top_result` (`app/services/search_providers.py`) vrací `None` jedině
  ve svém posledním kroku, tedy když **všechny čtyři větve přišly prázdné** — a tehdy
  není nad co hlášku psát. Změřeno na živé instanci: `zzzqqqxyznotathing12345` **top
  má** (`NO BATIDÃO (Slowed)`), protože picker propadne na `tracks[0]`, když se nic
  neshoduje přesně. Doslovné (b) by tedy zrušilo i kontrolu, kterou týž dodatek
  nařizuje („zzzqqqxyznotathing12345 pruh **má**"). Měřeno to bylo nejdřív doslovně —
  `S7-zelena` padla, pruh nebyl — a teprve pak se hledalo proč. `top` je navíc
  jedna z položek v `allItems`, takže ho jediný test už pokrývá. Je to stejný případ
  jako R1.4: formulace dodatku proti vlastní kontrole téhož dodatku.

**Červenou R1.1 nejde udělat proti produkci** — pruh je celý nový v téhle dávce, takže
ho nasazený kód nekreslí nikdy. Prohlásit nález za „bez červené" by znamenalo tvrdit
ho bez důkazu, proto má R1.1 **třetí orákulum: kód prvního kola**. `postavPredOpravou()`
zkopíruje `static/` do dočasného adresáře, vrátí v `search.js` tři řádky na znění
prvního kola (kotvy se ověřují, musí sedět právě jednou) a naservíruje ho toutéž
cestou. Není to náhrada ve stránce — je to starý soubor na svém místě.

Naměřeno (`R1.1a/b/c`, desktop):

| dotaz | kód prvního kola | tenhle strom |
|---|---|---|
| `beyonse` (artist) | pruh **je**, 18 karet, první „Beyoncé" | pruh **není**, 18 karet, první „Beyoncé" |
| `thriler` (album) | pruh **je**, 20 karet, první „Thriller" | pruh **není**, 20 karet, první „Thriller" |
| `michaell jacksonn` (all) | pruh **je**, 25 karet, první „Thriller" | pruh **není**, 25 karet, první „Thriller" |
| `zzzqqqxyznotathing12345` (S7) | — (na produkci pruh není) | pruh **je**, 5 karet pod ním |

Nad rámec e2e jsem pravidlo pustil přes 12 dotazů proti živým odpovědím providera
(`scratchpad/autor2-4-c1/pravidlo.txt`, skript `pravidlo.mjs` vedle). Na té sadě pruh
**ubírá právě u těch tří dotazů, kde ho první kolo ukazovalo** (`beyonse`, `thriler`,
`michaell jacksonn`), u obou nesmyslů (`zzzqqqxyznotathing12345`, `xkcdvvzzqq0987`)
ho **nechává** a nikde nový nepřidává — ani u `daft punk zzzqqqnothing`, kde se
shoduje část dotazu, ani u `radiohed`, `queen bohemian rapsody`, `u2` a `nirvana`,
kde ho neukazovalo ani staré pravidlo. Jinak řečeno: změna je čisté zúžení falešně
kladných, žádný nový falešně záporný případ na té sadě není.

## D. R1.2 — částečný výpadek s prázdnou větví tracks

**Opraveno** přesně tak, jak dodatek říká: do podmínky prázdna přibylo
`&& !Object.keys(errors).length`.

Kontrola `R1.2` podstrčí odpověď se třemi spadlými větvemi a prázdnými `tracks`:

| | proužky | Try again | „No results found" | dotazů po kliknutí na Try again |
|---|---|---|---|---|
| produkce | 0 | 0 | **ano** | 0 |
| tenhle strom | **3** | **3** | ne | **1** |

Kontrola klikne na Try again a čeká na nový dotaz na `/api/search/all` — proužek, který
nejde zopakovat, by byl jen jiné znění téhož mlčení.

## E. R1.3, R1.4, R1.5 — co zůstalo

- **R1.3 (S5):** zelená nad tímhle stromem doložit nejde a nevyrábí se. Větev
  `store.genreOpen` → `closeGenre(true)` v `handlePopstate` je bod N14, tedy celek 3.
  Kontrola proto zelenou polovinu **změří a vypíše jako přeskočenou i s naměřeným
  stavem** (`naměřeno PADLO: dlaždic 0, žebříček pořád otevřený: true`) — ne jako
  zelenou. Červená proti produkci zůstává a prochází. Patří do ověřovacího kola nad
  spojeným stromem.
- **R1.4 (S6):** beze změny, jak dodatek nařizuje. Kontrola měří 0 duplicit,
  0 credit-entity a první kartu se skutečným obrázkem; naměřeno 16 → 8 karet,
  duplicit 1 → 0, credit-entity 7 → 0.
- **R1.5:** na `store.js` jsem nesáhl, `genreOpen` doplní vedení při merge.
  Dedupe napříč stránkami nekonečného scrollu zůstává mezí.

## F. Meze druhého kola

Z prvního kola **padly dvě**: mez 5 (zelená S14 nedokládá přehrání) a mez 9 (S8 si
vyráběl značku v DOM) — obojí vyřešilo servírování z worktree a fixtura
`zz-audit-fixture`. **Pořád platí** meze 1 (dál jako R1.3), 2 (`store.genreOpen`
doplní vedení), 3 (S6 — potvrzeno jako R1.4), 4 (jednotypové taby bez `errors`),
6 (S9 nemá vlastní červenou na zrušení čipů), 7 (dedupe napříč stránkami),
8 (S10 na podstrčené odpovědi) a 10. Nově k nim:

1. **S5 nemá zelenou** (R1.3). Měří se, vypisuje se naměřený stav, ale je to SKIP,
   ne PASS. Ověřovací kolo nad spojeným stromem.
2. **Skutečný zvuk se neměří.** S14 dokládá, že klik vystřelí
   `/api/artist/{id}/top`, že se lišta přehrávače zobrazí a že v ní je titul
   (`Instant Crush (feat. Julian Casablancas)`). Že z reproduktoru jde zvuk,
   headless prohlížeč bez zvukového zařízení neprokáže — patří na přejímku.
3. **Hover se neměří vůbec.** `.card-play-btn` na kartách v mřížce se odkrývá při
   hoveru; 1024×768 je nad breakpointem 640, takže dostává desktopová pravidla na
   zařízení bez hoveru. Hrdinka má proto `opacity: 1` (první kolo), ale pro karty
   v mřížce je to otevřená otázka vlny 2, ne něco, co by tahle dávka doložila.
4. **R1.1 nemá červenou proti produkci.** Pruh je nový, nasazený kód ho nekreslí.
   Červenou dělá kód prvního kola; proti produkci by to byl nález bez důkazu.
5. **S10, S4, S4b a R1.2 měří na podstrčené odpovědi serveru** — pořad s jedinou
   epizodou se na produkci nedá spolehlivě najít a výpadek providera se vyvolat
   nedá vůbec. Vykreslení pod tou odpovědí běží v každé polovině jejím vlastním
   kódem; podstrčený je jen vstup, ne měřený kód.
6. **Čísla karet se mezi běhy hýbou** — provider je živý. Proto kontroly tvrdí
   poměry a přítomnosti (0 duplicit, pruh je/není), ne konkrétní počty.
7. **`_nothingMatches` nemá jednotkový test.** Logika se měří e2e nad živými daty
   a navíc skriptem `pravidlo.mjs` přes 12 dotazů; čistě jednotkový test by si
   vyžádal export vnitřností `search.js` a do sady projektu
   (`pytest` + `bpm_client.test.mjs`) nepatří. Vlna 2.
8. **Tablet má jeden bod bez vlastního dokladu v posledním běhu** — `S14-červená`
   skončila výjimkou „provider nevrátil nic". Tvrzení platí a je doložené na
   desktopu i na telefonu; na tabletu je k němu doklad jen ze staršího běhu.
   Rozhodnutí, jestli se běhy mají rozestoupit, patří vedení (sdílený postroj).

## G. Běhy druhého kola

`node tests/e2e/audit/search.mjs <phone|tablet|desktop>` nad sdíleným postrojem
`tests/e2e/audit/helpers.mjs` (**needitován**, bajtově shodný s hlavním stromem).
Produkce v okamžiku měření: `GET /api/version` → **1.25.2**. Účet `claude_test`,
`ms_device_id` `e2e-autor2-4-c1-<viewport>-{prod,wt,pred}` — tři sezení, tři různá
id, aby si lanes nepřepisovaly frontu.

Logy v
`/tmp/claude-1000/-home-lucas-music-seeker/9b785486-17c6-4ffa-ba41-f02f20510898/scratchpad/autor2-4-c1/`.
Návratové kódy čtené samostatným během, ne přes rouru.

| běh | výsledek | log |
|---|---|---|
| `search.mjs desktop` | **40 prošlo, 0 padlo, 1 přeskočeno** (S5), rc=0 | `desktop-final.txt` |
| `search.mjs tablet` | **19 prošlo, 1 padlo** (S14-červená: výpadek providera, viz pozn. níž), 11 přeskočeno, rc=1 | `tablet-final2.txt` |
| `search.mjs phone` | **18 prošlo, 0 padlo**, 12 přeskočeno, rc=0 | `phone-final.txt` |
| `python3 -m pytest tests/ -q` | **78 passed, 3 skipped**, rc=0 | `pytest-final.txt` |
| `node --test tests/js/bpm_client.test.mjs` | **10/10**, rc=0 | `nodetest-final.txt` |
| `scripts/build-index.sh` + `scripts/check-index.sh` | rc=0, „agrees with 16 partials" | `build.txt`, `check-final.txt` |
| pravidlo R1.1 přes 12 dotazů | čisté zúžení falešně kladných | `pravidlo.txt` |

Partialy jsem nesahal, takže `static/index.html` zůstal beze změny i po přestavění
(`git status` ho nevypisuje). Na produkci se jen četlo; jediný zápis je fronta
vlastního `ms_device_id` ze S14. Nic se nestahovalo, nemazalo, nenastavovalo a
v kontextovém menu se neklikalo.

Běh desktopu otevírá **tři** prohlížeče (produkce, worktree, kód prvního kola),
tablet a phone dva — body R1.1 se měří jen na desktopu, protože nezávisí na
rozložení.

### Výpadek providera během měření (pozn. k dokladům)

Při opakovaných bězích za sebou začal Deezer odpovídat prázdno. Kontrola to pozná
a nehlásí falešný nález — `searchFor()` dotaz třikrát zopakuje a pak hodí výjimku
„provider nevrátil nic pro …", takže se takový bod odliší od skutečného padnutí.
Projevilo se to v běhu `tablet-final.txt`: **4 padlé body jsou čtyři takové
výjimky** (S14 i S1, obě poloviny — červená i zelená, tedy symetricky, což samo
ukazuje na okolí, ne na kód). Ve stejném běhu všechno ostatní prošlo a zbylé body
se měřily normálně, protože provider se mezitím probral.

Po pětiminutové pauze bez zátěže se běh zopakoval (`tablet-final2.txt`): **19 prošlo,
1 padlo** — zbyla jediná taková výjimka, `S14-červená`. Ověřeno, že nejde o výpadek
backendu: `/api/search/all?q=daft punk` ze shellu odpovídal ve stejnou chvíli třikrát
po sobě korektně (`top=Daft Punk, tracks=8, errors=None`). Příčina je dávkování
dotazů — jeden běh pouští dvě až tři sezení naráz a Deezer pod tím občas vrátí
prázdno.

**Tvrzení S14-červené („hrdinka interpreta na produkci nemá `.card-play-btn`") je
doloženo jinde ve stejném znění:** `desktop-final.txt` a `phone-final.txt` ho mají
zeleně (detail `hrdinka interpreta nemá .card-play-btn`) a v prvním tabletovém běhu
prošlo taky. Na rozložení nezávisí — jde o existenci tlačítka, ne o jeho pozici.
Další běhy jsem už nepouštěl, aby měření nebylo jen další zátěží na živé instanci;
**zůstává to jako odchylka v dokladu, ne jako zamlčené padnutí.** Rozhodnout, jestli
`searchFor()` má mít delší odstup mezi pokusy, patří vedení — `helpers.mjs` ani
dávkování sezení nejsou můj soubor.
