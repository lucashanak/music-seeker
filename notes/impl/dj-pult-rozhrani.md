# DJ pult — rozhraní mezi moduly (kontrakt pro paralelní agenty, 2026-11-19)

Zadání: `/home/lucas/music-seeker/notes/impl/dj-pult-zadani.md`, pravidla: `/home/lucas/music-seeker/notes/impl/spolecna-pravidla-davek-2026-11-19.md`,
kontext přehrávače: `/home/lucas/music-seeker/CLAUDE.md` (sekce DJ mode, Energy, volume).
Worktree: `/home/lucas/music-seeker-wt/dj-pult` (větev `dj-pult`). Nikdy nepracuj v `/home/lucas/music-seeker`.

## Základní model
- Engine (`static/js/player_v3.js`) má dva fyzické decky **A** (`#audioElement`) a **B**. Hraje
  vždy jeden, `active`; při přechodu se role prohodí. Pult je ukazuje **fyzicky**: levý deck = A,
  pravý = B, štítek LIVE na aktivním. Crossfader: vlevo A, vpravo B (jako skutečný pult — po
  ručním mixu zůstane fader na straně nového decku a volný je ten druhý).
- **Odposlech (cue)** = engine *půjčí* neaktivní deck pultu (`deskLend`). Půjčený deck má
  crossfade gain 0 (v masteru ticho) a jeho zvuk se odebírá ze `levelGain` (před crossfade gainem)
  do odposlechové sběrnice. Engine si deck vezme zpět při každém načtení / přechodu (událost
  `desk:engine` `{type:'revoked'}`).
- Pult funguje **jen s DJ enginem** (`getPlayerEngine() === 'dj'` z `player_active.js`).
  **Nikdy `import ... from './player_v3.js'` staticky** v nových modulech — klasický engine by pak
  běžel souběžně s druhou instancí. Engine získej přes `await getPlayerModule()` (player_active.js)
  a jen když je engine `dj`; jinak pult/odposlech skryj.
- Při castu (`store.castDevice`) nebo ovládání jiného zařízení (`store.remoteTarget`) je pult
  nedostupný: skrýt / jasná hláška. Engine sám půjčku zruší (reason `cast`/`remote`).
- Texty v UI anglicky (celá aplikace je anglicky); Lukáš je případně změní.

## Engine — exporty z `player_v3.js` (píše vedení dávky, ne agenti)
```
deskGraph() -> { ctx, master, nodes: {A:{low,mid,high,sweep,levelGain,gain}, B:{…}}, els: {A,B} } | null
    Zajistí AudioContext (volat z uživatelského gesta). null při castu/remote/klasickém enginu.
    `master` = DynamicsCompressor (limiter), dnes připojený přímo na ctx.destination.
deskInfo() -> {
    ready, active:'A'|'B', fading:'A'|'B'|null, crossfading, mixing, loan:'A'|'B'|null,
    manual, busy, blocked:null|'cast'|'remote'|'rec', volume /*master 0..1*/,
    index /*store.playerIndex*/, next /*_upcomingIdx()*/, deskNext,
    items: {A:item|null, B:item|null},   // co který deck drží (queue item / item z deskLoad)
    data:  {A:djData|null, B:djData|null} // BPM/grid/key/energy toho, co deck drží
}
deskLend() -> 'A'|'B'|null
    Půjčí neaktivní deck. Odmítne (null) během přechodu, rozjetého posunu, castu, remote, rec.
    Půjčený deck: pauza, EQ neutrální, crossfade gain 0, element.volume 1, playbackRate 1.
deskLoad(item, { startAt=0, play=true, index=null, warm=true }) -> Promise<boolean>
    warm=false: bez prefetch blobu (rychlý náhled); warm=true pro skladbu nachystanou k mixu.
    Načte skladbu na půjčený deck (blob z prefetch, jinak progresivní stream) a spustí její
    prefetch. `index` = pozice ve frontě (nutná pro ruční mix). true = může hrát.
deskRelease()                      vrátí půjčený deck (pauza, src pryč, gainy reset, volume = master)
deskDur(key) -> s | 0              délka (u progresivního streamu ji engine zjistí ze serveru)
deskSetNext(idx|null) -> boolean   co hraje dál (shuffle: přesun v pořadí; jinak override)
deskMixNow({startAt}) -> boolean   enginový přechod TEĎ do svázané další (nejdřív deskSetNext);
                                   startAt jen u blobu; vrátí půjčku. false = odmítnuto
deskSetManual(on)                  ruční režim: auto-trigger nikdy; dohraná skladba naváže (ended)
deskBeginMix() -> boolean          ruční crossfader: půjčený deck (deskLoad s index, hraje) se
                                   stane LIVE (playerIndex, titulek, fronta, media session),
                                   dosavadní hraje dál jako odcházející
deskMixLevel(t)                    t 0..1: 0 = jen odcházející, 1 = jen nový; equal-power
deskEndMix(commit)                 true: odcházející stop; false: zpět (nový deck znovu půjčený)
deskSetRate(key, rate) -> boolean  playbackRate decku; na live decku zruší návrat tempa a PLL
deskSeek(key, t)                   posun (live přes seekLocal, půjčený přímo)
```
Událost: `document` `desk:engine` s `detail.type` ∈ `revoked` (`reason`, `key`), `mixend`
(`commit`), `swap` (po každém enginovém přechodu, `active`).

## `static/js/cuebus.js` — směrování odposlechu (agent „cuebus“)
```
cueSupport() -> { engineDj, devices, ctxSink, selectOutput, maxChannels, split:true,
                  mobile, webkit, androidApp, modes:['devices'|'multichannel'|'split'] }
cueSettings() / setCueSettings(patch)   localStorage ms_cue_*: mode ('devices'|'multichannel'|
                  'split'|'off'), deviceId, deviceLabel, volume 0..1, mix 0..1 (0 = jen cue,
                  1 = jen master), pfl {A:bool,B:bool}
listOutputs() -> Promise<[{deviceId,label}]>
acquireCue(owner) / releaseCue(owner) -> Promise<{ok,error}>   refcount; směrování žije, jen dokud
                  ho někdo drží (pult otevřený, náhled hraje). Poslední release vrátí
                  master → destination přesně jako dřív.
setDeckCue(key, on)                    PFL decku do sluchátek
cueLevels() -> {master, cue}           RMS pro měřáky
isBluetoothLabel(label) -> boolean
onCueChange(cb) -> unsubscribe
previewItem(item, {startAt, index}) -> Promise<boolean>   půjčí deck, načte, PFL on, hraje
stopPreview(); previewState() -> {item,key,playing,pos,dur}|null; previewToggle(); previewSeek(t)
_debugTaps() -> { master, cue, post: {A, B} }   AnalyserNode pro testy
```
`static/js/cuesetup.js` — `openCueSetup() -> Promise<boolean>` dialog nastavení odposlechu
(režim, zařízení, hlasitost, mix, věta o Bluetooth). Dialog se registruje do `store.dialogStack`.
`static/js/cuemath.js` — čisté funkce (bez DOM), testované v `tests/js/cue_routing.test.mjs`.

## `static/js/djdesk.js` + `frontend/partials/91-dj-desk.html` + `static/css/djdesk.css` (agent „desk“)
`openDesk()`, `closeDesk()`, `isDeskOpen()`, `init()`. Čisté výpočty v `static/js/deskmath.js`
(`tests/js/desk_math.test.mjs`).

## `static/js/cuemini.js` + `static/css/cue.css` (agent „vstupy“)
`init()`; tlačítko se sluchátky ve frontě, položka kontextového menu, mini lišta náhledu.

## Backend (agent „waveform“)
`GET /api/desk/waveform?name=&artist=` → `{ step: 0.1, duration, peaks: <base64, 1 bajt / 0,1 s> }`,
nebo `200 {"owned": false}`, když server audio nemá (YouTube nikdy).

## Sdílené soubory (kdo smí sahat)
- `app.js` — importy a `init()` nových modulů zapojí vedení (stuby už existují).
- `frontend/partials/00-head.html` — odkazy na `djdesk.css` a `cue.css` už jsou.
- `static/index.html` — jen přes `scripts/build-index.sh`.
- `player_v3.js` — jen vedení.
