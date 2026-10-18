# Oprava 2 - rozhodnuti a evidence

Vsechna cisla jdou prehrat z korene worktree. Produkce se nedotkla (zadne ssh, HTTP ani docker).
Testy `test_bpm*.py` / `test_bpm_playwright.mjs` z korene repa se NESPOUSTELY.

## Bod -> radek -> test -> mutace

| bod | kde | test | mutace (co zcervenalo) |
|---|---|---|---|
| B1' owned u polozek ze serveru | `app/services/library.py` get_playlist, klic `"owned": True` | `test_playlist_entries_are_marked_owned` | M6 odstranit klic -> tento test (1 failed) |
| B2' 200 `owned:false` bez prace | `app/routers/bpm.py` `get_track_bpm`, vetev za `find_song_id` | `test_unowned_track_gets_200_owned_false_and_no_analysis`, `test_local_file_without_navidrome_id_is_still_analysed` | M1 pad do analyze -> 2 failed (unowned, second_ask); M4 zahodit lokalni soubor -> 2 failed (local_file, second_ask) |
| B2' klient si pamatuje | `static/js/bpm.js` `_notOwned`, `isBpmUnavailable`, `fetchTrackBpm` | `bpm_client.test.mjs`: "asked once", "error is not remembered", "queue render" | M7 nezapisovat -> 2 fail; M8 nekonzultovat -> 1 fail; M9 pamatovat i chybu -> 1 fail |
| B3' negativni cache na serveru | `app/routers/bpm.py` `_not_owned`, TTL 300 s, max 2000 | `test_second_ask...`, `test_negative_entry_expires`, `test_negative_cache_is_bounded`, `test_owned_track_whose_analysis_fails_is_not_negative_cached` | M2 nekonzultovat -> second_ask; M3 bez stropu -> bounded; M5 cachovat i selhani analyzy -> not_negative_cached |
| B4' priznat v UI | `static/js/queue.js` `_noBpmBadgeHtml`, render + lazy cesta; poznamky v `61-settings-playback.html`, `90-full-player.html` | "queue render shows a no BPM badge" | M10 odznak pryc z renderu -> 1 fail |

Vsech 10 mutaci provedeno v izolovane kopii (`scratchpad/mut/w`), vysledek cten z radku "N failed" a jmen testu
ze souboru, ne z exit kodu. Prezivsi: zadna z 10. Poznamka: M2 necervena `test_negative_entry_expires`
(ten hlida vyprseni, ne konzultaci) - to je v poradku, ne diru.

## Sada
- `python3 -m pytest tests -q -p no:cacheprovider > out 2>&1` -> **65 passed, 3 skipped** (pred zmenou 48 passed, 3 skipped).
- `node --test tests/js/bpm_client.test.mjs` (prikaz S cestou k souboru; `node --test tests/js/` na node 22 konci MODULE_NOT_FOUND) -> **10 pass, 0 fail**.
- `scripts/build-index.sh` + `scripts/check-index.sh` -> exit 0 (index.html prestaven z casti).

## Co jinak a proc
- Klient NEhradluje na `item.inLibrary` ani na `owned` (kritika s.1-2). Ptá se jednou, pamatuje si odpoved.
  Proto `player_v3.js` zustal beze zmeny: vsech 7 volani jde pres `fetchTrackBpm`, ktery uz memo konzultuje.
- Server rozhoduje vlastnictvi stejnymi dvema zdroji jako analyza (`find_song_id`, `bpm.find_track_file`),
  `rglob` pres `asyncio.to_thread`. Chyba Navidrome se NEcte jako "neni stazena" a necachuje se.
- Odznak "no BPM" pouziva `qi-bpm` + inline `opacity` a `title`, protoze `static/css/player.css` neni mezi mymi soubory.
- B1' je informacni: `owned:true` nese jen cestu z Navidrome playlistu; nic se na nem nehradluje.

## Rozpory
- `app/services/bpm.py`, `player.py` nezmeneny (patri oprave 3). Zapis tagu (`write_tags`) do analyzovaneho
  souboru zustava otevreny - mimo tuto davku.

## PRIZNANE MEZE (co NEBYLO overeno)
- Zadny beh proti realne instanci (ani lokalni uvicorn, ani Playwright): jen TestClient s nahrazenou analyzou
  a node se stubem `fetch`/`document`. Prejimka (sitove pocitadlo, DJ mode) je na vedeni.
- Text poznamek v partialech neni testovan; tvrzeni "dalsi skladba nasleduje poradi fronty" vychazi z cteni
  `player_v3.js:1261` (`smartMode !== 'off' && _outDjData`), ne z behu.
- `POST /lookup-by-name?analyze=true` a `GET /playlist/{id}?scan=true` negativni cache nevyuzivaji.
- Negativni cache je per-proces a TTL 300 s: skladba stazena behem TTL se nejvyse 5 min tvari jako nestazena; `force=true` to prebije, klient se po dokonceni stahovani (job running/queued -> done) sam vymaze.
- Odznak se objevi az po odpovedi serveru v tomto sezeni; po reloadu u dosud nedotazanych polozek chybi.

## Kolo 2: nalezy z review (N1-N13 dvou drah; cisla dle poradi v zadani)

Mutace v izolovane kopii (`scratchpad/mut2/mut.py`, vystup `scratchpad/mut2.out`), cteno z radku "N failed" a jmen testu:
vsech 15 mutantu zcervenalo. Pytest 65 passed, 3 skipped; node 10 pass, 0 fail; `check-index.sh` exit 0.

- **N1 blocker (index.html smazal Popular)**: PRIJATO. Tri bloky (`#playArtistTop`, `#artistTop`, `#artistAlbumsHeader`, tridy
  `btn-hero-*`, inline flex) vraceny do `frontend/partials/30-search.html`, index prestavet. `git diff main -- static/index.html` ma
  nyni jen 3 BPM hunky (2 insertions, 1 deletion). Novy `tests/test_index_ids.py` (partialy i index nesou ID, ktera hleda `spotify.js`);
  M1 (odstranit `#artistTop` z partialu, prestavet) -> `1 failed`, gate `check-index.sh` pritom zeleny. Poucka: gate hlida shodu, ne celistvost.
- **N2 high (zahozene zmerene BPM)**: PRIJATO. Kdyz neni audio a v cache je zaznam (jakekoli verze), vrati se zaznam, neni `owned:false`
  a nezapisuje se do negativni cache; neg-cache se u skladby se zaznamem ani nekonzultuje. Test `test_stale_cached_entry_without_audio...`; M2 -> 1 failed.
- **N3 high (force)**: PRIJATO, `force` preskakuje negativni pamet (a ani ji nezapisuje). Test `test_force_bypasses_negative_cache`; M3 -> 1 failed.
- **N4 medium (song_id obchazi branu)**: PRIJATO v teto podobe: server klientovo `song_id` pro rozhodnuti o vlastnictvi vubec nepouzije a hleda
  skladbu sam (`find_song_id`, pak soubor). Cena: tlacitko "Analyze BPM" s platnym Navidrome id, ktere `find_song_id` podle jmena nenajde,
  dostane `owned:false` (dosud 200 s analyzou). NEOVERENO, jak casto to nastane; neni to zmereno. Test `test_client_song_id_does_not_skip...`; M4 -> 1 failed.
- **N5 medium (docs/UI tvrzeni)**: PRIJATO. Docs ted rika, ze yt-cache (`ms-yt-cache`) se neconzultuje a takova skladba dostane `owned:false`;
  titulek odznaku a text napovedy uz netvrdi "not downloaded" bez vyhrady ("server found no audio file or library entry", "usually not downloaded").
  Pripad "knihovni skladba, kterou `find_song_id` neprojde (50+ shod)" zustava mozny a NEBYL zmeren; je v docs jako limit (odznak = server nenasel zdroj).
- **N6 medium (shuffle)**: PRIJATO, texty v obou partialech i v docs rikaji "Smart Queue se pro dalsi vyber nepouzije (queue order, nebo nahodne pri shuffle)".
  Text neni testovan; opet z cteni `player_v3.js:1243`, ne z behu.
- **N7 medium (klient bez invalidace)**: PRIJATO. `forgetBpmUnavailable()` v `bpm.js`; `checkJobCompletions` v `downloads.js` (nyni exportovana) ji vola pri prechodu
  running/queued -> done, nezavisle na notifikacich (stav `previousJobStates` se ted zapisuje i s vypnutymi notifikacemi - vedlejsi zmena chovani).
  Maze VSE, protoze job neridka neni mapovan na konkretni skladbu. Testy "forgetBpmUnavailable...", "a download job going running -> done..."; M10 -> 2 fail, M11 -> 1 fail.
- **N8 medium (pamet klicu)**: PRIJATO, klic zkracen na 200 znaku na cast (`NOT_OWNED_KEY_CHARS`); strop = 2000 x ~400 znaku. Dve jmena delsi nez 200 se shodnym zacatkem
  by sdilela zaznam (okrajove, 5 min). Test `test_long_names_do_not_grow_the_key`; M7 -> 1 failed. Skutecna spotreba pameti po oprave NEMERENA (jen delka klice).
- **N9 low (strop 0)**: PRIJATO, smycka ma `_not_owned and`. Test `test_zero_cap_does_not_crash`; M8 -> `RuntimeError` -> 1 failed.
- **N10 low (lazy cesta bez testu, bez abort strazce)**: PRIJATO. Pridan `if (abort.aborted) return;` pred vlozeni odznaku; dva testy (odznak se vlozi; po prerenderovani behem pozadavku se nevlozi). M12 -> 1 fail, M13 -> 1 fail.
- **N11 low (prikaz node --test)**: PRIJATO, komentar v testu i poznamky maji prikaz s cestou k souboru.
- **N12 low (to_thread)**: PRIJATO castecne: test porovnava vlakno event loopu (fake `find_song_id`) s vlaknem `find_track_file`; M9 -> 1 failed. Sdileny default executor a realna delka rglobu NEMERENY.
- **N13 low (mrtvy `owned:true`)**: ODMITNUTO smazani: zadani, dodatek B1', pole vyslovne pozaduje jako informacni a druha review dráha B1' vede jako splneno.
  Opraven pouze nepravdivy komentar (zaznam muze zustat v Navidrome i po smazani souboru). M15 -> 1 failed.
- **Review 2 N2 (M-A artist v klici)**: PRIJATO, test `test_negative_key_keeps_artists_apart`; M5 -> 1 failed.
- **Review 2 N3 (M-B song_id)**: viz N4 vyse.
- **Review 2 N4 (TTL)**: PRIJATO. Server: test s podvrzenym `time.monotonic` (299 s zije, 301 s vyprsi); M6 -> 1 failed. Klient: test s podvrzenym `Date.now`; M14 -> 1 fail.
- **Review 2 N5/N6**: bez nalezu k oprave.

NEBYLO overeno: zadny beh proti realne instanci ani Playwright (UI Popular, odznak, DJ mode); prejimka je na vedeni.
