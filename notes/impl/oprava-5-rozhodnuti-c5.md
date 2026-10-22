# Oprava 5 — celek 5: knihovna a stahování

Autor, worktree `/home/lucas/music-seeker-wt/oprava-5-c5-knihovna`, 22. 10. 2026.
Necommitováno, nenasazeno, do `app/` ani do env se nesáhlo. Podklady:
`oprava-5-dodatek-po-kritice.md` (**přednost**), `oprava-5-zadani.md`,
`notes/impl/audit-2026-10/library.md`. Strom vychází z nasazené vlny 1 (1.26.0).

## Jak se to měřilo

Oracle má tři kroky a všechny tři leží v `tests/e2e/audit/knihovna.mjs`
nad sdíleným postrojem `tests/e2e/audit/helpers.mjs` (**needitován**):

```
node tests/e2e/audit/knihovna.mjs                     → proti produkci, musí PADAT
MS_TREE=<worktree> node tests/e2e/audit/knihovna.mjs  → tentýž živý web, ale se
                                                        skutečnými soubory z tohohle
                                                        stromu, musí PROJÍT
```

`MS_TREE` (stejně jako `MS_PATCH=1`) jde přes `open({ worktree })`, takže
prohlížeč stáhne **syrové soubory z worktree včetně `static/index.html`**
a postroj k nim doplní cache-bust razítko z produkce. Nic z měřeného kódu se
nenahrazuje: do stránky se nevkládá žádný náhradní posluchač ani přepsaná
funkce.

**Co se naopak podstrkuje, a proč je to v pořádku:** odpovědi serveru přes
`page.route` — `/api/jobs` (účet nemá job předaný Lidarru ani běžící stahování),
`/api/podcasts` a `/api/favorites` (prázdné stavy nejsou jak vyvolat jinak),
`/api/library/likes` (zdržení, viz K2) a `/api/favorites` se smyšleným
interpretem pro K7. To je **vstup**, ne měřený kód.

**Produkce se jen čte.** Dvě místa, kde by kontrola jinak zapsala, se
zachytávají v prohlížeči a odpovídá se jim lokálně:
`/api/library/playlist/*/tracks` (DELETE) a `/api/library/playlist/*/remove-by-name`
pro K6, `/api/library/track/delete` pro K17. Fixtura `zz-audit-fixture`
(id `7t8AEa0q44JuRWpHm3MCoD`, 4 skladby) se tedy **pouze čte** — ověřeno tím, že
obě dráhy po celém běhu hlásí stejné 4 skladby. V kontextovém menu se klikalo
**porovnáním textu položky**, nikdy podle pořadí (`clickMenu()` prochází položky
a porovnává `.ctx-menu-label` na přesnou shodu — `:text-is()` selhávalo na
uvozovkách v `Remove from "zz-audit-fixture"`).

Tři rozlišení, obě dráhy, účet `claude_test`, `ms_device_id=e2e-autor-5-c5`:

| běh | telefon 390x844 | tablet 1024x768 | desktop 1280x900 |
|---|---|---|---|
| proti produkci | 0 prošlo, 18 padlo, 2 přeskočeno | 0 prošlo, **19 padlo** | 0 prošlo, **19 padlo** |
| nad tímhle stromem | **18 prošlo, 0 padlo** | **19 prošlo, 0 padlo** | **19 prošlo, 0 padlo** |

Výstupy: `scratchpad/autor-5-c5/{red,green}_{phone,tablet,desktop}.txt`.
Návratové kódy čteny samostatným během (`cmd > out 2>&1; rc=$?`), ne přes rouru.

Sada: `python3 -m pytest tests/ -q` → **82 passed, 3 skipped** (beze změny,
tenhle celek je čistě frontendový), `node --test tests/js/bpm_client.test.mjs`
→ **10 passed**. `scripts/build-index.sh` + `scripts/check-index.sh` → v souladu.

## Bod → řádek → kontrola → červená/zelená

| bod | kde | kontrola | proti produkci | nad stromem |
|---|---|---|---|---|
| **K1** dlaždice Liked Songs | `50-library.html:21-34` | `K1` — rozměr dlaždice vs. první karta playlistu | tablet `tile 968x1033` vs. `karta 227x296` | `227x292` vs. `227x296` |
| **K2** „0 songs" | `library.js:165`, `:984` | `K2` — `/api/library/likes` zdrženo o 15 s | `"0 songs"` i po doběhnutí | `"0 songs"` při vykreslení → `"8 songs"` po doběhnutí |
| **K3** Lidarr hlásí hotovo | `downloads.js:238-259`, `downloads.css:36,79-81` | `K3` — odznak a ořez vysvětlující věty | odznak `done`, ořez `true`, text 14/14 px | odznak `Sent to Lidarr`, ořez `false`, text 32/32 px |
| **K4** ukazatel na nule | `downloads.js:243,255`, `downloads.css:34,64-77` | `K4` — třída `indeterminate` + barva drážky vs. karty | `indeterminate=false`, drážka `rgb(26,26,42)` na kartě `rgb(28,28,46)` | `indeterminate=true`, drážka `rgba(255,255,255,.12)` |
| **K5** „Add to playlist" přidá do fronty | `library.js:800-810` | `K5` — popisky hromadného menu | `Add to playlist \| Add to other playlist…` | `Add to queue \| Add to playlist…` |
| **K6** křížek a kebab | `library.js:620-627`, `:678-694`, `:917-932`, `:498-500` | `K6` — potvrzení + odchozí volání | potvrzení `false`, `remove-by-name {"name":"Bohemian Rhapsody…"}` | potvrzení `true`, `{"indices":[1]}` |
| **K7** sledovaný interpret | `favorites.js:63-82` | `K7` — co se otevře po kliknutí | `#artistDetail` skrytý, stahovací dialog otevřený | `#artistDetail` viditelný, dialog zavřený |
| **K8** hrdinka se sedmi tlačítky | `50-library.html:67-70`, `library.js:1015-1030`, `:1226-1228` | `K8` — počet viditelných tlačítek + kebab + červené Delete | 7 tlačítek, kebab `false`, Delete `true` | 3 (Play, Shuffle, kebab), Delete `false` |
| **K9** chybí Shuffle | `50-library.html:69`, `library.js:1215-1224` | `K9` — `#shuffleLibPlaylist` | 0x | 1x |
| **K10** délka u lajků | — | **přeskočeno** | — | — |
| **K11** slepé prázdné stavy | `downloads.js:266-279`, `podcasts.js:72-80`, `50-library.html:184-187`, `favorites.js:117-119` | `K11a/b/c` | žádné tlačítko; Favorites radí „Click the heart icon" | tlačítko ve všech třech; text bez zmínky o srdíčku |
| **K12** dialog neumí lajk ani playlist | `downloads.js:129-171` | `K12` — obsah rychlé řady | `+ Add to Queue \| 📻 Radio` | `+ Add to Queue \| Add to Liked Songs \| 📻 Radio \| ☰ Playlist` |
| **K13** Downloads se nepodbarví | `downloads.js:193-227`, `downloads.css:100` | `K13` — třída `active` na viditelném tlačítku | `active=false`, aktivní zůstává `library` | `active=true`, aktivní `downloads` |
| **K14** karty bez kebabu | `library.js:342-354` | `K14` — kebabů vs. karet | 1 karta, 0 kebabů | 1 karta, 1 kebab |
| **K15** plochý seznam jobů | `downloads.js:261-264`, `:310` | `K15` — počet skupin | 0 | 2 (`In progress · 1`, `Finished · 1`) |
| **K16** `catch {}` | `downloads.js:282-296`, `:300-304` | `K16` — 502 po úspěšném načtení | `.jobs-error=false`, panel ukazuje stará data mlčky | `.jobs-error=true "Downloads list is out of date — Bad Gateway"` |
| **K17** nativní `confirm()` | `downloads.js:445,471`, `podcasts.js` (8 míst) | `K17` — vlastní modál vs. nativní dialog | vlastní `false`, nativních dialogů 1 | vlastní `true`, nativních 0 |
| **K18** dvojí `display` | `50-library.html:77`, `:170` | `K18` — počet deklarací v inline stylu | `#libBulkActions 2x`, `#podcastBulkBar 2x` | obojí 1x |

## Co jinak, než říkalo zadání, a proč

- **K1 — dlaždice zůstala mimo `#libraryGrid`**, jak nařizuje dodatek. Dostala
  vlastní jednopoložkovou `.grid` (`#likedSongsRow`). `.grid` je
  `repeat(auto-fill, minmax(200px,1fr))`, takže jediné dítě sedne do první
  kolony a **vyjde na pixel stejně široké jako karta playlistu** (ověřeno ve
  všech třech rozlišeních). Zároveň jsem jí **sebral třídu `lib-card`**: nechat
  ji tam by znamenalo, že ji chytí `$$('.lib-card', grid)` i `attachContextMenu`,
  kdyby se někdy ocitla ve stejném kontejneru.
- **K8 — šest obsluh se nepřesunulo, ale vytáhlo.** Těla handlerů
  `#queueLibPlaylist`, `#renameLibPlaylist`, `#coverLibPlaylist`,
  `#duplicateLibPlaylist`, `#mergeLibPlaylist`, `#deleteLibPlaylist` jsou
  beze změny, jen z anonymních posluchačů v `init()` povýšila na pojmenované
  funkce, které volá kebab. Nechat tlačítka v markupu schovaná a kebabem na ně
  klikat by byl mrtvý kód se stejným výsledkem.
- **K6 — index „z dat" je držený odkaz, ne pořadové číslo.** Každý vykreslený
  řádek dostane `card._libTrack = currentLibPlaylistTracks[i]`
  (`library.js:498-500`) a index se čte `currentLibPlaylistTracks.indexOf(...)`.
  Pořadové číslo přiřazené při renderu by byl zase jen „pořadí v DOM v okamžiku
  navěšení"; tohle sleduje objekt i přes splice, který dělá přetahování.
  `_selectSet` (zaškrtávátka) zůstává na DOM indexech — je to jiná množina a
  srovnávat ji nebylo v zadání.
- **K5 — zkrácení „Add to other playlist…" platí jen pro hromadné menu.**
  V `buildActionsFor` (`contextmenu.js:352`) stojí vedle sebe s popiskou, která
  se přepíná podle `store.playlistMode` (`Add to Up Next` / `Add to playlist`).
  To je starší, promyšlený rozdíl; přejmenovat ho by bylo rozšíření mimo bod.
- **K12 — bez `70-download-modal.html`.** Ten partial tenhle celek nevlastní,
  takže obě tlačítka staví `downloads.js` do existující `.modal-quick-row`
  (jednou, při prvním otevření dialogu). Srdíčko je `makeHeartButton` z
  `likes.js`, playlist volá `_addToNavidromePlaylist` z `contextmenu.js` —
  obojí **dynamickým importem**, protože `contextmenu.js` importuje
  `downloads.js` a statický import by uzavřel kruh.
- **K13 — jen z `openPanel()`/`closePanel()`**, `router.js` se nečetl jinak než
  očima. **Pro vedení k merge:** nastavuje se třída `active` na
  `#downloadsToggle` (desktop, třída `.downloads-btn`) a `#bnavDownloads`
  (telefon, `.bnav-btn`); při zavření se `active` vrací tlačítkům
  `[data-page="${store.currentPage}"]`. `.downloads-btn.active` dosud neměl
  **žádný** styl, pravidlo je proto v `downloads.css:100`, ne v `nav.css`
  (ten patří vlně 1).
- **K7 — klik musí nejdřív přepnout stránku.** `#artistDetail` bydlí uvnitř
  `#pageSearch`, který je při otevřené Knihovně `display:none`. Samotné
  `loadArtistDetail` by tedy vykreslilo interpreta do schované stránky. Pořadí
  je `switchPage('search')` → `loadArtistDetail(id, 'library', provider)`.
  Dialog se stahováním zůstal dosažitelný přes kebab karty („Download options…"),
  protože přepínač automatického stahování nikde jinde není.
- **K15 — „zahození jednotlivé položky" se neudělalo**, viz Meze.
- **K3/K4 — udělána jen frontendová polovina**, jak určuje dodatek. Příznak
  `handed_off` a vzorec `int(i / total * 100)` patří celku 6; do té doby je
  kontrola měří přes podstrčenou odpověď `/api/jobs`. **Nový stav v enumu
  nevznikl** — `status` zůstává `done`, mění se jen text odznaku a jeho barva
  (`.job-status.handed-off`).

## Přiznané meze

1. **K15 je udělaný jen zpola.** Dělení na „In progress" / „Finished" se
   souhrnným počtem je hotové; **ETA a zahození jednotlivé položky nejsou.**
   ETA nemá z čeho vzniknout, dokud backend nehlásí skutečná procenta (to je
   odložený bod z dodatku, oddíl H). Zahodit jeden dokončený job nejde
   **vůbec**: `DELETE /api/jobs/{id}` je *zrušení běžícího* jobu
   (`jobs.cancel_job`, nastaví `CANCELLED`), jediné mazání je hromadné
   `clear_history()`. Nový endpoint patří do `app/`, tedy celku 6. Klientské
   „schovej to u mě" jsem **neudělal schválně** — po reloadu by se položka
   vrátila a uživatel by si myslel, že mazání nefunguje.
2. **K5 se na telefonu neměří.** Zaškrtávátka hromadného výběru jsou pod 640 px
   schovaná (`search.css:336-338`, vědomé rozhodnutí z dřívější dávky), takže
   hromadné menu tam není jak otevřít. Kontrola to hlásí jako `SKIP` i s
   důvodem, ne jako průchod.
3. **K6 se neověřilo na skutečném smazání.** Odchozí volání se zachytává
   v prohlížeči, takže doložené je **co se posílá** (`{"indices":[1]}` místo
   `remove-by-name` s názvem) a že se napřed ptá. To, že server na ten tvar
   odpoví správně, je doloženo jen tím, že **touž cestou už dnes chodí**
   hromadné odebrání (`library.js:1269-1286`, `#libBulkRemove`). Smazání nad
   vlastní kopií fixtury jsem neprovokoval — bylo by to zapisování do produkce
   kvůli jedné kontrole.
4. **K7 se měří nad podstrčeným seznamem sledovaných**, protože `claude_test`
   nikoho nesleduje a následovat někoho by byl zápis do produkce. Kontrola
   proto tvrdí jen to, co opravdu vidí: otevře se stránka interpreta a
   neotevře se stahovací dialog. **Netvrdí**, že se interpret doopravdy
   dohledal.
5. **K3 se neověřilo proti skutečnému jobu Lidarru.** `handed_off` dnes žádný
   job nenese — příznak dělá celek 6. Kontrola měří frontend nad podstrčenou
   odpovědí; po merge obou polovin je potřeba **společné ověření**.
6. **K4 neukazuje skutečná procenta.** Podle rozhodnutí v dodatku je to
   neurčitý ukazatel; skutečný postup vyžaduje přepsat sdílený `_run`
   v `downloader.py` na čtení po řádcích (samostatný bod).
7. **Potvrzovací modály dědí kontrakt zásobníku dialogů z vlny 1**
   (`store.dialogStack`, `showConfirmModal`). Nová volání v `podcasts.js`,
   `downloads.js` a `library.js` na něj jen navazují — kontrola jejich
   chování při Back **neprovádí**.
8. **K8 a D1 se nepotkaly.** Hrdinka má teď dvě tlačítka a kebab, ale základní
   pravidlo `.playlist-hero-actions` (sloupec) mění celek 4 v `pages.css`.
   Po merge je potřeba ověřit **obě změny společně** — kritérium z dodatku
   (oddíl C, D1) na knihovním playlistu zezelená až s touhle změnou.

## Dotčené soubory

```
frontend/partials/50-library.html   K1, K8, K9, K11c, K18
frontend/partials/95-panels.html    jen blok #jobsList (prázdný stav se kreslí z JS)
static/js/library.js                K2, K5, K6, K8, K9, K14
static/js/downloads.js              K3, K4, K11a, K12, K13, K15, K16, K17
static/js/podcasts.js               K11b, K17
static/js/favorites.js              K7, K11c
static/js/contextmenu.js            export searchForType (K11)
static/css/downloads.css            K3, K4, K13, K15, K16, prázdné stavy
static/index.html                   PŘEGENEROVÁNO scripts/build-index.sh
tests/e2e/audit/knihovna.mjs        nový — orákulum celku
docs/architecture.md                popis změněného chování
```

---

# Druhé kolo (po review)

Autor, tentýž worktree, 22. 10. 2026. Necommitováno, nenasazeno, do `app/`
ani do env se nesáhlo. Podklad: `oprava-5-dodatek-po-review.md`, oddíl B
(**nejvyšší přednost**). Orákulum je pořád `tests/e2e/audit/knihovna.mjs`,
běhy nově pod `ms_device_id = e2e-autor2-5-c5`, výstupy v
`scratchpad/autor2-5-c5/`.

Řádky K6 a K8 v tabulce prvního kola výš **už neplatí** — co měří a co
naměřily teď, stojí níž.

## R5.1 — mazání se vrátilo na `remove-by-name`, s indexem

`_removeTrackFromPlaylist` (`library.js:685-694`) posílá
`POST /api/library/playlist/{id}/remove-by-name` s tělem
`{ name, artist, index }`. Index z dat
(`currentLibPlaylistTracks.indexOf(item)`) **zůstal beze změny** — mění se
jen endpoint, přesně jak nařizuje review.

Proč to byla blokující vada: `DELETE /tracks { indices:[i] }` jde v
`app/services/library.py:404-406` rovnou na Subsonic `songIndexToRemove`,
tedy na **číslo bez jakékoli kontroly**. `remove_track_by_name`
(`app/services/library.py:413-431`) si playlist napřed **znovu načte**,
index použije jen dokud na něm pořád sedí jméno i interpret, jinak spadne na
shodu podle jména a bez shody vrátí `False` → router 404
(`app/routers/library.py:277-283`). Nejhorší případ se tím posouvá z
„smazalo se něco jiného" na „nesmazalo se nic".

Hromadné odebrání (`#libBulkRemove`, `library.js:1281-1298`) na `DELETE
/tracks` **zůstává**: odebírá dávku, kterou si uživatel právě odškrtal na
obrazovce, a jednotlivé jméno pro každý řádek nemá co poslat. Je to vědomá
asymetrie, ne přehlédnutí.

Naměřeno (tablet, obě dráhy, odchozí volání zachycené v prohlížeči):

| dráha | co odešlo |
|---|---|
| proti produkci | `remove-by-name {"name":"Bohemian Rhapsody (Remastered 2011)","artist":"Queen"}` — bez indexu, **a bez ptaní** |
| první kolo (vráceno) | `{"indices":[1]}` |
| **nad tímhle stromem** | `remove-by-name {"name":"Bohemian Rhapsody (Remastered 2011)","artist":"Queen","index":1}` |

## R5.2 — vybrána varianta (a): druhá pozice patří „+ Add All"

Hrdinka je `[▶ Play All][+ Add All][🔀 Shuffle][⋯]`
(`50-library.html:68-73`, obsluha `library.js:1222-1225`). Z kebabu
(`_libPlaylistMenu`) **zmizelo** „Add all to queue" — jedna akce, jedno místo.

**Proč (a), ne (b):**

1. Vada není v tom, že Shuffle přepíše frontu — to je jeho práce a dělá to i
   u Liked Songs a u spotifyho playlistu. Vada je v tom, že si **sedl na
   místo additivní akce**. Varianta (b) by tu záměnu nechala stát a jen k ní
   přilepila dialog; uživatel by pořád sahal po „přidat" a pořád by dostával
   „hrát", jen s jedním kliknutím navíc.
2. Potvrzovací dialog na Shuffle by se ptal **i tam, kde je odpověď vždycky
   ano** (prázdná fronta vyloučená podmínkou, ale „dvě dohrané skladby"
   taky není co chránit). Dialog, který se ptá na nic, se odklikává bez
   čtení — a příště se odklikne i ten, který se ptá právem.
3. (a) je menší změna: jedno tlačítko zpátky do markupu, jedna řádka
   obsluhy, jedna položka pryč z kebabu. (b) by znamenala nové volání
   `showConfirmModal` v cestě, která se **spouští z hrdinky každého**
   playlistu, tedy nový dědičný závazek vůči zásobníku dialogů z vlny 1.
4. K8 (tři tlačítka místo sedmi) tím neutrpí: hrdinka má čtyři prvky včetně
   kebabu, akce mají vlastní řádek a samy se zalamují (potvrzeno review,
   oddíl D), takže se hrdinka neroztáhne. Změřeno: `tlačítek 4
   (▶ Play All | + Add All | 🔀 Shuffle), kebab=true, červené Delete=false`.

K8 **nově měří i pořadí**, ne jen počet: `labels[1]` musí odpovídat
`/add all/i`. Záměna zpátky je tím měřitelná (viz mutace M4).

## R5.3 — doplněné kontroly

| kontrola | co měří | proti produkci | nad stromem |
|---|---|---|---|
| **K6** (přepsaná) | kebab u druhého řádku → ptá se, a odejde **právě jedno** `remove-by-name`, které **jmenuje druhý řádek** a nese `index:1` | `potvrzení=false`, `remove-by-name` bez indexu | `potvrzení=true`, `{"name":"Bohemian Rhapsody (Remastered 2011)","artist":"Queen","index":1}` |
| **K6b** (nová) | klik na `.lib-track-remove` u **druhého** řádku → tatáž podmínka, a `sent.length === 1` | `potvrzení=false`, odešlo `{"indices":[1]}` | 1 volání, `index:1`, jméno sedí |
| **K6c** (nová) | klik na `.confirm-cancel` → **neodešlo nic** | `potvrzení nabídnuto=false`, po Cancel odešlo 1 volání | `nabídnuto=true`, odeslaných volání **0** |
| **K17b** (nová) | smazání epizody v `podcasts.js` nad podstrčeným `/api/podcasts` → vlastní modál, **žádný nativní dialog** | `vlastní modál=false, nativních dialogů 1: Delete "Audit episode one"?` | `vlastní modál=true, nativních dialogů 0` |

Jméno druhého řádku se nečte z nadpisu, ale z `dataset.item` — tedy přesně
z toho, co obsluha do těla požadavku posílá. „Index 1" sám o sobě nestačí:
holý index je právě to, co review zahodilo.

**Mutace (nad stromem, tablet) — každá musí zčervenat svou kontrolu:**

| mutace | co rozbíjí | výsledek |
|---|---|---|
| M1 `_removeTrackFromPlaylist(playlistId, track, 0)` u křížku | křížek předá index 0 místo indexu své karty | **K6b FAIL** (`index:0`), K6 a K6c pass |
| M2 `if (!ok) return;` pryč | Cancel stejně maže | **K6c FAIL** (po Cancel 1 volání), K6 a K6b pass |
| M3 nativní `confirm()` zpátky do `podcasts.js` (mazání epizody) | osmé místo, které K17 neviděl | **K17b FAIL** (1 nativní dialog), K17 pass |
| M4 Shuffle zpátky na druhou pozici | svalová paměť zase na `playTracks` | **K8 FAIL** (`druhé="🔀 Shuffle"`), K9 pass |
| M5 endpoint zpátky na `DELETE /tracks {indices}` | R5.1 odvolána | **K6 i K6b FAIL** (`indices {"indices":[1]}`), K6c pass |

Mutace vždy červená **jen tu kontrolu, které se týká** — ostatní zůstávají
zelené, takže kontroly nejsou slepě provázané. Strom byl po každé mutaci
obnoven ze zálohy (`scratchpad/autor2-5-c5/bak/`) a `scripts/build-index.sh`
přegeneroval `static/index.html`; skript mutací je
`scratchpad/autor2-5-c5/mutate.py`.

**K6b a K6c na telefonu:** křížek u řádku je pod 640 px **záměrně skrytý**
(`search.css:336-338`, tatáž deklarace, která schovává zaškrtávátka — vědomé
rozhodnutí z dřívější dávky, řádek by jinak měl titulek ~42 px široký).
K6b se proto na telefonu hlásí jako **SKIP i s důvodem**, ne jako průchod.
K6c si na telefonu sáhne na tutéž otázku přes ⋮ (jediná cesta, která tam
existuje) a měří ji normálně.

## R5.4 — `handed_off` není mrtvý kód, a jeho přiznaná mez

Beze změny, jak nařizuje review. Příznak přidal celek 6 (`jobs.py:41`,
`downloader.py:749`), `to_dict()` ho vydává, `to_history()` ho **vypouští
záměrně**, aby starší image neshodil celou historii.

**Mez do evidence:** job **obnovený z historie po restartu kontejneru ukáže
`DONE`, ne „Sent to Lidarr"** — příznak v historii uložený není, takže se po
načtení nevrátí. Živý job (dokud běží proces) odznak nese správně. Je to
**přijatá mez, ne vada**; cena za to, že rollback na starší image nevyhodí
`ValueError` nad neznámým polem a neztratí celou historii. Ověřit po merge
obou polovin nad spojeným stromem.

## Výsledky obou drah po druhém kole

Tři rozlišení, obě dráhy, účet `claude_test`, fixtura `zz-audit-fixture` jen
čtená. Návratové kódy čteny samostatným během (`cmd > out 2>&1; rc=$?`).

| běh | telefon 390x844 | tablet 1024x768 | desktop 1280x900 |
|---|---|---|---|
| proti produkci | 0 prošlo, **20 padlo**, 3 přeskočeno (rc 1) | 0 prošlo, **22 padlo**, 1 přeskočeno (rc 1) | 0 prošlo, **22 padlo**, 1 přeskočeno (rc 1) |
| nad tímhle stromem | **20 prošlo, 0 padlo**, 3 přeskočeno (rc 0) | **22 prošlo, 0 padlo**, 1 přeskočeno (rc 0) | **22 prošlo, 0 padlo**, 1 přeskočeno (rc 0) |

Výstupy: `scratchpad/autor2-5-c5/{red,green}_{phone,tablet,desktop}.txt`,
mutace `scratchpad/autor2-5-c5/mut_M{1..5}.txt`.

Sada: `python3 -m pytest tests/ -q` → **82 passed, 3 skipped** (rc 0, beze
změny — celek je čistě frontendový), `node --test tests/js/bpm_client.test.mjs`
→ **10 passed, 0 failed** (rc 0). `scripts/build-index.sh` +
`scripts/check-index.sh` → v souladu, 16 partialů.

**Fixtura zůstala nedotčená.** Všechna destruktivní volání se zachytávají
v prohlížeči (`page.route` na `remove-by-name`, na `DELETE /tracks`, na
`/api/library/track/delete` a na `DELETE /api/podcasts/**`) a odpovídá se jim
lokálně. Doklad, že se opravdu nic nesmazalo: ve všech sedmi bězích, které
se fixtury dotkly — a to až **po** všech pokusech o smazání — je druhý řádek
pořád `"Bohemian Rhapsody (Remastered 2011)"`.

## Meze druhého kola

1. **R5.1 není ověřená proti skutečnému serveru.** Doložené je **co se
   posílá** a že backend ten tvar umí (`remove_track_by_name` přijímá
   `index`, `AddTrackByNameRequest.index` existuje v `app/models.py:124`).
   Že server na tu trojici odpoví správně, se neprovokovalo — bylo by to
   zapisování do produkce. Tutéž cestou chodí mazání **dnes na produkci**
   (jen bez indexu), takže endpoint sám živý je.
2. **Scénář „druhé zařízení přeskládalo playlist" se nepřehrál.** Oprava se
   obhajuje čtením backendu, ne měřením rozejitého pohledu; k tomu by bylo
   potřeba playlist na produkci opravdu přeskládat.
3. **Mez z prvního kola č. 8 platí dál** — K8 a D1 se nepotkaly. Hrdinka má
   teď o jedno tlačítko víc než v prvním kole (čtyři místo tří), takže
   kritérium D1 na knihovním playlistu je po merge potřeba ověřit **s touhle
   čtveřicí**, ne s trojicí.
4. **K17b měří jedno z osmi míst** v `podcasts.js` (mazání epizody z řádku).
   Zbylých sedm je doloženo jen tím, že `grep -c "confirm("` nad
   `static/js/podcasts.js` vrací **0** a `showConfirmModal` **7** výskytů.
5. Ostatní meze prvního kola (1-7) zůstávají v platnosti beze změny.
