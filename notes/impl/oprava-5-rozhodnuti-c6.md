# Oprava 5 — celek 6, backend: evidence

Worktree `/home/lucas/music-seeker-wt/oprava-5-c6-backend`, větev `oprava-5-c6-backend`
nad `b1f6078` (vlna 1 nasazena, produkce 1.26.0). Necommitnuto, nenasazeno.

Celek 6 nemá prohlížečový orákulum — servírovat jde jen `static/`, takže změna v `app/`
se přes stránku neověří. Orákulem je **pytest**: ke každému bodu kontrola, která nad
nezměněným kódem **padá**, a mutace, která ji nad opraveným kódem **rozsvítí červeně**.

Výchozí stav sady: **82 passed, 3 skipped** (`scratchpad/autor-5-c6/baseline.txt`).
Konečný stav: **100 passed, 3 skipped** (`scratchpad/autor-5-c6/final_pytest.txt`),
`node --test tests/js/bpm_client.test.mjs` → 10 pass (`final_node.txt`).

---

## Jak se měřila červená

Produkční kód = tento strom bez změn v `app/`: `git stash push -- app/`, pustit nové
soubory, `git stash pop`. Testy se pouštějí po souborech, protože chybějící
`_track_progress` je chyba při sběru a ta jinak přeruší celý běh.
Výstup: `scratchpad/autor-5-c6/red_*.txt`.

```
test_genre_browse      3 failed, 1 passed
test_top_result        3 failed, 3 passed
test_lidarr_handoff    3 failed, 2 passed
test_download_progress 1 error (ImportError: _track_progress)
```

## Jak se měřily mutace

`scratchpad/autor-5-c6/mutate.py` — vždy jedna změna zpět, celá sada, pak obnova.
Výstup `scratchpad/autor-5-c6/mutations.txt`. **Žádná mutace nepřežila.**

| mutace | výsledek |
|---|---|
| B1 odebrat `Accept-Language` | 1 failed |
| B2 vrátit Deezerův vlastní seznam interpretů | 2 failed |
| B3 přesná shoda jména vyhrává bez podmínky | 2 failed |
| B3 první jmenovec místo největšího | 1 failed |
| K3 zrušit příznak `handed_off` | 2 failed |
| K4 vrátit původní vzorec `(done - 1) / total` | 2 failed |

---

## B1 — dlaždice žánrů chodí česky

`app/services/search_providers.py:345` — `deezer_genres()` posílá
`headers={"Accept-Language": "en"}`.

**Měření proti živému Deezeru** (`scratchpad/autor-5-c6/b1.txt`, 22. 10. 2026). Holý
požadavek vs. požadavek s hlavičkou se liší v **devíti z dvaceti tří** jmen:

```
holý : Všechny, Pop, Rap/Hip Hop, Rock, R&B, Taneční hudba, Alternativní hudba, …,
       Klasická hudba, Filmy/videohry, …, Africká hudba, …, Pro děti
en   : All, Pop, Rap/Hip Hop, Rock, Dance, R&B, Alternative, …,
       Classical, Films/Games, …, African Music, …, Kids
```

Kritika měla pravdu proti vlastní předpovědi: rozhoduje hlavička, ne jen IP.

**Kontrola** `tests/test_genre_browse.py::test_genre_tiles_are_not_czech`. Píše se na
**text dlaždic**, ne na pořadí — Deezer vrací obě jazykové verze v jiném pořadí (R&B
a Dance si prohodí místo), takže kontrola na pořadí by zezelenala ze špatného důvodu.
Falešný klient odpovídá česky, dokud požadavek neřekne `Accept-Language: en` — tím měří
opravu, ne fixturu.

**Poznámka o cache opravena proti zadání.** `_genre_list_cache` je obyčejný modulový
dict, tedy jen v paměti procesu: nasazení = nový kontejner = prázdná cache = angličtina
**hned při prvním požadavku**. Žádné 24h okno zastaralosti neexistuje. Riziko je opačné
— přejímka spuštěná proti kontejneru, který se nerekreoval.

## B2 — žánrový žebříček vrací mimo žánr

`app/services/search_providers.py:376` + nový `_chart_artists()` na `:388`.

**Měření na pěti žánrech** (`scratchpad/autor-5-c6/b2.txt`): Pop, Rock, Rap/Hip Hop,
Jazz, Metal. Překryv `artists` se `/chart/0` je **10/10 u všech pěti** — je to doslova
regionální seznam. Pod „Rock" stáli Taylor Swift, P T K, Yzomandias a německý
audioknižní kanál. **Alba scopovaná jsou** (Judas Priest a Pink Floyd pod Rockem,
Weather Report pod Jazzem), takže se **nezahazují**.

Interpreti se odvozují ze **surových** řádků `_rows("tracks")` před mapováním, dedup
podle `artist.id`, pořadí prvního výskytu. Surových proto, že `_deezer_track` dává do
`image` **obal alba** — odvozená karta by nesla desku místo portrétu. Odvozené seznamy
z měření: Rock → Guns N' Roses, The Beaches, Bon Jovi, Springsteen, The Killers,
Survivor; Jazz → Nina Simone, Laufey, Gil Scott-Heron, Robert Glasper, Roy Ayers;
Metal → AC/DC, Pain, System of A Down, Rammstein, Turnstile.

**Fixtura je zaznamenaná odpověď**, ne vymyšlený tvar: `GET /chart/152?limit=5`
z 22. 10. 2026, ořezaná o pole, která mapovače nečtou. Blok `artists` v ní je doslovný
— Taylor Swift, P T K, Yzomandias — tedy ta chyba sama.

**Kontroly** `test_rock_chart_has_no_regional_pop_stars` (text karet),
`test_derived_artists_carry_a_portrait_not_a_sleeve` (adresa obrázku je portrét a není
to žádný z obalů v témže žebříčku), `test_albums_are_kept`.

Fixtura leží **v testovém modulu**, ne jako `tests/fixtures/*.json`: přidělené soubory
jsou `tests/test_*.py` a zakládat vedle nich další strom by přidělení obešlo.

## B3 — top výsledek dá přednost jmenovci před skladbou

> **Absolutní práh z tohoto oddílu byl v druhém kole zrušen** (nález R6.1 a R6.2).
> Kalibrační tabulka níž platí jako měření Deezeru, rozhodnutí o prahu ne —
> platné znění je v oddílu „Druhé kolo".

`app/services/search_providers.py:1150` (`_TOP_RESULT_MIN_FANS = 1_000_000`) a `:1162`.

Track dict **nenese žádnou veličinu popularity** (`_deezer_track` zahazuje `rank`),
takže navržené porovnání „interpret vs. skladba" nemá druhou stranu. Měří se `nb_fan`
interpreta, který už je na položce jako `fans` (`search_providers.py:152`).

**Kalibrace na patnácti dotazech** proti živému Deezeru
(`scratchpad/autor-5-c6/b3.txt`, 22. 10. 2026):

| strana | dotaz | jmenovec (fanoušků) | správná odpověď |
|---|---|---|---|
| špatně dnes | one more time | 4 187 | One More Time — Daft Punk |
| špatně dnes | creep | 4 020 | Creep — Radiohead |
| špatně dnes | bohemian rhapsody | 5 371 | Bohemian Rhapsody — Queen |
| špatně dnes | yesterday | 1 193 | YESTERDAY — Hamza |
| špatně dnes | hurt | 8 076 | Hurt — Johnny Cash |
| špatně dnes | thriller | 324 | Thriller — Michael Jackson |
| špatně dnes | hello | 3 757 | Hello — Adele |
| špatně dnes | imagine | 11 378 | Imagine — Carbonne |
| špatně dnes | zombie | 397 | Zombie — GIMS |
| správně dnes | adele | 15 500 326 | interpret |
| správně dnes | queen | 12 841 063 | interpret |
| správně dnes | nirvana | 10 092 597 | interpret |
| správně dnes | daft punk | 5 224 729 | interpret |
| správně dnes | radiohead | 4 108 466 | interpret |
| bez jmenovce | smells like teen spirit | — | skladba (dnes i potom) |

Nejhorší falešná shoda 11 378, nejslabší pravá 4 108 466. Práh **1 000 000** leží
uprostřed té mezery: 88× nad nejhorším jmenovcem, 4× pod nejslabším pravým interpretem.
Zadání jmenovalo „creep" a „bohemian rhapsody" mezi dnes správnými — **měřením je to
vyvráceno**, oba dnes selhávají; dodatek to opravil stejně.

Dvě upřesnění proti návrhu: bere se **největší** jmenovec, ne první v pořadí (Deezerovo
pořadí relevance není pořadí podle velikosti — „Adele" vrací čtyři Adele, nejmenší má
386 fanoušků), a malý jmenovec se vrací dál, když nic jiného nesedlo — jinak by místo
něj padl `artists[0]`, tedy interpret, na kterého se nikdo neptal.

**Kontroly** `tests/test_top_result.py`, obě strany kalibrační sady plus tři hraniční
případy.

## B4 — `type=episode` v `/api/search`

**Žádný kód.** `episode` zůstává v patternu (`app/routers/search.py:16`). Odebrání je
změna veřejného kontraktu s nulovým ziskem: backend ten typ plně implementuje
(`search.py:22-25` posílá `podcast_provider` a vypíná hudební fallback), udělalo by to
z funkční implementace mrtvý kód, a „nikdo to nevolá" se nedá ověřit — existuje nativní
Android klient, jehož zdroj v repu není (`project_android_app`: Kotlin žije jako
heredoc v `build-desktop.yml`). Zpřístupnit ho pod Podcasts je frontend, tedy jiná dávka.

## K3 — backend: Lidarr hlásí hotovo dřív, než cokoli stáhne

`app/services/jobs.py:41` (`handed_off: bool = False`), `:49` (`to_history()`),
`:91` (`_save_history` přes `to_history`), `app/services/downloader.py:749`
(`_run_lidarr` nastaví příznak).

**Nový stav v enumu je zakázaný** a tady je proč měřitelně: `jobs.py` filtruje na
trojici terminálních stavů na `:92`, `:102` a `:151` (`_save_history`,
`save_if_finished`, `clear_history`), takže čtvrtý stav by se musel doplnit do všech tří
— jinak by se job neuložil do historie, nepřežil restart a nešel smazat. Navíc `:80`
vyhodí `ValueError` na neznámém statusu **uvnitř holého `except`**, tedy tichá ztráta
celé historie při rollbacku.

Ze stejného důvodu se příznak **neukládá na disk**: `to_history()` ho odstraní, takže
starší image čtoucí soubor přes `Job(**e)` se neudusí na klíči, který nezná. Příznak
popisuje předání, které udělal **tenhle** proces — což je přesně to, co potřebuje živý
panel stahování, a co záznam starší než proces stejně nemůže tvrdit.

**Kontroly** `tests/test_lidarr_handoff.py`: job s metodou lidarr má příznak a status
DONE; job s yt-dlp příznak nemá; job s lidarr **je po doběhnutí v historii** a
`clear_history()` ho odstraní; zápis na disk drží tvar, který starší image přečte;
API tvar příznak nese.

Falšuje se **jen HTTP vrstva** — `_run_lidarr` běží doopravdy. Stub, který by příznak
nastavil sám, by měřil stub; v první verzi tohohle souboru přesně to prošlo i nad
nezměněným kódem (dataclass bez `__slots__` přijme libovolný atribut) a bylo to přepsáno.

Frontendová polovina (odznak „Sent to Lidarr", přeskočení notifikace, zalomení věty)
patří celku 5.

## K4 — backend: ukazatel postupu

`app/services/downloader.py:84` (`_track_progress`), `:447` (yt-dlp), `:679` (slskd).
Vzorec `int(done / total * 100)` **po dokončení stopy** místo `int((i - 1) / total * 100)`
před jejím začátkem. `progress` tím začne znamenat „hotová část práce".

**Kontrola** `tests/test_download_progress.py`, mutace vrátí původní vzorec → 2 failed.

**Skutečná procenta z yt-dlp se nedělají** — vyžádalo by si to přepsat sdílený `_run`
(`downloader.py:31-49`) na čtení po řádcích, a ten obsluhuje i metaflac a ffmpeg.
Samostatná dávka.

---

## PŘIZNANÉ MEZE

1. **K4 sám o sobě nerozhýbe pruh u jednostopého stahování.** Změřeno čtením kódu:
   jediná stopa dostane `(1-1)/1 = 0` před začátkem i `0` po celou dobu běhu v obou
   verzích, a na 100 ho stejně postaví **nepodmíněné `job.progress = 100` za smyčkou**
   (`downloader.py:449`, `:681`). Rozdíl mezi starým a novým vzorcem je proto pro
   uživatele **neviditelný**; viditelná část K4 je frontendový neurčitý ukazatel na
   `progress === 0 && status === 'running'` (celek 5) a skutečná procenta (jiná dávka).
   Důsledek pro recenzi: mutace „zavolat `_track_progress(i - 1, total)` před stažením"
   **přežije** — ne proto, že chybí kontrola, ale protože je sémanticky ekvivalentní.
   Kontrola na smyčku se proto nepsala; byla by to kontrola, která nemůže zčervenat.
2. **Celek 6 nemá prohlížečovou zelenou.** Sdílený postroj `tests/e2e/audit/helpers.mjs`
   servíruje `static/`; soubory v `app/` se přes stránku nenaservírují, takže kontrola
   v `tests/e2e/audit/*.mjs` by měřila produkční backend bez mých změn. Orákulem je
   pytest nad skutečnými funkcemi.
3. **Rollback na image starší než tahle dávka** je ošetřen jen pro `handed_off`
   (přes `to_history()`). `_load_history()` dál padá na **jakémkoli** neznámém klíči
   nebo statusu, a to uvnitř holého `except`, tedy tiše a pro celou historii. Nesahal
   jsem na to — je to vada nad rámec přidělených bodů. Viz nálezy níž.
4. **Počet odvozených interpretů u žánru je menší než `limit`.** `deezer_genre_chart`
   dostane `limit` stop a z nich vznikne tolik interpretů, kolik je mezi nimi různých
   (měřeno 8–10 z 10). Dřív jich bylo přesně `limit`, ale byli z jiného žánru.
5. **Práh `nb_fan` je kalibrovaný na patnácti dotazech**, všech v latince a v hudbě,
   kterou měří evropský Deezer. Pro scénu, kde nikdo nemá milion fanoušků, bude práh
   vždycky volit skladbu. Pojistka je větev „malý jmenovec, když nic jiného nesedlo",
   ne práh sám.

## CO JINAK A PROČ

- **K3: příznak se neukládá na disk** (nad rámec dodatku, který jen zakázal nový stav).
  Dodatek zdůvodnil volbu tím, že „perzistence, restart i Clear history fungují beze
  změny" — zapsat nový klíč do historie ten formát mění a otevírá přesně tu rollbackovou
  past, kvůli které se nový stav zakázal. `to_history()` ten slib drží doslova.
- **B3: největší jmenovec, ne první v pořadí.** Dodatek mluvil o prahu, ne o výběru.
  `_deezer_artists_by_size` (`:994`) vrací jmenovce seřazené podle velikosti jen tehdy,
  když se vůbec uplatní; když vrátí `None`, zůstává Deezerovo pořadí relevance a první
  jmenovec může být ten se 386 fanoušky. Samostatná kontrola + samostatná mutace.
- **B3: malý jmenovec jako poslední záchrana.** Bez téhle větve by dotaz, kde existuje
  jen malý interpret toho jména a žádné skladby, spadl na `artists[0]` — jiného
  interpreta. Zachovává dnešní chování tam, kde bylo správné.
- **B2: fixtura v testovém modulu, ne v `tests/fixtures/`.** Viz B1/B2 výš — držím se
  přidělených souborů.
- **`fans` zmizelo z karet interpreta v žánrovém žebříčku.** Odvozený řádek Deezer
  nedává; `grep -rn "\.fans" static/js/` nevrací nic, takže to pole nikdo nečetl.
  Vymýšlet nulu by bylo horší než ho vynechat.

## NÁLEZY PRO DALŠÍ DÁVKU

- `_load_history()` (`jobs.py:73-84`) má holý `except` kolem **celé** smyčky: jediný
  vadný záznam zahodí celou historii. Per-záznam `try` a zahazování neznámých klíčů by
  tu třídu selhání zrušilo nadobro.
- `job.progress = 100` za smyčkou (`downloader.py:449`, `:681`) se nastaví i tehdy, když
  se smyčka přerušila na překročené kvótě — job hlásí sto procent a neúplný výsledek.
- Skutečná procenta z yt-dlp (přepis `_run` na streamování), viz dodatek, oddíl H.

---

# Druhé kolo

Nad týmž worktree, nad `b1f6078`. Odbavené nálezy: **R6.1** (blokující) a **R6.2**.
Necommitnuto, nenasazeno. Skripty a surové výstupy: `scratchpad/autor2-5-c6/`.

Sada po druhém kole: **105 passed, 3 skipped** (`scratchpad/autor2-5-c6/suite-po-oprave.txt`,
`rc=0`), `node --test tests/js/bpm_client.test.mjs` → **10 pass, 0 fail**
(`node-po-oprave.txt`, `rc=0`). Žádný partial se nedotkl, takže `build-index.sh`
ani `check-index.sh` se nepouštěly.

## R6.1 — absolutní práh zrušen, rozhoduje relativní vlastnictví stránky

`app/services/search_providers.py`: `_TOP_RESULT_MIN_FANS` pryč, přibylo
`_artist_owns()` / `_artist_owns_enough()` nad existujícími konstantami
`_ARTIST_DOMINANCE_MIN = 3` a `_ARTIST_DOMINANCE_SAMPLE = 10`. `_pick_top_result`
se ptá, kolik ze stránky (hlavička seznamu skladeb + alb) už tomu interpretovi
patří; `_deezer_popular_first` teď používá **tutéž** funkci místo vlastní kopie
téhož výpočtu.

### Kalibrace — čeští a menší interpreti (musí vyhrát INTERPRET)

Měřeno přes `search_all(limit_per_type=8)` proti **živému Deezeru**, tedy přes
celý skutečný řetězec, ne přes náhradu měřeného kódu. Skript `kalibrace.py`,
výstupy `kal-produkce.txt` (strom `main`), `kal-prvni-kolo.txt` (práh 1 000 000),
`kal-druhe-kolo.txt` (odevzdané znění), 22. 10. 2026.

| dotaz | fanoušků | produkce (main) | první kolo (práh 1 M) | **druhé kolo** |
|---|---|---|---|---|
| chinaski | 17 728 | interpret | **skladba „Potkal Jsem Tě Po Letech"** | **interpret** |
| ektor | 36 487 | interpret | **skladba „KSN (PINTLICH REMIX)"** | **interpret** |
| yzomandias | 15 238 | interpret | **skladba „Limbo"** | **interpret** |
| mandrage | 14 539 | interpret | **skladba „Srouby a matice"** | **interpret** |
| wohnout | 13 555 | interpret | **skladba „Svaz českých bohémů"** | **interpret** |
| olympic | 5 071 | interpret | **skladba „Slzy Tvý Mámy"** | **interpret** |
| mig 21 | 4 430 | interpret | **skladba „Snadne je zit"** | **interpret** |
| kryptor | 148 | interpret | **skladba „Greedpeace"** | **interpret** |
| portishead | 584 000 | interpret | **album „Portishead"** | **interpret** |
| bonobo | 366 000 | interpret | **skladba „Tides"** | **interpret** |
| khruangbin | 99 000 | interpret | **skladba „Chocolate Hills"** | **interpret** |
| adele | 15 500 326 | interpret | interpret | interpret |
| queen | 12 841 063 | interpret | interpret | interpret |
| nirvana | 10 092 597 | interpret | interpret | interpret |
| **součet** | | **14/14** | **3/14** | **14/14** |

Review hlásilo „7 z 10 dotazů k horšímu"; nad širší sadou je to **11 ze 14**.

### Kalibrace — názvy skladeb se jmenovcem (musí vyhrát SKLADBA)

| dotaz | jmenovec (fanoušků) | produkce (main) | první kolo | **druhé kolo** |
|---|---|---|---|---|
| creep | 4 020 | **interpret „Creep"** | skladba — Radiohead | **skladba — Radiohead** |
| bohemian rhapsody | 5 371 | **interpret** | skladba — Queen | **skladba — Queen** |
| one more time | 4 187 | **interpret** | skladba — Daft Punk | **skladba — Daft Punk** |
| hurt | 8 076 | **interpret** | skladba — Johnny Cash | **skladba — Johnny Cash** |
| yesterday | 1 193 | **interpret** | skladba — Hamza | **skladba — Hamza** |
| thriller | 324 | **interpret** | skladba — Michael Jackson | **skladba — Michael Jackson** |
| hello | 3 757 | **interpret** | skladba — Adele | **skladba — Adele** |
| imagine | 11 378 | **interpret** | skladba — Carbonne | **skladba — Carbonne** |
| zombie | 397 | **interpret** | skladba — GIMS | **skladba — GIMS** |
| **součet** | | **0/9** | **9/9** | **9/9** |

Obě strany tedy vycházejí **14/14 a 9/9**; žádná z nich se neplatí druhou.

### Proč to funguje: naměřený odstup

`mereni-signalu.py` → `signaly.txt`: kolik z osmi skladeb a osmi alb na stránce
nese dotazované jméno.

| skupina | vlastnictví stránky (ze 16 řádků) |
|---|---|
| 16 dotazů na interpreta | 3 (kryptor) a dál 14–16 |
| 10 názvů skladeb | 0, jen „hurt" 1 |

Mezi 1 a 3 je práh `_ARTIST_DOMINANCE_MIN = 3`, který už v modulu byl. Stabilita
hraničních případů: `kryptor-opakovani.txt`, šest běhů po sobě — kryptor 3/16
pokaždé, hurt 1/16 pokaždé.

## R6.2 — brána se neuplatňuje na číslo, které provider neposílá

`fans` skládá jen deezerovský maper (`search_providers.py:152`); iTunes
(`:627`) ani YouTube Music (`:516`) klíč nemají. Vlastnictví se proto čte
z `artist_id` tam, kde ho provider razítkuje, a jinak z textu autora —
YouTube Music spojuje víc jmen do jednoho řetězce („Queen, David Bowie"),
takže se čte i jako seznam. Velikost interpreta už nerozhoduje vůbec;
`max(..., key=fans)` zůstává jen pro výběr mezi víc jmenovci a tam, kde `fans`
nikdo neposílá, se chová jako „první přesná shoda", tedy jako dřív.

Měřeno `kalibrace-provideri.py` proti živým API (`prov-prvni-kolo.txt` proti
`prov-druhe-kolo.txt`):

| provider | dotaz | první kolo (práh 1 M) | **druhé kolo** |
|---|---|---|---|
| itunes | metallica | skladba „One" | **interpret Metallica** |
| itunes | queen | skladba „Queen" — Loren Gray | **interpret Queen** |
| itunes | chinaski | skladba „Chinaski" — Venetian Snares | **interpret Chinaski** |
| ytmusic | metallica | skladba „METALLICA" — SDM, Werenoi | **interpret Metallica** |
| ytmusic | queen | skladba „Queen" — SOUTH BLUE | **interpret Queen** |
| ytmusic | chinaski | skladba „Positivo Pesimismo" | **interpret Chinaski** |
| obojí | creep / bohemian rhapsody / hurt | skladba | **skladba** (beze změny) |

Karta interpreta tedy byla u obou providerů zavřená i pro Metallicu a Queen,
přesně jak review psalo; po opravě je 12/12 správně.

## Nález nad rámec zadání: `limit_per_type` až 20

Při měření na horní mezi endpointu (`/api/search/all`, `le=20`) vyšlo, že
absolutní počet „aspoň tři řádky" se stránkou roste: při 20 na typ držela kapela
„Hurt" **pět ze čtyřiceti** řádků a kartu by dostala ona místo Johnnyho Cashe
(`mez-limit20.txt`). Brána proto čte jen **hlavičku** obou seznamů
(`_ARTIST_DOMINANCE_SAMPLE` z každého), takže na velikosti stránky nezávisí.
Po opravě `mez-limit20-final.txt`: **9/9 skladeb a 7/7 interpretů** i při 20,
vlastnictví hlavičky hurt 2/20 proti kryptor 3/20.

Druhá drobnost, kterou si vynutila čárka: jméno samo může čárku obsahovat
(„Crosby, Stills & Nash"), takže se autor porovnává **i celý**, nejen po dílech.

## Jak se měřila červená (druhé kolo)

`cervena-pred-opravou.txt` — stejný postup jako v prvním kole, jen se vrací dva
konkrétní stavy, se kterými review porovnávalo:

```
PRODUKCE (main, žádná brána)          3 failed, 8 passed
  test_a_song_beats_a_band_that_owns_none_of_the_page
  test_a_bigger_page_does_not_let_the_namesake_in_through_the_back
  test_an_exact_song_title_wins_over_an_unrelated_first_track
PRVNÍ KOLO (absolutní práh 1 000 000) 5 failed, 6 passed
  test_an_artist_wins_their_own_name_however_small_they_are
  test_a_provider_without_fan_counts_still_gets_an_artist_card
  test_a_joined_credit_counts_for_everyone_named_in_it
  test_a_comma_inside_a_name_is_not_a_list_of_two
  test_ownership_is_read_from_the_id_when_the_credit_text_differs
```

Oracle tedy padá v **obou** stavech, proti kterým se oprava vymezuje, a nad
odevzdaným stromem je zelený.

## Mutace (druhé kolo)

`mutate.py` → `mutace.txt`, patnáct mutací včetně čtyř z prvního kola; každá
pouští celou sadu a vrací soubor zpět. **Žádná nepřežila** (`rc=0`,
„UNCAUGHT MUTATIONS: none“):

```
B1  drop Accept-Language                          1 failed
B2  back to Deezer's own artist list              2 failed
K3  no hand-off flag                              2 failed
K4  back to counting started tracks               2 failed
R6.1 production: exact name wins unconditionally  3 failed
R6.1 round one: absolute fan threshold            5 failed
R6.1 count only the tracks, not the albums        1 failed
R6.1 judge the whole page, not its head           1 failed
R6.1 demand the whole page instead of three rows  2 failed
R6.1 one row is enough                            1 failed
R6.2 compare the joined credit whole only         1 failed
R6.2 split the credit and never compare it whole  1 failed
R6.1 ignore artist_id, text only                  1 failed
B3  first namesake instead of the biggest         1 failed
B3  drop the small-namesake fallback              1 failed
```

## MEZE DRUHÉHO KOLA

1. **Kryptor leží přesně na prahu** (3 z 16 řádků hlavičky; šest běhů po sobě
   stejně). Jeden řádek navíc od cizí kapely a karta interpreta mu propadne na
   skladbu. Je to nejmenší měřený interpret vůbec (148 fanoušků) a odstup od
   nejhoršího jmenovce („hurt", 1 řádek) jsou dva řádky — ne řády, jak to vypadalo
   u fanouškovského prahu. Pásmo 2 řádky **není změřené na širší sadě**.
2. **Vlastnictví se čte ze stránky, kterou už změnilo `popular_first`.** U dotazu
   na interpreta může být seznam skladeb přeskládaný tak, že vede jeho tvorba —
   signál se tím zesiluje sám. Nevadí to (je to tentýž závěr dvakrát), ale znamená
   to, že brána a `popular_first` nejsou nezávislé.
3. **Měřeno jen proti evropskému Deezeru, iTunes a YouTube Music.** Spotify cestou
   `search_all` neprošla — `_SEARCH_FUNCS` ji nemá, a produkční klíče jsou mrtvé
   (viz paměť projektu).
4. **Deezer kvóty.** Jeden běh kalibrace spadl do „Quota limit exceeded" u šesti
   dotazů; výsledek i tak vyšel 14/14 a 9/9, protože řetězec degraduje na prosté
   hledání. Odevzdaný běh `kal-druhe-kolo.txt` je bez jediné kvótové chyby.
5. **Neměřeno v prohlížeči.** Platí důvod z prvního kola: `app/` se přes stránku
   neservíruje, orákulem je pytest nad skutečnými funkcemi plus živá API.

## CO JINAK A PROČ (druhé kolo)

- **Vlastnictví počítám ze skladeb i alb, ne jen ze skladeb.** Review mluvilo
  o „běžných výsledcích". Jen skladby by Kryptoru nestačily (1 z 8) a karta by mu
  propadla; alba jsou druhá polovina téže stránky a u jmenovců zůstávají na nule
  (nejhorší „hurt" 1 z 8). Mutace „count only the tracks" to drží.
- **Hlavička místo celé stránky.** Nad rámec nálezu, viz oddíl o `limit_per_type`.
- **`_deezer_popular_first` přepnut na sdílenou funkci.** Měl vlastní kopii téhož
  výpočtu; dvě kopie jednoho pravidla by se rozešly při první úpravě prahu.
- **Starý oddíl B3 výš jsem nepřepsal**, jen označil jako překonaný. Kalibrační
  tabulka v něm je pořád platné měření Deezeru a review se na ni odkazuje.

---

# Třetí kolo

Nad týmž worktree, nad `b1f6078`. Odbavené nálezy ověřovacího kola: **regrese proti
produkci u iTunes** (střední) a **přeživší mutace** `min(..., len(rows))` (nízká).
Necommitnuto, nenasazeno, na produkci nesaháno. Skripty a surové výstupy:
`scratchpad/autor3-5-c6/`.

Sada po třetím kole: **109 passed, 3 skipped** (`suite-treti-kolo.txt`, `rc=0`),
`node --test tests/js/bpm_client.test.mjs` → **10 pass, 0 fail** (`node3.txt`, `rc=0`),
`scripts/check-index.sh` → `rc=0` (`check-index.txt`; na žádný partial jsem nesáhl).

Změny v `app/`: dvě. `_CREDIT_JOINERS` + `_credit_names()` v `search_providers.py:939`
a `ITUNES_COUNTRY` + parametr `country` v `itunes_search` (`:49`, `:605`).
Testy: čtyři nové v `tests/test_top_result.py` a jeden přepsaný.

---

## 1) Regrese u iTunes — zadaná příčina platí jen z poloviny

### Čím jsou kredity doopravdy spojené (měření, ne odhad)

`sonda-credity.py` → `sonda-credity.txt`: osmnáct dotazů, u každého osm skladeb a osm
alb, u všech **tří** providerů, a na každém kreditu zkouška deseti kandidátních
oddělovačů. Dohromady **839 kreditů**:

| oddělovač | itunes (267) | deezer (288) | ytmusic (284) |
|---|---|---|---|
| `,` | 34 | 22 | 57 |
| ` & ` | **62** | 22 | 32 |
| ` feat. ` | 0 | 0 | 0 |
| ` ft. ` | 0 | 0 | 0 |
| ` x ` | 0 | 0 | 0 |
| ` with ` | 0 | 0 | 0 |
| ` and ` | 0 | 0 | 0 |
| ` vs ` | 0 | 0 | 0 |
| `/` | 0 | 0 | 1 |
| `;` | 0 | 0 | 0 |

Proto se dělí **jen čárkou a ` & `**. `feat.` a `ft.` v kreditu nejsou ani jednou,
protože všichni tři providery drží hosta v **názvu** („Dresscode (feat. Yzomandias)“),
ne u autora — dělit podle nich by bylo přesně to, co zadání zakazuje: dohad, který
umí rozseknout jméno. Jediné `/` je `'Olympic, Orchestr/Vladimír Popelka'`, tedy
dirigent u orchestru; jeden výskyt z 839 není vzorek, na kterém se mění pravidlo.

Celý kredit se dál porovnává **i vcelku** — oba oddělovače jsou součástí skutečných
jmen („Earth, Wind & Fire“ nese dokonce oba najednou, „Crosby, Stills & Nash“ taky).

### Yzomandias: ` & ` to opravdu způsobil

`sonda-vlastnictvi-pred.txt`, iTunes, 22. 10. 2026 — celá stránka má pět řádků:

```
track  'Żabson & Yzomandias'    'Elegancko'
track  'El Nino'                'Dresscode (feat. Yzomandias)'
track  'Fvck_kvlt & Yzomandias' 'Sokratov Cowbell'
track  'Gosha Grey'             'Revoluce (feat. Yzomandias & Dusan Vlk)'
album  'Żabson & Yzomandias'    'Elegancko - Single'
```

Tři z pěti řádků jsou jeho a dělení čárkou nezapočítá ani jeden → `_artist_owns = 0`,
brána zavřená, kartu dostala skladba „Elegancko“. Po dělení ` & ` jsou to 3 z 5,
práh `min(3, 5) = 3` → **interpret**.

### Olympic: zadaná příčina NEPLATÍ, příčina je jinde

Tentýž výpis pro „olympic“ na iTunes má `_artist_owns = 0 z 16` a **žádný** z šestnácti
řádků nepatří Olympicu — ani po jakémkoli dělení. Stránka je:

```
track 'Cleveland Symphonic Winds & Frederick Fennell'  'Olympic Theme'
track 'Berlin Philharmonic Orchestra & John Williams'  'Olympic Fanfare and Theme'
track 'French 79' / 'Philip G Anderson' / 'Paul Gilbert' / 'Millencolin' / '808 State' …
album 'John Williams' ('Summon the Heroes', 'Jurassic Park') / 'French 79' / 'Senri Oe' …
```

Je to **olympiáda**, ne kapela. Oprava dělení s tím neudělá nic a žádné povolení
brány, které by tuhle stránku pustilo, by zároveň nezavřelo „creep“ — obě mají
vlastnictví 0.

Příčina je, že **iTunes odpovídá za americký obchod bez ohledu na to, odkud se volá**.
Deezer i YouTube Music odpovídají za region volajícího (Deezer tak důsledně, že v
prvním kole posílal české názvy žánrů sám od sebe). Kapela na iTunes je, jako interpret
`1376449023` s alby `Trilobit`, `Jako Zamlada`, `66 Nej + 1`
(`itunes-olympic-kdo.txt`) — jen v US obchodě o ní na stránce „olympic“ nic není.

`itunes-storefront.txt` / `itunes-storefront-skladby.txt`, kolik z 8 skladeb + 8 alb
nese dotazované jméno (dělení čárkou i ` & `):

| dotaz | US | CZ | | dotaz (název skladby) | US | CZ |
|---|---|---|---|---|---|---|
| olympic | **0/16** | 14/16 | | creep | 0/16 | 0/16 |
| yzomandias | 3/16 | 6/16 | | bohemian rhapsody | 0/16 | 0/16 |
| chinaski | 8/16 | 16/16 | | one more time | 0/16 | 0/16 |
| mig 21 | 7/16 | 16/16 | | hurt | 0/16 | 0/16 |
| wohnout | 14/16 | 16/16 | | thriller | 0/16 | 0/16 |
| ektor | 8/16 | 10/16 | | hello | 0/16 | 0/16 |
| kryptor | 10/16 | 10/16 | | yesterday | 0/16 | 0/16 |
| mandrage | 7/16 | 16/16 | | imagine | 0/16 | 0/16 |
| queen | 9/16 | 8/16 | | zombie | 0/16 | 0/16 |
| metallica | 15/16 | 15/16 | | | | |
| portishead | 16/16 | 16/16 | | | | |

Obchod tedy hýbe **katalogem, ne branou**: na straně názvů skladeb je vlastnictví
nula u obou, takže se za tu změnu nic neplatí. Proto `itunes_search` posílá
`country=ITUNES_COUNTRY` (`"CZ"`).

**Podcasty** jdou týmž voláním (iTunes je výchozí `podcast_provider`), takže jsem je
změřil zvlášť — `itunes-podcasty.txt`, čtyři dotazy: první výsledek je na obou
obchodech **tentýž** („Vinohradská 12“, „The Joe Rogan Experience“, „Darknet Diaries“,
„Brain We Are“), rozdíly jsou až na čtvrtém a pátém místě.

### Živé ověření přes `search_all` (povinné)

`kalibrace-itunes.py` → `kal3-itunes-po.txt`, `kal3-dz-ytm-po.txt`, 22. 10. 2026,
`search_all(provider=…, fallback='', limit_per_type=8)` proti živým API:

| dotaz | očekáváno | **itunes** | vlastnictví | **deezer** | **ytmusic** |
|---|---|---|---|---|---|
| olympic | artist | **artist** | 14/16 | artist | artist |
| yzomandias | artist | **artist** | 6/15 | artist | artist |
| chinaski | artist | artist | 16/16 | artist | artist |
| mig 21 | artist | artist | 16/16 | artist | artist |
| wohnout | artist | artist | 16/16 | artist | artist |
| ektor | artist | artist | 10/16 | artist | artist |
| kryptor | artist | artist | 10/10 | artist | artist |
| mandrage | artist | artist | 16/16 | artist | artist |
| queen | artist | artist | 8/16 | artist | artist |
| metallica | artist | artist | 15/16 | artist | artist |
| portishead | artist | artist | 16/16 | artist | artist |
| adele | artist | artist | 14/16 | artist | **album** (viz meze) |
| creep | track | **track** | 0/16 | track | track |
| bohemian rhapsody | track | **track** | 0/16 | track | track |
| one more time | track | track | 0/16 | track | track |
| hurt | track | track | 0/16 | track | track |
| thriller | track | track | 0/16 | track | track |
| hello | track | track | 0/16 | track | track |
| yesterday | track | track | 0/16 | track | track |
| imagine | track | track | 0/16 | track | track |
| zombie | track | track | 0/16 | track | track |
| **součet** | | **12/12 + 9/9** | | **12/12 + 9/9** | **11/12 + 9/9** |

Obě vyžádané věci tedy sedí: „olympic“ i „yzomandias“ na iTunes vracejí **artist**,
„creep“ i „bohemian rhapsody“ **track**.

Stabilita, pět běhů po sobě (`opakovani-itunes.txt`) — iTunes neposílá pokaždé jinou
stránku, čísla jsou na řádek stejná:

```
run 1-5: olympic=artist(14/16)  yzomandias=artist(6/15)  creep=track(0/16)  bohemian rhapsody=track(-/16)
```

(`-` u „bohemian rhapsody“ znamená, že iTunes nevrátil žádného interpreta přesně toho
jména, takže se brána ani nemá na čem ptát.)

### Kontroly

`tests/test_top_result.py`:

- `test_an_ampersand_credit_counts_for_everyone_named_in_it` — doslovná naměřená
  pětiřádková iTunes stránka pro „yzomandias“.
- `test_an_ampersand_inside_a_name_is_not_a_list_of_two` — „Earth, Wind & Fire“.
  Původní `test_a_comma_inside_a_name_is_not_a_list_of_two` („Crosby, Stills & Nash“)
  drží beze změny.
- `test_itunes_searches_the_users_storefront_not_the_american_one` — falešný `httpx`
  vrací **americkou** stránku, dokud požadavek neřekne `country=CZ`; obě odpovědi jsou
  zkrácené záznamy skutečných odpovědí. Měří tedy opravu, ne fixturu, stejně jako
  kontrola na `Accept-Language` v prvním kole.

## 2) Přeživší mutace: krátká stránka

`_artist_owns_enough` má práh `min(_ARTIST_DOMINANCE_MIN, len(rows))`. Odstranění
`min(...)` prošlo celou sadou druhého kola, protože každá tamní fixtura měla aspoň
šestnáct řádků. Živý protipříklad existuje — iTunes vrátil na „yzomandias“ **pět** řádků
a na „kryptor“ deset.

`test_a_short_page_is_judged_by_its_own_size`: dva řádky, oba interpretovy. Původní kód
`min(3, 2) = 2` → interpret; mutant `>= 3` kartu nikdy nedá a spadne na `tracks[0]`.
Ověřeno zvlášť (`mutace3-kratka-stranka.txt`): mutace → `FAILED
test_a_short_page_is_judged_by_its_own_size`, `1 failed, 108 passed`.

---

## Jak se měřila červená (třetí kolo)

`cervena3.py` → `cervena-pred-opravou3.txt`: obě změny vrácené najednou, tedy přesně
strom druhého kola.

```
2 failed, 107 passed, 3 skipped
  test_an_ampersand_credit_counts_for_everyone_named_in_it
  test_itunes_searches_the_users_storefront_not_the_american_one
```

Obě nové kontroly k regresi tedy nad stromem druhého kola padají a nad odevzdaným jsou
zelené. Zbylé dvě nové kontroly (jméno s `&` uvnitř, krátká stránka) jsou pojistky,
ne regrese — nad druhým kolem procházejí a červené je dělá až příslušná mutace.

## Mutace (třetí kolo)

`mutate3.py` → `mutace3.txt`, **dvacet dva** mutací: všech patnáct z druhého kola
(dvěma se musela přepsat kotva, protože se `_artist_owns` změnil) a sedm nových. Každá
pouští celou sadu a vrací soubor zpět. `rc=0`, „UNCAUGHT MUTATIONS: none“.

| nová mutace | výsledek |
|---|---|
| R6.3 druhé kolo: dělit jen čárkou | 1 failed |
| R6.3 dělit jen ampersandem | 1 failed |
| R6.3 dělit i každou mezerou | 1 failed |
| R6.3 zahodit `min()`, chtít tři řádky z jakékoli stránky | 1 failed |
| R6.3 druhé kolo: bez obchodu, iTunes odpovídá US | 1 failed |
| R6.3 obchod, ale špatný (`US`) | 1 failed |
| R6.3 **EKVIVALENTNÍ**: přidat oddělovače, které jen tušíme | 109 passed — viz níž |

Patnáct starých mutací zčervenalo beze změny (2 až 9 failed), s jednou výjimkou, kterou
musela opravit kontrola, ne kód — viz „CO JINAK A PROČ“.

**Ekvivalentní mutant je přiznaný, ne schovaný.** Přidání ` feat. `, ` ft. ` a ` with `
mezi oddělovače nezmění ani jednu odpověď, protože v 839 naměřených kreditech se žádný
z nich nevyskytuje. Kontrola na to by musela vymyslet data, která poskytovatelé
neposílají — `mutate3.py` ho proto drží v seznamu a **vyžaduje**, aby zůstal zelený;
kdyby zčervenal, znamená to, že se někde objevil kredit, který to pravidlo poruší.

---

## PŘIZNANÉ MEZE (třetí kolo)

1. **`country=CZ` je natvrdo.** Není to nastavení ani proměnná prostředí — je to
   konstanta s odůvodněním u ní. Pro instanci běžící jinde než v Česku je to špatná
   volba a bude ji muset změnit ruka. Zvažoval jsem `os.getenv`, ale přidávat
   konfigurační povrch kvůli jedné instanci je horší než jeden řádek, který je vidět.
2. **Obchod mění katalog celého provideru, ne jen top kartu.** Změřil jsem obě strany
   kalibrace (12/12 a 9/9) a podcasty (stejný první výsledek u čtyř dotazů), ale
   **neměřil** jsem stahovací cestu `resolve()` ani zbytek katalogu. Co se v CZ obchodě
   neprodává, se v odpovědi neobjeví; v US obchodě to platí stejně, jen o jiných deskách.
3. **„creep“ na iTunes vrací cover.** Top je `'Creep' — 'Kina Grannis'`, ne Radiohead.
   **Není to tahle změna**: druhé kolo na americkém obchodě vrátilo
   `'Creep' — 'Stone Temple Pilots'` (`scratchpad/autor2-5-c6/prov-druhe-kolo.txt`).
   Dělá to větev „přesná shoda názvu skladby“, která vezme první řádek pojmenovaný
   **přesně** „Creep“ — a iTunes vede verzi „Creep (Acoustic)“ od Radiohead, která se
   přesně nerovná. Typ karty je správný, interpret ne. Nález pro další dávku.
4. **YouTube Music na „adele“ nevrátí interpreta vůbec.** `sonda-id-vs-text.txt`:
   jeho seznam interpretů obsahuje „Adele Adkins“, „ADÉLA“, „Adele Evelync“ — žádnou
   přesnou „Adele“. Brána se proto vůbec nedostane ke slovu (`named is None`) a top
   padne na album. Není to regrese téhle dávky ani vada brány, je to pojmenování
   u providera; druhé kolo tenhle dotaz na ytmusic neměřilo.
5. **Větev `artist_id` není na živých datech dosažitelná jinak než textová.** Měřeno
   dvanácti dotazy proti Deezeru (`sonda-id-vs-text.txt`): **žádný** řádek nemá
   interpretovo `artist_id` a zároveň kredit, který by text nepřečetl — Deezer skládá
   obojí z téhož záznamu. Kontrola na tu větev je proto zkonstruovaná a je to v ní
   napsané. Je to pojistka pro providera, který by to razítkoval jinak, ne nosný signál.
6. **Dělení přidává falešné shody u krátkých jmen.** Dotaz „nash“ se teď započítá
   řádku „Crosby, Stills & Nash“, dotaz „fire“ řádku „Earth, Wind & Fire“. Čárka to
   dělala už ve druhém kole („crosby“), ampersand rozšiřuje tutéž třídu. Nezměřil jsem
   ji na sadě — v kalibračních dvaceti jedna dotazech se neprojevila, ale tvrzení
   „neprojeví se“ nemám čím podložit.
7. **Pásmo kolem prahu se nezměřilo znovu.** Mez 1 ze druhého kola (Kryptor leží na
   3/16 na Deezeru) platí beze změny; na iTunes má po změně obchodu 10/16, takže
   nejtěsnější naměřený případ je teď „yzomandias“ na iTunes — 3 z 5 řádků, tedy přesně
   na prahu.
8. **Stále bez prohlížečového orákula.** Platí důvod z prvního kola: `app/` se přes
   stránku neservíruje. Orákulem je pytest nad skutečnými funkcemi plus živá API.

## CO JINAK A PROČ (třetí kolo)

- **Zadaná příčina regrese u „olympic“ se měřením nepotvrdila** a je to v evidenci
  napsané rovně. ` & ` opravuje „yzomandias“ (3 z 5 řádků), u „olympic“ je vlastnictví
  nula po jakémkoli dělení. Udělal jsem obě opravy — tu zadanou, protože data ji
  potvrzují, i tu skutečnou, protože bez ní povinné živé ověření neprojde.
- **Obchod místo povolení brány.** Nabízelo se povolit bránu tam, kde provider
  nerazítkuje `artist_id`. Zahodil jsem to: „olympic“ i „creep“ mají na US obchodě
  vlastnictví **0/16**, takže každé povolení, které pustí jedno, pustí i druhé. Když je
  vstup brány špatná stránka, patří oprava ke vstupu.
- **Kontrola na `artist_id` se musela přepsat.** Používala kredit `'Mig 21 & hosté'`,
  který po nové opravě projde **textovou** cestou — mutace „ignore artist_id“ tím
  přestala červenat. Kredit je teď `'Mig 21 a hosté'`, který žádné dělení nerozebere,
  takže kontrola měří tu větev, kvůli které vznikla. Je to přesně ta třída chyby, na
  kterou si stěžovalo první kolo u K3: kontrola, která prochází z jiného důvodu, než
  si myslí.
- **Oddělovače jako jeden regulární výraz v konstantě**, ne dvě volání `split`.
  `_CREDIT_JOINERS` je jediné místo, kde je to pravidlo zapsané, a mutace na něj míří
  přímo.
- **Ekvivalentní mutant zůstal v seznamu** místo tichého vyhození. Viz výš.
