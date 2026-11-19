# DJ pult: podpora výstupu zvuku na druhé zařízení (sluchátkový cue)

Staženo 2026-11-19 z primárních zdrojů (MDN, browser-compat-data (BCD) na GitHubu, W3C/Web Audio spec, Chromium/WebKit/Mozilla trackery, blink-dev). Z paměti nic. Co se nepodařilo potvrdit, je označeno **NEPOTVRZENO**.

Poznámka ke zdrojům: tabulky kompatibility na stránkách MDN se při stažení nevykreslily, proto čísla verzí pocházejí z BCD, ze kterého MDN tabulky generuje (`https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/...`, staženo 2026-11-19). caniuse neposkytl data (vyhledávací stránka vrátila jen odkazy).

## 1. Matice podpory

| API | Chrome desktop | Edge | Firefox desktop | Safari macOS | Safari iOS | Chrome Android | Android WebView |
|---|---|---|---|---|---|---|---|
| `HTMLMediaElement.setSinkId` / `sinkId` | 49 | 17 | 116 | 18.4 | BCD: "mirror" = 18.4, **ale viz konflikt níže** | **ne** (crbug 41276355) | **ne** (mirror Chrome Android) |
| `AudioContext.setSinkId` / `sinkId` / `{sinkId}` v konstruktoru | 110 | 110 | **ne** | **ne** | **ne** | 110 | 110 |
| `selectAudioOutput()` | **ne** (není vydáno, crbug 372214870) | ne | 116 (jen desktop) | **ne** (WebKit bug 216641) | ne | ne | ne |
| `enumerateDevices()` | 47 | 12 | 116 (od 116 i výstupy; dřív jen vstupy) | 11 | 11 | 47 | 47 |
| `AudioDestinationNode.maxChannelCount` | 27 | 12 | 25 | 14.1 (7 až 14.1 vždy vracelo 0) | mirror Safari | mirror Chrome | mirror Chrome |

Zdroje:
- setSinkId a sinkId: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/HTMLMediaElement.json (poznámka u chrome_android: "Not available due to a limitation in Android, see bug 41276355"; u firefox_android bug 1473346).
- AudioContext.setSinkId, sinkId, konstruktor, sinkchange: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AudioContext.json
- selectAudioOutput, enumerateDevices: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaDevices.json
- maxChannelCount: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/AudioDestinationNode.json
- Firefox 116: "Audio Output Devices API is now supported on all platforms except for Android": https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/116
- Chrome (2015 Intent to Ship) potvrzuje, že element setSinkId byl jen desktop: "the Android platform does not provide the ability to programmatically switch individual audio streams": https://groups.google.com/a/chromium.org/g/blink-dev/c/ELz4SxMwa0U
- Chrome 110 AudioContext.setSinkId: https://developer.chrome.com/blog/audiocontext-setsinkid a Intent to Ship https://groups.google.com/a/chromium.org/g/blink-dev/c/mdOF67Z-hXc (tam se uvádí "all six Blink platforms", tedy včetně Androidu a WebView; BCD to potvrzuje pro Chrome Android a WebView 110).

### Konflikt a nejistota: Safari iOS
- BCD dává `safari_ios` jako "mirror" Safari, tedy 18.4 (`HTMLMediaElement.json`).
- WebKit blog k Safari 18.4 ale uvádí "speaker selection API" jako **macOS** funkci a o iOS se nezmiňuje: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
- WebKit bug 216641 je pořád NEW (naposledy změněn 2025-08-02), bez uvedené platformy: https://bugs.webkit.org/show_bug.cgi?id=216641
- **Závěr: na iOS Safari element setSinkId NEPOČÍTAT, dokud se to neověří na zařízení.** Ověřeno není.
- Stejný bug dokládá, že `selectAudioOutput` v Safari chybí (3 testy WPT padají) a že funkce byla za experimentálním příznakem "Allow speaker device selection".

## 2. Oprávnění a permissions policy (otázka 1)

- `speaker-selection` je Permissions-Policy direktiva. Výchozí allowlist je `self`. Když ji politika blokuje: `enumerateDevices()` nevrátí výstupní zařízení, `selectAudioOutput()` se zamítne s `NotAllowedError`, `HTMLMediaElement.setSinkId()` i `AudioContext.setSinkId()` vyhodí `NotAllowedError`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/speaker-selection
- Pro vlastní stránku (bez iframe) tedy není potřeba nic nastavovat, `self` stačí. Hlavičku řešit jen u vložení do iframe z jiného původu.
- BCD nemá záznam pro `speaker-selection` v `Permissions-Policy.json` (dotaz vrátil "žádný záznam"), takže **podporu samotné direktivy podle prohlížečů nelze z BCD potvrdit**. Firefox 116 ji uvádí v release notes (odkaz výše).
- Obě metody jsou `[SecureContext]` (HTTPS): https://www.w3.org/TR/audio-output/ a MDN `HTMLMediaElement/setSinkId`.
- Spec: bez transient activation smí prohlížeč zamítnout s `InvalidStateError`, tedy volat z kliknutí: https://www.w3.org/TR/audio-output/
- Nevýchozí zařízení vyžaduje souhlas. Souhlas vzniká buď explicitně přes `selectAudioOutput()`, nebo implicitně udělením `getUserMedia()` mikrofonu se stejným `groupId`. Zdroj: https://www.w3.org/TR/audio-output/ (část o exposure, algoritmus 4.2 vrací `true` jen pro explicitně udělené zařízení, nebo když se smí zveřejnit informace o mikrofonu).
- Výchozí zařízení se označuje prázdným řetězcem `""` a nemá požadavek na oprávnění: tamtéž.

### Funguje element setSinkId se srcObject = MediaStream z MediaStreamAudioDestinationNode?
- **Firefox: ano, je to testováno.** Mochitest `test_setSinkId-stream-source.html` bere zdroj z `new AudioContext().createMediaStreamDestination().stream`, nastavuje ho jako `srcObject` na `<audio>` a volá `setSinkId`. Test běží jen na Linuxu s loopback zařízením a je přeskočen na Androidu: https://searchfox.org/firefox-main/source/dom/media/webrtc/tests/mochitests/test_setSinkId-stream-source.html
- **Chrome: NEPOTVRZENO v primárním zdroji.** Žádná stránka MDN ani spec to neomezuje a spec na srcObject nic nemění. Nenašel jsem ale ani explicitní potvrzení ani vyvrácení. Chromium issue 40160849 (popisuje rostoucí a kolísavou latenci při `createMediaStreamDestination()` + `setSinkId()`) se nepodařilo stáhnout (vyžaduje přihlášení), jen z výsledku vyhledávání: https://issues.chromium.org/40160849. Je třeba ověřit prakticky.
- Mozilla v tom testu poznamenává, že pořadí dvou po sobě jdoucích `setSinkId` není garantováno (bug 1874629), takže nevolat dvakrát rychle za sebou.

## 3. AudioContext.setSinkId a `{type:'none'}` (otázka 2)

- Matice viz tabulka: jen Chromium (110+), Firefox a Safari ne.
- Podpis: `setSinkId(string | AudioSinkOptions)`, `AudioSinkOptions = { type: "none" }`; konstruktor `new AudioContext({ sinkId })` přijímá totéž: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId a https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext
- Výjimky: `InvalidAccessError` (přístup k zařízení selhal), `NotAllowedError` (nemá oprávnění), `NotFoundError` (sinkId neodpovídá žádnému zařízení). Nastavení stejné hodnoty nehází chybu a hned skončí: MDN `AudioContext/setSinkId`.
- Nevýchozí zařízení vyžaduje oprávnění k audio zařízením, MDN doporučuje `getUserMedia()`: tamtéž.
- `{type:'none'}`: Web Audio spec: "The audio graph will be processed without being played through an audio output device": https://webaudio.github.io/web-audio-api/ (`#enumdef-audiosinktype`). Chrome blog doplňuje, že `currentTime` dál běží a graf se renderuje bez slyšitelného zvuku: https://developer.chrome.com/blog/audiocontext-setsinkid
- Událost `sinkchange` se vyvolá po dokončení `setSinkId()`, ne při počátečním výběru: Web Audio spec (`#dom-audiocontext-onsinkchange`). Událost `error` při odpojení zařízení běžícího kontextu: tamtéž.
- Spec dovoluje u výchozí konstrukce tiše použít emulované výstupní zařízení, když se zařízení nepodaří získat: Web Audio spec §1.2.1.

## 4. selectAudioOutput() (otázka 3)

- Podpora: **jen Firefox 116+ desktop**. Chrome (crbug 372214870) a Safari (WebKit 216641) ne: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/MediaDevices.json
- Požadavky: HTTPS, transient user activation (jinak `InvalidStateError`), `speaker-selection` politika. Výjimky: `NotAllowedError` (politika, nebo uživatel zavřel dialog), `NotFoundError` (žádné výstupy): https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/selectAudioOutput
- Uložené deviceId musí nejdřív projít `selectAudioOutput()`, než poslouží `setSinkId()`: tamtéž a https://www.w3.org/TR/audio-output/
- Po výběru je zařízení vidět v `enumerateDevices()` pro daný browsing context: https://www.w3.org/TR/audio-output/

## 5. enumerateDevices() a audiooutput: popisky a deviceId (otázka 4)

| Prohlížeč | Bez povolení mikrofonu | Co je potřeba pro použitelné deviceId a labely |
|---|---|---|
| Chrome | Jen výchozí zařízení: "The list consists of default devices only when this permission is not granted." | Udělení "microphone": "The list of media devices is exhaustive when the 'microphone' permission is granted"; vyvolá se `getUserMedia({audio:true})`. https://developer.chrome.com/blog/audiocontext-setsinkid |
| Firefox | Nelze potvrdit číslem, ale spec a MDN: mimo výchozí jsou "available" jen zařízení s udělením. | `selectAudioOutput()` (jediná cesta, která nevyžaduje mikrofon), nebo getUserMedia mikrofon se stejným `groupId`. `enumerateDevices` v 116+ se vyřeší jen když má dokument fokus (bug 1818588). https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices a BCD `MediaDevices.json` |
| Safari | NEPOTVRZENO | WebKit blog: reproduktory se vypíšou "once microphone access has been granted": https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ |

Další fakta:
- Spec: `audiooutput` se zveřejní, jen když je povolená `speaker-selection` a zařízení je buď explicitně uděleno přes `selectAudioOutput()`, nebo se smí zveřejnit informace o mikrofonu: https://www.w3.org/TR/audio-output/ (4.2). Pravidla pro zveřejnění labelů jsou v mediacapture-main §9.2, **tu část se nepodařilo stáhnout (stažení se zkrátilo před kapitolou 9)**. MDN říká, že labely jsou vidět, když je aktivní MediaStream nebo je udělené trvalé oprávnění: MDN `enumerateDevices`.
- **Mikrofon není pro Chrome "od verze X" vynucen; je to dlouhodobě v Chrome blogu (110) uvedeno jako podmínka úplného seznamu.** Konkrétní verzi, od které to platí, jsem nenašel. **NEPOTVRZENO.**
- Chrome vrací, když nejsou zpřístupněna žádná výstupní zařízení, jednu položku s prázdným `label`, `deviceId` i `groupId` (ne žádnou). Na Linuxu je při zpřístupnění první položka `deviceId:"default"` a pak fyzická zařízení s hashem: https://lists.w3.org/Archives/Public/public-webrtc-logs/2024Aug/0105.html (e-mail do WebRTC issue, ne normativní, pozorování autora).
- Praktický důsledek: pro cue na druhé zařízení v Chrome si uživatel musí povolit mikrofon (jinak uvidí jen výchozí). Ve Firefoxu použít `selectAudioOutput()`.

## 6. Vícekanálový výstup (otázka 5)

- Spec: `channelCount` lze nastavit na hodnotu nejvýše `maxChannelCount`; výchozí pro AudioContext je 2, `channelCountMode` "explicit", `channelInterpretation` "speakers". `maxChannelCount` je maximum, které hardware zvládne: https://webaudio.github.io/web-audio-api/ (§ AudioDestinationNode). MDN: https://developer.mozilla.org/en-US/docs/Web/API/AudioDestinationNode/maxChannelCount
- Spec definuje rozvržení kanálů jen do 6 (5.1), jak uvádí Paul Adenot v bugu 1474175; kanály 3 a 4 jako "diskrétní cue" tedy nejsou standardizovaný scénář.
- **Firefox:**
  - `maxChannelCount` hlásí správně od verze 25 a `channelCount` se musí zvýšit ručně, jinak se výstup downmixuje na stereo: https://bugzilla.mozilla.org/show_bug.cgi?id=1474175
  - Na macOS s vícekanálovým USB rozhraním šly kanály 1+2, mapování bylo `[FrontLeft, FrontRight, Silence, Silence, Silence, Silence]`; opraveno aktualizací cubeb-coreaudio-rs, cíl Firefox 128 (tamtéž).
  - Bug 1434362 (otevřený): Web Audio při stereo konfiguraci posílá jen přední L/R: https://bugzilla.mozilla.org/show_bug.cgi?id=1434362
  - Bug 2012662 (otevřený, UNCONFIRMED, Ubuntu): 8 kanálů přes Web Audio na 8kanálový virtuální výstup, slyšet jen první dva: https://bugzilla.mozilla.org/show_bug.cgi?id=2012662
- **Chrome/Chromium:**
  - Dokumentovaný důkaz o desktopovém výstupu kanálů 3+ jsem **nenašel**. NEPOTVRZENO.
  - Fragmenty z vyhledávání: uživatel Opery (Chromium) na macOS s 7.1 USB zařízením hlásil `maxChannelCount` = 2 (Firefox na stejném stroji 6 nebo 8): https://forums.opera.com/post/217484 . Je to jen fórový příspěvek, ne tracker.
  - Chromium code review říká, že patch řešil jen macOS a "does not fix the issue for Windows/Linux multichannel support": https://codereview.chromium.org/810763006 (jen z výsledku vyhledávání, stránku jsem nestahoval).
  - Review 1464673002 přidal vícekanálovost do `MediaStreamAudioDestinationNode` (do 8 kanálů): https://codereview.chromium.org/1464673002. To se týká toku do streamu, ne výstupu na hardware.
- **Závěr: vícekanálový cue (kanály 3+4) je nespolehlivý, hlavně v Chrome. Nenabízet jako výchozí, jen jako experimentální volbu s testem (`maxChannelCount >= 4`) a nutností ověřit na cílovém rozhraní.**

## 7. Latence (otázka 6)

- **Žádná dokumentovaná čísla nenalezena. NEPOTVRZENO.** Chrome blog k `AudioContext.setSinkId` latenci vůbec nezmiňuje: https://developer.chrome.com/blog/audiocontext-setsinkid
- Chromium issue 40160849 (nepodařilo se stáhnout; z výsledku vyhledávání): latence roste a kolísá při `createMediaStreamDestination()` + `setSinkId()`, komentář hlásí výskyt na Chromium 89 v Electronu 12. Stav neznámý: https://issues.chromium.org/40160849
- Chromium commit k metrikám zpoždění Web Audio (`fifo_delay`, `total_playout_delay`) by byl cestou k měření: https://chromium.googlesource.com/chromium/src/+/af64ee78d7c0a6c68169f88af3cc91e948e7cf20 (jen z vyhledávání, nestaženo).
- Strukturálně: cesta "Web Audio, MediaStreamAudioDestinationNode, `<audio>.setSinkId`" vede přes element a jeho vlastní buffering, kdežto druhý `AudioContext` s `sinkId` renderuje přímo na zařízení. To je moje úvaha, ne citace. Nic z toho jsem nezměřil. Doporučené řešení: změřit na cílovém stroji (`AudioContext.outputLatency` a smyčka s mikrofonem).
- Pro cue to není kritické (náhled skladby, ne synchronní míchání), ale ladění beatmatchingu podle cue vyžaduje stálé, změřené zpoždění. Rozdíl mezi hlavním a cue výstupem se musí kompenzovat.

## 8. Chromium headless a automatizace (otázka 7)

- `--use-fake-device-for-media-stream`: "Use fake device for Media Stream to replace actual camera and microphone." Tedy kamera a mikrofon, **o výstupních zařízeních tam nic není**: https://chromium.googlesource.com/chromium/src/+/main/media/base/media_switches.cc
- `--use-fake-ui-for-media-stream`: definice není v `media_switches.cc` (nenalezeno v tomto souboru). Nelze ze zdroje potvrdit; obecně jde o automatické potvrzení dialogu oprávnění, ale **tento zdroj to nepotvrzuje**. **NEPOTVRZENO.**
- `--disable-audio-output`: "Forces input and output stream creation to use fake audio streams." (komentář nad deklarací `kDisableAudioInput`, tamtéž). `FakeAudioManager::HasAudioOutputDevices()` vrací `false` a `MakeLowLatencyOutputStream` ignoruje `device_id` a vrací falešný stream: https://chromium.googlesource.com/chromium/src/+/main/media/audio/fake_audio_manager.cc
- **Závěr: žádný zdroj netvrdí, že fake flagy vytvoří falešná VÝSTUPNÍ zařízení pro `enumerateDevices`/`setSinkId`. NEPOTVRZENO a spíš ne.** V headless režimu s `FakeAudioManager` není žádný výstup. Pro e2e test se spolehnout jen na (a) chování `setSinkId("")` a nonexistentního id, (b) mockování `HTMLMediaElement.prototype.setSinkId` a `enumerateDevices` v Playwrightu, (c) reálné zařízení na stroji. Pozn.: Firefox test používá Linux loopback `media.audio_loopback_dev` (viz Firefox mochitest výše).
- `setSinkId('nonexistent-id')` odmítne s **`NotFoundError`**:
  - WPT test "setSinkId fails with NotFoundError on made up deviceid": https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/web_tests/external/wpt/audio-output/setSinkId.https.html (`audio.setSinkId("nonexistent_device_id")`).
  - Chromium zdroj mapuje `kNotFound` na `NotFoundError` ("Requested device not found") a `kNotAuthorized` na **`SecurityError`** ("No permission to use requested device"), pozor: spec říká `NotAllowedError`, Chromium kód používá `SecurityError`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/audio_output_devices/html_media_element_audio_output_device.cc . Kód je z větve main k datu stažení, nemusí odpovídat vydané verzi.
  - Spec: neznámé id `NotFoundError`, nepovolené id `NotAllowedError`, selhání přepnutí `AbortError`: https://www.w3.org/TR/audio-output/
- `setSinkId("")` musí vždy uspět (reset na výchozí): ten samý WPT test. V Chrome se zpracuje jako každé jiné id; shoda s aktuálním id se vyřeší hned (zdrojový soubor výše).

## 9. Praktická doporučení (co nabídnout kde)

| Scénář | Nabídnout | Poznámka |
|---|---|---|
| Chrome / Edge desktop | **AudioContext.setSinkId** (nebo element setSinkId) | Vyžádat mikrofon pro úplný seznam zařízení. |
| Firefox desktop | **element setSinkId** přes `<audio>` + MediaStreamDestination, výběr přes `selectAudioOutput()` | AudioContext.setSinkId chybí. Firefox testuje právě tento tok. |
| Safari macOS 18.4+ | element setSinkId (po povolení mikrofonu) | Bez `selectAudioOutput`. |
| iOS Safari | **nenabízet** | Podpora nepotvrzena (konflikt BCD vs. WebKit blog). |
| Chrome Android / WebView | **nenabízet** | `setSinkId` na elementu nedostupný (crbug 41276355). AudioContext.setSinkId má od 110 podle BCD, ale reálný efekt na Androidu **není ověřen**. |
| Vícekanálový (3+4) | jen jako experimentální volba | Chrome nepotvrzeno, Firefox historicky chybné. |
| Split-cue (jeden kontext, dva výstupy) | nelze v rámci jednoho AudioContext | Jeden kontext má jedno `destination`; druhý výstup vyžaduje druhý `AudioContext` se `sinkId` nebo element. |
