# Předávka — dávky oprava-2 a oprava-3 (18. 10. 2026)

Dvě dávky běžely paralelně ve workflow: 11 agentů, ~1,22 M tokenů, 34 minut.
Autoři v oddělených worktree, nesdíleli ani jeden soubor.

## Co se stalo nejdřív: hradlo chytilo cizí commit, ne dávku

Adversariální dráha dvojky vrátila BLOCKER: přestavba `index.html` z partialů prý
tiše smazala funkci „Popular" na stránce interpreta. **Ověřil jsem to sám a nález
je pravdivý, ale jeho přičtení ne.**

`9f024f0` (17. 10. 23:15, jiná session, identita `lukashanak@gmail.com`) přidal
funkci **přímou editací `static/index.html`**, mimo partialy. Od té chvíle byl
`check-index.sh` na `main` ČERVENÝ a nikdo si toho nevšiml, protože
**`core.hooksPath` v tomhle klonu nebyl nastaven** — přesně past, před kterou
CLAUDE.md varuje a kvůli které existuje značka `GENERATED FILE` na ř. 2.

Autor dávky tedy udělal správnou věc (spustil `build-index.sh`) a ta správná věc
cizí ruční editaci vrátila zpátky.

Řešení: devět řádků portováno do `frontend/partials/30-search.html` (`b51efdd`).
Přestavba pak dává `index.html` **bajtově shodný** s tím, co commit `9f024f0`
obsahoval. Hradlo aktivováno (`git config core.hooksPath .githooks`) a hned při
dalším commitu zafungovalo — zastavilo commit ve worktree trojky, který tu opravu
ještě neměl.

**Poučení:** dávka 1 postavila hradlo, ale nechala jeho aktivaci na člověku. Mezi
dávkou 1 a dnes se do `index.html` stihla dostat ruční editace. Značka na ř. 2
sama nestačila.

## Oprava 2 — BPM jen pro stažené skladby

Zadání prošlo kritikou s verdiktem **přepracovat**; dodatek po kritice zrušil
původní body B1–B4 a nahradil je B1′–B4′. Důvod: hradlovat klienta na
`item.inLibrary` nešlo — ten příznak žije jen v DOM, backend ho nezná
(`grep -rn inLibrary app/` → nula) a chybí právě tam, kde je vlastnictví jisté.
Nasazené v původní podobě by BPM nezlepšilo, ale **vyplo**.

Zdrojem pravdy je tedy server. Endpoint odpovídá `200 {"owned": false}` a nespouští
nic; obě strany si odpověď pamatují (300 s server, 10 min klient); dokončené
stažení klientovu paměť maže. DJ panel a fronta přestaly předstírat, že Smart Queue
pracuje, když na to nemá data.

Dráhy vrátily 19 nálezů (1 blokující, 2 vysoké, 5 středních, zbytek nízké). Kolo 2
zavřelo 13, jeden odmítlo vědomě (`owned:True` u položek playlistu zůstal jako
informativní, nic na něm nehradluje).

## Oprava 3 — zápis tagů do souboru, který se streamuje

Vzniklo vyčleněním z „K ověření" dvojky, kde to kritika potvrdila a ukázala, že
moje podezření mířilo na **nepoužívanou** větev (`ms-nav-cache`), zatímco riziko
leží v té jediné používané (skutečný soubor v `/music`).

Autor to nevyřešil zámkem, ale **změnou způsobu zápisu**: tagy se uloží do kopie
a ta soubor nahradí přes `os.replace`. Běžící `FileResponse` drží starý inode
a dočte původní bajty. Navíc se zápis úplně vynechá, když se žádná hodnota
nezměnila — tím přestal každý běh analýzy zahazovat MP3 transkód (klíč je
`sha1(abspath + mtime)`).

Stráž `_served_to_player` **není vyčerpávající** a autor to napsal do docstringu
místo aby to zakryl: lokální `.mp3` a `quality=lossless` se servírují bez pinu.
Kryje je ten atomický replace.

## Čísla

    pytest na main po merge        78 passed, 3 skipped   (před dávkami 48 + 3)
    node --test (po souboru)       10 pass, 0 fail
    check-index.sh                 exit 0
    AI stopy v 4cf0c7d..HEAD       žádné
    placená volání                 0

`node --test tests/js/` (adresář) na Node v22.23.2 **nefunguje** — `MODULE_NOT_FOUND`.
Musí se předat cesta na soubor. Nález dráhy, opraveno v hlavičce testu.

## Co zůstává otevřené

- **Nic z toho neběželo proti živé ani lokální instanci.** Testy jsou `TestClient`
  s nahrazenou analýzou a node se stubem `fetch`. Přejímka proti běžící aplikaci
  (síťové počítadlo, DJ mode, odznak ve frontě) **se nekonala**.
- Posun offsetů byl změřen jen na MP3 s nedostatečným paddingem. Jestli k němu
  u produkčních FLAC souborů vůbec docházelo, **nikdo nedoložil** — dávka
  odstraňuje souběh, ne změřený symptom. Tak je to i v docs.
- Nízké přeživší mutace: `copy2` → `copyfile` (nehlídá zachování práv),
  `force=true` nezapisuje do negativní cache (bez testu).
- Negativní cache je per-proces; skladba stažená během TTL se až 5 minut tváří
  jako nestažená.
- `POST /lookup-by-name?analyze=true` a sken playlistu negativní cache nevyužívají.

## Nenasazeno, nepushnuto

Čtyři commity sedí na `main`. Push ani nasazení nebyly odsouhlasené.

---

# Přejímka (18. 10. 2026, po nasazení 12:31) — 0 placených volání

Nasazeno přes compose, `builder prune -af` uvolnil 1,72 GB (disk 49 %).
Měřeno proti `http://192.168.1.22:8090` účtem `claude_test`.

## Oprava 2

| co | výsledek |
|---|---|
| nestažená skladba (`Stan`, `Lithium`, `Godzilla`) | `200 {"owned": false}` — dřív 404 |
| první dotaz / druhý dotaz na tutéž | **0,746 s → 0,0017 s** (negativní cache, ~440×) |
| stažená skladba s BPM (`Without Me`) | 200, bpm 112.3, key G minor, beat grid 556 bodů |
| 404 z `/api/bpm/track` za 15 min provozu | **0** |
| vyhledání interpreta + otevření stránky v prohlížeči | **0 požadavků na `/api/bpm/track`** |
| fronta 10 skladeb | 10 dotazů, **0 opakovaných** |
| odznaky ve frontě | `no BPM` u nestažených, `112` / `85` / `86` u tří, které BPM mají |
| `pageerror` | žádný |

Ty tři čísla sedí přesně na záznamy, které byly v `bpm_analysis.json` **před**
dávkou (`eminem::without me` 112.3, `eminem::mockingbird` 85.0,
`eminem::till i collapse` 86.0). Nic se nepřepočítalo, jen se přestalo ptát.

## Oprava 3 — ostrý test zápisu pod běžícím streamem

Skladba bez záznamu v cache (`Adele – He Won't Go`, 58 374 243 B), aby analýza
opravdu **zapsala tagy**, ne jen přeskočila.

    stream spuštěn (lossless, raw FLAC, škrcený na 700 kB/s)
    po 3 s a 11 124 736 B staženo  ->  spuštěna první analýza
    analýza:  HTTP 200, 44,98 s   mtime 1774168236 -> 1792326961  (zápis PROBĚHL)
    stream:   HTTP 200, 73,25 s   staženo 58 374 243 B = PŘESNĚ velikost souboru

    flac -t na stažené kopii      ok   (MD5 dekódovaného zvuku ze STREAMINFO sedí)
    flac -t na originálu na disku ok

Tedy: tagy se do souboru zapsaly **uprostřed běžícího Range streamu** a stream
přesto dojel celý a bajtově nepoškozený. To je důkaz B1 — běžící `FileResponse`
drží starý inode a `os.replace` mu ho nesebere.

Druhý test, B2: vynucená analýza už otagovaného souboru
(`AK – Wanderlust`) — `mtime` i velikost **beze změny**, takže MP3 transkód
zůstal platný.

## Co přejímka NEOVĚŘILA

- **Zda k posunu offsetů vůbec kdy docházelo.** `He Won't Go` má dost paddingu,
  takže velikost se nezměnila ani teď. Test dokládá, že zápis pod streamem
  neuškodí; nedokládá, že dřív škodil.
- Chování při souběhu dvou analýz téhož souboru (zámek je jen v procesu).
- DJ přechod mezi dvěma skladbami bez BPM naživo — odznak ano, mix ne.
- `POST /lookup-by-name?analyze=true` a sken playlistu.
