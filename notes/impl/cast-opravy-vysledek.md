# cast-opravy: výsledek dávky (2026-11-19)

Větev `cast-opravy`. Zadání `notes/impl/cast-opravy-zadani.md`, review
`notes/impl/cast-review-2026-11-19.md`, rozhraní server ↔ klient `notes/impl/cast-opravy-kontrakt.md`.

## Co se změnilo v principu
Při castu o konci skladby a o další skladbě rozhoduje **server** (sledovač receiveru v
`app/services/dlna.py`), ne časovač stránky. Telefon může zhasnout, stránka zamrznout,
kontejner se restartovat — fronta hraje dál. Stránka po probuzení převezme, co server pustil
(`cast_seq`, `session_id`, `track`), a tutéž skladbu znovu neposílá. Co hrát dál bere server
z nápovědy klienta (shuffle, Smart Queue, repeat, rádio), bez ní z uložené fronty
(`shuffle_order`, repeat). Session, která 30 min nehraje, končí sama (bez Stop na receiver).

## Nálezy review (19)
| # | Stav | Poznámka |
|---|---|---|
| 1 | opraveno | serverový sledovač (konec, stall, další skladba, souběh s klientem, restart); klient: dopočet pozice přes mezery (záloha bez serveru), `abPlay`/`abPause`/`abProgress` Android shellu |
| 2 | opraveno | obnova castu po načtení stránky (`restoreCast`, volá ji `auth.js` po `loadQueueState`, ne init — před přihlášením není token) |
| 3 | opraveno | `start_seconds` při zapnutí castu, pozice z receiveru zpět při vypnutí |
| 4 | opraveno | `castDuration()` / `castSeekDuration()` v obou seek lištách |
| 5 | opraveno | seek na zastaveném receiveru = cast téže skladby na pozici; původní seek navíc nikdy nešel zamýšlenou cestou (string místo intervalu) — teď přímá akce Seek |
| 6 | opraveno | klient: jeden dotaz naráz (setTimeout řetěz + příznak, timeout 8 s); server: gather, GetVolume jen občas, cache + single-flight |
| 7 | opraveno | `stale`, po 60 s bez úspěšného vzorku konec s hláškou `abandoned` |
| 8 | opraveno | stall hodiny jen přes živé dotazy; nikdy re-cast při pozici > 1 s |
| 9 | opraveno | ikona play/pauza ze stavu receiveru; mediální klávesy/notifikace přes `_resume/_pauseLocalPlayback` → `castPlay/castPause` (domluveno s remote-opravy) |
| 10 | opraveno | mixy a klipy posílají `duration_ms`; server: neznámá délka → konec jen po ≥ 30 s skutečného hraní; jen katalogová délka → okno 12 s |
| 11 | opraveno | neúspěšné dotazy → backoff (4/8/16/30 s), ne teardown; teardown jen přes server (`abandoned`) |
| 12 | opraveno | lossless Navidrome ne-FLAC: `{id}.raw.{ext}` + skutečný MIME; DIDL bere MIME ze stejné funkce jako stream |
| 13 | opraveno | YouTube / nevyřešené → `audio/mpeg` |
| 14 | opraveno | zařízení klíčovaná UDN, nová IP nahradí starou |
| 15 | opraveno | soubor, který se právě posílá, eviction nesmaže |
| 16 | odloženo | Opus: stream při běžné kvalitě posílá podle stavu cache jednou `.ogg`, jednou MP3 — typ by se změnil uprostřed castu; potřebuje kvalitu, která vždy transkóduje. Latentní: všech 5 mixů je `.m4a` |
| 17 | opraveno (nezkompilováno) | Kotlin: wake lock se obnovuje každých 50 min, strop 4 h; review tvrdí „jen na ACTION_PLAY“ — neplatí úplně, `ACTION_PROGRESS` ho obnovoval, při castu ale progress nechodí |
| 18 | opraveno | cast zastaví oba decky (a prefetch) PŘED odesláním, při selhání je pustí |
| 19 | opraveno | neznámá hlasitost = klíč `volume` chybí, slider se nehýbe |

## Neověřeno bez skutečného receiveru / telefonu
- jestli Onkyo hlásí `TrackDuration` pro FLAC a m4a (kód na tom nezávisí);
- jestli Onkyo vrací `TrackURI` a v jakém tvaru (kontrola „hraje něco jiného“ se učí ozvěnu
  po našem castu a cizí zdroj uzná až po 3 vzorcích při hraní);
- jestli přijme seek hned po Play (3 pokusy) a `audio/mp4` / `audio/ogg` v DIDL;
- obnova po skutečném restartu kontejneru uprostřed castu;
- Android: nová verze Kotlinu (wake lock) se neskompilovala, build až po pushi;
- baterie: během castu telefon kvůli hlášení „hraje“ Android shellu zůstává vzhůru, ač další
  skladbu pouští server.

## Postup pro Lukáše (skutečný receiver)
1. Po nasazení otevři appku na telefonu, zapni Onkyo na síťovém vstupu, pusť **dlouhý mix**
   od 20. minuty a stiskni Cast → mix musí na receiveru pokračovat od ~20. minuty (ne od 0).
2. Zhasni telefon na déle, než zbývá do konce skladby (nebo pusť krátký klip a zhasni) →
   po dohrání musí receiver sám začít další skladbu fronty, i se zhasnutým telefonem.
3. Rozsviť telefon → appka ukazuje skladbu, která právě hraje na receiveru; nezačne ji znovu.
4. Ťukni na půlku průběhu u mixu → receiver skočí zhruba doprostřed mixu.
5. Ovladačem receiveru dej Stop uprostřed skladby, počkej minutu → nic se samo nespustí,
   ikona v appce je „pauza“; Play v appce → pokračuje, kde stál.
6. Přepni receiver na jiný vstup (TV) uprostřed skladby → appka nic znovu neposílá,
   receiver na síťový vstup sám nepřepne.
7. Mediální tlačítka / notifikace na telefonu během castu → ovládají receiver, telefon nehraje.
8. Zastav cast v appce → Play pokračuje v telefonu od pozice, kde byl receiver.
Když něco nesedí: čas a co se stalo; log je `docker logs music-seeker | grep DLNA`.

## Kontroly (stav při commitu)
- `python3 -m pytest tests/ -q` → 603 passed, 5 skipped (cílené DLNA/stream 140).
- `node --test tests/js/cast.test.mjs` → 71/71; `dj_transition` 33, `shuffle_order` 7,
  `android_bridge` 5 (`bpm_client` 12/1 padá stejně i na main).
- `node tests/e2e/audit/cast.mjs` (všechny `/api/dlna/*` i fronta podvržené, žádný receiver):
  produkce 50/38/1 (původních 5 scénářů) + 40/14 (midstop, midstopmix, superseded);
  strom 213/0/1 na phone+tablet+desktop (18:02), po posledních změnách klienta desktop 71/0 (18:24).
- Review: kód server, kód klient, adversariální bez zadání, 2 ověřovací kola s mutacemi.
  Neopraveno vědomě: Smart Queue tah, který server vzal z nápovědy mezi dvěma kroky,
  se po probuzení neoznačí jako odehraný; review nález 9 dálkového ovládání patří dávce remote-opravy.
