// A playlist row shows the track's energy (five bars) once the server has analysed it
// with the level-independent formula (feature_version >= 3). Also: the queue
// panel's rows carry the meter, and the DJ panel's energy direction is stored and re-picks.
//
// Oracle: production, account claude_test, fixture playlist zz-audit-fixture (READ only).
//   node tests/e2e/audit/energy_badge.mjs [--tree]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const TREE = process.argv.includes('--tree') ? (process.env.MS_TREE || '/home/lucas/music-seeker-wt/energie-playlistu') : null;
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


// ---- expectations for the energy order and summary, from the server's own data ----
const plTitles = tracks.map(t => t.name);
const plIds = tracks.map(t => t.id);
const entryOf = new Map(got.map((g, i) => [tracks[i].name, g]));
const eOf = (title) => { const g = entryOf.get(title); return g && g.feature_version >= 3 && Number.isFinite(g.energy) ? g.energy : null; };
const lvl = (e) => Math.max(1, Math.min(5, Math.floor(e * 5) + 1));
const med = (a) => { const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : null; };
const wantLevels = [0, 0, 0, 0, 0]; for (const t of plTitles) { const e = eOf(t); if (e != null) wantLevels[lvl(e) - 1]++; }
const known = plTitles.map((t, i) => ({ t, i, e: eOf(t) })).filter(x => x.e != null);
const unknown = plTitles.map((t, i) => ({ t, i, e: eOf(t) })).filter(x => x.e == null).map(x => x.t);
const wantMedLevel = known.length ? lvl(med(known.map(x => x.e))) : null;
const wantMissing = unknown.length;
const bpms = got.map(g => (g.tempo_feel > 0 ? g.tempo_feel : g.bpm)).filter(x => Number.isFinite(x) && x > 0);
const wantTempo = bpms.length ? { min: Math.round(Math.min(...bpms)), max: Math.round(Math.max(...bpms)), median: Math.round(med(bpms)) } : null;
const wantAsc = [...known].sort((a, b) => a.e - b.e || a.i - b.i).map(x => x.t).concat(unknown);
const wantDesc = [...known].sort((a, b) => b.e - a.e || a.i - b.i).map(x => x.t).concat(unknown);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const readList = (page) => page.evaluate(() => {
  const cards = [...document.querySelectorAll('#libraryTracks .card')];
  const rows = cards.map((c) => ({ title: c.querySelector('.song-title')?.textContent.trim(), top: c.getBoundingClientRect().top, handle: (() => { const h = c.querySelector('.card-drag-handle'); if (!h) return 'none'; const r = h.getBoundingClientRect(); const cs = getComputedStyle(h); return cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 ? 'hidden' : 'shown'; })() }));
  return { dom: rows.map(r => r.title), shown: [...rows].sort((a, b) => a.top - b.top).map(r => r.title), handles: rows.map(r => r.handle), sorted: document.querySelector('#libraryTracks').classList.contains('energy-sorted') };
});

const browser = await pw.chromium.launch();
try {
  for (const [vp, size] of [['desktop', { width: 1280, height: 900 }], ['tablet', { width: 1024, height: 768 }], ['phone', { width: 390, height: 844 }]]) {
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
    await page.locator('#libraryGrid :text("zz-audit-fixture")').first().click();
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
    // ---- energy order and summary ----
    const sum = await page.evaluate(() => {
      const box = document.querySelector('#libDetailCount + .pl-energy-summary');
      if (!box) return null;
      const t = box.querySelector('.pes-tempo'), e = box.querySelector('.pes-energy');
      return { bars: [...box.querySelectorAll('.pes-bar')].map(b => +b.dataset.count), levels: [...box.querySelectorAll('.pes-bar')].map(b => +b.dataset.level),
               med: e ? +e.dataset.medianLevel : null, missing: e ? +e.dataset.missing : null, tempo: t ? { min: +t.dataset.min, max: +t.dataset.max, median: +t.dataset.median } : null };
    });
    check(`${vp}: the summary shows the five level counts`, !!sum && sum.levels.join() === '1,2,3,4,5' && sum.bars.join() === wantLevels.join(), JSON.stringify({ got: sum && sum.bars, want: wantLevels }));
    check(`${vp}: the summary shows the median level and the missing count`, !!sum && sum.med === wantMedLevel && sum.missing === wantMissing, JSON.stringify({ got: sum && [sum.med, sum.missing], want: [wantMedLevel, wantMissing] }));
    check(`${vp}: the summary shows the tempo min, max and median`, !!sum && !!wantTempo && !!sum.tempo && sum.tempo.min === wantTempo.min && sum.tempo.max === wantTempo.max && sum.tempo.median === wantTempo.median, JSON.stringify({ got: sum && sum.tempo, want: wantTempo }));
    const ctl = await page.evaluate(() => { const c = document.querySelector('.energy-sort'); const t = document.querySelector('#libraryTracks'); return { n: c ? c.querySelectorAll('.es-btn').length : 0, modes: c ? [...c.querySelectorAll('.es-btn')].map(b => b.dataset.mode).join() : '', before: !!c && c.nextElementSibling === t, activeDefault: c ? [...c.querySelectorAll('.es-btn.active')].map(b => b.dataset.mode).join() : '' }; });
    check(`${vp}: the order control sits before the track list, playlist order active`, ctl.n === 3 && ctl.modes === 'playlist,asc,desc' && ctl.before && ctl.activeDefault === 'playlist', JSON.stringify(ctl));
    const base = await readList(page);
    check(`${vp}: the DOM and the screen start in playlist order`, same(base.dom, plTitles) && same(base.shown, plTitles), base.dom.join('|').slice(0, 160));
    for (const [mode, label, want] of [['asc', 'Calm first', wantAsc], ['desc', 'Energetic first', wantDesc]]) {
      const btn = page.locator(`.energy-sort .es-btn[data-mode="${mode}"]`);
      if (!await btn.count()) { check(`${vp}: "${label}" button exists`, false); continue; }
      await btn.click();
      await page.waitForTimeout(300);
      const r = await readList(page);
      const pressed = await page.evaluate((m) => { const b = document.querySelector(`.energy-sort .es-btn[data-mode="${m}"]`); return b.classList.contains('active') && b.getAttribute('aria-pressed') === 'true' && b.textContent.trim(); }, mode);
      check(`${vp}: "${label}" is pressed and shows the rows by energy, unknown last`, pressed === label && r.sorted && same(r.shown, want), JSON.stringify({ shown: r.shown, want }).slice(0, 300));
      check(`${vp}: "${label}" leaves the DOM in playlist order, drag handles hidden`, same(r.dom, plTitles) && r.handles.every(h => h !== 'shown'), r.handles.join());
      if (!unknown.length) console.log(`NOTE  ${vp}: every fixture track has energy, so "unknown last" in ${label} is vacuous here (unit tests only)`);
      else check(`${vp}: "${label}" puts the ${unknown.length} track(s) without energy last`, same(r.shown.slice(r.shown.length - unknown.length), unknown));
      check(`${vp}: no horizontal scroll with the control and summary (${label})`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    if (await page.locator('.energy-sort .es-btn[data-mode="playlist"]').count()) {
      await page.locator('.energy-sort .es-btn[data-mode="playlist"]').click();
      await page.waitForTimeout(300);
    }
    const back = await readList(page);
    check(`${vp}: "Playlist order" restores the rows`, !!ctl.n && back.sorted === false && same(back.shown, plTitles) && same(back.dom, plTitles) && same(back.handles, base.handles), back.handles.join());
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
      // Play from the sorted view: the queue lists the rows as displayed; the playlist is not rewritten.
      if (await page.locator('.energy-sort .es-btn[data-mode="desc"]').count()) await page.locator('.energy-sort .es-btn[data-mode="desc"]').click();
      await page.waitForTimeout(300);
      await page.click('#playLibPlaylist');
      const readQ = () => page.evaluate(() => { const rows = [...document.querySelectorAll('.queue-item')]; const pid = rows[0]?.closest('[id]')?.id; return rows.filter(r => r.closest('[id]')?.id === pid).map(r => r.querySelector('.qi-title')?.textContent.trim()); });
      let qt = [];
      for (let k = 0; k < 30; k++) { await page.waitForTimeout(500); qt = await readQ(); if (same(qt, wantDesc)) break; }
      check('Play All in "Energetic first" queues the tracks in the displayed order', same(qt, wantDesc), JSON.stringify({ queue: qt, want: wantDesc }).slice(0, 300));
      await page.evaluate(() => { for (const m of document.querySelectorAll('audio')) m.pause(); });
      const after = ((await api(`/api/library/playlist/${fixture.id}`, { tok })).tracks || []).map(t => t.id);
      check('the fixture playlist on the server keeps its track order', same(after, plIds), after.join().slice(0, 120));
      // A row's play button in a sorted mode: plays on in the shown order through Up Next (server mirror).
      // Up Next persists on the server between runs, so pick the mode whose order it does NOT hold yet.
      const readMirror = async () => { const up = await api('/api/library/upnext', { tok }); return up && up.id ? ((await api(`/api/library/playlist/${up.id}`, { tok })).tracks || []).map(t => t.name) : []; };
      const pre = await readMirror();
      const [rowMode, rowLabel, rowWant] = same(pre, wantAsc) ? ['desc', 'Energetic first', wantDesc] : ['asc', 'Calm first', wantAsc];
      if (await page.locator(`.energy-sort .es-btn[data-mode="${rowMode}"]`).count()) await page.locator(`.energy-sort .es-btn[data-mode="${rowMode}"]`).click();
      await page.waitForTimeout(300);
      const cardOf = (t) => page.locator('#libraryTracks .card').filter({ has: page.locator('.song-title', { hasText: t }) }).first();
      const shownNow = (await readList(page)).shown;
      await cardOf(shownNow[1]).hover();
      await cardOf(shownNow[1]).locator('.card-play-btn').first().click({ force: true });
      let mirror = [];
      for (let k = 0; k < 20; k++) { await page.waitForTimeout(1000); mirror = await readMirror(); if (same(mirror, rowWant)) break; }
      check(`a row play in "${rowLabel}" mirrors the shown order to the server Up Next`, !same(pre, rowWant) && same(mirror, rowWant), JSON.stringify({ pre, mirror, want: rowWant }).slice(0, 300));
      await page.evaluate(() => { for (const m of document.querySelectorAll('audio')) m.pause(); });
      const after2 = ((await api(`/api/library/playlist/${fixture.id}`, { tok })).tracks || []).map(t => t.id);
      check('the fixture playlist keeps its track order after a row play too', same(after2, plIds), after2.join().slice(0, 120));
      // Shift-click range follows the screen order, not the DOM order.
      const selected = () => page.evaluate(() => [...document.querySelectorAll('#libraryTracks .card[data-selected="true"]')].map(c => c.querySelector('.song-title')?.textContent.trim()));
      const sel = async (title, mod) => { await cardOf(title).locator('.song-title').first().click({ modifiers: [mod] }); await page.waitForTimeout(150); };
      await sel(shownNow[0], 'Control'); await sel(shownNow[1], 'Shift');
      const r12 = await selected();
      check('shift-click between shown rows 1 and 2 selects exactly those two rows', same([...r12].sort(), shownNow.slice(0, 2).sort()), JSON.stringify({ selected: r12, want: shownNow.slice(0, 2) }));
      await sel(shownNow[0], 'Control'); await sel(shownNow[1], 'Control');
      const cleared = await selected();
      await sel(shownNow[0], 'Control'); await sel(shownNow[3], 'Shift');
      const r14 = await selected();
      check('shift-click between shown rows 1 and 4 selects all four (range in screen order)', cleared.length === 0 && same([...r14].sort(), [...shownNow].sort()), JSON.stringify({ cleared, selected: r14 }));
      for (const t of shownNow) await sel(t, 'Control');
      check('the selection can be cleared again', (await selected()).length === 0);
      const after3 = ((await api(`/api/library/playlist/${fixture.id}`, { tok })).tracks || []).map(t => t.id);
      check('the fixture playlist is unchanged after the selection checks', same(after3, plIds));
      if (await page.locator('.energy-sort .es-btn[data-mode="playlist"]').count()) await page.locator('.energy-sort .es-btn[data-mode="playlist"]').click();
    }
    await context.close();
  }
} catch (e) {
  check('ran to completion', false, String(e.message).split('\n').slice(0,4).join(' / '));
} finally { await browser.close(); }
const bad = results.filter(r => !r).length;
console.log(`# ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
