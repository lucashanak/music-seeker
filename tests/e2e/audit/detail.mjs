// Celek 4 — detail interpreta a alba. Body D1–D11 z notes/impl/oprava-5-zadani.md
// ve znění notes/impl/oprava-5-dodatek-po-kritice.md (D6 je škrtnutý).
//
// Orákulum má dvě poloviny a obě běží nad TÝMŽ kódem, jaký pojede v produkci:
//
//   červená — `open()` bez worktree: stránka je nasazená produkce (1.26.0, bez
//             téhle dávky), kontrola musí PADAT,
//   zelená  — `open({ worktree: ROOT })`: postroj naservíruje stránce SKUTEČNÉ
//             soubory z tohohle stromu včetně index.html, kontrola musí PROJÍT.
//
// Do stránky se nevkládá žádná náhrada měřeného kódu — `page.addInitScript` ani
// `page.evaluate` s přepsanou funkcí tu nejsou. Jediné, co se podstrkává, jsou
// ODPOVĚDI SERVERU (`page.route` na `/api/...`): zdržení, aby šel změřit stav
// „požadavek ještě běží", a jeden seznam sledovaných interpretů, protože Spotify
// API je pro tenhle účet mrtvé a bez něj se na cestu přes searchForArtistDetail
// nedá kliknout. To je vstup, ne náhrada — pod ním běží kód té které strany.
//
// Spuštění:  node tests/e2e/audit/detail.mjs [phone|tablet|desktop] [D1 D5 …]
//
// Na produkci se jen čte: nic se nestahuje, nemaže ani nenastavuje. Knihovní
// playlist je fixtura `zz-audit-fixture` — jen se otevře.

import { open, search, goPage, makeReport } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const ROOT = process.env.MS_TREE || '/home/lucas/music-seeker-wt/oprava-5-c4-detail';
const DEVICE = 'autor2-5-c4';

// Interpret s velkým katalogem: 39 vydání, z toho studiovky i remixová EP, takže
// rozdělení diskografie má co rozdělit.
const ARTIST = 'daft punk';

// ── cesty na čtyři hrdinky ──────────────────────────────────────────────────
// Kliká se `page.click`, ne `el.click()`: karty rozlišují dlouhý stisk, a
// syntetický klik z `evaluate` jim proklouzne bez navigace.

// Detailní vrstva se novým dotazem sama nezavře — `#searchResults` pod ní
// zůstane neviditelný a klik na kartu by se nedočkal. Každá cesta proto začíná
// tím, že zavře, co je otevřené.
async function naVyhledavani(page) {
  for (let i = 0; i < 6; i++) {
    const zavrel = await page.evaluate(() => {
      const b = ['#backFromAlbum', '#backFromArtist', '#backToSearch', '#backToPlaylists', '#backToLibrary']
        .map(sel => document.querySelector(sel)).find(e => e && e.offsetParent !== null);
      if (!b) return false;
      b.click();
      return true;
    });
    if (!zavrel) break;
    await page.waitForTimeout(900);
  }
  if (!(await page.isVisible('#searchInput'))) await goPage(page, 'search');
  await page.waitForTimeout(600);
}

async function naInterpreta(page, q = ARTIST) {
  await naVyhledavani(page);
  await search(page, q, 'artist');
  await page.click('#searchResults .card');
  await page.waitForSelector('#artistDetail', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(4000);
}

async function naAlbum(page) {
  await naInterpreta(page);
  await page.click('#artistAlbums .card');
  await page.waitForSelector('#albumDetail', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(4000);
}

async function naPlaylistZVyhledavani(page) {
  await naVyhledavani(page);
  await search(page, ARTIST, 'playlist');
  await page.click('#searchResults .card');
  await page.waitForSelector('#playlistDetail', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(4000);
}

async function naKnihovniPlaylist(page) {
  await goPage(page, 'library');
  await page.evaluate(() => document.querySelector('[data-lib-tab="downloaded"]')?.click());
  await page.waitForTimeout(3500);
  await page.click('#libraryGrid .card');
  await page.waitForSelector('#libraryDetail', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(3000);
}

const HRDINKY = [
  { jmeno: 'interpret', sel: '#artistDetail', jdi: naInterpreta },
  { jmeno: 'album', sel: '#albumDetail', jdi: naAlbum },
  { jmeno: 'playlist', sel: '#playlistDetail', jdi: naPlaylistZVyhledavani },
  { jmeno: 'knihovní playlist', sel: '#libraryDetail', jdi: naKnihovniPlaylist },
];

// Tři čísla z dodatku, sekce C: přetok dokumentu, přetok hrdinky, šířka titulku.
// K nim to, co dávka ve skutečnosti mění — řada akcí místo sloupce a velký obal.
function zmerHrdinku(page, sel) {
  return page.evaluate((sl) => {
    const hero = document.querySelector(sl + ' .playlist-hero');
    if (!hero) return null;
    const d = document.documentElement;
    const info = hero.querySelector('.playlist-hero-info');
    const akce = hero.querySelector('.playlist-hero-actions');
    const obal = hero.querySelector('.playlist-hero-img');
    return {
      docPretok: d.scrollWidth - d.clientWidth,
      heroPretok: hero.scrollWidth - hero.clientWidth,
      info: info ? Math.round(info.getBoundingClientRect().width) : -1,
      smer: akce ? getComputedStyle(akce).flexDirection : '?',
      obal: obal ? Math.round(obal.getBoundingClientRect().width) : -1,
    };
  }, sel);
}

async function vsechnyHrdinky(page) {
  const out = {};
  for (const h of HRDINKY) {
    await h.jdi(page);
    out[h.jmeno] = await zmerHrdinku(page, h.sel);
  }
  return out;
}

const shrn = (m) => Object.entries(m)
  .map(([k, v]) => v ? `${k}: doc+${v.docPretok} hero+${v.heroPretok} info ${v.info} ${v.smer} obal ${v.obal}` : `${k}: CHYBÍ`)
  .join(' | ');

// ── zdržené odpovědi ────────────────────────────────────────────────────────
// Bez zdržení se stav „hrdinka je vykreslená, požadavek ještě běží" na živé
// instanci neuloví — albová odpověď chodí do půl vteřiny.

function zdrz(page, vzor, ms) {
  return page.route(vzor, async (route) => {
    await new Promise(r => setTimeout(r, ms));
    // Než zdržení doběhne, stránka už může být jinde a `unroute` hotové —
    // doručovat takovou odpověď nemá komu.
    await route.continue().catch(() => {});
  });
}

// Spotify API je pro tenhle účet mrtvé (403 bez Premium), takže záložka
// Knihovna → Spotify → Artists je prázdná a klik na kartu interpreta, který jako
// jediný vede přes searchForArtistDetail, nejde vyvolat. Podstrčí se tedy
// odpověď serveru; všechno ostatní na té cestě je skutečný kód.
const ARTIST_D2 = 'Queen';

async function sledovaniInterpreti(page) {
  await page.route('**/api/spotify/artists', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ artists: [{ id: 'sp-queen', name: ARTIST_D2, image: '', url: '' }] }),
  }));
}

async function otevriZeSledovanych(page) {
  await goPage(page, 'library');
  await page.evaluate(() => document.querySelector('[data-lib-tab="spotify"]')?.click());
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelector('.sp-tab[data-sp-tab="artists"]')?.click());
  await page.waitForSelector('#spArtistsGrid .sp-card', { timeout: 20000 });
  await page.click('#spArtistsGrid .sp-card');
}

// ── druhé kolo: vstupy pro R4.1 a R4.2 ─────────────────────────────────────

// R4.1 jede přes volajícího, který posílá ŘETĚZEC — `search.js:106`
// (`loadArtistDetail(item.id, fromPage, item.provider)`), tedy klik na kartu
// interpreta ve výsledcích hledání. To je všední cesta, ne okrajová.
// Měří se DRUHÝ otevřený interpret: celá věc je o tom, co v hrdince zůstane
// po tom předchozím, dokud běží nový požadavek.
const ARTIST_PRVNI = ARTIST;          // 'daft punk' → hrdinka „Daft Punk"
const JMENO_PRVNI = 'Daft Punk';
const ARTIST_DRUHY = 'queen';

// R4.2 potřebuje odpověď od providera, který druh vydání nepublikuje. Místo
// vymyšleného těla se vezme SKUTEČNÁ odpověď nasazeného backendu pro
// `?provider=itunes` — stáhne ji sama stránka, přihlášeným tokenem, a teprve ta
// se podstrčí jako vstup. Měřený kód je na obou polovinách ten pravý.
async function _itunesArtistId(term) {
  const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=musicArtist&limit=1`);
  const j = await r.json();
  const id = j.results?.[0]?.artistId;
  if (!id) throw new Error(`iTunes nezná interpreta ${term}`);
  return String(id);
}

async function itunesAlba(page, term) {
  const id = await _itunesArtistId(term);
  const telo = await page.evaluate(async (aid) => {
    const t = localStorage.getItem('ms_token') || '';
    const r = await fetch(`/api/artist/${aid}/albums?provider=itunes`, {
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
    if (!r.ok) throw new Error(`backend vrátil ${r.status}`);
    return await r.json();
  }, id);
  if (!telo.albums?.length) throw new Error('iTunes vrátil prázdnou diskografii');
  return telo;
}

const EMOJI_SHUFFLE = '\u{1F500}';
const EMOJI_RADIO = '\u{1F4FB}';

// ── kontroly ────────────────────────────────────────────────────────────────

const checks = [

{
  id: 'D1',
  popis: 'hrdinka: řada akcí a velký obal na všech čtyřech stránkách, bez přetoku',
  viewports: ['tablet', 'desktop'],
  prep: async () => {},
  assert: async ({ page }) => {
    const m = await vsechnyHrdinky(page);
    const ok = HRDINKY.every(h => {
      const v = m[h.jmeno];
      return v && v.docPretok <= 0 && v.heroPretok <= 0 && v.info > 120 && v.smer === 'row' && v.obal === 180;
    });
    return { ok, detail: shrn(m) };
  },
},

{
  // Telefon dělal správnou věc už před dávkou (responsive.css), takže tady není
  // co zčervenat — je to stráž proti tomu, aby obal 180 px propadl pod breakpoint
  // (naměřeno dřív v návrhu: hrdinka alba 329 → 409 px) nebo aby vznikl přetok.
  id: 'D1-telefon',
  popis: 'telefon se nemění: obal zůstává 100 px a nic nepřetéká',
  viewports: ['phone'],
  red: false,
  prep: async () => {},
  assert: async ({ page }) => {
    const m = await vsechnyHrdinky(page);
    const ok = HRDINKY.every(h => {
      const v = m[h.jmeno];
      return v && v.docPretok <= 0 && v.heroPretok <= 0 && v.smer === 'row' && v.obal === 100;
    });
    return { ok, detail: shrn(m) };
  },
},

{
  id: 'D2',
  popis: 'hrdinka interpreta nese jméno i obrázek dřív, než dojde seznam alb',
  viewports: ['desktop'],
  prep: async ({ page, state }) => {
    await naVyhledavani(page);
    await sledovaniInterpreti(page);
    await zdrz(page, '**/api/artist/*/albums*', 8000);
    await otevriZeSledovanych(page);
    await page.waitForSelector('#artistDetail', { state: 'visible', timeout: 25000 });
    // Odečítá se, dokud seznam alb ještě běží — proto skeleton, ne karty.
    state.m = await page.evaluate(() => ({
      jmeno: (document.querySelector('#artistDetailName')?.textContent || '').trim(),
      obrazek: (document.querySelector('#artistDetailImg')?.getAttribute('src') || '').slice(0, 40),
      cekaSeNaAlba: !!document.querySelector('#artistAlbums .skeleton'),
    }));
  },
  // Musí tam stát jméno TOHO interpreta, na kterého se kliklo. Pouhé „není
  // prázdné" by prošlo i na jméně, které v hrdince zbylo po předchozí stránce.
  assert: async ({ state }) => ({
    ok: state.m.jmeno === ARTIST_D2 && state.m.cekaSeNaAlba,
    detail: `jméno "${state.m.jmeno}" (čekáno "${ARTIST_D2}"), src "${state.m.obrazek}", alba ještě běží: ${state.m.cekaSeNaAlba}`,
  }),
  cleanup: async ({ page }) => {
    await page.unroute('**/api/artist/*/albums*').catch(() => {});
    await page.unroute('**/api/spotify/artists').catch(() => {});
  },
},

{
  // DRUHÉ KOLO, R4.1. Nejde o vadu produkce — produkce se tu chová SPRÁVNĚ a
  // tahle kontrola to i tvrdí (`red: 'projde'`). Padající polovina je strom
  // prvního kola, kde `o.name || ''` běželo bezpodmínečně; spouští se zvlášť
  // přes MS_TREE a je zapsaná v evidenci.
  id: 'D2-retezec',
  popis: 'volající s řetězcem: hrdinka drží předchozího interpreta, dokud běží požadavek',
  viewports: ['phone'],
  red: 'projde',
  prep: async ({ page, state }) => {
    await naInterpreta(page, ARTIST_PRVNI);
    // Hrdinka musí být opravdu dojetá, jinak se měří nedokončený první interpret.
    await page.waitForFunction(
      () => /\d+\s+albums/.test(document.querySelector('#artistDetailCount')?.textContent || ''),
      { timeout: 25000 });
    state.pred = await page.evaluate(() => ({
      jmeno: (document.querySelector('#artistDetailName')?.textContent || '').trim(),
      pocet: (document.querySelector('#artistDetailCount')?.textContent || '').trim(),
      obrazek: (document.querySelector('#artistDetailImg')?.getAttribute('src') || '').slice(0, 40),
    }));
    await naVyhledavani(page);
    await search(page, ARTIST_DRUHY, 'artist');
    // Teprve teď se zdrží síť: pomalé spojení je to jediné, co ten mezistav
    // udrží dost dlouho, aby se dal odečíst.
    await zdrz(page, '**/api/artist/**', 5000);
    state.kliknuto = await page.evaluate(() =>
      (document.querySelector('#searchResults .card .card-title')?.textContent || '').trim());
    await page.click('#searchResults .card');
    await page.waitForSelector('#artistDetail', { state: 'visible', timeout: 25000 });
    await page.waitForTimeout(1500);
    state.behem = await page.evaluate(() => ({
      jmeno: (document.querySelector('#artistDetailName')?.textContent || '').trim(),
      pocet: (document.querySelector('#artistDetailCount')?.textContent || '').trim(),
      obrazek: (document.querySelector('#artistDetailImg')?.getAttribute('src') || '').slice(0, 40),
      cekaSeNaAlba: !!document.querySelector('#artistAlbums .skeleton'),
    }));
  },
  assert: async ({ state }) => {
    const b = state.behem, p = state.pred;
    // Jiný interpret, než na kterého se dívám: jinak by „zůstalo jméno" nic
    // nedokazovalo.
    const jinyInterpret = !!state.kliknuto && state.kliknuto.toLowerCase() !== JMENO_PRVNI.toLowerCase();
    const ok = jinyInterpret && b.cekaSeNaAlba
      && b.jmeno === JMENO_PRVNI && b.jmeno === p.jmeno
      && b.pocet === p.pocet && !!b.obrazek && b.obrazek === p.obrazek;
    return {
      ok,
      detail: `kliknuto "${state.kliknuto}"; během ${JSON.stringify(b)} (předtím ${JSON.stringify(p)})`,
    };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/artist/**').catch(() => {}); },
},

{
  id: 'D3',
  popis: 'Play a Shuffle jsou na hrdince interpreta od začátku, jen zakázané',
  viewports: ['desktop'],
  prep: async ({ page, state }) => {
    await zdrz(page, '**/api/artist/*/top*', 9000);
    await naVyhledavani(page);
    await search(page, ARTIST, 'artist');
    await page.click('#searchResults .card');
    await page.waitForSelector('#artistDetail', { state: 'visible', timeout: 25000 });
    const ctiStav = () => page.evaluate(() => {
      const st = (sel) => {
        const b = document.querySelector(sel);
        if (!b) return null;
        return { je: true, vidi: b.offsetParent !== null, zakazane: b.disabled };
      };
      return { play: st('#playArtistTop'), shuffle: st('#shuffleArtistTop') };
    });
    state.behem = await ctiStav();
    await page.waitForTimeout(11000);
    state.potom = await ctiStav();
  },
  assert: async ({ state }) => {
    const b = state.behem, p = state.potom;
    const ok = !!(b.play?.vidi && b.play.zakazane && b.shuffle?.vidi && b.shuffle.zakazane
      && p.play && !p.play.zakazane && p.shuffle && !p.shuffle.zakazane);
    return { ok, detail: `během ${JSON.stringify(b)} · potom ${JSON.stringify(p)}` };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/artist/*/top*').catch(() => {}); },
},

{
  id: 'D4',
  popis: 'diskografie je rozdělená na Albums a Singles and EPs, podtitulek nese typ',
  viewports: ['desktop'],
  prep: async ({ page }) => { await naInterpreta(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const vidi = (sel) => {
        const e = document.querySelector(sel);
        return !!e && e.offsetParent !== null;
      };
      const text = (sel) => (document.querySelector(sel)?.textContent || '').trim();
      const subs = (sel) => [...document.querySelectorAll(sel + ' .card-sub')].map(e => e.textContent.trim());
      return {
        hlavaAlba: vidi('#artistAlbumsHeader') ? text('#artistAlbumsHeader') : '',
        hlavaSingly: vidi('#artistSinglesHeader') ? text('#artistSinglesHeader') : '',
        alba: document.querySelectorAll('#artistAlbums .card').length,
        singly: document.querySelectorAll('#artistSingles .card').length,
        subAlba: subs('#artistAlbums'),
        subSingly: subs('#artistSingles'),
        pocet: text('#artistDetailCount'),
        // Jen do výpisu: když provider odpoví chybou, obě mřížky jsou taky
        // prázdné a bez tohohle se to nedá odlišit od vadného rozdělení.
        chyba: !!document.querySelector('#artistAlbums .empty-state'),
      };
    });
    const albumSub = /^\d{4} · Album$/;
    const singleSub = /^\d{4} · (Single|EP)$/;
    const ok = r.hlavaAlba === 'Albums' && r.hlavaSingly === 'Singles and EPs'
      && r.alba > 0 && r.singly > 0
      && r.subAlba.every(s => albumSub.test(s))
      && r.subSingly.every(s => singleSub.test(s))
      && !r.subAlba.concat(r.subSingly).some(s => /tracks/.test(s));
    return { ok, detail: `"${r.hlavaAlba}" ${r.alba} + "${r.hlavaSingly}" ${r.singly} (${r.pocet})${r.chyba ? ', ODPOVĚĎ PROVIDERA SELHALA' : ''}; vzorky ${JSON.stringify(r.subAlba.slice(0, 2))} ${JSON.stringify(r.subSingly.slice(0, 2))}` };
  },
},

{
  // DRUHÉ KOLO, R4.2. Také regrese prvního kola, ne vada produkce — produkce
  // nic nedělí a tuhle kontrolu projde. Tělo odpovědi není vymyšlené: stáhne ho
  // sama přihlášená stránka z nasazeného backendu (`?provider=itunes`), takže
  // se měří skutečný tvar, jaký ten mapper posílá.
  id: 'D4-itunes',
  popis: 'provider bez record_type: jedna mřížka pod „Albums", ne prázdná sekce',
  viewports: ['desktop'],
  red: 'projde',
  prep: async ({ page, state }) => {
    await naVyhledavani(page);
    state.telo = await itunesAlba(page, ARTIST_DRUHY);
    await page.route('**/api/artist/*/albums*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(state.telo),
    }));
    await search(page, ARTIST_DRUHY, 'artist');
    await page.click('#searchResults .card');
    await page.waitForSelector('#artistDetail', { state: 'visible', timeout: 25000 });
    await page.waitForTimeout(4000);
  },
  assert: async ({ page, state }) => {
    const r = await page.evaluate(() => {
      const vidi = (sel) => {
        const e = document.querySelector(sel);
        return !!e && e.offsetParent !== null;
      };
      return {
        hlavaAlba: vidi('#artistAlbumsHeader') ? (document.querySelector('#artistAlbumsHeader')?.textContent || '').trim() : '',
        hlavaSinglyVidi: vidi('#artistSinglesHeader'),
        alba: document.querySelectorAll('#artistAlbums .card').length,
        singly: document.querySelectorAll('#artistSingles .card').length,
        albaVidi: vidi('#artistAlbums'),
        pocet: (document.querySelector('#artistDetailCount')?.textContent || '').trim(),
      };
    });
    const n = state.telo.albums.length;
    // Předpoklad kontroly: tahle odpověď druh vydání OPRAVDU nenese. Kdyby ho
    // iTunes jednou začalo posílat, kontrola se nesmí tvářit, že něco dokázala.
    const bezDruhu = state.telo.albums.every(a => !String(a.record_type || '').trim());
    const ok = bezDruhu && n > 0 && r.alba === n && r.singly === 0
      && r.albaVidi && r.hlavaAlba === 'Albums' && !r.hlavaSinglyVidi;
    return {
      ok,
      detail: `odpověď: ${n} alb, record_type u žádného: ${bezDruhu}; stránka: "${r.hlavaAlba}" ${r.alba} + druhá hlavička vidět ${r.hlavaSinglyVidi} / ${r.singly} karet (${r.pocet})`,
    };
  },
  cleanup: async ({ page }) => { await page.unroute('**/api/artist/*/albums*').catch(() => {}); },
},

{
  id: 'D5',
  popis: 'hlavička alba nese druh, rok, počet skladeb a celkový čas',
  viewports: ['desktop'],
  prep: async ({ page }) => { await naAlbum(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => ({
      radek: (document.querySelector('#albumDetailCount')?.textContent || '').trim(),
      delky: [...document.querySelectorAll('#albumTracks .song-duration')].map(e => e.textContent.trim()),
    }));
    // Čas se smí objevit jen tehdy, když ho má každá skladba — proto se vedle
    // řádku čte i to, že žádná délka v seznamu nechybí.
    const vse = r.delky.length > 0 && r.delky.every(d => /^\d+:\d\d$/.test(d));
    const ok = /^(Album|Single|EP) · \d{4} · \d+ songs?, \d+( hr( \d+ min)?| min)$/.test(r.radek) && vse;
    return { ok, detail: `"${r.radek}"; délek ${r.delky.length}, všechny vyplněné: ${vse}` };
  },
},

{
  id: 'D7',
  popis: 'na hrdince alba je akcentové jen Play All, Download All je druhotné',
  viewports: ['desktop'],
  prep: async ({ page }) => { await naAlbum(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const bg = (sel) => {
        const e = document.querySelector(sel);
        return e ? getComputedStyle(e).backgroundColor : '';
      };
      return { play: bg('#playAlbum'), queue: bg('#queueAlbum'), dl: bg('#downloadAlbum') };
    });
    return {
      ok: !!r.dl && r.dl === r.queue && r.dl !== r.play,
      detail: `play ${r.play}, add all ${r.queue}, download ${r.dl}`,
    };
  },
},

{
  id: 'D8',
  popis: 'Shuffle i Radio na hrdince mají ikonu, ne emoji',
  viewports: ['desktop'],
  prep: async ({ page, state }) => {
    await naInterpreta(page);
    state.radio = await page.evaluate(() => {
      const b = document.querySelector('#radioArtist');
      return b ? { text: b.textContent.trim(), svg: !!b.querySelector('svg') } : null;
    });
    await page.click('#artistAlbums .card');
    await page.waitForSelector('#albumDetail', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2500);
  },
  assert: async ({ page, state }) => {
    const shuffle = await page.evaluate(() => {
      const b = document.querySelector('#shuffleAlbum');
      return b ? { text: b.textContent.trim(), svg: !!b.querySelector('svg') } : null;
    });
    const r = state.radio;
    const ok = !!(shuffle?.svg && !shuffle.text.includes(EMOJI_SHUFFLE)
      && r?.svg && !r.text.includes(EMOJI_RADIO));
    return { ok, detail: `shuffle ${JSON.stringify(shuffle)} · radio ${JSON.stringify(r)}` };
  },
},

{
  id: 'D9',
  popis: 'Refresh app zmizel z řádku hledání, mikrofon má aria-label',
  viewports: ['phone', 'desktop'],
  prep: async ({ page }) => { await naVyhledavani(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => ({
      refresh: !!document.querySelector('#appRefreshBtn'),
      aria: document.querySelector('#micBtn')?.getAttribute('aria-label') || '',
      sirkaRady: Math.round(document.querySelector('.search-row')?.getBoundingClientRect().width || 0),
      tlacitek: document.querySelectorAll('.search-row .btn-mic').length,
      vNastaveni: !!document.querySelector('#refreshCacheBtn'),
    }));
    return {
      ok: !r.refresh && !!r.aria && r.tlacitek === 2 && r.vNastaveni,
      detail: `#appRefreshBtn ${r.refresh}, aria "${r.aria}", kulatých ${r.tlacitek}, řádek ${r.sirkaRady} px, dvojník v Nastavení ${r.vNastaveni}`,
    };
  },
},

{
  // CSS `.type-toggle` patří celku 1 vlny 1 (search.css), markup se měnit
  // nemusí — proto se tu jen měří, ne opravuje. Viz evidence, bod D10.
  id: 'D10',
  popis: 'taby hledání přetékají na telefonu do dvou řádků',
  viewports: ['phone'],
  red: false,
  greenSkip: 'CSS .type-toggle patří celku 1 vlny 1; jen naměřeno, neopravuje se tady',
  prep: async ({ page }) => { await naVyhledavani(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => {
      const box = document.querySelector('.type-toggle');
      if (!box) return null;
      const radky = new Set([...box.querySelectorAll('.type-btn')].map(b => Math.round(b.getBoundingClientRect().top)));
      return { radku: radky.size, vyska: Math.round(box.getBoundingClientRect().height), wrap: getComputedStyle(box).flexWrap };
    });
    return { ok: r?.radku === 1, detail: `řádků ${r?.radku}, výška ${r?.vyska} px, flex-wrap ${r?.wrap}` };
  },
},

{
  id: 'D11',
  popis: 'popisky zpět na stránkách tohohle celku jsou jednotné',
  viewports: ['desktop'],
  prep: async ({ page }) => { await naVyhledavani(page); },
  assert: async ({ page }) => {
    const r = await page.evaluate(() => ['#backToSearch', '#backFromArtist', '#backFromAlbum']
      .map(s => (document.querySelector(s)?.textContent || '').trim()));
    return { ok: new Set(r).size === 1 && r[0] === '← Back', detail: JSON.stringify(r) };
  },
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
  const rep = makeReport(`detail.mjs @ ${vpName}`);
  const prod = await open({ viewport: vpName, device: `${DEVICE}-${vpName}-prod` });
  const wt = await open({ viewport: vpName, device: `${DEVICE}-${vpName}-wt`, worktree: ROOT });
  prod.rep = rep; wt.rep = rep;
  try {
    for (const c of checks) {
      if (only.length && !only.includes(c.id)) continue;
      if (!c.viewports.includes(vpName)) { rep.skip(c.id, c.popis, `neměří se na ${vpName}`); continue; }
      const state = {};
      // `red: 'projde'` — bod druhého kola, který opravuje REGRESI prvního kola.
      // Produkce se u něj nesmí vydávat za červenou polovinu, protože se chová
      // správně; měří se tedy taky, ale s opačným očekáváním. Padající polovinu
      // dodává strom prvního kola přes MS_TREE (viz evidence, „Druhé kolo").
      const maProjit = c.red === 'projde';
      const pul = maProjit ? 'produkce' : 'cervena';
      if (c.red !== false) {
        try {
          const { r } = await half(c, prod, pul, state);
          rep.check(`${c.id}-${pul}`, `${c.popis} — na produkci ${maProjit ? 'prochází' : 'padá'}`,
            maProjit ? r.ok : !r.ok, r.detail);
        } catch (e) {
          rep.check(`${c.id}-${pul}`, c.popis, false, `výjimka: ${e.message}`);
        }
        await prod.page.waitForTimeout(2500);
      }
      try {
        const { r } = await half(c, wt, 'zelena', state);
        if (c.greenSkip) rep.skip(`${c.id}-zelena`, `${c.popis} — naměřeno ${r.ok ? 'PROŠLO' : 'PADLO'}: ${r.detail}`, c.greenSkip);
        else rep.check(`${c.id}-zelena`, `${c.popis} — nad soubory z worktree projde`, r.ok, r.detail);
      } catch (e) {
        rep.check(`${c.id}-zelena`, c.popis, false, `výjimka: ${e.message}`);
      }
      // Ať na providera nejde dotaz za dotazem. 1200 ms nestačilo: v plném běhu
      // desktopu dvakrát selhal seznam alb (jednou prázdné mřížky, podruhé
      // `page.click` bez karet), vždy na jiném bodu a samostatně oba prošly.
      await wt.page.waitForTimeout(2500);
    }
  } finally {
    if (prod.errors.length) console.log(`chyby stránky (produkce): ${JSON.stringify(prod.errors.slice(0, 5))}`);
    if (wt.errors.length) console.log(`chyby stránky (worktree): ${JSON.stringify(wt.errors.slice(0, 5))}`);
    await prod.browser.close();
    await wt.browser.close();
  }
  return rep.done();
}

const vp = process.argv[2] || 'desktop';
const only = process.argv.slice(3);
run(vp, only).then((ok) => { process.exitCode = ok ? 0 : 1; });
