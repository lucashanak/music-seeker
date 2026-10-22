# Přejímka — oprava 4 (UX audit, vlna 1), v1.26.0

22. 10. 2026, proti běžící instanci `https://musicseeker.hanaktech.org`, účet
`claude_test`. Tři agenti paralelně, každý svoji oblast, **všechna tři rozlišení**
(telefon 390x844, tablet na šířku 1024x768, desktop 1280x900).
Rozpočet placených volání: **žádná** — všechno jsou volání vlastního backendu a
bezplatného Deezeru.

| oblast | potvrzeno | nepotvrzeno | neprovokováno |
|---|---|---|---|
| vyhledávání | **18** | 0 | 0 |
| přehrávač a fronta | **21** | 0 | 3 |
| navigace a chrome | **16** | 1 | 0 |

## Doklady k hlavním bodům

- **Zpět dělá jeden krok.** Discover → tag → Library → Zpět přistane tam, kde má;
  Search → interpret → Settings → Zpět nepřeskočí dvě úrovně. Po Zpět má všech
  osm vrstev detailu `style.display === 'none'`.
- **Žánrový žebříček**: 22 dlaždic → klik → `#genreBack`, `history.length` 4 →
  Zpět → zpátky 22 dlaždic, aplikace neopuštěna. Tohle drží až dohromady
  z vyhledávání (příznak) a navigace (větev v routeru).
- **Nekonečný scroll přes detail alba**: 4× doscrollováno, **0 požadavků** na
  `/api/search` (před dávkou 4).
- **Fronta neblokuje přehrávač**: `elementFromPoint` nad `#playerPlayPause` leží
  uvnitř `#playerBar`, klik mění stav a fronta zůstane otevřená.
- **Odhlášení**: po něm `audio.paused = true`, v `localStorage` nezůstal
  `ms_recent_searches` předchozího uživatele. Obě cesty ven (sekce Account
  i horní lišta) jdou stejnou cestou.
- **Výpadek providera**: stub 502 na `/api/genres` → „Could not load the genre
  list. Try again"; po odebrání stubu klik na Try again dotáhne 22 dlaždic.
  Spadlé tři větve `/api/search/all` → 3 chybové proužky, 3× Try again, žádné
  „No results found".
- **Překlepy**: `beyonse` → 18 karet, první Beyoncé, **bez** pruhu „No results";
  `zzzqqqxyznotathing12345` pruh **má**.
- **Hrdinka interpreta**: play → 1 požadavek na `/api/artist/{id}/top`, hraje
  „Instant Crush".

## Jediný nepotvrzený bod — a proč je to chyba kritéria, ne kódu

**N13** (plovoucí tlačítko zpětné vazby bylo příliš bledé). Naměřeno
`opacity = 0.85` ve všech třech rozlišeních; před dávkou bylo `0.55`
(`feedback.css:13`). Oprava tedy platí. Agent ho označil za nepotvrzený s
odůvodněním „tj. >= .8", což je **obrácené kritérium** — vyšší hodnota je ta
správná. Bod se počítá za hotový, chyba je v přejímkovém tvrzení.

## Nahlášená regrese — prověřeno, falešný poplach

Agent navigace zaznamenal po spuštění skladby `POST …/add-and-download-batch` a
upozornil, že slovo „download" na produkci, kde se nemá stahovat, chce ověřit.
**Prověřeno měřením, ne čtením:** `mirrorAdd` (`upnext.js:167-171`) posílá
`download: false` a `GET /api/jobs` hlásí po celé přejímce **0 úloh**. Je to
zrcadlení dočasné fronty Up Next do playlistu zařízení, nic se nestáhlo.

## Co zůstalo neprovokované (poctivě, ne přehlédnutím)

- **R2.5** — ručně spuštěné doporučení se nemá připnout do fronty: v panelu
  doporučení nebyl po testu autoplay žádný volný řádek mimo právě hrající, takže
  nebylo na co klepnout.
- **P4** — hláška, když doporučovač nevrátí nic: pro „daft punk" vrátil vždy
  skladby, prázdná cesta se nespustila.
- **P2** — strop 20 automaticky doplněných skladeb a shuffle v DJ enginu: strop
  jsem neprovokoval (přidával jsem 1–2 tipy) a `claude_test` má `classic`, takže
  `player_v3.js` není ověřený živě.
- **S10** („1 episode") měřeno jen na desktopu nad podstrčenou odpovědí — pořad
  s jedinou epizodou se na produkci spolehlivě nenajde.
- **S11** (pořadí ♡ / délka / ⋯) na telefonu neměřitelné, srdce je tam záměrně
  skryté.

## Jedno nevysvětlené měření

Na telefonu zavřel detail pořadu po kliku na tab Albums správně, ale v prvním
běhu ukázal **0 karet** po 3,5 s. Třikrát zopakováno samostatným skriptem:
pokaždé 20 karet už po 1,5 s, jeden dotaz na `/api/search` → 200. Nulu se
nepodařilo zopakovat ani vysvětlit; nejpravděpodobnější je pomalá odpověď
Deezeru. **Zapsáno jako nevysvětlené, ne jako vyřešené.**

## Disk

Před nasazením 54 %, po nasazení a `docker builder prune -af` **47 %**
(uvolněno 3,44 GB + 1,87 GB).
