# Předávka — dávky oprava-4 a oprava-5 (UX audit), 21.–22. 10. 2026

Vedoucí session řídila, agenti pracovali. **46 agentů, ~7,5 M tokenů, dvě vlny,
dvě přejímky, 1.25.2 → 1.27.1.**

## Odkud se vzalo zadání

Čtyři agenti prošli 21. 10. celou aplikaci proti produkci — četli kód a pak ji
**opravdu proklikali** na desktopu, tabletu i telefonu, u přehrávače se
skutečnými dotykovými událostmi. Vrátili **97 nálezů**
(`notes/impl/audit-2026-10/`). Ty se rozdělily do dvou vln po třech celcích,
které spolu nesdílely soubor.

## Co se naučilo o metodice

### 1. Kontrola, která si do stránky vloží náhradu, měří tu náhradu

Nejdražší poučení dávky. Autoři vlny 1 psali zelenou polovinu orákula tak, že do
živé stránky vložili vlastní posluchač. Dvě review dráhy na to přišly **nezávisle
na sobě**: u jednoho celku nebyl v souboru kontrol **jediný odkaz na kód ze
stromu**, takže žádná změna v něm nemohla kontrolu zčervenat a **13 mutací
autorova kódu zůstalo neviditelných**. U druhého celku se režim se záplatou na
produkci vůbec nespustil — syrové soubory nemají cache-bust razítko, moduly se
načetly podruhé a stránka běžela se **dvěma instancemi** `store`/`queue`/`player`.

Řešení je v `tests/e2e/audit/helpers.mjs`: `open({ worktree })` naservíruje
stránce **skutečné soubory ze stromu** včetně `index.html` a dorazítkuje je.
Od vlny 2 to bylo v zadání od začátku.

### 2. Tři rozlišení, protože tablet na šířku je past

`phone` 390x844, **`tablet` 1024x768**, `desktop` 1280x900. Tablet leží **nad**
breakpointem 640 px, takže dostane desktopová pravidla (ovládání odkryté až při
hoveru) na zařízení, které hover nemá. Několik nálezů se schovávalo přesně tam.

### 3. Adversariální dráha bez zadání se vyplatila potřetí

Nálezy, které obě dráhy se zadáním minuly: mazání podle holého indexu smaže cizí
skladbu, Shuffle zabral místo additivní akce a zahodí frontu, hrdinka se na
pomalé síti vyprázdní (a produkce je na tom **lépe**).

### 4. Vedení se mýlilo třikrát a pokaždé to chytil někdo jiný

- **Kritika** vyvrátila premisu „8 z 10 interpretů je bez obrázku" — mají ho
  všichni, šedé jsou zástupné adresy. A premisu „titulek modálu neposlouchá
  přepínač" — poslouchá.
- **Autor** doložil, že moje kontrolní tvrzení k S6 **nejde splnit pravidlem,
  které týž dodatek nařizoval**.
- **Autor c6** ukázal, že moje diagnóza „iTunes ztrácí interprety kvůli dělení
  creditu" platila **jen z poloviny**: u „olympic" je vlastnictví 0/16 po
  jakémkoli dělení, protože **iTunes odpovídá za americký obchod**. Po přepnutí
  na český 14/16.
- Dvakrát jsem napsal **přejímkové kritérium obráceně** (N13: vyšší průhlednost
  je ta správná; hrdinka na telefonu: `info > 120 px` neplatí pro zalomené
  rozložení).

### 5. Co se měří, se nehádá

Autor c6 nehádal oddělovače spojeného creditu — **změřil 839 creditů z 18 dotazů
u tří providerů**. Čárka a ampersand jsou jediné, které se vyskytují; `feat.`,
`ft.`, `x`, `with` mají **nulu**. Mutaci přidávající neexistující oddělovače
nechal v sadě **záměrně zelenou jako past**.

## Co se nasadilo

**1.26.0 (vlna 1):** Zpět dělá jeden krok a čistí vrstvy; dialogy mají vlastní
vrstvu historie a vracejí svůj Promise; fronta neblokuje přehrávač; shuffle hraje
v pořadí, které ukazuje; konec fronty doplní doporučení **do** fronty za
oddělovač; odhlášení je na telefonu dosažitelné a zastaví zvuk; vyhledávání
nehledá za překryvem a výpadek providera se přizná.

**1.27.0 (vlna 2):** hrdinka je řada akcí pod titulkem a obal má rozumnou
velikost; diskografie se dělí na alba a singly (a nedělí se tam, kde provider typ
nehlásí); hlavička alba počítá délku; knihovna nezačíná jednou obří dlaždicí;
mazání z playlistu posílá jméno i index; karta interpreta vyhrává podle toho,
kolik stránky mu patří, ne podle absolutního počtu fanoušků; iTunes odpovídá za
český obchod.

**1.27.1:** oprava vady, kterou našla přejímka — „+ Add All" zapisoval playlist
sám do sebe (6 → 48 skladeb).

## Čísla

| | vlna 1 | vlna 2 |
|---|---|---|
| kola autorů | 2 | 2 (celek 6 tři) |
| review drah | 9 | 9 |
| otisk stromu seděl | 9/9 | 9/9 |
| sada po merge | 82 passed, 3 skipped | **109 passed, 3 skipped** |
| přejímka | 55 potvrzeno, 1 chyba kritéria | 43 potvrzeno, 1 vada (opravena) |

## Co zůstává pro další dávku

1. `.type-toggle` je na telefonu dvouřádkový (`search.css`).
2. Žánrový žebříček: `albums` u některých žánrů pochází z regionálního.
3. iTunes vrací u „creep" cover místo Radiohead (větev přesné shody názvu).
4. `ITUNES_COUNTRY` je natvrdo `CZ`.
5. Délka skladby u Liked Songs — chybí `duration_ms` v uložených lajcích.
6. Skutečná procenta z yt-dlp (vyžaduje přepsat sdílený `_run` na streamování).
7. `/api/search` nevrací `errors`, takže jednotypové taby při výpadku mlčí.
8. Kontextové menu (`z-index 10000`) nezakládá vrstvu historie.
9. Party relace po zavření překryvu běží dál bez indikátoru.
10. `store._ignorePopstate` je booleovský proti rostoucímu počtu vrstev.
11. Shuffle tiše vypíná Smart Queue (nález #19 reportu přehrávače).
12. Devět děr v kontrolách, které přežily mutace — vypsané v ověřovacích kolech.

## Past, na kterou narazí příští session

Pravidla, která teď platí napříč kódem, jsou v **CLAUDE.md**, sekce „UX audit a
dávky oprava-4 / oprava-5": viditelnost vrstvy přes `offsetParent` (s výhradou
`position: fixed`), každý překryv zakládá vrstvu historie, `push` místo `concat`
u `store.playerQueue`, `data-qi` zůstává indexem do fronty, zástupný obrázek se
pozná podle tvaru adresy.

**Testovací fixtura:** `zz-audit-fixture` na účtu `claude_test`, 4 skladby.
Číst, nemazat. Po přejímce vlny 2 má nové id, protože ji bylo nutné znovu
založit.
