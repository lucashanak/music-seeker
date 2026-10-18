# Kritika zadání „Oprava 2 — BPM nedostane zvuk, který už má na disku"

- Zadání: `notes/impl/oprava-2-zadani.md`, md5 na začátku **7db021517772907e75ce659aa3a5242f** (ověřeno)
- HEAD: `00fe700a2230f6867b58cfc5318754c1331efd90` (ověřeno), pracovní strom čistý
- Role: read-only kritika. Nic v repu změněno, nulové volání na produkci.
- Produkční čísla ze zadání přebírám hotová (nerevidoval jsem je, nemám na produkci sáhnout).

---

## 1. Premisa B2 — příznak „staženo" ve frontě. VYVRÁCENO.

**Verdikt: `item.inLibrary` v `store.playerQueue` ve většině cest neexistuje, a to i u skladeb,
které prokazatelně stažené JSOU. B1 na něm stát nemůže.**

### 1.1 `inLibrary` je čistě klientský příznak a vzniká jen ve dvou funkcích

```
grep -rn "inLibrary" app/          # 0 výskytů — backend ten klíč nezná
grep -rn "inLibrary" static/js/    # 20 výskytů, z toho ZÁPISY jen 3
```

Zápisy:
- `static/js/search.js:225` (`checkLibrary`)
- `static/js/search.js:231` (`store.currentArtistAlbums[idx]`)
- `static/js/library.js:587` (`_markTracksInLibrary`)

Všechno ostatní je čtení.

### 1.2 Obě zapisující funkce píšou do DOM, ne do objektu

`search.js:223-226`:
```js
if (cards[i].dataset.item) {
  const item = JSON.parse(cards[i].dataset.item);   // ČERSTVÝ objekt z parse
  item.inLibrary = true;
  cards[i].dataset.item = JSON.stringify(item);     // zpátky do dataset
}
```
Parametr `items`, který `checkLibrary(items, …)` dostala, **se nemění**. Totéž
`library.js:585-588`: `_markTracksInLibrary('#libraryTracks', currentLibPlaylistTracks)`
(volané z `library.js:491`) bere `tracks` jako druhý argument a **vůbec ho nepoužije** —
iteruje `$$('… .card')` a píše do `card.dataset.item`. Pole
`currentLibPlaylistTracks` zůstane bez příznaku.

Důsledek: příznak žije **jen v serializovaném řetězci v DOM**. Přežije jen ta cesta do
fronty, která položku znovu parsuje z `dataset.item`.

### 1.3 Třetí vlastnost: příznak se nastavuje jen na `true`, nikdy na `false`

`search.js:224` je uvnitř `if (inLib && cards[i])`. Klíč tedy u nestažené skladby
**chybí**, nikdy není `false`. `!!item.inLibrary === false` proto znamená dvě různé věci:
„ověřeno, že není v knihovně" a „nikdy se neptalo". Hradlo podle zadání (`!item.inLibrary → neptat se`)
obě slije dohromady a druhý případ je ten častý (viz 1.4).

Navíc `checkLibrary` má na `search.js:239` `catch`, který jen `console.warn` — při výpadku
`/api/library/check` (nebo vypršelém tokenu) nedostane příznak **ani jedna** karta.
Hradlo pak vypne BPM pro celou knihovnu a vypadá to jako „funkce je pryč", ne jako chyba.

### 1.4 Cesty do `store.playerQueue` — tabulka

Zápisy do fronty (`grep -n "playerQueue" static/js/*.js`, filtr na přiřazení/splice/concat/push):

| # | místo | zdroj položek | nese `inLibrary`? |
|---|---|---|---|
| 1 | `upnext.js:55` `initUpNext` hydratace | `/api/library/upnext` → `library.py:365-375` | **NE** — viz 1.5 |
| 2 | `upnext.js:121` `playTracks` | cokoli od volajícího | podle volajícího |
| 3 | `upnext.js:148` `playRadio` | `/api/radio` | **NE** |
| 4 | `upnext.js:178` `clearActiveQueue` | prázdno | n/a |
| 5 | `player.js:76` `playTrack(item)` | volající | podle volajícího |
| 6 | `player.js:84` `addToQueue(items)` | volající | podle volajícího |
| 7 | `player.js:357` auto-radio dosyp | `/api/radio` `data.tracks` | **NE** |
| 8 | `player.js:391` `playRecTrack` (remote) | doporučení | **NE** |
| 9 | `player.js:558` `loadQueueState` | `/api/player/queue` | **round-trip** — viz 1.6 |
| 10 | `player.js:741` | položka z `dataset.item` (`player.js:813/833`) | ANO |
| 11 | `contextmenu.js:441` „Play next" | `getItem()` z `dataset.item` | ANO |
| 12 | `library.js:768` multi-select vložení | `library.js:752` z `dataset.item` | ANO |

### 1.5 Hydratace z Up Next příznak zahazuje — a je to ta cesta, kde je vlastnictví jisté

`app/services/library.py:365-376` staví položku z **pevného seznamu klíčů**:
```python
tracks = [
    {
        "id": e.get("id", ""),
        "name": e.get("title", ""),
        "artist": e.get("artist", ""),
        "album": e.get("album", ""),
        "duration_ms": e.get("duration", 0) * 1000,
        "image": …,
        "type": "track",
    }
    for e in entries
]
```
Žádný příznak vlastnictví. Přitom **každá** položka tady pochází z playlistu v Navidrome,
takže je z definice v knihovně — `find_song_id` ji tam našel (`library.py:612-629`
`replace_playlist_by_names` přidá do playlistu jen to, co Navidrome zná; zbytek hlásí
jako `missing`).

To je inverze premisy zadání: cesta, u které je „staženo" **zaručené**, je zároveň cesta,
která příznak **nepřenese**. Po reloadu stránky (nejčastější vstup do aplikace) má fronta
samé položky bez příznaku a hradlo podle B1 vypne BPM úplně — včetně bodu 2 přejímky
(„stažená skladba v playlistu BPM dál dostane"), který by tím **spadl**.

Totéž `library.js:368-375` `_playLibraryPlaylist` → `_fetchPlaylistTracks` → `data.tracks`
z téhož endpointu: „Play" na playlistu v knihovně dá frontu bez příznaku.

### 1.6 Round-trip přes `/api/player/queue` příznak zachová — ale jen když tam byl

`app/models.py:85-90` má `queue: list[dict]`, `app/routers/player.py:197-199` dělá
`state.model_dump()` a `player.save_queue` uloží dict beze změny. Extra klíče tedy
projdou tam i zpět. To ale nic nezachraňuje: hodnota se do fronty musí nejdřív dostat,
a podle 1.4 se tam ve většině cest nedostane.

### 1.7 Album a interpret příznak nemají nikdy

`player.js:500-520` `resolveItemTracks`:
```js
if (type === 'album' && item.id) {
  const data = await apiJson(`/api/album/${item.id}/tracks…`);
  return (data.tracks || []).map(t => ({ ...t, type: 'track' }));
}
```
Skladby alba jsou ze Spotify a příznak nemají, i kdyby bylo album stažené celé.
Jen větev `return [item]` (jedna skladba) zdědí, co měl volající.

`library.js:275-282` jde ještě dál — mapuje na šest pevných klíčů
(`name, artist, album, image, duration_ms, type`) a **cokoli navíc explicitně zahodí**.

### 1.8 Co z toho plyne pro zadání

Premisa B2 („příznak existuje, jen jsem neověřil, že je i ve frontě") je **vyvrácená ve dvou
směrech najednou**:
1. ve frontě **není** u většiny cest, a
2. tam, kde by měl nejvíc smysl (Navidrome playlist, Up Next hydratace), chybí **právě proto**,
   že položka přišla ze serveru, který ten klíč neumí.

B1 napsané jako „hradluj na `item.inLibrary`" by tedy nevypnulo volání pro nestažené skladby —
**vypnulo by je skoro pro všechny**, a tiše by rozbilo přesně tu cestu, kterou má přejímka
bod 2 chránit. Oprava není v hradle, ale v tom, **odkud se pravda o vlastnictví bere**.

---

## 2. Je „staženo" vůbec dobře definované? NE — jsou to dvě různé množiny.

Zadání mlčky předpokládá `inLibrary ⟺ _get_audio_file uspěje`. Kódem doloženo,
že **ani jedna inkluze neplatí**.

### 2.1 Tři různé predikáty na tři různá místa

| predikát | kde | jak rozhoduje |
|---|---|---|
| `inLibrary` | `library.check_items` → `_search_navidrome` (`library.py:103-141`) | Navidrome `search3`, **dva** dotazy: `"{artist} {name}"`, pak `"{name}"` |
| „analýza na to dosáhne" | `bpm._get_audio_file` (`bpm.py:1158-1198`) | `find_track_file` (soubor na disku) **nebo** `find_song_id` |
| `find_song_id` | `library.py:192-206` | Navidrome `search3`, **jediný** dotaz `query=name` (jen titul), `songCount=50` |

### 2.2 `inLibrary = true`, a přesto 404 (nadmnožina)

`_search_navidrome` zkusí nejdřív `"{artist} {name}"` a teprve pak `"{name}"`
(`library.py:106-108`). `find_song_id` pošle **jen** `query=name` (`library.py:197`)
a prohledá prvních 50 výsledků. Skladba s obecným názvem („Lithium", „Numb") se
v top 50 výsledků na samotný titul nemusí objevit, zatímco na `"nirvana lithium"`
ano. Pak platí: `inLibrary = true`, `find_song_id = None`, žádný lokální soubor →
`_get_audio_file` vrátí `None` → **404 i po projití hradla**. B1 tedy 404 nevyruší,
jen zmenší.

### 2.3 Lokální soubor bez Navidrome (podmnožina)

`_get_audio_file:1159` sáhne nejdřív na `find_track_file` → `_resolve_local_file`
(`player.py:130-170`), což je čistě hledání souboru `/music/{user}/{artist}/{album}/{title}.{flac|mp3|opus|m4a}`.
Na Navidrome se neptá. Čerstvě stažená skladba je na disku **dřív**, než ji
Navidrome naskenuje (`downloader.py:102-106` scan až po stažení) → `inLibrary = false`,
ale analýza by prošla. Hradlo podle B1 by ji vypnulo.

CLAUDE.md říká, že `/music` je stejný svazek jako pro Navidrome. Stejný svazek ale
neznamená okamžitý index — a navíc se obě strany shodují na **jiném klíči**:
`_resolve_local_file` matchuje sanitizované **jméno souboru**, Navidrome matchuje
**tagy**. Přejmenovaný soubor se správnými tagy je v Navidrome a ne v `find_track_file`;
správně pojmenovaný soubor se špatnými tagy naopak.

### 2.4 Co z toho plyne

`inLibrary` neměří to, co `_get_audio_file` umí otevřít. Je to **třetí**, nezávisle
implementovaný odhad téhož. Hradlovat klienta na něj znamená přidat čtvrté místo,
kde se „staženo" počítá jinak. Jediný predikát, který je s chováním serveru shodný
z definice, je **odpověď serveru samotného** — tedy varianta „server řekne
`owned: false` a klient si to zapamatuje", ne „klient si to odvodí sám".

---

## 3. Ověření citací ze zadání

### 3.1 Řádky — všechny sedí doslova

Ověřeno příkazem `for spec in …; do sed -n "${l}p" "$f"; done` (viz 3.3).

| citace v zadání | obsah řádku | sedí |
|---|---|---|
| `player.py:232` `resolve_stream` | `async def resolve_stream(name, artist)` | ✅ |
| `player.py:243` lokální | `result = await loop.run_in_executor(None, _resolve_local_file, …)` | ✅ |
| `player.py:249` Navidrome | `result = await _resolve_navidrome(name, artist)` | ✅ |
| `player.py:255` YouTube | `result = await _resolve_youtube(name, artist)` | ✅ |
| `player.py:599` `cache_youtube_stream` | `async def cache_youtube_stream(…)` | ✅ |
| `bpm.py:1158` `_get_audio_file` | `async def _get_audio_file(…)` | ✅ |
| `bpm.py:1159` lokální | `local = find_track_file(name, artist)` | ✅ |
| `bpm.py:1163–1164` `return None` | `if not … or not song_id:` / `return None` | ✅ |
| `bpm.py:1169, 1176` Navidrome | `cache_navidrome_stream(...)` / `cache_path = …flac` | ✅ |
| `bpm.py:1204` `_analysis_locks` | `_analysis_locks: dict[str, asyncio.Lock] = {}` | ✅ |
| `bpm.py:1239` `return None` | `return None` (v `analyze_track`) | ✅ |
| `bpm.py:1080` `_analyze_or_read_tag` | `def _analyze_or_read_tag(file_path)` | ✅ |
| `bpm.py:1120, 1137` `write_tags` | obě `write_tags(file_path,` | ✅ |
| `routers/bpm.py:49–51` | `analyze_track` / `if not result` / `raise HTTPException(404, …)` | ✅ |
| `djmix.js:18` | `export { fetchTrackBpm as fetchDjData };` | ✅ |
| `player_v3.js` 525/536/555/588/926/1056/1677 | všech 7 je volání `fetchDjData` | ✅ |
| `bpm.js:15 / :146 / :299` komentáře „owned-only" | doslova | ✅ |
| `bpm.js:100` `fetchTrackBpm` | `export async function fetchTrackBpm(name, artist)` | ✅ |
| `bpm.js:369` | `await fetchTrackBpm(item.name, item.artist);` | ✅ |
| `bpm.js:424` | komentář `// 12 concurrent requests (server has 6-thread pool…)` | ✅ řádek, ❌ obsah → 3.2 |
| `queue.js:53` | `const data = await fetchTrackBpm(…)` | ✅ |
| `search.js:169/186/225`, `contextmenu.js:363` | `inLibrary` | ✅ |

**Sedm volání `fetchDjData` v `player_v3.js` je přesně sedm** (`grep -n fetchDjData`
vrací ještě 11 = import a 918/1049 = komentáře). Žádné nepředává `song_id` —
nemůže, `fetchTrackBpm(name, artist)` má jen dva parametry a URL na `bpm.js:104`
`song_id` neobsahuje. ✅

### 3.2 Dvě čísla v zadání jsou PŘEVZATÁ Z KOMENTÁŘE A JSOU ŠPATNĚ

Zadání píše: *„`bpm.js:424` pouští **12 souběžných požadavků** („server has 6-thread
pool, 12 keeps it saturated")."* a staví na tom argument o amplifikaci.

Skutečnost:

```
static/js/bpm.js:424    // 12 concurrent requests (server has 6-thread pool, 12 keeps it saturated)
static/js/bpm.js:425    const CONCURRENT = 4;
```
```
app/services/bpm.py:67  _executor = ThreadPoolExecutor(max_workers=int(os.environ.get("BPM_WORKERS", "2")))
```

- Souběžnost je **4**, ne 12.
- Pool má **2** vlákna (výchozí `BPM_WORKERS`), ne 6.
- Třetí číslo: docstring téže funkce (`bpm.js:375`) slibuje „**6** concurrent per-track requests".

Tři různá čísla v jedné funkci, a zadání si vybralo to jediné, které není nikde
v kódu. Je to **přesně ta chyba, kvůli které měla dávka 1 kolo 3**: komentář se
vydával za měření. Argument „amplifikace" tím neumírá, ale jeho velikost je
**3× menší**, než zadání tvrdí, a `_run_in_pool` ji dál srovnává na 2 souběžné
analýzy bez ohledu na to, kolik požadavků přijde.

### 3.3 Příkazy k přehrání

```bash
cd /home/lucas/music-seeker
for spec in app/services/bpm.py:1158 static/js/bpm.js:424 static/js/bpm.js:425; do
  f=${spec%:*}; l=${spec#*:}; printf '%s:%s | %s\n' "$f" "$l" "$(sed -n "${l}p" "$f")"
done
grep -n "max_workers" app/services/bpm.py
grep -n "fetchDjData" static/js/player_v3.js
grep -rn "inLibrary" app/ ; echo "navratovy kod: $?"   # 1 = zadny vyskyt
```

### 3.4 Premisa o `song_id` je pravdivá, ale v argumentu nehraje roli

Zadání z „nikde nepředává `song_id`" dělá součást příčiny. **Server si ho dohledá sám:**

```python
# app/routers/bpm.py:46-47
if not song_id:
    song_id = await library.find_song_id(name, artist) or ""
```

Chybějící `song_id` na klientovi tedy 404 **nezpůsobuje**. 404 vzniká tím, že
`find_song_id` nic nenašla a lokální soubor není. Zadání to formuluje tak, že to
vypadá na vadu klienta; není.

(Pro úplnost: `bpm.js:415` v `addScanButton` `song_id` **předává** —
`&song_id=${item.id || ''}`. Tvrzení „nikde" platí jen pro `player_v3.js`/`queue.js`.)

---

## 4. Hrozby

### 4.1 Co dávka spouští drahého a kdo to vyvolá

Dnes, bez jakékoli změny, jeden `GET /api/bpm/track?name=…&artist=…` od
**kteréhokoli držitele JWT** (`routers/bpm.py:34` `Depends(auth.get_current_user)`,
parametry nijak nevázané na knihovnu) spustí:

1. `bpm.get_cached_bpm` — levné.
2. `library.find_song_id` → HTTP `search3` na Navidrome, `songCount=50` (`bpm.py` router:46).
3. `analyze_track` → **vytvoří trvalý `asyncio.Lock`** (viz 4.3).
4. `_get_audio_file` → `find_track_file` → **`rglob` přes celý `/music` na NAS**
   (`player.py:147-168`, dvě pasáže: nejdřív adresář interpreta, pak **všechny**
   uživatelské adresáře × 2 varianty titulu × 4 přípony).
5. Pokud je `song_id`: `cache_navidrome_stream` → **stažení celé stopy** jako 320k MP3;
   při selhání `bpm.py:1174-1198` → **stažení celého původního FLACu** (`timeout=120`).
6. `_run_in_pool(_analyze_or_read_tag)` → madmom analýza.

**Strop je jen na disk** (`NAV_CACHE_MAX_BYTES`/`BPM_CACHE_MAX_BYTES` = 2 GiB,
`player.py:24-26`). Na počet požadavků, na stažené bajty ani na CPU strop není —
`grep -rn "ratelimit\|slowapi\|Limiter" app/` vrací jen `playlist_harvest`, nic
pro BPM. `_run_in_pool` ale srovná **analýzu** na 2 souběžné (`BPM_WORKERS=2`);
co se neserializuje, jsou kroky 2–5, tedy právě ty síťové a diskové.

**Hradlování na klientovi tohle neřeší vůbec.** Endpoint zůstane otevřený komukoli
s tokenem a s libovolným `name`/`artist`. B1 sníží provoz od vlastní aplikace;
neudělá z endpointu nic levnějšího. Pokud dávka chce tvrdit „server odpoví levně",
musí to být **B3 na serveru**, a B1 je jen optimalizace UX.

### 4.2 Blokující `rglob` v async funkci

`resolve_stream` (`player.py:241-243`) volá `_resolve_local_file` **přes
`run_in_executor`** s výslovným komentářem *„rglob blocks on NAS"*.
`_get_audio_file` (`bpm.py:1159`) volá `find_track_file` → tutéž funkci
**přímo v korutině**. Každý 404 na `/api/bpm/track` tedy blokuje event loop na
dobu průchodu celého `/music` přes NAS. V zadání to není; pro B3 („levně") je to
podstatné — dnes je **404 ta dražší odpověď**, protože projde obě pasáže rglobu
až do konce, zatímco nález skončí dřív.

### 4.3 `_analysis_locks` roste navždy a 404 se nikdy necachuje

```python
# app/services/bpm.py:1229-1239
if key not in _analysis_locks:
    _analysis_locks[key] = asyncio.Lock()      # vzniká PŘED pokusem o zvuk
async with _analysis_locks[key]:
    …
    file_path = await _get_audio_file(song_id, name, artist)
    if not file_path:
        return None                             # zámek zůstává
```

Dict se nikde nepročišťuje (`grep -n "_analysis_locks" app/services/bpm.py` → jen
1204, 1230, 1231, 1232). Každá **neúspěšná** dvojice `(name, artist)` tam nechá
trvalý objekt. Při `mem_limit 2g` a doložené historii OOM je to relevantní.

Souběžně: `fetchTrackBpm` (`bpm.js:101-110`) ukládá do `_cache` **jen úspěch**,
a `_bpm_cache[key] = result` v `analyze_track` taky jen úspěch. Neexistuje
**negativní cache** ani na klientovi, ani na serveru. Stejná nestažená skladba
tedy generuje 404 při každém překreslení fronty donekonečna — což je realistické
vysvětlení poměru 18:22 z měření a zároveň důvod, proč samotné B1 (hradlo) uleví,
ale B3 bez negativní cache neuleví skoro vůbec.

### 4.4 Riziko, které zadání nepojmenovalo: hradlo zhasne BPM plošně

Viz 1.3–1.5. `inLibrary` chybí u hydratované fronty, u „Play" na knihovním
playlistu i u celého alba. Nasazené B1 v napsané podobě by nejpravděpodobnější
pozorovaný výsledek nebyl „míň 404", ale **„BPM zmizelo"**. A protože `catch` v
`checkLibrary` je tichý (`console.warn`), vypadalo by to při výpadku
`/api/library/check` stejně.

---

## 5. Neověřené podezření ze zadání — `write_tags` do sdílené cache. POTVRZENO, s výhradou.

### 5.1 Zámek to NEVYLUČUJE — komentář v kódu tvrdí opak a je nepravdivý

`bpm.py:1166-1168`:
> *„Reuse the player's shared Navidrome stream cache (ms-nav-cache/{song_id}.mp3) …
> **it's build-lock-guarded against the live stream GET.**"*

`cache_navidrome_stream` (`player.py:384-429`):
```python
if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
    return cache_path          # ← řádky 400-401: VRACÍ SE PŘED ZÁMKEM
lock_key = f"nav:{cache_path}"
lock = _get_build_lock(lock_key)
try:
    async with lock:           # zámek drží jen po dobu STAVBY
        …
finally:
    _release_build_lock(lock_key)
```

Zámek chrání **jen stavbu** souboru a na teplé cestě se vůbec nebere. Následný
`write_tags` v `_analyze_or_read_tag` ho nedrží. `FileResponse(cached, …)` na
`routers/player.py:119` se o něj taky neopírá. **Žádný zámek mezi zápisem tagů
a servírováním neexistuje.** Komentář na `bpm.py:1168` je nepravda stejného druhu,
jaký zadání vytýká `bpm.js` — jen opačným směrem (slibuje ochranu, která není).

Pin `_raw_pins` / `raw_pinned` (`player.py:448-464`) z opravy 1 je volán **výhradně**
ve větvi `source == "local"` (`routers/player.py:103-110`). Navidrome větev ho nemá.
A i kdyby měl, pin fixuje **volbu reprezentace** (raw vs. MP3), ne obsah souboru.

### 5.2 Změří se to: zápis tagů dokáže posunout bajtové offsety

Změřeno lokálně, mutagen 1.47.0, bez produkce
(`scratchpad/mutagen-test4.out`, `flac-test.out`):

| výchozí padding v MP3 | velikost před | po | změna | audio začíná na |
|---|---|---|---|---|
| výchozí (mutagen) | 84 566 | 84 566 | **0 B** | 1166 → 1166 |
| nulový | 83 459 | 84 941 | **+1 482 B** | 1166 → **1541** |
| 64 B | 83 523 | 84 941 | **+1 418 B** | 1166 → **1541** |

Skript (přehratelný):
```bash
cd <scratchpad> && python3 - <<'PY'
import os, sys; sys.path.insert(0, '/home/lucas/music-seeker')
from mutagen.easyid3 import EasyID3
from app.services.bpm import write_tags
body = (b'\xff\xfb\x90\x64' + b'\x00'*413) * 200
def run(label, padding):
    p=f'pad{label}.mp3'; open(p,'wb').write(body)
    t=EasyID3(); t.filename=p; t['artist']='Eminem'; t['title']='X'; t.save(padding=padding)
    s1=os.path.getsize(p)
    write_tags(p, bpm=128, key='8A', beat_anchor=.123, intro_end=1.5, outro_start=180.,
               algo_ver=7, energy=.5, danceability=.6, brightness=.4, key_confidence=.9,
               feature_ver=3, downbeat_anchor=.123, time_sig=4, lufs=-9.1, loudness_range=5.2)
    print(label, s1, os.path.getsize(p), os.path.getsize(p)-s1)
run('vychozi', None); run('nula', lambda i: 0); run('mala64', lambda i: 64)
PY
```

**Závěr:** mechanismus je reálný, ale **podmíněný**. Když má soubor dost paddingu,
délka se nezmění (jen `mtime`); když ne, soubor naroste a **všechny bajtové offsety
audia se posunou o ~375 B**. Běžící `Range` požadavek na starý offset pak dostane
data z jiného místa, a u zkrácení 416 — přesně třída chyby z opravy 1. Jestli
ffmpeg v Navidrome nechává v MP3 padding, **nevím a bez produkce nezjistím**; proto
„potvrzeno jako možné", ne „potvrzeno jako nastávající".

### 5.3 Neexistující `ms-nav-cache` na produkci riziko NEODSTRAŇUJE — jen ho přesouvá

To, že `/tmp/ms-nav-cache` na produkci není, znamená, že se **žádná** skladba
nerozřešila na `source == "navidrome"` — lokální soubor vyhrává dřív
(`player.py:241-247` a `bpm.py:1159`). Jenže tatáž `_analyze_or_read_tag` →
`write_tags` pak píše do **skutečného souboru v `/music`**, který `/api/player/stream`
servíruje jako `FileResponse(path, …)` (`routers/player.py:110` a `:113`).
Riziko tedy **neleží v nepoužívané větvi, ale v té jediné, která se používá.**

Navíc: `cache_local_transcode` klíčuje cache jako `sha1(abspath + mtime)`
(`player.py:506-511`). Změřeno, že zápis tagů **mění `mtime` i tehdy, když se
velikost nezmění** (`mutagen-test3.out`: `mtime zmenen: True`, `ZMENA DELKY: 0 B`).
Každá analýza stažené skladby tedy **invaliduje její MP3 transkód** a příští
přehrání ho překóduje znovu — na stroji s `mem_limit 2g` a historií OOM.

**Pro zadání to znamená:** sekce „K ověření" míří na větev, která se nepoužívá, a
míjí tu, která ano. Doporučuji ji přepsat na lokální cestu.

---

## 6. Unesou navrhované testy mutaci?

### 6.1 Zadání se mýlí v tom, že na BPM nejsou testy

Zadání: *„Repo nemá ani jeden test na BPM (51 sebraných testů, `grep -rl bpm tests/`
nevrací nic)."* — Ten grep hledal **jen v `tests/`**. V kořeni repa leží:

```
test_bpm.py              215 r. — analýza proti PRODUKČNÍMU Navidrome (192.168.1.22:4533)
test_bpm_eval.py         533 r. — OLD/NEW evaluace proti PRODUKČNÍMU API
test_bpm_playwright.mjs  293 r. — login → knihovna → Analyze BPM → badge → filtry, BASE=http://192.168.1.22:8090
```

Počet 51 pytest testů v `tests/` **sedí** (`python3 -m pytest tests/ --collect-only -q`
→ `51 tests collected`). Závěr „testy si dávka musí přinést" tedy **platí**, ale
odůvodnění je nepravdivé a riziko je nepojmenované: `test_bpm_playwright.mjs` je
hotový BPM postroj a **míří na produkci**, což tahle dávka zakazuje. Zadání by mělo
výslovně říct „nespouštět", jinak ho někdo v dobré víře spustí.

### 6.2 Jde to bez produkce a bez placených volání? ANO.

Ověřeno, že se aplikace importuje lokálně:
```bash
cd /home/lucas/music-seeker
DATA_DIR=<tmp>/d MUSIC_DIR=<tmp>/m python3 -c "import sys; sys.path.insert(0,'.'); import main; print(len(main.app.routes))"
# → IMPORT OK, routes: 144        (jen RuntimeWarning o chybějícím ffmpeg)
```
`node_modules` i `@playwright/test` ^1.58.2 v repu jsou. Je tedy možné:
**uvicorn na localhost + Playwright proti `http://127.0.0.1:…`**, nulová produkce,
nulové placené volání. Instanci stačí `MUSIC_DIR` s pár soubory a vypnuté
`NAVIDROME_PASSWORD` (pak `check_items` vrací `[False]*n`, `library.py:67-68`).

### 6.3 Čím konkrétně doložit B1 a B2 tak, aby to nad starým kódem padalo (D18)

**B1 — Playwright proti lokální instanci, počítadlo požadavků.**
```js
let bpmCalls = [];
page.on('request', r => { if (r.url().includes('/api/bpm/track')) bpmCalls.push(r.url()); });
```
Scénář: přihlásit se, nechat frontu naplnit položkami **bez** příznaku staženo,
otevřít panel fronty (spustí `queue.js:40-68`), počkat > 1 200 ms (timer 1 000 ms
+ rezerva) → `expect(bpmCalls).toHaveLength(0)`.
*Mutace:* smazat hradlo v `queue.js:53` → `bpmCalls.length > 0` → **červená**. ✅ unese.

**B1 — druhá polovina, která je důležitější: kontrola, že se BPM NEZTRATILO.**
Tentýž scénář s frontou ze **stažených** skladeb → `expect(bpmCalls.length).toBeGreaterThan(0)`
a na kartě se objeví `.qi-bpm`. **Tenhle test nad B1 v napsané podobě spadne**
(viz 1.5) — a právě proto ho tam chci: je to mechanická kontrola premisy B2.

**B2 — čistě v node, bez prohlížeče, nejlevnější a nejostřejší.**
`upnext.js` i `player.js` jsou ES moduly; `store.js` je prostý objekt. Stačí
`node --test` s malým stubem `document`/`apiJson` (dynamický import + `--experimental-...`
netřeba, Node 18+ umí ESM nativně):
```js
import { store } from './static/js/store.js';
// hydratace: simulovat odpoved /api/library/upnext s tvarem z library.py:365-375
// a overit, ze po initUpNext() kazda polozka store.playerQueue nese priznak staženo
```
*Mutace:* z tvaru položky odstranit příznak → test červená.
**Dnes je tenhle test červený bez jakékoli mutace** — což je přesně ten doklad,
že B2 neplatí.

**B3 — pytest, bez madmom.**
`main.py` se importuje; `TestClient` + `monkeypatch` na `bpm.analyze_bpm`
(a na `_run_in_pool`), který při zavolání `raise AssertionError("analyza spustena")`.
Požadavek na nestaženou skladbu → očekávaný stavový kód a **žádné vyvolání**.
*Mutace:* vrátit původní větev → analýza se zavolá → červená. ✅ unese, a je to
jediný bod dávky, který se dá doložit **bez prohlížeče i bez produkce**.

### 6.4 Past, na kterou vedení upozornilo

Všechna měření výš jsou ukládána do souboru a exit kód čten zvlášť
(`cmd > out.txt 2>&1; echo "exit=$?"`), nikdy `$?` za rourou. `pytest --collect-only`
běžel takto a vrátil `exit=0`.

---

## 7. Bod B4 — co `player_v3.js` dnes dělá, když `fetchDjData` vrátí `null`

**Nespadne a nepřeskočí. Tiše degraduje na čtyřech místech najednou.**

| | chování bez DJ dat | řádek |
|---|---|---|
| kontrola crossfade | odloží se, dokud `currentTime < dur - crossfade - 5` → rozhoduje se až v posledních ~10 s | `player_v3.js:1869` |
| délka přechodu | `triggerAt = _crossfadeDur()` = nastavení `crossfade_sec`, výchozí **5 s**; beat/downbeat větev se přeskočí | `:1892`, `:1902` |
| **Smart Queue** | `pickSmartNext` se **vůbec nezavolá** (`… && _outDjData`) → přehrávání je sekvenční, zatímco nastavení dál hlásí „smart" | `:609`, `:1261` |
| LUFS vyrovnání | `_levelGainFor(undefined)` → gain 1.0, bez vyrovnání | `:1064`, `:354` |
| intro/outro skip | `outro_skip='auto'` se neuplatní (podmínka na `_outDjData.outro_start`) | `:1879` |

Pád nehrozí: `scheduleDjTransitionV3` čte `outData?.bpm` / `inData?.bpm`
(`djmix.js:840-841`) a PLL na `:434` je uvnitř stráže `transOutData?.bpm && transInData?.bpm`
(`:423`). Diagnostika existuje: `localStorage.ms_dj_debug='1'` vypíše
`grid=fallback outBpm=null` (`:1926-1928`).

**Varianty pro dodatek, s cenou a ztrátou:**

| varianta | cena | co se ztratí | poznámka |
|---|---|---|---|
| **A. Nechat jak je** | 0 | nic nového; zůstává tichá lež „Smart Queue zapnuto" | porušuje záměr B4 („ne ticho") |
| **B. Přiznat v UI** (odznak „bez tempa" u položky fronty, poznámka u přepínače Smart Queue) | malá, `queue.js` + partial | nic | **doporučuji**; splní B4 doslova a nemění zvuk |
| **C. Nestažené přeskakovat** | malá | uživatel přijde o skladby, které dnes hrají | mění chování přehrávače, ne jen zobrazení — mimo rozsah dávky |
| **D. Mixovat natvrdo a říct to** = B + ponechat 5s fade | = B | nic | prakticky totéž co B |

Pozor: varianta C se potká s 2.2 — „nestažená" podle klienta není totéž co
„server na ni nedosáhne", takže by přeskakovala i skladby, které BPM mají.


---

## 8. Verdikt

# PŘEPRACOVAT

Ne kvůli drobnostem — kvůli tomu, že **premisa, na které stojí těžiště dávky,
neplatí**, a bod, který měl největší váhu (B1), by v napsané podobě způsobil
regresi, kterou vlastní přejímka dávky (bod 2) odhalí až na živé instanci.

Co konkrétně přepsat, než to půjde k autorovi:

1. **B2 zahodit a nahradit.** `item.inLibrary` ve frontě neexistuje a existovat
   nemá — je to příznak vázaný na kartu v DOM, ne na skladbu. Zdroj pravdy musí
   být server (odpověď endpointu, nebo nové pole v tvaru položky v
   `library.py:365-375` + `/api/player/queue`), ne klientský odhad. Dokud tohle
   zadání nerozhodne, B1 nemá na čem stát.
2. **B1 přeformulovat** z „hradluj na `inLibrary`" na „hradluj na příznaku, který
   položka fronty nese po **všech** cestách z 1.4" — a do přejímky přidat
   protikus: *stažená skladba BPM dál dostane* se musí měřit **počítadlem
   požadavků**, ne pohledem na badge.
3. **B3 povýšit z doplňku na jádro.** Hradlo na klientovi endpoint nezlevní
   (4.1). Levná a pravdivá odpověď navíc potřebuje **negativní cache** (4.3),
   jinak se 18 z 22 jen přejmenuje z 404 na 200-s-„neni-stazena" při stejné ceně.
4. **Sekci „K ověření" přesměrovat** z nepoužívané Navidrome větve na lokální
   (5.3) a tu označit za samostatný nález, ne za podezření.
5. **Opravit čísla**: souběžnost 4 (ne 12), pool 2 (ne 6), BPM testy existují
   (tři soubory, všechny proti produkci).

Co je v zadání dobře a má zůstat: rozhodnutí zadavatele a jeho důsledek
(dnešní chování serveru je podle pravidla správné, chybějící YouTube stupeň je
hranice, ne díra) — to kód potvrzuje. Rozpočet 0 placených volání je splnitelný,
protože se aplikace spustí lokálně (6.2). B4 je správně ponechán na dodatek a
podklady k rozhodnutí jsou v sekci 7.

---

## 9. Seznam vyvrácených premis

| # | premisa v zadání | stav | důkaz |
|---|---|---|---|
| 1 | „Příznak `item.inLibrary` existuje … není ověřeno, že totéž nese položka v `store.playerQueue`" (B2) | **VYVRÁCENO** — nenese ho ve většině cest a chybí právě tam, kde je vlastnictví jisté | 1.2–1.7 |
| 2 | Mlčky: `inLibrary` ⟺ „analýza na skladbu dosáhne" | **VYVRÁCENO** — dvě různé množiny, ani jedna inkluze | 2.2, 2.3 |
| 3 | „`bpm.js:424` pouští 12 souběžných požadavků" | **VYVRÁCENO** — kód má `CONCURRENT = 4`; číslo 12 je jen zastaralý komentář | 3.2 |
| 4 | „server has 6-thread pool" (převzato do argumentu) | **VYVRÁCENO** — `BPM_WORKERS` výchozí **2** | 3.2 |
| 5 | „Repo nemá ani jeden test na BPM" | **VYVRÁCENO** — `test_bpm.py`, `test_bpm_eval.py`, `test_bpm_playwright.mjs` (1 041 řádků); grep byl zúžený na `tests/` | 6.1 |
| 6 | Implicitně: chybějící `song_id` na klientovi se podílí na 404 | **VYVRÁCENO** — router si ho dohledá (`routers/bpm.py:46-47`) | 3.4 |
| 7 | „nikde nepředává `song_id`" | **ČÁSTEČNĚ** — platí pro `player_v3.js`/`queue.js`, ne pro `bpm.js:415` | 3.4 |
| 8 | „nevím, jestli tam není zámek, který to vylučuje" | **ZODPOVĚZENO: zámek tam NENÍ** a komentář `bpm.py:1168`, který ho slibuje, je nepravdivý | 5.1 |
| 9 | „nav cache na produkci neexistuje" ⇒ riziko je hypotetické | **VYVRÁCENO** — tentýž zápis jde do skutečných souborů v `/music`, které stream servíruje | 5.3 |
| 10 | „Jak se B1 a B2 doloží … je otevřené" (předpoklad, že možná nejde bez produkce) | **VYVRÁCENO v náš prospěch** — aplikace se spustí lokálně, Playwright i pytest jdou bez produkce | 6.2, 6.3 |

Co jsem **nevyvrátil** a potvrzuji: všechny citace `soubor:řádek` sedí doslova
(3.1); sedm volání `fetchDjData` je opravdu sedm; `_analysis_locks` serializuje
jen stejnou skladbu; `return None` na `bpm.py:1164`/`1239` se opravdu propíše na
404; rozhodnutí zadavatele je s kódem konzistentní.

Nálezy nad rámec zadání: blokující `rglob` v korutině (4.2), neomezený růst
`_analysis_locks` (4.3), chybějící negativní cache (4.3), invalidace transkódu
přes `mtime` (5.3), tichý `catch` v `checkLibrary` (1.3).

---

## 10. Kontrola zamrazení na konci práce

```
$ md5sum notes/impl/oprava-2-zadani.md
7db021517772907e75ce659aa3a5242f  notes/impl/oprava-2-zadani.md
$ git rev-parse HEAD
00fe700a2230f6867b58cfc5318754c1331efd90
$ git status --porcelain
(prazdne)
```
