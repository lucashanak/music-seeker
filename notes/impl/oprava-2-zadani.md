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

## Hrozby (co změna spustí a kdo to může vyvolat)

Tohle je ta část, kterou musí kritika rozebrat **dřív než autor sáhne na kód**.
Dnešní 404 je levná. Doplnění YouTube větve ji mění na:
vyhledání na YouTube → stažení → ffmpeg → `analyze_bpm` (madmom, několik oken).

- Vyvolá to **kterýkoli přihlášený uživatel** jedním GET s libovolným
  `name`/`artist`; parametry nejsou vázané na knihovnu ani na frontu.
- `_analysis_locks` (`bpm.py:1204`) serializuje jen **stejnou** skladbu. Různá
  jména jdou paralelně.
- `bpm.js:424` pouští **12 souběžných požadavků** („server has 6-thread pool,
  12 keeps it saturated"); tlačítko „Analyze BPM" na 375 šest.
- Strop na velikost cache je `BPM_CACHE_MAX_BYTES` / `YT_CACHE_MAX_BYTES` (2 GB),
  tedy strop na disk, **ne na počet stažení ani na CPU**.
- Produkce má `mem_limit 2g` a historii OOM (viz `project_oom_memlimit`).

Bez stropu je tohle amplifikace: jeden levný požadavek → stažení + těžký DSP.

## Otevřené volby (rozhodnout v dodatku po kritice)

**(a) Plná YouTube větev.** `_get_audio_file` dostane třetí stupeň přes
`_resolve_youtube` + `cache_youtube_stream`. Zisk: BPM pro všechno, co hraje.
Cena: viz Hrozby — potřebuje strop.

**(b) Jen použít, co už je stažené.** Spočítat klíč cache a soubor vzít, **jen
když existuje**; nikdy nestahovat. Zisk: nulová nová cena, okamžitě zabere pro
všechno, co sis pustil — tedy přesně pro frontu, kterou DJ hraje. Ztráta: první
poslech skladby je pořád bez BPM.

**(c) Nechat server a přestat se ptát z frontendu** u skladeb mimo knihovnu.
Zisk: zmizí šum. Ztráta: DJ je slepý dál. Tohle problém neřeší, jen schová.

**Doporučení vedení: (b) jako výchozí chování + (a) za výslovným parametrem**,
který smí poslat jen DJ předvídání na *následující* skladbu fronty. (b) nemá
žádnou z hrozeb výš a pokrývá hlavní případ; (a) zůstane ohraničená na jeden
známý volající a jde opatřit stropem souběhu.

## Body

- **B1.** `_get_audio_file` sáhne po existujícím souboru v `ms-yt-cache`, když
  lokální soubor a Navidrome selžou. Nikdy nestahuje.
  *Test:* dočasný `ms-yt-cache` s podvrženým souborem pod správným klíčem →
  `_get_audio_file` vrátí jeho cestu. *Mutace:* vypnout větev → test zčervená;
  vrátit cestu bez `os.path.exists` → test na chybějící soubor zčervená.
- **B2.** Klíč cache se počítá na **jednom místě**. Dnes je vzorec zadrátovaný
  uvnitř `cache_youtube_stream`; B1 ho nesmí zkopírovat (stejná past, kterou
  v dávce 1 vyřešil `scripts/lib-partials.sh`).
  *Test:* obě cesty dají pro týž vstup týž klíč. *Mutace:* změnit vzorec na
  jednom místě → test zčervená.
- **B3.** Rozhodnuté chování pro stahování (podle volby výš) **se stropem
  souběhu**, ne jen se stropem disku.
  *Test:* N souběžných požadavků na různé skladby → nejvýš K současných
  stažení. *Mutace:* strop odstranit → test zčervená.
- **B4.** 404 přestane lhát. Když zvuk opravdu není, odpověď má říct proč
  (není v knihovně / nestahuje se zde), ne „audio not available" u souboru,
  který leží na disku vedle.

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

- Repo **nemá ani jeden test na BPM** (51 sebraných testů, `grep -l bpm tests/`
  prázdný). Body B1–B3 si testy musí přinést; mutace jsou povinné.
- `analyze_bpm` potřebuje madmom + numpy a běhá dlouho — testy musí mířit na
  `_get_audio_file` a klíčování, ne na skutečnou analýzu.
- Produkce se během dávky nemění. Měření výš je čtení logu, výpis adresáře
  a čtení `bpm_analysis.json`; **nic se nezapisovalo**.

## Přejímka

Proti běžící instanci po nasazení: pustit skladbu, která není v knihovně,
počkat na `ms-yt-cache`, zavolat `/api/bpm/track` na tutéž skladbu a doložit
200 + `bpm` + `beat_grid`. Dál doložit, že se při tom **nic nestáhlo** (mtime
souboru v cache se nezměnil). Rozpočet placených volání: **0**.
