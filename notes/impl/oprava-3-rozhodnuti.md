# Oprava 3 - rozhodnuti a evidence

Odstranuje se souhra, ne doloženy symptom. Nedokazal jsem, ze na produkci doslo k posunu
zvuku ani k useknutemu konci; kritika to zmerila jen na synteticky FLAC bez paddingu.

## Vybrana varianta B1: V1 rozsirena
`bpm.py` `_served_to_player` + guard na zacatku `write_tags` (kryje oba volaci body i
`analyze_and_tag`). Zapis se preskoci, kdyz `raw_pinned(path)` nebo cesta lezi v
`ms-nav-cache` (tam zadny pin neni). Neodklada se analyza (hlad: pin se obnovuje kazdym
prehranim, RAW_PIN_SEC=900).
Ztrata: odlozeny zapis se nefrontuje. Dokonci ho az dalsi analyza, ktera tag nenajde
(restart, bump BPM_ALGO_VERSION). Soubory v ms-nav-cache tagy nedostanou nikdy, takze po
restartu se analyzuji znovu (cena CPU, vysledek je v bpm_analysis.json). Nezvolil jsem V3
(netagovat), protoze _save_cache neni atomicky (N-B) a Navidrome by o BPM nevedel.
`write_tags` bezi ve vlakne poolu; `raw_pinned` cte dict z jineho vlakna (get/pop, GIL).

## B2 (podle kritiky prepsano)
Puvodni B2 vyvraceno (2. analyza mtime nemeni, test by byl zeleny nad starym kodem).
Misto toho: stopa bez beat gridu se pretagovavala pri kazdem behu. `write_tags` ted
ukladat nechava jen kdyz se nejaka hodnota tagu skutecne zmeni (snapshot pred/po).
Neresi znovuanalyzu CPU u stop bez gridu, jen zbytecny zapis a zmenu mtime.

## B3
Komentar `bpm.py` u `cache_navidrome_stream` nahrazen pravdivym (analyza jen cte; zapis
resi `_served_to_player`). V `player.py` zadny podobny nepravdivy komentar nebyl, beze zmeny.

## Testy a mutace (tests/test_bpm_tag_safety.py, 5 testu)
Prikaz: `python3 -m pytest tests/test_bpm_tag_safety.py -q`
- Nad starym kodem (git stash, test ponechan): 4 failed, 49 passed, 3 skipped v celem tests/;
  pozitivni kontrola test_unpinned_write_changes_file prosla.
- M1 smazat raw_pinned: 1 failed (test_pinned_file_is_not_written)
- M2 smazat nav-cache vetev: 1 failed (test_nav_cache_file_is_not_written)
- M3 smazat porovnani pred/po: 2 failed (test_identical_write_keeps_mtime,
  test_gridless_track_not_retagged_every_run)
Cele tests/: 53 passed, 3 skipped. Vystupy v ../mut/*.out.

## PRIZNANE MEZE
- Test nepousti skutecny stream pres uvicorn; overuje, ze se do souboru nesahne, ne
  zvukovy dusledek. Zadny test nedokazuje, ze k poskozeni na produkci doslo.
- Zbyva uzke okno: pin se nastavi v routeru po kontrole v write_tags. Router nesmim menit.
- Nespusteno: pripejimka (prehrani + analyza), mereni paddingu v /music, test_bpm*.py z korene,
  cokoli proti produkci. Prah 272 B a cisla FLAC jsou z kritiky, ne moje mereni.
- N-A (write_tags je no-op bez tagu) a N-B (neatomicky _save_cache) neopraveno.
- Behavior zmena: analyza stop v ms-nav-cache uz neuklada tagy.


# Kolo 2 - nalezy review

Vystupy behu: ../mut3/*.out. Prikaz: `python3 -m pytest tests/test_bpm_tag_safety.py -q`.
Cela sada po opravach: `python3 -m pytest tests/ -q` -> 61 passed, 3 skipped (rc cten zvlast).
Nad `git show main:app/services/bpm.py` padlo 7 z 13 testu nove sady (main2.out).

## Review adversarialni
- N1 (nepripnute vetve): PRIJATO, vyreseno jinak nez rozsirenim straze. Router menit nesmim a
  z bpm.py nepoznam, ze FileResponse bez pinu bezi. Misto toho write_tags uklada do kopie a
  `os.replace`, takze otevreny deskriptor drzi stare bajty. Test
  test_open_reader_keeps_original_bytes (nad main padl; mutace "tags.save()" na miste ->
  1 failed, noreplace.out). NEPOKRYTO: dalsi Range pozadavek stejneho prehrani dopadne na novy
  soubor s mozna posunutymi offsety; nemereno, v docs uvedeno.
- N2 (souběh write_tags): PRIJATO. `_tag_write_lock` kolem read-modify-write. Test
  test_concurrent_writers_keep_last_values (zapis do jedne stopy ze 2 vlaken, `_open_tags`
  zpomaleno kvuli jistemu prekryti). Mutace "bez zamku": 3 z 3 behu 1 failed
  (nolock_r1-3.out). Pozn.: bez zpomaleni test mutaci chytil jen 1 z 2 behu, proto zpomaleni.
  Neresi proces-siroky souběh (vice workeru uvicornu): zamek je jen v procesu.
  Dopad replace na ztratu vsech tagu jsem nemeril na puvodnim scenari z review (60 volani,
  padding 0), jen vlastnim testem.
- N3 (nepravdive vety): PRIJATO, docstring `_served_to_player` i docs prepsany: vycet neni
  uplny, uvedeny nepripnute vetve.
- N4 (docs "dalsi analyza"): PRIJATO, docs a docstring `write_tags` opraveny: nav-cache tagy
  nedostane nikdy, pripnuty soubor jen pri plne analyze (force / ztrata bpm_analysis.json).
- N5 (TOCTOU): PRIJATO jako zname okno, ne opraveno kontrolou. Zmirneno replace (otevreny
  deskriptor je v bezpecí); uvedeno v docs. Test na okno nepridan (nemam deterministicky
  zpusob bez zasahu do routeru).
- N6 (realpath na vstupu): PRIJATO, test_nav_cache_reached_through_symlink_is_not_written;
  mutace bez realpath na vstupu -> 1 failed (mutA_realpath.out).
- N7 (MP3 bez ID3): PRIJATO. `if not tags` -> `if tags is None` ve write_tags (prazdny
  EasyID3 je falsy). Test test_mp3_without_id3_header_gets_tags; nad main padl; mutace
  "if not tags" -> 1 failed (mutD_falsy.out). Vedlejsi: stejna zmena plati i pro FLAC bez
  jedineho tagu. Cteci funkce (`read_*_tag`) nemeneny.
- N8 (test do sdileneho tmp): PRIJATO, test pouziva monkeypatch `tempfile.gettempdir` na
  tmp_path, nesaha na skutecny ms-nav-cache.
- N9 (rozpor s ProcessPoolExecutor): PRIJATO, docs maji odstavec o tom, ze pin v potomkovi
  neplati a zamek by musel byt souborovy.

## Review kod
- N1 (mutace C prezila): PRIJATO, test_changed_value_of_existing_tag_is_written; mutace
  "set(keys)" -> 1 failed (mutC_keysonly.out).
- N2: viz adversarialni N1.
- N3 (sibling `ms-nav-cache-x`): PRIJATO, test_sibling_of_nav_cache_is_written; mutace bez
  `os.sep` -> 1 failed (mutB_sep.out). Mutace realpath->abspath neresena (ekvivalentni).
- N4, N5: informativni, beze zmeny. Poznamka k N5: sirsi chovani "analyza nav-cache neuklada
  tagy" zustava.

## Nove veci z teto opravy
- Uklid docasneho souboru pri selhani: test_failed_save_leaves_no_temp_file; mutace bez
  cleanupu -> 1 failed (mutE2.out).
- Zapis kopiruje cely soubor (shutil.copy2) - vice I/O nez drive; nemereno.
- Prejmenovani na novy inode: pripadne hardlinky na soubor se rozpojí; v /music nezkoumano.
- Docasny soubor `.NAME.tagtmpPID` v adresari knihovny; pri padu procesu uprostred zapisu
  zustane. Navidrome ho nemá indexovat (neznama pripona), neoveřeno.
- Nespusteno: zadna prejimka, nic proti produkci, test_bpm*.py z korene.
