# Oprava 4 — celek 2 (přehrávač a fronta): evidence

Worktree `oprava-4-c2-prehravac`, základ `5c5ffd6`. Body P1–P17 podle
`notes/impl/oprava-4-zadani.md` ve znění `notes/impl/oprava-4-dodatek-po-kritice.md`
(dodatek má přednost).

## Jak se měřilo

Oracle má tři kroky a všechny tři jsou v `tests/e2e/audit/player.mjs` nad sdíleným
postrojem `tests/e2e/audit/helpers.mjs` (ten jsem needitoval).

```
node tests/e2e/audit/player.mjs --vp=<phone|tablet|desktop>             # nasazený kód
node tests/e2e/audit/player.mjs --vp=<phone|tablet|desktop> --patched   # s mým kódem
```

**Zelená se předvádí vložením navrženého kódu do živé stránky.** `--patched` navěsí po
přihlášení routu, která sedm změněných souborů (`static/index.html`, `static/css/player.css`,
`static/js/{player,player_v3,queue,fullplayer,djpanel}.js`) obslouží z worktree, a stránku
načte znovu. Backend, data i účet zůstávají produkční — mění se jen těch sedm souborů.

Že to měří právě tuhle dávku, a ne rozdíl mezi produkcí a HEAD, je ověřené: nasazené
soubory jsou **bajtově shodné s HEAD** až na razítko `?v=` v dynamických importech.

```
curl -s https://musicseeker.hanaktech.org/ ⟷ git show HEAD:static/index.html        → shodné (po odstranění ?v=)
/static/js/queue.js ⟷ HEAD:static/js/queue.js                                       → shodné (po odstranění ?v=)
/static/css/player.css ⟷ HEAD:static/css/player.css                                 → bajtově shodné
```

Verze na produkci v době měření: `/api/version` → **1.25.2**. Účet `claude_test`,
`ms_device_id` = `e2e-autor-4-c2-<rozlišení>` (postroj si k názvu dráhy připíná vlastní
předponu; každé rozlišení má vlastní id, aby si tři souběžné dráhy nepřepisovaly frontu).
Engine `classic`, tj. `player.js`. Na produkci se jen četlo a přehrávalo: **nic se
nestahovalo, nemazalo, nezakládal se žádný playlist** — dočasný playlist `zz-*`, který
dávka celku 2 povoluje, nebyl potřeba a nevznikl.

### Souhrn posledního běhu

| rozlišení | nasazený kód | s mým kódem |
|---|---|---|
| 390x844 | 4 prošlo, **13 padlo**, 7 přeskočeno | **18 prošlo, 0 padlo**, 7 přeskočeno |
| 1024x768 | 4 prošlo, **14 padlo**, 6 přeskočeno | **19 prošlo, 0 padlo**, 6 přeskočeno |
| 1280x900 | 5 prošlo, **20 padlo**, 1 přeskočeno | **26 prošlo, 0 padlo**, 1 přeskočeno |

Výstupy: `scratchpad/autor-4-c2/FINAL-{prod,patched}-{phone,tablet,desktop}.txt`.
Návratové kódy čtené samostatným během (`cmd > out 2>&1; rc=$?`): prod 1/1/1, patched 0/0/0.

Body, které nejsou o rozložení (P2, P3, P4, P5, P13, P17), běží jen na 1280x900 a na
ostatních rozlišeních jsou výslovně přeskočené s důvodem. P8 je dotykové gesto, takže
na 1280x900 (bez dotyku) odpadá. P16 je na 390 px neprovokováno — `.qi-bpm` je podle
P7 skrytý.

## Bod po bodu

Čísla řádků jsou ověřená proti HEAD, ne přejatá ze zadání (zadání je razítkované
proti staršímu stavu).

### P1 — s otevřenou frontou nejde ovládat lišta
`queue.js:213-231 → openQueuePanel/closeQueuePanel`, `player.css:5` a `:166`.
Třídu `queue-open` na `#playerBar` nastavuje **výhradně** `openQueuePanel`, ruší
`closeQueuePanel`; pravidlo `.player-bar.queue-open { z-index: 250 }`. Selektor odvozený
od `.queue-backdrop` se nepoužil — backdrop je sdílený s frontou uvnitř velkého
přehrávače a lišta by vylezla nad něj (to je přesně situace, kterou opravuje P8).
- červená: `elementFromPoint` středu `#playerPlayPause` vrací `queueBackdrop`,
  Playwright klik odmítnut (`klik=false`, `paused false→false`) — všechna tři rozlišení.
- zelená: `elementFromPoint` = `playPauseIcon`, klik projde, `paused false→true`, a
  `#queuePanel.open` zůstává true (fronta se nezavřela).

### P2 — shuffle lže a Previous je rozbité
`player.js:332` (`_nextTrackInQueue`), `player_v3.js:1242`, mechanika v `queue.js` (`shuffleNext`,
`shufflePrev`, `resetShuffleOrder`, `playOrder`).
Permutace se dopočítává **líně**, jen když se změní `store.playerQueue.length`, a jen
přes nepřehrané indexy. `data-qi` zůstává indexem do `store.playerQueue`. Precedence
shuffle nad Smart Queue zůstává.
- červená: krok 1 — odehraná skladba je v panelu na 1. řádku, hrající na 62. (panel
  tvrdí jiné pořadí, než po kterém engine chodí). Pět návratů vrátí úplně jinou
  posloupnost, než jakou pět přeskoků prošlo.
- zelená: 5/5 kroků posunulo značku „hraje" přesně o jeden řádek dolů; pět návratů jde
  přesně obrácenou cestou (`Sea of Simulation | LYTD… | Get Lucky (Radio Edit) |
  Aerodynamic Beats…` ⟵ čekáno totéž).
- Kontrola se měří **po kroku**, ne před ním: panel se překresluje i při doplňování
  fronty z vyhledávání (`search.js:527 _growLiveQueue`), takže snímek pořízený před
  kliknutím může být o jedno doplnění pozadu a kontrola by padala na cizí jev.

### P3 / P4 — po konci fronty hraje něco, co ve frontě není
`player.js` (`_autofillFromRecs`, `_takeAutofill`, `_appendAutoplay`), totéž
v `player_v3.js:_nextTrackTerminal`. Šev je `playRecTrack`, ne `playNextRec`.
`store.playerQueue.push`, nikdy `concat`. Do fronty se přidává jen to, co přišlo
z `_nextTrackInQueue`. Strop ocasu 20 skladeb. `prevTrack` už nechodí do `playPrevRec`.
- červená: řádků 100 → 100, `now-playing=„Disc Wars"` proti titulku
  `„Lady (Hear Me Tonight)"`, `.qi-autoplay-sep=false`.
- zelená: řádků 100 → 101, `now-playing` i titulek `„Lose Yourself to Dance"`,
  `.qi-autoplay-sep=true`.
- P4 (**Next na poslední skladbě tiše nic**) se na starém kódu reprodukuje, dokud je
  stanice studená: `„Face to Face / Short Circuit" → „Face to Face / Short Circuit"`
  (běh `p3-prod.txt` před zahřátím doporučovače). Jakmile je stanice teplá, stará verze
  něco zahraje — ale mimo frontu, což je P3. Kontrola proto doporučovač nejdřív zahřeje
  (otevře velký přehrávač a počká na `.rec-item`) a když nevrátí nic, bod přeskočí
  s důvodem místo falešné zelené.
- Hláška místo ticha: `showToast('No more recommendations for this queue')`.

### P5 — shuffle a repeat se po reloadu vypnou
`fullplayer.js:33-42` (`toggleShuffle`/`toggleRepeat` → `_persistModes`),
`syncShuffleRepeatUI` → `_restoreModes`, klíče `ms_shuffle` a `ms_repeat_mode`.
- červená: před reloadem sh=true rp=true, po reloadu sh=false rp=false.
- zelená: po reloadu sh=true rp=true.

### P6 — velký přehrávač je průhledný na 99 %
`player.css:42` — gradient `rgba(…,0.99)` nahrazen `background-color: var(--bg)` plus
neprůhledný `background-image`.
- červená: alfy pod 1 v `getComputedStyle(#fullPlayer)`: `0.99, 0.99, 0`.
- zelená: žádná alfa pod 1. Všechna tři rozlišení.

### P7 — řádky fronty jsou na telefonu uťaté
`player.css`, `@media (max-width: 640px)` skrývá `.qi-bpm` a `.qi-remove`. `display:none`
— prvky zůstávají v DOM.
- červená (390 px): `display(.qi-remove)=flex`, šířka `.qi-info` **51 px**.
- zelená (390 px): `display(.qi-remove)=none`, šířka `.qi-info` **146 px**.
- 1024x768 a 1280x900: ✕ zůstává viditelný (685 px, resp. 1004 px) před i po.

### P8 — gesto „švihni nahoru pro frontu" je ve spodní části mrtvé
Měněna **výhradně** stráž na `fullplayer.js:562` (gesto nahoru = fronta): z
`closest('button, input, .fp-progress-bar')` vypuštěn `button`. Stráž na `:504`
(švihnutí dolů = zavřít přehrávač) zůstává i s `button` — ta má `preventDefault`.
- červená: 1024x768 obě výšky `#fpQueuePanel.open=false`; 390x844 z 0,90 výšky false
  (z 0,80 na telefonu náhodou projde i na starém kódu — tam v tom místě tlačítko neleží).
- zelená: obě výšky a obě dotyková rozlišení true.
- hlídaná regrese: krátké klepnutí na `#fpPlayPause` dál pauzuje (`paused false→true`)
  před i po.

### P9 — „přidat do playlistu" a „odebrat z playlistu" jsou k nerozeznání
`player.js:updatePlaylistBadge` a `player_v3.js:1128` — v Up Next se tlačítko nenabízí;
nový glyf (`pl-remove-btn`) a červený hover v `player.css`.
- červená: `fp=flex bar=flex`, `playlist="Up Next"`, `.pl-remove-btn=false`.
- zelená: `fp=none bar=none`, `.pl-remove-btn=true`.

### P10 — nikde není „Playing from …"
`fullplayer.js:syncSourceLabel`, volané ze `syncFullPlayer` a `openFullPlayer`.
- červená: `.fp-source="Now Playing"`.
- zelená: `.fp-source="Playing from Up Next"`. Všechna tři rozlišení.

### P11 — z hrající skladby na interpreta se jde přes vyhledávání
**Zadání tu mělo chybnou premisu.** `openArtistByName` (`contextmenu.js:648`) dělá
*přesně totéž* co `router.searchFor` — obojí je `_searchFor('artist', jméno)`. Sjednocení
na `openArtistByName` by tedy nezměnilo nic měřitelného a kontrola by zůstala červená.
Položka fronty žádné `artist_id` nenese (nenese ho nic v aplikaci — proto každé „show
artist" končí v hledání), takže `fullplayer.js:_openArtistPage` jméno nejdřív rozloží
přes `/api/search?type=artist&limit=5` na id, přepne na stránku Search (detail bydlí
uvnitř `#pageSearch`) a zavolá `spotify.loadArtistDetail`. Když se nic netrefí, spadne
zpět na dnešní hledání podle jména.
- červená: `#artistDetail viditelný=false display=none`, `#searchInput="Daft Punk"`.
- zelená: `#artistDetail viditelný=true display=block`, jméno `„Daft Punk"`.
- Podtržení při hoveru na `#playerArtist`, `#fpArtist`, `#fpTitle` je v `player.css`;
  hover se `getComputedStyle` změřit nedá, pravidlo je v evidenci jen jako změna.

### P12 — hrající skladba nemá ⋯ menu
`fullplayer.js:init` — `makeKebabButton` s položkou `{ type: 'queue-track',
context: { queueIndex: store.playerIndex } }`, vložený za `#fpDownload`, tedy se stejnou
nabídkou jako kebab řádku fronty (včetně rádia od téhle skladby).
- červená: `#fpKebab=false`.
- zelená: `#fpKebab=true`, klepnutí otevře `.ctx-menu`. Menu se jen otevřelo a zavřelo
  Escapem — na žádnou položku se neklikalo (vedle je „Download", který na produkci
  skutečně stahuje).

### P13 — skladbu jde přetáhnout nad právě hrající
`queue.js:_dropAllowed` v obou cestách (HTML5 drop i dotykové řazení, kde se cíl navíc
ořízne zdola). Přesun samotné hrající skladby zůstává povolený — index jde s ní.
- červená: první řádek `„Instant Crush…" → „One More Time"` (přesun nad hrající prošel).
- zelená: první řádek se nezměnil.

### P14 — „Save as playlist" je jen na desktopu
`frontend/partials/90-full-player.html` (`#queuePanelSave`) a `95-panels.html`
(`#fpQueuePanelSave`), oba řízené `updateSaveButton` spolu s `#fpSaveQueue`; obsluha
uložení je vytažená do `_saveQueueAsPlaylist(btn)`.
- červená: `#queuePanelSave present=false`.
- zelená: `present=true visible=true "Save as playlist"`. Tlačítko se v kontrole
  **nemačká** — zakládalo by playlist na produkci.
- Vedlejší nález, který mi kontrola našla a opravil jsem ho: delší popisek v hlavičce
  panelu vytlačil `#queuePanelClose` mimo viewport. Pravidlo
  `.queue-panel .panel-header, .fp-queue-panel .panel-header { flex-wrap: wrap }`.

### P15 — „DJ controls" v klasickém enginu otevře prázdnou zásuvku
`djpanel.js:_applyPanelMode`. **Tlačítko zůstává** — zásuvka je jediná cesta z klasického
enginu do DJ bez odchodu do Nastavení. Mění se jméno: nadpis `Player`, popisek tlačítka
`Player settings`.
- červená: nadpis `„🎛 Live DJ Controls"`, `title="DJ controls"`.
- zelená: nadpis `„Player"`, `title="Player settings"`, výběr enginu viditelný.

### P16 — BPM odznaky skáčou do špatného slotu
`queue.js:_badgeAnchor` — odznak se vkládá před srdce (jinak před kebab, jinak před ✕),
ne před ✕, kam dnes dorazí **za** srdce i kebab.
- Ověřováno jen na 1024x768 a 1280x900; na 390 px neprovokováno — `.qi-bpm` je podle
  P7 skrytý.
- Měří se **v okamžiku vložení**, pozorovatelem na `document.body`. Statický pohled
  „až potom" vadu nevidí: první překreslení řádku odznak přesune do správného slotu,
  takže pozdní čtení ukazovalo zeleno i na starém kódu. To je i důvod, proč je
  pozorovatel navěšený hned po načtení stránky — líný dotaz na BPM startuje s prvním
  vykreslením fronty.
- červená: 11 vložených odznaků, **11 mimo slot**.
- zelená: 11, resp. 6 odznaků, **0 mimo slot**.

### P17 — česká hláška v anglickém UI
`queue.js` — `Playlist "…" už existuje — zvol jiný název` → `… already exists — pick
another name`. Hláška se spouští kolizí jména playlistu, což na produkci nejde
vyprovokovat bez zakládání playlistu; kontrola proto čte nasazený `/static/js/queue.js`.
- červená: nalezeno `„už existuje — zvol jiný název"`.
- zelená: žádný český řetězec.

## Přiznané meze

1. **Zelená se předvádí vložením souborů, ne nasazením.** Chování po skutečném buildu
   může záviset na razítkování cache (`entrypoint.sh`), které v `--patched` neběží.
   Nový `<link rel="stylesheet">` jsem nepřidával, takže `?v=__CACHE_BUST__` nebylo kde
   použít; žádný nový dynamický import jsem nepsal.
2. **Dvojí engine.** Obě vady jsem opravil v `player.js` i `player_v3.js` stejně, ale
   `claude_test` má `classic`, takže **měřená je jen klasická cesta**. DJ engine je
   ověřený pouze čtením kódu. Odlišnosti, které jsem v něm musel řešit a v klasickém
   enginu nejsou: `_advanceInFlight` (terminální větev ho uvolňuje před `_autofillFromRecs`,
   protože append jde do `loadAndPlay` až přes `playRecTrack`) a `_nextTrackTerminal`,
   které sdílí nešťastná i smart větev.
3. **Oddělovač „Autoplay" reload nepřežije.** Ukládaná fronta (`/api/player/queue`)
   nese jen `queue` a `current_index`; `store.js` na mém seznamu souborů není, takže
   značku držím v `queue.js` identitou objektu. Po načtení stránky je ocas ve frontě,
   ale bez oddělovače.
4. **Permutace a ruční přeskládání fronty.** `data-qi` po přetažení se zapnutým shuffle
   zůstává správné, ale pořadí permutace se nepřepočítá (délka se nezměnila), takže
   přesunutý řádek si drží své místo v permutaci. Nález nízké závažnosti, mimo P2.
5. **P4 má podmíněnou červenou.** Doslovný příznak ze zadání (stejný titulek, stejný
   `audio.src`) nastává jen se studeným doporučovačem. S teplým starý kód něco zahraje,
   jen mimo frontu — a to měří P3. Obě měření jsou výš.
6. **P16 je na desktopu občas přeskočené** s důvodem „žádný řádek odznak nedostal":
   jestli se odznak vůbec doplní, závisí na tom, co server o skladbách ví. Červená
   i zelená jsou doložené na obou rozlišeních, kde bod platí.
7. **P9 ověřuje jen skrytí v Up Next.** Nový glyf a červený hover jsou doložené třídou
   `pl-remove-btn`; samotnou barvu hoveru headless prohlížeč nezměří.
8. **P2 je statistická, ne vyčerpávající.** Měří pět kroků vpřed a pět zpět, ne celou
   permutaci. Na starém kódu padá na prvním porovnání.

## Co jinak a proč

- **P11 jsem neudělal podle zadání.** Zadání chtělo „sjednotit na `openArtistByName`",
  jenže ta funkce je sama hledání podle jména — změna by byla bez účinku a kontrola by
  zůstala červená. Řeším to rozložením jména na id a voláním `loadArtistDetail`.
  Stojí to jedno síťové volání navíc na jedno klepnutí.
- **Mechanika shuffle bydlí v `queue.js`, ne v obou enginech.** Nový soubor na seznamu
  povolených není a duplikovat permutaci do dvou enginů znamená dvě místa, která se
  rozejdou. `queue.js` je navíc přirozený vlastník: pořadí je to, co panel kreslí.
- **Značku autoplay držím identitou objektu, ne indexem.** `upnext.playTracks` frontu
  celou vymění a zapamatovaný index by ukazoval do fronty, kterou uživatel mezitím
  začal znovu. `store.js` měnit nesmím, takže stav je v `queue.js`.
- **Hand-off autoplay není časově omezený.** První návrh měl okno 15 s; změřil jsem, že
  první načtení doporučení je síťová obrátka, která to přeteče (P3 pak jednou zezelenalo
  a podruhé spadlo na témže kódu). Příznak se teď předává a spotřebovává přesně jednou.
- **`addToQueue` jsem nechal na `concat`**, i když porušuje stejný kontrakt identity
  pole jako `playRadio` — je to mimo rozsah těchhle bodů a je to už vypsané mezi nálezy
  pro další dávku.
- **Nález #19 (shuffle tiše vypíná Smart Queue) zůstává otevřený.** Větev
  `player_v3.js:1243` jsem přepsal se **zachovanou precedencí** shuffle nad Smart Queue,
  jak dodatek ukládá.
- **P13 nechává přesun samotné hrající skladby povolený.** Vada je v tom, že *jiná*
  skladba skončí nad hrající a nikdy se nepřehraje; posunutí hrající skladby index
  následuje, takže se z fronty nic neztratí.
- `recommendations.js`, `app/services/radio.py` ani `app/routers/player.py` jsem
  neotevřel k editaci.

## Ostatní měření

```
python3 -m pytest tests/ -q          → 78 passed, 3 skipped   (rc=0)
node --test tests/js/bpm_client.test.mjs → 10/10 pass          (rc=0)
scripts/build-index.sh                → wrote static/index.html from 16 partials
scripts/check-index.sh                → rc=0, partials a generovaný soubor souhlasí
```

---

# Druhé kolo — po review

Review vrátilo celek 2 ve všech třech drahách. Tahle sekce je jeho odbavení podle
`notes/impl/oprava-4-dodatek-po-review.md` (má přednost před oběma staršími texty).

## A. Orákulum: zelenou dělá servírovaný strom, ne vložená náhrada

Nejzávažnější nález celé dávky platí i pro mě. Režim `--patched` z prvního kola si
do stránky navěsil **vlastní routu** a syrové soubory bez cache-bust razítka; na
dnešní produkci kvůli tomu modul načetl podruhé pod jinou adresou a stránka běžela
se dvěma instancemi `store`/`queue`/`player`.

Je **pryč**. Zelenou polovinu dělá sdílený postroj:

```
node tests/e2e/audit/player.mjs --vp=<phone|tablet|desktop>              # nasazený kód
node tests/e2e/audit/player.mjs --vp=<phone|tablet|desktop> --worktree   # tenhle strom
node tests/e2e/audit/player.mjs --vp=desktop --worktree=<cesta>          # jiný strom
```

`open({ worktree })` naservíruje živé stránce **skutečné soubory ze stromu** včetně
`index.html`, s razítkem přečteným z produkce. Do stránky se nevkládá žádný kód:
běží buď můj, nebo nasazený. `helpers.mjs` jsem needitoval.

Účet `claude_test`, `ms_device_id` = `e2e-autor2-4-c2-<rozlišení>` (postroj si
předponu `e2e-` připíná sám). Engine `classic`. Na produkci se nic nestahovalo,
nemazal se cizí playlist, nic se nepřenastavovalo. Jediné, do čeho kontroly
zapisují, je **odkládací fronta tohohle zařízení** (`__upnext_e2e-autor2-4-c2-*`),
kterou samy vytvořily přehráním skladeb — tam R2.3 maže jeden řádek a P13 zkouší
přetažení. V kontextovém menu se neklepalo na žádnou položku.

### Souhrn posledního běhu

| rozlišení | nasazený kód | můj strom |
|---|---|---|
| 390x844 | 4 prošlo, **16 padlo**, 11 přeskočeno | **23 prošlo, 0 padlo**, 11 přeskočeno |
| 1024x768 | 4 prošlo, **17 padlo**, 10 přeskočeno | **24 prošlo, 0 padlo**, 10 přeskočeno |
| 1280x900 | 8 prošlo, **24 padlo**, 3 přeskočeno | **40 prošlo, 0 padlo**, 2 přeskočeno |

Návratové kódy čtené samostatným během (`cmd > out 2>&1; rc=$?`): produkce 1/1/1,
worktree 0/0/0. Výstupy ve `scratchpad/autor2-4-c2/`
(`FINAL-wt-{desktop,tablet}.txt`, `r2-wt-phone.txt`, `r2-prod-*.txt`).

### Červená polovina u nálezů review

R2.1–R2.4 jsou vady **prvního kola**, ne nasazeného kódu — nasazený kód je nemá,
protože nemá ani opravu, do které se vloudily. Abych je nemusel jen tvrdit, složil
jsem strom prvního kola zpět (`scratchpad/autor2-4-c2/kolo1/`, zpětné nahrazení mých
dnešních úprav v `player.js`, `player_v3.js`, `queue.js`, `fullplayer.js`) a změřil
ho týmž postrojem. Výsledek sedí s review bod po bodu:

```
node tests/e2e/audit/player.mjs --vp=desktop --worktree=<kolo1> --only=P2,P3,P4,R2.4

FAIL  R2.4.b  malý panel fronty se přitom zavře         #queuePanel.open=true .queue-open=true
FAIL  R2.4.c  v místě lišty je navrchu velký přehrávač  elementFromPoint(střed lišty)=#playerBar
FAIL  R2.2    Previous … není mrtvé tlačítko            „Digital Love (Radio Edit)" → „Digital Love (Radio Edit)"
FAIL  R2.3.a  smazání nechá pořadí zbytku beze změny    první rozdíl na 2. řádku
FAIL  P2.a    panel slíbil „The Writing of Fragments…", zahrálo „Short Circuit"
FAIL  R2.1.a  Previous v ocasu se vrací o skladbu zpět  „Lady (Hear Me Tonight)" → „Lady (Hear Me Tonight)"
FAIL  R2.1.c  Next nepřipíše duplicitu                  řádků 102 (čekáno 101)
FAIL  R2.1.e  první tip se do fronty nezapsal podruhé   „Lady (Hear Me Tonight)" ve frontě 1× → 2×
```

Ta poslední řádka je doslova duplicita z nálezu R2.1, změřená na živé instanci.

## B. Nálezy review bod po bodu

### R2.1 — Previous v autoplay ocasu (blokující)

`player.js:prevTrack`, `player_v3.js:prevTrack`, `loadAndPlay` v obou enginech.

Tři změny, všechny nutné:

1. **„Hraje se doporučení" je `_currentRecItem`, ne `isPlayingRec()`.** Kurzor
   doporučovače zůstává nastavený po celou dobu autoplay ocasu, jenže ty řádky jsou
   běžné položky fronty. Větev `if (m.isPlayingRec())` proto skladbu restartovala.
   Totéž v `nextTrack` — jinak by Next z řádku **nad** oddělovačem spadl do
   `playNextRec` místo do fronty.
2. **Previous je v ocasu běžná navigace** (`playerIndex--`, `loadAndPlay`).
3. **Kurzor doporučovače přežije načtení**, dokud fronta nese ocas:
   `const keepRec = _keepRecCursor || autoplayStart() >= 0`. Bez toho by
   `stopRecPlayback()` kurzor shodil a další Next by zahrál týž tip znovu a zapsal ho
   do fronty podruhé. Zadání mluvilo jen o `keepRec` při připojení; to nestačí, kurzor
   padne i při kroku zpět. Doloženo měřením výš (`1× → 2×`).

`prevTrack` je tím v klasickém enginu **synchronní** — dynamický import
`recommendations.js` už není k čemu.

- červená (kolo 1): `R2.1.a` restart, `R2.1.c` řádků 102, `R2.1.e` tip 1× → 2×.
- zelená: `„Lady (Hear Me Tonight)" → „Disc Wars"`, řádků 101 → 101, další Next se
  vrátí na týž řádek, teprve Next z konce dá nový tip, tip zůstává ve frontě 1×.

### R2.2 — Previous se zapnutým shuffle (vysoká, regrese)

Nová větev neměla `else` a stála před původní `store.playerIndex > 0`. Teď je
záložní cesta výslovná: **když permutační historie nic nemá, chová se Previous jako
původní lineární Previous**. Kontrola míří přesně na ten stav — shuffle se zapne až
po skoku na 4. řádek, takže je historie prázdná (je to paměť modulu, prázdná je i po
každém načtení stránky).

- červená (kolo 1): `„Digital Love (Radio Edit)" → „Digital Love (Radio Edit)"`.
- zelená: `„I Feel It Coming" → „Starboy"`.
- na produkci kontrola **prochází** — nasazený kód tuhle regresi nemá a kontrola to
  má potvrdit, ne skrýt.

### R2.3 — smazání nebo přetažení řádku ve shuffle (vysoká)

`queue.js` — pořadí se nově drží nad **položkami**, ne nad pozicemi, a sesouhlasí se
při každém čtení (`_syncShuffleOrder`): co z fronty zmizelo, vypadne; co přibylo, se
zamíchá do ocasu; zbytek si drží své místo. `_shufLen` a přepočet „jen při změně
délky" jsou pryč.

Volím variantu „nad identitou položek" z dodatku, ne `resetShuffleOrder()` z mazacích
cest: to druhé by ocas po každém ✕ znovu zamíchalo — tedy přesně ta polovina nálezu,
kterou review změřilo („z 49 zbylých řádků je téměř každý jinde"). Navíc to pokrývá i
cesty, které **nevlastním** (`contextmenu.js` → „Play next" frontu také přeskládá) a
na které bych hák nedostal.

`playOrder()` má pojistku: po sestavení z položek dopíše každý index, který ještě
nepadl, takže panel nakreslí každý řádek právě jednou i kdyby fronta nesla tentýž
objekt dvakrát.

- červená (kolo 1): `R2.3.a` první rozdíl na 2. řádku; na produkci `R2.3.b`
  „panel slíbil „Recognizer", zahrálo „GLBTM (Studio Outtakes)"".
- zelená: smazáno „The Writing of Fragments of Time", zbylých 99 řádků ve stejném
  pořadí; a další Next zahrál přesně to, co panel slíbil.

### R2.4 — lišta a panel nad velkým přehrávačem (vysoká)

`fullplayer.js:openFullPlayer` zavře malý panel fronty (`closeQueuePanel(true)`) —
tím spadne i třída `queue-open`, takže lišta klesne zpátky pod velký přehrávač.
Panel už jednu položku historie má, takže ji velký přehrávač **převezme**
(`replaceState`) místo aby přidal druhou: jedno Zpět ho zavře, jako odkudkoli jinud.
Druhá varianta (jen snímat třídu) by nechala panel fronty otevřený za přehrávačem.

- červená: na produkci klik na obal vůbec neprojde (backdrop ho spolkne,
  `#fullPlayer.open=false`); na kódu prvního kola se přehrávač otevře, ale
  `#queuePanel.open=true`, `.queue-open=true` a `elementFromPoint` ve středu lišty
  vrací `#playerBar`.
- zelená: přehrávač otevřený, panel zavřený, ve středu lišty je `#fullPlayer`.
  Všechna tři rozlišení.

### R2.5 — příznak autoplay vázaný na volajícího (vysoká)

Doslovné znění z dodatku („příznak nastavovat až z `.then(filled => …)`") **nejde
použít a opravu by rozbilo**: `getPlayerModule()` je kešovaný, už vyřízený slib,
takže `playRecTrack`, který si `playNextRec` naplánuje, běží **dřív**, než se slib
`playNextRec` vyřídí. Příznak nastavený v jeho `.then()` by přišel pozdě, připojení
by se nikdy nestalo a spotřeboval by ho až nějaký pozdější — tedy opravdu
uživatelský — výběr.

Dělám tedy totéž naruby: příznak se nastaví jako dřív a **uživatelský výběr ho
zruší**. V `player.js` i `player_v3.js` je posluchač na `document` v zachytávací fázi;
klik do `.rec-item` nebo do `.ctx-menu` příznak zahodí. Automatický tip pak zahraje
virtuálně, jako před dávkou, a do fronty uživatele se nenapíše nic, co si nevybral.
Zachytávací fáze na `document` proto, že ty řádky vlastní `recommendations.js`, který
tahle dávka editovat nesmí.

- zelená: `řádků 102 → 102, „Nightcall" ve frontě: false`.
- **mez:** samotné závodní okno se na živé instanci vyprovokovat nedá, viz meze níž.

### R2.6 — vady v kontrolách

**P12 už nezavírá menu Escapem.** Zavírá se klikem mimo (`.fp-source`) a přibyla
tvrzení `P12.c` (menu zmizelo) a `P12.d` (**velký přehrávač je pořád otevřený**).
V prvním kole Escape zavřel i přehrávač a devět dalších kontrol pak neběželo.

**Rozhodnutí k Escape nad kontextovým menu: ne, Escape nad otevřeným ctx-menu nemá
zavírat přehrávač.** Escape je „zavři nejvrchnější překryv" a `.ctx-menu`
(`z-index: 10000`) je nejvrchnější překryv v aplikaci. Dnes se to děje proto, že
`contextmenu.js:_onEsc` nezastaví bublání a `router.js:handleKeydown` sáhne na
`store.fullPlayerOpen` v téže události. **Opravit to tady nemůžu** — oprava sedí v
`contextmenu.js` nebo v `router.js` a ani jeden soubor není na seznamu celku 2.
Zůstává jako nález pro vlnu 2 (v dodatku po kritice už je v sekci F).

**P2.a měří předpověď, ne rekonstrukci.** Před každým Next se zapamatuje titulek
řádku hned pod značkou „hraje" a po Next se porovná s tím, co opravdu hraje. Původní
tvar porovnával pozice až **po** přeskoku, takže mutace, která ocas při každém
vykreslení znovu zamíchá, jím prošla zeleně. Nová `P2.d` navíc panel **třikrát
překreslí** a ověří, že je pořadí ocasu bajtově stejné.

- červená: produkce `krok 1: panel slíbil „One More Time", zahrálo „C.L.U."`;
  kolo 1 `krok 1: panel slíbil „The Writing of Fragments of Time", zahrálo „Short Circuit"`.
- zelená: `5/5 kroků předpovězeno správně`, `100 řádků, tři vykreslení shodná`.
- `P2.d` a `R2.3.a` **procházejí i na produkci**, a je to správně: nasazený kód kreslí
  panel v pořadí fronty, takže je tam stabilita a odolnost vůči smazání zadarmo.
  Rozlišující je `P2.a` a `R2.3.b`, a ty na produkci padají.

## C. Co se tím změřením rozpadlo

Dvě kontroly spadly na vlastní vadě, ne na kódu — obě opraveny:

1. **P2.c porovnávalo návraty proti zastaralé předpovědi.** Blok R2.3 jsem vložil mezi
   běh vpřed a běh zpět, takže mezi nimi přibyl jeden Next navíc a očekávaná
   posloupnost byla o jeden krok posunutá. Přesunuto **za** P2.c.
2. **R2.1.e hledalo duplicitu mezi všemi tituly fronty.** Fronta z vyhledávání nese
   duplicitní názvy sama od sebe (různé edice téže skladby — „Get Lucky" je ve
   výsledcích „daft punk" vícekrát). Teď se počítá jen to, jestli **přibyl další
   výskyt první doplněné skladby**, což je přesně ta duplicita z nálezu.

## D. Přiznané meze druhého kola

1. **Závodní okno R2.5 se živě nevyprovokuje.** Okno existuje jen tehdy, když
   `playNextRec` musí sáhnout na síť — tedy při vyčerpané stanici. S teplou stanicí je
   dlouhé pár mikroúkolů a klepnutí do něj netrefím. Měřím proto pravidlo samo
   (ručně spuštěné doporučení se do fronty nikdy nenapíše), ne závod. Zpomalení
   požadavku přes `context.route` by nepomohlo: s teplou keší se na síť nejde vůbec.
2. **R2.5 je občas přeskočené** s důvodem „v panelu není žádný volný řádek
   doporučení" — panel doporučení se do 30 s nevykreslil. Zelená je doložená dvěma
   běhy (`r2-wt-desktop.txt`, `FINAL-wt-r25.txt`), ve třetím bod přeskočil.
3. **Strom prvního kola je rekonstrukce**, ne archiv: složil jsem ho zpětným
   nahrazením svých dnešních úprav. Čísla z něj sedí s review bod po bodu, ale je to
   můj výrobek — kdyby se rozcházel, platí review, ne on.
4. **Hover se pořád nezměří.** Podtržení na `#playerArtist`/`#fpArtist`/`#fpTitle`
   (P11) a červený hover na `.pl-remove-btn` (P9) jsou v `player.css` a v evidenci jen
   jako změna pravidla; headless prohlížeč stav hoveru nevyrobí. **Mez na přejímku.**
5. **Skutečné přehrání zvuku se neměří.** Kontroly čtou `audio.paused`, `currentTime`
   a titulek — ne to, že je slyšet zvuk. **Mez na přejímku.**
6. **DJ engine (`player_v3.js`) je ověřený jen čtením kódu.** `claude_test` má
   `classic`. Všech pět oprav druhého kola je v obou enginech ve stejném tvaru;
   v `player_v3` navíc drží latch `_advanceInFlight` — `prevTrack` ho uvolňuje na
   každé cestě, která nejde přes `loadAndPlay`, včetně nové záložní lineární větve.
7. **Duplicitní objekt ve frontě.** Pořadí shuffle drží položky v `Set`, takže dvojí
   výskyt **téhož objektu** by se slil do jednoho. Panel to nerozbije (`playOrder`
   má pojistku, která dokreslí každý index), jen by jeden z těch dvou řádků shuffle
   nikdy nevybral. Dnes do fronty nic takové objekty nepřidává; nízká závažnost.
8. **Oddělovač „Autoplay" reload nepřežije** (ukládaná fronta nese jen `queue` a
   `current_index`) — beze změny z prvního kola.
9. **Nález #19 (shuffle tiše vypíná Smart Queue) zůstává otevřený**, precedence
   zachována — beze změny z prvního kola.

## E. Nové nálezy pro další dávku

- Escape nad `.ctx-menu` zavírá i velký přehrávač; oprava patří do `contextmenu.js`
  (`_onEsc` bez `stopPropagation`) nebo do `router.js`, ani jeden není na seznamu
  celku 2.
- `_shufPlayed`/`_shufTail` jsou paměť modulu a reload nepřežijí: po načtení stránky
  se zapnutým shuffle je historie prázdná a Previous jde lineárně (po téhle opravě
  aspoň jde). Persistence by patřila ke stejnému klíči jako `ms_shuffle`.
- `addToQueue` i `playRadio` pořád mění `store.playerQueue` přes `concat` — stejná
  vada identity pole jako P3, mimo rozsah.

## F. Ostatní měření

```
python3 -m pytest tests/ -q               → 78 passed, 3 skipped   (rc=0)
node --test tests/js/bpm_client.test.mjs  → 10/10 pass             (rc=0)
scripts/build-index.sh                    → wrote static/index.html from 16 partials (rc=0)
scripts/check-index.sh                    → rc=0, partials a generovaný soubor souhlasí
```
