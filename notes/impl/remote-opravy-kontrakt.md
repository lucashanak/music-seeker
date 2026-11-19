# remote-opravy: kontrakt ovladač ↔ server ↔ cíl (vedení dávky, 2026-11-19)

Závazné pro všechny agenty dávky. Nálezy B1–B24: `notes/impl/remote-review-2026-11-19.md`
(v hlavním stromu `/home/lucas/music-seeker/notes/impl/`). Zadání:
`/home/lucas/music-seeker/notes/impl/remote-opravy-zadani.md`. Pravidla:
`/home/lucas/music-seeker/notes/impl/spolecna-pravidla-davek-2026-11-19.md`.
Projektové poznámky (hlavní zdroj pravdy o přehrávači): `/home/lucas/music-seeker/CLAUDE.md`.

**Ovladač** = zařízení s `store.remoteTarget`. **Cíl** = zařízení, které příkazy přijímá.

## Princip
1. Ovladač je dálkový ovladač, ne přehrávač: nikdy nevydá zvuk, nikdy nezapíše svou frontu
   na server, nikdy nezrcadlí nic do playlistu v Navidrome. Vše, co mění přehrávání nebo frontu,
   jde jako příkaz cíli; cíl to provede svými vlastními funkcemi (a ty zrcadlí jednou).
2. Co ovladač zobrazuje (skladba, pozice, délka, play/pauza, hlasitost, ztlumení, shuffle,
   repeat, další skladba, fronta, DJ nastavení), pochází z hlášení cíle, nikdy z lokálního enginu.
3. Funkce, kterou nejde poslat cíli, je pod `body.remote-active` skrytá nebo vypnutá s hláškou.
4. Enginy (`player_v3.js`, `player.js`) zůstávají od `remote.js` oddělené DOM událostmi
   (`remote:*`); enginy remote.js neimportují. remote.js importuje engine přes `getPlayerModule()`.

## Lokální fronta ovladače během ovládání
- `enterRemoteMode` uloží snímek lokálního stavu (`queue`, `index`, `shuffle order`
  přes `serializeShuffleOrder`, `playlistMode`, `radioMode`, `radioSeedTrack`) a zastaví zvuk.
- Během ovládání je `store.playerQueue` ovladače jen pracovní plocha: `playTracks`, karta alba
  atd. do ní dál zapisují, aby šlo poslat transfer s novým seznamem. **Engine v `saveQueueNow`
  pod `store.remoteTarget` nic neukládá** a `upnext.js` (`playTracks`, `playRadio`, `mirrorAdd`,
  `clearActiveQueue`) pod ovládáním nezrcadlí a nemění `store.playlistMode`.
- `exitRemoteMode` snímek vrátí (fronta, index, shuffle order, playlistMode, radio) a zavolá
  `m.repaintLocal()` (engine export, viz níž) — bar ukáže zase lokální skladbu.
- `store.remoteTarget` se drží i v `sessionStorage` (`ms_remote_target`), aby reload ovladače
  (např. přepnutí enginu) ovládání neztratil; po startu se obnoví, když je cíl online.

## Identita karty (B3)
- `store.tabId`: náhodné id karty, `sessionStorage['ms_tab_id']` (přežije reload téže karty).
- SSE: `/api/remote/events?token=…&device_id=…&tab_id=…`; `tab_id` odpovídá `^[A-Za-z0-9_-]{1,64}$`,
  chybějící = `"default"` (zpětná kompatibilita se starým klientem během nasazení).
- `POST /api/remote/state` nese `tab_id`.
- Broker doručí příkaz **jedné** kartě zařízení: té, která naposled hlásila `playing: true`
  a má otevřené spojení; jinak nejnovějšímu spojení. Snapshot zařízení se skládá ze stavu téže
  karty (jinak z naposled hlášené), takže se pohled ovladače nepřeklápí mezi kartami.
- Nové spojení se stejným `(device, tab)` nejdřív zavře staré spojení téže karty.

## Broker a SSE (B13, B20, B23)
- Každé spojení má `closed: asyncio.Event`. Vyřazení (limit 8 na zařízení, nebo stejná karta)
  nastaví `closed` a generátor skončí (spojení se zavře, klient se po 5 s znovu připojí).
- Generátor při každém pingu (15 s) znovu ověří `exp` stream tokenu a existenci uživatele;
  neplatné → konec. Session JWT na `/events` dál nikdy (`aud == "stream"`).
- Každá událost `devices` a `ping` nese `server_time` (s). Klient z prvního `devices` po připojení
  spočítá posun hodin `offset = server_time − Date.now()/1000`; z dalších `ping`/`devices` bere
  `offset = max(offset, nový)` (zpožděně doručená událost by posun zmenšila).
- Příkaz: `{"id": <int, roste per uživatel>, "action", "value", "ts": <server time>, "from": <device_id ovladače>}`.
  Klient cíle zahodí příkaz starší než **5 s** (`Date.now()/1000 + offset − ts > 5`) — zamrzlá
  karta po probuzení nepřehraje dávku starých příkazů. Generátor na serveru zahodí příkaz,
  který ve frontě čekal přes 5 s.
- Snapshot zařízení: všechna pole stavu níž + `name`, `online`, `updated_at`, `server_time`.
  Ovladač zařízení bez hlášení déle než 10 s (`server_time − updated_at`) šedne („not responding“).
- Stavová pole se na serveru whitelistují a řetězce zkracují (≤ 300 znaků); `track`/`next`
  jen klíče `name, artist, album, image, duration_ms, id`.
- Hlášení stavu (klient): každé 3 s jen tehdy, když je online jiné zařízení téhož uživatele;
  jinak každých 15 s. Navíc ihned po provedení příkazu (s `ack`), po změně skladby a po
  play/pauze.

## Stav, který cíl hlásí (`POST /api/remote/state`)
```
tab_id, playing (bool), position_seconds, duration (s, z enginu `_getDuration()`, 0 = neznámá),
volume (0–1), muted (bool), shuffle (bool), repeat ("off"|"all"|"one"),
index (int, store.playerIndex), queue_len, queue_rev (int, roste s každým úspěšným uložením fronty),
track {name, artist, album, image, duration_ms, id} | null   ← skutečná položka fronty, ne virtuální doporučení
next  {name, artist, album, image, duration_ms, id} | null   ← `_upcomingItem()` enginu (shuffle, Smart Queue)
engine ("v3"|"classic"), dj {smart_queue, tempo_pref, fade_beats, transition_style, energy_weight, energy_dir} | null
controlling (device_id | null), blocked (bool: AudioContext neběží nebo play() odmítnut autoplay politikou),
casting (název rendereru | null), radio (bool), ack (id posledního provedeného příkazu | 0)
```
Engine dodá `export function getRemoteState()` → `{playing, position_seconds, duration, volume,
index, queue_len, track, next, engine, dj, blocked, casting}`; remote.js doplní `tab_id, muted,
shuffle, repeat, queue_rev, controlling, radio, ack`. `muted` drží fullplayer.js (viz C3).

## Příkazy (`POST /api/remote/command`, `{target_device_id, action, value}`)
Whitelist: `play, pause, toggle, next, prev, seek, volume, mute, shuffle, repeat, transfer,
enqueue, queue_op, energy_dir`.
- `seek`: sekundy (číslo ≥ 0). Ovladač počítá z `dev.duration` (fallback `track.duration_ms`);
  při neznámé délce nic nepošle a ukáže toast. Cíl: při castu `/api/dlna/seek`, jinak
  `seekLocal()` (progresivní stream); během crossfade nejdřív dokončí přechod.
- `volume`: 0–1. `mute`: bool. `shuffle`: bool. `repeat`: `"off"|"all"|"one"`. `energy_dir`:
  `"auto"|"up"|"hold"|"down"` (cíl zapíše svůj `ms_dj_energy_dir` a zavolá `repickNext`).
- `toggle`: cíl rozhodne podle SVÉHO stavu (B12). Ovladač po odeslání optimisticky překlopí ikonu.
- `play`/`pause`/`toggle` na cíli: při `store.castDevice` jde na renderer (`/api/dlna/play|pause`),
  jinak `_resumeLocalPlayback()` / `_pauseLocalPlayback()` (B10, B17). Žádné násilné nastavení
  zisků během `_crossfading`.
- `enqueue`: seznam položek (≤ 200) → cíl `addToQueue(items, false)` (zrcadlí jednou).
- `queue_op`: `{op, …}`:
  - `{op:"play_now", items}` → cíl `addToQueue(items, true)`
  - `{op:"insert_next", items}` → vloží za aktuální (logika „Play next“ z contextmenu)
  - `{op:"move_next", index, name, artist}` → přesune řádek za aktuální
  - `{op:"remove", index, name, artist}` → odebere řádek (ověří, že na indexu leží ta skladba;
    jinak ji najde podle name+artist; jinak nic)
  - `{op:"move", from, to, name, artist}` → přeřadí (indexy fronty; cíl se shuffle odmítne)
  - `{op:"clear"}` → vyčistí frontu cíle (jeho clearActiveQueue)
  - `{op:"jump", index, name, artist}` → cíl začne hrát řádek `index`
  Cíl je provede přes `export function applyQueueOp(op)` v `queue.js`.
- `transfer`: `value` = `{queue, current_index, position_seconds, shuffle_order, playlist_mode,
  radio_mode, radio_seed}` sestavené ovladačem ze `store` (ne ze souboru ovladače). Server
  **sloučí** do uloženého souboru fronty cíle jen `queue, current_index, position_seconds,
  shuffle_order, radio_mode, radio_seed`; `volume` cíle zůstane; `playlist_mode` převezme
  jen když je to pojmenovaný playlist (ne Up Next/Radio — jméno `"Up Next"`/`"Radio"` nebo
  `__upnext_`/`__radio_`), jinak cíl ponechá svůj. Bez `value` (starý klient) se sloučí
  soubor ovladače stejně (ne kopie). Cíl pak `loadQueueState({ touchDeck: false })` (B11:
  nesahá na hrající deck), `resetSmartQueuePlayed()` + `_predictedNextIdx = null` (B18), plné
  `loadAndPlay()` (DJ přechod), posun na `position_seconds` gen-hlídaně, a když má aktivní
  dočasný playlist (Up Next), přepíše jeho obsah novou frontou (`replaceByName`).
- Server odmítne příkaz 409 `{"detail": "Device is controlling another device"}`, když
  hlášený stav cíle má `controlling` (B2). Klient cíle navíc: přijde-li příkaz, když sám
  ovládá, nejdřív opustí režim ovládání (`exitRemoteMode`) a pak příkaz provede.

## Fronta cíle na ovladači (B4, B7, B8)
- `GET /api/remote/queue?device=<id>` → `{queue, current_index, shuffle_order, playlist_mode,
  radio_mode}` z uloženého souboru fronty cíle (jen týž uživatel; bez `volume`).
- Ovladač si ji načte při vstupu do ovládání a pokaždé, když se změní `queue_rev` nebo
  `queue_len` v hlášení; drží ji ve `store.remoteQueue` (`{queue, shuffle_order, …}` | null).
- Panel fronty pod ovládáním kreslí `store.remoteQueue.queue`, aktuální řádek = `dev.index`,
  pořadí při `dev.shuffle` podle `remoteQueue.shuffle_order`; řádek „další“ = `dev.next`.
  Kliknutí → `queue_op jump`, ✕ → `queue_op remove`, tažení → `queue_op move` (při shuffle
  cíle tažení vypnuté s hláškou), Clear → `queue_op clear`.

## Události mezi moduly (DOM, `document`)
- `remote:play` (engine `loadAndPlay` pod ovládáním) → remote.js pošle `transfer` s payloadem ze store.
- `remote:enqueue` `{detail: items}` → `enqueue`.
- `remote:cmd` `{detail: {action, value}}` → remote.js: `toggle|play|pause|next|prev` přímo;
  `seek_pct` (0–1, přepočte z délky cíle), `volume_step` (±0.05 od `dev.volume`), `volume`,
  `mute` (bez value = převrátit `dev.muted`), `shuffle`/`repeat` (bez value = další stav od
  hodnoty cíle), `queue_op` (value = op), `energy_dir`.
- Engine po změně fronty, skladby, play/pauzy zavolá `document.dispatchEvent(new Event('remote:report'))`
  → remote.js hlásí stav hned (bez čekání na 3 s).

## Exporty, na které se ostatní spoléhají
- Engine (oba): `getRemoteState()`, `repaintLocal()` (bar + full player z lokálního stavu),
  `applyRemoteCommand(action, value)` (play/pause/toggle/next/prev/seek/volume/transfer/enqueue),
  stávající `addToQueue`, `loadAndPlay`, `flushQueue`, `pauseLocal`, `getAudio`.
  V3 navíc stávající `repickNext`.
- `fullplayer.js`: `setMuted(bool)`, `setShuffle(bool)`, `setRepeat(mode)` (cíl je volá z příkazu;
  zapíší store, localStorage, UI, a u shuffle totéž, co dělá tlačítko), `isMuted()`,
  `paintRemoteState(dev)` (srdce like, mute, shuffle, repeat, řádek „Next“ z hlášení cíle).
- `queue.js`: `applyQueueOp(op)` (cíl), `renderQueue()` kreslí pod ovládáním `store.remoteQueue`.
- `djpanel.js`: `setEnergyDirection(v)` (cíl), `syncDjPanel()` kreslí pod ovládáním read-only
  zrcadlo z `dev.engine`/`dev.dj`.

## Vlastnictví souborů (agenti nesahají do cizích; potřeba změny jinde → napsat do výstupu)
- **A backend:** `app/services/remote.py`, `app/routers/remote.py`, `tests/test_remote.py`;
  `app/routers/player.py` + `app/services/player.py` jen kvůli `radio_mode`/`radio_seed` v QueueState
  (souběžná dávka cast-opravy tyto dva soubory mění — změna co nejmenší).
- **B enginy:** `static/js/player_v3.js`, `static/js/player.js`.
- **C1 ovladač:** `static/js/remote.js`, `static/js/store.js`, `static/css/player.css`, `frontend/partials/*` (pokud nutné).
- **C2 fronta:** `static/js/queue.js`, `contextmenu.js`, `search.js`, `library.js`, `upnext.js`, `plmanager.js`, `radio.js`.
- **C3 UI:** `static/js/fullplayer.js`, `djpanel.js`, `settings.js` (+ jejich CSS, ne player.css).
- `static/js/cast.js` patří dávce cast-opravy — nesahat. Cast tlačítko pod ovládáním skryje CSS (C1).
- Nikdo: `static/index.html` (generovaný), `CLAUDE.md`, commit, push, nasazení.

## Texty v UI (anglicky, krátké; seznam jde Lukášovi do hlášení)
- `Reconnecting to <device>…` (banner, výpadek ≤ 15 s), po 15 s toast `<device> went offline`
- `<device> isn't responding` (žádné hlášení 10 s)
- `Tap <device> once to allow playback` (blocked)
- `Can't seek: track length unknown`
- `Settings of <device> — change them on that device` (DJ panel pod ovládáním)
- `These settings apply to this device, not <device>` (Settings pod ovládáním)
- `That device is controlling another device` (409)
- `Shuffle is on at <device> — turn it off to reorder` (tažení pod shuffle cíle)

## Změny po review (platí přednostně před textem výš)
- SSE se neověřuje stream tokenem, ale `GET /api/remote/token?device_id=` → `aud="remote"` vázaný
  na zařízení, 1 h; klient ho obnovuje 5 min před koncem. Ping 10 s, čerstvost karty 35 s.
- Příkaz nese `{id, epoch, action, value, ts, from}`; `ack` = `"<epoch>:<id>"`.
- Transfer: prázdná fronta → 400; hodnota příkazu = sloučený stav (`transfer_id`, queue, …),
  cíl ho použije přímo; soubor zůstává jako trvalá kopie. Bez vlastního souboru cíl nebere
  frontu výchozího zařízení (`fallback=False`).
- `track` v hlášení = skutečně hrající položka (i doporučení mimo frontu).
- Ovladač: `silenceForRemote()`; „Send to“ během ovládání posílá frontu ovládaného zařízení
  (nejdřív ho pozastaví, při neúspěchu znovu pustí); zařízení, které samo ovládá, nejde ovládat
  ani mu poslat frontu.
- Fronta je kopie se značkou `_src` (viz CLAUDE.md „Kontrakty“).
- Soubory front: `PLAYER_DIR/users/<user>/<device>.json`.
