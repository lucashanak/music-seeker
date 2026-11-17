# Zadání: záložka „Mixes“ v Knihovně — hledání DJ setů napříč zdroji, filtr kvality, stažené mixy, sledovaní DJové

Sepsáno 2026-11-17. Navazuje na commit 2acb2a4 (stažení mixu z Mixcloudu/SoundCloudu podle
vložené adresy, `app/services/mixes.py`). Lukáš schválil body 1–4 níž, celé.
Fakta označená **změřeno** jsou z produkčního kontejneru (yt-dlp 2026.11.16), ne odhad.

## Proč

Mixcloud dává většinu mixů v AAC 64 kbps („bída“). Stejný set bývá jinde ve dvoj- až
trojnásobné kvalitě. Uživatel chce mixy hledat jako podcasty: na jedné stránce, s filtrem
kvality, a sledovat DJe.

## Změřené zdroje (zouk mixy, 2026-11-17)

| zdroj | kvalita | jak zjistit kvalitu levně |
|---|---|---|
| SoundCloud | AAC 160k (8/8 mixů 2025 mělo `hls_aac_160k` + `hls_aac_96k`); staré nahrávky mohou být MP3 128 | `yt-dlp -J "scsearch10:<q>"` vrací formáty u každého výsledku, 8 výsledků za ~6 s |
| YouTube | AAC 129k (itag 140) nebo Opus ~135–141k; u všech 4 změřených stejné | **nezjišťovat per video** (rate limit, viz níž) — flat hledání a jmenovitě „AAC 128“ |
| Mixcloud | SQ = AAC 64k (většina), HQ = AAC 192k + Opus ~195k (jen autor s Pro) | GraphQL vrací `audioQuality` přímo ve výsledku hledání, 1 dotaz |
| hearthis.at | stream MP3 128k; když autor povolí stažení (`downloadable: 1`), formát `mp3-1` = MP3 192k (změřeno 1×) | veřejné API bez klíče |
| archive.org | VBR MP3, na „zouk mix“ jen 12 výsledků | **vynechat** |
| Audiomack | yt-dlp hledání neumí, API chce OAuth | **vynechat** |

### Mixcloud GraphQL (`POST https://app.mixcloud.com/graphql`)

Hlavičky `Content-Type: application/json`, `Referer: https://www.mixcloud.com/`,
`Origin: https://www.mixcloud.com`, nějaký `User-Agent`. Introspekce je zakázaná (403), tyhle
tvary jsou **ověřené**:

```graphql
{ viewer { search { searchQuery(term: "zouk") {
    cloudcasts(first: 20) { edges { node {
      name slug audioQuality audioLength publishDate
      picture { urlRoot }
      owner { username displayName picture { urlRoot } } } } }
    users(first: 3) { edges { node { username displayName } } } } } } }

{ userLookup(lookup: {username: "martin-šmoldas"}) { displayName
    uploads(first: 10) { edges { node { name slug audioQuality audioLength publishDate picture { urlRoot } } } } } }

{ cloudcastLookup(lookup: {username: "NTSRadio", slug: "..."}) { name audioQuality audioType audioLength } }
```

Obrázek: `https://thumbnailer.mixcloud.com/unsafe/300x300/<urlRoot>`. URL mixu:
`https://www.mixcloud.com/<username>/<slug>/` (username procentově kódovat, viz
`mixes.parse_mix_url`). HQ → uváděj „AAC 192“, SQ → „AAC 64“ (obojí změřeno na stažených souborech).

### hearthis.at

`GET https://api-v2.hearthis.at/search?t=<q>&type=tracks&count=20` → seznam s `title`,
`duration` (s), `user.username`, `user.permalink`, `permalink_url`, `artwork_url`,
`downloadable` ("0"/"1"). Nahrávky uživatele: `GET https://api-v2.hearthis.at/<permalink>/?type=tracks&page=1&count=N`
(ověř). yt-dlp extractor `HearThisAt` existuje; formáty `mp3-0` (128) a u stažitelných `mp3-1`
(192). **Ověř**, že stažení s naším selektorem vybere `mp3-1`, a když ne, uprav selektor tak,
aby u hearthis vybral větší bitrate.

### YouTube — pozor na rate limit

CLAUDE.md, sekce „A track nobody owns plays from YouTube“: YouTube nás už dvakrát zablokoval
(`HTTP 429`, „Sign in to confirm you're not a bot“) a pak nehraje nic nestaženého. Hledání mixů
proto: jen flat hledání přes `ytpick.search` (žádná extrakce formátů per video), malý limit
(≤ 8), cache výsledků 10 min, a když `player.youtube_rate_limited()` → YouTube vynechat a
vrátit u něj chybu „YouTube is rate-limiting us“. Kvalitu uváděj jmenovitě „AAC 128“ s příznakem,
že je typická, ne změřená (`quality_known: false`).

## Rozhodnutí

1. **Umístění:** Knihovna → nová podzáložka **„Mixes“** vedle „Podcasts“
   (`frontend/partials/50-library.html`, `data-lib-tab="mixes"`). Navigace zůstává na 4
   položkách (viz memory `project_ux_overhaul_2026-07`). Zrcadli, jak je zapojená záložka
   Podcasts (`static/js/library.js` `switchLibraryTab`, `static/js/router.js`, `podcasts.js`).
2. **Tři sekce záložky** shora: Hledání → Sledovaní DJové → Stažené mixy.
3. **Hledání (bod 1)** — `GET /api/mixes/search?q=&sources=soundcloud,youtube,mixcloud,hearthis`
   - zdroje paralelně, každý s vlastním timeoutem (~25 s), částečné výsledky + `errors: {source: msg}`;
   - server vrací **všechny** výsledky i s `kbps`; **filtry dělá klient** (přepnutí je okamžité
     a ukáže „N skryto filtrem kvality / délky“);
   - položka: `{source, source_label, url, title, uploader, uploader_id, uploader_url, thumbnail,
     duration, codec, kbps, quality_known, quality_label, also: [{source, source_label, url, kbps, quality_label}]}`;
   - **deduplikace**: stejný set na víc zdrojích (normalizovaný název — malá písmena, bez
     diakritiky a interpunkce, Jaccard tokenů ≥ 0,6 — a délka do ±2 %) → jedna položka s
     nejlepší kvalitou, ostatní v `also`;
   - výchozí filtry v UI: **kvalita ≥ 128 kbps**, **délka ≥ 20 min**; volby kvality
     Any / 128 / 160 / 192, délky Any / 20 / 45 min; přepínače zdrojů;
   - řazení: výchozí podle kvality (pásma ≥192, ≥160, ≥128, <128), uvnitř pásma zachovat
     relevanci zdroje (prokládat zdroje round-robin); volba „Relevance“;
   - cache 10 min na (q, sources).
   - **Odznak kvality** i v banneru vložené adresy (`static/js/mixlink.js`): `fetch_info` vrátí
     `kbps`/`quality_label` z formátů (u Mixcloudu z `audioQuality`), banner ho ukáže ještě
     před stažením, u < 128 s poznámkou, že víc zdroj nedává.
4. **Stahování (bod 4)** jde **jen** přes existující cestu mixu (`POST /api/download`
   `type: "mix"` → `mixes.run_mix`). Rozšiř `mixes.parse_mix_url` o:
   - `hearthis.at/<user>/<slug>/` → `("hearthis", "https://hearthis.at/<user>/<slug>/")`;
   - YouTube (`youtube.com/watch?v=ID`, `youtu.be/ID`, `m.`/`music.youtube.com`, ID
     `[A-Za-z0-9_-]{11}`) → `("youtube", "https://www.youtube.com/watch?v=ID")`.
   - **Automatické přepnutí v `start_download`** (URL mixu → `type: "mix"`) smí zůstat **jen pro
     Mixcloud, SoundCloud a hearthis.at**. YouTube adresu dává poskytovatel YouTube Music jako
     `url` obyčejných skladeb (`search_providers.py:506`, `:573`) — kdyby se přepínala, spadlo by
     do cesty mixu každé stažení skladby z YouTube Music. YouTube je mix **jen** když klient pošle
     `type: "mix"`. Na to test.
   - Banner vložené adresy: hearthis ano. YouTube adresu v hledání **nechat, jak je dnes**
     (nevyskakovat s mixem na každé vložené video).
   - Selektor formátu: zachovat „nejlepší AAC, Opus jen bez AAC“ (důvod v CLAUDE.md, sekce
     Mixes). U YouTube to dá AAC 129 (itag 140). Kvalita v úloze se dál bere ze souboru (ffprobe).
5. **Stažené mixy (bod 2)** — `GET /api/mixes/library`: projdi `<MUSIC_DIR>/<user>/Mixes/<DJ>/*`
   (audio přípony, vynech `.mix-dl-*`), seskup podle DJ; u souboru název a DJ z tagů (mutagen
   easy, fallback jméno souboru/složky), velikost, délka, kvalita (z registru `mixes.json`, jinak
   z mutagen `info.bitrate` + kodek), zdrojová URL (registr nebo COMMENT).
   `DELETE /api/mixes/library` `{dj, file}` — obě jako jediné složky cesty (vzor
   `podcasts._safe_path_component` + kontrola, že výsledek leží uvnitř `<user>/Mixes`), smaž
   soubor, prázdnou složku DJ, záznam v registru, spusť scan Navidrome.
   UI: seskupeno podle DJ, řádek = cover/ikona, název, kvalita, velikost, délka, ▶ přehrát
   (do fronty jako `{name: title, artist: DJ}` stejně jako jiné stažené skladby), 🗑 smazat
   s potvrzením. Celková velikost nahoře jako u podcastů.
6. **Sledovaní DJové (bod 3)** — **per uživatel** (podcasty jsou globální, mixy ne — leží
   v `<user>/Mixes`). Soubor `DATA_DIR/mix_follows.json`, zápis atomicky (tmp + `os.replace`
   ve stejném adresáři). Záznam: `{source, user_id, name, image, url, auto_download: false,
   min_kbps: 128, min_minutes: 20, added, seen: [url…] (max 300, nejnovější)}`.
   - `GET /api/mixes/follows`, `POST /api/mixes/follows` `{source, user_id, name, image, url}`,
     `DELETE /api/mixes/follows/{source}/{user_id}`, `PUT …` `{auto_download, min_kbps, min_minutes}`,
     `GET /api/mixes/follows/{source}/{user_id}/uploads?limit=10` → poslední nahrávky ve stejném
     tvaru jako výsledky hledání + `in_library`.
   - Nahrávky DJ: Mixcloud `userLookup.uploads`; SoundCloud `yt-dlp -J --playlist-end N
     https://soundcloud.com/<user>/tracks` (ověř, že vrací formáty a jak dlouho to trvá);
     hearthis API; YouTube `yt-dlp --flat-playlist --playlist-end N <kanál>/videos` (flat,
     jmenovitá kvalita, respektuj rate limit).
   - **Při založení sledování označ aktuální nahrávky jako `seen`** — automatika stahuje jen
     NOVÉ, nikdy celou historii DJ.
   - `POST /api/mixes/follows/check` (tlačítko „Check now“) a periodická úloha v
     `app/background.py` každých 6 h (vzor `_podcast_auto_sync`, první běh až po intervalu):
     pro sledování s `auto_download` vezmi nahrávky, které nejsou v `seen`, nejsou v knihovně
     (`library.find_song_id`), mají `kbps ≥ min_kbps` a délku ≥ `min_minutes` → vytvoř mix job
     (`jobs.create_job(type_="mix", …, fmt="original")` + `downloader.run_download`), **max 3 na
     DJ a běh**. Do `seen` přidej vše vyhodnocené (i odmítnuté kvalitou — Mixcloud SQ se HQ
     nestane). Respektuj oprávnění účtu (`allowed_methods` musí mít `yt-dlp`), kvótu hlídá `run_mix`.
   - UI: seznam sledovaných (avatar, jméno, zdroj, přepínač auto-download, prahy), rozbalení
     ukáže poslední nahrávky (stejný řádek jako výsledek hledání), „Unfollow“. Tlačítko
     „Follow DJ“ u výsledku hledání (`uploader_id` musí být pro daný zdroj použitelný
     k načtení nahrávek — u YouTube ID kanálu, u Mixcloudu username, u SoundCloudu permalink,
     u hearthis permalink).
7. **Bez nového stavu v prohlížeči**, mimo zapamatované filtry (localStorage, v try/catch).

## Kontrakty z CLAUDE.md, které platí

- `static/index.html` je generovaný — edituj `frontend/partials/*.html`, spusť
  `scripts/build-index.sh`, ověř `scripts/check-index.sh`.
- JS importy s jednoduchými uvozovkami (`entrypoint.sh` jim přidává cache-bust).
- Tři rozlišení: phone 390x844, **tablet 1024x768** (nad breakpointem 640 px, bez hoveru —
  žádné ovládání odkryté jen hoverem), desktop 1280x900. Bez vodorovného posunu stránky.
- Viditelnost uvnitř stránky `offsetParent !== null`; překryvy (potvrzení smazání) zakládají
  vrstvu historie a registrují se do `store.dialogStack`.
- Všechny texty z cizích zdrojů přes `esc`/`escAttr`.
- Jména s diakritikou přes `player.nfc()`.
- Každý externí proces/požadavek má timeout.

## Testy

- `python3 -m pytest tests/ -q` musí zůstat zelené (dnes 198 passed, 5 skipped, část jsou
  testy jiné session). Nové testy **nic nestahují ani nevolají síť**: parsery každého zdroje nad
  uloženými JSON ukázkami, deduplikace, řazení, `parse_mix_url` pro nové hosty, **YouTube URL
  v obyčejném track jobu se nepřepne na mix**, follows (uložení, `seen` při založení, check
  s podvrženými fetchery: práh kvality, délky, max 3, knihovna, oprávnění), library listing a
  delete (path traversal, prázdná složka, registr), router oprávnění.
- Přejímací skript `tests/e2e/audit/mixes_page.mjs` (vzor `tests/e2e/audit/mix_download.mjs`,
  helpers `open({viewport, device:'mixpage'})`, účet `claude_test`): na všech 3 rozlišeních
  záložka, hledání „zouk mix“ s odznaky, výchozí filtr skryje < 128 a ukáže počet, vypnutí filtru
  je ukáže; follow + načtení nahrávek + unfollow; stažení jednoho výsledku ≥ 128 (vyber
  nejkratší ≥ 20 min), objeví se ve Stažených, přehraje se (stream 206), smaže se přes UI.
  `--tree` přes `serveWorktree`. Spouští ho vedení po nasazení.

## Pravidla prostředí

- Ve stejném stromu může pracovat jiná session (DJ režim). **Nesahej** na
  `static/js/{player_v3,djmix,prefetch,queue,api,player,app,fullplayer}.js`,
  `app/services/player.py`, `app/routers/player.py`, `app/services/bpm.py`. Kdyby to bylo nutné,
  zastav se a napiš proč.
- **Nenasazuj, necommituj.** To dělá vedení.
- Na produkci (`ssh -i ~/.ssh/yams_key deploy@192.168.1.22`, kontejner `music-seeker`) smíš
  **jen číst a měřit** — spouštět yt-dlp/ffprobe/python v `/tmp` kontejneru, nic v knihovně,
  nic v `/app`, žádný restart. Po sobě ukliď.
