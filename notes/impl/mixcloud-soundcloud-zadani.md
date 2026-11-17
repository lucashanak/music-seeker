# Zadání: stahování mixů z Mixcloudu a SoundCloudu podle vložené adresy

Sepsáno 2026-11-17 v předchozí session. Fakta níž jsou **změřená** na produkčním
kontejneru (yt-dlp 2026.11.04 nightly), ne odhadnutá. Výjimky jsou výslovně označené.

## Cíl

Uživatel vloží do aplikace adresu mixu na Mixcloudu nebo SoundCloudu, například

    https://www.mixcloud.com/martin-%C5%A1moldas/zouktime-marathon-brno-sunday-set/?utm_medium=share&utm_source=clipboard&utm_content=show&utm_term=VXNlcjo1NDYzMDM2NQ%3D%3D

a MusicSeeker stáhne **přesně ten soubor** (žádné hledání na YouTube), otaguje ho,
uloží do knihovny a spustí scan Navidrome. V úloze stahování je vidět, jakou kvalitu
uživatel dostal.

## Co víme o kvalitě (hlavní důvod zadání)

- **Mixcloud nabízí dvě kvality a rozhoduje o nich autor, ne posluchač.** Standardní
  nahrávky jsou AAC 64 kbps. „HQ“ (Opus 160 kbps) mají jen mixy, které nahrál autor
  s placeným Pro účtem (https://www.mixcloud.com/pro/). Posluchač si vyšší kvalitu
  koupit nemůže.
- **Vzorový mix výš je SQ.** GraphQL `https://app.mixcloud.com/graphql`,
  dotaz `cloudcastLookup(lookup:{username,slug}) { audioQuality audioType }`, vrací
  `audioQuality: "SQ"`, `audioType: "SHOW"`. HQ mix má nejspíš `"HQ"`, ale ověřené to
  není, žádný HQ mix jsme neměli po ruce.
- **Všechny formáty yt-dlp jsou u SQ mixu stejné.** `http`, `dash-a1-x3` i `hls-64`
  jsou podle ffprobe AAC-LC 64 kbps, 44,1 kHz stereo; hodina mixu má 30 MB a adresa
  souboru obsahuje `/m4a/64/`.
- **SoundCloud dává víc.** Mix od stejného DJ má formáty `hls_aac_96k` a
  `hls_aac_160k` (m4a). yt-dlp u `soundcloud:user` hlásí *„no impersonate target is
  available“* (chybí `curl_cffi`), zatím to ale funguje.
- **Převod do FLAC nebo MP3 320 nic nepřidá.** U SQ mixu vznikne jen větší soubor se
  stejným zvukem a falešně „bezztrátovou“ příponou.

## Rozhodnutí (udělal Lukáš / předchozí session)

1. **Ukládat v původním kodeku, bez převodu.** U těchto zdrojů ignorovat
   `DownloadRequest.format` (výchozí FLAC). Brát nejlepší dostupný zvuk
   (`-f bestaudio`, `-x --audio-format best` nebo ekvivalent, aby nedošlo k reenkódu).
2. **Bitrate ukázat v úloze**, například „Mixcloud · AAC 64 kbps“. Hodnotu vzít ze
   staženého souboru (ffprobe nebo mutagen), ne z metadat yt-dlp. U `http` formátu
   Mixcloudu `abr` chybí.
3. **Mixcloud a SoundCloud jedna cesta.** Obojí je „stáhni tuhle adresu“, liší se jen
   rozpoznáním adresy a popiskem zdroje.
4. **Dodatečné vylepšení zvuku (AudioSR apod.) nedělat.**

## Výchozí body v kódu

- `app/services/downloader.py` — `_resolve_tracks` (Spotify/Deezer URL → seznam
  skladeb) a `_download_track_ytdlp`, které **vždycky hledá na YouTube** přes
  `ytpick.search`. Přímou adresu dnes nestahuje nic. Je potřeba nová větev
  v `_run_ytdlp` nebo `run_download`, nejspíš podle `parse_*_url` vedle
  `parse_deezer_url` (`app/services/search_providers.py`).
- Tagy: dnes `metaflac` pro FLAC a ffmpeg pro MP3. Pro m4a a opus je jednodušší
  **mutagen**, projekt ho už používá (`app/services/bpm.py`, `write_tags`); u Opusu jde
  cover přes `METADATA_BLOCK_PICTURE`. Tagy: TITLE = název mixu, ARTIST = autor
  (`uploader`), ALBUM třeba „Mixcloud“ nebo „DJ Sets“ (rozhodni a napiš proč),
  cover = `thumbnail`, datum z `timestamp`.
- Cesta souboru: návrh `<MUSIC_DIR>/<user>/Mixes/<autor>/<název>.<ext>`, ať se mixy
  nepletou mezi alba. Jména s diakritikou skládat přes `player.nfc()` (viz CLAUDE.md
  „One spelling per track“).
- Časový limit: hodinový mix potřebuje `PODCAST_DL_TIMEOUT` (2400 s), ne
  `TRACK_DL_TIMEOUT`.
- Kontrolu knihovny (`library.find_song_id`) a kvótu (`_check_quota`) zachovat.
- `app/routers/downloads.py`, `app/models.py` (`DownloadRequest`) — vstup.
- Frontend: dnes vloženou adresu rozpoznává jen `static/js/playlistimport.js`
  (Spotify a Deezer playlisty). Kudy půjde Mixcloud (vyhledávací pole, import modal,
  nebo obojí), rozhodni sám a napiš proč. **`static/index.html` je generovaný** —
  edituj `frontend/partials/*.html` a spusť `scripts/build-index.sh`.

## Co ověřit kromě stažení

- **Přehrávač:** umí `resolve_stream` a stream endpoint pustit lokální `.m4a` a `.opus`?
  Dnes je cesta stavěná na FLAC→MP3 transcode. Opus v Safari na iOS je riziko.
- **BPM:** analýza hodinového mixu nesmí zahltit paměť (viz
  `project_oom_memlimit`, `mem_limit 2g`). Klidně mixy z analýzy vynech, jen to napiš.
- **Navidrome** soubor po scanu skutečně vidí a má správné tagy a cover.
- **HQ mix na Mixcloudu:** zkus nějaký najít (Pro autoři). Pokud se to povede, ověř,
  že stažený soubor je Opus 160, ne AAC 64.

## Pravidla prostředí

- **Ve stromu jsou necommitnuté změny jiné session** (DJ review: `player_v3.js`,
  `djmix.js`, `prefetch.js`, `queue.js`, `api.js`, `player.js`, `app/services/player.py`,
  `app/services/bpm.py`, `app/routers/player.py` + nové testy). Podle CLAUDE.md jsou už
  nasazené (2026-11-17), takže tar ze stromu je zatím shodný s produkcí. Před nasazením
  to **ověř porovnáním md5** souborů v kontejneru a ve stromu. **Necommituj je jako
  součást této dávky.** Do commitu přidávej jen vlastní soubory, jmenovitě.
- Testovací účet `claude_test` / `TestPass2026!`, nikdy `lucas`.
- Postup: implementace → review v jiné dráze → nasazení (compose, viz CLAUDE.md) →
  přejímka na živé instanci se vzorovou adresou výš → commit. Neptej se uprostřed,
  dotáhni to a výsledek ohlas (viz memory `feedback_neptat_se_pracuj_sam`).
- Po nasazení `docker builder prune -af` (disk na produkci).
- Sada testů: `python3 -m pytest tests/ -q` (147 passed, 3 skipped před touto dávkou).
  Nové testy rozpoznávání adres a sestavení příkazu yt-dlp nesmí nic skutečně stahovat.
- Na konci doplň do CLAUDE.md krátkou sekci o kvalitě zdrojů (SQ/HQ, proč bez převodu).
