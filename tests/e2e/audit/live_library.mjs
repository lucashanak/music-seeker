// Přejímka GitHub issues #9, #10, #12: Discover má obálky, Liked Songs ukazuje
// obaly svých skladeb a otevřená Knihovna se obnoví sama po změně odjinud.
//
//   node tests/e2e/audit/live_library.mjs            # proti produkci
//   node tests/e2e/audit/live_library.mjs --tree     # stránka ze stromu (backend z produkce)
//   MS_VIEWPORTS=phone node tests/e2e/audit/live_library.mjs
//
// Účet claude_test. Lajkne 4 skladby z fixtury zz-audit-fixture (fixturu jen
// čte) a na konci je zase odlajkne; založí playlist zz-live-* a smaže ho.
// Zápisy jdou přes modul api.js TÉ stránky (stejná instance, stejná adresa),
// tedy stejnou cestou jako přidání do playlistu z přehrávače nebo z menu.
import { open, goPage } from './helpers.mjs';

const args = new Set(process.argv.slice(2));
const worktree = args.has('--tree') ? process.cwd() : null;
const vps = (process.env.MS_VIEWPORTS || 'phone,desktop').split(',');
const FIXTURE = 'zz-audit-fixture';
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

// Zápis přes api.js stránky — ta instance, kterou používá celá aplikace.
const appWrite = (page, path, method, body) => page.evaluate(async ({ path, method, body }) => {
  const src = document.querySelector('script[src*="/static/js/app.js"]')?.src || '';
  const v = (src.match(/\?v=([^&]+)/) || [])[1];
  const m = await import(`/static/js/api.js${v ? `?v=${v}` : ''}`);
  return m.apiJson(path, { method, body });
}, { path, method, body });

// Srdíčko stránky: likes.js toggleLike, stejná instance jako v UI.
const toggleLike = (page, item) => page.evaluate(async (item) => {
  const src = document.querySelector('script[src*="/static/js/app.js"]')?.src || '';
  const v = (src.match(/\?v=([^&]+)/) || [])[1];
  const m = await import(`/static/js/likes.js${v ? `?v=${v}` : ''}`);
  return m.toggleLike(item);
}, item);

const waitFor = async (page, fn, arg, ms = 6000) => {
  try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; }
};

async function discoverArt(page) {
  // #9 — backend: Last.fm dává skladbám a interpretům jen hvězdu; Deezer doplní.
  for (const type of ['track', 'artist']) {
    const r = await api(page, `/api/discover/tag/zouk?type=${type}&limit=20&page=1`);
    const rows = r.body?.results || [];
    const withArt = rows.filter(x => x.image).length;
    const star = rows.filter(x => (x.image || '').includes('2a96cbd8b46e442fc41c2b86b821562f')).length;
    check(`#9 Discover ${type}: most rows have a cover`, rows.length >= 10 && withArt >= rows.length * 0.7, `${withArt}/${rows.length}`);
    check(`#9 Discover ${type}: no placeholder star`, star === 0, `${star}`);
  }
}

async function likedCollage(page, fixtureTracks) {
  // #10 — dlaždice Liked Songs ukazuje obaly nejnovějších lajknutých skladeb.
  const four = fixtureTracks.slice(0, 4);
  try {
    for (const t of four) {
      await toggleLike(page, { name: t.name, artist: t.artist, album: t.album, id: t.id, image: t.image, type: 'track' });
    }
    await goPage(page, 'library');
    await page.evaluate(() => document.querySelector('[data-lib-tab="downloaded"]')?.click());
    await page.waitForTimeout(2500);
    const tile = await page.evaluate(() => {
      const th = document.querySelector('#likedSongsTile .coll-thumb');
      const imgs = th ? [...th.querySelectorAll('img')] : [];
      const r = th?.getBoundingClientRect();
      const row = document.querySelector('#likedSongsTile')?.getBoundingClientRect();
      const pl = document.querySelector('#libraryGrid .coll-row')?.getBoundingClientRect();
      return { n: imgs.length, cls: th?.className || '', loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
        w: r?.width, h: r?.height, rowH: row?.height, plH: pl?.height };
    });
    const distinct = new Set(four.map(t => t.image).filter(Boolean)).size;
    const want = distinct >= 4 ? 4 : (distinct ? 1 : 0);
    check('#10 Liked Songs tile shows the liked covers', tile.n === want && want > 0, JSON.stringify(tile));
    await page.waitForTimeout(1500);
    const loaded = await page.evaluate(() => [...document.querySelectorAll('#likedSongsTile .coll-thumb img')].filter(i => i.naturalWidth > 0).length);
    check('#10 the covers load', loaded === want, `${loaded}/${want}`);
    check('#10 the tile is a row the size of a playlist row', tile.rowH && tile.plH && Math.abs(tile.rowH - tile.plH) < 2 && tile.w <= 64, `row ${tile.rowH} / playlist ${tile.plH}, thumb ${tile.w}`);
    await page.click('#likedSongsTile');
    await page.waitForTimeout(2000);
    const hero = await page.evaluate(() => document.querySelectorAll('#likedHeroImg img').length);
    check('#10 the Liked Songs header shows the same covers', hero === want, `${hero}`);
    await page.goBack();
    await page.waitForTimeout(1200);
  } finally {
    for (const t of four) {
      await toggleLike(page, { name: t.name, artist: t.artist, album: t.album, id: t.id, image: t.image, type: 'track' }).catch(() => {});
    }
  }
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => document.querySelectorAll('#likedSongsTile .coll-thumb img').length);
  check('#10 unliking takes the covers away again (no reload)', after === 0, `${after}`);
}

async function liveLibrary(page, fixtureTracks, vp) {
  // #12 — změna odjinud se v otevřené Knihovně projeví bez reloadu.
  const name = `zz-live-${vp}-${Date.now()}`;
  let id = null;
  try {
    await goPage(page, 'library');
    await page.evaluate(() => document.querySelector('[data-lib-tab="downloaded"]')?.click());
    await page.waitForTimeout(2500);
    const created = await appWrite(page, '/api/library/playlist', 'POST', { name });
    id = created?.id || created?.playlist?.id || null;
    if (!id) {
      const all = (await api(page, '/api/library/playlists')).body?.playlists || [];
      id = all.find(p => p.name === name)?.id || null;
    }
    const shown = await waitFor(page, (n) => [...document.querySelectorAll('#libraryGrid .coll-title')].some(e => e.textContent === n), name);
    check('#12 a new playlist appears in the open Library', shown);

    const song = fixtureTracks[0];
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#libraryGrid .coll-row')].find(r => r.querySelector('.coll-title')?.textContent === n);
      row?.click();
    }, name);
    await page.waitForTimeout(2500);
    const histBefore = await page.evaluate(() => history.length);
    await appWrite(page, `/api/library/playlist/${id}/tracks`, 'PUT', { song_ids: [song.id] });
    const inDetail = await waitFor(page, () => document.querySelectorAll('#libraryTracks .song-row').length === 1);
    const count = await page.evaluate(() => document.querySelector('#libDetailCount')?.textContent || '');
    check('#12 a song added elsewhere appears in the open playlist', inDetail && /^1 tracks/.test(count), count);
    const histAfter = await page.evaluate(() => history.length);
    check('#12 the quiet refresh added no history entry', histAfter === histBefore, `${histBefore} -> ${histAfter}`);
    await page.goBack();
    await page.waitForTimeout(1500);
    const meta = await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#libraryGrid .coll-row')].find(r => r.querySelector('.coll-title')?.textContent === n);
      return row?.querySelector('.coll-meta')?.textContent || '';
    }, name);
    check('#12 back in the list, the row counts the new song', /^1 track/.test(meta), meta);

    // Ze stránky Search (Knihovna skrytá) přidat další skladbu, pak se vrátit.
    await goPage(page, 'search');
    await appWrite(page, `/api/library/playlist/${id}/tracks`, 'PUT', { song_ids: [fixtureTracks[1].id] });
    await page.waitForTimeout(1500);
    await goPage(page, 'library');
    const metaRet = await waitFor(page, (n) => {
      const row = [...document.querySelectorAll('#libraryGrid .coll-row')].find(r => r.querySelector('.coll-title')?.textContent === n);
      return /^2 tracks/.test(row?.querySelector('.coll-meta')?.textContent || '');
    }, name);
    check('#12 a change made on another page shows on returning to Library', metaRet);
  } finally {
    if (id) await api(page, `/api/library/playlist/${id}`, { method: 'DELETE' });
  }
}

async function downloadRecheck(page) {
  // #12 — po dokončeném stahování se viditelné karty zeptají znovu.
  await goPage(page, 'search');
  await page.fill('#searchInput', 'Daft Punk One More Time');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);
  let checks = 0;
  const onReq = (r) => { if (r.url().includes('/api/library/check')) checks++; };
  page.on('request', onReq);
  const ok = await page.evaluate(async () => {
    const src = document.querySelector('script[src*="/static/js/app.js"]')?.src || '';
    const v = (src.match(/\?v=([^&]+)/) || [])[1];
    const q = v ? `?v=${v}` : '';
    const d = await import(`/static/js/downloads.js${q}`);
    const { store } = await import(`/static/js/store.js${q}`);
    store.previousJobStates['e2e-fake-job'] = 'running';
    d.checkJobCompletions([{ id: 'e2e-fake-job', status: 'done', title: 'e2e', method: 'yt-dlp' }]);
    return true;
  });
  await page.waitForTimeout(7000);
  page.off('request', onReq);
  check('#12 a finished download re-checks the cards on screen', ok && checks >= 1, `${checks} check request(s)`);
}

async function followedArtists(page) {
  // #11 (jasná část) — záložka se sledovanými interprety se tak i jmenuje.
  await goPage(page, 'library');
  const tab = await page.evaluate(() => document.querySelector('[data-lib-tab="favorites"]')?.textContent.trim());
  await page.evaluate(() => document.querySelector('[data-lib-tab="favorites"]')?.click());
  await page.waitForTimeout(1500);
  const title = await page.evaluate(() => document.querySelector('#pageFavorites .page-title')?.textContent.trim());
  check('#11 the followed-artists tab says what it holds', tab === 'Artists' && title === 'Followed Artists', `${tab} / ${title}`);
  await page.evaluate(() => document.querySelector('[data-lib-tab="downloaded"]')?.click());
  await page.waitForTimeout(800);
}

let failed = 0;
for (const vp of vps) {
  console.log(`\n=== ${vp}${worktree ? ' (tree)' : ''}`);
  const s = await open({ viewport: vp, device: `live-${vp}`, worktree });
  try {
    const pls = (await api(s.page, '/api/library/playlists')).body?.playlists || [];
    const fx = pls.find(p => p.name === FIXTURE);
    const tracks = fx ? ((await api(s.page, `/api/library/playlist/${fx.id}`)).body?.tracks || []) : [];
    if (!check('fixture readable', tracks.length >= 4, `${tracks.length}`)) { failed++; continue; }
    if (vp === vps[0]) await discoverArt(s.page);
    if (vp === vps[0]) await followedArtists(s.page);
    await likedCollage(s.page, tracks);
    await liveLibrary(s.page, tracks, vp);
    if (vp === vps[0]) await downloadRecheck(s.page);
    check('no page errors', s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
  } catch (e) {
    check(`run ${vp}`, false, e.message);
  } finally {
    await s.browser.close();
  }
}
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`\nlive_library: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
