# cast-opravy: rozhraní server ↔ klient (vedení dávky, 2026-11-19)

Závazné pro agenty dávky. Zdroj nálezů: `notes/impl/cast-review-2026-11-19.md` (čísla 1–19).

## Princip
Při aktivním castu je **autoritou pro konec skladby a přechod na další server** (nález 1).
Stránka na telefonu může kdykoli zamrznout; server ne. Klient při `status.follow === true`
NEDĚLÁ vlastní detekci konce ani vlastní stall-retry/skip — jen zobrazuje stav, posílá
uživatelské akce (Next/Prev/seek/play/pause/volume) a serveru hlásí, co by hrál dál.
Starý klientský algoritmus (s opravou dopočtu pozice) zůstává jako záloha, když server
`follow` nehlásí.

## POST /api/dlna/cast — nová pole (všechna volitelná, staré tělo dál funguje)
- `start_seconds: float = 0` — po úspěšném Play server seekne (nález 3). 0 = bez seeku.
- `queue_index: int = -1` — index castované položky v `store.playerQueue` (= v uložené frontě).
- `next: {queue_index:int, name, artist, album, image, duration_ms} | null` — co by klient
  hrál po této skladbě (výsledek `_upcomingIdx()` v player_v3: shuffle, Smart Queue predikce,
  repeat-all). `null` = klient neví / nic.
- `repeat: "off"|"all"|"one" = "off"`, `shuffle: bool = false`.
- Odpověď: `{"status":"casting","cast_seq":<int>}`.

## POST /api/dlna/next-hint — nový
Tělo `{queue_index:int, next:{…}|null, repeat, shuffle}` (`queue_index` = co klient považuje
za právě hrající). Klient posílá, když se jeho „další“ změní (úprava fronty, shuffle, predikce)
— porovnává klíč s naposledy odeslaným, žádný spam každý tick. Server hint přijme jen tehdy,
když `queue_index` sedí na jeho aktuální skladbu; jinak 409 `{"stale":true}` (klient si pak
nejdřív převezme stav ze statusu). 400 když není session.

## GET /api/dlna/status — rozšířená odpověď
`{"active": true, "device": <name>, "device_id": <udn>, "location": <url>, "state": ...,
 "position_seconds", "duration_seconds", "volume": <int|null>,
 "follow": true, "cast_seq": <int>,
 "track": {"queue_index", "name", "artist", "album", "image", "duration_ms", "by": "client"|"server"},
 "queue_ended": <bool>, "stale": <bool, jen když>, "abandoned": "<zpráva>" (jen když)}`
- **Skutečný stav po review (platí přednostně):** neznámá hlasitost = klíč `volume` CHYBÍ
  (ne `null`; stará stránka v cache by ukázala „null%“) — klient slider nehýbe (nález 19).
  Navíc `session_id` (nový při každé session, i v odpovědi na POST /cast), `idle_seconds`
  (0 při hraní), `queue_ended_ago` (s), `transport_status`; `{"active":false,"resuming":true}`
  během obnovy po startu; přeskočený cast = 409 `{superseded:true, cause:"superseded"}`;
  `follow:true` jen pro cast s `queue_index >= 0`; nečinnost 30 min → session končí bez Stop;
  stale = 60 s bez úspěšného vzorku.
- `stale: true` když v ticku selhala obě AVTransport volání; po N po sobě (N=5 ticků
  sledovače, tj. ~10–15 s) session končí → `{"active": false, "abandoned": "<Device> neodpovídá…"}`
  jednou, pak `{"active": false}` (nález 7).
- `duration_seconds`: od rendereru, jinak délka poslaná klientem (`duration_ms`).
- `cast_seq` roste s každým úspěšným castem (klientovým i serverovým).
- `track.by == "server"` → tuhle skladbu poslal sledovač sám.
- `queue_ended: true` — sledovač dohrál frontu a nic dalšího nepustil.
- `abandoned`: sledovač se vzdal (2 skladby po sobě nezačaly hrát / receiver nedostupný).

## Serverový sledovač (app/services/dlna.py)
- Jedna úloha na session (`user:device_id`), start po úspěšném castu, konec při `stop()`,
  při opuštění session, při konci fronty (session zůstane, `queue_ended`). Nesmí blokovat
  event loop (SOAP je async; souborové I/O přes `asyncio.to_thread`).
- Tick ~2 s: GetTransportInfo + GetPositionInfo přes `asyncio.gather`, GetVolume jen
  každý ~5. tick. Výsledek se cachuje v session; `get_status` vrací cache mladší než ~1.5 s,
  jinak se dotáže (single-flight: souběžné dotazy čekají na jeden výsledek — nález 6).
- Konec skladby: latch „hrálo“, poslední pozice + čas vzorku, dopočet přes mezeru,
  near-end = pos ≥ dur−12 nebo ≥ 0.85·dur; neznámá délka → konec jen po STOPPED po
  postupu > 1 s **a** uplynulé době přehrávání ≥ 30 s (nález 10 — přepnutí vstupu po
  pár sekundách nesmí posunout frontu).
- Stall: po castu bez PLAYING 15 s → jednou znovu poslat; 30 s → přeskočit; 2 mrtvé
  skladby po sobě → `abandoned`, sledovač končí.
- Výběr další: (1) hint, pokud jeho `queue_index` = aktuální a ještě nebyl použit;
  (2) jinak uložená fronta `player.load_queue(username, device_id)`: repeat one → tatáž;
  shuffle → první z `shuffle_order.tail` (pozice) různá od aktuální, vyčerpaný tail +
  repeat all → nová náhodná permutace; jinak index+1, na konci repeat all → 0, jinak konec.
  Aktuální položka se ve frontě hledá podle indexu, a když tam není tatáž (name+artist),
  podle name+artist. Repeat/shuffle bere z posledního hintu/castu.
- Po serverovém posunu přepíše v uloženém souboru fronty jen `current_index`,
  `position_seconds=0` a `shuffle_order` (aktuální → played, nová vyjmutá z tail).
- Souběh s klientem: sledovač si při detekci konce zapamatuje `generation`; cast pustí jen
  když se mezitím nezměnila (klient mezitím poslal vlastní cast → vyhrává klient).
- Restart kontejneru: aktivní session (device udn+location, track, hint, repeat/shuffle,
  cast_seq) se ukládá do `DATA_DIR/dlna_sessions.json` (atomicky, .tmp + os.replace);
  po startu se session obnoví a sledovač pokračuje (DmrDevice z location, s timeoutem;
  nedostupný receiver → session zahodit). Stream token si sledovač vyrábí sám
  (`auth.create_stream_token(username, ttl=24*3600)`).

## Klient (static/js/cast.js + malé háčky)
- Všechny POST /cast jdou přes jednu funkci v cast.js (`castItem(item, {startSeconds})`),
  která přidá `queue_index`, `next`, `repeat`, `shuffle` a zapamatuje `cast_seq`.
  Engine dodá přes `initCast`: `getUpcoming()` → `{index, item}|null`, `adoptTrack(idx, track)`,
  `pauseLocal()` (oba decky), `onCastPlaying(bool)` (ikona play/pauza), `localPosition()`.
- Převzetí: status s `cast_seq` > známý a `track.queue_index`/name ≠ aktuální → `adoptTrack`
  (nastaví `store.playerIndex`, UI, media session, shuffle bookkeeping, uloží frontu) a
  **neposílá cast**.
- Obnova po načtení stránky (nález 2): při initu `GET /api/dlna/status`; aktivní →
  `store.castDevice = {id: device_id, name: device}`, tlačítka, poll, převzetí skladby.
