# Oprava 3 — analýza BPM přepisuje soubor, který se právě streamuje

Stav: zadání před kritikou. Vzniklo vyčleněním ze sekce „K ověření" zadání
`oprava-2`, kde to kritika 18. 10. 2026 potvrdila a ukázala, že míří jinam, než
jsem psal. Měření níž pochází z kritiky a vedení ho přebralo po vlastní kontrole
`player.py:400-401`, `player.py:474-511` a `bpm.py:1166-1169`.

## Nález 1 — zápis tagů do souboru, který servíruje `FileResponse`

`_analyze_or_read_tag` (`bpm.py:1080`) po analýze **zapisuje tagy přímo do
analyzovaného souboru** (`write_tags` na `bpm.py:1120` a `:1137`). Analyzovaným
souborem je u naprosté většiny skladeb **skutečný soubor v `/music`**, protože
`_get_audio_file:1159` sahá nejdřív na `find_track_file`.

Týž soubor zároveň servíruje `/api/player/stream` jako
`FileResponse(path, …)` (`routers/player.py:110`, `:113`) — tedy **s podporou
Range requestů**.

Změřeno lokálně (mutagen 1.47.0, bez produkce):

| padding v MP3 | velikost před | po | změna | audio začíná na |
|---|---|---|---|---|
| výchozí | 84 566 | 84 566 | 0 B | 1166 → 1166 |
| nulový | 83 459 | 84 941 | **+1 482 B** | 1166 → **1541** |
| 64 B | 83 523 | 84 941 | **+1 418 B** | 1166 → **1541** |

Když soubor nemá dost paddingu, **posunou se všechny bajtové offsety audia**.
Běžící `Range` požadavek na starý offset pak dostane data z jiného místa, při
zkrácení 416. To je **táž třída chyby jako `project_stream_representation_pin`**
(oprava z 11. 8. 2026: „uřízne konec skladby a pak tam běží ticho").

**Poctivě: je to potvrzené jako MOŽNÉ, ne jako nastávající.** Jestli soubory
v `/music` padding mají, se bez produkce nezjistí. Zadání proto nežádá opravu
symptomu, ale **odstranění souběhu** — zápis do souboru, který může být právě
servírovaný, nemá nastat bez ohledu na to, jak to dopadne.

## Nález 2 — každá analýza zahodí MP3 transkód skladby

`local_transcode_cached_path` i `cache_local_transcode` klíčují cache
`sha1(abspath + mtime)` (`player.py:484` a `:510`). Zápis tagů **mění `mtime`
i tehdy, když se velikost nezmění** (změřeno). Každá analýza stažené skladby
tedy invaliduje její cached MP3 a příští přehrání překóduje **celý FLAC** znovu
— na stroji s `mem_limit 2g` a historií OOM (`project_oom_memlimit`).

Pozor, tohle je **zčásti záměr**: docstring `cache_local_transcode` říká
„keyed by sha1(abspath + mtime) so a re-downloaded/re-tagged file re-transcodes".
Správně — po změně tagů je cached MP3 zastaralý. Nezamýšlená je **cena**: že se
to děje po každé analýze, včetně analýz, které jen dopisují feature tagy do
jinak nezměněného souboru. Zadání tedy nesmí klíčování „opravit"; má se ptát,
jestli se musí zapisovat tak často.

## Nález 3 — komentář slibuje zámek, který neexistuje

`bpm.py:1168` tvrdí: „it's build-lock-guarded against the live stream GET".
Není. `cache_navidrome_stream` se na teplé cestě vrací na `player.py:400-401`,
**před** zámkem na `:405-408`; zámek drží jen stavbu, ne čtení ani cizí zápis.
`raw_pinned` se volá výhradně ve větvi `source == "local"` v routeru.

Dokumentovaná nepravda v kódu je horší než chybějící ochrana — čte ji příští
člověk a spolehne se na ni. (Táž úvaha vedla ke kolu 3 dávky 1.)

## Body

- **B1.** Analýza nesmí zapisovat do souboru, na který může běžet Range
  požadavek. Rozhodnout jak: pin jako u `pin_raw_local`, zápis do kopie, nebo
  zápis odložit — **varianty s cenou a ztrátou patří do kritiky**.
  *Test:* zápis se nespustí (nebo je serializovaný), když je soubor „v letu".
  *Mutace:* ochranu odstranit → test zčervená.
- **B2.** Zápis tagů do nezměněného souboru jen kvůli doplnění feature tagů se
  nemá dít opakovaně. *Test:* druhá analýza téže skladby `mtime` nemění.
  *Mutace:* podmínku odstranit → test zčervená.
- **B3.** Komentář `bpm.py:1168` buď zmizí, nebo začne být pravdivý.
  Nestačí ho zjemnit. *Test:* nelze testovat automaticky — doloží review.

## Omezení a hranice celku

- **Autor téhle dávky vlastní výhradně `app/services/bpm.py`
  a `app/services/player.py`.** Nesmí sáhnout na `app/routers/bpm.py`,
  `app/services/library.py`, `static/js/**` ani `frontend/partials/**` — ty
  patří souběžné dávce `oprava-2`.
- **`test_bpm.py`, `test_bpm_eval.py` a `test_bpm_playwright.mjs` v kořeni repa
  MÍŘÍ NA PRODUKCI. Nespouštět.** Nové testy patří do `tests/`.
- Produkce se nemění. Rozpočet placených volání: **0**.
- Nezasahovat do samotného algoritmu analýzy (`analyze_bpm`) — mimo rozsah.

## Přejímka

Pustit skladbu z `/music`, během přehrávání vyvolat analýzu téže skladby
a doložit, že (1) přehrávání doběhlo do konce, (2) `mtime` souboru se
nezměnil, nebo se zápis odložil, (3) cached MP3 transkód zůstal platný.
Rozpočet placených volání: **0**.
