# Oprava 5 — Dodatek po review

**Přednost:** dodatek po review > dodatek po kritice > zadání.

Devět drah, **otisk zamrazeného stromu seděl u všech devíti**.

| celek | kód | testy | adversariální |
|---|---|---|---|
| c4 detail | **vrátit** | přijmout s výhradami | **vrátit** |
| c5 knihovna | přijmout s výhradami | **vrátit** | **vrátit** |
| c6 backend | přijmout s výhradami | přijmout s výhradami | **vrátit** |

---

## A. Celek 6 — práh popularity (BLOKUJÍCÍ)

### R6.1 — práh 1 000 000 fanoušků vezme kartu interpreta skoro každému, koho Lukáš poslouchá

Absolutní práh neměří to, co má. Na Deezeru má Portishead 584 k, Bonobo 366 k,
Khruangbin 99 k — a **všichni čeští interpreti jsou hluboko pod ním**:
Chinaski 17 728, Ektor 36 487, Yzomandias 15 238, Mandrage 14 539,
Wohnout 13 555, Olympic 5 071, Mig 21 4 430, Kryptor 148.

Změřeno: **7 z 10 dotazů změnilo výsledek k horšímu** — „Chinaski" vracel kartu
interpreta, nově vrací skladbu „Potkal jsem tě po letech". To je přesně ta vada,
kterou měl bod B3 opravit, jen otočená proti domácí hudbě.

**Oprava:** absolutní práh zrušit. V modulu **už existuje** mechanismus, který
tohle řeší relativně — `_ARTIST_DOMINANCE_SAMPLE` / `_ARTIST_DOMINANCE_MIN`
(kolik z běžných výsledků už tomu interpretovi patří). Použij ten: přesná shoda
jména vyhraje, když mu zároveň patří dost výsledků na stránce.

**Kalibrace je povinná a měřená:** sada musí obsahovat aspoň pět českých
interpretů z výčtu výše (u nich MUSÍ vyhrát interpret) a dotazy „creep",
„bohemian rhapsody", „one more time", „hurt", „yesterday" (tam MUSÍ vyhrát
skladba). Výsledek obou skupin napiš do evidence jako tabulku.

### R6.2 — u iTunes a YouTube Music je brána trvale zavřená

Jejich mapery klíč `fans` vůbec neskládají, takže `named.get("fans", 0)` je vždy
0 a podmínka nikdy neprojde: karta interpreta zmizí z top výsledků **úplně**, a to
i pro Metallicu a Queen. Týká se to i uživatele s Deezerem, protože
`_DEFAULT_FALLBACK["deezer"] == "ytmusic"`.

**Oprava:** brána se smí uplatnit jen tam, kde to číslo existuje. Když provider
velikost nepublikuje, chovej se jako dřív.

---

## B. Celek 5 — mazání a hrdinka

### R5.1 — „Remove from playlist" posílá holý index (BLOKUJÍCÍ)

Změna přepnula mazání z `remove-by-name` na `DELETE /tracks {indices:[i]}`.
Backend u `remove-by-name` playlist **znovu načte** a index použije jen tehdy,
když na něm pořád sedí jméno a interpret; jinak spadne na shodu podle jména a
nenajde-li nic, vrátí 404. Nová cesta jde rovnou na Subsonic `songIndexToRemove`.

Doloženo: když se pohled rozejde se serverem (druhé zařízení přeskládalo playlist),
**smaže se jiná skladba**. Agent to změřil s destruktivními voláními zachycenými
a abortovanými, produkce zůstala nedotčená.

**Oprava:** vrátit se na `remove-by-name` a poslat do něj i index
(`{ name, artist, index }`) — backend to umí a duplicity řeší přesně. Index z dat
(`currentLibPlaylistTracks.indexOf(item)`) zůstává, mění se jen endpoint.

### R5.2 — Shuffle zabral místo, kam šla svalová paměť pro „přidat"

Pořadí bylo `[Play All][+ Add All][Edit]…`, nově je `[Play All][🔀 Shuffle][⋯]`.
Na druhé pozici, kam uživatel sahal pro **additivní** akci, je teď akce, která
přes `playTracks` **zahodí celou rozpracovanou frontu** a začne hrát. Agent to
změřil: fronta o šesti položkách byla po kliknutí pryč.

**Oprava, vyber jednu a zdůvodni:** (a) nechat na druhé pozici „+ Add All" a
Shuffle dát za něj nebo do ⋯; (b) před přepsáním **neprázdné** fronty se zeptat
(`showConfirmModal`, který dávka zavádí jinde).

### R5.3 — díry v kontrolách, které přežily mutace

- **K6 nehlídá křížek u řádku ani zrušení potvrzení.** Mutace „křížek předá index 0
  místo indexu své karty" i „`if (!ok) return;` pryč, takže Cancel stejně maže"
  **obě prošly zeleně**. Doplň K6b (klik na `.lib-track-remove` u druhého řádku →
  odeslané `indices` jsou přesně `[1]`, a jen jednou) a K6c (klik na Cancel →
  neodešlo nic).
- **K17 měří nativní `confirm` jen ve stahovacím dialogu.** Mutace, která vrátila
  nativní `confirm()` do `podcasts.js`, prošla — přitom evidence uvádí osm
  opravených míst. Doplň kontrolu nad podstrčeným `/api/podcasts`.

### R5.4 — `handed_off` není mrtvý kód (artefakt izolace)

Adversariální dráha hlásila, že příznak v backendu neexistuje. **Ověřeno vedením:**
celek 6 ho přidal (`jobs.py:41`, `downloader.py:749`) a `to_dict()` ho **vydává**;
`to_history()` ho vypouští **záměrně**, aby starší image neshodil celou historii.
Důsledek, který platí a patří do evidence: **job obnovený z historie po restartu
kontejneru ukáže DONE, ne „Sent to Lidarr"**. Je to přijatá mez, ne vada.
Ověří se nad spojeným stromem.

---

## C. Celek 4 — hrdinka a diskografie

### R4.1 — D2 je na hlavní cestě regrese, ne oprava

`setArt(…, o.image || '')` a `textContent = o.name || ''` běží **bezpodmínečně**
před fetchem. Tři ze čtyř volajících ale posílají třetí argument jako **řetězec**
(`search.js:106`, `contextmenu.js:639`, `fullplayer.js:256`), takže `o.name` i
`o.image` chybí a hrdinka se **vyprázdní**. Na nasazené verzi tam přitom po dobu
~470 ms zůstávalo jméno a obrázek předchozího interpreta — tedy **lepší** stav.

Změřeno na pomalé síti (+5 s na `/api/artist/**`), telefon, 1,5 s po kliknutí:
worktree `{name:"", count:"", imgSrc:"PRÁZDNÝ"}` proti produkci
`{name:"Queen", count:"85 albums"}`.

**Oprava:** vykreslit jen to, co volající skutečně poslal — `if (o.name !== undefined)`,
`if (o.image !== undefined)`. A v evidenci opravit větu, která tvrdí, že se
chování ostatních cest nemění; mění.

Doplnění zbylých tří volajících (aby posílali objekt) udělá **vedení při merge** —
`search.js` i `fullplayer.js` už jsou v mainu a `contextmenu.js` patří celku 5.

### R4.2 — u iTunes zmizí celá sekce Albums

`_isFullAlbum` vyžaduje `record_type == "album"`, jenže `itunes_get_artist_albums`
to pole vůbec neskládá. Uživatel s Apple Music jako zdrojem (nebo jako fallbackem)
dostane **prázdnou sekci Albums** a celou diskografii včetně „A Night At The Opera"
pod nadpisem „Singles and EPs". Změřeno: `?provider=itunes` → 96 alb,
`record_type` chybí u všech 96.

**Oprava:** degradovat bezpečně — když **žádné** album v odpovědi `record_type`
nenese, nedělit vůbec a vykreslit všechno do jedné mřížky. Rozdělení má smysl jen
tam, kde zdroj druh vydání skutečně publikuje.

---

## D. Co se potvrdilo jako správné

- **Hrdinka na tabletu nepřetéká.** Měřeno na všech čtyřech hrdinkách a ve všech
  třech rozlišeních: `doc+0 hero+0`, info 894 px (desktop) / 718 (tablet),
  obal 180 px. Čísla 1027/1167 z dodatku po kritice byla měřením **naivní**
  varianty, ne nasazeného stavu — v dodatku to bylo napsané správně.
- **Kontrola hrdinky knihovního playlistu zezelenala hned, bez K8** — akce mají
  vlastní řádek a samy se zalamují, takže sedmé tlačítko spadne pod ostatní místo
  aby hrdinku roztáhlo. Dodatek čekal opak; vedení to při merge nemusí hlídat.
- **Rozdělení diskografie** Daft Punk: 15 + 24, přesně podle očekávání z dodatku.
- **Hlavička alba**: „Album · 2013 · 13 songs, 1 hr 14 min".

## E. Pro vedení při merge

- `search.js:106`, `fullplayer.js:256` a `contextmenu.js:639` mají posílat objekt
  `{ provider, name, image }` (data mají v ruce).
- Celek 6 má ve stromu netrackovaný `scratchpad/` — **necommitovat**.
- `.type-toggle` (D10, taby na dvou řádcích) je v `search.css`, tedy soubor vlny 1.
  Zbývá jako samostatný bod.
