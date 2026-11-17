// Cutting a passage out of a downloaded set and playing the cuts in DJ mode.
//
// Oracle: PRODUCTION, account claude_test, device e2e-mixcut. --tree serves the working
// tree's static files to the live page (helpers.serveWorktree); the /api/clips back end
// is always the deployed one. The script downloads one real SoundCloud set if
// claude_test does not have it yet (18 s, 67 MB), cuts two clips and — unless --keep —
// deletes the clips and the set again.
//
//   node tests/e2e/audit/mix_cut.mjs [--tree] [--keep] [--shots=<dir>]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const { chromium } = pw;
const TREE = process.argv.includes('--tree') ? '/home/lucas/music-seeker' : null;
const KEEP = process.argv.includes('--keep');
const SHOTS = (process.argv.find(a => a.startsWith('--shots=')) || '').slice(8);
// A set nobody else on the instance has: a download job answers "Already in library"
// (and downloads nothing) when Navidrome knows the title + DJ from ANY user's folder.
const LINK = 'https://www.mixcloud.com/martin-%C5%A1moldas/zouktime-marathon-brno-sunday-set/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function api(path, { body, tok, method } = {}) {
  const h = { 'User-Agent': 'ms-review/1.0', 'Content-Type': 'application/json', 'X-Device-ID': 'e2e-mixcut' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return { status: r.status, ...JSON.parse(t || '{}') }; } catch { return { status: r.status, text: t }; }
}
const tok = (await api('/api/auth/login', { body: { username: USER, password: PASS } })).token;
const theSet = async () => ((await api('/api/mixes/library', { tok })).djs || []).flatMap(d => d.mixes)[0] || null;

let mix = await theSet();
if (!mix) {
  await api('/api/download', { tok, body: { url: LINK, title: '', type: 'mix', method: 'yt-dlp' } });
  for (let i = 0; i < 90 && !mix; i++) { await sleep(5000); mix = await theSet(); }
}
check('setup: the set is in the library', !!mix, mix ? `${mix.artist} – ${mix.title.slice(0, 50)}… (${mix.quality})` : 'download did not finish');
if (!mix) process.exit(1);
// A known first clip, made through the API: the editor must show it and DJ mode needs two.
const A = { start: 17 * 60 + 45, end: 22 * 60 + 45 };
const titleA = `${mix.title} (17:45–22:45)`;
const have = (await api('/api/clips', { tok })).clips || [];
if (!have.some(c => c.title === titleA)) {
  const r = await api('/api/clips', { tok, body: { dj: mix.dj, file: mix.file, ...A, title: titleA, artist: mix.artist } });
  check('setup: first clip cut through the API', r.status === 200, `status ${r.status} ${r.detail || ''}`);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
if (TREE) await serveWorktree(context, TREE);
await context.route('**/api/player/recommendations**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"recommendations":[],"tracks":[]}' }));
const page = await context.newPage();
await page.addInitScript(() => {
  localStorage.setItem('ms_device_id', 'e2e-mixcut');
  localStorage.setItem('ms_player_engine', 'dj');
  localStorage.setItem('ms_dj_debug', '1');
  // Observe every media element that is ever played (the editor's is not in the DOM).
  window.__media = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { if (!window.__media.includes(this)) window.__media.push(this); return play.apply(this, arguments); };
});
const errors = [], logs = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { const t = m.text(); if (t.startsWith('[DJ')) logs.push(t); });
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${n}.png` }); };
try {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#loginUser'); await page.waitForTimeout(2500);
  await page.fill('#loginUser', USER); await page.fill('#loginPass', PASS); await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#loginScreen')).display === 'none', null, { timeout: 25000 });
  await page.waitForTimeout(1200);
  await page.click('.nav-btn[data-page="library"]');
  await page.click('[data-lib-tab="mixes"]');
  await page.waitForSelector('.mix-lib-row [data-act="cut"]', { timeout: 20000 });
  // The section is filled by its own request, after the rows.
  await page.waitForFunction(() => /17:45/.test(document.querySelector('#mixClips')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('list: the Clips section shows the existing clip', /17:45/.test(await page.locator('#mixClips').textContent()), (await page.locator('#mixClips').textContent()).replace(/\s+/g, ' ').slice(0, 120));

  await page.click('.mix-lib-row [data-act="cut"]');
  await page.waitForSelector('.mixcut-overlay canvas', { timeout: 15000 });
  await page.waitForFunction(() => { const s = document.querySelector('.mixcut-overlay [data-r="status"]'); return !s || !/Analysing/.test(s.textContent) || s.offsetParent === null; }, null, { timeout: 120000 });
  await page.waitForTimeout(800);
  // The overview must actually be drawn from real peaks: many distinct columns, not a flat bar.
  const drawn = await page.evaluate(() => {
    const c = document.querySelector('.mixcut-overlay canvas[data-r="ov"]'); const g = c.getContext('2d');
    const y = Math.floor(c.height * 0.2); const d = g.getImageData(0, y, c.width, 1).data; let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) lit++;
    return { lit, w: c.width };
  });
  check('editor: the whole-set waveform is drawn', drawn.lit > drawn.w * 0.05 && drawn.lit < drawn.w * 0.95, `${drawn.lit} of ${drawn.w} px lit at 20 % height`);
  await shot('cut-real-1-open');

  const T = (r) => page.locator(`.mixcut-overlay [data-r="${r}"]`);
  await T('rStart').fill('30:00'); await T('rStart').press('Enter');
  await T('rEnd').fill('33:00'); await T('rEnd').press('Enter');
  await page.waitForTimeout(600);
  const len = (await T('rLen').textContent()).trim();
  const title = await page.locator('.mixcut-overlay form input').first().inputValue();
  check('editor: typed times set the selection', len === '3:00.0', `length shows ${len}`);
  check('editor: the title is prefilled with the range', /\(30:00–33:00\)$/.test(title), title.slice(-24));

  await T('playStart').click();
  await page.waitForTimeout(3500);
  const au = await page.evaluate(() => window.__media.filter(m => !m.paused).map(m => ({ t: m.currentTime, src: m.src.replace(/token=[^&]+/, 'token=…') })));
  check('editor: ▶ Start plays the SET FILE from the selection start', au.length === 1 && au[0].t > 1800 && au[0].t < 1806 && au[0].src.includes('/api/clips/audio'), JSON.stringify(au).slice(0, 160));
  await shot('cut-real-2-selected');
  await page.locator('.mixcut-overlay form button[type="submit"], .mixcut-overlay form button').last().click();
  await page.waitForFunction(() => document.querySelectorAll('.mixcut-overlay [data-r="clips"] .mixcut-clip').length >= 2, null, { timeout: 60000 }).catch(() => {});
  const inEditor = await page.locator('.mixcut-overlay [data-r="clips"] .mixcut-clip').count();
  check('editor: the saved clip appears in the list without leaving', inEditor >= 2, `${inEditor} clips listed`);
  await shot('cut-real-3-saved');

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.mixcut-overlay'), null, { timeout: 5000 }).catch(() => {});
  const stillPlaying = await page.evaluate(() => window.__media.some(m => !m.paused));
  check('editor: closing removes it and stops its audio', !(await page.locator('.mixcut-overlay').count()) && !stillPlaying);

  // The two clips as a queue, through the real DJ engine.
  // The section re-renders from its own request after a save; wait for BOTH clips.
  await page.waitForFunction(() => /30:00/.test(document.querySelector('#mixClips')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('list: the Clips section picked up the clip saved in the editor', /30:00/.test(await page.locator('#mixClips').textContent()));
  await page.waitForSelector('#mixClips [data-a="all"]', { timeout: 15000 });
  await page.click('#mixClips [data-a="all"]');
  await page.waitForFunction(() => window.__media.some(m => !m.paused && m.currentTime > 0.5), null, { timeout: 60000 });
  const first = await page.evaluate(() => document.querySelector('#playerTitle').textContent);
  check('DJ: "Play all" starts with the earlier clip', /\(17:45–22:45\)$/.test(first), first.slice(-24));
  // Wait for the second clip to be analysed + prefetched, then go near the end.
  await page.waitForFunction(() => /ready/.test(document.querySelector('#prefetchStatus')?.innerHTML || '') && document.querySelectorAll('#prefetchStatus .prefetch-dot.ready').length >= 2, null, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => { const a = window.__media.find(m => !m.paused); a.currentTime = a.duration - 22; });
  await page.waitForFunction(() => /\(30:00–33:00\)$/.test(document.querySelector('#playerTitle').textContent), null, { timeout: 45000 }).catch(() => {});
  await sleep(1500);
  const second = await page.evaluate(() => document.querySelector('#playerTitle').textContent);
  const trig = logs.filter(l => l.startsWith('[DJ auto]')).pop() || '';
  const diag = await page.evaluate(() => JSON.stringify({ media: window.__media.map(m => ({ p: m.paused, e: m.ended, t: +m.currentTime.toFixed(1), d: m.duration, err: m.error?.code || 0, blob: m.src.startsWith('blob:') })), q: document.querySelectorAll('.queue-item').length, idx: window.__q?.() }));
  check('DJ: it crosses over into the next clip', /\(30:00–33:00\)$/.test(second), second.slice(-24) + ' ' + diag + ' logs=' + logs.slice(-4).join(' ¦ ').slice(0, 300));
  check('DJ: the transition was timed off the clip\'s own beat grid', /grid=beat/.test(trig) && /outBpm=\d/.test(trig), trig.replace(/play=.*? outBpm/, 'outBpm').slice(0, 140));
  // ── Cut on ANY owned track: the same set, addressed the way a track row addresses it
  // (title + artist, no dj/file), through the context menu the user would use.
  await page.evaluate(() => { for (const m of window.__media) m.pause(); });
  const row = page.locator('.queue-item').first();
  await row.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 });
  const item = page.locator('.ctx-menu').getByText('Cut a clip');
  check('track: the context menu of a queue row offers "Cut a clip…"', await item.count() > 0);
  await page.keyboard.press('Escape');
  await page.evaluate(async (t) => {
    const v = [...document.scripts].map(x => x.src).find(x => /app\.js\?v=/.test(x)).split('?v=')[1];
    const m = await import(`/static/js/mixcut.js?v=${v}`);
    m.openCutter({ name: t.title, artist: t.artist, type: 'track' }, null);
  }, { title: mix.title, artist: mix.artist });
  await page.waitForSelector('.mixcut-overlay canvas', { timeout: 15000 });
  await page.waitForFunction(() => { const s = document.querySelector('.mixcut-overlay [data-r="status"]'); return !s || !/Analysing/.test(s.textContent) || s.offsetParent === null; }, null, { timeout: 120000 });
  const T2 = (r) => page.locator(`.mixcut-overlay [data-r="${r}"]`);
  await T2('rStart').fill('40:00'); await T2('rStart').press('Enter');
  await T2('rEnd').fill('41:00'); await T2('rEnd').press('Enter');
  await page.waitForTimeout(500);
  await T2('playStart').click();
  await page.waitForTimeout(3000);
  const au2 = await page.evaluate(() => window.__media.filter(m => !m.paused).map(m => ({ t: m.currentTime, src: m.src.replace(/token=[^&]+/, 'token=…') })));
  check('track: the editor plays the track\'s own file, addressed by title + artist', au2.length === 1 && au2[0].t > 2400 && au2[0].t < 2406 && /\/api\/clips\/audio\?.*name=/.test(au2[0].src), JSON.stringify(au2).slice(0, 150));
  await page.locator('.mixcut-overlay form button').last().click();
  let trackClip = null;
  for (let i = 0; i < 30 && !trackClip; i++) { await sleep(1000); trackClip = ((await api('/api/clips', { tok })).clips || []).find(c => /\(40:00–41:00\)$/.test(c.title)) || null; }
  check('track: saving writes a clip that remembers its source as a library track', !!trackClip && trackClip.source_dj === '@track' && /DJ Sets\//.test(trackClip.source_file), trackClip ? `${trackClip.source_dj} | ${trackClip.source_file.slice(0, 60)}… | ${trackClip.duration}s` : 'not saved');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.mixcut-overlay'), null, { timeout: 5000 }).catch(() => {});
  // A track the user does not own: one clear sentence, no five-minute retry.
  await page.evaluate(async () => {
    const v = [...document.scripts].map(x => x.src).find(x => /app\.js\?v=/.test(x)).split('?v=')[1];
    (await import(`/static/js/mixcut.js?v=${v}`)).openCutter({ name: 'ZZ Not In Anyones Library', artist: 'Nobody At All', type: 'track' }, null);
  });
  await page.waitForFunction(() => /own library/.test(document.querySelector('.mixcut-overlay [data-r="status"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  check('track: a track that is not stored in the library says so', /own library/.test(await page.locator('.mixcut-overlay [data-r="status"]').textContent()), (await page.locator('.mixcut-overlay [data-r="status"]').textContent()).slice(0, 80));
  await page.keyboard.press('Escape');
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
} catch (e) {
  check('ran to completion', false, String(e.message).split('\n')[0]);
  await shot('cut-real-failed');
} finally {
  await browser.close();
  if (!KEEP) {
    for (const c of (await api('/api/clips', { tok })).clips || []) await api('/api/clips', { tok, method: 'DELETE', body: { dir: c.dir, file: c.file } });
    await api('/api/mixes/library', { tok, method: 'DELETE', body: { dj: mix.dj, file: mix.file } });
    const left = ((await api('/api/clips', { tok })).clips || []).length + (((await api('/api/mixes/library', { tok })).count) || 0);
    check('cleanup: claude_test is left without the set and its clips', left === 0, `${left} items left`);
  }
}
const bad = results.filter(r => !r).length;
console.log(`# ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
