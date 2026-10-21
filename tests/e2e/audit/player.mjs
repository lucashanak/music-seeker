// Kontroly k celku 2 (přehrávač a fronta) z UX auditu — notes/impl/audit-2026-10/player.md.
//
// Každá kontrola se pouští DVAKRÁT proti téže živé instanci:
//   node tests/e2e/audit/player.mjs --vp=desktop               … nasazený kód (musí PADAT)
//   node tests/e2e/audit/player.mjs --vp=desktop --worktree    … tenhle strom (musí PROJÍT)
//
// Zelenou polovinu dělá `open({ worktree })` ze sdíleného postroje: stránce se
// naservírují SKUTEČNÉ soubory z worktree včetně index.html, s cache-bust razítkem
// přečteným z živé stránky. V prvním kole si tenhle soubor vkládal do stránky vlastní
// náhradní posluchač a měřil tím tu náhradu — žádná změna v autorově kódu ho nemohla
// zčervenat. Tady do stránky nic nevkládáme: běží můj kód, nebo nasazený.
//
// `--worktree=<cesta>` obslouží jiný strom. Tím se dokládá červená polovina u nálezů
// review (R2.*), které jsou vadou PRVNÍHO KOLA — nasazený kód je nemá, protože nemá
// ani opravu, do které se vloudily.
//
// Backend, data i účet zůstávají produkční. Na produkci se jen čte a přehrává: nic se
// nestahuje, nezakládá ani nemaže se cizí playlist. Jediné, do čeho se zapisuje, je
// odkládací fronta tohohle zařízení (`__upnext_e2e-autor2-4-c2-*`), kterou kontroly
// samy vytvořily přehráním skladeb.

import { open, search, swipe, makeReport } from './helpers.mjs';

const args = process.argv.slice(2);
const VP = (args.find(a => a.startsWith('--vp=')) || '--vp=desktop').slice(5);
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice(7);
const wtArg = args.find(a => a === '--worktree' || a.startsWith('--worktree='));
const WORKTREE = wtArg
  ? (wtArg.includes('=') ? wtArg.slice('--worktree='.length) : (process.env.MS_TREE || '/home/lucas/music-seeker'))
  : null;

// ── Společné kroky ──────────────────────────────────────────────────────────

/** Pustí první skladbu z výsledků hledání; vrátí její název. */
async function playSomething(page, q = 'daft punk') {
  await search(page, q, 'track');
  await page.click('.card .card-play-btn');
  await page.waitForFunction(() => document.body.classList.contains('player-active')
    && (document.querySelector('#playerTitle')?.textContent || '').length > 0, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page.textContent('#playerTitle');
}

const title = (page) => page.evaluate(() => document.querySelector('#playerTitle')?.textContent || '');

// Programový klik. Nesmí se použít tam, kde se měří dosažitelnost prvku (P1) —
// jinde je nutný: s otevřenou frontou je právě P1 to, co ukazatelský klik na lištu
// na starém kódu nepustí, a kontroly P2/P3 by pak padaly na cizí nález.
const clickJs = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (e) e.click(); }, sel);


async function openQueue(page) {
  const already = await page.evaluate(() => !!document.querySelector('#queuePanel')?.classList.contains('open'));
  if (already) return;
  await page.click('#playerQueueBtn');
  await page.waitForTimeout(900);
}

async function rows(page, sel = '#queueList') {
  return page.$$eval(`${sel} .queue-item`, els => els.map(e => ({
    qi: e.dataset.qi,
    now: e.classList.contains('now-playing'),
    title: e.querySelector('.qi-title')?.textContent || '',
  })));
}

// ── Běh ─────────────────────────────────────────────────────────────────────

const r = makeReport(`player ${VP} ${WORKTREE ? 'WORKTREE ' + WORKTREE : 'PROD'}`);
const want = (id) => !ONLY || ONLY.split(',').includes(id);

// Postroj si k názvu dráhy připíná předponu `e2e-`, takže ms_device_id je
// `e2e-autor2-4-c2-<rozlišení>`; každé rozlišení má vlastní, aby si tři souběžné
// dráhy nepřepisovaly frontu.
const { browser, context, page } = await open({
  viewport: VP,
  device: `autor2-4-c2-${VP}`,
  worktree: WORKTREE,
});

try {
  await page.waitForTimeout(1500);

  // Odznak, který dorazí později, se měří v okamžiku VLOŽENÍ: nejbližší překreslení
  // řádku ho přesune do správného slotu, takže pohled „až potom" vadu nevidí, i když
  // ji uživatel na obrazovce zahlédne. Pozorovatel proto běží od začátku relace.
  await page.evaluate(() => {
    window.__bpmSlots = [];
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || !n.classList || !n.classList.contains('qi-bpm')) continue;
        const row = n.closest('.queue-item');
        if (!row) continue;
        const kids = [...row.children];
        window.__bpmSlots.push({
          bpm: kids.indexOf(n),
          like: kids.findIndex(e => e.classList.contains('like-btn')),
          kebab: kids.findIndex(e => e.classList.contains('kebab-btn')),
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  await playSomething(page);

  // ── P16 — odznak BPM patří před srdce, i když dorazí později ───────────────
  if (want('P16')) {
    if (VP === 'phone') {
      r.skip('P16', 'slot BPM odznaku', 'na 390 px neprovokováno — .qi-bpm je podle P7 skrytý');
    } else {
      await page.waitForTimeout(12000); // líný dotaz: 1 s odklad + dotazy po 200 ms // lazy fetch: 1 s odklad + dotazy po 200 ms
      const slots = await page.evaluate(() => window.__bpmSlots || []);
      const bad = slots.filter(s => (s.like >= 0 && s.bpm > s.like) || (s.kebab >= 0 && s.bpm > s.kebab));
      if (!slots.length) r.skip('P16', 'slot BPM odznaku', 'žádný řádek odznak nedostal');
      else r.check('P16', 'každý odznak BPM leží před srdcem i kebabem', bad.length === 0,
        `${slots.length} odznaků, mimo slot ${bad.length}`);
    }
    await clickJs(page, '#queuePanelClose');
    await page.waitForTimeout(500);
  }

  // ── P1 — s otevřenou frontou musí jít ovládat lišta ────────────────────────
  if (want('P1')) {
    await openQueue(page);
    const hit = await page.evaluate(() => {
      const b = document.querySelector('#playerPlayPause');
      const box = b.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { id: el?.id || '', inBar: !!el?.closest('#playerBar') };
    });
    r.check('P1.a', 'střed #playerPlayPause patří liště, ne backdropu', hit.inBar, `elementFromPoint=${hit.id || '(bez id)'}`);

    let clicked = true;
    const before = await page.evaluate(() => document.querySelector('#audioElement').paused);
    try {
      await page.click('#playerPlayPause', { timeout: 4000 });
    } catch { clicked = false; }
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => ({
      paused: document.querySelector('#audioElement').paused,
      queueOpen: document.querySelector('#queuePanel').classList.contains('open'),
    }));
    r.check('P1.b', 'klik na Play/Pause projde a přepne stav', clicked && after.paused !== before,
      `klik=${clicked} paused ${before}→${after.paused}`);
    r.check('P1.c', 'fronta po kliknutí zůstává otevřená', after.queueOpen, `#queuePanel.open=${after.queueOpen}`);
    // zpět do hry
    await page.evaluate(() => { const a = document.querySelector('#audioElement'); if (a.paused) a.play().catch(() => {}); });
    await clickJs(page, '#queuePanelClose');
    await page.waitForTimeout(600);
  }

  // ── R2.4 — lišta ani panel fronty nesmí zůstat nad velkým přehrávačem ─────
  // Oprava P1 zvedla lištu nad backdrop (z-index 250). Klepnutí na obal v liště
  // otevře velký přehrávač (201) — a lišta i panel (250) by nad ním zůstaly:
  // uživatel vidí dva přehrávače přes sebe.
  if (want('R2.4')) {
    await openQueue(page);
    let opened = true;
    try {
      await page.click('#playerImg', { timeout: 5000 });
    } catch { opened = false; }
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => {
      const fp = document.querySelector('#fullPlayer');
      const bar = document.querySelector('#playerBar');
      const b = bar.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return {
        fpOpen: !!fp && fp.classList.contains('open'),
        queueOpen: !!document.querySelector('#queuePanel')?.classList.contains('open'),
        barLifted: bar.classList.contains('queue-open'),
        topAtBar: hit ? (hit.closest('#fullPlayer') ? '#fullPlayer'
          : hit.closest('#playerBar') ? '#playerBar'
          : hit.closest('#queuePanel') ? '#queuePanel'
          : hit.id || hit.className || '?') : '(nic)',
      };
    });
    r.check('R2.4.a', 'klepnutí na obal v liště otevře velký přehrávač i s otevřenou frontou',
      opened && st.fpOpen, `klik=${opened} #fullPlayer.open=${st.fpOpen}`);
    r.check('R2.4.b', 'malý panel fronty se přitom zavře', !st.queueOpen && !st.barLifted,
      `#queuePanel.open=${st.queueOpen} .queue-open=${st.barLifted}`);
    r.check('R2.4.c', 'v místě lišty je navrchu velký přehrávač, ne lišta', st.topAtBar === '#fullPlayer',
      `elementFromPoint(střed lišty)=${st.topAtBar}`);
    if (st.fpOpen) { await clickJs(page, '#fpClose'); await page.waitForTimeout(700); }
    await page.evaluate(() => { const b = document.querySelector('#queuePanelClose'); if (b) b.click(); });
    await page.waitForTimeout(500);
  }

  // ── P6 — velký přehrávač musí být neprůhledný ──────────────────────────────
  if (want('P6')) {
    const alphas = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#fullPlayer'));
      const txt = `${cs.backgroundImage} ${cs.backgroundColor}`;
      return (txt.match(/rgba\([^)]*?,\s*([0-9.]+)\)/g) || []).map(s => parseFloat(s.slice(s.lastIndexOf(',') + 1)));
    });
    const translucent = alphas.filter(a => a < 1);
    r.check('P6', 'pozadí velkého přehrávače nemá průsvitnou vrstvu', translucent.length === 0,
      `alfy<1: ${translucent.join(',') || 'žádné'}`);
  }

  // ── P7 — řádek fronty na telefonu ──────────────────────────────────────────
  if (want('P7')) {
    await openQueue(page);
    const vis = await page.evaluate(() => {
      const row = document.querySelector('#queueList .queue-item');
      if (!row) return null;
      const d = (sel) => { const e = row.querySelector(sel); return e ? getComputedStyle(e).display : 'chybí'; };
      return { remove: d('.qi-remove'), info: row.querySelector('.qi-info')?.getBoundingClientRect().width || 0 };
    });
    if (!vis) r.skip('P7', 'řádek fronty', 'fronta je prázdná');
    else if (VP === 'phone') {
      r.check('P7', 'pod 640 px je ✕ na řádku skrytý (kebab odebírá)', vis.remove === 'none',
        `display(.qi-remove)=${vis.remove}, šířka .qi-info=${Math.round(vis.info)}px`);
    } else {
      r.check('P7', 'nad 640 px ✕ na řádku zůstává', vis.remove !== 'none',
        `display(.qi-remove)=${vis.remove}, šířka .qi-info=${Math.round(vis.info)}px`);
    }
    await clickJs(page, '#queuePanelClose');
    await page.waitForTimeout(500);
  }

  // ── P14 — Save as playlist i v telefonních panelech ────────────────────────
  if (want('P14')) {
    await openQueue(page);
    const save = await page.evaluate(() => {
      const b = document.querySelector('#queuePanel #queuePanelSave');
      return { present: !!b, visible: !!b && b.offsetParent !== null, text: b?.textContent || '' };
    });
    r.check('P14.a', 'malý panel fronty nabízí uložení fronty', save.visible,
      `#queuePanelSave present=${save.present} visible=${save.visible} "${save.text}"`);
    await clickJs(page, '#queuePanelClose');
    await page.waitForTimeout(500);
  }

  // ── P9/P10/P11/P12/P15 — velký přehrávač ──────────────────────────────────
  await page.click('#playerImg');
  await page.waitForTimeout(900);

  if (want('P10')) {
    const src = await page.textContent('.fp-source');
    r.check('P10', 'hlavička velkého přehrávače říká, odkud se hraje',
      /playing from/i.test(src || ''), `.fp-source="${(src || '').trim()}"`);
  }

  if (want('P9')) {
    const rm = await page.evaluate(() => {
      const f = document.querySelector('#fpRemoveFromPlaylist');
      const p = document.querySelector('#playerRemoveFromPlaylist');
      const badge = document.querySelector('#fpPlaylistBadge');
      return {
        fp: f ? getComputedStyle(f).display : 'chybí',
        bar: p ? getComputedStyle(p).display : 'chybí',
        mode: badge ? badge.textContent : '',
        glyph: !!f && f.classList.contains('pl-remove-btn'),
      };
    });
    const isUpNext = (rm.mode || '').trim() === 'Up Next';
    if (!isUpNext) r.skip('P9', 'odebrání z playlistu v Up Next', `aktivní playlist je "${rm.mode}", ne Up Next`);
    else {
      r.check('P9.a', 'v Up Next se „odebrat z playlistu" nenabízí', rm.fp === 'none' && rm.bar === 'none',
        `fp=${rm.fp} bar=${rm.bar} playlist="${rm.mode}"`);
      r.check('P9.b', 'tlačítko odebrání má vlastní glyf a varovnou barvu', rm.glyph,
        `.pl-remove-btn=${rm.glyph}`);
    }
  }

  if (want('P12')) {
    const has = await page.evaluate(() => !!document.querySelector('#fpKebab'));
    r.check('P12.a', 'hrající skladba má v přehrávači ⋯ menu', has, `#fpKebab=${has}`);
    if (has) {
      await page.click('#fpKebab');
      await page.waitForTimeout(500);
      const menu = await page.evaluate(() => !!document.querySelector('.ctx-menu'));
      r.check('P12.b', 'klepnutí na ⋯ otevře kontextové menu', menu, `.ctx-menu=${menu}`);
      // Zavřít klikem MIMO menu, ne Escapem. Escape nad ctx-menu zavře i velký
      // přehrávač (contextmenu.js:_onEsc nezastavuje bublání, router pak sáhne na
      // store.fullPlayerOpen) a v prvním kole tím devět dalších kontrol neběželo.
      // Na žádnou položku menu se neklepe — vedle „Add to other playlist" je
      // „Download", který na produkci skutečně stahuje.
      await page.click('.fp-source', { force: true });
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => ({
        menu: !!document.querySelector('.ctx-menu'),
        fp: !!document.querySelector('#fullPlayer')?.classList.contains('open'),
      }));
      r.check('P12.c', 'klik mimo menu ho zavře', !after.menu, `.ctx-menu=${after.menu}`);
      r.check('P12.d', 'velký přehrávač je pořád otevřený', after.fp, `#fullPlayer.open=${after.fp}`);
    }
  }

  if (want('P15')) {
    await page.evaluate(() => localStorage.getItem('ms_player_engine'));
    await page.click('#fpDjPanelBtn');
    await page.waitForTimeout(700);
    const drawer = await page.evaluate(() => ({
      engine: localStorage.getItem('ms_player_engine') || 'classic',
      title: (document.querySelector('.fp-dj-title')?.textContent || '').trim(),
      btn: document.querySelector('#fpDjPanelBtn')?.getAttribute('title') || '',
      selectVisible: !!document.querySelector('#fpPlayerEngine')
        && document.querySelector('#fpPlayerEngine').offsetParent !== null,
    }));
    if (drawer.engine === 'dj') r.skip('P15', 'zásuvka v klasickém enginu', 'aktivní engine je dj');
    else {
      r.check('P15.a', 'v klasickém enginu se zásuvka jmenuje Player', drawer.title === 'Player',
        `nadpis="${drawer.title}"`);
      r.check('P15.b', 'popisek tlačítka odpovídá obsahu', drawer.btn === 'Player settings', `title="${drawer.btn}"`);
      r.check('P15.c', 'zásuvka obsahuje viditelný výběr enginu', drawer.selectVisible, `#fpPlayerEngine=${drawer.selectVisible}`);
    }
    await clickJs(page, '#fpDjPanelClose');
    await page.waitForTimeout(400);
  }

  // ── P8 — gesto „švihni nahoru pro frontu" ve spodní části ─────────────────
  if (want('P8')) {
    if (VP === 'desktop') {
      r.skip('P8', 'gesto pro frontu', 'desktopová dráha nemá dotyk');
    } else {
      const box = await page.evaluate(() => {
        const r0 = document.querySelector('#fpPlayerSide').getBoundingClientRect();
        return { top: r0.top, h: r0.height, x: r0.left + r0.width / 2 };
      });
      for (const frac of [0.80, 0.90]) {
        await page.evaluate(() => { const p = document.querySelector('#fpQueuePanel'); p && p.classList.remove('open'); });
        const fromY = box.top + box.h * frac;
        await swipe(context, page, { x: box.x, fromY, toY: fromY - 120 });
        const open1 = await page.evaluate(() => !!document.querySelector('#fpQueuePanel')?.classList.contains('open'));
        r.check(`P8.${frac}`, `švihnutí nahoru z ${frac * 100} % výšky otevře frontu`, open1, `#fpQueuePanel.open=${open1}`);
        if (open1) { await clickJs(page, '#fpQueuePanelClose'); await page.waitForTimeout(600); }
      }
      // regrese, kterou hlídáme: krátké klepnutí na Play/Pause musí dál pauzovat
      const was = await page.evaluate(() => document.querySelector('#audioElement').paused);
      await page.click('#fpPlayPause');
      await page.waitForTimeout(600);
      const now = await page.evaluate(() => document.querySelector('#audioElement').paused);
      r.check('P8.tap', 'krátké klepnutí na #fpPlayPause dál přepíná přehrávání', now !== was, `paused ${was}→${now}`);
      await page.evaluate(() => { const a = document.querySelector('#audioElement'); if (a.paused) a.play().catch(() => {}); });
    }
  }

  // Velký přehrávač zavřít, ať nepřekrývá stránku dalším bodům.
  await clickJs(page, '#fpClose');
  await page.waitForTimeout(700);

  // ── P11 — z hrající skladby rovnou na interpreta ──────────────────────────
  if (want('P11')) {
    await page.click('#playerArtist');
    // Rozlišení jména na interpreta je jedno síťové volání navíc; měří se, kam
    // navigace vede, ne jak rychle.
    await page.waitForFunction(() => {
      const d = document.querySelector('#artistDetail');
      return !!d && d.offsetParent !== null;
    }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const nav = await page.evaluate(() => {
      const d = document.querySelector('#artistDetail');
      return {
        artistDetail: !!d && d.offsetParent !== null,
        computed: d ? getComputedStyle(d).display : 'chybí',
        name: document.querySelector('#artistDetailName')?.textContent || '',
        page: document.querySelector('#pageSearch') ? getComputedStyle(document.querySelector('#pageSearch')).display : '?',
        searchBox: document.querySelector('#searchInput')?.value || '',
      };
    });
    r.check('P11', 'klepnutí na interpreta otevře jeho detail, ne vyhledávání', nav.artistDetail,
      `#artistDetail viditelný=${nav.artistDetail} display=${nav.computed} jméno="${nav.name}" #pageSearch=${nav.page} #searchInput="${nav.searchBox}"`);
    await page.evaluate(() => {
      const b = document.querySelector('#artistDetail .back-btn, #artistDetail button');
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
  }

  // ── Body, které nejsou o rozložení: jen na desktopu ───────────────────────
  if (VP !== 'desktop') {
    r.skip('P2', 'pořadí shuffle', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('P3', 'autoplay do fronty', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('P4', 'Next na poslední skladbě', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('P5', 'shuffle a repeat po reloadu', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('P13', 'přetažení nad hrající skladbu', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('P17', 'česká hláška', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('R2.1', 'Previous v autoplay ocasu', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('R2.2', 'Previous se shuffle a prázdnou historií', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('R2.3', 'smazání řádku ve shuffle', 'kontrola není o rozložení — běží na 1280x900');
    r.skip('R2.5', 'ruční výběr doporučení', 'kontrola není o rozložení — běží na 1280x900');
  } else {
    // ── P17 — hláška o kolizi jména ─────────────────────────────────────────
    if (want('P17')) {
      const src = await page.evaluate(async () => (await fetch('/static/js/queue.js')).text());
      r.check('P17', 'fronta nemá českou hlášku v anglickém UI', !/už existuje/.test(src),
        /už existuje/.test(src) ? 'nalezeno: „už existuje — zvol jiný název"' : 'žádný český řetězec');
    }

    // ── P5 — shuffle a repeat přežijí reload ────────────────────────────────
    if (want('P5')) {
      await page.evaluate(() => { localStorage.removeItem('ms_shuffle'); localStorage.removeItem('ms_repeat_mode'); });
      await page.click('#playerShuffle');
      await page.click('#playerRepeat');
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => ({
        sh: document.querySelector('#playerShuffle').classList.contains('active'),
        rp: document.querySelector('#playerRepeat').classList.contains('active'),
      }));
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(6000);
      const after = await page.evaluate(() => ({
        sh: document.querySelector('#playerShuffle').classList.contains('active'),
        rp: document.querySelector('#playerRepeat').classList.contains('active'),
      }));
      r.check('P5', 'shuffle i repeat se po načtení stránky obnoví',
        before.sh && before.rp && after.sh && after.rp,
        `před reloadem sh=${before.sh} rp=${before.rp}, po reloadu sh=${after.sh} rp=${after.rp}`);
      // Vrátit do výchozího stavu — repeat 'all' by jinak ve stejném běhu přepsal
      // terminální větev fronty, kterou měří P3.
      await page.evaluate(() => {
        localStorage.removeItem('ms_shuffle');
        localStorage.removeItem('ms_repeat_mode');
        const rp = document.querySelector('#playerRepeat');
        for (let i = 0; i < 3 && rp && rp.classList.contains('active'); i++) rp.click();
        const sh = document.querySelector('#playerShuffle');
        if (sh && sh.classList.contains('active')) sh.click();
      });
      await page.waitForTimeout(500);
    }

    // ── P2 — shuffle hraje to, co panel ukazuje; Previous je historie ───────
    if (want('P2')) try {
      await playSomething(page, 'daft punk');
      await page.evaluate(() => {
        const sh = document.querySelector('#playerShuffle');
        if (!sh.classList.contains('active')) sh.click();
      });
      await page.waitForTimeout(600);
      await openQueue(page);
      // Fronta roste, dokud se donačítají výsledky hledání; ustálit ji, ať se
      // neporovnává proti pořadí, které mezitím přibyl řádek přepočítal.
      let n = 0;
      for (let i = 0; i < 12; i++) {
        const m = (await rows(page)).length;
        if (m === n && m > 5) break;
        n = m;
        await page.waitForTimeout(2500);
      }

      // ── R2.2 — Previous se zapnutým shuffle a PRÁZDNOU historií ───────────
      // Permutační historie je paměť modulu: prázdná je hned po zapnutí shuffle
      // a po každém načtení stránky. V prvním kole v tom stavu Previous nedělalo
      // vůbec nic, protože nová větev neměla záložní cestu a stála před původní.
      if (n > 3) {
        await page.evaluate(() => {
          const sh = document.querySelector('#playerShuffle');
          if (sh.classList.contains('active')) sh.click();   // vypnout
        });
        await page.waitForTimeout(400);
        // Lineárně na 4. řádek, aby bylo kam couvat.
        const list0 = await rows(page);
        await page.evaluate(() => {
          const it = document.querySelectorAll('#queueList .queue-item')[3];
          if (it) it.click();
        });
        await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '').trim() === t,
          list0[3].title.trim(), { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(1500);
        // Teprve teď zapnout shuffle — historie je prázdná.
        await page.evaluate(() => {
          const sh = document.querySelector('#playerShuffle');
          if (!sh.classList.contains('active')) sh.click();
          try { document.querySelector('#audioElement').currentTime = 0; } catch {}
        });
        await page.waitForTimeout(600);
        const wasPrev = await title(page);
        await clickJs(page, '#playerPrev');
        await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
          wasPrev, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const gotPrev = await title(page);
        r.check('R2.2', 'Previous se zapnutým shuffle a prázdnou historií není mrtvé tlačítko',
          gotPrev.trim() !== wasPrev.trim(), `„${wasPrev}" → „${gotPrev}"`);
      } else {
        r.skip('R2.2', 'Previous se zapnutým shuffle', `fronta má jen ${n} skladeb`);
      }
      await page.evaluate(() => {
        const sh = document.querySelector('#playerShuffle');
        if (!sh.classList.contains('active')) sh.click();
      });
      await page.waitForTimeout(500);
      // Předpověď, ne rekonstrukce. První kolo porovnávalo pozice až PO přeskoku —
      // mutace, která ocas při každém vykreslení znovu zamíchá, tím projde zeleně,
      // protože „o jeden řádek dál" platí i v nově zamíchaném pořadí. Proto se
      // PŘED každým Next zapamatuje titulek řádku hned pod značkou „hraje" a po
      // Next se porovná s tím, co opravdu hraje.
      const forward = [];
      let mismatch = null;
      let races = 0;
      let predicted = 0;
      for (let i = 0; i < 5; i++) {
        const before = await rows(page);
        const posNowBefore = before.findIndex(x => x.now);
        const expect = posNowBefore >= 0 && posNowBefore + 1 < before.length
          ? before[posNowBefore + 1].title : null;
        const was = await title(page);
        await clickJs(page, '#playerNext');
        await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
          was, { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(1800);
        const now = await title(page);
        forward.push(now);
        if (expect === null) { races++; continue; }
        predicted++;
        if (mismatch === null && expect.trim() !== now.trim()) {
          mismatch = `krok ${i + 1}: panel slíbil „${expect}", zahrálo „${now}"`;
        }
      }
      r.check('P2.a', 'to, co panel ukazuje jako další, je to, co se opravdu zahraje',
        mismatch === null && predicted >= 4,
        mismatch || `${predicted}/5 kroků předpovězeno správně (fronta ${n} skladeb)`);

      // Druhá polovina téže vady: pořadí ocasu musí být STABILNÍ. Panel se
      // překreslí dvakrát (zavřít a znovu otevřít) a porovná se titulek po titulku.
      const snap1 = (await rows(page)).map(x => x.title);
      await clickJs(page, '#queuePanelClose');
      await page.waitForTimeout(600);
      await openQueue(page);
      const snap2 = (await rows(page)).map(x => x.title);
      await clickJs(page, '#queuePanelClose');
      await page.waitForTimeout(400);
      await openQueue(page);
      const snap3 = (await rows(page)).map(x => x.title);
      const stable = snap1.join('|') === snap2.join('|') && snap2.join('|') === snap3.join('|');
      const firstDiff = snap1.findIndex((t, k) => t !== snap2[k]);
      r.check('P2.d', 'pořadí ocasu se při překreslení panelu nemění', stable,
        stable ? `${snap1.length} řádků, tři vykreslení shodná`
               : `první rozdíl na ${firstDiff + 1}. řádku: „${snap1[firstDiff]}" vs „${snap2[firstDiff]}"`);

      r.check('P2.b', 'pět přeskoků dá pět různých skladeb', new Set(forward).size === 5,
        `${new Set(forward).size}/5 různých: ${forward.join(' | ')}`);

      const back = [];
      for (let i = 0; i < 5; i++) {
        // Previous se do 3 s od začátku skladby chová jako „na začátek" — posuň čas.
        await page.evaluate(() => { try { document.querySelector('#audioElement').currentTime = 0; } catch {} });
        const was = await title(page);
        await clickJs(page, '#playerPrev');
        await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
          was, { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(1500);
        back.push(await title(page));
      }
      const wantBack = forward.slice(0, 4).reverse();
      const okBack = back.slice(0, 4).join('|') === wantBack.join('|');
      r.check('P2.c', 'pět návratů jde přesně obrácenou cestou', okBack,
        `zpět: ${back.join(' | ')}  ⟵ čekáno: ${wantBack.join(' | ')}`);

      // ── R2.3 — smazání řádku nesmí přeskládat zbytek ocasu ────────────────
      // Permutace držená nad POZICEMI se po smazání přepočítala celá: z 49 zbylých
      // řádků byl téměř každý jinde. Maže se jen z odkládací fronty tohohle
      // zařízení, kterou kontrola sama vytvořila přehráním skladeb.
      const beforeDel = await rows(page);
      const nowPos = beforeDel.findIndex(x => x.now);
      const victimPos = nowPos + 3;
      if (victimPos < beforeDel.length - 1) {
        const victim = beforeDel[victimPos].title;
        await page.evaluate((pos) => {
          const it = document.querySelectorAll('#queueList .queue-item')[pos];
          const rm = it && it.querySelector('.qi-remove');
          if (rm) rm.click();
        }, victimPos);
        await page.waitForTimeout(1500);
        const afterDel = (await rows(page)).map(x => x.title);
        const expectDel = beforeDel.map(x => x.title);
        expectDel.splice(victimPos, 1);
        const same = afterDel.join('|') === expectDel.join('|');
        const diffAt = expectDel.findIndex((t, k) => t !== afterDel[k]);
        r.check('R2.3.a', 'smazání řádku nechá pořadí zbytku fronty beze změny', same,
          same ? `smazáno „${victim}", zbylých ${afterDel.length} řádků ve stejném pořadí`
               : `první rozdíl na ${diffAt + 1}. řádku: čekáno „${expectDel[diffAt]}", je „${afterDel[diffAt]}"`);

        // A pořadí po smazání pořád platí: další Next zahraje řádek pod značkou.
        const rowsNow = await rows(page);
        const pN = rowsNow.findIndex(x => x.now);
        if (pN >= 0 && pN + 1 < rowsNow.length) {
          const expect = rowsNow[pN + 1].title;
          const was2 = await title(page);
          await clickJs(page, '#playerNext');
          await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
            was2, { timeout: 25000 }).catch(() => {});
          await page.waitForTimeout(1800);
          const got2 = await title(page);
          r.check('R2.3.b', 'i po smazání hraje engine to, co panel slibuje',
            expect.trim() === got2.trim(), `panel slíbil „${expect}", zahrálo „${got2}"`);
        } else {
          r.skip('R2.3.b', 'pořadí po smazání', 'značka „hraje" je na posledním řádku');
        }
      } else {
        r.skip('R2.3', 'smazání řádku ve shuffle', `fronta je příliš krátká (${beforeDel.length} řádků)`);
      }
      await page.evaluate(() => {
        const sh = document.querySelector('#playerShuffle');
        if (sh.classList.contains('active')) sh.click();
      });
      await clickJs(page, '#queuePanelClose');
      await page.waitForTimeout(600);
    } catch (e) { r.check('P2', 'kontrola doběhla', false, String((e && e.message) || e).split('\n')[0]); }

    // ── P13 — nad hrající skladbu se přetahovat nedá ────────────────────────
    if (want('P13')) try {
      await openQueue(page);
      const list0 = await rows(page);
      if (list0.length < 4) r.skip('P13', 'cíl přetažení', 'fronta je kratší než 4 skladby');
      else {
        const moved = await page.evaluate(() => {
          const list = document.querySelector('#queueList');
          const items = [...list.querySelectorAll('.queue-item')];
          const src = items[3], dst = items[0];
          const handle = src.querySelector('.qi-drag');
          const sb = handle.getBoundingClientRect();
          const db = dst.getBoundingClientRect();
          const ev = (type, y) => handle.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch',
            clientX: sb.left + 4, clientY: y,
          }));
          ev('pointerdown', sb.top + sb.height / 2);
          ev('pointermove', db.top + 2);
          ev('pointerup', db.top + 2);
          return [...document.querySelectorAll('#queueList .queue-item')].map(e => e.querySelector('.qi-title').textContent);
        });
        await page.waitForTimeout(900);
        const list1 = await rows(page);
        const nowFirst = list1.length ? list1[0].title : '';
        r.check('P13', 'skladba se nedá přetáhnout nad právě hrající',
          nowFirst === list0[0].title, `první řádek „${list0[0].title}" → „${nowFirst}" (${moved.length} řádků)`);
      }
      await clickJs(page, '#queuePanelClose');
      await page.waitForTimeout(500);
    } catch (e) { r.check('P13', 'kontrola doběhla', false, String((e && e.message) || e).split('\n')[0]); }

    // ── P3/P4 — konec fronty: co hraje, je ve frontě ────────────────────────
    if (want('P3') || want('P4')) try {
      await playSomething(page, 'daft punk');
      // Doporučovač se načítá až při otevření panelu (onPanelOpened). Bez toho by
      // „konec fronty" měřil prázdnou stanici, ne to, co se s jejím výsledkem stane.
      await clickJs(page, '#playerImg');
      await page.waitForFunction(() => document.querySelectorAll('.rec-item').length > 0,
        null, { timeout: 90000 }).catch(() => {});
      const recs = await page.evaluate(() => document.querySelectorAll('.rec-item').length);
      await clickJs(page, '#fpClose');
      await page.waitForTimeout(800);
      await openQueue(page);
      // Poslední řádek fronty — tím je splněná podmínka „konec fronty" bez mazání
      // čehokoli z Up Next účtu.
      await page.evaluate(() => {
        const items = [...document.querySelectorAll('#queueList .queue-item')];
        const last = items[items.length - 1];
        if (last && !last.classList.contains('now-playing')) last.click();
      });
      await page.waitForTimeout(6000);
      if (!recs) {
        r.skip('P3', 'konec fronty', 'doporučovač nevrátil ani jednu skladbu — není co doplnit');
        r.skip('P4', 'Next na poslední skladbě', 'doporučovač nevrátil ani jednu skladbu');
      } else {
        const was = await title(page);
        const beforeRows = (await rows(page)).length;
        await clickJs(page, '#playerNext');
        await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
          was, { timeout: 40000 }).catch(() => {});
        await page.waitForTimeout(4000);
        const after = await rows(page);
        const playing = await title(page);
        const np = after.find(x => x.now);
        const sep = await page.evaluate(() => !!document.querySelector('#queueList .qi-autoplay-sep'));

        r.check('P4', 'Next na poslední skladbě opravdu něco zahraje', playing !== was,
          `„${was}" → „${playing}"`);
        r.check('P3.a', 'doplněná skladba je ve frontě', after.length === beforeRows + 1,
          `řádků ${beforeRows} → ${after.length}`);
        r.check('P3.b', 'značka „hraje" sedí na tom, co hraje', !!np && np.title === playing,
          `now-playing=„${np ? np.title : '(žádná)'}" vs titulek=„${playing}"`);
        r.check('P3.c', 'automaticky doplněné skladby odděluje „Autoplay"', sep, `.qi-autoplay-sep=${sep}`);

        // ── R2.1 — Previous v autoplay ocasu ───────────────────────────────
        // V prvním kole vzal Previous větev „hraje doporučení" a jen znovu načetl
        // AKTUÁLNÍ index: skladbu restartoval místo návratu. Ten reload navíc
        // shodil kurzor doporučovače, takže následující Next zahrál týž tip znovu
        // a zapsal duplicitu do fronty uživatele.
        if (after.length === beforeRows + 1) {
          const tailTitle = playing;
          await page.evaluate(() => { try { document.querySelector('#audioElement').currentTime = 0; } catch {} });
          await clickJs(page, '#playerPrev');
          await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
            tailTitle, { timeout: 25000 }).catch(() => {});
          await page.waitForTimeout(2500);
          const back1 = await title(page);
          const rowsBack = await rows(page);
          r.check('R2.1.a', 'Previous v autoplay ocasu se vrací o skladbu zpět, nerestartuje',
            back1.trim() !== tailTitle.trim() && back1.trim() === was.trim(),
            `„${tailTitle}" → „${back1}" (čekáno „${was}")`);
          r.check('R2.1.b', 'Previous frontu nezvětší', rowsBack.length === after.length,
            `řádků ${after.length} → ${rowsBack.length}`);

          // Next z posledního vlastního řádku se vrací na už doplněný řádek —
          // je to teď běžná položka fronty, takže se NESMÍ doplnit znovu.
          await clickJs(page, '#playerNext');
          await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
            back1, { timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(3000);
          const again = await title(page);
          const rowsAgain = await rows(page);
          r.check('R2.1.c', 'Next se vrátí na týž doplněný řádek a nepřipíše duplicitu',
            again.trim() === tailTitle.trim() && rowsAgain.length === after.length,
            `hraje „${again}" (čekáno „${tailTitle}"), řádků ${rowsAgain.length}`);

          // A teprve Next z konce fronty dá NOVÝ tip.
          await clickJs(page, '#playerNext');
          await page.waitForFunction((t) => (document.querySelector('#playerTitle')?.textContent || '') !== t,
            again, { timeout: 40000 }).catch(() => {});
          await page.waitForTimeout(4000);
          const third = await title(page);
          const rows3 = (await rows(page)).map(x => x.title.trim());
          const count = (list, t) => list.filter(x => x === t).length;
          // Fronta z vyhledávání nese duplicitní názvy sama od sebe (různé edice téže
          // skladby), takže se neporovnává celý seznam — jen to, jestli PŘIBYL další
          // výskyt první doplněné skladby. To je přesně ta duplicita z nálezu.
          const beforeCount = count(after.map(x => x.title.trim()), tailTitle.trim());
          const afterCount = count(rows3, tailTitle.trim());
          r.check('R2.1.d', 'další Next z konce fronty zahraje nový tip, ne znovu ten první',
            third.trim() !== tailTitle.trim(), `první tip „${tailTitle}", druhý „${third}"`);
          r.check('R2.1.e', 'první tip se do fronty nezapsal podruhé', afterCount === beforeCount,
            `„${tailTitle}" ve frontě ${beforeCount}× → ${afterCount}×, řádků ${rows3.length}`);
        } else {
          r.skip('R2.1', 'Previous v autoplay ocasu', 'fronta se nedoplnila — není ocas, po kterém chodit');
        }

        // ── R2.5 — skladba vybraná uživatelem se nesmí připnout za oddělovač ─
        // Příznak autoplay musí patřit volajícímu. Když ho spotřebuje klepnutí
        // uživatele v panelu doporučení, připne se do fronty jeho skladba.
        await clickJs(page, '#playerImg');
        await page.waitForFunction(() => document.querySelectorAll('.rec-item').length > 0,
          null, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const recRow = await page.evaluate(() => {
          const items = [...document.querySelectorAll('.rec-item')].filter(e => !e.classList.contains('rec-playing'));
          const it = items[0];
          if (!it) return null;
          return { name: (it.querySelector('.rec-name')?.textContent || '').trim() };
        });
        if (!recRow) {
          r.skip('R2.5', 'ruční výběr doporučení', 'v panelu není žádný volný řádek doporučení');
        } else {
          const qBefore = await page.evaluate(() => (window.__msq = null, document.querySelectorAll('#fpQueueList .queue-item').length));
          await page.evaluate(() => {
            const items = [...document.querySelectorAll('.rec-item')].filter(e => !e.classList.contains('rec-playing'));
            if (items[0]) items[0].click();
          });
          await page.waitForTimeout(5000);
          const qAfter = await page.evaluate(() => [...document.querySelectorAll('#fpQueueList .queue-item')]
            .map(e => (e.querySelector('.qi-title')?.textContent || '').trim()));
          r.check('R2.5', 'doporučení spuštěné uživatelem se nepřipne do fronty',
            qAfter.length === qBefore && !qAfter.includes(recRow.name),
            `řádků ${qBefore} → ${qAfter.length}, „${recRow.name}" ve frontě: ${qAfter.includes(recRow.name)}`);
        }
        await clickJs(page, '#fpClose');
        await page.waitForTimeout(700);
        await openQueue(page);
      }
      await clickJs(page, '#queuePanelClose');
    } catch (e) { r.check('P3', 'kontrola doběhla', false, String((e && e.message) || e).split('\n')[0]); }
  }
} catch (e) {
  r.check('BĚH', 'kontrola doběhla', false, String(e && e.message || e));
} finally {
  const ok = r.done();
  await browser.close();
  process.exit(ok ? 0 : 1);
}
