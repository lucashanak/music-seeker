// Přejímka: Knihovna → Mixes. Hledání DJ setů napříč SoundCloudem, YouTube,
// Mixcloudem a hearthis.at s odznakem kvality, výchozí filtr (≥ 128 kbps,
// ≥ 20 min) a počet skrytých, sledování DJe, stažení, přehrání a smazání.
//
//   node tests/e2e/audit/mixes_page.mjs                 # vše, včetně stažení jednoho mixu
//   node tests/e2e/audit/mixes_page.mjs --no-download   # bez stažení (nic nezapíše do knihovny)
//   node tests/e2e/audit/mixes_page.mjs --tree          # stránka ze stromu (serveWorktree)
//
// Běží na účtu claude_test. Sledování, které skript založí, na konci zruší.
// Stažený mix smaže přes UI (a kdyby to selhalo, vypíše, co po něm zůstalo).
import { open, VIEWPORTS, goPage } from './helpers.mjs';

const QUERY = 'zouk mix';
const args = new Set(process.argv.slice(2));
const worktree = args.has('--tree') ? process.cwd() : null;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + detail : ''}`);
  return !!ok;
};

const api = (page, path, opts = {}) => page.evaluate(async ({ path, opts }) => {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ms_token') },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, { path, opts });

async function openMixesTab(page) {
  await goPage(page, 'library');
  await page.evaluate(() => {
    const b = document.querySelector('#libraryTabs .sp-tab[data-lib-tab="mixes"]');
    if (!b) throw new Error('záložka Mixes chybí');
    b.click();
  });
  // The tab's module loads on first use; on a cold browser cache with the server
  // busy that took over 800 ms (measured: tablet saw the bare HTML selects, 0 / 0,
  // and a search button with no handler yet). Wait for the tab to be initialised.
  await page.waitForFunction(() => document.querySelector('#mixMinKbps')?.dataset.ready === '1'
    || (document.querySelector('#mixSearchBtn') && document.querySelector('#mixMinKbps')?.value !== '0'
        && document.querySelector('#mixMinKbps')?.value !== ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
}

async function setFilters(page, kbps, minutes) {
  await page.selectOption('#mixMinKbps', String(kbps));
  await page.selectOption('#mixMinMinutes', String(minutes));
  await page.waitForTimeout(200);
}

/** Řádky výsledků, jak je stránka ukazuje. */
const readRows = (page) => page.evaluate(() => [...document.querySelectorAll('#mixResults .mix-row')].map((r) => {
  const q = r.querySelector('.mix-q');
  const btns = [...r.querySelectorAll('.mix-actions button')];
  return {
    title: r.querySelector('.mix-title')?.textContent.trim() || '',
    badge: q ? q.textContent.trim() : '',
    // The badge text is not parseable ("MP3 192typ." — the first number is the 3 of
    // MP3), so the row carries its link and kbps comes from the API answer by URL.
    url: r.querySelector('.mix-title a')?.href || '',
    hasBadge: !!q,
    actionsVisible: btns.length > 0 && btns.every((b) => {
      const rc = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return rc.width > 0 && rc.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3
        && rc.right <= window.innerWidth + 1;
    }),
  };
}));

async function searchOn(viewport) {
  const s = await open({ viewport, device: 'mixpage', worktree });
  const { page } = s;
  try {
    // Výchozí filtry, ne to, co si stránka pamatuje z minulého běhu.
    await page.evaluate(() => { try { localStorage.removeItem('ms_mix_filters'); } catch {} });
    await openMixesTab(page);
    const tab = await page.evaluate(() => {
      const el = document.querySelector('#pageMixes');
      return {
        visible: !!el && el.offsetParent !== null,
        sections: ['#mixSearchSection', '#mixFollowSection', '#mixLibrarySection']
          .map((id) => document.querySelector(id)?.offsetParent !== null),
        kbps: document.querySelector('#mixMinKbps')?.value,
        minutes: document.querySelector('#mixMinMinutes')?.value,
      };
    });
    check(`[${viewport}] záložka Mixes je vidět se třemi sekcemi`, tab.visible && tab.sections.every(Boolean), JSON.stringify(tab.sections));
    check(`[${viewport}] výchozí filtr ≥ 128 kbps a ≥ 20 min`, tab.kbps === '128' && tab.minutes === '20', `${tab.kbps} / ${tab.minutes}`);

    await page.fill('#mixSearchInput', QUERY);
    await page.click('#mixSearchBtn');
    await page.waitForSelector('#mixShownCount, #mixSearchStatus .mix-err', { timeout: 90000 });
    const data = (await api(page, `/api/mixes/search?q=${encodeURIComponent(QUERY)}`)).body || { results: [] };
    const all = data.results || [];
    const low = all.filter((r) => r.kbps < 128).length;
    check(`[${viewport}] hledání vrátilo výsledky`, all.length > 0,
      `${all.length} · zdroje ${JSON.stringify(data.counts)} · chyby ${JSON.stringify(data.errors)}`);

    const byUrl = new Map();
    for (const r of all) {
      byUrl.set(r.url, r.kbps);
      for (const a of r.also || []) if (!byUrl.has(a.url)) byUrl.set(a.url, a.kbps);
    }
    const rows = (await readRows(page)).map((r) => ({ ...r, kbps: r.hasBadge ? (byUrl.get(r.url) ?? -1) : -1 }));
    check(`[${viewport}] každý řádek má odznak kvality`, rows.length > 0 && rows.every((r) => r.badge), rows.slice(0, 4).map((r) => r.badge).join(', '));
    check(`[${viewport}] výchozí filtr neukáže nic pod 128 kbps`, rows.every((r) => r.kbps >= 128),
      rows.filter((r) => r.kbps < 128).map((r) => r.badge).join(', '));
    const note = await page.evaluate(() => document.querySelector('#mixHiddenNote')?.textContent || '');
    if (low) check(`[${viewport}] stránka řekne, kolik skryl filtr kvality`, /\d+ hidden by quality/.test(note), note);
    else console.log(`      (žádný výsledek pod 128 kbps — počet skrytých kvalitou se nedá ověřit)`);
    check(`[${viewport}] ovládání řádků je vidět bez hoveru`, rows.every((r) => r.actionsVisible));

    await setFilters(page, 0, 0);
    const shownAll = await page.evaluate(() => Number(document.querySelector('#mixShownCount')?.textContent || -1));
    const rowsAll = (await readRows(page)).map((r) => ({ ...r, kbps: r.hasBadge ? (byUrl.get(r.url) ?? -1) : -1 }));
    check(`[${viewport}] bez filtru se ukážou všechny`, shownAll === all.length && rowsAll.length === all.length,
      `${shownAll} / ${all.length}`);
    if (low) check(`[${viewport}] bez filtru jsou vidět i mixy pod 128 kbps`, rowsAll.some((r) => r.kbps < 128));
    const scrollX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`[${viewport}] stránka nejede do strany`, !scrollX);
    await setFilters(page, 128, 20);
    check(`[${viewport}] žádná chyba stránky`, s.errors.length === 0, s.errors.join(' | '));
    return { s, data };
  } catch (e) {
    check(`[${viewport}] hledání`, false, String(e.message || e));
    return { s, data: null };
  }
}

async function followFlow(page, data) {
  // Mixcloud nebo hearthis: nahrávky přijdou jedním dotazem, ne extrakcí přes yt-dlp.
  const pick = (data.results || []).find((r) => r.uploader_id && ['mixcloud', 'hearthis'].includes(r.source))
    || (data.results || []).find((r) => r.uploader_id);
  if (!pick) { check('je koho sledovat', false); return; }
  const path = `/api/mixes/follows/${encodeURIComponent(pick.source)}/${encodeURIComponent(pick.uploader_id)}`;
  await api(page, path, { method: 'DELETE' });   // zbytek z minulého běhu
  try {
    await setFilters(page, 0, 0);
    const clicked = await page.evaluate((t) => {
      const row = [...document.querySelectorAll('#mixResults .mix-row')]
        .find((r) => r.querySelector('.mix-title')?.textContent.trim() === t);
      const b = row && row.querySelector('[data-act="follow"]');
      if (!b) return false;
      b.click();
      return true;
    }, pick.title);
    check('tlačítko Follow DJ u výsledku', clicked, `${pick.source} · ${pick.uploader}`);
    await page.waitForFunction((n) => [...document.querySelectorAll('#mixFollows .mix-follow .mix-title')]
      .some((e) => e.textContent.trim() === n), pick.uploader, { timeout: 60000 });
    const f = (await api(page, '/api/mixes/follows')).body.follows.find((x) => x.user_id === pick.uploader_id);
    check('sledování je uložené a současné nahrávky jsou „viděné“', f && f.seeded && f.seen_count > 0 && f.auto_download === false,
      JSON.stringify(f && { seeded: f.seeded, seen: f.seen_count }));
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('#mixFollows .mix-follow')]
        .find((c) => c.querySelector('.mix-title')?.textContent.trim() === n);
      card.querySelector('[data-act="uploads"]').click();
    }, pick.uploader);
    await page.waitForSelector('#mixFollows .mix-uploads .mix-row, #mixFollows .mix-uploads .mix-err', { timeout: 90000 });
    const up = await page.evaluate(() => ({
      rows: document.querySelectorAll('#mixFollows .mix-uploads .mix-row').length,
      badges: document.querySelectorAll('#mixFollows .mix-uploads .mix-q').length,
      err: document.querySelector('#mixFollows .mix-uploads .mix-err')?.textContent || '',
    }));
    check('nahrávky DJe se načtou s odznaky kvality', up.rows > 0 && up.badges === up.rows, JSON.stringify(up));
    await page.evaluate((n) => {
      const card = [...document.querySelectorAll('#mixFollows .mix-follow')]
        .find((c) => c.querySelector('.mix-title')?.textContent.trim() === n);
      card.querySelector('[data-act="unfollow"]').click();
    }, pick.uploader);
    await page.waitForSelector('.modal-overlay .confirm-ok', { timeout: 5000 });
    await page.click('.modal-overlay .confirm-ok');
    await page.waitForTimeout(1500);
    const left = (await api(page, '/api/mixes/follows')).body.follows.some((x) => x.user_id === pick.uploader_id);
    check('Unfollow přes UI sledování zruší', !left);
  } finally {
    await api(page, path, { method: 'DELETE' });
    await setFilters(page, 128, 20);
  }
}

async function downloadFlow(page, data) {
  const ok = (data.results || []).filter((r) => r.kbps >= 128 && r.duration >= 1200);
  const nonYt = ok.filter((r) => r.source !== 'youtube');
  const pool = (nonYt.length ? nonYt : ok).sort((a, b) => a.duration - b.duration);
  const pick = pool[0];
  if (!pick) { check('je co stáhnout (≥ 128 kbps, ≥ 20 min)', false); return; }
  console.log(`      stahuji: ${pick.source} · ${pick.quality_label} · ${Math.round(pick.duration / 60)} min · ${pick.title}`);
  await setFilters(page, 0, 0);
  const clicked = await page.evaluate((u) => {
    const row = [...document.querySelectorAll('#mixResults .mix-row')]
      .find((r) => r.querySelector('.mix-title a')?.href === u);
    const b = row && row.querySelector('[data-act="download"]');
    if (!b) return false;
    b.click();
    return true;
  }, pick.url);
  check('tlačítko Download u výsledku', clicked);
  // Překreslení (jiné řazení) nesmí tlačítko už spuštěného stažení znovu povolit.
  await page.waitForTimeout(800);
  await page.selectOption('#mixSort', 'relevance');
  const stillOff = await page.evaluate((u) => {
    const row = [...document.querySelectorAll('#mixResults .mix-row')]
      .find((r) => r.querySelector('.mix-title a')?.href === u);
    return row ? row.querySelector('[data-act="download"]').disabled : null;
  }, pick.url);
  check('spuštěné stažení zůstane po překreslení zakázané', stillOff === true, String(stillOff));
  await page.selectOption('#mixSort', 'quality');
  let job = null;
  const started = Date.now();
  for (let i = 0; i < 200 && !job; i++) {
    await page.waitForTimeout(3000);
    const jobs = (await api(page, '/api/jobs')).body?.jobs || [];
    const j = jobs.find((x) => x.type === 'mix' && x.url === pick.url);
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) job = j;
  }
  check('úloha mixu doběhla jako done', job && job.status === 'done',
    job ? `${job.status} · ${job.progress_text} · ${job.error || ''} · ${Math.round((Date.now() - started) / 1000)} s` : 'nedoběhla do 10 min');
  if (!job || job.status !== 'done') return;
  check('úloha je mix ve formátu zdroje', job.format === 'original' && job.method === 'yt-dlp');

  // Starting a download opens the Downloads panel over the page (as for every
  // download); close it the way a user would before touching the list.
  if (await page.evaluate(() => document.querySelector('#downloadsPanel')?.classList.contains('open'))) {
    await page.click('#panelClose');
    await page.waitForTimeout(400);
  }
  await page.click('#mixLibRefresh');
  let lib = null, mine = null;
  for (let i = 0; i < 10 && !mine; i++) {
    await page.waitForTimeout(1500);
    lib = (await api(page, '/api/mixes/library')).body;
    for (const dj of lib?.djs || []) for (const m of dj.mixes) if (m.url === pick.url) mine = m;
  }
  check('mix je ve Stažených (API)', !!mine, mine ? `${mine.dj} / ${mine.file} · ${mine.quality}` : '');
  if (!mine) return;
  await page.click('#mixLibRefresh');
  await page.waitForTimeout(1500);
  const inUi = await page.evaluate((t) => [...document.querySelectorAll('#mixLibrary .mix-lib-row .mix-title')]
    .some((e) => e.textContent.trim() === t), mine.title);
  check('mix je ve Stažených (UI)', inUi, mine.title);

  const st = await page.evaluate(async ({ n, a }) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('ms_token') };
    const tk = await (await fetch('/api/player/stream-token', { headers: h })).json();
    const token = tk.token || tk.stream_token || '';
    const r = await fetch(`/api/player/stream?name=${encodeURIComponent(n)}&artist=${encodeURIComponent(a)}&token=${encodeURIComponent(token)}`,
      { headers: { Range: 'bytes=0-1023' } });
    await r.arrayBuffer();
    return { status: r.status, source: r.headers.get('x-stream-source'), type: r.headers.get('content-type') };
  }, { n: mine.title, a: mine.artist });
  check('stream mixu odpoví 206 z lokálního souboru', st.status === 206 && st.source === 'local', JSON.stringify(st));

  const batch = [];
  const onReq = (r) => { if (r.url().includes('add-and-download-batch')) batch.push(r.url()); };
  page.on('request', onReq);
  const before = await page.evaluate(() => document.querySelector('#playerBar, .player-bar')?.textContent || '');
  await page.evaluate((t) => {
    const row = [...document.querySelectorAll('#mixLibrary .mix-lib-row')]
      .find((r) => r.querySelector('.mix-title')?.textContent.trim() === t);
    row.querySelector('[data-act="play"]').click();
  }, mine.title);
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => document.querySelector('#playerBar, .player-bar')?.textContent || '');
  check('▶ Play dá mix do přehrávače', after.includes(mine.title) || (after !== before && after.length > 0), after.slice(0, 120));
  page.off('request', onReq);
  // addToQueue by mix zapsal do store.playlistMode (otevřený playlist v Navidrome).
  check('▶ Play nezapisuje do otevřeného playlistu', batch.length === 0, `${batch.length} požadavků add-and-download-batch`);
  await page.evaluate(() => document.querySelectorAll('audio').forEach((a) => { try { a.pause(); } catch {} }));

  await page.evaluate((t) => {
    const row = [...document.querySelectorAll('#mixLibrary .mix-lib-row')]
      .find((r) => r.querySelector('.mix-title')?.textContent.trim() === t);
    row.querySelector('[data-act="delete"]').click();
  }, mine.title);
  await page.waitForSelector('.modal-overlay .confirm-ok', { timeout: 5000 });
  await page.click('.modal-overlay .confirm-ok');
  await page.waitForTimeout(2500);
  lib = (await api(page, '/api/mixes/library')).body;
  const still = (lib?.djs || []).some((dj) => dj.mixes.some((m) => m.url === pick.url));
  check('smazání přes UI soubor odstraní', !still);
  if (still) console.log(`Úklid: v knihovně claude_test zůstal ${mine.dj}/DJ Sets/${mine.file}`);
  await setFilters(page, 128, 20);
}

let keep = null;
for (const vp of ['phone', 'tablet', 'desktop'].filter((v) => VIEWPORTS[v])) {
  const { s, data } = await searchOn(vp);
  if (vp === 'desktop' && data) keep = { s, data };
  else await s.browser.close();
}
if (keep) {
  try {
    await followFlow(keep.s.page, keep.data);
    if (!args.has('--no-download')) await downloadFlow(keep.s.page, keep.data);
    check('[desktop] žádná chyba stránky po celém běhu', keep.s.errors.length === 0, keep.s.errors.join(' | '));
  } finally {
    await keep.s.browser.close();
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
