// A playlist row shows the track's energy (five bars) once the server has analysed it
// with the level-independent formula (feature_version >= 3). Also: the queue
// panel's rows carry the meter, and the DJ panel's energy direction is stored and re-picks.
//
// Oracle: production, account claude_test, fixture playlist zz-audit-fixture (READ only).
//   node tests/e2e/audit/energy_badge.mjs [--tree]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const TREE = process.argv.includes('--tree') ? '/home/lucas/music-seeker' : null;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
async function api(path, { body, tok } = {}) {
  const h = { 'User-Agent': 'ms-review/1.0', 'Content-Type': 'application/json', 'X-Device-ID': 'e2e-energy' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  try { return { status: r.status, ...(await r.json()) }; } catch { return { status: r.status }; }
}
const tok = (await api('/api/auth/login', { body: { username: USER, password: PASS } })).token;
const fixture = ((await api('/api/library/playlists', { tok })).playlists || []).find(p => p.name === 'zz-audit-fixture');
// Ask for each track once: a stale entry is brought up to date by the request itself.
const tracks = (await api(`/api/library/playlist/${fixture.id}`, { tok })).tracks || [];
const got = [];
for (const t of tracks) got.push(await api(`/api/bpm/track?name=${encodeURIComponent(t.name)}&artist=${encodeURIComponent(t.artist)}`, { tok }));
const fresh = got.filter(g => g.feature_version >= 3 && Number.isFinite(g.energy));
check('server: the fixture tracks carry current-version energy', fresh.length >= 2, got.map(g => `${g.name || '?'}: v${g.feature_version ?? '-'} e=${g.energy ?? '-'}`).join(' | ').slice(0, 220));
check('server: the values are not all the same', new Set(fresh.map(g => g.energy)).size > 1);
check('server: each carries a felt tempo and the mixing BPM is untouched', fresh.length > 0 && fresh.every(g => g.tempo_feel > 0 && g.bpm > 40 && g.bpm <= 121 && [0.5, 1, 2].some(k => Math.abs(g.tempo_feel / g.bpm - k) < 0.01)), fresh.map(g => `${g.bpm}/${g.tempo_feel}`).join(' '));

const browser = await pw.chromium.launch();
try {
  for (const [vp, size] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport: size });
    if (TREE) await serveWorktree(context, TREE);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.addInitScript(() => localStorage.setItem('ms_device_id', 'e2e-energy'));
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#loginUser'); await page.waitForTimeout(2500);
    await page.fill('#loginUser', USER); await page.fill('#loginPass', PASS); await page.click('button:has-text("Sign In")');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#loginScreen')).display === 'none', null, { timeout: 25000 });
    await page.waitForTimeout(1200);
    await page.locator('[data-page="library"]:visible').first().click();
    await page.getByText('zz-audit-fixture').first().click();
    await page.waitForSelector('#libraryTracks .card', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#libraryTracks .energy-badge').length > 0, null, { timeout: 15000 }).catch(() => {});
    const seen = await page.evaluate(() => [...document.querySelectorAll('#libraryTracks .card')].map(c => {
      const b = c.querySelector('.energy-badge'); const r = b && b.getBoundingClientRect();
      return { title: c.querySelector('.song-title')?.textContent.trim(), level: b ? +b.dataset.level : null, on: b ? b.querySelectorAll('i.on').length : 0,
               visible: !!r && r.width > 0 && r.height > 0 && r.right <= innerWidth, tip: b ? b.title : '' };
    }));
    const withBadge = seen.filter(s => s.level);
    check(`${vp}: rows of analysed tracks show the meter`, withBadge.length === fresh.length && withBadge.length > 0, seen.map(s => `${(s.title || '').slice(0, 14)}=${s.level ?? '-'}`).join(' | '));
    check(`${vp}: the meter is on screen and lights as many bars as its level`, withBadge.length > 0 && withBadge.every(s => s.visible && s.on === s.level && /^Energy \d+ %$/.test(s.tip)), JSON.stringify(withBadge[0] || {}));
    const want = Object.fromEntries(fresh.map(g => [g.name, Math.max(1, Math.min(5, Math.floor(g.energy * 5) + 1))]));
    check(`${vp}: the level matches the server's energy`, withBadge.length > 0 && withBadge.every(s => want[s.title] === s.level), JSON.stringify(want).slice(0, 160));
    check(`${vp}: no horizontal scroll, no page errors`, errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), errors.join(' | ').slice(0, 160));
    if (process.env.MS_SHOT) await page.screenshot({ path: `${process.env.MS_SHOT}/energy-${vp}.png` });
    if (vp === 'desktop') {
      // The queue panel: play the fixture, its rows get the meter too.
      await page.locator('#libraryDetail button:has-text("Play All"), #libraryDetail button:has-text("Play")').first().click();
      await page.waitForFunction(() => document.querySelectorAll('.queue-item .energy-badge').length > 0, null, { timeout: 25000 }).catch(() => {});
      const q = await page.evaluate(() => { const panel = [...document.querySelectorAll('.queue-item')].map(r => r.closest('[id]')?.id); const rows = [...document.querySelectorAll('.queue-item')].filter(r => r.closest('[id]')?.id === panel[0]); return { rows: rows.length, meters: rows.filter(r => r.querySelector('.energy-badge')).length }; });
      check('queue: rows of analysed tracks carry the meter', q.meters >= fresh.length && q.meters > 0, JSON.stringify(q));
      // The DJ panel's energy direction.
      const dir = await page.evaluate(async () => {
        const box = document.querySelector('#fpDjEnergyDir'); if (!box) return null;
        const press = async (v) => { box.querySelector(`button[data-v="${v}"]`).click(); await new Promise(r => setTimeout(r, 400)); return { stored: localStorage.getItem('ms_dj_energy_dir'), checked: [...box.querySelectorAll('[aria-checked="true"]')].map(b => b.dataset.v).join(',') }; };
        const up = await press('up'); const auto = await press('auto');
        return { up, auto, options: [...box.querySelectorAll('button')].map(b => b.dataset.v).join(',') };
      });
      check('DJ panel: the energy direction offers auto/down/hold/up', !!dir && dir.options === 'auto,down,hold,up', JSON.stringify(dir));
      check('DJ panel: a press is stored for the engine and shown as chosen', !!dir && dir.up.stored === 'up' && dir.up.checked === 'up' && dir.auto.stored === 'auto' && dir.auto.checked === 'auto');
      await page.evaluate(() => { for (const m of document.querySelectorAll('audio')) m.pause(); });
    }
    await context.close();
  }
} catch (e) {
  check('ran to completion', false, String(e.message).split('\n')[0]);
} finally { await browser.close(); }
const bad = results.filter(r => !r).length;
console.log(`# ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
