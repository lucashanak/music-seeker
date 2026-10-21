// Celek 1 — vyhledávání. Kontroly k bodům S1–S14 z notes/impl/audit-2026-10/search.md
// plus R1.1 a R1.2 z notes/impl/oprava-4-dodatek-po-review.md.
//
// DRUHÉ KOLO: zelenou polovinu NEDĚLÁ náhrada vložená do stránky.
// V prvním kole se kontroly zezelenaly tím, že si do živé stránky vložily vlastní
// posluchač nebo přepsaly DOM — měřily tu náhradu, ne autorův kód, a třináct mutací
// `search.js` jim zůstalo neviditelných. Teď:
//
//   červená — `open()` bez worktree: stránka je nasazená produkce (starý kód),
//             kontrola musí PADAT,
//   zelená  — `open({ worktree: ROOT })`: stránce se naservírují SKUTEČNÉ soubory
//             z tohohle stromu včetně index.html, kontrola musí PROJÍT.
//
// Body R1.1 mají červenou třetí: pruh „No results for" je celý nový v téhle dávce,
// takže se proti produkci nedá zčervenat. Jejich starým kódem je kód PRVNÍHO KOLA,
// naservírovaný stejnou cestou — viz `postavPredOpravou()` níž.
//
// Jediné, co se do stránky podstrkává, jsou odpovědi SERVERU (`page.route` na
// `/api/...`) tam, kde se měřený stav na produkci nedá vyvolat — výpadek providera,
// pořad s jedinou epizodou. To je vstup, ne náhrada měřeného kódu: pod ním běží
// v obou polovinách kód té které strany.
//
// Spuštění:  node tests/e2e/audit/search.mjs [phone|tablet|desktop] [S1 S2 …]
//
// Na produkci se jen čte: nic se nestahuje, nemaže ani nenastavuje. Jediná zapisující
// akce je S14 (klik na přehrát v zelené polovině) — zapíše frontu vlastního
// `ms_device_id`, nic sdíleného.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, search, makeReport } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const ROOT = process.env.MS_TREE || '/home/lucas/music-seeker';

// ── třetí orákulum: strom PŘED opravou R1.1 ────────────────────────────────
// Pruh „No results for" nasazená produkce vůbec nekreslí — je celý nový v téhle
// dávce. Překlep tedy proti produkci zčervenat NEJDE a prohlásit ho za „bez
// červené" by znamenalo tvrdit nález bez důkazu. Červenou proto dělá kód, ve
// kterém review ten pruh naměřilo: první kolo téhle dávky. Není to náhrada
// vložená do stránky — je to kopie stromu s vrácenými třemi řádky, kterou
// serveWorktree naservíruje stejně jako kterýkoli jiný soubor.
const PRED_OPRAVOU = [
  ["const words = [...new Set(_normName(q).split(' ').filter(w => w.length > 1))];",
   "const words = new Set(_normName(q).split(' ').filter(w => w.length > 1));"],
  ['if (!words.length || !items.length) return false;',
   'if (!words.size || !items.length) return false;'],
  [".split(' ').some(w => words.some(qw => _sharesOpening(qw, w))));",
   ".split(' ').some(w => words.has(w)));"],
];

function postavPredOpravou() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-c1-pred-'));
  fs.cpSync(path.join(ROOT, 'static'), path.join(dir, 'static'), { recursive: true });
  const f = path.join(dir, 'static', 'js', 'search.js');
  let src = fs.readFileSync(f, 'utf8');
  for (const [po, pred] of PRED_OPRAVOU) {
    const kolik = src.split(po).length - 1;
    if (kolik !== 1) throw new Error(`kotva pro strom před opravou sedí ${kolik}× místo 1×: ${po}`);
    src = src.replace(po, pred);
  }
  fs.writeFileSync(f, src);
  return dir;
}

const DEVICE = 'autor2-4-c1';
const Q = 'daft punk';
const NONSENSE = 'zzzqqqxyznotathing12345';

// Překlepy z R1.1: dotaz, který se od správné odpovědi liší o písmeno, nesmí
// dostat „No results for" nad kartu toho, co uživatel hledal.
const TYPOS = [
  { id: 'R1.1a', q: 'beyonse', type: 'artist', kdo: 'Beyoncé' },
  { id: 'R1.1b', q: 'thriler', type: 'album', kdo: 'Thriller' },
  { id: 'R1.1c', q: 'michaell jacksonn', type: 'all', kdo: 'Michael Jackson' },
];

// Zástupný obrázek Deezeru: prázdný hash v cestě (/images/artist//500x500-…).
// Je to platná adresa, která se načte, takže prázdné pole netestuje nic.
const PLACEHOLDER_RE = '/\\/images\\/[a-z]+\\/\\/\\d+x\\d+/';

// Skladba z fixtury `zz-audit-fixture` (4 skladby, jen se čte). Řádek z knihovny
// tím vzniká SKUTEČNĚ přes checkLibrary(), ne vyrobením značky v DOM.
const LIB_Q = 'daft punk one more time';

// ── drobné pomůcky ──────────────────────────────────────────────────────────

async function emptySearch(page) {
  // Prázdné pole se prázdným polem přepsat nejde — `input` by se nevyvolal a
  // obrazovka by zůstala na tom, co je na ní (třeba na žánrovém žebříčku).
  const back = await page.$('#genreBack');
  if (back) { await back.click(); await page.waitForTimeout(1500); }
  if (!(await page.$('.genre-tile'))) {
    await page.fill('#searchInput', 'x');
    await page.waitForTimeout(300);
    await page.fill('#searchInput', '');
    await page.waitForTimeout(2200);
  }
  await page.waitForSelector('.genre-tile', { timeout: 20000 });
}

// Provider občas odpoví prázdno, když na něj jde dotaz za dotazem. Prázdná
// stránka by udělala z kontroly planý poplach v obou směrech, takže se dotaz
// opakuje, dokud něco nevrátí.
async function searchFor(page, q, type, sel = '#searchResults .card') {
  for (let i = 0; i < 3; i++) {
    await search(page, q, type);
    try { await page.waitForSelector(sel, { timeout: 9000 }); return true; } catch {}
    await page.waitForTimeout(4000);
  }
  throw new Error(`provider nevrátil nic pro "${q}" (${type || 'all'}) ani na třetí pokus`);
}

async function heroQuery(page) {
  // Hrdinka musí být interpret (S14 a S12 ji měří). "daft punk" ji tak vrací;
  // kdyby ne, zkusí se druhý dotaz, ať kontrola neměří jiný typ karty.
  for (const q of [Q, 'enya', Q]) {
    await searchFor(page, q, 'all', '.top-result-card');
    if (await page.$('.top-result-card.artist-card')) return q;
  }
  throw new Error('hrdinka interpreta se nepodařilo dostat na stránku');
}

// ── kontroly ────────────────────────────────────────────────────────────────
// prep: dostane stránku do měřeného stavu. assert: vrátí { ok, detail }.
// Obojí běží DVAKRÁT: jednou nad produkcí (musí padnout), jednou nad stránkou
// servírovanou z worktree (musí projít). `red: false` = půlka, která platí
// i na starém kódu. `greenSkip` = zelenou nad tímhle stromem doložit nejde (mez).

const checks = [

{
  id: 'W0',
  popis: 'orákulum: zelená polovina běží na souborech z worktree, a jen jednou',
  viewports: ['phone', 'tablet', 'desktop'],
  // Běží jen v zelené polovině: tvrdí o orákulu samotném, ne o produktu, takže
  // „na produkci padá" by u něj nedávalo smysl. Že je červená polovina opravdu
  // nasazený kód, si ověřuje sám — stažením téhož souboru z produkce.
  red: false,
  prep: async () => {},
  assert: async ({ page }) => {
    const nasazeny = await (await fetch(`${process.env.MS_URL || 'https://musicseeker.hanaktech.org'}/static/js/search.js`)).text();
    const prodMarker = /_MATCH_PREFIX/.test(nasazeny) || /Object\.keys\(errors\)\.length/.test(nasazeny);
    const r = await page.evaluate(async () => {
      // Nejdřív moduly, teprve pak vlastní fetch — ten by si do seznamu přidal
      // vlastní položku bez razítka a kontrola by hlásila dvojí načtení.
      const mods = performance.getEntriesByType('resource')
        .filter((e) => e.initiatorType === 'script' && /\/static\/js\/.+\.js/.test(e.name))
        .map((e) => e.name.replace(/^https?:\/\/[^/]+/, ''));
      const bezRazitka = mods.filter((n) => !/\?v=/.test(n));
      const cesty = mods.map((n) => n.split('?')[0]);
      const dvakrat = [...new Set(cesty.filter((n, i) => cesty.indexOf(n) !== i))];
      const src = await (await fetch('/static/js/search.js')).text();
      return {
        marker: /_MATCH_PREFIX/.test(src) && /_sharesOpening/.test(src),
        errorsInEmpty: /Object\.keys\(errors\)\.length/.test(src),
        modulu: mods.length, dvakrat, bezRazitka,
      };
    });
    return {
      ok: r.marker && r.errorsInEmpty && !prodMarker
        && r.modulu > 5 && !r.dvakrat.length && !r.bezRazitka.length,
      detail: `zelená strana nese opravy R1.1/R1.2: ${r.marker}/${r.errorsInEmpty}, nasazená produkce je nenese: ${!prodMarker}, modulů ${r.modulu}, dvakrát ${JSON.stringify(r.dvakrat)}, bez razítka ${JSON.stringify(r.bezRazitka)}`,
    };
  },
},

{
  id: 'S3',
  popis: 'karta interpreta nemá jako podtitulek vlastní jméno',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => { await searchFor(page, Q, 'artist'); },
  assert: async ({ page }) => {
    const same = await page.evaluate(() => [...document.querySelectorAll('#searchResults .card')]
      .filter((c) => {
        const t = c.querySelector('.card-title'), s = c.querySelector('.card-sub');
        return t && s && t.textContent.trim() && t.textContent.trim() === s.textContent.trim();
      }).length);
    return { ok: same === 0, detail: `karet s podtitulkem == název: ${same}` };
  },
},

{
  id: 'S6',
  popis: 'tab Artists: žádná zástupná dlaždice ani duplicitní jméno',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => { await searchFor(page, Q, 'artist'); },
  assert: async ({ page }) => {
    const r = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc.slice(1, reSrc.lastIndexOf('/')), reSrc.slice(reSrc.lastIndexOf('/') + 1));
      const cards = [...document.querySelectorAll('#searchResults .card')];
      const names = cards.map((c) => (c.querySelector('.card-title')?.textContent || '').trim());
      const dup = names.length - new Set(names.filter(Boolean).map((n) => n.toLowerCase())).size;
      const credit = cards.filter((c, i) => re.test(c.querySelector('.card-img')?.getAttribute('src') || '')
        && names[i].includes(',')).length;
      const firstReal = cards.length ? !re.test(cards[0].querySelector('.card-img')?.getAttribute('src') || '') : false;
      const ph = cards.filter((c) => re.test(c.querySelector('.card-img')?.getAttribute('src') || '')).length;
      return { dup, credit, firstReal, ph, total: cards.length };
    }, PLACEHOLDER_RE);
    return {
      ok: r.total > 0 && r.dup === 0 && r.credit === 0 && r.firstReal,
      detail: `karet ${r.total}, duplicit ${r.dup}, credit-entity ${r.credit}, první karta má skutečný obrázek: ${r.firstReal} (zástupných celkem ${r.ph})`,
    };
  },
},

{
  id: 'S10',
  popis: 'jednotné číslo u jedné epizody',
  viewports: ['desktop'],
  prep: async ({ page }) => {
    // Pořad s jedinou epizodou se na produkci nedá spolehlivě najít, takže se
    // podstrčí odpověď SERVERU — vykresluje ji pořád kód té které strany.
    await page.route('**/api/search?*type=show*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ results: [{ id: 'zz1', type: 'show', name: 'Jednodílný pořad', artist: 'Studio', total_tracks: 1, image: '' }] }),
    }));
    await searchFor(page, 'podcast', 'show');
  },
  assert: async ({ page }) => {
    const txt = await page.evaluate(() => document.querySelector('#searchResults .card .card-meta')?.textContent.trim() || '');
    return { ok: /\b1 episode\b/.test(txt) && !/\b1 episodes\b/.test(txt), detail: `card-meta: "${txt}"` };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/search?*type=show*'); },
},

{
  id: 'S13',
  popis: 'tlačítko rádia kreslí ikonu, ne emoji',
  viewports: ['desktop'],
  prep: async ({ page }) => { await searchFor(page, Q, 'album'); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const b = document.querySelector('#searchResults .card .card-radio-btn');
      if (!b) return null;
      return { svg: !!b.querySelector('svg'), text: b.textContent.trim() };
    });
    if (!r) return { ok: false, detail: 'žádné .card-radio-btn na stránce' };
    return { ok: r.svg && r.text === '', detail: `svg: ${r.svg}, textový obsah: ${JSON.stringify(r.text)}` };
  },
},

{
  id: 'S7',
  popis: 'nesmyslný dotaz se přizná',
  viewports: ['desktop'],
  prep: async ({ page }) => { await searchFor(page, NONSENSE, 'all', '#searchResults .card, #searchResults .song-row'); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => ({
      note: !!document.querySelector('#searchResults .no-match-note'),
      cards: document.querySelectorAll('#searchResults .card').length,
    }));
    return { ok: r.note, detail: `řádek "No results for": ${r.note}, karet pod ním: ${r.cards}` };
  },
},

{
  id: 'S7b',
  popis: 'smysluplný dotaz řádek "No results for" nemá',
  viewports: ['desktop'],
  red: false,   // tahle půlka platí i na starém kódu; hlídá, že S7 nestřílí všude
  prep: async ({ page }) => { await searchFor(page, Q, 'all', '.top-result-card'); },
  assert: async ({ page }) => {
    const note = await page.evaluate(() => !!document.querySelector('#searchResults .no-match-note'));
    return { ok: !note, detail: `řádek přítomen: ${note}` };
  },
},

// ── R1.1: překlep není „nenalezeno" ────────────────────────────────────────
// Jeden tvar pro tři dotazy. Každý z nich na produkci vrátí správnou odpověď
// a NAD NÍ pruh „No results for X" — přesně to, co review naměřilo.
...TYPOS.map(({ id, q, type, kdo }) => ({
  id,
  popis: `překlep "${q}" nedostane "No results" nad kartou ${kdo}`,
  viewports: ['desktop'],
  redNa: 'pred',   // produkce pruh nekreslí vůbec; červenou dělá kód prvního kola
  prep: async ({ page }) => {
    await searchFor(page, q, type, '#searchResults .card, #searchResults .song-row, .top-result-card');
  },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => ({
      note: !!document.querySelector('#searchResults .no-match-note'),
      cards: document.querySelectorAll('#searchResults .card').length,
      prvni: (document.querySelector('.top-result-name, #searchResults .card .card-title')?.textContent || '').trim(),
    }));
    return {
      ok: !r.note && (r.cards > 0 || !!r.prvni),
      detail: `pruh "No results for": ${r.note}, karet ${r.cards}, první: "${r.prvni}"`,
    };
  },
})),

// ── R1.2: částečný výpadek s prázdnou větví tracks ─────────────────────────
{
  id: 'R1.2',
  popis: 'tři větve spadlé a čtvrtá prázdná je výpadek, ne "No results found"',
  viewports: ['desktop'],
  prep: async ({ page }) => {
    await page.route('**/api/search/all*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        query: Q, top: null, tracks: [], artists: [], albums: [], playlists: [],
        errors: { artist: 'provider_unavailable', album: 'timeout', playlist: 'timeout' },
      }),
    }));
    await search(page, Q, 'all');
    await page.waitForTimeout(2500);
  },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const el = document.querySelector('#searchResults');
      return {
        strips: el ? el.querySelectorAll('.section-error').length : 0,
        retry: el ? el.querySelectorAll('.section-error .retry-btn').length : 0,
        nic: /No results found/.test(el?.innerText || ''),
      };
    });
    // Proužek, který nejde zopakovat, je jen jiné znění téhož mlčení: klikne se
    // na Try again a čeká se na nový dotaz na /api/search/all.
    let znovu = 0;
    if (r.retry) {
      const onReq = (q) => { if (/\/api\/search\/all/.test(q.url())) znovu++; };
      page.on('request', onReq);
      await page.click('#searchResults .section-error .retry-btn');
      await page.waitForTimeout(2500);
      page.off('request', onReq);
    }
    return {
      ok: r.strips === 3 && r.retry === 3 && !r.nic && znovu > 0,
      detail: `proužků ${r.strips}, Try again ${r.retry}, "No results found": ${r.nic}, dotazů po kliknutí ${znovu}`,
    };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/search/all*'); },
},

{
  id: 'S14',
  popis: 'hrdinka interpreta má tlačítko přehrát a pustí jeho top skladby',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page, state }) => { state.q = await heroQuery(page); },
  assert: async ({ page }) => {
    const has = await page.evaluate(() => !!document.querySelector('.top-result-card.artist-card .card-play-btn'));
    if (!has) return { ok: false, detail: 'hrdinka interpreta nemá .card-play-btn' };
    const seen = [];
    const onReq = (r) => { if (/\/api\/artist\/[^/]+\/top/.test(r.url())) seen.push(r.url()); };
    page.on('request', onReq);
    await page.locator('.top-result-card.artist-card .card-play-btn').scrollIntoViewIfNeeded();
    await page.click('.top-result-card.artist-card .card-play-btn');
    await page.waitForTimeout(4000);
    page.off('request', onReq);
    // Natažení samo o sobě nic nedokazuje — skladba se musí dostat do přehrávače.
    const hraje = await page.evaluate(() => {
      // Lišta je `position: fixed` (player.css:5), takže `offsetParent` je u ní
      // null i když je vidět — sdílený kontrakt o offsetParent platí na vrstvy
      // v toku, ne na tuhle. Měří se zobrazení a skutečná výška.
      const bar = document.querySelector('#playerBar');
      const b = bar ? bar.getBoundingClientRect() : null;
      return {
        bar: !!bar && getComputedStyle(bar).display !== 'none' && !!b && b.height > 0,
        titul: (document.querySelector('#playerTitle')?.textContent || '').trim(),
      };
    });
    return {
      ok: seen.length > 0 && hraje.bar && !!hraje.titul,
      detail: `požadavků na /api/artist/{id}/top: ${seen.length}, lišta přehrávače: ${hraje.bar}, hraje: "${hraje.titul}"`,
    };
  },
},

{
  id: 'S12',
  popis: 'akce hrdinky leží uvnitř obalu, ne vedle něj',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => {
    await searchFor(page, NONSENSE, 'all', '.top-result-card');
    const both = await page.evaluate(() => {
      const c = document.querySelector('.top-result-card');
      return !!(c && c.querySelector('.card-radio-btn') && c.querySelector('.card-addpl-btn'));
    });
    // Hrdinka nesmyslného dotazu je skladba; když nemá obě tlačítka, vezme se
    // hrdinka interpreta, ať se měří karta se všemi třemi sloty.
    if (!both) await heroQuery(page);
  },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const card = document.querySelector('.top-result-card');
      if (!card) return null;
      const art = card.querySelector('.top-result-img').getBoundingClientRect();
      const out = [];
      ['.card-radio-btn', '.card-addpl-btn'].forEach((sel) => {
        const b = card.querySelector(sel);
        if (!b) return;
        const r2 = b.getBoundingClientRect();
        const inside = r2.left >= art.left - 1 && r2.right <= art.right + 1
          && r2.bottom <= art.bottom + 1 && r2.top >= art.bottom - 56;
        out.push({ sel, inside, left: Math.round(r2.left), right: Math.round(r2.right), artLeft: Math.round(art.left), artRight: Math.round(art.right) });
      });
      return out;
    });
    if (!r) return { ok: false, detail: 'hrdinka není na stránce' };
    if (!r.length) return { ok: false, detail: 'hrdinka nemá radio ani add tlačítko' };
    return { ok: r.every((x) => x.inside), detail: JSON.stringify(r) };
  },
},

{
  id: 'S8',
  popis: 'řádek z knihovny má viditelnou značku a nezkracuje název',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => {
    // Fixtura `zz-audit-fixture` drží „One More Time" od Daft Punk, takže značku
    // navěsí skutečné checkLibrary() — v DOM se nic nevyrábí.
    await searchFor(page, LIB_Q, 'track', '#searchResults .song-row');
    await page.waitForSelector('#searchResults .song-row.in-library', { timeout: 15000 });
  },
  assert: async ({ page, state }) => {
    const r = await page.evaluate(() => {
      const lib = [...document.querySelectorAll('#searchResults .song-row')]
        .find((x) => x.classList.contains('in-library'));
      if (!lib) return null;
      const badge = lib.querySelector('.in-library-badge');
      const b = badge ? badge.getBoundingClientRect() : null;
      return {
        badgeWidth: b ? Math.round(b.width) : 0,
        badgeVidet: !!badge && badge.offsetParent !== null && !!b && b.width > 0 && b.height > 0,
        info: Math.round(lib.querySelector('.song-info').getBoundingClientRect().width),
        titul: (lib.querySelector('.song-title')?.textContent || '').trim(),
      };
    });
    if (!r) return { ok: false, detail: 'nenašel se řádek z knihovny' };
    // Šířka názvu na starém kódu je měřítko: značka ho nesmí zkrátit.
    if (state.infoBefore == null) state.infoBefore = r.info;
    return {
      ok: r.badgeVidet && r.info >= state.infoBefore,
      detail: `značka vidět: ${r.badgeVidet} (${r.badgeWidth}px), šířka názvu ${r.info}px (na starém kódu ${state.infoBefore}px), řádek "${r.titul}"`,
    };
  },
},

{
  id: 'S11',
  popis: 'pořadí na řádku je ♡, délka, ⋯',
  viewports: ['tablet', 'desktop'],   // na 390 px je srdce skryté (search.css)
  prep: async ({ page }) => { await searchFor(page, Q, 'track', '#searchResults .song-row'); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const row = document.querySelector('#searchResults .song-row');
      if (!row) return null;
      const x = (sel) => {
        const e = row.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return b.width ? Math.round(b.left) : null;
      };
      return { heart: x('.like-btn'), dur: x('.song-duration'), kebab: x('.kebab-btn') };
    });
    if (!r) return { ok: false, detail: 'žádný .song-row' };
    const ok = r.heart != null && r.dur != null && r.kebab != null && r.heart < r.dur && r.dur < r.kebab;
    return { ok, detail: `x srdce ${r.heart}, délka ${r.dur}, kebab ${r.kebab}` };
  },
},

{
  id: 'S1',
  popis: 'přepnutí tabu zavře otevřený detail interpreta',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => {
    await searchFor(page, Q, 'all', '.top-result-card');
    // Klik na hrdinku interpreta otevře detail; na kartu, ne na její tlačítka.
    await page.click('.top-result-card .top-result-name');
    await page.waitForTimeout(3000);
    await page.click('.type-btn[data-type="album"]');
    // Na nasazeném kódu zůstane detail přes výsledky, takže se karty vykreslí do
    // skrytého seznamu — proto `attached`, ne `visible`. Bez tohohle čekání měřil
    // bod rychlost providera: na 390 px dorazily karty až po 3,5 s a zelená padla
    // na `cards: 0`, přestože se detail zavřel a výsledky byly vidět.
    await page.waitForSelector('#searchResults .card', { state: 'attached', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const d = document.querySelector('#artistDetail');
      const res = document.querySelector('#searchResults');
      return {
        detailVisible: !!d && d.offsetParent !== null,
        resultsVisible: !!res && res.offsetParent !== null,
        cards: res ? res.querySelectorAll('.card').length : 0,
      };
    });
    return { ok: !r.detailVisible && r.resultsVisible && r.cards > 0, detail: JSON.stringify(r) };
  },
},

{
  id: 'S2',
  popis: 'nekonečný scroll mlčí, dokud je přes výsledky detail',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page }) => {
    await searchFor(page, Q, 'album');
    await page.click('#searchResults .card .card-title');
    await page.waitForSelector('#albumDetail', { state: 'attached' });
    await page.waitForTimeout(3000);
  },
  assert: async ({ page }) => {
    const hits = [];
    const onReq = (r) => { if (/\/api\/search\?/.test(r.url())) hits.push(r.url()); };
    page.on('request', onReq);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
    }
    page.off('request', onReq);
    const visible = await page.evaluate(() => {
      const d = document.querySelector('#albumDetail');
      return !!d && d.offsetParent !== null;
    });
    return { ok: visible && hits.length === 0, detail: `detail alba vidět: ${visible}, požadavků na /api/search: ${hits.length}` };
  },
},

{
  id: 'S5',
  popis: 'Zpět v žánrovém žebříčku vrátí dlaždice',
  viewports: ['phone', 'tablet', 'desktop'],
  // Větev `store.genreOpen` v `handlePopstate` je bod N14, tedy celek 3. Tenhle
  // strom vystavuje `closeGenre(fromPopstate)` a příznak, ale volat je má router.
  // Zelená se proto měří až nad spojeným stromem (R1.3) — vyrobit si tady vlastní
  // posluchač by znamenalo vrátit se přesně k tomu, co review zakázalo.
  greenSkip: 'větev v handlePopstate je N14 (celek 3); měří se nad spojeným stromem',
  prep: async ({ page }) => {
    await emptySearch(page);
    await page.click('.genre-tile');
    await page.waitForSelector('#genreBack', { timeout: 20000 });
    await page.waitForTimeout(2000);
  },
  assert: async ({ page }) => {
    await page.goBack();
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.genre-tile').length,
      chart: !!document.querySelector('#genreBack'),
    }));
    return { ok: r.tiles > 0 && !r.chart, detail: `dlaždic ${r.tiles}, žebříček pořád otevřený: ${r.chart}` };
  },
},

{
  id: 'S9',
  popis: 'poslední hledání jsou vidět bez fokusu a dají se mazat',
  viewports: ['phone', 'tablet', 'desktop'],
  prep: async ({ page, state }) => {
    state.seed = ['alpha one', 'beta two', 'gamma three'];
    await page.evaluate((seed) => {
      const u = (JSON.parse(localStorage.getItem('ms_user') || 'null') || {}).username;
      localStorage.setItem('ms_recent_searches', JSON.stringify(seed));
      localStorage.setItem(`ms_recent_searches_${u || 'claude_test'}`, JSON.stringify(seed));
    }, state.seed);
    await emptySearch(page);
    await page.focus('#searchInput');
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#searchInput').blur());
    await page.waitForTimeout(600);
  },
  assert: async ({ page, state }) => {
    const r = await page.evaluate(() => {
      const wrap = document.querySelector('#recentSearches');
      return {
        chips: !!wrap && wrap.offsetParent !== null,
        items: document.querySelectorAll('#searchResults .recent-list .recent-item').length,
      };
    });
    if (r.chips || r.items !== state.seed.length) {
      return { ok: false, detail: `čipy při fokusu viditelné: ${r.chips}, položek v #searchResults: ${r.items} (čekáno ${state.seed.length})` };
    }
    await page.click('#searchResults .recent-list .recent-item .recent-item-del');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => {
      const u = (JSON.parse(localStorage.getItem('ms_user') || 'null') || {}).username || 'claude_test';
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(`ms_recent_searches_${u}`)) || []; } catch {}
      return { items: document.querySelectorAll('#searchResults .recent-list .recent-item').length, stored: stored.length };
    });
    return {
      ok: after.items === state.seed.length - 1 && after.stored === state.seed.length - 1,
      detail: `po křížku položek ${after.items}, v localStorage ${after.stored} (čekáno ${state.seed.length - 1})`,
    };
  },
},

{
  id: 'S4',
  popis: 'výpadek /api/genres není prázdná stránka',
  viewports: ['desktop'],
  prep: async ({ page }) => {
    await page.route('**/api/genres*', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: '{}' }));
    await page.evaluate(() => {
      Object.keys(localStorage).filter((k) => k.startsWith('ms_search_')).forEach((k) => localStorage.removeItem(k));
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
  },
  assert: async ({ page }) => {
    // „Něco tam je a je tam tlačítko" nestačí: seznam posledních hledání (S9)
    // obojí splní sám o sobě. Měří se hláška a vlastní #browseRetry.
    const r = await page.evaluate(() => {
      const el = document.querySelector('#searchResults');
      const btn = el?.querySelector('#browseRetry');
      return {
        hlaska: /Could not load the genre list/.test(el?.innerText || ''),
        btn: !!btn && (btn.textContent || '').trim() === 'Try again',
        text: (el?.innerText || '').trim().replace(/\s+/g, ' '),
      };
    });
    return { ok: r.hlaska && r.btn, detail: `hláška: ${r.hlaska}, #browseRetry: ${r.btn}, text "${r.text.slice(0, 80)}"` };
  },
  // Druhá půlka: po odebrání 502 a kliknutí na Zkusit znovu se dlaždice objeví.
  after: async ({ page, rep }) => {
    await page.unroute('**/api/genres*');
    await page.click('#browseRetry');
    await page.waitForTimeout(5000);
    const tiles = await page.evaluate(() => document.querySelectorAll('.genre-tile').length);
    rep.check('S4-retry', 'Zkusit znovu dotáhne dlaždice', tiles > 0, `dlaždic ${tiles}`);
  },
},

{
  id: 'S4b',
  popis: 'výpadek všech větví hledání nabídne Zkusit znovu',
  viewports: ['desktop'],
  prep: async ({ page }) => {
    await page.route('**/api/search/all*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        query: Q, top: null, tracks: [], artists: [], albums: [], playlists: [],
        errors: { track: 'provider_unavailable', artist: 'provider_unavailable', album: 'timeout', playlist: 'timeout' },
      }),
    }));
    await search(page, Q, 'all');
    await page.waitForTimeout(2000);
  },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const el = document.querySelector('#searchResults');
      const text = (el?.innerText || '').trim().replace(/\s+/g, ' ');
      return {
        hlaska: /Search is unavailable right now/.test(text),
        btn: !!el?.querySelector('#browseRetry'),
        nic: /No results found/.test(text),
        text,
      };
    });
    return { ok: r.hlaska && r.btn && !r.nic, detail: `hláška: ${r.hlaska}, #browseRetry: ${r.btn}, text "${r.text.slice(0, 80)}"` };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/search/all*'); },
},

];

// ── běh ─────────────────────────────────────────────────────────────────────
// Dvě sezení vedle sebe: jedno na nasazené produkci, jedno na souborech z tohohle
// stromu. Každý bod se měří v obou — stejná `prep`, stejná `assert`, jiný kód pod nimi.

async function half(c, sez, nazev, state) {
  const ctx = { page: sez.page, context: sez.context, rep: sez.rep, state, half: nazev };
  try {
    await c.prep(ctx);
    return { r: await c.assert(ctx), ctx };
  } finally {
    if (c.cleanup) await c.cleanup(ctx).catch(() => {});
  }
}

async function run(vpName, only) {
  const rep = makeReport(`search.mjs @ ${vpName}`);
  const bezi = checks.filter((c) => (!only.length || only.includes(c.id)) && c.viewports.includes(vpName));
  const prod = await open({ viewport: vpName, device: `${DEVICE}-${vpName}-prod` });
  const wt = await open({ viewport: vpName, device: `${DEVICE}-${vpName}-wt`, worktree: ROOT });
  // Třetí sezení se otevírá, jen když ho některý z běžících bodů potřebuje.
  const chcePred = bezi.some((c) => c.red !== false && c.redNa === 'pred');
  const predDir = chcePred ? postavPredOpravou() : null;
  const pred = predDir
    ? await open({ viewport: vpName, device: `${DEVICE}-${vpName}-pred`, worktree: predDir })
    : null;
  prod.rep = rep; wt.rep = rep; if (pred) pred.rep = rep;
  try {
    for (const c of checks) {
      if (only.length && !only.includes(c.id)) continue;
      if (!c.viewports.includes(vpName)) { rep.skip(c.id, c.popis, `neměří se na ${vpName}`); continue; }
      const state = {};
      if (c.red !== false) {
        const sez = c.redNa === 'pred' ? pred : prod;
        const kde = c.redNa === 'pred' ? 'na kódu prvního kola' : 'na produkci';
        try {
          const { r } = await half(c, sez, 'cervena', state);
          rep.check(`${c.id}-cervena`, `${c.popis} — ${kde} padá`, !r.ok, r.detail);
        } catch (e) {
          rep.check(`${c.id}-cervena`, c.popis, false, `výjimka: ${e.message}`);
        }
        await sez.page.waitForTimeout(1200);
      }
      try {
        const { r, ctx } = await half(c, wt, 'zelena', state);
        if (c.greenSkip) rep.skip(`${c.id}-zelena`, `${c.popis} — naměřeno ${r.ok ? 'PROŠLO' : 'PADLO'}: ${r.detail}`, c.greenSkip);
        else rep.check(`${c.id}-zelena`, `${c.popis} — nad soubory z worktree projde`, r.ok, r.detail);
        if (c.after && !c.greenSkip) await c.after(ctx);
      } catch (e) {
        rep.check(`${c.id}-zelena`, c.popis, false, `výjimka: ${e.message}`);
      }
      await wt.page.waitForTimeout(1200);   // ať na providera nejde dotaz za dotazem
    }
  } finally {
    if (prod.errors.length) console.log(`chyby stránky (produkce): ${JSON.stringify(prod.errors.slice(0, 5))}`);
    if (wt.errors.length) console.log(`chyby stránky (worktree): ${JSON.stringify(wt.errors.slice(0, 5))}`);
    if (pred && pred.errors.length) console.log(`chyby stránky (první kolo): ${JSON.stringify(pred.errors.slice(0, 5))}`);
    await prod.browser.close();
    await wt.browser.close();
    if (pred) await pred.browser.close();
    if (predDir) fs.rmSync(predDir, { recursive: true, force: true });
  }
  return rep.done();
}

const vp = process.argv[2] || 'desktop';
const only = process.argv.slice(3);
run(vp, only).then((ok) => { process.exitCode = ok ? 0 : 1; });
