// Dragging a row in a library playlist changes its order — on screen AND on the server.
//
// Reported 2026-11-17: "only the last track can be dragged". Since the playlist became a
// row list the rows sit in a wrapper inside #libraryTracks, while the drag code inserted
// into the outer container: every move threw NotFoundError and the row stayed put.
//
// Oracle: production; --tree serves the working tree's static files. The fixture playlist
// zz-audit-fixture is READ here; the drags run on a copy this script creates and deletes.
//
//   node tests/e2e/audit/playlist_reorder.mjs [--tree]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const TREE = process.argv.includes('--tree') ? '/home/lucas/music-seeker' : null;
const NAME = 'zz-reorder-e2e';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
async function api(path, { body, tok, method } = {}) {
  const h = { 'User-Agent': 'ms-review/1.0', 'Content-Type': 'application/json', 'X-Device-ID': 'e2e-reorder' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: h, body: body ? JSON.stringify(body) : undefined });
  try { return { status: r.status, ...(await r.json()) }; } catch { return { status: r.status }; }
}
const tok = (await api('/api/auth/login', { body: { username: USER, password: PASS } })).token;
const lists = async () => (await api('/api/library/playlists', { tok })).playlists || [];
for (const p of (await lists()).filter(p => p.name === NAME)) await api(`/api/library/playlist/${p.id}`, { tok, method: 'DELETE' });
const fixture = (await lists()).find(p => p.name === 'zz-audit-fixture');
const src = (await api(`/api/library/playlist/${fixture.id}`, { tok })).tracks || [];
const made = await api('/api/library/playlist', { tok, body: { name: NAME } });
await api(`/api/library/playlist/${made.id}/reorder`, { tok, method: 'PUT', body: { song_ids: src.map(t => t.id) } });
const order = async () => { const r = await api(`/api/library/playlist/${made.id}`, { tok }); if (process.env.MS_DIAG && !(r.tracks || []).length) console.log('   order():', JSON.stringify(r).slice(0, 200)); return (r.tracks || []).map(t => t.name); };
const start = await order();
check('setup: a private copy of the fixture with 4 tracks', start.length === 4, start.join(' | '));

const browser = await pw.chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (TREE) await serveWorktree(context, TREE);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
if (process.env.MS_DIAG) page.on('response', async (r) => { if (/\/reorder|\/api\/library\/playlist\//.test(r.url()) && r.request().method() !== 'GET') console.log('  ', r.request().method(), r.url().split('/api')[1], r.status(), (r.request().postData() || '').slice(0, 200), (await r.text().catch(() => '')).slice(0, 120)); });
await page.addInitScript(() => localStorage.setItem('ms_device_id', 'e2e-reorder'));
try {
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#loginUser'); await page.waitForTimeout(2500);
  await page.fill('#loginUser', USER); await page.fill('#loginPass', PASS); await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#loginScreen')).display === 'none', null, { timeout: 25000 });
  await page.waitForTimeout(1200);
  await page.click('.nav-btn[data-page="library"]');
  await page.getByText(NAME).first().click();
  await page.waitForSelector('#libraryTracks .card .card-drag-handle', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const shown = () => page.evaluate(() => [...document.querySelectorAll('#libraryTracks .card .song-title')].map(e => e.textContent.trim()));
  const drag = async (from, to) => {
    const h = await page.locator('#libraryTracks .card .card-drag-handle').nth(from).boundingBox();
    const t = await page.locator('#libraryTracks .card').nth(to).boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, (h.y + t.y + t.height / 2) / 2, { steps: 6 });
    await page.mouse.move(h.x + h.width / 2, t.y + t.height * (to > from ? 0.75 : 0.25), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
  };
  const expectMove = (list, from, to) => { const a = [...list]; const [x] = a.splice(from, 1); a.splice(to, 0, x); return a; };

  // The FIRST row down two places — the case that did nothing.
  let want = expectMove(start, 0, 2);
  await drag(0, 2);
  check('the first row can be dragged down', JSON.stringify(await shown()) === JSON.stringify(want), (await shown()).join(' | '));
  check('…and the server has the new order', JSON.stringify(await order()) === JSON.stringify(want), (await order()).join(' | '));
  // A middle row up to the top.
  const before = await order();
  want = expectMove(before, 2, 0);
  await drag(2, 0);
  check('a middle row can be dragged to the top', JSON.stringify(await shown()) === JSON.stringify(want), (await shown()).join(' | '));
  // The last row up one (the only thing that "worked" before, by accident).
  const b2 = await order();
  want = expectMove(b2, 3, 2);
  await drag(3, 2);
  check('the last row can be dragged up', JSON.stringify(await order()) === JSON.stringify(want), (await order()).join(' | '));
  check('rows are still inside the list wrapper', await page.evaluate(() => [...document.querySelectorAll('#libraryTracks .card')].every(c => c.parentNode !== document.querySelector('#libraryTracks'))));
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
} catch (e) {
  check('ran to completion', false, String(e.message).split('\n')[0]);
} finally {
  await browser.close();
  await api(`/api/library/playlist/${made.id}`, { tok, method: 'DELETE' });
  check('cleanup: the copy is deleted', !(await lists()).some(p => p.name === NAME));
}
const bad = results.filter(r => !r).length;
console.log(`# ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
