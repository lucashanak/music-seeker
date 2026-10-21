# Oprava 4 — celek 3: globální navigace a chrome

Autor, worktree `/home/lucas/music-seeker-wt/oprava-4-c3-navigace`, 21. 10. 2026.
Necommitováno, nenasazeno. Podklady: `oprava-4-dodatek-po-kritice.md` (přednost),
`oprava-4-zadani.md`, `notes/impl/audit-2026-10/nav.md`.

## Jak se to měřilo

Oracle má tři kroky a všechny tři jsou v jednom souboru,
`tests/e2e/audit/nav.mjs` nad `tests/e2e/audit/helpers.mjs` (postroj needitován):

```
node tests/e2e/audit/nav.mjs              → proti produkci 1.25.2, musí PADAT
MS_PATCH=1 node tests/e2e/audit/nav.mjs   → s opravou v živé stránce, musí PROJÍT
```

`MS_PATCH=1` podstrčí do té **stejné živé stránky** přes `page.route` sedm
souborů z tohohle worktree (`router.js`, `utils.js`, `auth.js`, `party.js`,
`feedback.js`, `recognize.js`, `bpm.js`), tři CSS a nový `toast.css`, a na
produkční dokument aplikuje přesně ty záměny, které dělají partialy — markup se
čte **ze samotných partialů**, ne opisuje.

**Proč je to poctivá zelená, a ne jiný build:** ověřeno bajtově, že všech sedm
JS souborů na HEADu je identických s nasazenými, až na razítko importů, které
píše `entrypoint.sh` (`.js'` → `.js?v=1792608207'`). Postroj totéž razítko
aplikuje, takže se moduly rozpustí na stejné URL a sdílejí tentýž `store` —
jiné razítko by vyrobilo druhou kopii modulu s vlastním stavem. Rozdíl mezi
červeným a zeleným během je tedy **přesně tahle oprava**, nic víc.

Tři rozlišení, obě dráhy, účet `claude_test`, `ms_device_id=e2e-autor-4-c3`:

| běh | telefon 390x844 | tablet 1024x768 | desktop 1280x900 |
|---|---|---|---|
| proti produkci | 23 padlo, 2 prošlo | 22 padlo, 4 prošlo | 23 padlo, 3 prošlo |
| s opravou | **29 prošlo, 0 padlo** | **30 prošlo, 0 padlo** | **30 prošlo, 0 padlo** |

Výstupy: `scratchpad/autor-4-c3/{red,green}_{phone,tablet,desktop*}.txt`.
Návratové kódy čteny samostatným během (`cmd > out 2>&1; rc=$?`).

Sada: `python3 -m pytest tests/ -q` → **82 passed, 3 skipped** (výchozí 78+3,
přibyly 4 nové v `tests/test_lastfm_image.py`), `node --test
tests/js/bpm_client.test.mjs` → 10 pass, 0 fail. `scripts/build-index.sh`
spuštěn, `scripts/check-index.sh` rc=0.

## Bod po bodu

Citace řádků ověřeny proti HEADu před zásahem; opravené rozsahy z dodatku
(`router.js:141-148`, `router.js:67-75`, `utils.js:177-271`, `utils.js:379`,
`bpm.js:365-382`, `feedback.js:215`) seděly, čísla ze zadání ne.

### N1 — Zpět je spolknuté nebo přeskočí úroveň

Tři díly, všechny: (1) osm větví v `handlePopstate` testuje
`offsetParent !== null` místo `style.display`; (2) `switchPage` zhasíná všech
osm vrstev ze seznamu `LAYER_IDS`; (3) větev pro osiřelý `{layer}` bez `page`
dělá `history.back()` s počitadlem `layerHops` (strop 16, pak `replaceState` +
`switchPage` na aktuální stránku).

| kontrola | červená na produkci | zelená s opravou |
|---|---|---|
| `N1a` Discover → tag → Library → Zpět | `onDiscover=false onLibrary=true state={"layer":"tagDetail"}` | `onDiscover=true onLibrary=false state={"page":"discover"}` |
| `N1b` Search → interpret → Settings → Zpět | `state={"layer":"artistDetail"}` (obrazovka a historie se rozešly) | `state={"page":"search"}`, na obrazovce výsledky |
| `N1c` vrstva nepřežije odchod ze stránky | `stale=#artistDetail[display=(unset),onScreen=true]` | `stale=none` |

`N1c` je ta třetí věta z dodatku, ale měřená tam, kde ji produkce skutečně
poruší: po Search → interpret → Library → Search zůstává `#artistDetail`
**na obrazovce** přes výsledky. Ve variantě „po Zpět" je produkce náhodou čistá
(`closeArtistDetail` tu jednu vrstvu zhasne sama), takže by to nebyla červená.

**Zvolený výklad N1b:** jeden stisk vrací na **Search s výsledky**, ne na
otevřený detail interpreta. Tak to rozhodl dodatek („jeden stisk, správná
stránka, souhlasící `history.state`") a je to konzistentní s třetí větou, která
po Zpět chce všech osm vrstev zhasnutých.

### N2 — modály nezakládají historii a nevyřeší svůj Promise

`store.dialogStack` (LIFO `{kind, cancel}`), `pushDialog`/`popDialog`/`dialogOpen`
v `utils.js`. Větev dialogů je **první** v `handlePopstate`, hned za
`_ignorePopstate`. Cancel cesty vyrobeny u všech čtyř modálů (`done` vytažen
z closure ven) i u `feedback._openModal`; `showPlaylistPicker` dostal poprvé
obsluhu Escape a jedinou cestu ven místo tří inline `overlay.remove()`.

| kontrola | červená | zelená |
|---|---|---|
| `N2a` dialog je vlastní položka historie | `state={"page":"library"}` | `state={"layer":"dialog"}` |
| `N2b` Zpět zavře dialog a nechá stránku | `before={"page":"library"} after={"page":"search"}` | `after={"page":"library"}` |
| `N2c` čekaný Promise se vyřeší | `settled=false` | `settled=true value=false` |
| `N2d` zanoření picker → input | `{n:1,picker:false,input:true}` (zavřel se spodní) | `{n:1,picker:true,input:false}` |
| `N2e` Escape v pickeru | `overlays=1` (žádná obsluha) | `overlays=0 settled=true` |
| `N2f` dvojí otevření téhož modálu | `overlays=2` | `overlays=1` |

**Proč `store.dialogStack` vzniká v `utils.js`:** `store.js` není na seznamu
souborů tohohle celku a zásobník stejně nikdo jiný nezapisuje — router z něj
jen čte vršek.

### N3 — na telefonu se nedá odhlásit

Nové `logout()` je **async** a nevolá holý teardown: `await flushQueue()` ještě
s nastaveným `store.currentUser`, pak smazání `ms_token`, `ms_party_session`,
`ms_recs_feedback_v1` a všeho s prefixem `ms_recent_searches`, pak
`location.href = '/'`. `ms_device_id`, `ms_player_engine`, `ms_dj_*` zůstávají.
Touto cestou jde i stávající `#logoutBtn`. Nová sekce `#accountSection` je
v `63-settings-account.html` **před** `#spotifySection` a je `open`; štítek
`#spotifySection` přejmenován z „Account" na „Spotify". Navěšeno v `auth.js
init()`.

| kontrola | červená | zelená |
|---|---|---|
| `N3a` prosté „Log out" na obrazovce | `tlačítek=0` (všechna tři rozlišení) | `tlačítek=1` |
| `N3b` je vidět, kdo je přihlášený (390 px) | `prvků=0 šířka=0px` | `prvků=1 šířka=173px` |
| `N3c` destruktivní reset je odlišený | `#clearCacheBtn color=rgb(238,238,245)` | `rgb(239,68,68)` = `--red` |
| `N3e` po odhlášení nezůstanou data | — | `ms_token=null ms_recent_searches=null ms_party_session=null` |
| `N3f` zařízení si nechá identitu | — | `ms_device_id=e2e-autor-4-c3` |
| `N3h` horní lišta jde toutéž cestou (tablet) | `audio=playing@13.6 ms_recent_searches=["daft punk","oracle"]` | `audio=paused ms_recent_searches=null` |

`N3h` je ta červená, kterou kritika popsala: na produkci po odhlášení **hraje
dál hudba** (13,6 s proti 7,6 s před stiskem) a historie hledání předchozího
uživatele zůstane v prohlížeči.

### N4 — Party ignoruje Zpět

`openParty` dělá `pushState({layer:'party'})` a nastaví `store.partyOpen`;
`closeParty(fromPopstate)` je exportovaná a volá `historyBack()` jen když
`!fromPopstate`. Větev v routeru je mezi příznaky překryvů. **Relaci Zpět
nezastavuje** — chová se přesně jako křížek, podle rozhodnutí v dodatku.

Červená: `overlayShown=true`, položka historie `{"layer":"artistDetail"}` (žádná
vlastní). Zelená: `state={"layer":"party"}` při otevření, po Zpět
`overlayShown=false onSearch=true state={"page":"search"}`.

### N5 — toast překrýval spodní navigaci

Dva toasty sloučeny do jednoho: `#bpmActionToast` z `bpm.js` smazán a nahrazen
`showToast(msg, false, { actionLabel: 'Analyze', duration: 5000, onAction })`.
Geometrie přesunuta z inline `bottom:80px` (`utils.js:88`) do nového
`static/css/toast.css`, `<link>` v `00-head.html` nese `?v=__CACHE_BUST__`.
V `utils.js` po přesunu zůstává inline jen `opacity` (přepíná se na zprávu),
`display` a barvy — nic z toho pravidlo nepřebije.

Měřeno s `body.player-active`, jak dodatek žádá:

| rozlišení | červená | zelená |
|---|---|---|
| 390x844 | `toastBottom=764 navTop=705` → **mezera −59 px** | `toastBottom=688` → mezera **17 px** |
| 1024x768 | `playerBarTop=700` mezera 12 px (neprovokováno) | mezera 16 px |
| 1280x900 | `playerBarTop=832` mezera 12 px (neprovokováno) | mezera 16 px |

Nad 640 px je vada neprovokovaná: `bottom:80px` tam 68px lištu přehrávače
odžene. Kontrola tam slouží jako pojistka proti regresi a hlídá i to, že se
toast nezvedl zbytečně vysoko (16 px místo 12 px, ne víc).

### N6 — potvrzovací dialog měl fokus na „Delete"

U `danger` je fokus na `.confirm-cancel` a Enter mapuje na `done(!danger)`,
tedy na zrušení. Pořadí tlačítek nezměněno.
Červená: `activeElement=.confirm-ok`, Enter → `value=true`.
Zelená: `.confirm-cancel`, Enter → `value=false`.
`N6c` hlídá, že u nedestruktivního dialogu Enter dál potvrzuje — prochází
v obou bězích.

### N7 — šedá hvězda Last.fm

`_pick_image` **přeskakuje uvnitř cyklu** (`if size matches and #text and
PLACEHOLDER not in text: return text`, po cyklech `return ""`), takže
placeholder v `extralarge` nezahodí skutečný obal v `large`.

`tests/test_lastfm_image.py`, čtyři testy včetně čtvrtého z dodatku. Mutace:
odstranění podmínky → 2 failed; obrácení podmínky → 3 failed; návrat → 4 passed.
V prohlížeči: `20/20` karet na stránce tagu má placeholder → `0/20`.

**Rozsah dopadu:** `_pick_image` se volá u šesti funkcí, ale mimo Discover její
výstup spotřebovává jen `radio.py`, který pole `image` nečte (0 výskytů) — dopad
je omezen na `/api/discover/tag`. Placeholder je jediný: 2392 výskytů proti nule
jiných kandidátů.

### N8 — `<html lang>`

`cs` → `en`, plus tři administrátorské tooltipy v `64-settings-admin.html`
přeloženy. Červená `lang=cs`, zelená `lang=en`.

### N9 — přihlašovací obrazovka

`autoFocus($('#loginUser'))` na konci `auth.js init()` ve větvi bez tokenu, plus
`.login-meta` v `10-login.html` (název instance z `location.host` + „Stays
signed in for 30 days"). Chybová hláška nezměněna.

Kontrola je rozdělená podle ukazatele, jak dodatek žádá, a **obě půlky jsou
požadavek**: s `pointer: fine` (1280x900) musí být `activeElement=loginUser`,
bez něj (390x844 i 1024x768, oba dotykové) musí zůstat `BODY` — klávesnice se
na dotyku vytahovat nemá.
Červená na desktopu: `activeElement=BODY`. Zelená: `loginUser`.
`#loginInstance` červená `""` → zelená `"musicseeker.hanaktech.org"`.

### N10 — syrové hlášky mikrofonu

`micErrorMessage(e)` mapuje `NotAllowedError`/`SecurityError` →
„Microphone blocked — allow it in your browser's site settings",
`NotFoundError`/`DevicesNotFoundError` → „No microphone found", jinak původní
text. Použito na obou místech, kde `recognize.js` hlásí `Mic error:`.
`classifyRecognizeError` (serverové chyby) nezměněn.

Červená: `#micStatus="Mic error: Requested device not found"`. Zelená:
`"Mic error: No microphone found"`. Kontejner nemá záznamové zařízení, takže
prohlížeč vrací `NotFoundError`, ne `NotAllowedError` — kontrola proto přijímá
obě namapované věty a odmítá cokoli jiného.

### N11 — zakázané „Save to playlist" vypadalo aktivně

Barvy tlačítka přesunuty z inline stylu do vloženého `<style>` bloku party
překryvu, kde na ně `:disabled` dosáhne.
Červená: `background=rgb(162,230,64)` = `--accent` při `disabled=true`.
Zelená: `rgb(28,28,46)`.

### N12 — ŠKRTNUTO

Neděláno. Premisa neplatí, titulek se přepíná správně.

### N13 — bledé plovoucí tlačítko zpětné vazby

`opacity: .55` → `.85`, hover/fokus dál na 1.
Červená `opacity=0.55`, zelená `0.85`.

### N14 — větev žánrové vrstvy — ZELENOU NELZE VYROBIT SAMOSTATNĚ

Větev je napsaná a stojí přesně tam, kde ji dodatek chce: **pod** vrstvami
detailu, **nad** catch-allem na `.modal-overlay`, pod větví dialogů. Volá
`closeGenre(true)` ze `search.js` a vlastní `closeGenre` jsem **nepsal**.

Dvě věci k tomu:

1. **Import je dynamický** (`import('./search.js').then(m => m.closeGenre && …)`),
   ne doplnění jména do statického importu na `router.js:8`. Statický
   pojmenovaný import neexistujícího exportu je chyba při linkování modulu —
   shodila by **celou aplikaci** při načtení, dokud celek 1 nepřistane. Takhle
   je větev do té doby neškodná. `search.js` už v grafu je, takže dynamický
   import nestojí další stažení a rozpustí se na tentýž modul.
2. **Kontrola je v `nav.mjs` jako `skip` s důvodem.** Oracle pro ni vyrobit
   nejde: `store.genreOpen` nastavuje `openGenre` z celku 1, takže na dnešním
   kódu větev není z UI dosažitelná a obě verze se chovají **shodně** (Zpět je
   v žebříčku netečné). Jediný způsob, jak zelenou vynutit, by bylo dopsat si
   `closeGenre` — což dodatek výslovně zakazuje. **Bod tedy nemá všechny tři
   kroky a je takto odevzdán; dokončí ho přejímka po merge celku 1.**
   Ověřeno aspoň to, že větev nic nerozbíjí: 30 kontrol zelených s ní v kódu.

## Přiznané meze

- **N14 nemá zelenou** (viz výš). Jediný bod zadání, který neodevzdávám
  s kompletním oracle.
- **N1b nevrací na otevřený detail interpreta**, vrací na Search s výsledky.
  Dodatek to tak rozhodl; kdo čekal „Zpět ze Settings obnoví detail", dostane
  jiné chování, než si možná představoval. Router nemá záznam o tom, které
  stránce vrstva patří — doplnit by znamenalo rozšířit `{layer}` o `page`, což
  je zásah do osmi modulů mimo tenhle celek.
- **Catch-all na `.modal-overlay` se posunul pod vrstvy detailu** (dodatek to
  u N14 vyžaduje). Pro dialogy ze `settings.js` a `playlistimport.js` to teoreticky
  znamená, že při současně otevřeném detailu by Zpět zavřelo detail místo
  dialogu. Prakticky nenastává: ty dialogy žijí na Settings (kde mají všechny
  vrstvy `offsetParent === null`) a nad výsledky hledání, kde detail překrývá
  prvek, kterým se otevírají. Neměřeno přímo — je to přiznaná mez, ne doklad.
- **`store._ignorePopstate` zůstává booleovský**, jak ho dodatek v seznamu pro
  další dávku nechává. Při velmi rychlém dvojím Zpět může jeden stisk propadnout.
  Můj počitadlový hop v osiřelé větvi stojí vedle něj a nenahrazuje ho.
- **`responsive.css` jsem nakonec nezměnil.** Zadání ho povolovalo pro geometrii
  toastu, dodatek ji ale posílá do nového `toast.css` — a mobilní breakpoint
  toastu patří k ostatním pravidlům toastu, ne mezi cizí. Soubor je tedy na
  seznamu povolených, ale beze změny.
- **`store.js` jsem nesměl měnit**, takže tři nové příznaky (`dialogStack`,
  `partyOpen`, a čtený `genreOpen`) vznikají za běhu. Patří do `store.js`
  k `queuePanelOpen`; vedení ať to po merge srovná.
- **Kontrola N1 neprochází přes skutečné hardwarové Zpět**, ale přes
  `page.goBack()`. Je to tentýž `popstate`, ale ne tentýž vstup.
- **N3b na 1024x768 a 1280x900 prochází i na produkci** — tam je horní lišta
  vidět a `#navUsername` má 70 px. Vada je výhradně telefonní, červená je na
  390 px.
- **N5 je nad 640 px neprovokovaná** (viz tabulka). Napsáno i v kontrole.

## Co jinak a proč

- **N14 dynamickým importem místo statického** — viz výš, jinak by neexistující
  export shodil aplikaci.
- **N1c měřeno jinou sekvencí, než zadání napovídalo.** „Po Zpět mají všechny
  vrstvy `display:none`" je na produkci po té konkrétní sekvenci náhodou
  pravda, takže by to nebyla červená a nedokazovalo by to nic. Sekvence
  Search → interpret → Library → Search tutéž vadu ukazuje jako červenou
  (`onScreen=true`) a měří přesně to, co opravuje povinný reset ve `switchPage`.
- **N10 přijímá dvě věty, ne jednu.** Headless kontejner nemá záznamové
  zařízení, takže prohlížeč vrací `NotFoundError`. Kontrola trvá na tom, že
  hláška je jedna ze dvou namapovaných, a odmítá syrový text prohlížeče — to je
  to, co se opravovalo.
- **N5 duration 5000 ms** u obou BPM hlášek, aby zůstalo chování smazaného
  `_showAnalyzeToast` (výchozí `showToast` je 2000 ms).
- **N3: `#clearCacheBtn` překreslen do `--red`.** Dodatek žádá, aby byl
  destruktivní východ „vizuálně odlišený"; po přidání neutrálního „Log out"
  vypadala obě tlačítka stejně.
- **N9 má navíc řádek o 30 dnech.** Zadání ho uvádí mezi vadami, oprava ho
  nezmiňuje; je to jeden `<span>` vedle názvu instance.
- **Oprava se do živé stránky vkládá přes `page.route`, ne jen
  `page.addInitScript`.** Router i modály jsou uvnitř ES modulů bez globálního
  úchytu, takže náhradní posluchač by se k nim nedostal. Podstrčení sedmi
  souborů je silnější verze téhož a je doložené bajtovou shodou s produkcí.

## Co jsem na produkci udělal

Jen čtení a přehrávání. Žádné stahování, mazání, zakládání playlistů ani změna
nastavení; kontextové menu se neotevíralo vůbec, modál zpětné vazby se
neodesílal. Přehrávala se jedna skladba („Daft Punk") v každém běhu, aby byla
aktivní lišta přehrávače — to zapíše frontu a Up Next pro zařízení
`e2e-autor-4-c3`, tedy **přibyl dočasný playlist `__upnext_e2e-autor-4-c3`**
(známý nález `project_temp_playlists`). Nemažu ho, protože mazání mám zakázané;
vedení ať ho po dávce uklidí.

## Pro další dávku (nálezy mimo rozsah)

- `.ctx-menu` (`contextmenu.js`) je nejvrchnější překryv v aplikaci a jako
  jediný pořád nemá vrstvu historie ani cancel cestu.
- Dialogy v `settings.js` (3×) a `playlistimport.js` (1×) stojí mimo
  `dialogStack` a drží se posledního catch-allu.
- Běžící party relace nemá po zavření překryvu žádný indikátor.
- `aria-label`/`title` plovoucího tlačítka zpětné vazby říkají natvrdo
  „Report a bug or request a feature" (zbytek nálezu po škrtnutém N12).

---

# Druhé kolo (po review), 21. 10. 2026

Podklad: `notes/impl/oprava-4-dodatek-po-review.md`, sekce A (společná) a D (c3).
Worktree beze změny, necommitováno, nenasazeno. Účet `claude_test`,
`ms_device_id=e2e-autor2-4-c3`, výstupy ve `scratchpad/autor2-4-c3/`.

## A. Orákulum už neměří náhradu

Zelenou polovinu dělá nově **`open({ worktree })`** ze sdíleného postroje.
`nav.mjs` tím ztratil všechno vlastní podstrkávání: smazána funkce `patchHtml`
(deset textových záměn do produkčního dokumentu), `installFix` (čtyři
`page.route`) i seznamy `JS_FILES` / `CSS_FILES`. Zbyl jediný rozdíl mezi
červeným a zeleným během — **ze které kopie zdrojů si prohlížeč stáhne soubory**.

Nový přepínač `MS_TREE=<cesta>` servíruje libovolný strom; `MS_PATCH=1` je jen
zkratka za `MS_TREE=<tenhle worktree>`. Použito níž k doložení regrese R3.1.

Ověřeno, že se opravdu servíruje tenhle strom (`scratchpad/autor2-4-c3/smoke.mjs`):
`lang=en`, `toast.css` v hlavičce, `#accountSection` i `.login-meta` v dokumentu,
`router.js` nese `LAYER_IDS` a catch-all stojí nad detaily. Produkce proti tomu
hlásí `lang=cs`.

**Co z toho spadlo: nic.** Všech 29/30 bodů, které byly zelené s ručním
podstrčením, je zelených i se skutečně servírovaným stromem — kromě N7, viz
mez níž. Rozdíl je v tom, čím to je doložené, ne v číslech.

## B. R3.1 — Zpět zavíralo stránku pod otevřeným dialogem

**Potvrzeno jako skutečná vada, a jako regrese prvního kola.** Nasazený kód má
catch-all `.modal-overlay:not(#downloadModal)` **nad** větvemi detailů; první
kolo ho posunulo pod ně.

**Zvolená oprava: vrátit kontrolu nad bloky detailů** (`router.js:170-180`),
větev `store.dialogStack` zůstává první. Druhou nabízenou cestu — dotáhnout
zbývající překryvy do `dialogStack` a ruční `querySelector` zrušit — jsem
**nemohl vzít**: ty čtyři dialogy žijí v `settings.js` (3×) a
`playlistimport.js` (1×) a ani jeden z těch souborů není na seznamu, který smí
tenhle celek měnit („Soubory: … **Nic jiného**"). Zůstává to jako nález pro
další dávku, tak jak to první kolo zapsalo.

Umístění je navíc správné i podle vrstvení: `.modal-overlay` je `z-index: 200`,
tedy nad každou vrstvou uvnitř stránky. Zároveň **pod** příznakovými překryvy,
které jsou výš (velký přehrávač 201, panely fronty 249/250, party 1000) — proto
stojí až za nimi, ne hned za `dialogStack`. Žánrová větev N14 tím klesla **pod**
catch-all; to je úmyslné a podle vrstvení správné: dialog nakreslený přes celou
stránku má zhasnout dřív než žebříček uvnitř `#searchResults`. Ostatní dvě
podmínky N14 z dodatku (pod větví dialogů, pod vrstvami detailu) platí beze změny.

Falešný poplach to není: v statickém markupu existuje jediný `.modal-overlay`,
a to `#downloadModal`, který je ze selektoru vyjmutý. Všechny ostatní vznikají
při otevření a při zavření se z DOMu odstraní — nalezený překryv je tedy
skutečně otevřený.

### Kontrola N2g (nová)

Detail interpreta na Search, nad ním **importní dialog otevřený vlastní
exportovanou funkcí aplikace** (`playlistimport.openImportModal()`, pole
ponecháno prázdné, takže se nic neimportuje), pak Zpět. Tvrdí se trojí: dialog
zmizel, detail **zůstal**, jsme pořád na Search.

| strom | 390x844 | 1024x768 | 1280x900 |
|---|---|---|---|
| **před opravou** (první kolo) | `poZpět={dialog:true,detail:false}` **FAIL** | `{dialog:true,detail:false}` **FAIL** | `{dialog:true,detail:false}` **FAIL** |
| **po opravě** (tenhle strom) | `{dialog:false,detail:true,naSearch:true}` PASS | PASS | PASS |
| produkce | PASS | PASS | PASS |

Červenou polovinu pro N2g **nedělá produkce** — ta tuhle vadu nikdy neměla.
Dělá ji servírovaný strom `scratchpad/autor2-4-c3/pred-opravou/`, což je tenhle
worktree se symlinky na všechno kromě `router.js`, kde leží verze z prvního
kola. Výstupy: `pred_opravou_N2g_phone.txt`,
`pred_opravou_N2g_tablet_desktop.txt`. Je to tedy pojistka proti regresi, ne
kontrola vady v nasazeném kódu, a je to tu napsané proto, aby si to nikdo
nespletl.

## C. R3.2 — `.recent-*`

Beze změny, jak dodatek nařizuje. Pravidla v `00-head.html` zůstávají smazaná
(0 výskytů v partialu i v `static/index.html`), nepoužitý `#recentSearches`
v `30-search.html` zůstává (1 výskyt) jako nález pro další dávku. Ověří se nad
spojeným stromem.

Vedlejší důsledek přechodu na `open({ worktree })`: dřívější zelená polovina ten
blok **vystřihávala z produkčního dokumentu řetězcovou náhradou**. Teď se servíruje
`index.html` z tohohle stromu, takže smazání je skutečné, ne předstírané.

## D. Výsledky, bod po bodu

Tři rozlišení, obě poloviny, jeden běh na rozlišení (návratový kód čten
samostatně, `cmd > out 2>&1; rc=$?`):

| běh | telefon 390x844 | tablet 1024x768 | desktop 1280x900 |
|---|---|---|---|
| proti produkci (`red_*.txt`) | 23 padlo, 3 prošlo, rc=1 | 22 padlo, 5 prošlo, rc=1 | 23 padlo, 4 prošlo, rc=1 |
| servírovaný worktree (`green_*.txt`) | **29 prošlo, 0 padlo, rc=0** | **30 prošlo, 0 padlo, rc=0** | **30 prošlo, 0 padlo, rc=0** |

Co na produkci prochází a proč to tak má být:
- `N6c` a `N2g` jsou pojistky proti regresi — na produkci zelené záměrně.
- `N9a` je na obou dotykových rozlišeních požadavek „fokus **nesmí** být
  v poli"; produkce ho splňuje tím, že nefokusuje nikde. Červená je na desktopu.
- `N5` je nad 640 px neprovokovaná (`bottom:80px` tam 68px lištu odžene,
  mezera 12 px); kontrola tam hlídá, že se toast nezvedl zbytečně vysoko.
- `N3b` na tabletu a desktopu prochází i na produkci — horní lišta je vidět.
  Vada je výhradně telefonní.

Hodnoty bodů jsou proti prvnímu kolu beze změny (`N5` telefon mezera
−59 px → +17 px, `N3c` `rgb(238,238,245)` → `rgb(239,68,68)`, `N10`
„Requested device not found" → „No microphone found", `N1a`
`state={"layer":"tagDetail"}` → `{"page":"discover"}`, …), jen jsou nově měřené
nad skutečnými soubory.

## E. Meze druhého kola

- **N7 ztratil zelenou polovinu a je přiznaný jako MEZ.** Oprava je
  v `app/services/lastfm.py`; servírovaný strom nahrazuje `static/`, server dál
  odpovídá nasazeným kódem. Zelenou by šlo koupit jedině přepsáním jeho odpovědi
  za letu — a to je přesně ta náhrada, kterou tohle kolo ruší. První kolo ji
  dělalo (`page.route` nad `/api/discover/tag/**`); **smazáno**. Živě zůstává
  20/20 karet s placeholderem na všech třech rozlišeních a to je zapsané přímo
  ve výstupu kontroly. Orákulem pravidla je `tests/test_lastfm_image.py`
  (4 testy; mutace: odstranění podmínky → 2 failed, obrácení → 3 failed,
  návrat → 4 passed). Dotáhne se při přejímce po nasazení.
- **N14 pořád nemá zelenou** — čeká na `openGenre`/`closeGenre` z celku 1.
  Beze změny proti prvnímu kolu. Nově navíc stojí pod catch-allem (viz B).
- **N2g nemá červenou proti produkci**, protože vadu zavedlo až první kolo.
  Červená je proti servírovanému stromu s předchozí verzí `router.js`.
- **Zpět se pořád mačká `page.goBack()`**, ne hardwarovým tlačítkem. Tentýž
  `popstate`, ne tentýž vstup.
- **Hover se neměří** (nad 640 px je odkryté ovládání vázané na `:hover`).
  Dotykový tablet 1024x768 je v sadě právě proto, že hover nemá; co se na něm
  dá doložit, doložené je, zbytek zůstává na přejímku.
- Ostatní meze prvního kola platí dál (`store.js` nesmím měnit, `N1b` vrací na
  Search s výsledky, `_ignorePopstate` zůstává booleovský).

## F. Sada a soubory

`python3 -m pytest tests/ -q` → **82 passed, 3 skipped**, rc=0.
`node --test tests/js/bpm_client.test.mjs` → 10 tests, 10 pass, 0 fail, rc=0.
`scripts/build-index.sh` → rc=0 („wrote static/index.html from 16 partials"),
`scripts/check-index.sh` → rc=0. Oba návratové kódy čteny samostatným během.

Změněno v tomhle kole: `static/js/router.js` (přesun catch-allu),
`tests/e2e/audit/nav.mjs` (postroj + N2g + mez u N7), tenhle soubor.
`tests/e2e/audit/helpers.mjs` needitován (vlastní vedení).

## G. Co jsem na produkci udělal

Zase jen čtení a přehrávání. Žádné stahování, mazání, zakládání playlistů ani
změna nastavení. Importní dialog se otevřel s prázdným polem a byl zavřen Zpět,
takže `runImport` neběžel. Přehrávala se jedna skladba („Daft Punk") na běh —
přibyl dočasný playlist `__upnext_e2e-autor2-4-c3` (vedle
`__upnext_e2e-autor-4-c3` z prvního kola). Mazání mám zakázané; vedení ať je
po dávce uklidí.

## H. Nové nálezy pro další dávku

- Když router zavře dialog z `playlistimport.js` svým `overlay.remove()`,
  **zůstane navěšený jeho `keydown` posluchač na `document`** a jeho Promise se
  nevyřeší. Je to tentýž kořen jako dialogy mimo `dialogStack` — spraví se tím,
  že se dotáhnou do zásobníku, ne posunem pořadí.
- Zbylé body z prvního kola platí (`.ctx-menu` bez vrstvy historie, party
  relace bez indikátoru, natvrdo psaný `aria-label` plovoucího tlačítka).
