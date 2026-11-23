// Přejímka: Search → typ „Mixes“. Hledání DJ setů z hlavní stránky Search, stejné
// řádky jako Library → Mixes (mixes.js), filtry z Mixes záložky, žádné hledání
// při psaní, obnova uloženého hledání bez spuštění, zastaralé hledání nemaluje.
//
//   node tests/e2e/audit/search_mixes.mjs [--tree] [--vp=phone,tablet,desktop]
//
// Bez --tree běží proti nasazené produkci (musí PADAT), s --tree se stránce
// naservírují soubory ze stromu (musí PROJÍT). Server mixů (/api/mixes/search,
// /follows) a /api/download se falšují přes page.route; jediné skutečné volání
// hledání mixů je jedno za běh (desktop). Nic se nestahuje.
import fs from 'node:fs';
import path from 'node:path';
import { open, makeReport } from './helpers.mjs';

const args = process.argv.slice(2);
const worktree = args.includes('--tree') ? (process.env.MS_TREE || process.cwd()) : null;
const vpArg = args.find((a) => a.startsWith('--vp='));
const VPS = vpArg ? vpArg.slice(5).split(',') : ['phone', 'tablet', 'desktop'];
const rep = makeReport('search_mixes');
const check = (name, ok, detail) => rep.check(name, '', ok, detail);

const R = (o) => ({ source: 'mixcloud', source_label: 'Mixcloud', duration: 3600, kbps: 192, quality_label: 'AAC 192', quality_known: true,
  uploader: 'DJ Test', uploader_id: 'u1', thumbnail: '', in_library: false, also: [], ...o });
const FAKE = {
  sources: ['soundcloud', 'youtube', 'mixcloud', 'hearthis'], counts: {}, errors: { hearthis: 'boom' },
  results: [
    R({ title: 'Alpha set', url: 'https://www.mixcloud.com/djtest/alpha/' }),
    R({ title: 'Beta low', url: 'https://www.mixcloud.com/djtest/beta/', kbps: 64, quality_label: 'AAC 64', uploader_id: 'u2' }),
    R({ title: 'Gamma owned', url: 'https://www.mixcloud.com/djtest/gamma/', kbps: 160, in_library: true, uploader_id: 'u3' }),
    R({ title: 'Delta also', url: 'https://www.mixcloud.com/djtest/delta/', kbps: 128, duration: 1800, uploader_id: 'u4',
        also: [{ source: 'youtube', source_label: 'YouTube', quality_label: 'AAC 128', kbps: 128, url: 'https://www.youtube.com/watch?v=x' }] }),
    R({ title: 'Epsilon short', url: 'https://www.mixcloud.com/djtest/eps/', duration: 600, uploader_id: 'u5' }),
  ],
};
const FOLLOWS = { follows: [{ source: 'mixcloud', user_id: 'u1', name: 'DJ Test', image: '', url: '', auto_download: false, min_kbps: 0, min_minutes: 0 }] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function onViewport(vp, real) {
  const tag = `[${vp}]`;
  const s = await open({ viewport: vp, device: 'searchmix', worktree });
  const { page } = s;
  const st = { mixSearch: [], typeMix: [], downloads: [], delay: 0, real: false };
  page.on('request', (r) => { if (/\/api\/search\?.*type=mix/.test(r.url())) st.typeMix.push(r.url()); });
  await page.route('**/api/mixes/follows', (r) => (r.request().method() === 'GET' ? json(r, FOLLOWS) : r.continue()));
  await page.route('**/api/mixes/search**', async (r) => {
    st.mixSearch.push(new URL(r.request().url()).searchParams.get('q'));
    if (st.real) return r.continue();
    if (st.delay) await new Promise((x) => setTimeout(x, st.delay));
    return json(r, FAKE);
  });
  await page.route('**/api/download', (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    st.downloads.push(JSON.parse(r.request().postData() || '{}'));
    return json(r, { id: 'fake', status: 'queued' });
  });
  const step = async (name, fn) => { try { await fn(); } catch (e) { check(`${tag} ${name}`, false, String(e.message || e).split('\n')[0]); } };
  const rows = () => page.$$eval('#searchResults .mix-row', (rs) => rs.map((r) => ({
    title: r.querySelector('.mix-title')?.textContent.trim(),
    badge: !!r.querySelector('.mix-q'),
    dlDisabled: r.querySelector('[data-act="download"]')?.disabled,
    follow: r.querySelector('[data-act="follow"]')?.textContent.trim() || '',
    also: r.querySelector('.mix-also')?.textContent || '',
    owned: !!r.querySelector('.mix-owned'),
  })));
  const reset = async () => {
    await page.evaluate(() => { try { localStorage.removeItem('ms_mix_filters'); localStorage.removeItem('ms_search_claude_test'); } catch {} });
  };
  try {
    await reset();
    await page.waitForSelector('#searchInput');
    await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
    await page.waitForTimeout(500);

    await step('typ Mixes je v řadě tlačítek a nejede se do strany', async () => {
      const info = await page.evaluate(() => {
        const b = document.querySelector('.type-btn[data-type="mix"]');
        const t = document.querySelector('.type-toggle');
        return { has: !!b, text: b?.textContent.trim(), over: document.documentElement.scrollWidth > window.innerWidth + 1,
          inside: !!b && t && b.getBoundingClientRect().right <= t.getBoundingClientRect().right + 1 };
      });
      check(`${tag} tlačítko Mixes existuje a stránka nejede do strany`, info.has && info.text === 'Mixes' && !info.over && info.inside, JSON.stringify(info));
    });
    if (!(await page.$('.type-btn[data-type="mix"]'))) return s;

    await step('psaní nespouští hledání', async () => {
      await page.click('.type-btn[data-type="mix"]');
      await page.waitForTimeout(300);
      await page.click('#searchInput');
      await page.keyboard.type('zouk set', { delay: 120 });
      await page.waitForTimeout(1500);
      check(`${tag} žádný požadavek na mixy při psaní`, st.mixSearch.length === 0 && st.typeMix.length === 0, `mixy ${st.mixSearch.length}, type=mix ${st.typeMix.length}`);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      check(`${tag} Enter spustí právě jedno hledání mixů`, st.mixSearch.length === 1 && st.mixSearch[0] === 'zouk set', JSON.stringify(st.mixSearch));
      check(`${tag} nic nešlo na /api/search?type=mix`, st.typeMix.length === 0);
    });

    await step('řádky a filtry', async () => {
      const r = await rows();
      const titles = r.map((x) => x.title);
      check(`${tag} výchozí filtr: Alpha, Gamma, Delta (Beta kvalita, Epsilon délka skryté)`,
        JSON.stringify(titles) === JSON.stringify(['Alpha set', 'Gamma owned', 'Delta also']), titles.join(' | '));
      check(`${tag} odznak kvality na každém řádku`, r.length > 0 && r.every((x) => x.badge));
      const g = r.find((x) => x.title === 'Gamma owned');
      check(`${tag} In library a vypnuté Download u vlastněného`, g && g.owned && g.dlDisabled === true);
      const a = r.find((x) => x.title === 'Alpha set');
      check(`${tag} sledovaný DJ je „Following“, ostatní „+ Follow DJ“`, a?.follow === 'Following' && r.find((x) => x.title === 'Delta also')?.follow === '+ Follow DJ', JSON.stringify(r.map((x) => x.follow)));
      check(`${tag} „Also on …“`, /Also on YouTube/.test(r.find((x) => x.title === 'Delta also')?.also || ''));
      const status = await page.$eval('#mixSearchViewStatus', (e) => ({ vis: e.offsetParent !== null, text: e.textContent }));
      check(`${tag} stavový řádek: 3 of 5 shown · hidden by quality`, status.vis && /3\s*of 5 shown/.test(status.text) && /1 hidden by quality/.test(status.text) && /1 hidden by length/.test(status.text), status.text.replace(/\s+/g, ' ').slice(0, 160));
      check(`${tag} chyba zdroje hearthis se ukáže`, /hearthis\.at: boom/.test(status.text));
      await page.click('#smixShowAll');
      await page.waitForTimeout(300);
      check(`${tag} Show all ukáže všech 5`, (await rows()).length === 5);
      const flt = await page.evaluate(() => JSON.parse(localStorage.getItem('ms_mix_filters') || '{}'));
      check(`${tag} Show all uložil filtr stejně jako záložka (stejný klíč)`, flt.minKbps === 0 && flt.minMinutes === 0, JSON.stringify(flt));
    });

    await step('odkaz do Library › Mixes', async () => {
      await page.click('#smixOpenLib');
      await page.waitForTimeout(1500);
      const vis = await page.evaluate(() => document.querySelector('#pageMixes')?.offsetParent !== null);
      check(`${tag} odkaz otevře Library › Mixes`, vis);
      await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
      await page.waitForTimeout(600);
    });

    await step('přepnutí typu uprostřed hledání nemaluje zastaralé', async () => {
      st.delay = 2500;
      await page.fill('#searchInput', 'slow one');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await page.click('.type-btn[data-type="track"]');
      await page.waitForTimeout(4500);
      st.delay = 0;
      const left = await page.evaluate(() => ({ rows: document.querySelectorAll('#searchResults .mix-row').length,
        status: document.querySelector('#mixSearchViewStatus')?.offsetParent !== null }));
      check(`${tag} po přepnutí na Tracks nezůstal žádný mix řádek ani stavový řádek`, left.rows === 0 && !left.status, JSON.stringify(left));
    });

    await step('All a Tracks fungují', async () => {
      st.mixSearch.length = 0;
      await page.fill('#searchInput', 'enya');
      await page.click('.type-btn[data-type="all"]');
      await page.waitForFunction(() => document.querySelectorAll('#searchResults > *').length > 0 && !document.querySelector('#searchResults .skeleton'), null, { timeout: 20000 });
      check(`${tag} All vykreslí výsledky bez mixů`, st.mixSearch.length === 0 && (await page.$$('#searchResults .mix-row')).length === 0);
      await page.click('.type-btn[data-type="track"]');
      await page.waitForFunction(() => document.querySelectorAll('#searchResults > *').length > 0 && !document.querySelector('#searchResults .skeleton'), null, { timeout: 20000 });
      check(`${tag} Tracks vykreslí výsledky`, (await page.$$('#searchResults .mix-row')).length === 0 && st.mixSearch.length === 0);
    });

    await step('stažení posílá type:mix', async () => {
      // the download opens the downloads panel over the page: this step goes last before a reload
      await page.fill('#searchInput', 'dl');
      await page.click('.type-btn[data-type="mix"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      await page.click('#searchResults .mix-row:first-child [data-act="download"]');
      await page.waitForTimeout(500);
      const d = st.downloads[0] || {};
      check(`${tag} POST /api/download má type:"mix" a URL řádku`, d.type === 'mix' && /mixcloud\.com/.test(d.url || ''), JSON.stringify(d));
    });

    await step('obnova uloženého hledání', async () => {
      st.mixSearch.length = 0;
      await page.evaluate(() => localStorage.setItem('ms_search_claude_test', JSON.stringify({ q: 'saved q', type: 'mix' })));
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(6000);
      const info = await page.evaluate(() => ({
        q: document.querySelector('#searchInput')?.value,
        active: document.querySelector('.type-btn.active')?.dataset.type,
        hint: document.querySelector('#searchResults')?.textContent || '',
        rows: document.querySelectorAll('#searchResults .mix-row').length,
      }));
      check(`${tag} obnova ukáže dotaz a typ Mixes a nehledá`, info.q === 'saved q' && info.active === 'mix' && st.mixSearch.length === 0 && st.typeMix.length === 0 && info.rows === 0, JSON.stringify({ ...info, hint: info.hint.slice(0, 60), n: st.mixSearch.length }));
      check(`${tag} obnova ukáže klidový text`, /Press Enter/.test(info.hint), info.hint.slice(0, 80));
    });

    if (real) await step('jedno skutečné hledání', async () => {
      st.real = true;
      st.mixSearch.length = 0;
      await page.fill('#searchInput', 'zouk mix');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#searchResults .mix-row, #mixSearchViewStatus .mix-err', { timeout: 120000 });
      const n = (await rows()).length;
      const errTxt = await page.$eval('#mixSearchViewStatus', (e) => e.textContent.slice(0, 120));
      check(`${tag} skutečné hledání vrátilo řádky nebo hlášení zdrojů`, n > 0 || /:/.test(errTxt), `${n} řádků · ${errTxt.replace(/\s+/g, ' ')}`);
    });
    check(`${tag} žádná chyba stránky`, s.errors.length === 0, s.errors.join(' | '));
  } catch (e) {
    check(`${tag} běh`, false, String(e.message || e));
  }
  return s;
}


// ── scenario play: a mix from search plays without being downloaded ─────────────────
// One REAL short public set (Mixcloud, AAC 64, ~25 min, ~13 MB). Search and follows are
// faked; the stream is real. Needs the tree's own backend for the new endpoint
// (tests/e2e/audit/remote_backend.sh, MS_URL=http://127.0.0.1:18094) — production as
// deployed has no /api/player/mix-stream, so this scenario fails there.
// Two real public sets. SHORT (Mixcloud, AAC 64, ~25 min, ~13 MB) builds in ~5 s; LONG
// (hearthis.at, MP3 192, ~36 min, ~52 MB) takes ~30 s, so a seek tried early meets a build
// that is still running — the case the server's progressive body cannot answer.
const SETS = {
  short: { url: process.env.MS_PLAY_URL || 'https://www.mixcloud.com/Dj_Vasco/retro-zouk-mix/', dur: Number(process.env.MS_PLAY_DUR || 1479), title: 'Retro Zouk Mix', long: false },
  long: { url: 'https://hearthis.at/jeamo972/zouk-mix-session-manege/', dur: 2169, title: 'Zouk mix session manege', long: true },
};
// Where the tree's backend keeps its cache (remote_backend.sh: <scratch>/music/.mix-stream);
// without it the cold-restore step is skipped.
const MIX_CACHE = process.env.MS_MIX_CACHE || '';
// Wipe the cache the way a deploy does — but never under a build that is still running (a
// restore that Chromium seeked by itself leaves one going): deleting its .tmp makes the
// server record a failure for that URL, which is the server doing the right thing.
const clearCache = async () => {
  for (let i = 0; i < 60; i++) {
    let busy = false;
    try { busy = fs.readdirSync(MIX_CACHE).some((f) => f.endsWith('.tmp')); } catch {}
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { for (const f of fs.readdirSync(MIX_CACHE)) fs.unlinkSync(path.join(MIX_CACHE, f)); } catch {}
};

async function playOn(vp, engine, set) {
  const PLAY_URL = set.url, PLAY_DUR = set.dur;
  const tag = `[${vp}] play/${engine}/${set.long ? 'long' : 'short'}`;
  if (set.long && MIX_CACHE) await clearCache();          // a cold build
  const s = await open({ viewport: vp, device: 'searchmixplay', worktree: process.env.MS_URL ? null : worktree });
  const { page } = s;
  const seen = { mixStream: [], titleStream: [], download: 0, nonProgressive: 0 };
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/player/mix-stream?')) {
      seen.mixStream.push(u);
      if (new URL(u).searchParams.get('progressive') !== '1') seen.nonProgressive++;
    }
    if (u.includes('/api/player/stream?') && /name=Retro|name=Zouk/.test(u)) seen.titleStream.push(u);
  });
  const fake = { sources: ['mixcloud'], counts: {}, errors: {}, results: [R({
    title: set.title, uploader: 'Dj Test', uploader_id: 'dj_test', url: PLAY_URL, duration: PLAY_DUR, kbps: 192, in_library: false })] };
  await page.route('**/api/mixes/follows', (r) => (r.request().method() === 'GET' ? json(r, { follows: [] }) : r.continue()));
  await page.route('**/api/mixes/search**', (r) => json(r, fake));
  await page.route('**/api/download', (r) => { seen.download++; return json(r, { id: 'x' }); });
  const active = () => page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find((x) => !x.paused && x.currentSrc) || null;
    return a ? { t: a.currentTime, dur: a.duration, src: a.currentSrc, paused: a.paused } : null;
  });
  const status = () => page.evaluate(async (u) => {
    const q = new URLSearchParams({ url: u });
    const r = await fetch('/api/player/mix-stream-status?' + q, { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token') } });
    return r.ok ? r.json() : null;
  }, PLAY_URL);
  const clickBar = async (frac) => {
    let box = await (await page.$('#playerProgressBar')).boundingBox();
    if (!box) {   // phone: the mini bar has no seek bar; the full player has one
      await page.evaluate(() => document.querySelector('#playerImg').click());
      await page.waitForTimeout(800);
      box = await (await page.$('#fpProgressBar')).boundingBox();
    }
    await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
  };
  try {
    await page.evaluate((e) => { try { localStorage.setItem('ms_player_engine', e); } catch {} }, engine);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    await page.evaluate(() => { try { localStorage.removeItem('ms_search_claude_test'); localStorage.setItem('ms_mix_filters', JSON.stringify({ minKbps: 0, minMinutes: 0, sort: 'quality', sources: ['soundcloud', 'youtube', 'mixcloud', 'hearthis'] })); } catch {} });
    const libBefore = await page.evaluate(async () => (await (await fetch('/api/mixes/library', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token') } })).json()).count);
    await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
    await page.waitForTimeout(500);
    if (!(await page.$('.type-btn[data-type="mix"]'))) { check(`${tag}: Mixes type`, false, 'chybí tlačítko Mixes'); return s; }
    await page.click('.type-btn[data-type="mix"]');
    await page.fill('#searchInput', 'retro zouk');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
    const btn = await page.evaluate(() => {
      const r = document.querySelector('#searchResults .mix-row');
      const bs = [...r.querySelectorAll('.mix-actions button')].map((b) => ({ t: b.textContent.trim(), right: b.getBoundingClientRect().right, w: b.getBoundingClientRect().width }));
      return { labels: bs.map((b) => b.t), fits: bs.every((b) => b.w > 0 && b.right <= window.innerWidth + 1) };
    });
    check(`${tag}: řádek má Play, Download a Follow a vejde se`, btn.labels.some((t) => /Play/.test(t)) && btn.labels.length === 3 && btn.fits, JSON.stringify(btn));
    await page.click('#searchResults .mix-row [data-act="play"]');
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 2), null, { timeout: 90000 });
    const t1 = await active();
    await page.waitForTimeout(3000);
    const t2 = await active();
    check(`${tag}: zvuk běží a čas postupuje`, t1 && t2 && t2.t - t1.t > 2, JSON.stringify({ a: t1 && t1.t, b: t2 && t2.t }));
    check(`${tag}: hraje přesná URL přes /api/player/mix-stream, ne podle názvu`,
      seen.mixStream.length > 0 && seen.mixStream.every((u) => new URL(u).searchParams.get('url') === PLAY_URL) && seen.titleStream.length === 0,
      `mix-stream ${seen.mixStream.length}, podle názvu ${seen.titleStream.length}`);
    const shown = await page.evaluate(() => ({ total: document.querySelector('#playerTimeTotal')?.textContent, title: document.querySelector('#playerTitle')?.textContent }));
    const wantTotal = `${Math.floor(PLAY_DUR / 60)}:${String(PLAY_DUR % 60).padStart(2, '0')}`;
    check(`${tag}: lišta ukazuje délku ze search výsledku a název`, shown.total === wantTotal && shown.title === set.title, JSON.stringify(shown) + ' čekáno ' + wantTotal);

    if (set.long) {
      // The build is still running (~30 s): a seek beyond what is fetched must not reload
      // (the request would wait for the whole build, then 503 → media error → skip).
      const st0 = await status();
      const before = await active();
      await clickBar(0.4);
      await page.waitForTimeout(3000);
      const after = await active();
      const toast = await page.evaluate(() => document.querySelector('#toastMsg')?.textContent || '');
      const title = await page.evaluate(() => document.querySelector('#playerTitle')?.textContent);
      check(`${tag}: seek za načtenou část během stahování: hláška, hraje dál, žádný reload ani skok`,
        st0 && st0.building && /once it has been fetched/.test(toast) && after && before && after.t - before.t < 8 && after.t >= before.t
          && seen.nonProgressive === 0 && title === set.title,
        JSON.stringify({ building: st0 && st0.building, toast: toast.slice(0, 60), before: before && before.t, after: after && after.t, nonProg: seen.nonProgressive }));
      // wait until the build is done
      let cached = false;
      for (let i = 0; i < 60 && !cached; i++) { await page.waitForTimeout(3000); cached = !!((await status()) || {}).cached; }
      check(`${tag}: sestavení dokončeno`, cached);
    } else {
      await page.waitForTimeout(3000);
    }
    const want = PLAY_DUR * 0.4;
    await clickBar(0.4);
    await page.waitForTimeout(6000);
    const t3 = await active();
    await page.waitForTimeout(2500);
    const t4 = await active();
    check(`${tag}: seek na 40 % dojde a hraje dál`, t3 && t4 && Math.abs(t3.t - want) < 40 && t4.t - t3.t > 1.5, JSON.stringify({ want, a: t3 && t3.t, b: t4 && t4.t }));
    const libAfter = await page.evaluate(async () => (await (await fetch('/api/mixes/library', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token') } })).json()).count);
    check(`${tag}: nic se nestáhlo do knihovny`, seen.download === 0 && libAfter === libBefore, `stažení ${seen.download}, knihovna ${libBefore} → ${libAfter}`);
    await page.waitForTimeout(2500);
    const getSaved = () => page.evaluate(async () => { const r = await fetch('/api/player/queue', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ms_token'), 'X-Device-Id': localStorage.getItem('ms_device_id') } }); return r.json(); });
    // pause, then save through the engine's own flush (the DJ engine saves the position only
    // on events, not on pause), and look at what was saved
    await page.evaluate(() => document.querySelector('#playerPlayPause').click());
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const u = performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/player_active.js'));
      const m = await (await import(u)).getPlayerModule();
      await m.flushQueue();
    });
    await page.waitForTimeout(1500);
    const saved = await getSaved();
    check(`${tag}: uložená fronta nese zdrojovou URL`, (saved.queue || []).some((x) => x.mix_url === PLAY_URL), JSON.stringify((saved.queue || []).map((x) => x.mix_url)));
    const savedPos = saved.position_seconds || 0;
    check(`${tag}: uložená pozice je kolem seeku`, Math.abs(savedPos - want) < 60, `uloženo ${savedPos}, seek ${want}`);
    // a deploy empties the cache: restore must keep the position, with the build gone
    const cold = !!MIX_CACHE;           // both sets: the cache is gone, as after a deploy
    if (cold) await clearCache();
    seen.mixStream.length = 0;
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(6000);
    await page.evaluate(() => {   // every toast the page shows from now on
      window.__toasts = [];
      new MutationObserver(() => { const t = document.querySelector('#toastMsg'); if (t && t.textContent) window.__toasts.push(t.textContent); })
        .observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.evaluate(() => document.querySelector('#playerPlayPause').click());
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 0.3), null, { timeout: 60000 }).catch(() => {});
    if (cold) {
      await page.waitForTimeout(3000);
      const toasts = await page.evaluate(() => window.__toasts || []);
      // The fragmented MP4 (short, AAC) cannot be sought while it is built: the page says it waits.
      // Chromium seeks the growing MP3 of the long set by itself (checked by the position below).
      if (!set.long) check(`${tag}: po obnovení bez sestavení hláška o čekání na pozici`, toasts.some((t) => /resuming at/.test(t)), JSON.stringify(toasts.slice(0, 3)).slice(0, 120));
      await page.waitForFunction((p) => [...document.querySelectorAll('audio')].some((a) => !a.paused && Math.abs(a.currentTime - p) < 40), savedPos, { timeout: 150000 }).catch(() => {});
    } else {
      await page.waitForTimeout(3000);
    }
    const t5 = await active();
    check(`${tag}: po obnovení Play pokračuje stejným streamem na uložené pozici`,
      !!t5 && /mix-stream/.test(t5.src) && seen.mixStream.length > 0 && Math.abs(t5.t - savedPos) < 40,
      JSON.stringify(t5 && { t: t5.t, savedPos, cold, src: t5.src.slice(0, 50) }));
    await page.evaluate(() => document.querySelector('#playerPlayPause').click()).catch(() => {});
    check(`${tag}: žádná chyba stránky`, s.errors.length === 0, s.errors.join(' | '));
  } catch (e) {
    check(`${tag}: běh`, false, String(e.message || e).split('\n')[0]);
  }
  return s;
}


// ── scenario recover: the user's path in the macOS app ─────────────────────────────────
// WebKit's first request for a mix is a Range probe, never progressive: the server answers
// "still building" (503) and the page waits for the finished file, then PLAYS it. We force
// that first answer in Chromium (page.route) and then listen for minutes: the finished file
// must be a plain MP4 (index up front, no fragments: what WebKit/AVFoundation can size),
// the page must stay on the mix with the position advancing and the real length shown, an
// `ended` the element fires far from the end must not advance (queue stays one row, no
// Autoplay), and the recovery must show ONE calm "Fetching the mix…" state, no error toast.
const REC = { url: process.env.MS_RECOVER_URL || 'https://www.mixcloud.com/TigerZouk/zouktime-brno-2024-its-showtime/', dur: Number(process.env.MS_RECOVER_DUR || 5047), title: 'Zouktime Brno 2024 - its showtime' };
const REC_MIN = Number(process.env.MS_RECOVER_MIN || 3);

async function recoverOn(engine) {
  const tag = `[desktop] recover/${engine}`;
  const s = await open({ viewport: 'desktop', device: 'searchmixrec', worktree: process.env.MS_URL ? null : worktree });
  const { page } = s;
  let blocked = 0;
  const toasts = [];
  const fake = { sources: ['mixcloud'], counts: {}, errors: {}, results: [R({ title: REC.title, uploader: 'TigerZouk', uploader_id: 'tigerzouk', url: REC.url, duration: REC.dur, kbps: 192, in_library: false })] };
  await page.route('**/api/mixes/follows', (r) => (r.request().method() === 'GET' ? json(r, { follows: [] }) : r.continue()));
  await page.route('**/api/mixes/search**', (r) => json(r, fake));
  // the first progressive request fails the way WebKit's did: "still building"
  await page.route('**/api/player/mix-stream?*', (r) => {
    if (new URL(r.request().url()).searchParams.get('progressive') === '1' && blocked < 1) {
      blocked++;
      return r.fulfill({ status: 503, headers: { 'Retry-After': '5' }, contentType: 'application/json', body: '{"detail":"The mix is still being fetched"}' });
    }
    return r.continue();
  });
  const active = () => page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find((x) => x.currentSrc && !x.paused) || null;
    return a ? { t: a.currentTime, src: a.currentSrc, dur: a.duration, paused: a.paused } : null;
  });
  try {
    await page.evaluate((e) => { try { localStorage.setItem('ms_player_engine', e); localStorage.setItem('ms_mix_filters', JSON.stringify({ minKbps: 0, minMinutes: 0, sort: 'quality', sources: ['soundcloud', 'youtube', 'mixcloud', 'hearthis'] })); } catch {} }, engine);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(() => { const t = document.querySelector('#toastMsg'); if (t && t.textContent) window.__toasts.push(t.textContent); })
        .observe(document.body, { subtree: true, childList: true, characterData: true });
      window.__consoleWarn = [];
      const w = console.warn; console.warn = (...a) => { window.__consoleWarn.push(a.join(' ')); w.apply(console, a); };
    });
    await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
    await page.waitForTimeout(500);
    await page.click('.type-btn[data-type="mix"]');
    await page.fill('#searchInput', 'zouktime');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
    // WebKit's own first request is what STARTS the server's build (then answers 503): ours is
    // answered by the route above without reaching the server, so start the build the same way.
    await page.evaluate(async (url) => {
      const tok = (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/api.js')))).streamToken();
      const c = new AbortController();
      fetch('/api/player/mix-stream?' + new URLSearchParams({ url, token: tok, progressive: '1' }), { signal: c.signal }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      c.abort();
    }, REC.url);
    await page.click('#searchResults .mix-row [data-act="play"]');
    // recovery: the page waits for the finished file (a 50-minute set builds in a minute or two)
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 3), null, { timeout: 420000 });
    const t = await page.evaluate(() => window.__toasts);
    const uniq = [...new Set(t.map((x) => x.replace(/\s*\d+\s*(%|MB)\s*$/, '')))];
    check(`${tag}: the 503 recovery shows one calm state, no error toast`, blocked === 1 && uniq.every((x) => /^Fetching the mix/.test(x)), JSON.stringify(uniq));
    // the finished file is a plain MP4 (what WebKit can size): boxes from the first 2 MB
    const boxes = await page.evaluate(async (url) => {
      const tok = (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/api.js')))).streamToken();
      let r;
      for (let i = 0; i < 60; i++) {           // a request during the remux is "still building" (503): that is the rule, retry
        r = await fetch('/api/player/mix-stream?' + new URLSearchParams({ url, token: tok }), { headers: { Range: 'bytes=0-2097151' } });
        if (r.status !== 503) break;
        await new Promise((x) => setTimeout(x, 1000));
      }
      const b = new DataView(await r.arrayBuffer());
      const out = []; let pos = 0;
      while (pos + 8 <= b.byteLength) { const n = b.getUint32(pos); out.push(String.fromCharCode(b.getUint8(pos + 4), b.getUint8(pos + 5), b.getUint8(pos + 6), b.getUint8(pos + 7))); if (n < 8) break; pos += n; }
      return { status: r.status, boxes: out };
    }, REC.url);
    check(`${tag}: the finished file is a plain MP4 (moov up front, no fragments)`, boxes.boxes.includes('moov') && !boxes.boxes.includes('moof') && boxes.boxes.indexOf('moov') < (boxes.boxes.indexOf('mdat') < 0 ? 99 : boxes.boxes.indexOf('mdat')), JSON.stringify(boxes));
    const shown = await page.evaluate(() => document.querySelector('#playerTimeTotal')?.textContent);
    const want = `${Math.floor(REC.dur / 60)}:${String(REC.dur % 60).padStart(2, '0')}`;
    check(`${tag}: the real length is shown`, shown === want || Math.abs((() => { const [m, sec] = String(shown).split(':').map(Number); return m * 60 + sec; })() - REC.dur) < 5, `${shown} / ${want}`);
    // listen: position advances; at ~60 s the element "ends" far from the end — must not advance
    const t0 = await active();
    await page.waitForTimeout(20000);
    await page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find((x) => x.currentSrc && !x.paused); if (a) a.dispatchEvent(new Event('ended')); });
    await page.waitForTimeout(5000);
    const afterEnded = await active();
    const state = await page.evaluate(async () => {
      const m = await (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/store.js')))).store;
      return { len: m.playerQueue.length, idx: m.playerIndex, title: document.querySelector('#playerTitle')?.textContent };
    });
    check(`${tag}: an early \`ended\` does not advance (still the mix, one queue row, no Autoplay)`, !!afterEnded && state.len === 1 && state.idx === 0 && state.title === REC.title && afterEnded.t >= t0.t, JSON.stringify({ t0: t0 && t0.t, after: afterEnded && afterEnded.t, ...state }));
    // listen for minutes: still on the mix, advancing, no skip
    const samples = [];
    for (let i = 0; i < REC_MIN * 6; i++) { await page.waitForTimeout(10000); const a = await active(); samples.push(a ? Math.round(a.t) : -1); }
    const still = await page.evaluate(async () => {
      const m = await (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/store.js')))).store;
      return { len: m.playerQueue.length, idx: m.playerIndex, title: document.querySelector('#playerTitle')?.textContent };
    });
    const adv = samples.every((v, i) => v > 0 && (i === 0 || v >= samples[i - 1]));
    check(`${tag}: ${REC_MIN} more minutes on the mix, position advancing, no skip, no Autoplay`, adv && still.len === 1 && still.title === REC.title && samples[samples.length - 1] - samples[0] > REC_MIN * 60 * 0.8, JSON.stringify({ first: samples[0], last: samples[samples.length - 1], ...still }));
    check(`${tag}: no page error`, s.errors.length === 0, s.errors.join(' | '));
  } catch (e) {
    check(`${tag}: run`, false, String(e.message || e).split('\n')[0]);
  }
  return s;
}


// ── scenario paging: scrolling to the end of the results loads more ──────────────────────
// Faked pages (page.route): nothing real is asked. Page 1: ten rows. Page 2: eight rows, four
// of them under the default quality filter, plus a copy of page 1's second set found on
// YouTube (a fold, not a row). Page 3: three rows, and the sources are dry.
const PG = (tag, n, extra = {}) => Array.from({ length: n }, (_, i) => R({ title: `${tag}${i + 1}`, url: `https://www.mixcloud.com/pg/${tag.toLowerCase()}${i + 1}/`, uploader: `DJ ${tag}`, uploader_id: `${tag}${i}`, ...extra }));
const PAGES = {
  1: { results: PG('A', 10), more: { mixcloud: true }, done: false, page: 1 },
  2: { results: [...PG('B', 4, { kbps: 64, quality_label: 'AAC 64' }), ...PG('B', 8).slice(4).map((x, i) => ({ ...x, title: `B${i + 5}`, url: `https://www.mixcloud.com/pg/b${i + 5}/` }))],
       folds: [{ into: 'https://www.mixcloud.com/pg/a2/', also: [{ source: 'youtube', source_label: 'YouTube', quality_label: 'AAC 128', kbps: 128, url: 'https://www.youtube.com/watch?v=pg2' }] }],
       more: { mixcloud: true }, done: false, page: 2 },
  3: { results: PG('C', 3), folds: [], more: { mixcloud: false }, done: true, page: 3 },
};

async function pagingOn(vp) {
  const tag = `[${vp}] paging`;
  const s = await open({ viewport: vp, device: 'searchmixpg', worktree: process.env.MS_URL ? null : worktree });
  const { page } = s;
  const st = { sids: [], hideAll: false, reqs: [], inflight: 0, maxInflight: 0, delay: 400, emptyAt: 0, trackRequests: [] };
  page.on('request', (r) => { if (/\/api\/search\?/.test(r.url())) st.trackRequests.push(r.url()); });
  await page.route('**/api/mixes/follows', (r) => (r.request().method() === 'GET' ? json(r, { follows: [] }) : r.continue()));
  await page.route('**/api/mixes/search**', async (r) => {
    const u = new URL(r.request().url());
    const pg = Number(u.searchParams.get('page') || 1);
    st.reqs.push(pg);
    st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    await new Promise((x) => setTimeout(x, pg === 1 ? 0 : st.delay));
    st.inflight--;
    let body = { query: u.searchParams.get('q'), sources: ['mixcloud'], counts: {}, errors: {}, folds: [], ...(PAGES[pg] || PAGES[3]) };
    if (st.hideAll && pg >= 2) body = { ...body, results: PG(`H${pg}x`, 5, { kbps: 64, quality_label: 'AAC 64' }), folds: [], more: { mixcloud: true }, done: false, page: pg };
    if (pg > 1) st.sids.push(u.searchParams.get('sid'));
    if (st.emptyAt && pg === st.emptyAt) body = { ...body, results: [], folds: [], done: false };
    return json(r, body);
  });
  const rows = () => page.$$eval('#searchResults .mix-row', (rs) => rs.map((r) => ({ url: r.dataset.url, title: r.querySelector('.mix-title')?.textContent.trim(), also: r.querySelector('.mix-also')?.textContent || '' })));
  const statusText = () => page.$eval('#mixSearchViewStatus', (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  const go = async (q) => {
    await page.evaluate(() => { try { localStorage.removeItem('ms_mix_filters'); localStorage.removeItem('ms_search_claude_test'); } catch {} });
    await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
    await page.waitForTimeout(400);
    await page.click('.type-btn[data-type="mix"]');
    await page.fill('#searchInput', q);
    await page.keyboard.press('Enter');
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { check(`${tag} ${name}`, false, String(e.message || e).split('\n')[0]); } };
  try {
    await page.waitForSelector('#searchInput');
    if (!(await page.$('.type-btn[data-type="mix"]'))) { check(`${tag}: Mixes type`, false, 'chybí'); return s; }

    await step('scroll načte stránky 2 a 3 a skončí', async () => {
      await go('paging one');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500); if ((await statusText()).includes('No more results')) break; }
      const r = await rows();
      const urls = r.map((x) => x.url);
      check(`${tag}: stránky 2 a 3 se načetly, a pak už nic`, JSON.stringify(st.reqs) === '[1,2,3]', JSON.stringify(st.reqs));
      check(`${tag}: 17 řádků (10 + 4 viditelné z 8 + 3), bez duplicit`, r.length === 17 && new Set(urls).size === 17, `${r.length} řádků, ${new Set(urls).size} unikátních`);
      check(`${tag}: řádky na obrazovce se nepřeuspořádaly (A1…A10 pak B, pak C)`, r.slice(0, 10).map((x) => x.title).join() === 'A1,A2,A3,A4,A5,A6,A7,A8,A9,A10' && r[10].title.startsWith('B') && r[16].title.startsWith('C'), r.map((x) => x.title).join());
      check(`${tag}: kopie na YouTube se složila do řádku A2 („Also on YouTube“), ne nový řádek`, /Also on YouTube/.test(r[1].also) && !r.some((x) => /pg2/.test(x.url)), r[1].also);
      const t = await statusText();
      check(`${tag}: stavový řádek počítá vše načtené a hlásí konec`, /17 of 21 shown/.test(t) && /4 hidden by quality/.test(t) && /No more results/.test(t), t.slice(0, 140));
      check(`${tag}: nikdy víc než jeden požadavek najednou`, st.maxInflight === 1, `max ${st.maxInflight}`);
      check(`${tag}: žádný požadavek na /api/search?type=mix`, st.trackRequests.every((u) => !/type=mix/.test(u)));
      const sentinel = await page.$('#searchResults .mix-sentinel');
      check(`${tag}: po vyčerpání není strážce`, !sentinel);
      await page.click('#smixShowAll');
      await page.waitForTimeout(300);
      check(`${tag}: Show all ukáže všech 21 (filtr se použil na všechny stránky)`, (await rows()).length === 21);
    });

    await step('stránka bez nových řádků zastaví načítání', async () => {
      st.reqs.length = 0; st.emptyAt = 2;
      await go('paging two');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500); }
      check(`${tag}: prázdná stránka 2 → žádná stránka 3`, st.reqs.includes(2) && !st.reqs.some((p) => p > 2), JSON.stringify(st.reqs));   // (page 1 may repeat: the Mixes button re-runs the typed query)
      check(`${tag}: stav říká konec`, /No more results/.test(await statusText()));
      st.emptyAt = 0;
    });

    await step('filtry skryjí všechny nové řádky: načítání se samo zastaví', async () => {
      st.reqs.length = 0; st.sids.length = 0; st.hideAll = true; st.delay = 100;
      await page.reload({ waitUntil: 'load' });                  // the filters back to their defaults (Show all was saved above)
      await page.waitForTimeout(3000);
      await go('paging hidden');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      for (let i = 0; i < 10; i++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(500); }
      const before = st.reqs.filter((p) => p > 1);
      const t = await statusText();
      check(`${tag}: po jednom spuštění (3 stránky) bez viditelného řádku se samo nepokračuje`, JSON.stringify(before) === '[2,3,4]' && /held back by your filters/.test(t) && /Load more/.test(t), JSON.stringify(before) + ' ' + t.slice(0, 120));
      check(`${tag}: každá stránka nese stejné id hledání (sid)`, new Set(st.sids.filter(Boolean)).size === 1 && st.sids.length >= 3, JSON.stringify([...new Set(st.sids)]));
      await page.click('#smixMore');
      await page.waitForTimeout(1500);
      check(`${tag}: „Load more“ pokračuje další stránkou`, st.reqs.filter((p) => p > 1).length > 3, JSON.stringify(st.reqs));
      st.hideAll = false; st.delay = 400;
    });

    await step('přepnutí typu zahodí rozjetou stránku', async () => {
      st.reqs.length = 0; st.delay = 1800;
      await go('paging three');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(() => /Loading more/.test(document.querySelector('#mixSearchViewStatus')?.textContent || ''), null, { timeout: 5000 });
      await page.click('.type-btn[data-type="track"]');
      await page.waitForTimeout(3500);
      const left = await page.evaluate(() => ({ rows: document.querySelectorAll('#searchResults .mix-row').length, status: document.querySelector('#mixSearchViewStatus')?.offsetParent !== null }));
      check(`${tag}: po přepnutí na Tracks nezůstal žádný mix řádek ani stav (zpožděná stránka nemaluje)`, left.rows === 0 && !left.status && st.reqs.includes(2), JSON.stringify({ ...left, reqs: st.reqs }));
      st.delay = 400;
    });

    await step('nové hledání zahodí rozjetou stránku', async () => {
      st.reqs.length = 0; st.delay = 1800;
      await go('paging four');
      await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForFunction(() => /Loading more/.test(document.querySelector('#mixSearchViewStatus')?.textContent || ''), null, { timeout: 5000 });
      st.delay = 0;
      await page.fill('#searchInput', 'paging five');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3500);
      const r = await rows();
      check(`${tag}: nové hledání ukáže jen svých 10 řádků + své stránky, nic ze starého`, r.length >= 10 && new Set(r.map((x) => x.url)).size === r.length, `${r.length} řádků`);
      st.delay = 400;
    });
    check(`${tag}: žádná chyba stránky`, s.errors.length === 0, s.errors.join(' | '));
  } catch (e) {
    check(`${tag}: běh`, false, String(e.message || e));
  }
  return s;
}


// ── scenario webkit: the macOS app's sequence in Playwright's WebKit ───────────────────────
// probe → 503 "still building" (forced for WebKit's first two requests) → status polls → the finished file → plays. Asserted:
// it plays on, the PROGRESSIVE url is requested once (the forced failure) and never again, no
// skip, no error toast. (Playwright's Linux WebKit is GStreamer, not AVFoundation: it proves the
// page's own recovery, not Apple's decoder.)
async function webkitOn(engine) {
  const tag = `[webkit] ${engine}`;
  const s = await open({ viewport: 'desktop', device: 'searchmixwk', engine: 'webkit', worktree: process.env.MS_URL ? null : worktree });
  const { page } = s;
  const prog = [], logs = [];
  let blocked = 0;
  page.on('request', (r) => { const u = r.url(); if (u.includes('/api/player/client-log')) { try { logs.push(JSON.parse(r.postData() || '{}')); } catch {} } if (u.includes('/api/player/mix-stream?') && new URL(u).searchParams.get('progressive') === '1') prog.push({ at: Date.now(), range: r.headers().range || '-' }); });
  const fake = { sources: ['mixcloud'], counts: {}, errors: {}, results: [R({ title: 'Retro Zouk Mix', uploader: 'Dj Vasco', uploader_id: 'dj_vasco', url: SETS.short.url, duration: SETS.short.dur, kbps: 192 })] };
  await page.route('**/api/mixes/follows', (r) => (r.request().method() === 'GET' ? json(r, { follows: [] }) : r.continue()));
  await page.route('**/api/mixes/search**', (r) => json(r, fake));
  await page.route('**/api/player/mix-stream?*', (r) => {
    if (new URL(r.request().url()).searchParams.get('progressive') === '1' && blocked < 2) {
      blocked++;
      return r.fulfill({ status: 503, headers: { 'Retry-After': '5' }, contentType: 'application/json', body: '{"detail":"The mix is still being fetched"}' });
    }
    return r.continue();
  });
  try {
    await page.evaluate((e) => { try { localStorage.setItem('ms_player_engine', e); localStorage.setItem('ms_mix_filters', JSON.stringify({ minKbps: 0, minMinutes: 0, sort: 'quality', sources: ['soundcloud', 'youtube', 'mixcloud', 'hearthis'] })); } catch {} }, engine);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      window.__toasts = [];
      new MutationObserver(() => { const t = document.querySelector('#toastMsg'); if (t && t.textContent) window.__toasts.push(t.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.evaluate(() => document.querySelector('.bnav-btn[data-page="search"], .nav-btn[data-page="search"]')?.click());
    await page.waitForTimeout(500);
    await page.click('.type-btn[data-type="mix"]');
    await page.fill('#searchInput', 'retro zouk');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#searchResults .mix-row', { timeout: 15000 });
    await page.evaluate(async (url) => {         // what WebKit's own probe does: start the server's build
      const tok = (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/api.js')))).streamToken();
      const c = new AbortController();
      fetch('/api/player/mix-stream?' + new URLSearchParams({ url, token: tok, progressive: '1' }), { signal: c.signal }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      c.abort();
    }, SETS.short.url);
    prog.length = 0; logs.length = 0;
    const tClick = Date.now();
    await page.click('#searchResults .mix-row [data-act="play"]');
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some((a) => !a.paused && a.currentTime > 3), null, { timeout: 120000 });
    await page.waitForTimeout(20000);
    const st = await page.evaluate(async () => {
      const store = (await import(performance.getEntriesByType('resource').map((r) => r.name).find((n) => n.includes('/static/js/store.js')))).store;
      const a = [...document.querySelectorAll('audio')].find((x) => !x.paused && x.currentSrc);
      return { len: store.playerQueue.length, idx: store.playerIndex, t: a ? a.currentTime : -1, toasts: [...new Set(window.__toasts)] };
    });
    check(`${tag}: plays on after the forced 503, on the mix, one queue row`, st.t > 15 && st.len === 1 && st.idx === 0, JSON.stringify(st));
    // WebKit reads one src with several parallel/ranged GETs (WKWebView: five): those are not a
    // problem. What matters is what the PAGE does: it must not swap a working load, loop, or skip.
    const kinds = logs.map((l) => l.k);
    const srcSets = logs.filter((l) => l.k === 'src').length;
    check(`${tag}: the page sets the source at most twice (the play and one finished-file reload), never loops`, srcSets <= 2 && kinds.filter((k) => k === 'reload-finished').length <= 1, JSON.stringify({ srcSets, kinds, ranges: prog.map((p) => p.range) }));
    check(`${tag}: no skip, no error recovery gave up`, !kinds.includes('skip'), JSON.stringify(kinds));
    check(`${tag}: no "Stream error" / skip toast`, !st.toasts.some((x) => /Stream error|skipping/i.test(x)), JSON.stringify(st.toasts));
    check(`${tag}: no page error`, s.errors.filter((e) => !/api\/player\/queue/.test(e)).length === 0, s.errors.join(' | '));   // (a queue save cut off by the test's own reload/close)
  } catch (e) {
    check(`${tag}: run`, false, String(e.message || e).split('\n')[0]);
  }
  return s;
}

let first = true;
for (const vp of VPS) {
  if (!args.includes('--only-play') && !args.includes('--only-recover') && !args.includes('--only-paging') && !args.includes('--webkit')) {
    const s = await onViewport(vp, vp === 'desktop' || (first && !VPS.includes('desktop')));
    first = false;
    try { await s.browser.close(); } catch {}
  }
  if (!args.includes('--no-paging') && !args.includes('--only-play') && !args.includes('--only-recover') && !args.includes('--webkit')) {
    const g = await pagingOn(vp);
    try { await g.browser.close(); } catch {}
  }
  if (args.includes('--webkit') && vp === VPS[0]) {
    for (const engine of (process.env.MS_WK_ENGINES || 'dj,classic').split(',')) {
      const w = await webkitOn(engine);
      try { await w.browser.close(); } catch {}
    }
  }
  if (args.includes('--recover') || args.includes('--only-recover')) {
    const r = await recoverOn(process.env.MS_RECOVER_ENGINE || 'dj');
    try { await r.browser.close(); } catch {}
  }
  if (!args.includes('--no-play') && !args.includes('--only-recover') && !args.includes('--only-paging') && !args.includes('--webkit')) {
    for (const engine of (process.env.MS_PLAY_ENGINES || 'dj,classic').split(',')) {   // dj: the engine the review is about; classic: the stored default
      for (const set of (process.env.MS_PLAY_SETS ? process.env.MS_PLAY_SETS.split(',').map((k) => SETS[k]) : (vp === 'desktop' ? [SETS.short, SETS.long] : [SETS.short]))) {
        const p = await playOn(vp, engine, set);
        try { await p.browser.close(); } catch {}
      }
    }
  }
}
process.exit(rep.done() ? 0 : 1);
