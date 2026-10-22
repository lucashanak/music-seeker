// knihovna.mjs — checks for the Library / Downloads findings of the October UX
// audit (notes/impl/audit-2026-10/library.md, points K1-K18).
//
// Oracle: production runs the old code, so every check here has to FAIL against
// https://musicseeker.hanaktech.org as it stands. Running it again with
// MS_PATCH=1 hands the same live page the REAL files out of the tree —
// index.html included — through the shared harness's open({ worktree }), and
// the same checks have to pass. Red on its own proves nothing: a typo in a
// selector is red too, which is why every row prints the number it measured.
//
// Nothing in here installs a stand-in for the code it measures. What IS
// replaced, through page.route, are SERVER ANSWERS — /api/jobs, /api/favorites,
// /api/podcasts — because those are the input a state like "a job handed to
// Lidarr" or "no favourites yet" is made of, and this account has neither.
// The two write paths that would otherwise touch the server (K6's remove, K17's
// delete) are intercepted and answered locally, so production is only read.
//
//   node tests/e2e/audit/knihovna.mjs             → against production, expect FAIL
//   MS_PATCH=1 node tests/e2e/audit/knihovna.mjs  → tree served, expect PASS
//   MS_TREE=/some/tree node tests/e2e/audit/knihovna.mjs  → serve that tree
//   MS_ONLY=K1,K8 ... → run a subset; MS_VIEWPORTS=tablet → one resolution
//
// Playlist fixture: zz-audit-fixture on claude_test (4 tracks). It is read, and
// the one check that removes a track from it never lets the request leave the
// browser.

import { open, makeReport, goPage, URL as PROD } from './helpers.mjs';

const ROOT = process.env.MS_TREE || '/home/lucas/music-seeker';
const TREE = process.env.MS_TREE || (process.env.MS_PATCH === '1' ? ROOT : null);
const PATCH = !!TREE;
const DEVICE = 'autor2-5-c5';
const ONLY = process.env.MS_ONLY ? process.env.MS_ONLY.split(',') : null;
const FIXTURE = 'zz-audit-fixture';

const want = (id) => !ONLY || ONLY.includes(id.split('/')[0]);

// A dynamic import inside the page has to spell the module URL the way the page
// already loaded it, or the browser fetches a second copy with its own `store`.
// That is the stamp entrypoint.sh writes and serveWorktree replays.
let STAMP = '';
async function readStamp() {
  const html = await (await fetch(PROD + '/')).text();
  const m = html.match(/variables\.css\?v=(\d+)/);
  if (!m) throw new Error('nepodařilo se přečíst cache-bust z produkce');
  return m[1];
}

// A job list this account does not have: one still running with no percentage
// to show (K4) and one handed to Lidarr (K3). `handed_off` is the flag the
// backend half of K3 sets; the frontend half is what this measures.
const JOBS_MIXED = {
  jobs: [
    {
      id: 'audit-running', title: 'Audit — single track', status: 'running',
      method: 'yt-dlp', format: 'flac', progress: 0,
      progress_text: '1/1 — Downloading Audit — single track', error: '',
    },
    {
      id: 'audit-lidarr', title: 'Audit — handed to Lidarr', status: 'done',
      method: 'lidarr', format: 'flac', progress: 100, handed_off: true,
      progress_text: 'Search triggered in Lidarr, download will proceed in background',
      error: '',
    },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// open() navigates on its own, so any /api/ answer a check wants to replace has
// to be routed before that — hence login:false here and an explicit sign-in.
async function prepare(viewport, setup) {
  const s = await open({ viewport, device: DEVICE, login: false, worktree: TREE });
  if (setup) await setup(s);
  await s.page.waitForSelector('#loginUser', { timeout: 20000 });
  await s.page.waitForTimeout(2500);
  await s.page.fill('#loginUser', 'claude_test');
  await s.page.fill('#loginPass', 'TestPass2026!');
  await s.page.click('button:has-text("Sign In")');
  await s.page.waitForFunction(() => {
    const l = document.querySelector('#loginScreen');
    return l && getComputedStyle(l).display === 'none';
  }, { timeout: 25000 });
  await s.page.waitForTimeout(1200);
  return s;
}

async function openLibrary(page) {
  await goPage(page, 'library');
  await page.click('#libraryTabs .sp-tab[data-lib-tab="downloaded"]');
  await page.waitForTimeout(2000);
}

async function openFixture(page) {
  await openLibrary(page);
  await page.waitForSelector('#libraryGrid .lib-card', { timeout: 20000 });
  const card = page.locator('#libraryGrid .lib-card', { hasText: FIXTURE }).first();
  if (!(await card.count())) return false;
  await card.locator('.card-title').click();
  await page.waitForSelector('#libraryTracks .card', { timeout: 20000 });
  await page.waitForTimeout(800);
  return true;
}

// Click a context-menu entry by its LABEL, matched exactly. Never by position:
// "Download" sits one row away from several of these and it really downloads.
// Walking the items beats a :text-is() selector because these labels contain
// quotes (Remove from "zz-audit-fixture").
async function clickMenu(page, label) {
  const items = page.locator('.ctx-menu .ctx-menu-item');
  for (let i = 0, n = await items.count(); i < n; i++) {
    const t = ((await items.nth(i).locator('.ctx-menu-label').textContent()) || '').trim();
    if (t === label) { await items.nth(i).click(); return true; }
  }
  return false;
}

async function menuLabels(page) {
  return page.$$eval('.ctx-menu .ctx-menu-label', (els) => els.map((e) => e.textContent.trim()));
}

async function closePanel(page) {
  if (await page.locator('#downloadsPanel.open').count()) {
    await page.click('#panelClose');
    await page.waitForTimeout(800);
  }
}

async function openPanel(page) {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#downloadsToggle, #bnavDownloads')]
      .find((x) => x.offsetParent !== null);
    if (!b) throw new Error('Downloads toggle není vidět');
    b.click();
  });
  await page.waitForTimeout(1200);
}

// ── K1, K8, K9, K14, K18 — layout and markup of the Library page ───────────
async function runLibrary(viewport, rep) {
  const s = await prepare(viewport);
  const { page } = s;
  try {
    await openLibrary(page);
    await page.waitForSelector('#libraryGrid .lib-card', { timeout: 20000 });

    if (want('K1')) {
      const m = await page.evaluate(() => {
        const tile = document.querySelector('#likedSongsTile');
        const card = document.querySelector('#libraryGrid .lib-card');
        if (!tile || !card) return null;
        const t = tile.getBoundingClientRect(), c = card.getBoundingClientRect();
        return { tw: Math.round(t.width), th: Math.round(t.height), cw: Math.round(c.width), ch: Math.round(c.height) };
      });
      rep.check(`K1/${viewport}`, 'the Liked Songs tile is the size of a playlist card',
        !!m && Math.abs(m.tw - m.cw) <= 4 && Math.abs(m.th - m.ch) <= 24,
        m ? `tile ${m.tw}x${m.th}, karta ${m.cw}x${m.ch}` : 'dlaždice nebo karta chybí');
    }

    if (want('K14')) {
      const n = await page.$$eval('#libraryGrid .lib-card .kebab-btn', (e) => e.length);
      const cards = await page.$$eval('#libraryGrid .lib-card', (e) => e.length);
      rep.check(`K14/${viewport}`, 'every library playlist card carries a visible kebab',
        cards > 0 && n === cards, `karet ${cards}, kebabů ${n}`);
    }

    if (want('K18')) {
      const dups = await page.evaluate(() => {
        const count = (id) => {
          const el = document.querySelector(id);
          if (!el) return -1;
          return (el.getAttribute('style') || '').split(';').filter((d) => d.trim().startsWith('display')).length;
        };
        return { bulk: count('#libBulkActions'), pod: count('#podcastBulkBar') };
      });
      rep.check(`K18/${viewport}`, 'no element declares `display` twice inline',
        dups.bulk === 1 && dups.pod === 1, `#libBulkActions ${dups.bulk}x, #podcastBulkBar ${dups.pod}x`);
    }

    const opened = (want('K8') || want('K9') || want('K5') || want('K6')) ? await openFixture(page) : false;
    if (!opened) {
      for (const id of ['K8', 'K9']) if (want(id)) rep.skip(`${id}/${viewport}`, 'hrdinka knihovního playlistu', `fixtura ${FIXTURE} nenalezena`);
    } else {
      if (want('K8')) {
        const hero = await page.evaluate(() => {
          const row = document.querySelector('#libraryDetail .playlist-hero-actions');
          if (!row) return null;
          const btns = [...row.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
          return {
            n: btns.length,
            kebab: !!row.querySelector('.kebab-btn'),
            labels: btns.map((b) => b.textContent.trim()).filter(Boolean),
            danger: !!row.querySelector('.btn-hero-danger'),
          };
        });
        // The second slot is checked by NAME, not just counted: R5.2 found
        // Shuffle sitting where the reach for an additive action goes, and
        // Shuffle replaces the whole queue. A swap back turns this red.
        const second = hero && hero.labels[1] ? hero.labels[1] : '';
        rep.check(`K8/${viewport}`, 'the hero keeps Play + Add All + Shuffle + one kebab, the additive action stays second, Delete is gone',
          !!hero && hero.n <= 4 && hero.kebab && !hero.danger && /add all/i.test(second),
          hero ? `tlačítek ${hero.n} (${hero.labels.join(' | ')}), druhé="${second}", kebab=${hero.kebab}, červené Delete=${hero.danger}` : 'hrdinka chybí');
      }
      if (want('K9')) {
        const sh = await page.$$eval('#shuffleLibPlaylist', (e) => e.length);
        rep.check(`K9/${viewport}`, 'a library playlist offers Shuffle', sh === 1, `#shuffleLibPlaylist ${sh}x`);
      }
    }
  } finally {
    await s.browser.close();
  }
}

// ── K2 — the Liked Songs count must survive a slow /api/likes ──────────────
async function runLikedCount(viewport, rep) {
  // Without a delay this passes on production too: the single load fired at
  // login usually lands before the Library is ever rendered. Held back far
  // enough to put the render first, which is the race the finding describes.
  let held = false;
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/library/likes**', async (route) => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true;
      await new Promise((r) => setTimeout(r, 15000));
      await route.continue();
    });
  });
  const { page } = s;
  try {
    await openLibrary(page);
    const early = ((await page.textContent('#likedSongsCount')) || '').trim();
    await page.waitForTimeout(22000);
    const txt = (await page.textContent('#likedSongsCount')) || '';
    rep.check(`K2/${viewport}`, 'the Liked Songs tile reports the real count after a slow /api/library/likes',
      /^[1-9]/.test(txt.trim()), `#likedSongsCount: při vykreslení "${early}", po doběhnutí "${txt.trim()}" (odpověď zdržena o 15 s)`);
  } finally {
    await s.browser.close();
  }
}

// ── K3, K4, K15 — the jobs panel over a stubbed job list ───────────────────
async function runJobs(viewport, rep) {
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/jobs', (route) =>
      route.request().method() === 'GET' ? json(route, JOBS_MIXED) : route.continue());
  });
  const { page } = s;
  try {
    await openPanel(page);
    await page.waitForTimeout(1500);

    if (want('K3')) {
      const m = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#jobsList .job-item')];
        const card = items.find((i) => (i.querySelector('.job-title') || {}).textContent?.includes('Lidarr'));
        if (!card) return null;
        const status = card.querySelector('.job-status');
        const text = card.querySelector('.job-progress-text');
        const cs = text ? getComputedStyle(text) : null;
        return {
          badge: status ? status.textContent.trim() : '',
          clipped: cs ? (cs.whiteSpace === 'nowrap' || cs.textOverflow === 'ellipsis') : true,
          height: text ? `${text.scrollHeight}/${text.clientHeight}` : '—',
        };
      });
      rep.check(`K3/${viewport}`, 'a job handed to Lidarr says so instead of DONE, and its explanation wraps',
        !!m && /Sent to Lidarr/i.test(m.badge) && !m.clipped,
        m ? `odznak "${m.badge}", ořez=${m.clipped}, výška textu ${m.height}` : 'job předaný Lidarru v panelu není');
    }

    if (want('K4')) {
      const m = await page.evaluate(() => {
        const bar = document.querySelector('#jobsList .job-progress-bar');
        if (!bar) return null;
        return {
          indeterminate: bar.classList.contains('indeterminate'),
          groove: getComputedStyle(bar).backgroundColor,
          card: getComputedStyle(bar.closest('.job-item')).backgroundColor,
        };
      });
      rep.check(`K4/${viewport}`, 'a download with no percentage shows motion, over a groove you can see',
        !!m && m.indeterminate && m.groove !== m.card,
        m ? `indeterminate=${m.indeterminate}, drážka ${m.groove} vs. karta ${m.card}` : 'ukazatel chybí');
    }

    if (want('K15')) {
      const groups = await page.$$eval('#jobsList .jobs-group-title', (e) => e.map((x) => x.textContent.trim()));
      rep.check(`K15/${viewport}`, 'running and finished downloads are told apart',
        groups.length === 2, `skupin ${groups.length}${groups.length ? ': ' + groups.join(' | ') : ''}`);
    }
  } finally {
    await s.browser.close();
  }
}

// ── K16 — a failing /api/jobs must be visible, not swallowed ───────────────
async function runJobsError(viewport, rep) {
  let fail = false;
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/jobs', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (fail) return json(route, { detail: 'Bad Gateway' }, 502);
      return json(route, JOBS_MIXED);
    });
  });
  const { page } = s;
  try {
    await openPanel(page);
    await page.waitForTimeout(1200);
    fail = true;
    await page.waitForTimeout(7000);
    const m = await page.evaluate(() => ({
      error: !!document.querySelector('#jobsList .jobs-error'),
      text: (document.querySelector('#jobsList .jobs-error') || {}).textContent || '',
      items: document.querySelectorAll('#jobsList .job-item').length,
    }));
    rep.check(`K16/${viewport}`, 'a 502 from /api/jobs is shown instead of swallowed',
      m.error, `.jobs-error=${m.error} "${m.text.trim()}", položek ${m.items}`);
  } finally {
    await s.browser.close();
  }
}

// ── K11 — the three empty states, each over a stubbed empty answer ─────────
async function runEmptyStates(viewport, rep) {
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/jobs', (route) =>
      route.request().method() === 'GET' ? json(route, { jobs: [] }) : route.continue());
    await context.route('**/api/podcasts', (route) =>
      route.request().method() === 'GET' ? json(route, { shows: [], total_size: 0 }) : route.continue());
    await context.route('**/api/favorites', (route) =>
      route.request().method() === 'GET' ? json(route, { artists: [] }) : route.continue());
  });
  const { page } = s;
  try {
    await openPanel(page);
    await page.waitForTimeout(1500);
    const dl = await page.evaluate(() => ({
      cta: !!document.querySelector('#jobsEmptyFind'),
      text: (document.querySelector('#jobsList .empty-state') || {}).textContent || '',
    }));
    rep.check(`K11a/${viewport}`, 'an empty Downloads panel offers a way out',
      dl.cta, `#jobsEmptyFind=${dl.cta} "${dl.text.trim().slice(0, 70)}"`);
    await closePanel(page);

    await goPage(page, 'library');
    await page.click('#libraryTabs .sp-tab[data-lib-tab="podcasts"]');
    await page.waitForTimeout(2500);
    const pod = await page.evaluate(() => ({
      cta: !!document.querySelector('#podcastsEmptyFind'),
      text: (document.querySelector('#podcastsList .empty-state') || {}).textContent || '',
    }));
    rep.check(`K11b/${viewport}`, 'an empty Podcasts tab offers a way out',
      pod.cta, `#podcastsEmptyFind=${pod.cta} "${pod.text.trim().slice(0, 70)}"`);

    await page.click('#libraryTabs .sp-tab[data-lib-tab="favorites"]');
    await page.waitForTimeout(2500);
    const fav = await page.evaluate(() => {
      const el = document.querySelector('#favoritesEmpty');
      return { cta: !!document.querySelector('#favoritesEmptyFind'), text: el ? el.textContent.trim() : '' };
    });
    // The old sentence sent the user to a heart that is invisible until hover —
    // exactly on the devices where hover exists.
    rep.check(`K11c/${viewport}`, 'empty Favorites names a followable route, not the hover-only heart',
      fav.cta && !/heart icon/i.test(fav.text),
      `#favoritesEmptyFind=${fav.cta}, text "${fav.text.slice(0, 90)}"`);
  } finally {
    await s.browser.close();
  }
}

// ── K7 — a followed artist opens the artist, not the download dialog ───────
async function runFavoriteClick(viewport, rep) {
  // claude_test follows nobody, and following somebody would be a write to
  // production. The list is an input, so it is supplied here.
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/favorites', (route) =>
      route.request().method() === 'GET'
        ? json(route, { artists: [{ id: '27', name: 'Daft Punk', image: '', provider: 'deezer' }] })
        : route.continue());
  });
  const { page } = s;
  try {
    await goPage(page, 'library');
    await page.click('#libraryTabs .sp-tab[data-lib-tab="favorites"]');
    await page.waitForTimeout(3000);
    const n = await page.$$eval('#favoritesGrid .fav-card', (e) => e.length);
    if (!n) { rep.skip(`K7/${viewport}`, 'followed artist opens the artist page', 'podstrčený seznam sledovaných se nevykreslil'); return; }
    await page.locator('#favoritesGrid .fav-card .card-title').first().click();
    await page.waitForTimeout(3500);
    const m = await page.evaluate(() => ({
      artist: !!document.querySelector('#artistDetail') && document.querySelector('#artistDetail').offsetParent !== null,
      modal: !!document.querySelector('#downloadModal.open'),
    }));
    rep.check(`K7/${viewport}`, 'tapping a followed artist opens the artist page',
      m.artist && !m.modal, `#artistDetail viditelný=${m.artist}, stahovací dialog otevřený=${m.modal}`);
  } finally {
    await s.browser.close();
  }
}

// ── K5, K6 — the playlist-detail menus ─────────────────────────────────────
// Neither of these lets a write reach the server: the remove request is
// answered inside the browser, so the fixture is only read.
async function runPlaylistMenus(viewport, rep) {
  const sent = [];
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/library/playlist/*/remove-by-name', (route) => {
      sent.push({ kind: 'remove-by-name', body: route.request().postData() });
      return json(route, { status: 'ok' });
    });
    await context.route('**/api/library/playlist/*/tracks', (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      sent.push({ kind: 'indices', body: route.request().postData() });
      return json(route, { status: 'ok' });
    });
  });
  const { page } = s;
  try {
    if (!(await openFixture(page))) {
      for (const id of ['K5', 'K6']) if (want(id)) rep.skip(`${id}/${viewport}`, 'menu nad knihovním playlistem', `fixtura ${FIXTURE} nenalezena`);
      return;
    }

    if (want('K5')) {
      const boxes = page.locator('#libraryTracks .lib-bulk-cb');
      // Bulk select is deliberately desktop-only on a playlist row (search.css
      // hides it under 640 px), so on a phone there is no bulk menu to name.
      const reachable = (await boxes.count()) >= 2 && (await boxes.first().isVisible());
      if (!reachable) {
        rep.skip(`K5/${viewport}`, 'hromadný výběr',
          (await boxes.count()) < 2 ? 'playlist má míň než dvě skladby' : 'zaškrtávátka jsou pod 640 px skrytá (search.css:336)');
      } else {
        await boxes.nth(0).check();
        await boxes.nth(1).check();
        // Right-click, not the kebab: a plain click anywhere on a row clears the
        // selection (the capture handler in library.js), so the kebab can only
        // ever show the single-track menu.
        await page.locator('#libraryTracks .card').nth(1).click({ button: 'right' });
        await page.waitForTimeout(600);
        const labels = await menuLabels(page);
        rep.check(`K5/${viewport}`, 'the bulk menu names the queue as the queue',
          labels.includes('Add to queue') && labels.includes('Add to playlist…') && !labels.includes('Add to other playlist…'),
          labels.join(' | '));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        await boxes.nth(0).uncheck();
        await boxes.nth(1).uncheck();
        await page.waitForTimeout(300);
      }
    }

    // The name of the SECOND row — every removal below must name it, and only
    // it. "Index 1" on its own is not enough: a bare index is what R5.1 threw
    // out, and an index that has drifted off its row deletes a stranger.
    const secondName = await page.evaluate(() => {
      const c = document.querySelectorAll('#libraryTracks .card')[1];
      try { return (JSON.parse(c.dataset.item).name || '').trim(); } catch { return ''; }
    });
    // Did exactly ONE remove-by-name leave, naming the second row, carrying
    // index 1, and did nothing go down the bare-index path?
    const soleRemove = (list) => {
      if (list.length !== 1 || list[0].kind !== 'remove-by-name') return false;
      let b = null;
      try { b = JSON.parse(list[0].body || 'null'); } catch { return false; }
      return !!b && b.index === 1 && typeof b.name === 'string' && b.name.trim() === secondName;
    };
    const shown = (list) => (list.length ? list.map((r) => `${r.kind} ${r.body}`).join(' ;; ') : 'žádné');

    if (want('K6')) {
      sent.length = 0;
      await page.locator('#libraryTracks .card').nth(1).locator('.kebab-lib').click();
      await page.waitForTimeout(600);
      const labels = await menuLabels(page);
      const label = labels.find((l) => l.startsWith('Remove from "'));
      const clicked = label ? await clickMenu(page, label) : false;
      await page.waitForTimeout(1200);
      const confirmed = await page.evaluate(() => !!document.querySelector('.confirm-ok'));
      if (confirmed) {
        await page.click('.confirm-ok');
        await page.waitForTimeout(1500);
      }
      rep.check(`K6/${viewport}`, 'the kebab asks first, then removes the row it was opened on by name AND index',
        clicked && confirmed && soleRemove(sent),
        `položka="${label || '—'}", druhý řádek="${secondName}", potvrzení=${confirmed}, poslané volání=${shown(sent)}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // The ✕ is deliberately desktop-only on a playlist row (search.css:338, the
    // same rule that hides the bulk checkboxes) — on a phone the ⋮ menu is the
    // only way to remove a track, and K6 above already measures that.
    const cross = page.locator('#libraryTracks .card').nth(1).locator('.lib-track-remove');
    const crossUsable = (await cross.count()) > 0 && (await cross.first().isVisible());

    // K6b — the ✕ on the row itself. K6 only ever exercised the kebab, so a
    // cross wired to index 0 (or to every row at once) stayed green.
    if (want('K6')) {
      if (!crossUsable) {
        rep.skip(`K6b/${viewport}`, 'křížek u řádku', 'křížek je pod 640 px skrytý (search.css:338)');
      } else {
      sent.length = 0;
      await cross.first().click();
      await page.waitForTimeout(1000);
      const confirmed = await page.evaluate(() => !!document.querySelector('.confirm-ok'));
      if (confirmed) {
        await page.click('.confirm-ok');
        await page.waitForTimeout(1500);
      }
      rep.check(`K6b/${viewport}`, 'the ✕ on a row removes that row, once, and nothing else',
        confirmed && soleRemove(sent),
        `druhý řádek="${secondName}", potvrzení=${confirmed}, poslaných volání ${sent.length}: ${shown(sent)}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      }
    }

    // K6c — Cancel has to mean cancel. Dropping the `if (!ok) return;` guard
    // left every other removal check green, because they all press OK.
    if (want('K6')) {
      sent.length = 0;
      // Whichever way in this resolution offers — the ✕ on desktop, the ⋮ menu
      // on a phone. Cancel has to mean the same thing from both.
      if (crossUsable) {
        await page.locator('#libraryTracks .card').nth(1).locator('.lib-track-remove').first().click();
      } else {
        await page.locator('#libraryTracks .card').nth(1).locator('.kebab-lib').click();
        await page.waitForTimeout(600);
        const l = (await menuLabels(page)).find((x) => x.startsWith('Remove from "'));
        if (l) await clickMenu(page, l);
      }
      await page.waitForTimeout(1000);
      const asked = await page.evaluate(() => !!document.querySelector('.confirm-cancel'));
      if (asked) {
        await page.click('.confirm-cancel');
        await page.waitForTimeout(2000);
      }
      rep.check(`K6c/${viewport}`, 'cancelling the confirmation sends nothing at all',
        asked && sent.length === 0,
        `potvrzení nabídnuto=${asked}, po Cancel poslaných volání ${sent.length}: ${shown(sent)}`);
      await page.keyboard.press('Escape');
    }
  } finally {
    await s.browser.close();
  }
}

// ── K12, K17 — the download dialog ─────────────────────────────────────────
async function runDownloadModal(viewport, rep) {
  const dialogs = [];
  const s = await prepare(viewport, async ({ context }) => {
    // Belt and braces: the delete this check walks up to must never leave the
    // browser even if a confirmation is accepted by accident.
    await context.route('**/api/library/track/delete', (route) => json(route, { status: 'ok' }));
  });
  const { page } = s;
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  try {
    await openLibrary(page);
    // Clicking a library row PLAYS it, so the dialog is opened the way the app
    // itself opens it — through downloads.js's own exported openModal, with a
    // made-up track. Nothing of the measured code is replaced.
    await page.evaluate(async ([stamp, item]) => {
      const m = await import(`/static/js/downloads.js?v=${stamp}`);
      m.openModal(item);
    }, [STAMP, {
      name: 'Audit Track', artist: 'Audit Artist', album: 'Audit Album',
      type: 'track', inLibrary: true, id: 'audit-track',
      url: 'https://open.spotify.com/track/0000000000000000000000',
    }]);
    await page.waitForSelector('#downloadModal.open', { timeout: 10000 });
    await page.waitForTimeout(1200);

    if (want('K12')) {
      const m = await page.evaluate(() => {
        const row = document.querySelector('#downloadModal .modal-quick-row');
        if (!row) return null;
        const vis = (el) => !!el && el.offsetParent !== null;
        return {
          heart: vis(row.querySelector('[data-like-key]')),
          playlist: [...row.querySelectorAll('button')].some((b) => vis(b) && /playlist/i.test(b.textContent)),
          buttons: [...row.querySelectorAll('button')].filter(vis).map((b) => b.textContent.trim() || b.title),
        };
      });
      rep.check(`K12/${viewport}`, 'the download dialog can like and add to a playlist, like the kebab can',
        !!m && m.heart && m.playlist,
        m ? `srdíčko=${m.heart}, playlist=${m.playlist} (${m.buttons.join(' | ')})` : 'rychlá řada chybí');
    }

    if (want('K17')) {
      dialogs.length = 0;
      const del = page.locator('#modalDeleteTrack');
      if (!(await del.isVisible())) {
        rep.skip(`K17/${viewport}`, 'nativní confirm ve stahovacím dialogu', '#modalDeleteTrack není vidět');
      } else {
        await del.click();
        await page.waitForTimeout(3000);
        const own = await page.evaluate(() => !!document.querySelector('.confirm-ok'));
        rep.check(`K17/${viewport}`, 'deleting from the library asks through the app’s own modal',
          own && dialogs.length === 0,
          `vlastní modál=${own}, nativních dialogů ${dialogs.length}${dialogs.length ? ': ' + dialogs[0] : ''}`);
        if (own) await page.click('.confirm-cancel');
      }
    }
  } finally {
    await s.browser.close();
  }
}

// ── K17b — the SAME question, asked from podcasts.js ───────────────────────
// K17 only ever walked up to the delete inside the download dialog, so putting
// a native confirm() back into podcasts.js (eight call sites) stayed green.
// This account has no downloaded show, so the list is supplied; every DELETE is
// answered inside the browser, so nothing on the server is touched.
const POD_SHOW = {
  shows: [{
    name: 'Audit Show', count: 2, total_size: 2048,
    episodes: [
      { name: 'Audit episode one', filename: 'audit-one.mp3', size: 1024, modified: 1760000000 },
      { name: 'Audit episode two', filename: 'audit-two.mp3', size: 1024, modified: 1760000100 },
    ],
  }],
  total_size: 2048,
};

async function runPodcastConfirm(viewport, rep) {
  const dialogs = [];
  const deletes = [];
  const s = await prepare(viewport, async ({ context }) => {
    await context.route('**/api/podcasts', (route) =>
      route.request().method() === 'GET' ? json(route, POD_SHOW) : route.continue());
    // Everything under /api/podcasts/ is answered here: the subscription list
    // (so the stubbed page renders) and the DELETE this check walks up to.
    await context.route('**/api/podcasts/**', (route) => {
      const r = route.request();
      if (r.url().endsWith('/api/podcasts/subs')) return json(route, { subs: [] });
      if (r.method() === 'DELETE') { deletes.push(r.url()); return json(route, { status: 'ok' }); }
      return route.continue();
    });
  });
  const { page } = s;
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  try {
    await goPage(page, 'library');
    await page.click('#libraryTabs .sp-tab[data-lib-tab="podcasts"]');
    await page.waitForTimeout(2500);
    const card = page.locator('#podcastsList .podcast-show-card').first();
    if (!(await card.count())) {
      rep.skip(`K17b/${viewport}`, 'nativní confirm v podcasts.js', 'podstrčený seznam pořadů se nevykreslil');
      return;
    }
    await card.click();
    await page.waitForSelector('#podcastEpisodesList .podcast-ep-row', { timeout: 15000 });
    await page.waitForTimeout(600);
    dialogs.length = 0;
    deletes.length = 0;
    await page.locator('#podcastEpisodesList .podcast-ep-row').first().locator('.btn-delete-ep').click();
    await page.waitForTimeout(2500);
    const own = await page.evaluate(() => !!document.querySelector('.confirm-ok'));
    rep.check(`K17b/${viewport}`, 'deleting a podcast episode asks through the app’s own modal too',
      own && dialogs.length === 0,
      `vlastní modál=${own}, nativních dialogů ${dialogs.length}${dialogs.length ? ': ' + dialogs[0] : ''}, odeslaných DELETE ${deletes.length}`);
    if (own) await page.click('.confirm-cancel');
  } finally {
    await s.browser.close();
  }
}

// ── K13 — the open panel marks its nav entry ───────────────────────────────
async function runPanelNav(viewport, rep) {
  const s = await prepare(viewport);
  const { page } = s;
  try {
    await goPage(page, 'library');
    await openPanel(page);
    const m = await page.evaluate(() => {
      const vis = (el) => !!el && el.offsetParent !== null;
      const t = document.querySelector('#downloadsToggle');
      const b = document.querySelector('#bnavDownloads');
      const shown = vis(t) ? t : (vis(b) ? b : null);
      return {
        open: !!document.querySelector('#downloadsPanel.open'),
        which: shown ? shown.id : '',
        active: !!shown && shown.classList.contains('active'),
        others: [...document.querySelectorAll('.nav-btn.active, .bnav-btn.active')].map((e) => e.dataset.page || e.id),
      };
    });
    rep.check(`K13/${viewport}`, 'the open Downloads panel highlights its own nav entry',
      m.open && m.active, `panel=${m.open}, ${m.which}.active=${m.active}, ostatní aktivní: ${m.others.join(',') || '—'}`);
    await page.keyboard.press('Escape');
  } finally {
    await s.browser.close();
  }
}

const main = async () => {
  STAMP = await readStamp();
  const rep = makeReport(`knihovna (${PATCH ? `SERVÍROVANÝ STROM ${TREE}` : 'PROTI PRODUKCI'}, cache-bust ${STAMP})`);
  // K10 is held back: the liked-songs payload carries no duration_ms at all, so
  // there is nothing for the renderer to print. Fixing it means storing the
  // field at like time, which is outside this set of files.
  rep.skip('K10', 'Liked Songs show track length', 'odloženo — chybí duration_ms v uložených lajcích');
  for (const vp of (process.env.MS_VIEWPORTS || 'phone,tablet,desktop').split(',')) {
    await runLibrary(vp, rep);
    if (want('K2')) await runLikedCount(vp, rep);
    if (want('K3') || want('K4') || want('K15')) await runJobs(vp, rep);
    if (want('K16')) await runJobsError(vp, rep);
    if (want('K11')) await runEmptyStates(vp, rep);
    if (want('K7')) await runFavoriteClick(vp, rep);
    if (want('K5') || want('K6')) await runPlaylistMenus(vp, rep);
    if (want('K12') || want('K17')) await runDownloadModal(vp, rep);
    if (want('K17')) await runPodcastConfirm(vp, rep);
    if (want('K13')) await runPanelNav(vp, rep);
  }
  const ok = rep.done();
  process.exit(ok ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(2); });
