# Oprava 4 — Dodatek po kritice

**Tenhle dodatek má přednost před `oprava-4-zadani.md`.** Kde si odporují, platí
dodatek. Kritika běžela ve dvou drahách (premisy a kód ∥ celek 3 a hrozby),
obě vrátily **„po úpravách"**, obě měřily proti produkci 1.25.2 ve všech třech
rozlišeních. Doklady: `scratchpad/kritika-4-kod/` a `scratchpad/kritika-4-hrozby/`.

Vedení kritiku přijalo celou. Níž jsou rozhodnutí — včetně dvou bodů, které se
**škrtají**, protože premisa neplatí.

---

## A. Škrtnuté body

### N12 — titulek modálu zpětné vazby — ŠKRTÁ SE

Premisa neplatí. `feedback.js:204` titulek přepíná a kritika to na živé instanci
změřila oběma směry („Report a bug" → „Request a feature" → zpět). Pro tenhle bod
**nelze vyrobit kontrolu, která padá na starém kódu**, takže podle pravidel dávky
není co dělat. Auditor nejspíš viděl `aria-label`/`title` plovoucího tlačítka
(`feedback.js:19-20`, natvrdo „Report a bug or request a feature") — to je jiný,
drobnější nález a jde do seznamu pro další dávku, ne sem.

### S6 první polovina — „8 z 10 interpretů je bez obrázku" — PŘEFORMULOVÁNO

Premisa neplatí: backend vrací neprázdný `image` u **všech** výsledků. Šedé
dlaždice jsou Deezerův **zástupný obrázek s prázdným hashem** v cestě
(`https://cdn-images.dzcdn.net/images/artist//500x500-000000-80-0-0.jpg` —
dvojité lomítko), který se normálně načte (`naturalWidth` 500). Test `!item.image`
je tedy vždy nepravdivý a navržené pravidlo by zahodilo **nula** položek: změřeno
na osmi dotazech, 148 výsledků, 0 zahozených.

Nové znění S6 je v sekci C.

---

## B. Rozhodnuté otevřené volby

Kritika položila šest voleb. Vedení rozhoduje takto; autor se jimi řídí a
nepřehodnocuje je.

| volba | rozhodnutí | důvod |
|---|---|---|
| **S5** — vlastní popstate handler, nebo `closeGenre()` pro celek 3 | **`closeGenre()` + větev v routeru.** Varianta s vlastním posluchačem se **zakazuje**. | `handlePopstate` spotřebuje `store._ignorePopstate` na `router.js:129` dřív, než se k němu dostane kterýkoli později navěšený posluchač. Žánrový handler by pak vystřelil i na stisky, které router záměrně polyká — např. „← Back to results" z alba by přemaloval výsledky na stěnu dlaždic. |
| **S9** — nechat čipy při fokusu? | **Zrušit je.** Jediný výskyt bude seznam v `#searchResults`. | Dva renderery téhož seznamu se musí trefit do stejného stavu po smazání položky, a `#recentSearches` se navíc schovává odloženě po 150 ms. |
| **P1** — lišta nad backdrop, nebo odsadit backdrop? | **Lišta nad backdrop, ale přes třídu, kterou nastavuje výhradně `openQueuePanel` a ruší `closeQueuePanel`** (`queue.js:213-231`), `z-index: 250`. | `#queueBackdrop` je **sdílený** s panelem fronty uvnitř velkého přehrávače. Selektor odvozený od backdropu by lištu vytáhl i nad velký přehrávač — tedy přesně v situaci, kterou opravuje P8. |
| **P15** — skrýt tlačítko DJ panelu? | **Nechat tlačítko, v klasickém enginu zásuvku nadepsat „Player".** | Zásuvka hostuje přepínač enginu a je to jediná cesta z klasického enginu do DJ bez odchodu do Nastavení; komentář u `refreshDjPanelVisibility` to říká výslovně. Skrytí by odebralo funkci. |
| **P2** — kdy přestavovat permutaci? | **Líně, při každém `_nextTrackInQueue`**, s dopočtem ocasu z nepřehraných indexů. | Frontu mění osm míst ve čtyřech souborech a tři z nich celek 2 měnit nesmí. Jednorázová permutace se s nimi rozejde. |
| **N1** — osiřelý stav `{layer:…}` | **`if (state && state.layer && !state.page) { history.back(); return; }`** s počitadlem skoků (nejvýš tolik, kolik je vrstev; pak spadnout na `switchPage(store.currentPage, true)` + `replaceState`). | Splní přejímací kritérium doslova — jeden stisk, správná stránka, souhlasící `history.state` — a vejde se do `router.js`. |
| **N2** — jak vystavit cancel cesty | **Zásobník `store.dialogStack` s `{ cancel }`**, LIFO. | `store` je už sdílené místo pro `queuePanelOpen`/`fullPlayerOpen`; řeší zároveň zanořený picker→input modál i to, že dnešní `querySelector` vrací **nejstarší** překryv, ne nejvrchnější. |
| **N3** — jak odhlásit bezpečně | **`flushQueue()` → smazat neuživatelské klíče → `location.href = '/'`.** | Reload zastaví audio, uklidí `mediaSession` i paměť `store`. Ruční teardown by se dal zapomenout. |
| **N3** — bude sekce Account rozbalená? | **Ano, `open`.** | N3 existuje proto, že odhlášení na telefonu není dosažitelné; schovat ho do zavřeného `<details>` je táž vada o stupeň slabší. (Všech 17 sekcí má dnes `open:false`.) |
| **N5** — kam s CSS toastu | **Nový `static/css/toast.css`** + `<link>` do `00-head.html` **s `?v=__CACHE_BUST__`**. | Jediná varianta, kde pravidlo najde ten, kdo bude příště hledat styl toastu. |
| **N4** — zastaví Zpět rozpoznávání? | **Ne.** Zpět se chová **přesně jako křížek** — zavře překryv, relaci nechá běžet. | Party mód je postavený na tom, že běží dál s telefonem v kapse (`closeParty` to dnes dělá záměrně). Změnit to by byla jiná funkce, ne oprava navigace. **Nový nález pro další dávku:** běžící relace nemá po zavření překryvu žádný indikátor. |

---

## C. Nová a přepsaná znění bodů

### S1 — náhrada instrukce o importu

Varování v zadání je obrácené. **Cyklus mezi `search.js` a `spotify.js` už
existuje a funguje** (`search.js:7` ↔ `spotify.js:7`), protože se obě strany volají
až z obsluhy události, ne při vyhodnocení modulu. Doplň tedy tři jména
(`closeArtistDetail`, `closeAlbumDetail`, `closeShowDetail`) **do stávajícího
statického importu na `search.js:7`**.

Dynamický `import()` se tu **zakazuje** — udělal by zavření asynchronním, takže
napsáno nejpřirozenějším způsobem by `doSearch()` běželo dřív než zavření.

Ošetři i **detail pořadu** (`#showDetail`) — žije taky uvnitř `#pageSearch`.

### S2 — bez změny, ale pozor na sdílený kontrakt

`offsetParent !== null` je správně, viz sekce D.

### S6 — nové znění

Vada je **zástupný obrázek**, ne chybějící obrázek. Zahazuj položku, která má
**zároveň** zástupnou adresu **a** čárku v názvu (vzor credit-entity):

```js
const DEEZER_PLACEHOLDER = /\/images\/[a-z]+\/\/\d+x\d+/;   // prázdný hash v cestě
```

Druhá polovina S6 (`_dedupeByName` v `doSearch` pro `searchType === 'artist'`)
platí beze změny a na starém kódu měřitelně padá (1–5 duplicit u všech osmi
měřených dotazů).

**Kontrola:** „žádná z prvních pěti karet nemá `src` odpovídající zástupné
adrese". Na starém kódu padá — dnes ji mají karty 2, 3, 5, 6, 7.

Tohle je **tentýž vzor jako N7** (univerzální hvězda Last.fm). Autoři celků 1 a 3
si toho ať všimnou; v dokumentaci to patří jako jedno pravidlo: *„zástupný obrázek
providera je platná URL, která se načte — detekuje se podle tvaru adresy, ne podle
prázdnosti pole."*

### S4 — doplněk o rozsahu

Klíč `errors` vrací **jen** `search_all`. Jednotypová cesta `/api/search`
(taby Songs/Artists/Albums/Playlists) ho nemá, takže tam výpadek providera i po
opravě skončí na „Search failed". **To je v pořádku a je to záměr téhle dávky** —
doplnění `errors` do `/api/search` je vlna 2. Napiš to do evidence, ať to při
přejímce nevypadá jako nedodělek.

### S5 — nové znění

`openGenre`:
1. `history.pushState({ layer: 'genre' }, '')`,
2. nastaví `store.genreOpen = true` (vrstva nemá vlastní DOM prvek, router ji
   podle viditelnosti nepozná),
3. exportuje `closeGenre(fromPopstate)`, která vrstvu zavře a `store.genreOpen`
   zruší; `historyBack()` volá jen když `!fromPopstate`.

Větev v `handlePopstate` doplní **celek 3** jako nový bod N14. Pořadí: **nad**
catch-allem na `.modal-overlay`, **pod** větví dialogů a pod vrstvami detailu.

Kontrola S5 je u celku 1 **červená a zůstane červená**, dokud nepřistane celek 3.
To je očekávané; napiš to do evidence a neobcházej to.

Oprav i popis vady: Zpět je na žánrové vrstvě **netečné donekonečna**, ne
„spotřebované a pak ven" — pojistka `router.js:149-153` položku pokaždé znovu
natlačí (`history.length` zůstává 3).

### S9 — nové znění

1. **Čipy při fokusu se ruší.** Jediný výskyt je seznam v `#searchResults`.
2. **`renderBrowse()` je jediný vlastník `#searchResults` v prázdném stavu** —
   poslední hledání vykresluje ono, nad dlaždicemi žánrů. Obsluha `input` ho jen
   spouští.
3. **Obsluha `input` při přechodu na prázdno musí volat `_cancelSearch()`** —
   dnes to nedělá, takže doběhlý starší požadavek přepíše seznam výsledky.
4. **Klíč se přejmenuje na `ms_recent_searches_${user}`** (dnešní `ms_recent_searches`
   není vázaný na účet). Bez toho by dávka vystavila historii hledání předchozího
   uživatele komukoli, kdo se přihlásí ve stejném prohlížeči — a nově by byla
   vidět bez jakékoli interakce. Starý klíč při prvním běhu zahoď.

### S14 — NOVÝ bod (celek 1): interpret nemá tlačítko přehrát

Jediný vysoký nález z reportu vyhledávání, který je celý uvnitř souborů celku 1 a
zadání ho vynechalo. `cardPlayBtn` (`search.js:15`) vrací prázdný řetězec pro
`playlist | show | artist`, takže interpret nemá play ani na hrdince top výsledku,
ani na kartě. Na Spotify má hrdinka play **vždy** a je to nejpoužívanější prvek
vyhledávání.

Oprava: povolit tlačítko pro `type === 'artist'` **na hrdince**; klik natáhne
`/api/artist/{id}/top` (endpoint už používá detail interpreta) a předá výsledek do
`playTracks`. Na kartách v mřížce to zatím nech — zdůvodni, proč (hrdinka je jeden
prvek, mřížka by znamenala další síťové volání na každé klepnutí).

### P1 — nové znění

Třída na `#playerBar` nebo na `body`, kterou nastavuje **výhradně**
`openQueuePanel` a ruší `closeQueuePanel` (`queue.js:213-231`), `z-index: 250`.
**Zakazuje se** selektor odvozený od `.queue-backdrop` — ten backdrop je sdílený
s panelem fronty uvnitř velkého přehrávače a lišta by vylezla nad něj.

### P2 — nové znění

1. **Líné vyhodnocení.** Drž zásobník už přehraných indexů (pro Previous) a
   množinu nepřehraných. Při každém `_nextTrackInQueue`: kdykoli se změní
   `store.playerQueue.length`, dopočítej permutaci **ocasu** z nepřehraných
   indexů (Fisher–Yates jen přes ně), nepřestavuj celou.
2. **`data-qi` zůstává indexem do `store.playerQueue`.** Permutace mění **jen
   pořadí, v jakém se řádky vkládají do panelu**, nikdy hodnotu `data-qi`.
   Tohle je bezpečnostní podmínka, ne estetická: křížek na řádku posílá `index`
   až na **server** do playlistu uživatele na Navidrome. Permutovaný `data-qi` by
   smazal cizí skladbu.
3. **Precedence shuffle nad smart queue zůstává** (`player_v3.js:1242-1248`).
   Nález #19 reportu přehrávače („shuffle tiše vypne Smart Queue") se v téhle
   dávce **neřeší** — napiš do evidence, že větev byla přepsána se zachovanou
   precedencí a nález zůstává otevřený.

### P3 / P4 — nové znění

Šev, který zadání hledalo, **neexistuje**: `playNextRec()` vrací `boolean` a
přehrávání spouští sám (`recommendations.js:163-173`). Správné místo zásahu je
**`playRecTrack(item)`** — `player.js:389`, totéž v `player_v3.js` — a jeho větev
pro remote už dnes dělá skoro přesně to, co P3 žádá.

Povinné podmínky:

1. **`store.playerQueue.push(item)`, nikdy `concat`.** `_growLiveQueue`
   v `search.js` testuje **identitu pole** (`store.playerQueue !== ctx`); výměna
   pole by **tiše vypnula** doplňování fronty z vyhledávání (commit `134ea6e`).
2. Do fronty přidávej **jen když volání přišlo z `_nextTrackInQueue`** — ne
   z panelu doporučení (`playRecIndex`) a ne z `playPrevRec`.
3. `prevTrack()` se dnes větví podle `isPlayingRec()` (`player.js:465-472`) —
   jakmile je doporučení ve frontě, Previous už nesmí chodit do `playPrevRec`.
4. **Strop ocasu: nejvýš 20 automaticky doplněných skladeb** za oddělovačem
   „Autoplay". Při překročení uřízni ze začátku autoplay ocasu a posuň
   `playerIndex`. Bez stropu fronta roste donekonečna a `saveQueueNow` ji celou
   PUTuje na server při každé změně.
5. Když doporučovač nic nevrátí, **hláška, ne ticho**.

### P7 / P16 — pořadí

P7 (skrýt `.qi-bpm` a `.qi-remove` pod 640 px) má přednost. **P16 se proto ověřuje
jen na 1024x768 a 1280x900**; do evidence napiš „na 390 px neprovokováno —
`.qi-bpm` je podle P7 skrytý". `.qi-remove` skryj **jen vizuálně** (`display:none`),
prvek nech v DOM.

### P8 — upřesnění místa

Měň **výhradně** stráž na `fullplayer.js:561` (gesto nahoru = fronta). Stráž na
`:504` (švihnutí dolů = zavřít přehrávač) zůstává i s `button` — ta má
`preventDefault` a vypuštění `button` by z ní klepnutí skutečně ukradlo.

### P15 — nové znění

Tlačítko zůstává. Když `_isDjEngine()` je false, nadpis zásuvky je **„Player"** a
popisek tlačítka **„Player settings"**.
Kontrola: s `ms_player_engine=classic` má zásuvka nadpis „Player" a obsahuje
viditelný `select` enginu; na starém kódu je nadpis „Live DJ Controls".

### N1 — nové znění (tři díly, všechny povinné)

1. **Záměna testu** na `offsetParent !== null` ve **všech osmi větvích** —
   správný rozsah je **`router.js:141-148`**, ne 144-150 (citace v zadání
   vynechávala `#playlistDetail`, `#showDetail`, `#podcastEpisodes` a naopak
   zabírala guard).
2. **Reset vrstev ve `switchPage` je povinný**, ne „zvaž" — správný rozsah je
   **`router.js:67-75`**. Vyjmenuj všech osm: `#playlistDetail`, `#showDetail`,
   `#podcastEpisodes`, `#tagDetailView`, `#artistDetail`, `#albumDetail`,
   `#libraryDetail`, `#likedSongsDetail`.
3. **Větev pro osiřelý stav** `{layer:…}` bez `page` (viz tabulka voleb).
   Bez ní **oprava nesplní vlastní přejímací kritérium**: kritika změřila, že po
   samotné záměně testu je v okamžiku Zpět `offsetParent` null u všech osmi vrstev,
   popnutý stav je `{layer:…}` bez `.page`, handler neudělá nic a Zpět je
   spolknuté znovu.

**Třetí tvrzení do kontroly:** po Zpět má všech osm vrstev
`style.display === 'none'`. Bez něj projde i oprava, která Zpět spraví, ale
`#artistDetail` nechá označený jako viditelný.

### N2 — nové znění

1. **Zásobník `store.dialogStack`.** Každý modál při otevření zapíše
   `{ cancel }`, při zavření odebere. Větev v `handlePopstate` vezme **poslední**
   položku a zavolá její `cancel`, která **vyřeší Promise**.
2. **Větev dialogu je PRVNÍ** v `handlePopstate`, hned za `store._ignorePopstate`
   — tedy **nad** `store.fpQueuePanelOpen` (`router.js:132`). Dnešní catch-all je
   až pod pěti příznaky překryvů, takže by Zpět zavřelo frontu **pod** modálem a
   modál nechalo viset. Změřeno.
3. **Cancel cesty neexistují, musíš je vytvořit.** `showPlaylistPicker`
   (`utils.js:177-271`) nemá pojmenovanou cancel cestu vůbec — zavírá se třikrát
   opakovaným inline `overlay.remove(); resolve(...)` — a jako jediný ze čtyř nemá
   ani obsluhu Escape; doplň ji. U `showInputModal`, `showPlaylistFormModal` a
   `showConfirmModal` funkce `done()` existuje, ale je to **lokální closure uvnitř
   Promise konstruktoru**, takže z routeru na ni není sahu — vytáhni ji ven.
   Totéž `_openModal` ve `feedback.js`.
4. **Žádný modál se neotevírá dvakrát.** Otevírací cesta se na začátku zkratuje,
   pokud je její položka už v zásobníku. Totéž `openParty()`.
5. Kontrola musí obsahovat **zanoření**: picker → „+ New playlist" → Zpět zavře
   jen vnitřní input modál a picker zůstane.

### N3 — nové znění

1. **Nové tlačítko nesmí volat holé `logout()`.** Kritika změřila, že po dnešním
   odhlášení **hraje dál hudba** (`currentTime` 39,6 → 44,7 → 48,7 s), systémová
   notifikace přes `mediaSession` dál ukazuje skladbu odhlášeného uživatele, a
   v localStorage zůstane `ms_recent_searches`. Dnes to nevadí jen proto, že je
   `logout()` na telefonu nedosažitelný — dávka by z bezpečného východu udělala
   nebezpečný.
   Povinný tvar: `await flushQueue()` (`player.js:549`) **před** vynulováním
   `store.currentUser`, pak smazat `ms_token`, `ms_recent_searches*`,
   `ms_party_session`, `ms_recs_feedback_v1`, pak `location.href = '/'`.
   `ms_device_id`, `ms_player_engine` a `ms_dj_*` **nech být**.
   Opravenou cestou projde **i stávající `#logoutBtn`**, ne jen nové tlačítko.
2. **Id neexistuje.** `#settings-account` v repu není; soubor
   `63-settings-account.html` obsahuje `<details id="spotifySection">` se štítkem
   „Account" a `<details id="desktopAppSection">` se štítkem „App". Takže:
   změnit text `.setting-section-label` uvnitř `#spotifySection` na „Spotify" a
   novou sekci Account vložit **před** něj.
3. **Nová sekce dostane `open`.**
4. **Navěs v `auth.js init()`** vedle `$('#logoutBtn')` — `settings.js` na seznamu
   celku 3 není. Jméno je v `store.currentUser.username`.
5. **Kontrola na 1024x768:** po dávce jsou tři cesty ven — `#logoutBtn` v horní
   liště, nové Log out v sekci Account a `#clearCacheBtn` v sekci App. První dvě
   musí dělat **totéž** (obě projít opravenou cestou); třetí zůstává destruktivní
   a musí být vizuálně odlišená.

### N5 — nové znění

1. **Dva toasty, ne jeden.** `#bpmActionToast` (`bpm.js:365-382`) má znakově
   totožnou geometrii. **`static/js/bpm.js` se přidává na seznam celku 3** s jedinou
   povolenou změnou: smazat `_showAnalyzeToast` a nahradit ho voláním
   `showToast(msg, false, { actionLabel: 'Analyze', onAction })` — `showToast` tu
   schopnost od `utils.js:77-79` má, komentář v `bpm.js:364` je zastaralý.
2. **Kontrola platí jen s aktivní lištou přehrávače.** Bez hrající skladby je na
   390 px mezi toastem a navigací 8 px — kontrola by na starém kódu neprošla jako
   červená. Podmínka: `document.body.classList.contains('player-active') === true`.
3. CSS do nového `static/css/toast.css`, `<link>` do `00-head.html`
   **s `?v=__CACHE_BUST__`**. V pravidlech drž i `z-index: 999`.
   Pozor: `showToast` zapisuje inline styly na šesti místech (`:88`, `:92-100`,
   `:104-105`, `:110`, `:119`, `:122-123`) — po přesunu geometrie nesmí zbylé
   zápisy pravidlo přebít.

### N7 — upřesnění

1. Implementuj jako **přeskočení uvnitř cyklu**, ne jako předčasný návrat:
   `if size matches and #text and PLACEHOLDER not in text: return text`, po cyklech
   `return ""`. Jinak by placeholder v `extralarge` zahodil skutečný obal
   v `large`.
2. **Čtvrtý test:** placeholder v `extralarge` + skutečný obal v `large` → vrátí
   ten skutečný.
3. Do evidence dvě věty: `_pick_image` se volá u šesti funkcí, ale mimo Discover
   její výstup spotřebovává jen `radio.py`, který pole `image` **nečte** (0 výskytů)
   — dopad je omezen na `/api/discover/tag`. Placeholder je **jediný**: 2392
   výskytů proti nule jiných kandidátů.

### N9 — kontrola rozdělená podle rozlišení

`autoFocus` se sám zkratuje, když není `pointer: fine` (`utils.js:149-155`) — a to
je **správně**, klávesnice se na telefonu vytahovat nemá. Kontrola tedy:
- 1280x900: po načtení `document.activeElement.id === 'loginUser'`;
- 390x844 s dotykovým profilem: `activeElement` zůstává tělo.
Druhá věta je **požadavek**, ne výjimka — ať to někdo později „neopraví".

### N4 — upřesnění

`closeParty(fromPopstate)` — `historyBack()` jen když `!fromPopstate`, stejný
kontrakt jako `closeQueuePanel`/`closeFullPlayer`. `#partyBtn` bydlí v
`#pageSearch`, takže kontrola musí běžet na stránce Search.

### N14 — NOVÝ bod (celek 3): větev žánrové vrstvy v routeru

Viz S5. `handlePopstate` dostane větev pro `store.genreOpen`, která zavolá
`closeGenre(true)` ze `search.js`. Pořadí: nad catch-allem na `.modal-overlay`,
pod větví dialogů a pod vrstvami detailu.

---

## D. Sdílené kontrakty (platí napříč celky, formulace musí být identická)

1. **Viditelnost vrstvy uvnitř stránky se testuje `offsetParent !== null`, nikdy
   `style.display`.** Zavádí to celek 1 (S2) i celek 3 (N1) nezávisle.
   **Výhrada, bez které je pravidlo nepravdivé:** platí jen pro staticky nebo
   relativně pozicované prvky. U `position: fixed` je `offsetParent` **vždy**
   `null`, i když je prvek plně vidět — tam se viditelnost řídí vlastním příznakem
   ve `store` (jako `store.queuePanelOpen`). `position: sticky` je v pořádku.
   V repu je 14 CSS pravidel a 11 inline míst s `position: fixed`.
2. **`store.playerQueue` se rozšiřuje `push`, nikdy `concat`** — `search.js`
   testuje identitu pole a výměna tiše vypne doplňování fronty z vyhledávání.
3. **`.recent-*` pravidla:** dnes bydlí v inline `<style>` v `00-head.html:80-93`,
   tedy **za** `<link>` tagy — při stejné specificitě vyhrají nad čímkoli
   v `search.css`. **Celek 3 je při své úpravě toho souboru smaže**, celek 1 je
   zapíše do `search.css`. Pořadí merge řídí vedení.
4. **Zástupný obrázek providera je platná URL, která se načte.** Detekuje se podle
   tvaru adresy, ne podle prázdnosti pole. Platí pro Deezer (S6) i Last.fm (N7).

---

## E. Doplněná pravidla měření a bezpečnosti

1. **Oracle má tři kroky, ne dva.** Červená proti produkci sama o sobě nedokazuje
   nic — padá i při překlepu v selektoru. Autor proto musí **předvést zelenou na
   téže stránce**: vložit navrhovaný kód do živé stránky přes
   `page.addInitScript` / `page.evaluate` a ukázat, že tatáž kontrola v tomtéž
   běhu zezelená. Kritika si to vyzkoušela na P8 a funguje to.
2. **Čísla řádků v zadání jsou razítkovaná proti staršímu stavu.** Šest citací
   nesedí na HEAD (mezitím přibyly commity `134ea6e`, `7fa00de`, `d1d9ffb`).
   **Každou citaci si před zásahem ověř proti HEAD.** Opravené citace celku 3 jsou
   v sekci C; pro ostatní platí: ověř, pak teprve editoval.
3. **Cache bust.** `entrypoint.sh` razítkuje jen `/app/static/index.html` a jen
   importy v **jednoduchých** uvozovkách (`s/\.js'/\.js?v=…/g`). Tedy: každý nový
   `<link rel="stylesheet">` nese `?v=__CACHE_BUST__`; dynamické importy piš
   jednoduchými uvozovkami.
4. **V kontextovém menu klikej výhradně přes text položky**
   (`text=Add to other playlist`), **nikdy přes pozici** — vedle je „Download",
   který na produkci skutečně stahuje.
5. **Modál zpětné vazby se smí otevřít a zavřít, Send se nemačká** — zakládá
   skutečnou issue v `lucashanak/music-seeker`.
6. **Hradlo generovaného souboru.** Autor smí ve svém worktree spustit
   `scripts/build-index.sh`; výsledek ověř `scripts/check-index.sh` a návratový kód
   načti **samostatným během** (`cmd > out 2>&1; rc=$?`), ne přes rouru.

---

## F. Nálezy pro další dávku (nezapomenout, neřeší se tady)

- `.ctx-menu` (`z-index: 10000`) je nejvrchnější překryv v aplikaci, otevře se
  dlouhým stiskem odkudkoli a Zpět ho nezavírá — stejný nález jako N2 a N4.
  Vyžaduje `contextmenu.js`, který v téhle dávce nikdo nevlastní.
- Party relace po zavření překryvu běží dál bez jakéhokoli indikátoru.
- `store._ignorePopstate` je booleovský proti rostoucímu počtu vrstev; při rychlém
  dvojím Zpět může jeden stisk propadnout. Povýšit na počitadlo.
- `playRadio` / rádio doplňuje frontu přes `concat` (`player.js:357`,
  `player_v3.js:1338`) — stejná vada jako P3, mimo rozsah téhle dávky.
- Nález #19 reportu přehrávače: shuffle tiše vypíná Smart Queue.
- `aria-label`/`title` plovoucího tlačítka zpětné vazby říkají natvrdo
  „Report a bug or request a feature".
- `/api/search` nevrací `errors` → jednotypové taby nemají co zobrazit při výpadku.

---

## G. Nasazení a úklid

Všechny tři celky se nasazují **jedním buildem**, ne třemi. Po nasazení
`sudo docker builder prune -af` a do evidence `df -h /` před a po — na 63GB
kořenovém disku zůstává po každém rebuildu ~5 GB build cache a při zaplnění umře
přehrávání Jellyfinu na témže serveru.
