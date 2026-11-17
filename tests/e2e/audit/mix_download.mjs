// Přejímka: vložená adresa mixu z Mixcloudu se ve Vyhledávání pozná, stáhne se
// PŘESNĚ ten soubor v kvalitě zdroje a úloha řekne, jakou kvalitu uživatel dostal.
//
//   node tests/e2e/audit/mix_download.mjs              # banner na 3 rozlišeních + stažení
//   node tests/e2e/audit/mix_download.mjs --banner     # jen banner, nic nestahuje
//   node tests/e2e/audit/mix_download.mjs --tree       # stránka ze stromu (serveWorktree)
//
// Běží na účtu claude_test. Stažení zapíše do knihovny claude_test jeden mix
// (~30 MB); jeho úklid je na volajícím (viz výpis na konci), protože soubor leží
// na serveru, kam se z prohlížeče nedostaneme.
import { open, VIEWPORTS } from './helpers.mjs';

const SAMPLE = 'https://www.mixcloud.com/martin-%C5%A1moldas/zouktime-marathon-brno-sunday-set/?utm_medium=share&utm_source=clipboard&utm_content=show&utm_term=VXNlcjo1NDYzMDM2NQ%3D%3D';
const TITLE = 'Zouktime Marathon Brno Sunday set';
const UPLOADER = 'Martin Šmoldas';
const QUALITY = 'Mixcloud · AAC 64 kbps';

const args = new Set(process.argv.slice(2));
const worktree = args.has('--tree') ? process.cwd() : null;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function pasteIntoSearch(page, text) {
  await page.click('.nav-btn[data-page="search"], .bnav-btn[data-page="search"] >> visible=true').catch(() => {});
  await page.fill('#searchInput', text);
  await page.dispatchEvent('#searchInput', 'paste');
}

async function bannerFor(viewport) {
  const s = await open({ viewport, device: 'mixaudit', worktree });
  const { page } = s;
  try {
    await pasteIntoSearch(page, SAMPLE);
    await page.waitForSelector('#importBanner [data-mix-act="download"]', { timeout: 60000 });
    const b = await page.evaluate(() => {
      const el = document.querySelector('#importBanner');
      const btn = el.querySelector('[data-mix-act="download"]');
      const r = btn.getBoundingClientRect();
      return {
        title: el.querySelector('.import-banner-title')?.textContent || '',
        meta: el.querySelector('.import-banner-meta')?.textContent || '',
        note: el.querySelector('.import-banner-note')?.textContent || '',
        btnVisible: r.width > 0 && r.height > 0 && r.right <= window.innerWidth + 1,
        btnDisabled: btn.disabled,
        resultsHidden: getComputedStyle(document.querySelector('#searchResults')).display === 'none',
        scrollX: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check(`[${viewport}] banner ukazuje název mixu`, b.title === TITLE, b.title);
    check(`[${viewport}] banner ukazuje autora, délku a zdroj`,
      b.meta.includes(UPLOADER) && b.meta.includes('Mixcloud') && /1 h 2 min/.test(b.meta), b.meta);
    check(`[${viewport}] tlačítko Download mix je vidět`, b.btnVisible);
    check(`[${viewport}] výsledky vyhledávání pro URL jsou schované`, b.resultsHidden);
    check(`[${viewport}] stránka nejede do strany`, !b.scrollX);
    check(`[${viewport}] žádná chyba stránky`, s.errors.length === 0, s.errors.join(' | '));
    return { s, b };
  } catch (e) {
    check(`[${viewport}] banner`, false, String(e.message || e));
    return { s, b: null };
  }
}

async function download(s, b) {
  const { page } = s;
  if (b.btnDisabled) {
    check('mix ještě není v knihovně (jinak se stahovat nebude)', false, b.note);
    return;
  }
  const started = Date.now();
  await page.click('#importBanner [data-mix-act="download"]');
  // Úloha doběhne a v panelu stahování nese kvalitu.
  let job = null;
  for (let i = 0; i < 120 && !job; i++) {
    await page.waitForTimeout(3000);
    job = await page.evaluate(async (t) => {
      const r = await fetch('/api/jobs', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token') } });
      const j = (await r.json()).jobs.find((x) => x.type === 'mix' && x.title.includes(t));
      return j && ['done', 'failed', 'cancelled'].includes(j.status) ? j : null;
    }, TITLE);
  }
  check('úloha mixu doběhla jako done', job && job.status === 'done',
    job ? `${job.status} · ${job.progress_text} · ${job.error || ''} · ${Math.round((Date.now() - started) / 1000)} s` : 'nedoběhla do 6 min');
  check('úloha ukazuje kvalitu ze souboru', !!job && job.progress_text.startsWith(QUALITY), job && job.progress_text);
  check('úloha je typu mix, formát original', !!job && job.format === 'original' && job.method === 'yt-dlp');
  const panelText = await page.evaluate(() => document.querySelector('#jobsList')?.textContent || '');
  check('panel stahování ukazuje kvalitu', panelText.includes(QUALITY));

  // Navidrome mix po scanu vidí (find_song_id přes účet claude_test).
  let inLib = false;
  for (let i = 0; i < 20 && !inLib; i++) {
    await page.waitForTimeout(3000);
    inLib = await page.evaluate(async (u) => {
      const r = await fetch('/api/mix/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ms_token') },
        body: JSON.stringify({ url: u }),
      });
      return r.ok && (await r.json()).in_library === true;
    }, SAMPLE);
  }
  check('Navidrome mix po scanu vidí (in_library)', inLib);

  // Přehrávač ho pustí: lokální soubor, audio/mp4, Range funguje.
  const st = await page.evaluate(async ({ n, a }) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('ms_token') };
    const tk = await (await fetch('/api/player/stream-token', { headers: h })).json();
    const token = tk.token || tk.stream_token || '';
    const url = `/api/player/stream?name=${encodeURIComponent(n)}&artist=${encodeURIComponent(a)}&token=${encodeURIComponent(token)}`;
    const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    const buf = new Uint8Array(await r.arrayBuffer());
    const ftyp = String.fromCharCode(...buf.slice(4, 8));
    return { status: r.status, type: r.headers.get('content-type'), source: r.headers.get('x-stream-source'), ftyp };
  }, { n: TITLE, a: UPLOADER });
  check('stream endpoint servíruje lokální m4a s Range', st.status === 206 && st.source === 'local' && st.ftyp === 'ftyp',
    JSON.stringify(st));

  // Prohlížeč ho opravdu dekóduje a zná délku (~62 min).
  const play = await page.evaluate(async ({ n, a }) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('ms_token') };
    const tk = await (await fetch('/api/player/stream-token', { headers: h })).json();
    const token = tk.token || tk.stream_token || '';
    const el = new Audio(`/api/player/stream?name=${encodeURIComponent(n)}&artist=${encodeURIComponent(a)}&token=${encodeURIComponent(token)}`);
    el.muted = true;
    return await new Promise((res) => {
      const t = setTimeout(() => res({ ok: false, why: 'timeout', err: el.error && el.error.code }), 30000);
      el.addEventListener('loadedmetadata', () => { clearTimeout(t); res({ ok: true, duration: el.duration }); });
      el.addEventListener('error', () => { clearTimeout(t); res({ ok: false, err: el.error && el.error.code }); });
      el.load();
    });
  }, { n: TITLE, a: UPLOADER });
  check('prohlížeč načte metadata mixu a zná jeho délku', play.ok && play.duration > 3700 && play.duration < 3730,
    JSON.stringify(play));

  // BPM se na mix neptá analýzou.
  const bpm = await page.evaluate(async ({ n, a }) => {
    const r = await fetch(`/api/bpm/track?name=${encodeURIComponent(n)}&artist=${encodeURIComponent(a)}`,
      { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token') } });
    return { status: r.status, body: await r.json() };
  }, { n: TITLE, a: UPLOADER });
  check('BPM mix neanalyzuje (owned, analysable:false)',
    bpm.status === 200 && bpm.body.owned === true && bpm.body.analysable === false, JSON.stringify(bpm));
}

const viewports = Object.keys(VIEWPORTS).filter((v) => ['phone', 'tablet', 'desktop'].includes(v));
let keep = null;
for (const vp of viewports) {
  const { s, b } = await bannerFor(vp);
  if (vp === 'desktop' && b && !args.has('--banner')) keep = { s, b };
  else await s.browser.close();
}
if (keep) {
  try { await download(keep.s, keep.b); } finally { await keep.s.browser.close(); }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (keep) console.log(`Úklid: soubor leží v /mnt/nas/Media/_Music/claude_test/${UPLOADER}/DJ Sets/`);
process.exit(failed ? 1 : 0);
