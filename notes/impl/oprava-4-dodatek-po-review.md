# Oprava 4 — Dodatek po review

**Přednost:** tenhle dodatek > dodatek po kritice > zadání.

Devět drah (tři celky × kód / testy / adversariální). **Otisk zamrazeného stromu
seděl u všech devíti** — review je platné. Souhrn verdiktů:

| celek | kód | testy | adversariální |
|---|---|---|---|
| c1 vyhledávání | přijmout s výhradami | **vrátit** | **vrátit** |
| c2 přehrávač | **vrátit** | **vrátit** | **vrátit** |
| c3 navigace | přijmout s výhradami | přijmout s výhradami | **vrátit** |

---

## A. Společné pro všechny tři celky: orákulum měřilo náhradu, ne opravu

Dvě dráhy na to přišly nezávisle a je to nejzávažnější nález celé dávky.

Kontroly se zezelenaly tím, že si do živé stránky vložily **vlastní náhradní
posluchač nebo přepsaly DOM**. Nic z nich nečetlo autorův kód: dráha testů u c1
nahlásila, že `search.mjs` nemá jediný odkaz na soubor ze stromu, takže
**žádná změna v `search.js` ani `search.css` ho nemohla zčervenat** — a všech
13 jejích mutací autorova kódu zůstalo pro autorovy kontroly neviditelných.
U c2 navíc režim `--patched` na dnešní produkci **vůbec neběžel**: syrové soubory
z worktree nemají cache-bust razítko, takže se moduly načetly podruhé pod jinou
adresou a stránka běžela se **dvěma instancemi** `store`/`queue`/`player`;
všechny tři viewporty skončily na první kontrole timeoutem.

**Vedení postroj opravilo.** `tests/e2e/audit/helpers.mjs` umí nově
`open({ worktree: '<cesta>' })` a `serveWorktree(context, root)`: stránce se
naservírují **skutečné soubory ze stromu**, včetně `index.html`, a doplní se jim
razítko přečtené z živé stránky (přesně to, co dělá `entrypoint.sh`).
Ověřeno: produkce hlásí `lang=cs`, worktree `lang=en`; `toast.css` se načte;
`router.js` obsahuje `LAYER_IDS` i `offsetParent`; přihlášení projde bez chyb.

**Povinné pro všechny tři autory:**
1. Přepsat kontroly tak, že **zelenou polovinu dělá `open({ worktree })`**, ne
   `page.addInitScript` / `page.evaluate` s náhradou. Červená polovina zůstává
   proti produkci (`open()` bez `worktree`).
2. Každý bod znovu změřit. Co se tím rozpadne, je skutečný nález — oprav ho.
3. Kde zelená bez náhrady doložit nejde (hover, přehrání zvuku), napiš to jako
   **mez** a nech to na přejímku. Nevyrábět náhradu a nevydávat ji za důkaz.

---

## B. Celek 1 — Vyhledávání

### R1.1 — „No results for X" vyskakuje nad správnými výsledky (vysoká)

Test „žádná položka nesdílí s dotazem normalizované slovo" **vyhodnotí překlep
jako nenalezeno**. Změřeno na živé instanci s novým kódem: `artist/"beyonse"` →
18 karet, první je Beyoncé s odznakem IN LIBRARY, a nad tím pruh
„No results for beyonse". Totéž `album/"thriler"` (první Thriller) a
`all/"michaell jacksonn"` (hrdinka Thriller / Michael Jackson).
Diakritika to zhoršuje: `_normName` shodí háčky z výsledku, ale **ne z dotazu**.

Oprava: hlášku ukazovat **jen když zároveň platí**: (a) žádná položka nesdílí
s dotazem prefix délky 4 u kteréhokoli slova, (b) odpověď nemá `top`.
Normalizovat **obě** strany týmž `_normName`.
Kontrola: „beyonse", „thriler" a „michaell jacksonn" pruh **nemají**;
„zzzqqqxyznotathing12345" ho má.

### R1.2 — částečný výpadek s prázdnou větví tracks skončí na „No results found" (vysoká)

`_sectionErrorStrip` se staví, ale větev „nic nenalezeno" se ptá jen na délky polí.
Když spadnou tři větve ze čtyř a čtvrtá legitimně vrátí prázdno, **fragment se
zahodí** — bez proužku, bez Try again, bez stopy po výpadku. To je přesně stav,
který měla oprava odstranit. Změřeno: `strips=0, retry=0, cards=0`.

Oprava: do podmínky prázdna přidat `!Object.keys(errors).length`. Kdykoli je
`errors` neprázdné, vykreslit fragment s proužky, i když v něm nic jiného není.

### R1.3 — S5 se ověří až nad spojeným stromem (není chyba autora)

Dráha testů i adversariální hlásily S5 jako blokující („`closeGenre` nikdo nevolá").
**Je to artefakt posuzování celku v izolaci** — větev `store.genreOpen` je bod N14
a celek 3 ji **má hotovou** (ověřeno v jeho odevzdání i v diffu). Ve spojeném
stromu to drží.
Povinné: v **ověřovacím kole** se S5 a N14 měří nad **spojeným** stromem, který
připraví vedení. Do té doby zůstává červená a je to v pořádku.

### R1.4 — S6 — formulace dodatku byla nesplnitelná (přijato)

Autor doložil, že tvrzení „žádná z prvních pěti karet nemá zástupnou adresu"
nejde splnit pravidlem, které týž dodatek nařizuje: po filtru „zástupná adresa
**a zároveň** čárka" zbydou položky se zástupnou adresou **bez** čárky
(„Daft Punk - Stardust", „Made famous by Daft Punk", „Daft Punk's Karaoke Band").
**Chyba vedení v předchozím dodatku.** Platí autorova formulace: 0 duplicit,
0 credit-entity, první karta se skutečným obrázkem (zahozeno 8 z 16).

### R1.5 — drobnosti k dotažení

- `store.genreOpen` chybí deklarace ve `store.js` (není ničí soubor) — **doplní
  vedení při merge**, autor na to nesahá.
- Dedupe neběží napříč stránkami nekonečného scrollu — přijato jako mez.

---

## C. Celek 2 — Přehrávač a fronta

Tři blokující/vysoké nálezy jsou **skutečné vady v chování**, ne v kontrolách.

### R2.1 — Previous v autoplay ocasu skladbu restartuje a další Next zahraje týž tip znovu (blokující)

V autoplay ocasu vezme `prevTrack()` větev `if (m.isPlayingRec())`, která jen
znovu načte **aktuální** index. Previous tedy restartuje místo návratu — a běží
s `keepRec=false`, takže `stopRecPlayback()` shodí kurzor doporučovače.
Následující Next pak **zahraje tentýž tip znovu a zapíše duplicitu do fronty
uživatele**. Změřeno na živé instanci.

Oprava: v autoplay ocasu se Previous chová jako běžná navigace ve frontě
(`store.playerIndex--; loadAndPlay()`), a `loadAndPlay` běží s `keepRec=true`,
aby `stopRecPlayback()` kurzor neshodil.

### R2.2 — Previous se zapnutým shuffle nedělá vůbec nic (vysoká, REGRESE)

Nová větev `else if (store.shuffleEnabled && …)` nemá `else` a je **před** původní
větví `store.playerIndex > 0`. Dokud je `_shufPlayed` prázdné — tedy hned po
zapnutí shuffle **a po každém načtení stránky**, protože je to paměť modulu —
vrací `shufflePrev()` null a Previous je mrtvé tlačítko. Nově přidaná persistence
shuffle to **zhoršuje**: po reloadu je shuffle zapnutý, historie prázdná.
Na nasazeném kódu Previous funguje, takže je to regrese.

Oprava: záložní cesta — když permutační historie nic nemá, chovat se jako původní
lineární Previous.

### R2.3 — ve shuffle rozbije smazání nebo přetažení řádku pořadí celého zbytku fronty (vysoká)

`_reshuffleTail` se přepočítá jen při změně **délky**. Smazání řádku → celý ocas
se znovu zamíchá a historie ukazuje po posunu indexů na jiné skladby (změřeno:
z 49 zbylých řádků je téměř každý jinde). Přetažení délku nemění → reshuffle
neproběhne, ale indexy se posunou.

Oprava: invalidovat permutaci při každé změně **obsahu**, ne jen délky — držet ji
nad identitou položek, nebo volat `resetShuffleOrder()` z `_moveQueueItem` i
z obou mazacích cest.

### R2.4 — lišta a panel fronty zůstanou nad velkým přehrávačem (vysoká)

Třída `queue-open` se snímá výhradně v `closeQueuePanel`. Oprava ale lištu
zároveň zpřístupnila nad backdropem — klepnutí na obal otevře velký přehrávač a
`openFullPlayer()` panel fronty nezavírá. Lišta (250) i panel (250) pak zůstanou
**nad** velkým přehrávačem (201): uživatel vidí dva přehrávače přes sebe.
Snímek v dokladech.

Oprava: v `openFullPlayer()` zavřít malý panel fronty, nebo třídu `queue-open`
snímat i při otevření velkého přehrávače.

### R2.5 — příznak autoplay není vázaný na volajícího (vysoká)

Mezi `_autofillFromRecs()` a doručením skladby je síťová obrátka. Klepne-li
uživatel v tom okně na řádek v panelu doporučení, `playRecIndex` spotřebuje
`_autofillPending` jako první: **uživatelem vybraná skladba se připne do fronty**
za oddělovač „Autoplay", a skladba doporučovače už příznak nenajde.

Oprava: příznak nastavovat až z `.then(filled => { if (filled) … })`, tím se okno
zkrátí ze síťové obrátky na jeden mikroúkol.

### R2.6 — vady v samotných kontrolách

- **P12** zavírá ctx-menu klávesou Escape, což zavře i velký přehrávač; pod
  servírovaným kódem pak **devět dalších kontrol vůbec neběželo**. Zavírat klikem
  mimo menu a doplnit tvrzení „velký přehrávač je pořád otevřený".
  Zároveň rozhodni a napiš: **má Escape nad ctx-menu zavírat přehrávač?**
- **P2.a** neměří to, co má. Porovnává pozice až **po** přeskoku, takže mutace,
  která při každém vykreslení znovu zamíchá ocas, projde zeleně — a to je přesně
  původní vada z auditu. Oprava: před každým Next si zapamatovat titulek řádku
  „next" a po Next ho porovnat s tím, co hraje; a dvakrát překreslit panel a ověřit,
  že je pořadí ocasu stabilní.

---

## D. Celek 3 — Globální navigace

Kód i testy: přijmout s výhradami, žádný blokující. Jeden skutečný nález:

### R3.1 — Zpět zavře stránku POD otevřeným dialogem (vysoká)

Dialogy, které se **neregistrují** do `store.dialogStack` (dialogy v Nastavení,
import playlistu), leží vizuálně nahoře (`z-index: 200`), ale jejich kontrola se
přesunula **pod** osm větví detailů. Uživatel má otevřený detail, nad ním dialog,
stiskne Zpět → zavře se **detail vzadu**, stránka se přepne a dialog zůstane viset.
Je to v přímém rozporu s komentářem o pár řádků výš. Změřeno na 390x844.

Oprava: kontrolu `.modal-overlay:not(#downloadModal)` vrátit **nad** bloky detailů
(větev `store.dialogStack` zůstává první), nebo zbývající překryvy dotáhnout do
`dialogStack` a ruční `querySelector` zrušit. Vyber a zdůvodni.

### R3.2 — smazané `.recent-*` CSS (ověří se nad spojeným stromem)

Adversariální dráha naměřila, že po smazání pravidel se čipy vykreslí jako
systémová tlačítka přetékající za okraj. **Je to artefakt izolace** — čipy ruší
celek 1 a ve spojeném stromu už se nevykreslují. Povinné: ověřit **nad spojeným
stromem** v ověřovacím kole. Zbylý nepoužitý `#recentSearches` v
`30-search.html` je partial vlny 2 → **nález pro další dávku**.

---

## E. Co se po druhém kole stane

Po „stop" všech tří autorů připraví vedení **spojený strom** a ověřovací kolo
(dráha testů) nad ním změří: S5 + N14, `.recent-*`, a mutace, které v prvním kole
přežily. Teprve pak commit, jeden build a přejímka.

## F. Nové nálezy pro další dávku

- `#recentSearches` v `30-search.html` zůstane nepoužitý.
- Escape nad kontextovým menu zavírá i velký přehrávač (rozhodnout ve vlně 2).
- `_shufPlayed` je paměť modulu, nepřežije reload — persistence shuffle tím dostává
  prázdnou historii.
- DJ engine (`player_v3.js`) není ověřený živě: `claude_test` má `classic`.
