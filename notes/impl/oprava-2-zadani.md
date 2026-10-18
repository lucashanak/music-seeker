# Oprava 2 — BPM nedostane zvuk, který už má na disku

Stav: návrh zadání, před kritikou. Čísla níž jsou měřená 18. 10. 2026 proti
produkci (192.168.1.22) a proti stromu na `30986db`.

## Nález

`GET /api/bpm/track` vrací 404 „Could not analyze track — audio not available"
u skladeb, které si ve stejné chvíli pustíš a hrají. V logu produkce za 72 h:

    GET /api/player/stream?name=The+Real+Slim+Shady&artist=Eminem   200 OK
    GET /api/bpm/track?name=The%20Real%20Slim%20Shady&artist=Eminem 404 Not Found

Z 22 volání `/api/bpm/track` v tom okně skončilo **18 čtyřistačtyřkou**. Čtyři,
která prošla, byla **výhradně zásahy do cache** — `bpm_analysis.json` má 665
záznamů a všech šest tam už leželo (`eminem::without me`, `nirvana::smells like
teen spirit`, …). Ani jedna skladba se v tom okně neanalyzovala znovu.

## Příčina

Rozlišení zvuku pro přehrávání a pro analýzu se rozchází o jeden stupeň:

| | lokální soubor | Navidrome | YouTube |
|---|---|---|---|
| `resolve_stream` (`app/services/player.py:232`) | ano (243) | ano (249) | **ano (255)** |
| `_get_audio_file` (`app/services/bpm.py:1158`) | ano (1159) | ano (1169, 1176) | **ne** |

`_get_audio_file` končí `return None` na `bpm.py:1163–1164`, když není lokální soubor
a chybí `song_id`; `analyze_track` (`bpm.py:1239`) to propíše na `None` a router
(`app/routers/bpm.py:49–51`) na 404. Skladba, která existuje jen na YouTube,
tedy hraje, ale BPM pro ni **nejde získat žádnou cestou**.

### Zvuk je přitom v kontejneru

`cache_youtube_stream` (`player.py:599`) klíčuje cache jako
`md5(f"{artist}:{name}".lower())[:12]`. V `/tmp/ms-yt-cache` na produkci leží
čtyři soubory; dva z nich jsou přesně skladby, u kterých analýza hlásila, že
zvuk nemá:

    35e792115b51.mp3  =  md5("eminem:the real slim shady")[:12]   → 404 z BPM
    56f0688b9cd3.mp3  =  md5("nirvana:lithium")[:12]              → 404 z BPM

`ms-nav-cache` na produkci **neexistuje** — Navidrome větev se tam reálně
nepoužívá, takže YouTube je pro neznámé skladby jediný zdroj a zároveň jediný,
který analýza neumí.

### Dopad na DJ mode

`fetchDjData` je přejmenované `fetchTrackBpm` (`static/js/djmix.js:18`) a
`player_v3.js` ho volá na **sedmi místech** (525, 536, 555, 588, 926, 1056,
1677), nikde nepředává `song_id`. Bez BPM/key/beat gridu DJ nemá tempo ani
mřížku a tiše spadne na náhradní chování. Není to hláška v konzoli — je to
hlavní funkce aplikace běžící naslepo.

## Rozhodnutí zadavatele (18. 10. 2026) — má přednost před vším výše

**„BPM mají mít jen stažené skladby v playlistech."**

Tím padá celá úvaha o doplnění YouTube větve. Dnešní chování serveru je podle
tohoto pravidla **správné**: `_get_audio_file` sahá na lokální soubor a na
Navidrome, tedy přesně na to, co je stažené. Chybějící třetí stupeň není díra,
je to hranice.

Vada tedy není tam, kde jsem ji hledal. Vada je, že **si klient o BPM říká pro
skladby, které ho podle pravidla nikdy mít nemají**, a server jeho dotaz
odbaví chybou místo odpovědi. 18 z 22 požadavků v měřeném okně bylo odsouzeno
předem.

### Proč se YouTube větev nepřidává (doloženo, ne odhad)

Stálo by to: jeden GET od kteréhokoli přihlášeného → hledání na YouTube →
stažení → ffmpeg → `analyze_bpm`. `_analysis_locks` (`bpm.py:1204`) serializuje
jen **stejnou** skladbu, různá jména jdou paralelně, a `bpm.js:424` pouští
**12 souběžných požadavků** („server has 6-thread pool, 12 keeps it saturated").
Strop je jen na disk (`YT_CACHE_MAX_BYTES`), ne na počet stažení ani na CPU;
produkce má `mem_limit 2g` a historii OOM. Rozhodnutí zadavatele tuhle
amplifikaci zavírá dřív, než vznikla.

### Pravidlo už v kódu je — jen nehlídá to, co má

Tohle je nejdůležitější zjištění pro autora. „Owned-only" není nový nápad,
`bpm.js` ho má popsané ve vlastních komentářích:

    bpm.js:146   „Set false for unowned views where on-demand analysis mostly 404s."
    bpm.js:15    „…the tempo controls render disabled (owned-only reality)."
    bpm.js:299   „Feasibility-aware: … (owned-only reality)."

Jenže `allowAnalyze` a hlídání pokrytí ovládají **jen vzhled** — tlačítko
v toastu a zešednutí filtru. Na vlastní požadavek nesahá nikdo:
`fetchTrackBpm` (`bpm.js:100`) se odpálí bez ohledu na vlastnictví.
Pravidlo je zdokumentované a neprosazené — tedy stejný druh nepravdy, kvůli
kterému měla dávka 1 kolo 3.

## Body

- **B1. Klient se neptá na to, co pravidlo vylučuje.** Volání `fetchTrackBpm`
  se hradlují na „staženo" na místech, odkud jdou reálné požadavky:
  `queue.js:53`, `bpm.js:369` a sedm míst v `player_v3.js` (525, 536, 555,
  588, 926, 1056, 1677).
  *Test:* položka bez příznaku staženo → žádné volání (odchycený `apiJson`).
  *Mutace:* hradlo odstranit → test zčervená.
- **B2. Příznak „staženo" musí u položky fronty existovat a být pravdivý.**
  `search.js:169/186/225` pracuje s `item.inLibrary`, `contextmenu.js:363`
  taky — ale **není ověřeno, že totéž nese položka v `store.playerQueue`**,
  a právě odtud se ptá `queue.js` a `player_v3.js`. Pokud ne, zadání neplatí
  tak, jak je napsané, a B1 nemá na čem stát. **Tohle má kritika ověřit jako
  první; je to premisa, ne detail.**
  *Test:* cesty, kterými se položka dostane do fronty, příznak zachovají.
  *Mutace:* příznak při vložení do fronty zahodit → test zčervená.
- **B3. Server odpoví levně a pravdivě.** Pro skladbu mimo knihovnu nemá
  odpověď znít „audio not available" (což je u skladby, jejíž zvuk leží
  v `ms-yt-cache`, nepravda), ale „mimo rozsah — není stažená". Nesmí přitom
  spustit žádnou práci.
  *Test:* požadavek na nestaženou skladbu → žádné volání `analyze_bpm`.
  *Mutace:* vrátit původní větev → test zčervená.
- **B4. DJ mode nesmí dělat, že tempo má.** Když skladba ve frontě není
  stažená, nemá BPM, klíč ani beat grid. Dnes `player_v3.js` dostane `null`
  a pokračuje. Co přesně má dělat — přeskočit, mixovat natvrdo, nebo to
  přiznat v UI — **rozhodne se v dodatku po kritice**; zadání jen vyžaduje,
  aby to bylo vědomé a doložené, ne ticho.

## K ověření v kritice (nepotvrzené)

`_analyze_or_read_tag` (`bpm.py:1080`) **zapisuje tagy do analyzovaného
souboru** (`write_tags`, 1120 a 1137). U Navidrome větve je tím souborem sdílená
cache `ms-nav-cache/{song_id}.mp3`, kterou **zároveň servíruje `FileResponse`**
v `/api/player/stream`. Zápis ID3 mění délku souboru. To je přesně třída chyby,
kterou zavřela oprava 1 (`project_stream_representation_pin`): posun bajtových
offsetů pod běžícím Range požadavkem → 416 → ticho v závěru skladby.
**Neověřeno** — nevím, jestli to v praxi nastane (nav cache na produkci
neexistuje) a jestli tam není zámek, který to vylučuje. Kritika to má buď
doložit, nebo vyvrátit; ne odhadnout.

## Omezení

- Repo **nemá ani jeden test na BPM** (51 sebraných testů, `grep -rl bpm tests/`
  nevrací nic). Body B1–B3 si testy musí přinést; mutace jsou povinné.
- Většina váhy dávky je ve **frontendu**, kde pytest nepomůže. Jak se B1 a B2
  doloží — odchycený `apiJson` v node, nebo Playwright proti nasazené instanci —
  je otevřené; `reference_e2e_harness` popisuje existující postroj. Kritika má
  říct, který z nich unese mutaci (D18: test musí nad starým kódem padat).
- `analyze_bpm` potřebuje madmom + numpy a běží dlouho — testy nesmí sahat na
  skutečnou analýzu.
- `static/index.html` se needituje, generuje se z `frontend/partials/*.html`
  (dávka 1). Pokud se B4 projeví v UI, mění se část, ne výstup.
- Produkce se během dávky nemění. Měření výš je čtení logu, výpis adresáře
  a čtení `bpm_analysis.json`; **nic se nezapisovalo**.

## Přejímka

Proti běžící instanci po nasazení:

1. Projít seznam skladeb, které nejsou stažené, a doložit **nula** požadavků na
   `/api/bpm/track` (síťové počítadlo, ne dojem z UI).
2. Stažená skladba v playlistu BPM dál dostane — 200 s `bpm` i `beat_grid`.
3. Přímé volání endpointu na nestaženou skladbu odpoví podle B3 a v logu po něm
   **nepřibude** žádná analýza.
4. DJ mode s frontou, kde je nestažená skladba, se zachová podle rozhodnutí
   u B4 — doložit, co udělal, ne že „nespadl".

Rozpočet placených volání: **0**.

---

# Dodatek po kritice (18. 10. 2026)

**Dodatek má přednost před vším výše.** Verdikt kritiky: **přepracovat**.
Report: `kritika-oprava-2.md`, 623 řádků, 10 vyvrácených premis, nula volání na
produkci, otisk zadání sedí na začátku i na konci.

Vedení ověřilo šest nejtvrdších tvrzení kritiky vlastním měřením (`bpm.js:425`,
`BPM_WORKERS`, `ls test_bpm*`, `grep -rn inLibrary app/`, `library.py:365-375`,
`player.py:400-401`). **Všechna sedí.**

## §0 Opravy mých čísel

| v zadání | skutečnost | kde jsem to vzal |
|---|---|---|
| „`bpm.js:424` pouští **12** souběžných požadavků" | `bpm.js:425`: `const CONCURRENT = 4;` | z **komentáře** na ř. 424 |
| „server has **6**-thread pool" | `bpm.py:67`: `BPM_WORKERS` výchozí **2** | z téhož komentáře |
| „repo **nemá ani jeden** test na BPM" | `test_bpm.py`, `test_bpm_eval.py`, `test_bpm_playwright.mjs` v kořeni, **1 041 řádků** | `grep` zúžený na `tests/` |
| „nikde nepředává `song_id`" | platí pro `player_v3.js` a `queue.js`, **ne** pro `bpm.js:415` | nedoměřeno |
| chybějící `song_id` jako součást příčiny 404 | router si ho dohledá sám (`routers/bpm.py:46-47`) — na 404 nemá vliv | chybný úsudek |

První dvě jsou tatáž chyba jako šest chyb v dávce 1: **četl jsem komentář a
vydával ho za měření**. Komentář na `bpm.js:424` je navíc prokazatelně
zastaralý — kód pod ním říká 4. Amplifikace, kterou jsem použil jako argument,
je ve skutečnosti zhruba třetinová.

## §1 B2 se ruší. Příznak „staženo" na klientovi neexistuje a nemá vzniknout.

`grep -rn inLibrary app/` vrací **nulu** — backend ten klíč nezná. Zapisují ho
jen `search.js:223-226` a `library.js:585-588`, obě do `card.dataset.item`, tedy
do **řetězce v DOM**, ne do objektu skladby. Nastavuje se jen na `true`, nikdy
na `false`.

A to podstatné, co jsem minul úplně: `library.py:365-375` staví položku Up Next
z **pevného seznamu sedmi klíčů**, žádný příznak mezi nimi není. Přitom položky
tam pocházejí z playlistu v Navidrome, takže jsou z definice stažené.
**Cesta, kde je vlastnictví jisté, je zároveň jediná, která příznak nepřenese.**

B1 v napsané podobě by tedy nevyplo volání pro nestažené skladby — vyplo by je
skoro pro všechny. Výsledek by nebyl „míň 404", ale **„BPM zmizelo"**, a shodil
by bod 2 mojí vlastní přejímky.

## §2 Zdrojem pravdy je server, ne odhad na klientovi

Kritika doložila, že `inLibrary` a „analýza na to dosáhne" jsou **dvě různé
množiny bez inkluze v obou směrech**:

- `_search_navidrome` posílá dva dotazy (`"{artist} {name}"`, pak `"{name}"`),
  `find_song_id` **jediný** (`query=name`, prvních 50). Skladba s obecným
  názvem → `inLibrary=true` a přesto 404.
- `find_track_file` sahá jen na disk a matchuje **jméno souboru**, Navidrome
  matchuje **tagy**. Čerstvě stažená skladba před skenem → `inLibrary=false`,
  ale analýza by prošla.

Hradlovat klienta na `inLibrary` by znamenalo přidat **čtvrté** místo, kde se
„staženo" počítá jinak. Proto:

**Rozhodnutí vedení: klient o vlastnictví nerozhoduje. Ptá se jednou a odpověď
si pamatuje.**

- **B1′** — `library.py:365-375` a ostatní místa, kde server staví položku
  fronty, doplní pole `owned`, **kde to server ví zadarmo** (položka
  z Navidrome playlistu = `true`). Žádné nové dotazy.
- **B2′** — endpoint odpoví na nestaženou skladbu **levně a pravdivě**
  (`owned: false`, 200), ne 404 „audio not available" o souboru, který leží
  v `ms-yt-cache`. Klient si zápornou odpověď zapamatuje na sezení a neptá se
  znovu. Hradlo je tím pádem „neptej se podruhé", ne „odhadni dopředu".
- **B3′** — **negativní cache i na serveru**. Bez ní se 18 z 22 jen přejmenuje
  z 404 na 200 za stejnou cenu (Navidrome `search3` + blokující `rglob`).
  Hradlo na klientovi endpoint nezlevní: zůstává otevřený komukoli s JWT,
  `name`/`artist` nejsou vázané na knihovnu a rate limit v `app/` není.
- **B4′** — DJ mode: **varianta B z kritiky** — přiznat v UI. Dnes degraduje
  tiše na čtyřech místech najednou, z toho nejhůř: `pickSmartNext` se **vůbec
  nezavolá** (`player_v3.js:609`, `:1261`), takže přehrávání je sekvenční,
  zatímco nastavení dál hlásí „Smart Queue". Odznak u položky fronty
  a poznámka u přepínače. Nemění zvuk, jen přestane lhát. Variantu C
  (přeskakovat) **zamítám**: potkala by se s §2 a přeskakovala i skladby, které
  BPM mají.

## §3 Podezření ze sekce „K ověření" je POTVRZENÉ — a míří jinam, než jsem psal

Zámek tam **není**. `cache_navidrome_stream` se na teplé cestě vrací na
`player.py:400-401`, **před** zámkem na 405-408; zámek drží jen stavbu.
Komentář `bpm.py:1168` („it's build-lock-guarded against the live stream GET")
je **nepravdivý**.

Kritika změřila, že zápis tagů při nedostatečném paddingu **zvětší MP3 o ~1 480 B
a posune začátek audia z 1166 na 1541**.

A hlavně: **to, že `ms-nav-cache` na produkci neexistuje, riziko neodstraňuje —
přesouvá ho.** Když nav cache není, vyhrává lokální soubor, a tatáž `write_tags`
píše do **skutečného souboru v `/music`**, který `/api/player/stream` servíruje
jako `FileResponse` (`routers/player.py:110`). Riziko tedy neleží v nepoužívané
větvi, ale v té jediné používané. Navíc `cache_local_transcode` klíčuje na
`sha1(abspath+mtime)` → každá analýza stažené skladby **invaliduje její MP3
transkód** a příští přehrání překóduje celý FLAC znovu.

**Tohle přestává být poznámka pod čarou.** Je to táž třída chyby jako
`project_stream_representation_pin` — posun bajtových offsetů pod běžícím Range
požadavkem → 416 → ticho v závěru skladby. **Vyjímá se z téhle dávky do
samostatného zadání `oprava-3`**, protože je to jiný podsystém, jiné riziko
a samostatně nasaditelný celek. Nesmí se smíchat s hradlováním.

## §4 Testy

Zadání tvrdilo, že na BPM testy nejsou. Jsou — tři soubory, 1 041 řádků,
a **všechny tři míří na produkci**. Autor je proto **nesmí spustit**; zadání to
musí říct výslovně, jinak je někdo v dobré víře pustí proti živé instanci.

Kritika doložila, že se aplikace dá spustit lokálně, takže B1′–B3′ jdou doložit
bez produkce a s rozpočtem 0 placených volání.

## §5 Nálezy kritiky nad rámec zadání (do dalších dávek, ne teď)

Blokující `rglob` v korutině; neomezený růst `_analysis_locks`; chybějící
negativní cache (vtažena do B3′); invalidace transkódu přes `mtime` (do
`oprava-3`); tichý `catch` v `checkLibrary`, který spolkne i chybu parsování.
