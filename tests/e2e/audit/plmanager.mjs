// Přejímka: Knihovna → Manager. Dva playlisty vedle sebe; přetažení řádku mění
// pořadí uvnitř playlistu nebo ho přesune/zkopíruje do druhého; klik přehraje.
//
//   node tests/e2e/audit/plmanager.mjs            # všechna tři rozlišení
//   node tests/e2e/audit/plmanager.mjs --tree     # stránka ze stromu (serveWorktree)
//   MS_VIEWPORTS=phone node tests/e2e/audit/plmanager.mjs
//
// Běží na účtu claude_test. Skladby si bere z fixtury zz-audit-fixture (jen
// čte), pracuje na dvou vlastních playlistech zz-plm-*, které na konci smaže.
// Každý tvrzený stav se ověřuje na SERVERU (GET playlistu), ne jen v DOM.
import { open, VIEWPORTS } from './helpers.mjs';

const args = new Set(process.argv.slice(2));
const worktree = args.has('--tree') ? process.cwd() : null;
const vps = (process.env.MS_VIEWPORTS || 'phone,tablet,desktop').split(',');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + detail : ''}`);
  return !!ok;
};

const api = (page, path, opts = {}) => page.evaluate(async ({ path, opts }) => {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ms_token'),
      'X-Device-ID': localStorage.getItem('ms_device_id') || 'default' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, { path, opts });

const serverIds = async (page, id) => ((await api(page, `/api/library/playlist/${id}`)).body.tracks || []).map(t => t.id);
const paneIds = (page, i) => page.$$eval(`#plmPanes .plm-pane[data-pane="${i}"] .plm-row`, rs => rs.map(r => r.dataset.id));
const idle = (page) => page.waitForFunction(() => !document.querySelector('#pagePlManager.plm-busy'), null, { timeout: 30000 });

async function rowBox(page, pane, idx, sel = '') {
  const el = await page.$(`#plmPanes .plm-pane[data-pane="${pane}"] .plm-row[data-idx="${idx}"] ${sel}`);
  if (!el) throw new Error(`řádek ${pane}/${idx} ${sel} chybí`);
  return el.boundingBox();
}

async function mouseDrag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 12;
  for (let s = 1; s <= steps; s++) {
    await page.mouse.move(from.x + (to.x - from.x) * s / steps, from.y + (to.y - from.y) * s / steps);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(100);
  await page.mouse.up();
}

async function touchDrag(context, page, from, to) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  const steps = 16;
  for (let s = 1; s <= steps; s++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * s / steps, y: from.y + (to.y - from.y) * s / steps }] });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(100);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
// The upper quarter of a row = "drop before it"; the lower quarter = "after it".
const upper = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height * 0.25 });
const lower = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height * 0.75 });

async function selectPane(page, i, id) {
  await page.selectOption(`#plmPanes .plm-pane[data-pane="${i}"] .plm-select`, String(id));
  await page.waitForFunction((i) => document.querySelectorAll(`#plmPanes .plm-pane[data-pane="${i}"] .skeleton`).length === 0, i, { timeout: 15000 });
  await page.waitForTimeout(300);
}

async function run(vpName) {
  const { browser, context, page, errors } = await open({ viewport: vpName, device: `plm-${vpName}`, worktree });
  const tag = (s) => `[${vpName}] ${s}`;
  const created = [];
  try {
    // ── Fixture: two own playlists, songs from zz-audit-fixture ──
    const pls = (await api(page, '/api/library/playlists')).body.playlists;
    for (const p of pls.filter(p => p.name.startsWith('zz-plm-'))) await api(page, `/api/library/playlist/${p.id}`, { method: 'DELETE' });
    const fix = pls.find(p => p.name === 'zz-audit-fixture');
    if (!fix) throw new Error('fixtura zz-audit-fixture chybí');
    const S = await serverIds(page, fix.id);
    if (S.length < 4) throw new Error('fixtura má < 4 skladby');
    const mk = async (name, ids) => {
      const r = await api(page, '/api/library/playlist', { method: 'POST', body: { name } });
      created.push(r.body.id);
      if (ids.length) await api(page, `/api/library/playlist/${r.body.id}/tracks`, { method: 'PUT', body: { song_ids: ids } });
      return r.body.id;
    };
    const A = await mk(`zz-plm-A-${vpName}`, S.slice(0, 4));
    const B = await mk(`zz-plm-B-${vpName}`, [S[3]]);

    // ── Open the tab ──
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.bnav-btn[data-page="library"], .nav-btn[data-page="library"]')].find(x => x.offsetParent !== null);
      b.click();
    });
    await page.waitForTimeout(1500);
    await page.click('#libraryTabs .sp-tab[data-lib-tab="manager"]');
    await page.waitForSelector('#plmPanes .plm-pane[data-pane="1"] .plm-select', { timeout: 15000 });
    await selectPane(page, 0, A);
    await selectPane(page, 1, B);

    const layout = await page.evaluate(() => {
      const ps = [...document.querySelectorAll('#plmPanes .plm-pane')].map(p => p.getBoundingClientRect());
      return { n: ps.length, side: ps.length === 2 && Math.abs(ps[0].top - ps[1].top) < 2, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    check(tag('two panes, no horizontal scroll'), layout.n === 2 && !layout.overflow, JSON.stringify(layout));
    check(tag(vpName === 'phone' ? 'phone: panes stacked' : 'panes side by side'), vpName === 'phone' ? !layout.side : layout.side);
    check(tag('pane rows = server'), JSON.stringify(await paneIds(page, 0)) === JSON.stringify(S.slice(0, 4)));
    {
      const all = (await api(page, '/api/library/playlists')).body.playlists;
      const own = all.filter(p => p.own).map(p => String(p.id)).sort();
      const opts = await page.$$eval('#plmPanes .plm-pane[data-pane="0"] .plm-select option',
        os => os.map(o => o.value).filter(v => v && !v.startsWith('__')).sort());
      check(tag('only own playlists offered'), JSON.stringify(opts) === JSON.stringify(own)
        && all.filter(p => p.own).every(p => p.owner === 'claude_test'),
        `opts=${opts.length} own=${own.length} all=${all.length}`);
    }

    const touch = vpName === 'phone';
    const drag = async (from, to) => (touch ? touchDrag(context, page, from, to) : mouseDrag(page, from, to));
    const grab = async (pane, idx) => center(await rowBox(page, pane, idx, touch ? '.plm-handle' : '.plm-title'));

    // 1) Reorder within A: row 0 below row 2  → [1,2,0,3]
    await drag(await grab(0, 0), lower(await rowBox(page, 0, 2)));
    await idle(page);
    let a = await serverIds(page, A);
    check(tag('reorder within a playlist (server)'), JSON.stringify(a) === JSON.stringify([S[1], S[2], S[0], S[3]]), a.map(x => S.indexOf(x)).join(','));
    check(tag('reorder: view = server'), JSON.stringify(await paneIds(page, 0)) === JSON.stringify(a));

    // 2) Move A row 0 (S1) to B before its row 0 → B [S1,S3], A [S2,S0,S3]
    await drag(await grab(0, 0), upper(await rowBox(page, 1, 0)));
    await idle(page);
    a = await serverIds(page, A);
    let b = await serverIds(page, B);
    check(tag('move to the other playlist, at the drop position'),
      JSON.stringify(b) === JSON.stringify([S[1], S[3]]) && JSON.stringify(a) === JSON.stringify([S[2], S[0], S[3]]),
      `A=${a.map(x => S.indexOf(x))} B=${b.map(x => S.indexOf(x))}`);

    // 3) Copy mode: A row 0 (S2) to the end of B → A unchanged, B [S1,S3,S2]
    await page.click('#pagePlManager [data-plm-mode="copy"]');
    await drag(await grab(0, 0), lower(await rowBox(page, 1, 1)));
    await idle(page);
    a = await serverIds(page, A);
    b = await serverIds(page, B);
    check(tag('copy keeps the source'),
      JSON.stringify(a) === JSON.stringify([S[2], S[0], S[3]]) && JSON.stringify(b) === JSON.stringify([S[1], S[3], S[2]]),
      `A=${a.map(x => S.indexOf(x))} B=${b.map(x => S.indexOf(x))}`);

    // 4) A track already in the target is not duplicated (S3 is in both)
    await drag(await grab(0, 2), center(await rowBox(page, 1, 0)));
    await idle(page);
    b = await serverIds(page, B);
    check(tag('no duplicate in the target'), b.filter(x => x === S[3]).length === 1, `B=${b.map(x => S.indexOf(x))}`);
    await page.click('#pagePlManager [data-plm-mode="move"]');

    // 5) Filter on: drop row onto the only visible row of B
    const bname = await page.$eval(`#plmPanes .plm-pane[data-pane="1"] .plm-row[data-idx="2"] .plm-title`, e => e.textContent);
    await page.fill('#plmPanes .plm-pane[data-pane="1"] .plm-filter', bname);
    await page.waitForTimeout(200);
    const vis = await page.$$eval('#plmPanes .plm-pane[data-pane="1"] .plm-row', rs => rs.map(r => +r.dataset.idx));
    // Move A row 1 (S0) before B's visible row (idx 2) → B [S1,S3,S0,S2]
    await drag(await grab(0, 1), upper(await rowBox(page, 1, vis[0])));
    await idle(page);
    b = await serverIds(page, B);
    check(tag('drop into a filtered list lands at the real index'),
      JSON.stringify(b) === JSON.stringify([S[1], S[3], S[0], S[2]]), `visible=${vis} B=${b.map(x => S.indexOf(x))}`);
    await page.fill('#plmPanes .plm-pane[data-pane="1"] .plm-filter', '');
    await page.waitForTimeout(200);

    // 6) A click plays the playlist from that row (a click, not a drag — no write)
    const before = await serverIds(page, B);
    const name2 = await page.$eval('#plmPanes .plm-pane[data-pane="1"] .plm-row[data-idx="2"] .plm-title', e => e.textContent);
    await page.click('#plmPanes .plm-pane[data-pane="1"] .plm-row[data-idx="2"] .plm-title');
    let playing = false;
    try {
      await page.waitForFunction((n) => (document.querySelector('#playerTitle')?.textContent || '').trim() === n, name2, { timeout: 20000 });
      playing = true;
    } catch {}
    check(tag('click plays that track'), playing, `want "${name2}", bar "${await page.$eval('#playerTitle', e => e.textContent)}"`);
    check(tag('click wrote nothing'), JSON.stringify(await serverIds(page, B)) === JSON.stringify(before));
    await page.waitForTimeout(1200);
    const now = await page.$$eval('#plmPanes .plm-row.plm-now .plm-title', rs => rs.map(r => r.textContent));
    check(tag('the playing row is marked'), now.includes(name2), JSON.stringify(now));
    await page.evaluate(() => { const a = document.querySelectorAll('audio'); a.forEach(x => { try { x.pause(); } catch {} }); });

    // 7) Escape cancels a drag (mouse only)
    if (!touch) {
      const p0 = await serverIds(page, A);
      const f = await grab(0, 0);
      await page.mouse.move(f.x, f.y); await page.mouse.down();
      const t = lower(await rowBox(page, 1, 0));
      await page.mouse.move(t.x, t.y, { steps: 8 });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForTimeout(800);
      check(tag('Escape cancels the drag'), JSON.stringify(await serverIds(page, A)) === JSON.stringify(p0)
        && !(await page.$('.plm-ghost')));
    }

    // 8) Row menu: Move to top
    await page.click('#plmPanes .plm-pane[data-pane="1"] .plm-row[data-idx="3"] .plm-more');
    await page.click('.ctx-menu .ctx-menu-item:has-text("Move to top")');
    await idle(page);
    b = await serverIds(page, B);
    check(tag('menu: move to top'), b[0] === before[3], `B=${b.map(x => S.indexOf(x))}`);

    // 9) B is playing: the player's queue follows the edit (a stale copy would
    //    be written back by the queue panel) and the same track keeps playing.
    await page.waitForTimeout(3000);   // saveQueueDebounced = 2 s
    const qs = (await api(page, '/api/player/queue')).body || {};
    const qids = (qs.queue || []).map(t => t.id);
    const cur = (qs.queue || [])[qs.current_index];
    check(tag('playing queue = edited playlist'), JSON.stringify(qids) === JSON.stringify(b),
      `queue=${qids.map(x => S.indexOf(x))} B=${b.map(x => S.indexOf(x))} mode=${JSON.stringify(qs.playlist_mode)}`);
    check(tag('same track still current'), cur && cur.name === name2, cur && cur.name);

    // 10) A queue that is NOT a copy of the playlist is never replaced by it.
    //     Library → B → Shuffle plays a shuffled array with playlistMode = B;
    //     an edit of B in the manager must leave that order alone and untie it.
    const bName = `zz-plm-B-${vpName}`;
    await page.click('#libraryTabs .sp-tab[data-lib-tab="downloaded"]');
    await page.waitForTimeout(1500);
    await page.click(`#libraryGrid .coll-row:has-text("${bName}")`);
    await page.waitForSelector('#shuffleLibPlaylist', { state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1500);
    // Wait for the shuffled queue to be SAVED (it lands a moment after the
    // click), and deal again if it came out in playlist order (1 in 24). Reading
    // too early returned the previous queue — a copy of B — and silently skipped
    // both checks below.
    const bNow = await serverIds(page, B);
    let shuffled = bNow;
    for (let deal = 0; deal < 4 && JSON.stringify(shuffled) === JSON.stringify(bNow); deal++) {
      await page.click('#shuffleLibPlaylist');
      for (let t = 0; t < 20; t++) {
        await page.waitForTimeout(500);
        const q = (((await api(page, '/api/player/queue')).body || {}).queue || []).map(x => x.id);
        if (q.length === bNow.length && [...q].sort().join() === [...bNow].sort().join()
            && JSON.stringify(q) !== JSON.stringify(bNow)) { shuffled = q; break; }
      }
    }
    await page.click('#libraryTabs .sp-tab[data-lib-tab="manager"]');
    await page.waitForTimeout(2000);
    check(tag('Shuffle dealt a different order'), JSON.stringify(shuffled) !== JSON.stringify(bNow),
      `B=${bNow.map(x => S.indexOf(x))}`);
    {
      await page.click('#plmPanes .plm-pane[data-pane="1"] .plm-row[data-idx="0"] .plm-more');
      await page.click('.ctx-menu .ctx-menu-item:has-text("Move to bottom")');
      await idle(page);
      await page.waitForTimeout(3000);
      const q2 = (await api(page, '/api/player/queue')).body || {};
      check(tag('shuffled queue left alone'), JSON.stringify((q2.queue || []).map(t => t.id)) === JSON.stringify(shuffled),
        `queue=${(q2.queue || []).map(t => S.indexOf(t.id))} shuffled=${shuffled.map(x => S.indexOf(x))}`);
      check(tag('…and no longer tied to the playlist'), !q2.playlist_mode, JSON.stringify(q2.playlist_mode));
    }

    check(tag('no page errors'), errors.length === 0, errors.join(' | '));
  } catch (e) {
    check(tag('run'), false, e.stack || String(e));
  } finally {
    // The test device's saved queue points at zz-plm-B (it was playing): empty it
    // before the playlist goes.
    await page.evaluate(() => document.querySelectorAll('audio').forEach(a => { try { a.pause(); } catch {} })).catch(() => {});
    await api(page, '/api/player/queue', { method: 'PUT', body: { queue: [], current_index: -1, position_seconds: 0, volume: 1, playlist_mode: null } }).catch(() => {});
    for (const id of created) await api(page, `/api/library/playlist/${id}`, { method: 'DELETE' }).catch(() => {});
    const left = ((await api(page, '/api/library/playlists').catch(() => ({ body: { playlists: [] } }))).body.playlists || [])
      .filter(p => p.name.startsWith('zz-plm-'));
    check(tag('cleanup'), left.length === 0, left.map(p => p.name).join(','));
    await browser.close();
  }
}

for (const vp of vps) {
  if (!VIEWPORTS[vp]) throw new Error(`neznámý viewport ${vp}`);
  await run(vp);
}
const fail = results.filter(r => !r.ok).length;
console.log(`\nplmanager: ${results.length - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
