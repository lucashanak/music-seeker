# R3 – bezpečnostní review backendu dálkového ovládání (2026-11-19)

Reviewer: R3 (security-reviewer, jen čtení). Rozsah: `git diff main -- app/`
(`app/services/remote.py`, `app/routers/remote.py`, `app/routers/player.py`) a `tests/test_remote.py`.
Kontext: `auth.py`, `dependencies.py`, `player.py` (`_queue_path`, `load_queue`, `save_queue`).
Riziko MEDIUM, nic se nedá zneužít bez přihlášení. `pytest tests/test_remote.py -q` → 61 passed.
Celkem: 0 kritických, 0 vysokých, 3 střední, 5 nízkých. (Zapsalo vedení z hlášení R3, R3 nemá zápis.)

## M1. Soubory front dvou uživatelů kolidují — jeden uživatel čte a přepisuje frontu druhého
`app/services/player.py:1098-1102`: `_queue_path = f"{username}_{device_id}.json"`, a `_` povolují
oba regexy. Uživatel `claude` se zařízením `test_x` → `claude_test_x.json` = zařízení `x` uživatele
`claude_test`; zařízení `test` → `claude_test.json` (legacy/default soubor). Nové cesty:
`GET /api/remote/queue?device=` (čtení), transfer (zápis — útočník otevře SSE jako `test_x`, aby byl
online). Starý `GET/PUT /api/player/queue` s `X-Device-ID` to umožňoval už na main. Ověřeno probe
(čtení vrátilo frontu oběti, transfer 202 a soubor oběti obsahoval `PWNED`).
Podmínka: jméno jednoho uživatele = jméno druhého + `_`.
Oprava: adresář na uživatele, nebo jako stopgap odmítnout při `create_user` jméno, které je
s existujícím v prefixovém vztahu přes `_`.

## M2. Přihlášený uživatel může přes zaseknutá SSE spojení vyčerpat paměť kontejneru
`services/remote.py:243-268` (`update_state` bez limitu zařízení a karet), `:319-323`
(`_broadcast_devices` vloží celý snapshot do fronty každého spojení při každém hlášení), `:21`
(`_QUEUE_MAXSIZE` 256). Každé `/state` s novým `X-Device-ID`/`tab_id` vytvoří záznam (vyřazení až po
1 h); nečtoucí SSE klient drží 256 snapshotů. Změřeno: 500 zařízení, jedno zaseknuté spojení +110 MB;
~20 takových přesáhne 2 GiB. Při 2000 zařízeních blokuje jedno `/state` smyčku ~11 ms.
Oprava: (1) limit zařízení na uživatele (~16) a karet na zařízení (~8), vyřadit nejdéle
neaktualizované; (2) slučovat `devices`: `_broadcast_devices` jen nastaví `devices_dirty` a probudí
spojení, `listen()` snapshot sestaví až při odeslání → spojení drží nejvýš jeden.

## M3. Uniklý stream token nově ovládá stream dálkového ovládání
`routers/remote.py:41-57`, `services/remote.py:62-76, 280-286`. Stream tokeny jsou v URL (logy nginx,
DLNA renderery s 24 h tokenem z `dlna.py:53`, Referer). Kdo ho má, čte stav všech zařízení (track,
next, dj, casting), registruje se jako libovolné zařízení/karta (8 spojení vyřadí skutečné karty),
přebírá příkazy (nové spojení bez stavu předběhne kartu, která nehrála) a ukazuje falešné zařízení
online. Porušuje slib v docstringu `create_stream_token`. SSE bral stream tokeny už na main; změna
přidala `next`, `dj`, `casting`.
Oprava: vlastní audience `aud="remote"` vázaná na zařízení (`dev`), vydávaná session-autentizovaným
`GET /api/remote/token` (~1 h); `/events` a periodická kontrola vyžadují `aud=="remote"` a
`dev==device_id`.

## L1. Obří celé číslo v těle → 500
`services/remote.py:166,177,195` (`_num/_int/_scalar`), `routers/remote.py:100` (`_is_num`):
`math.isfinite` na 400ciferném intu hodí `OverflowError`. Oprava: `_finite(v)` s try/except.

## L2. Položky enqueue / queue_op / transfer nejsou whitelistované ani zkrácené
`routers/remote.py:103-106, 189-193, 209-214, 234`. Kontroluje se jen typ a počet; klíče, vnoření a
délka řetězců volné (stav jde přes `sanitize_state`, příkazy ne). `playlist_mode.id` bez kontroly typu.
Jen vlastní zařízení. Oprava: whitelist klíčů jako `_track` se `STR_CAP`; `playlist_mode.id` regex;
`shuffle_order` jen `played`/`tail` jako seznamy intů < len(queue).

## L3. Transfer dělá blokující a neatomické souborové I/O v async handleru
`routers/remote.py:265-267`, `player.py:1125-1128`: dvě čtení + `json.dumps(indent=2)` (pure-Python
encoder, ~75 ms na 5000 položek) na event loopu; `write_text` není atomický (kill uprostřed → prázdný
soubor, fronta ztracena). `PUT /queue` na main stejně. Oprava: kompaktní JSON do `.tmp` + `os.replace`
přes `asyncio.to_thread`.

## L4. Příkaz se může ztratit při výměně spojení
`services/remote.py:127-131`: když `wait` vrátí s hotovým getterem i nastaveným `closed`, `listen()`
skončí a vyzvednutou zprávu zahodí (příkaz dostal 202, nedoručen). Oprava: nejdřív vydat zprávu
z hotového getteru, pak kontrolovat `closed`.

## L5. `_states` a `_cmd_ids` nečinných nebo smazaných uživatelů se nevyřazují
`services/remote.py:249-254`: vyřazení jen v `update_state` téhož uživatele. Malé; s limity z M2
omezené. Oprava: sweep i z `_broadcast_devices` nebo periodicky.

## Ověřeno jako v pořádku
- SSE nikdy nebere session token (`aud=="stream"` při připojení i při každé re-kontrole); `/command`,
  `/state`, `/devices`, `/queue` jdou přes `get_current_user`, který stream token odmítá.
- Periodická re-validace (exp, aud, sub, existence uživatele) běží podle hodin, provoz ji neodloží;
  `_load_users` je mtime-cache a `_save_users` píše atomicky.
- Izolace uživatelů v brokeru: vše klíčované autentizovaným jménem; jediná křížová cesta je M1.
- Path traversal: `device_id`, `tab_id`, jména uživatelů vylučují `/` a úvodní tečku; `tab_id` na disk nejde.
- Pořadí transferu: 404 offline a 409 controlling před `save_queue`, bez await mezi; nesmysly odmítnuty
  před zápisem; merge drží hlasitost cíle a jeho Up Next.
- `sanitize_state`, validace hodnot příkazů (bool místo čísla odmítnut, NaN/Inf odmítnuty).
- Životní cyklus spojení: registrace uvnitř generátoru, `finally` vždy odregistruje, vyřazené spojení
  skončí, plná fronta → další karta, příkaz starší 5 s zahozen.
- Diff bez tajemství; závislosti beze změny (pip-audit tu není).
