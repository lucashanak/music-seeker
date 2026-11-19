# remote-opravy — E (prohlížečová přejímka), výsledky 2026-11-19

Soubory (necommitnuté, ve worktree):
- `tests/e2e/audit/remote.mjs` — sada, dva prohlížeče (ovladač `e2e-remote-a`, cíl `e2e-remote-b`), účet `claude_test`.
- `tests/e2e/audit/remote_backend.sh` — lokální backend ze stromu (kopie stromu s cache-bust jako `entrypoint.sh`,
  uvicorn na `127.0.0.1:18094`, scratch `DATA_DIR` jen se záznamem `claude_test` přečteným read-only přes ssh,
  scratch `TMPDIR`, Navidrome `192.168.1.22:4533` jako `claude_test` — i servisní účet je `claude_test`, nikdy `lucas`).
  `stop` smaže celý scratch adresář včetně záznamu.
- `helpers.mjs` beze změny (`MS_URL` už uměl přepnout instanci).

## Jak to pustit znovu

```
uptime   # load nad ~30 → odložit
cd /home/lucas/music-seeker-wt/remote-opravy
# produkce (nasazený kód) — čekáno hlavně červeně
flock /home/lucas/music-seeker/notes/impl/.prejimka.lock node tests/e2e/audit/remote.mjs --vp=phone,desktop
# strom end-to-end (frontend i backend ze stromu)
tests/e2e/audit/remote_backend.sh start            # vypíše MS_URL=http://127.0.0.1:18094
flock /home/lucas/music-seeker/notes/impl/.prejimka.lock env MS_URL=http://127.0.0.1:18094 node tests/e2e/audit/remote.mjs --vp=phone,desktop
tests/e2e/audit/remote_backend.sh stop             # smaže scratch kopii i záznam claude_test
# volitelně: --vp=phone,tablet,desktop; --tree = frontend ze stromu nad produkčním backendem (neúplné, backend je starý)
```
Po nasazení stačí první příkaz (bez `MS_URL`). Běh trvá ~12 min pro dva viewporty.

## Poslední běh nad kompletním stromem (18:53–19:15)

Harness znovu spuštěný nad stromem se všemi koly oprav (SSE ping 10 s, rotace tokenu, odmítnutí Send-to pro
ovládající zařízení, fronty v `PLAYER_DIR/users/<user>/`, zámek příkazů per cíl, serializace zrcadla Up Next).

**Strom end-to-end, phone + desktop + tablet + SENDTO + LOCAL: 146 prošlo, 1 padlo, 2 přeskočeno** (`tree6.log`).
Jediné červené byl krok `B2 [phone]`: sada čekala na tlačítko Control u zařízení `e2e-remote-a`. Nový
`renderDevicesPanel` u zařízení, které samo ovládá, tlačítko nenabízí a do řádku píše „Controlling another device“
— je to záměrné (komentář v `remote.js`: Control i Send to by dostaly 409), takže **chyba sady, ne implementace**.
B2 teď přijme všechny tři správné podoby (žádné tlačítko + důvod v řádku / tlačítko odmítnuté toastem / 409 ze serveru).

**Opakování červeného (phone, `--no-local`): 65 prošlo, 0 padlo, 2 přeskočeno** (`tree7.log`):
`controlButton:false, rowHint:"Controlling another device"`, jeden příkaz `next` → 202, žádný transfer, ovladač ticho.
SENDTO zelený (Y hraje X-ovu frontu na stejném řádku, X stojí, ovladač ovládá Y). LOCAL zelený (fronta 100→101,
seznam 100→100; album Play all + Add all 14→28 za 810 ms, nejpomalejší evaluate 1 ms).

Podezření na chyby implementace: žádné. Harness zastavený, scratch záznam smazaný.

## Finální kolo po opravách ze tří review (18:26–19:00)

Harness restartovaný nad aktuálním stromem (device-bound SSE token, fronty v adresářích per uživatel,
`_src` kopie fronty, `silenceForRemote`, Send-to při ovládání …), běh pod zámkem `.prejimka.lock`, load 4–10.

**Strom end-to-end, phone + desktop + tablet: 147 prošlo, 2 padlo, 2 přeskočeno** (`tree3.log`). Padly jen
`B2 [phone]` „controller is told …“ a „neither device starts playing“. Příčina: **chyba v sadě, ne v kódu** —
nová verze (M7 v `remote.js: enterRemoteMode`) už nedovolí cíli převzít ovládání zařízení, které ho samo ovládá
(toast „That device is controlling another device“), takže předpoklad starého B2 (oba se ovládají navzájem)
nenastal, cíl zůstal cílem a Next na něm normálně přehrál další skladbu. B2 jsem přepsal tak, aby přijal obě
správná chování (odmítnutí už při vstupu s hláškou, NEBO 409 od serveru) a v obou ověřil, že nic nepingpongne.

**Opakování červených (phone, `--no-local`; B2 běží jen v prvním viewportu): 65 prošlo, 0 padlo, 2 přeskočeno**
(`tree5.log`): B2 odmítnutí s hláškou, 1 příkaz `next` → 202, žádný transfer, ovladač ticho.
Celkem tedy strom zelený na všech třech viewportech.

Nové kontroly (obě levné, obě zelené):
- **SENDTO** (třetí kontext `e2e-remote-c`, jen v prvním viewportu; `--no-sendto` vypne): ovladač ovládá X, dá
  „Send to Y“ → Y hraje X-ovu frontu (5 řádků, index 2, stejná skladba), X se zastaví, ovladač teď ovládá Y,
  ovladač ticho. Pak se vrátí k X a Y se zavře; Up Next `e2e-remote-c` se na konci maže.
- **LOCAL** (bez ovládání, stream/prewarm/resolve stubované na 404, aby žádný výsledek hledání nešel na YouTube;
  `--no-local` vypne): přehrání výsledku hledání → fronta je kopie (`same:false`, 100 řádků); Add to queue z řádku
  hledání → fronta 100→101, seznam hledání 100→100; album „Discovery“ Play all (14) + Add all → 28 za 1429 ms,
  nejpomalejší evaluate 7 ms (žádné zamrznutí), bez page errors.

Podezření na chyby implementace: žádné. Produkce se v tomto kole znovu nepouštěla (výsledek níž platí pro nasazený kód).

## Výsledky (předchozí kolo)

**Strom end-to-end (`MS_URL=http://127.0.0.1:18094`, strom po C2/B/bpm.js dedupe, 18:01): 95 prošlo, 0 padlo, 2 přeskočeno.**
Přeskočeno (z principu): `B7 [phone] mute` (řádek hlasitosti je na telefonu skrytý, responsive.css), `B1 [desktop] art tap/swipe` (bez dotyku).
Klíčové důkazy z běhu: B2 `commands in 8 s: ["next"], statuses [409]`, toast „That device is controlling another device“;
B3 `tab1 true (idx 0->1), tab2 false`; B4 `volume 0.8 -> 0.8`, playlist cíle beze změny; B5 cíl 4→5 řádků, Up Next cíle 4→5;
B6 `11.2s -> 216.1s of 359.5s` u položky bez `duration_ms`; B9 `0/8 samples out of remote mode`.
Červené kontroly ve stromu nebyly, takže nebylo co opakovat.

**Produkce (nasazený kód, 18:1x): 42 prošlo, 53 padlo, 2 přeskočeno.** Padá:
- B16 cast tlačítko viditelné (phone, desktop)
- B8 fronta v panelu je fronta ovladače, ✕ / Play next / Clear nesahají na cíl (phone, desktop)
- B1 tap na obal: ovladač sám hraje (`decks ["PLAYING",…]`, peak 0.29), cíl se nepřepne (phone)
- B12 druhé play/pause neobnoví přehrávání (zastaralý stav), Next na telefonu neposune cíl
- B6 seek na položce bez `duration_ms` → cíl na začátek (phone, desktop)
- B7 shuffle/repeat/mute jen lokálně, like označí skladbu ovladače (desktop: liked „Get Lucky“, cíl hraje „Bohemian Rhapsody“)
- B19 DJ panel bez banneru, Preload a volba enginu vidět, „saved ✓“ a zapsaný `ms_dj_smart_queue` ovladače
- B4 transfer přepíše hlasitost cíle `0.8 -> 0.3` (hlasitost ovladače), ovladač u toho hraje
- B5 Add to queue: přidá se do Up Next OVLADAČE (4→5), cíl nic
- B9 reload cíle vyhodí ovladač z ovládání (11/11 vzorků), play pak cíl nespustí
- B3 dvě karty cíle: příkaz se neprovede správně (`tab1 false, tab2 false`)
- B2 vzájemné ovládání: ovladač začne hrát sám, žádné 409
- EXIT ovladač po „Stop controlling“ nemá svou původní frontu a hraje

Po posledním produkčním běhu jsem zpřísnil like (B7): musí platit i `store.remoteTarget === cíl` v okamžiku stisku.
Na produkci tím `B7 [phone] like` přejde z PASS na FAIL (v běhu `remoteTarget at press null` — ovladač už nebyl v ovládání
a lajkl svou skladbu, která se náhodou jmenovala stejně). Ve stromu měly obě viewporty `remoteTarget at press e2e-remote-b`,
takže to zelený výsledek nemění. Produkce po této úpravě tedy odpovídá 41/54.

Na produkci prochází jako regresní hlídky (matice je hodnotí T i ve starém kódu): Space, desktopový Next, „dvě rychlá
play/pause“ a kontroly ticha u většiny kroků.

## Podezření na chyby implementace

V posledním běhu nad stromem žádná. Co jsem hlásil průběžně v 17:30 (Clear, kebab Play next, telefonní `#fpQueuePanelList`,
zpožděný transfer, like na předchozí skladbě) vedení přidělilo C1/C2/B a v běhu 18:01 vše prošlo.

## Co sada neověřuje
- Tablet jen ve stromovém běhu finálního kola (produkce byla phone + desktop).
- Serverová cesta 409 (cíl, který ovládá) se v UI už nedá vyvolat (odmítne ji klient při vstupu); jestli ji pokrývá `tests/test_remote.py`, jsem neověřoval.
- Skutečný telefon, Android shell (B1 notifikace), DLNA cíl (B10), cast — nic z toho.
- Na lokálním backendu měl Up Next ovladače v B5 0 řádků (0→0); kontrola „nic do Up Next ovladače“ je tam slabší než na
  produkci, kde starý kód padá 4→5.
- Na konci se mažou Up Next playlisty obou testovacích zařízení a vrací lajky; fixtura `zz-audit-fixture` je ověřená beze změny
  (kontrola FIXTURE). Na produkčním serveru se nic neměnilo; ssh jen četlo `users.json`. Harness je zastavený a scratch
  záznam smazaný.
