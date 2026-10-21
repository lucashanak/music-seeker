# Oprava 5 — Dodatek po kritice

**Má přednost před `oprava-5-zadani.md`.** Kritika běžela ve dvou drahách souběžně
s autory vlny 1, obě vrátily **„po úpravách"**, obě měřily proti produkci 1.25.2
a proti živému Deezeru. Doklady: `scratchpad/kritika-5-front/`, `scratchpad/kritika-5-back/`.

---

## A. Škrtnuté body

### D6 — mrtvý tempo filtr u alba — ŠKRTÁ SE

Premisa neplatí ve dvou vrstvách. (1) Na produkci 1.25.2 ten pruh u alba **není** —
změřeno ve všech třech rozlišeních, `bpmFilter.present = false`. (2) Uvedená
příčina je vyvrácená kódem: album i playlist mountují filtr **toutéž funkcí
`_mountTempoFilter` se stejnými `opts`** (`spotify.js:17-25`, voláno z `:274` a
`:609`). Oracle se k tomu bodu postavit nedá — kontrola by na produkci prošla už
dnes. Opravil to commit z 1.25.1 pro obě cesty najednou.

### B5 — placeholder Last.fm — ŠKRTÁ SE

Vlastní **vlna 1, celek 3, bod N7**. Nesahat. Ověřování přes `git log main` by
svedlo z cesty — vlna 1 běží ve worktree a do `main` zatím nic nedodala.

### K10 — délka skladby u Liked Songs — ODKLÁDÁ SE

Není to chyba rendereru, je to chybějící údaj v datech: položky lajků nesou jen
`name, artist, album, id, image, type`. Renderer délku umí
(`search.js:731`), ale nemá co vykreslit. Oprava znamená ukládat `duration_ms`
při lajkování, což je mimo přidělené soubory. **Samostatný bod pro další dávku**,
včetně otázky, co s už uloženými lajky.

---

## B. Rozhodnuté volby

| volba | rozhodnutí | důvod |
|---|---|---|
| **D1** — tvar hrdinky | **`.playlist-hero { flex-wrap: wrap }` + `.playlist-hero-actions { flex-basis: 100%; flex-shrink: 1 }`** — akce se přesunou pod titulek a obal. | Prosté povýšení mobilního pravidla **vyrobí vodorovný přetok**: změřeno na živé instanci, album 1027 > 1024, knihovní playlist **1167 > 1024** (143 px ujetí). `flex-shrink: 1` samo o sobě nepomůže — titulek pak spadne na **0 px**. |
| **D1** — obal 180 px | Jen **`@media (min-width: 641px)` v `pages.css`**. | Bez toho se zvětšení propíše na telefon (hrdinka alba 329 → 409 px) a oprava by si vyžádala `responsive.css`, což je **výhradní soubor vlny 1**. Takhle se soubor vlny 1 vůbec neotevře. |
| **K1** — kam s dlaždicí Liked Songs | **Nechat ji mimo `#libraryGrid`** a dát jí vlastní jednopoložkovou mřížku (nebo `max-width` odpovídající kartě). | Přesun dovnitř ji **zničí**: `renderLibraryGrid` přepisuje `grid.innerHTML`, takže první vykreslení playlistů ji smaže; navíc má třídu `lib-card`, takže by ji chytil selektor kliknutí (`playlists[undefined]`) i kontextové menu. |
| **K3** — nový stav, nebo příznak? | **Příznak vedle stavu** (`handed_off`), status zůstává `DONE`. | Nový stav v enumu by musel do **tří** filtrů v `jobs.py` (`:74`, `:84`, `:133`), jinak by se job neuložil do historie, nepřežil restart a nešel smazat. Navíc `jobs.py:62` vyhodí `ValueError` na neznámém statusu při načtení historie → **tichá ztráta celé historie při rollbacku**. |
| **K4** — skutečná procenta, nebo neurčitý ukazatel? | **Neurčitý ukazatel** + opravený vzorec `int(i / total * 100)` po dokončení stopy. | Skutečná procenta z yt-dlp znamenají přepsat sdílený pomocník `_run` (`downloader.py:31-49`) na čtení po řádcích — a ten obsluhuje i metaflac a ffmpeg. **Samostatný bod s vlastním rozpočtem pro další dávku.** |
| **K5** | **Přejmenovat na „Add to queue"**, toast „Added N to queue"; „Add to other playlist…" zkrátit na „Add to playlist…". | V menu stojí obě položky vedle sebe; oprava chování by vyrobila dvě skoro stejně pojmenované položky dělající totéž. |
| **K6** — jaká sémantika mazání | **Index z dat, ne z DOM**: `currentLibPlaylistTracks.indexOf(item)`, a `_removeTrackFromPlaylist` přepnout z `remove-by-name` na `DELETE { indices: [idx] }`. | Dnešní index křížku je **pořadí v DOM** v okamžiku navěšení — jakmile BPM filtr schová řádky nebo se seznam přerenderuje, ukazuje jinam. „Srovnat kebab na index" by vadu rozšířilo na obě cesty. |
| **B2** — co s žánrovým žebříčkem | **Nechat alba, přepočítat interprety ze surových řádků skladeb.** | Měření na pěti žánrech: **artists jsou doslova regionální seznam** (překryv 10/10 se `/chart/0` u všech pěti), ale **alba scopovaná JSOU** (překryv 0–1 z 10). Varianta „poslat jen tracks a playlists" by zahodila dobrá data. |
| **B2** — odkud odvodit interprety | **Ze surových Deezer řádků `_rows("tracks")`, PŘED mapováním.** Dedup podle `artist.id`, pořadí prvního výskytu. | `_deezer_track` nechává jen jméno a id; `image` v něm je **obal alba**, ne portrét. Karta odvozeného interpreta by nesla obal alba — horší vada než dnešní stav. |
| **B3** — jaká veličina a práh | **`nb_fan` interpreta ≥ 1 000 000.** | Track dict **nenese žádnou veličinu popularity** (`_deezer_track` zahazuje `rank`), takže navržené porovnání nemá druhou stranu; `nb_fan` a `rank` navíc nejsou souměřitelné (absolutní počet vs. saturovaný index 0..1e6). Změřeno na 15 dotazech: špatná strana leží v pásmu 6 – 8 076 fanoušků. |
| **B4** — `type=episode` | **Nechat v patternu.** Jedna věta do evidence. | Odebrání je změna veřejného kontraktu s nulovým ziskem a udělalo by z funkční implementace mrtvý kód. Navíc existuje nativní Android klient, jehož zdroj v repu není — „nikdo to nevolá" se nedá ověřit. |
| **D9** — kam s „Refresh app" | **Jen odstranit z `30-search.html`.** Nikam nepřesouvat. | Dvojník v Nastavení **už existuje** (`#refreshCacheBtn`) — a bydlí v `63-settings-account.html`, což je **soubor vlny 1**. Handler v `search.js` se váže přes `$('#appRefreshBtn')`, takže po odstranění prvku tiše nic nenaváže a nic nespadne. |
| **D3** | **Rozdělit.** Shuffle k interpretovi zůstává střední; „vykreslit Play od začátku zakázané" je **nízká** a zdůvodňuje se **stabilním rozměrem hrdinky**, ne vnímaným zpožděním. | Změřeno 169 ms — pod prahem vnímání, a Play naskočí **dřív** než jméno interpreta (470 ms). |

---

## C. Přepsaná a doplněná znění

### D1 — povinné měřitelné kritérium

Na **všech čtyřech hrdinkách** (interpret, album, playlist z vyhledávání,
knihovní playlist) a ve **všech třech rozlišeních** musí platit:

```
document.documentElement.scrollWidth <= document.documentElement.clientWidth
hero.scrollWidth <= hero.clientWidth
.playlist-hero-info šířka > 120 px
```

Bez těch tří čísel bod není hotový. Slovní „nesmí vzniknout přetok" nestačí —
právě na něm kritika původní návrh chytla.

Kontrola na **knihovním playlistu** zezelená až po K8 (sedm tlačítek je nejhorší
případ). To je očekávané; napiš to do evidence.

### D2 — úplný výčet volajících

Volající jsou **čtyři**, ne jeden, a dva z nich vlastní vlna 2:

- `spotify.js:182` (`searchForArtistDetail`) — **dělá celek 4**, má v ruce odpověď
  z `/api/search`, tedy jméno i obrázek;
- `favorites.js` — **dělá celek 5** spolu s K7;
- `search.js:80` (`_routeCardClick`) — vlna 1, doplní vedení;
- `contextmenu.js:639` — **celek 5** (viz přidělení souborů níž).

Závažnost D2 klesá z vysoké na střední: naměřené zdržení hrdinky je 470 ms.

### D4 — mapování `record_type`

Na pěti interpretech s velkým katalogem se `compilation` **nevyskytla ani jednou**
a hodnota může přijít jako **prázdný řetězec**. Mapuj natvrdo:

- `album` → „Albums"
- `single`, `ep`, **cokoli jiného včetně prázdna** → „Singles and EPs"

Do podtitulku piš **jen `record_type` a rok**, nikdy `total_tracks` — ten je
u tohohle endpointu vždy 0. Očekávání pro kontrolu: Daft Punk 15 + 24.

### D5 — celkový čas alba

Součet zobraz **jen když má `duration_ms > 0` každá skladba**. Jinak vynech a nech
`Album · 2001 · 14 songs`. iTunes a podcastové cesty vracejí 0
(`search_providers.py:587`, `:631`, `:700`), takže jinak by uživatel viděl
„1 hr 1 min" u alba, kde polovina stop chybí.

### D8 — rozšíření

Nejen `#shuffleAlbum`. Na téže hrdince je `#radioArtist` s 📻 — tentýž soubor,
tentýž celek, tatáž hrdinka.

### K2 — opravený popis příčiny

Oprava je správná, diagnóza ne. Událost `likeschange` při prvotním načtení
**vůbec nevznikne** — vysílá ji jen `toggleLike`. Platí tedy: `loadLibrary()` volá
`_refreshLikedCount()` synchronně (`library.js:164`), zatímco `loadLikes(true)`
z `auth.js:205` běží bez čekání a po doběhnutí nikoho neinformuje. Oprava je
`loadLikes().then(_refreshLikedCount)`. Posun nad strážce `_likedViewOpen` je
samostatné a užitečné zpřesnění, ne řešení závodu.

**Oracle:** kontrola musí `/api/likes` zdržet (`page.route` + `setTimeout`)
nejméně o 3 s, jinak projde na produkci už dnes (naměřeno „8 songs" v čase 0).

### K3 — nové znění (příznak, ne nový stav)

- **Backend (celek 6):** `_run_lidarr` nastaví na jobu příznak `handed_off = True`;
  `status` zůstává `DONE`, takže perzistence, restart i „Clear history" fungují beze
  změny. Pytest: job s metodou lidarr má `handed_off`, job s yt-dlp nemá; job
  s lidarr **je po doběhnutí v historii** a `clear_history()` ho odstraní.
  Mutace: příznak odstranit → test zčervená.
- **Frontend (celek 5):** odznak renderuje „Sent to Lidarr" místo „DONE", notifikace
  o dokončení se u `handed_off` přeskočí, vysvětlující věta se nechá zalomit
  (`downloads.css:36`).

### K4 — nové znění

- **Backend (celek 6):** vzorec na `int(i / total * 100)` **po dokončení stopy**
  (pro `total == 1` tedy 0 → 100 místo 0 → 0). Pytest na výpočet, mutace vrátí
  původní vzorec.
- **Frontend (celek 5):** neurčitý/pruhovaný ukazatel při
  `progress === 0 && status === 'running'`; drážku zviditelnit proti kartě.

### K11 — opravené zdůvodnění

Tvrzení o tabletu je vyvrácené: na dotykovém zařízení je srdíčko **trvale
viditelné** (`responsive.css:141-142`, `@media (hover: none)` → `opacity: 1 !important`),
a 1024x768 s dotykem ten dotaz splňuje. Platí jen: **na desktopu** je srdíčko do
najetí myší neviditelné, takže rada „klikni na srdíčko" je nenásledovatelná právě
tam, kde hover existuje. Bod zůstává, text prázdného stavu přepiš.

### K13 — upřesnění

Dělá se **výhradně z `openPanel()` / `closePanel()` v `downloads.js`**; `router.js`
se jen čte, nikdy needituje (patří vlně 1). Do evidence napiš selektor a třídu,
kterou nastavuješ, ať to vedení při merge zkontroluje.

### B1 — opravená poznámka o cache

Poznámka v zadání je obrácená. `_genre_list_cache` je **obyčejný modulový dict**,
tedy jen v paměti procesu. Nasazení = nový kontejner = prázdná cache = angličtina
**hned při prvním požadavku**. Žádné 24h okno zastaralosti po nasazení neexistuje;
riziko je opačné — přejímka spuštěná proti kontejneru, který se nerekreoval.

Kontrolu piš **na text dlaždic** (žádná neobsahuje „Taneční" ani „Klasická"), ne
na pořadí.

### B3 — opravená kalibrační sada

Zadání jmenovalo „adele, queen, creep, bohemian rhapsody, nirvana" jako sadu, kde
to dnes částečně rozhoduje správně. Měření: **„creep" i „bohemian rhapsody" dnes
selhávají.** Platí: `_pick_top_result` vrací interpreta u **15 z 15** testovaných
dotazů; správně je to jen u **adele, queen, nirvana**. Kalibrační sada je tedy
**12 selhávajících a 3 správné**.

---

## D. Přidělení souborů (doplnění, závazné)

| soubor | vlastník | poznámka |
|---|---|---|
| `app/services/downloader.py` | **celek 6** | backendová polovina K3 a K4 |
| `app/services/jobs.py` | **celek 6** | jen pokud si to příznak vyžádá; nový stav v enumu je zakázaný |
| `static/js/contextmenu.js` | **celek 5** | potřebuje ho K5, K11, K12, D2 |
| `frontend/partials/95-panels.html` | **sdílený po blocích** | celek 5 smí **jen** `#downloadsPanel` a `#jobsList`; panely fronty patří celku 2 vlny 1 |
| `static/css/pages.css` | **celek 4** | potvrzeno; celek 5 ho pro své body nepotřebuje (K1 i K8 jsou markup, pravidlo se vejde do `downloads.css`) |
| `static/css/responsive.css` | **nikdo ve vlně 2** | patří vlně 1; D1 je navržena tak, aby se neotevřel |
| `frontend/partials/63-settings-account.html` | **nikdo ve vlně 2** | patří vlně 1; proto se D9 řeší odstraněním, ne přesunem |
| `static/js/search.js` | **nikdo ve vlně 2** | drží řádkový renderer; všechno se musí dát udělat přes `opts` nebo přes data |

---

## E. Orákulum pro knihovní playlist

Účet `claude_test` **nemá žádný knihovní playlist**, takže K5, K6, K8, K9, K14,
K15 a kontrola hrdinky knihovního playlistu by neměly co měřit.

**Vedení proto založilo trvalou fixturu** — playlist `zz-audit-fixture` na účtu
`claude_test`, id `7t8AEa0q44JuRWpHm3MCoD`, **4 skladby** (Smells Like Teen Spirit,
Bohemian Rhapsody, One More Time, Get Lucky — ze zamýšlených osmi jsou v knihovně
jen tyhle čtyři). Autoři i dráhy ji **čtou, nemažou a nemění**. Kontrola, která by
musela mazat (K6), se dělá nad **kopií** založenou a smazanou ve stejném skriptu,
nebo se nahradí pytestem a do evidence se napíše „neprovokováno".

---

## F. Pořadí merge (vedení)

Partialy a sdílené kontrakty si vynucují pořadí:

1. **vlna 1 / celek 3** — `00-head`, `10-login`, `63-`, `64-`, `utils.js` (kontrakt
   modálů), `router.js`
2. **vlna 1 / celek 2** — `80-player-bar`, `90-full-player`, `95-panels` (bloky fronty)
3. **vlna 1 / celek 1** — `search.js` (`closeGenre` pro N14)
4. **vlna 2 / celek 5** — `50-library`, `95-panels` (blok stahování), `contextmenu.js`
5. **vlna 2 / celek 4** — `pages.css`, `30-search`
6. **vlna 2 / celek 6** — backend

K6, K17 a všechna nová volání `showConfirmModal` dědí kontrakt z dodatku vlny 1,
sekce N2 (zásobník `store.dialogStack`) — tedy až po bodu 1.

---

## G. Nasazení

Vlna 2 se nasazuje **jedním buildem pro celky 4+5+6** a **nenasazuje se zároveň
s vlnou 1** — každá vlna má vlastní přejímku. Po nasazení
`sudo docker builder prune -af`, `df -h /` před a po do evidence.

---

## H. Nálezy pro další dávku

- Délka skladby u lajků (K10) — chybí `duration_ms` v uložených datech.
- Skutečná procenta z yt-dlp — vyžaduje přepsat sdílený `_run` na streamování.
- `/api/search` nevrací `errors` → jednotypové taby nemají co zobrazit při výpadku.
- `episode` je v API, ale v UI není cesta, jak se k němu dostat.
- Hraniční pásmo tempo filtru: při `noBpm/total` mezi 0 a 0,8 se namountuje plně
  aktivní filtr nad daty, kde skoro není co filtrovat; větev s popiskou
  „Tempo filter needs analyzed local tracks" je pro album i playlist nedosažitelná.
