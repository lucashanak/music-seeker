# Přejímka — oprava 5 (UX audit, vlna 2), v1.27.0 → 1.27.1

22. 10. 2026, proti běžící instanci, účet `claude_test`, tři agenti paralelně,
tři rozlišení. Rozpočet placených volání: **žádná**.

| oblast | potvrzeno | nepotvrzeno | neprovokováno |
|---|---|---|---|
| detail interpreta a alba | **14** | 2 | 1 |
| knihovna a stahování | **19** | 1 | 1 |
| backend | **10** | 0 | 0 |

## Backend — nejdůležitější měření dávky

`R6.1`: **11 z 11** interpretů vrací kartu interpreta a **7 ze 7** písní vrací
skladbu; všech 18 dotazů **stabilních při dvou bězích**. Tedy i Chinaski,
Olympic, Mig 21, Wohnout a Yzomandias — ti, které absolutní práh z prvního kola
vyřadil.

`B1`: 22 dlaždic žánrů, **všechny anglicky**.
`B2`: interpreti se u čtyř žánrů liší od regionálního žebříčku a jsou odvození ze
skladeb daného žánru.
Podcasty přes iTunes a `type=episode` vracejí 200 — **český obchod je nerozbil**.

## Vada, kterou přejímka našla a která je už opravená (1.27.1)

**„+ Add All" v knihovním playlistu zapisoval playlist sám do sebe.** Tlačítko
přijalo otevřený playlist jako aktivní a `addToQueue` zrcadlí, co zařadí, **do
aktivního playlistu** — takže se skladby vracely tam, odkud přišly. Agent klikl
třikrát a fixtura vyrostla ze 6 na **48** skladeb.

Opraveno: zařazení do fronty už aktivní playlist nemění, zrcadlo míří do Up Next.
Ověřeno na nasazeném buildu s abortovanými zápisy — otevřený playlist
`5KcTxC0EIaFDzBkTkuklN8`, cíl zápisu `3t5K6tdIcsC7TTOEPEoPGJ` (Up Next):
**do sebe nepíše**. Fixtura srovnána zpátky na 4 skladby.

Zároveň: řádkové menu nabízelo „Add to playlist" přímo nad „Add to other
playlist…" a jen to druhé opravdu přidávalo do playlistu. První se teď jmenuje
**„Add to queue"**.

## Dvě „nepotvrzení", která jsou chybou kritéria, ne kódu

1. **Hrdinka interpreta na telefonu** — kritérium `.playlist-hero-info > 120 px`
   neprošlo (98 px u Daft Punk, 68 px u Queen). Prohlédl jsem snímek: portrét je
   na vlastním řádku, pod ním velké jméno, počet alb a akce — **přesně tvar
   mobilní stránky interpreta na Spotify**. Kritérium bylo psané pro rozložení
   vedle sebe a na zalomené verzi měří jen šířku textu. Vada to není.
   (Druhý případ téže chyby v této dávce; první byl N13 ve vlně 1.)
2. **K5 pro menu jedné skladby** — popisky „Add to playlist" / „Add to other
   playlist…". Platný nález, **opraven v 1.27.1** (viz výš).

## Neprovokováno

- `D5` větev bez délek (album, kde některé skladbě chybí `duration_ms`).
- Křížek u řádku na telefonu — pod 640 px je záměrně skrytý, jediná cesta je ⋯.

## Co zůstává otevřené

- `D10`: záložky hledání jsou na telefonu pořád ve **dvou řádcích**
  (`.type-toggle` v `search.css`, soubor vlny 1).
- Žánrový žebříček: pole `albums` u Rocku a Rap/Hip Hopu pochází z regionálního
  žebříčku. Zadání to povolovalo („alba zůstávají"), ale původní nález B2 tím
  není celý vyřešený.
- iTunes vrací u „creep" cover (Kina Grannis) místo Radiohead — dělá to větev
  „přesná shoda názvu skladby". Typ karty je správný, interpret ne.
- `ITUNES_COUNTRY = 'CZ'` je natvrdo. Pro instanci mimo Česko je to špatná volba.

## Disk

Před vlnou 2: 47 %. Po nasazení 1.27.0, 1.27.1 a `builder prune -af`: **49 %**.
