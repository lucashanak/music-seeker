// nav.mjs — checks for the global-navigation findings of the October UX audit
// (notes/impl/audit-2026-10/nav.md, points N1-N14).
//
// Oracle: production runs the old code, so every check here has to FAIL against
// https://musicseeker.hanaktech.org as it stands. Running it again with
// MS_PATCH=1 hands the same live page the REAL files out of this worktree —
// index.html included — through the shared harness's open({ worktree }), and
// the same checks have to pass. A red result on its own proves nothing: a typo
// in a selector is red too.
//
// The green half deliberately installs nothing of its own. A check that goes
// green because it dropped a stand-in listener into the page is measuring the
// stand-in, not the fix; the only thing swapped here is which copy of the
// source the browser downloads.
//
//   node tests/e2e/audit/nav.mjs              → against production, expect FAIL
//   MS_PATCH=1 node tests/e2e/audit/nav.mjs   → worktree served, expect PASS
//   MS_TREE=/some/tree node tests/e2e/audit/nav.mjs  → serve that tree instead
//
// Production is read-only here: nothing is downloaded, deleted, created or
// configured. A track is played (that is reading), the party overlay is opened
// without starting the microphone, and the dialogs are driven through their own
// exported functions with made-up arguments, so no playlist is ever touched.

import { open, search, goPage, makeReport, URL as PROD } from './helpers.mjs';

const ROOT = process.env.MS_TREE || '/home/lucas/music-seeker';
// Which tree the page is served from. Empty = production's own deployed files.
const TREE = process.env.MS_TREE || (process.env.MS_PATCH === '1' ? ROOT : null);
const PATCH = !!TREE;
const DEVICE = 'autor2-4-c3';
const ONLY = process.env.MS_ONLY ? process.env.MS_ONLY.split(',') : null;

const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';

let STAMP = '';

// The dynamic imports below have to spell the module URL the way the page
// already loaded it, or the browser fetches a second copy with its own `store`.
// That is the same stamp entrypoint.sh writes and serveWorktree replays.
async function readStamp() {
  const html = await (await fetch(PROD + '/')).text();
  const m = html.match(/variables\.css\?v=(\d+)/);
  if (!m) throw new Error('nepodařilo se přečíst cache-bust z produkce');
  return m[1];
}

// open() navigates, so the worktree routes have to be in place before it: the
// harness installs them itself when it is handed a tree. Signing in is separate
// here because N8 and N9 are measured on the login screen.
async function prepare(viewport) {
  const s = await open({ viewport, device: DEVICE, login: false, worktree: TREE });
  await s.page.waitForSelector('#loginUser', { timeout: 20000 });
  await s.page.waitForTimeout(3000);
  return s;
}

async function signIn(page) {
  await page.fill('#loginUser', 'claude_test');
  await page.fill('#loginPass', 'TestPass2026!');
  await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => {
    const l = document.querySelector('#loginScreen');
    return l && getComputedStyle(l).display === 'none';
  }, { timeout: 25000 });
  await page.waitForTimeout(1500);
}

const LAYERS = ['#playlistDetail', '#showDetail', '#podcastEpisodes', '#tagDetailView',
                '#artistDetail', '#albumDetail', '#libraryDetail', '#likedSongsDetail'];

// offsetParent is null for every position:fixed element, visible or not, so the
// bottom nav and the player bar need their own measure.
const VISIBLE_RECT = `(el) => {
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.width > 0 ? r : null;
}`;

const state = (page) => page.evaluate(() => JSON.stringify(history.state));
// Opens a dialog through the app's own exported function and parks its Promise
// on the window, so the check can see whether it ever settles.
async function openDialog(page, call) {
  await page.evaluate(async ([s, src]) => {
    const u = await import(`/static/js/utils.js?v=${s}`);
    window.__nav = { settled: false, value: undefined };
    // eslint-disable-next-line no-new-func
    const fn = new Function('u', `return ${src};`);
    fn(u).then(v => { window.__nav.settled = true; window.__nav.value = v; });
  }, [STAMP, call]);
  await page.waitForTimeout(400);
}

const overlays = (page) => page.evaluate(() => document.querySelectorAll('.modal-overlay:not(#downloadModal)').length);

// ── The checks ──────────────────────────────────────────────────────────────

async function run(viewport, rep) {
  const want = (id) => !ONLY || ONLY.includes(id);

  // ── N9 / N8: the login screen, before anything is signed in ──
  let s = await prepare(viewport);
  let page = s.page;
  try {
    if (want('N8')) {
      const lang = await page.evaluate(() => document.documentElement.lang);
      rep.check(`N8/${viewport}`, 'document declares English', lang === 'en', `lang=${lang}`);
    }
    if (want('N9')) {
      const r = await page.evaluate(() => ({
        focused: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '(none)',
        fine: window.matchMedia('(pointer: fine)').matches,
        instance: (document.querySelector('#loginInstance') || {}).textContent || '',
      }));
      // autoFocus deliberately does nothing without a fine pointer: raising the
      // keyboard on load is the behaviour it exists to prevent. That is the
      // requirement on a phone, not an exception to it.
      const ok = r.fine ? r.focused === 'loginUser' : r.focused !== 'loginUser';
      rep.check(`N9a/${viewport}`, 'login field focused only with a fine pointer', ok, `pointer-fine=${r.fine} activeElement=${r.focused}`);
      rep.check(`N9b/${viewport}`, 'login screen names the instance', r.instance.includes('musicseeker'), `#loginInstance="${r.instance}"`);
    }
    await signIn(page);

    if (want('N13')) {
      const op = await page.evaluate(() => {
        const f = document.querySelector('#feedbackFab');
        return f ? getComputedStyle(f).opacity : '(missing)';
      });
      rep.check(`N13/${viewport}`, 'feedback button is not styled as disabled', parseFloat(op) >= 0.8, `opacity=${op}`);
    }

    // ── N6: a destructive confirm must not be one Enter away ──
    if (want('N6')) {
      await openDialog(page, `u.showConfirmModal('Delete playlist', 'oracle check', {})`);
      const focused = await page.evaluate(() => document.activeElement ? document.activeElement.className : '(none)');
      rep.check(`N6a/${viewport}`, 'danger confirm rests on Cancel', /confirm-cancel/.test(focused), `activeElement=.${focused}`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const v = await page.evaluate(() => window.__nav);
      rep.check(`N6b/${viewport}`, 'Enter does not confirm a destructive dialog', v.settled && v.value === false, `settled=${v.settled} value=${v.value}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // Regression guard: the harmless confirms keep Enter as OK.
      await openDialog(page, `u.showConfirmModal('Keep going?', '', { danger: false, okLabel: 'OK' })`);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const v2 = await page.evaluate(() => window.__nav);
      rep.check(`N6c/${viewport}`, 'Enter still confirms a non-destructive dialog', v2.settled && v2.value === true, `settled=${v2.settled} value=${v2.value}`);
    }

    // ── N2: dialogs are a history layer and settle their own Promise ──
    if (want('N2')) {
      await goPage(page, 'library');
      const before = await state(page);
      await openDialog(page, `u.showConfirmModal('Delete playlist', 'oracle check', {})`);
      const inside = await state(page);
      await page.goBack();
      await page.waitForTimeout(700);
      const after = await state(page);
      const gone = (await overlays(page)) === 0;
      const v = await page.evaluate(() => window.__nav);
      rep.check(`N2a/${viewport}`, 'a dialog is its own history entry', JSON.parse(inside || '{}').layer === 'dialog', `state=${inside}`);
      rep.check(`N2b/${viewport}`, 'Back closes the dialog and leaves the page alone', gone && after === before, `before=${before} after=${after} overlays=${gone ? 0 : 'some'}`);
      rep.check(`N2c/${viewport}`, 'the awaited Promise settles', v.settled === true, `settled=${v.settled} value=${v.value}`);

      // Escape on the picker — it was the one dialog with no key handler at all.
      await openDialog(page, `u.showPlaylistPicker([], { multi: true })`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
      const esc = await page.evaluate(() => ({ n: document.querySelectorAll('.modal-overlay:not(#downloadModal)').length, settled: window.__nav.settled }));
      rep.check(`N2e/${viewport}`, 'Escape closes the playlist picker and settles it', esc.n === 0 && esc.settled === true, `overlays=${esc.n} settled=${esc.settled}`);
      await page.evaluate(() => document.querySelectorAll('.modal-overlay:not(#downloadModal)').forEach(o => o.remove()));

      // Nesting: the picker opens the name modal; Back must close the inner one.
      await openDialog(page, `u.showPlaylistPicker([], { multi: true })`);
      await page.click('.pl-pick-new');
      await page.waitForTimeout(700);
      const two = await overlays(page);
      await page.goBack();
      await page.waitForTimeout(800);
      const left = await page.evaluate(() => ({
        n: document.querySelectorAll('.modal-overlay:not(#downloadModal)').length,
        picker: !!document.querySelector('.pl-pick-new'),
        input: !!document.querySelector('.input-modal-field'),
      }));
      rep.check(`N2d/${viewport}`, 'Back closes the innermost dialog, not the one under it',
        two === 2 && left.n === 1 && left.picker && !left.input, `open=${two} after={n:${left.n},picker:${left.picker},input:${left.input}}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.evaluate(() => document.querySelectorAll('.modal-overlay:not(#downloadModal)').forEach(o => o.remove()));

      // No dialog opens twice.
      await openDialog(page, `u.showConfirmModal('Delete playlist', 'oracle check', {})`);
      await openDialog(page, `u.showConfirmModal('Delete playlist', 'oracle check', {})`);
      const dup = await overlays(page);
      rep.check(`N2f/${viewport}`, 'a second copy of the same dialog does not open', dup === 1, `overlays=${dup}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.evaluate(() => document.querySelectorAll('.modal-overlay:not(#downloadModal)').forEach(o => o.remove()));
    }

    // ── N1a: Discover → tag → Library → Back ──
    if (want('N1')) {
      await goPage(page, 'discover');
      await page.waitForSelector('.tag-chip', { timeout: 20000 });
      await page.click('.tag-chip');
      await page.waitForTimeout(2500);
      await goPage(page, 'library');
      await page.goBack();
      await page.waitForTimeout(1500);
      const r1 = await page.evaluate(() => ({
        discover: document.querySelector('#pageDiscover').offsetParent !== null,
        library: document.querySelector('#pageLibrary') ? document.querySelector('#pageLibrary').offsetParent !== null : false,
        state: JSON.stringify(history.state),
      }));
      rep.check(`N1a/${viewport}`, 'Back from Library lands on Discover, not nowhere',
        r1.discover && !r1.library && JSON.parse(r1.state || '{}').page === 'discover',
        `onDiscover=${r1.discover} onLibrary=${r1.library} state=${r1.state}`);

      // Open an artist detail; it is the layer the rest of N1 is measured on.
      const openArtist = async () => {
        await goPage(page, 'search');
        await search(page, 'daft punk', 'artist');
        await page.waitForSelector('#searchResults .card', { timeout: 20000 });
        await page.evaluate(() => document.querySelector('#searchResults .card').click());
        await page.waitForTimeout(3000);
        return page.evaluate(() => document.querySelector('#artistDetail').offsetParent !== null);
      };

      // ── N1c: leaving the page and coming back must not bring the layer with it ──
      if (!(await openArtist())) {
        rep.skip(`N1c/${viewport}`, 'a layer does not survive leaving its page', 'detail interpreta se neotevřel');
      } else {
        await goPage(page, 'library');
        await goPage(page, 'search');
        const stray = await page.evaluate((ids) => ids
          .map(id => { const el = document.querySelector(id); return el ? { id, display: el.style.display || '(unset)', onScreen: el.offsetParent !== null } : null; })
          .filter(x => x && (x.onScreen || x.display !== 'none'))
          .map(x => `${x.id}[display=${x.display},onScreen=${x.onScreen}]`), LAYERS);
        rep.check(`N1c/${viewport}`, 'a layer does not survive leaving its page', stray.length === 0, `stale=${stray.join(' ') || 'none'}`);
      }

      // ── N1b: Search → artist → Settings → Back ──
      if (!(await openArtist())) {
        rep.skip(`N1b/${viewport}`, 'Back from Settings lands on Search', 'detail interpreta se neotevřel');
      } else {
        await goPage(page, 'settings');
        await page.goBack();
        await page.waitForTimeout(1800);
        const r2 = await page.evaluate(() => ({
          search: document.querySelector('#pageSearch').offsetParent !== null,
          settings: document.querySelector('#pageSettings').offsetParent !== null,
          results: document.querySelector('#searchResults').offsetParent !== null,
          state: JSON.stringify(history.state),
        }));
        rep.check(`N1b/${viewport}`, 'Back from Settings lands on Search with matching history',
          r2.search && !r2.settings && r2.results && JSON.parse(r2.state || '{}').page === 'search',
          `onSearch=${r2.search} onSettings=${r2.settings} results=${r2.results} state=${r2.state}`);
      }
    }

    // ── N2g: Back belongs to the dialog on top, not the page behind it ──
    // The overlays that register nothing in store.dialogStack (the three in
    // settings.js, playlist import) are painted at z-index 200, over every
    // in-page layer. With a detail open behind one, the first round's order
    // closed the DETAIL and switched the page, leaving the dialog hanging over
    // a screen it no longer belonged to. Driven through the app's own exported
    // opener, with the field left empty, so nothing is ever imported.
    if (want('N2g')) {
      await goPage(page, 'search');
      await search(page, 'daft punk', 'artist');
      await page.waitForSelector('#searchResults .card', { timeout: 20000 });
      await page.evaluate(() => document.querySelector('#searchResults .card').click());
      await page.waitForTimeout(3000);
      if (!(await page.evaluate(() => document.querySelector('#artistDetail').offsetParent !== null))) {
        rep.skip(`N2g/${viewport}`, 'Back closes the dialog on top, not the page behind it', 'detail interpreta se neotevřel');
      } else {
        await page.evaluate(async (st) => {
          const m = await import(`/static/js/playlistimport.js?v=${st}`);
          m.openImportModal();
        }, STAMP);
        await page.waitForTimeout(900);
        const up = await page.evaluate(() => ({
          dialog: !!document.querySelector('.import-modal-field'),
          detail: document.querySelector('#artistDetail').offsetParent !== null,
        }));
        await page.goBack();
        await page.waitForTimeout(1200);
        const after = await page.evaluate(() => ({
          dialog: !!document.querySelector('.import-modal-field'),
          detail: document.querySelector('#artistDetail').offsetParent !== null,
          search: document.querySelector('#pageSearch').offsetParent !== null,
        }));
        rep.check(`N2g/${viewport}`, 'Back closes the dialog on top, not the page behind it',
          up.dialog && up.detail && !after.dialog && after.detail && after.search,
          `otevřeno={dialog:${up.dialog},detail:${up.detail}} poZpět={dialog:${after.dialog},detail:${after.detail},naSearch:${after.search}}`);
        await page.evaluate(() => document.querySelectorAll('.modal-overlay:not(#downloadModal)').forEach(o => o.remove()));
        await page.waitForTimeout(300);
      }
    }

    // ── N4 / N11: the party overlay ──
    if (want('N4') || want('N11')) {
      await goPage(page, 'search');
      await page.click('#partyBtn');
      await page.waitForTimeout(800);
      const openState = await page.evaluate(() => ({
        shown: getComputedStyle(document.querySelector('#partyOverlay')).display !== 'none',
        state: JSON.stringify(history.state),
        saveBg: getComputedStyle(document.querySelector('#partySave')).backgroundColor,
        disabled: document.querySelector('#partySave').disabled,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      }));
      if (want('N11')) {
        // The accent is written as a hex in variables.css; compare it by letting
        // the browser resolve both to the same notation.
        const accentRgb = await page.evaluate((c) => {
          const d = document.createElement('div'); d.style.color = c; document.body.appendChild(d);
          const v = getComputedStyle(d).color; d.remove(); return v;
        }, openState.accent);
        rep.check(`N11/${viewport}`, 'a disabled Save button does not look enabled',
          openState.disabled && openState.saveBg !== accentRgb, `disabled=${openState.disabled} background=${openState.saveBg} accent=${accentRgb}`);
      }
      if (want('N4')) {
        await page.goBack();
        await page.waitForTimeout(900);
        const closed = await page.evaluate(() => ({
          shown: getComputedStyle(document.querySelector('#partyOverlay')).display !== 'none',
          search: document.querySelector('#pageSearch').offsetParent !== null,
          state: JSON.stringify(history.state),
        }));
        rep.check(`N4a/${viewport}`, 'the party overlay is its own history entry', JSON.parse(openState.state || '{}').layer === 'party', `state=${openState.state}`);
        rep.check(`N4b/${viewport}`, 'Back closes party and stays on Search',
          !closed.shown && closed.search && JSON.parse(closed.state || '{}').page === 'search',
          `overlayShown=${closed.shown} onSearch=${closed.search} state=${closed.state}`);
      }
      await page.evaluate(() => { const o = document.querySelector('#partyOverlay'); if (o) o.style.display = 'none'; });
    }

    // ── N10: microphone errors in the user's language, not the browser's ──
    if (want('N10')) {
      await s.context.clearPermissions();
      await goPage(page, 'search');
      await page.click('#micBtn');
      let txt = '';
      try {
        await page.waitForFunction(() => (document.querySelector('#micStatus').textContent || '').startsWith('Mic error:'), { timeout: 35000 });
        txt = await page.evaluate(() => document.querySelector('#micStatus').textContent);
      } catch { txt = await page.evaluate(() => document.querySelector('#micStatus').textContent); }
      // Which of the two the browser raises depends on the machine — a headless
      // container has no capture device at all (NotFoundError), a desktop with
      // one refuses permission (NotAllowedError). Either way the user has to be
      // told what to do, not handed the DOMException's own wording.
      const SPOKEN = [
        "Mic error: Microphone blocked — allow it in your browser's site settings",
        'Mic error: No microphone found',
      ];
      if (!txt.startsWith('Mic error:')) {
        rep.skip(`N10/${viewport}`, 'a refused microphone explains itself', `prohlížeč mikrofon neodmítl (#micStatus="${txt}")`);
      } else {
        rep.check(`N10/${viewport}`, 'a refused microphone explains itself', SPOKEN.includes(txt), `#micStatus="${txt}"`);
      }
      await page.waitForTimeout(500);
    }

    // ── N7: a Discover tag page is not a wall of Last.fm placeholders ──
    if (want('N7')) {
      await goPage(page, 'discover');
      await page.waitForSelector('.tag-chip', { timeout: 20000 });
      const hasZouk = await page.evaluate(() => !!document.querySelector('.tag-chip[data-tag="zouk"]'));
      await page.click(hasZouk ? '.tag-chip[data-tag="zouk"]' : '.tag-chip');
      await page.waitForTimeout(4000);
      const imgs = await page.evaluate((ph) => {
        const all = [...document.querySelectorAll('#tagResults img')];
        return { total: all.length, placeholders: all.filter(i => (i.getAttribute('src') || '').includes(ph)).length };
      }, LASTFM_PLACEHOLDER);
      if (!imgs.total) {
        rep.skip(`N7/${viewport}`, 'no card carries the Last.fm placeholder', 'stránka tagu nevykreslila žádný obrázek');
      } else if (PATCH) {
        // N7 is the one point of this celek that lives in the backend
        // (app/services/lastfm.py). Serving the worktree replaces static files;
        // the server keeps answering with its deployed code, so a green here
        // could only be bought by rewriting its answer in flight — a stand-in,
        // which is exactly what this round stopped doing. MEZ: the browser half
        // is red until the fix is deployed; the oracle for the rule itself is
        // tests/test_lastfm_image.py (four tests, mutations recorded).
        rep.skip(`N7/${viewport}`, 'no card carries the Last.fm placeholder',
          `MEZ: oprava je v app/services/lastfm.py, servírovaný strom je jen static/ — živě ${imgs.placeholders}/${imgs.total} karet, oracle je tests/test_lastfm_image.py`);
      } else {
        rep.check(`N7/${viewport}`, 'no card carries the Last.fm placeholder', imgs.placeholders === 0, `${imgs.placeholders}/${imgs.total} karet`);
      }
    }

    // ── N5: the toast must not cover the navigation it reports about ──
    if (want('N5')) {
      await goPage(page, 'search');
      await search(page, 'daft punk', 'track');
      try {
        await page.waitForSelector('#searchResults .card-play-btn', { timeout: 20000 });
        await page.click('#searchResults .card-play-btn');
        await page.waitForFunction(() => document.body.classList.contains('player-active'), { timeout: 25000 });
      } catch {}
      const active = await page.evaluate(() => document.body.classList.contains('player-active'));
      if (!active) {
        rep.skip(`N5/${viewport}`, 'toast clears the bottom bars', 'přehrávání se nerozjelo, lišta přehrávače není aktivní');
      } else {
        await page.evaluate(async (st) => {
          const u = await import(`/static/js/utils.js?v=${st}`);
          u.showToast('oracle check', false, { duration: 20000 });
        }, STAMP);
        await page.waitForTimeout(600);
        const geo = await page.evaluate((src) => {
          // eslint-disable-next-line no-new-func
          const vis = new Function('return ' + src)();
          const t = document.querySelector('#toastMsg').getBoundingClientRect();
          const n = vis(document.querySelector('.bottom-nav'));
          const b = vis(document.querySelector('#playerBar'));
          return { toastBottom: Math.round(t.bottom), navTop: n ? Math.round(n.top) : null, barTop: b ? Math.round(b.top) : null };
        }, VISIBLE_RECT);
        const tops = [geo.navTop, geo.barTop].filter(v => v !== null);
        if (!tops.length) {
          rep.skip(`N5/${viewport}`, 'toast clears the bottom bars', 'ani spodní navigace, ani lišta přehrávače nejsou na obrazovce');
        } else {
          const gap = Math.min(...tops) - geo.toastBottom;
          rep.check(`N5/${viewport}`, 'toast clears the bottom bars', gap >= 8,
            `toastBottom=${geo.toastBottom} navTop=${geo.navTop} playerBarTop=${geo.barTop} gap=${gap}px`);
        }
      }
    }

    // ── N3: signing out has to be reachable, and has to be clean ──
    if (want('N3')) {
      await page.evaluate(() => {
        localStorage.setItem('ms_recent_searches', '["oracle"]');
        localStorage.setItem('ms_party_session', '[]');
      });
      await goPage(page, 'settings');
      await page.waitForTimeout(1200);
      const found = await page.evaluate(() => {
        const vis = (el) => !!el && el.offsetParent !== null;
        const btns = [...document.querySelectorAll('button')].filter(b => /^\s*Log out\s*$/.test(b.textContent) && vis(b));
        const name = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent.trim() === 'claude_test' && vis(e));
        return {
          buttons: btns.length,
          named: name.length,
          nameWidth: name.length ? Math.round(name[0].getBoundingClientRect().width) : 0,
          clearColor: (() => { const c = document.querySelector('#clearCacheBtn'); return c ? getComputedStyle(c).color : ''; })(),
          red: (() => {
            const d = document.createElement('div');
            d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
            document.body.appendChild(d);
            const v = getComputedStyle(d).color; d.remove(); return v;
          })(),
        };
      });
      rep.check(`N3a/${viewport}`, 'a plain Log out is on screen', found.buttons >= 1, `tlačítek "Log out"=${found.buttons}`);
      rep.check(`N3b/${viewport}`, 'the signed-in user is readable', found.named >= 1 && found.nameWidth > 0, `prvků se jménem=${found.named} šířka=${found.nameWidth}px`);
      rep.check(`N3c/${viewport}`, 'the destructive reset looks different from it',
        found.clearColor === found.red, `#clearCacheBtn color=${found.clearColor} --red=${found.red}`);

      if (found.buttons >= 1) {
        const playing = await page.evaluate(() => { const a = document.querySelector('audio'); return a ? a.currentTime : -1; });
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find(x => /^\s*Log out\s*$/.test(x.textContent) && x.offsetParent !== null);
          b.click();
        });
        await page.waitForTimeout(6000);
        const after = await page.evaluate(() => ({
          login: (() => { const l = document.querySelector('#loginScreen'); return !!l && getComputedStyle(l).display !== 'none'; })(),
          token: localStorage.getItem('ms_token'),
          recent: localStorage.getItem('ms_recent_searches'),
          party: localStorage.getItem('ms_party_session'),
          device: localStorage.getItem('ms_device_id'),
          audio: (() => { const a = document.querySelector('audio'); return a ? (a.paused ? 'paused' : a.currentTime) : 'none'; })(),
        }));
        rep.check(`N3d/${viewport}`, 'Log out reaches the login screen', after.login, `loginScreen=${after.login}`);
        rep.check(`N3e/${viewport}`, 'the previous user leaves no data behind',
          !after.token && !after.recent && !after.party, `ms_token=${after.token} ms_recent_searches=${after.recent} ms_party_session=${after.party}`);
        rep.check(`N3f/${viewport}`, 'the device keeps its own identity', after.device === `e2e-${DEVICE}`, `ms_device_id=${after.device}`);
        rep.check(`N3g/${viewport}`, 'the music stops',
          after.audio === 'none' || after.audio === 'paused', `audio=${after.audio} (before logout currentTime=${playing})`);
      }
    }
  } finally {
    await s.browser.close();
  }
}

// The top-bar button has to go the same way as the new one; it is only on
// screen above 640px, so it gets its own short session there.
async function runTopBarLogout(viewport, rep) {
  const s = await prepare(viewport);
  const page = s.page;
  try {
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('ms_recent_searches', '["oracle"]'));
    const visible = await page.evaluate(() => {
      const b = document.querySelector('#logoutBtn');
      return !!b && b.offsetParent !== null;
    });
    if (!visible) { rep.skip(`N3h/${viewport}`, 'the top-bar Log out takes the same path', 'horní lišta je pod 640 px skrytá'); return; }
    // Playing first: signing out used to leave the audio running and the system
    // notification showing the signed-out user's track.
    let before = -1;
    try {
      await search(page, 'daft punk', 'track');
      await page.click('#searchResults .card-play-btn');
      await page.waitForFunction(() => { const a = document.querySelector('audio'); return a && !a.paused && a.currentTime > 1; }, { timeout: 25000 });
      before = await page.evaluate(() => document.querySelector('audio').currentTime);
    } catch {}
    await page.click('#logoutBtn');
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({
      login: (() => { const l = document.querySelector('#loginScreen'); return !!l && getComputedStyle(l).display !== 'none'; })(),
      recent: localStorage.getItem('ms_recent_searches'),
      audio: (() => { const a = document.querySelector('audio'); return a ? (a.paused ? 'paused' : `playing@${a.currentTime.toFixed(1)}`) : 'none'; })(),
    }));
    rep.check(`N3h/${viewport}`, 'the top-bar Log out takes the same path',
      after.login && !after.recent && (after.audio === 'none' || after.audio === 'paused'),
      `loginScreen=${after.login} ms_recent_searches=${after.recent} audio=${after.audio} (před odhlášením ${before.toFixed ? before.toFixed(1) : before})`);
  } finally {
    await s.browser.close();
  }
}

const main = async () => {
  STAMP = await readStamp();
  const rep = makeReport(`nav (${PATCH ? `SERVÍROVANÝ STROM ${TREE}` : 'PROTI PRODUKCI'}, cache-bust ${STAMP})`);
  // N14 cannot be measured on its own: the genre layer it answers is introduced
  // by celek 1 (openGenre/closeGenre in search.js). Until that lands,
  // store.genreOpen is never set, so the branch is unreachable from the UI and
  // no sequence can tell the two builds apart.
  rep.skip('N14', 'Back closes the genre chart', 'čeká na openGenre/closeGenre z celku 1 (search.js)');
  for (const vp of (process.env.MS_VIEWPORTS || 'phone,tablet,desktop').split(',')) {
    await run(vp, rep);
    if (vp !== 'phone') await runTopBarLogout(vp, rep);
  }
  const ok = rep.done();
  process.exit(ok ? 0 : 1);
};

main().catch((e) => { console.error(e); process.exit(2); });
