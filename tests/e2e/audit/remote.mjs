// Device -> device remote control, two real browsers: a CONTROLLER (e2e-remote-a) drives
// a TARGET (e2e-remote-b), both logged in as claude_test. Acceptance for batch
// remote-opravy (notes/impl/remote-opravy-kontrakt.md; findings B1-B24 in
// notes/impl/remote-review-2026-11-19.md, section 5 is this list).
//
// What is asserted after every action on the controller:
//   - the TARGET's real state, read from its own page (store.playerQueue / playerIndex,
//     its decks' paused / currentTime / volume, and an AnalyserNode on its audio graph);
//   - the CONTROLLER makes no sound: every <audio> deck paused, not advancing, and its
//     analyser silent. The controller first plays a queue of its own, so its decks hold
//     a source and "plays locally by mistake" is audible, not hypothetical.
// Nothing here replaces app code: actions go through the real UI (clicks, taps, CDP
// touch, keys); app functions are called only to set up a precondition (start the
// target's queue, open the full player) and the analyser only OBSERVES the graph.
//
// Oracle: must FAIL against the deployed code and PASS over the tree. The fix changes
// the backend, so "over the tree" needs the tree's backend too:
//
//   node tests/e2e/audit/remote.mjs                     # production, deployed code
//   node tests/e2e/audit/remote.mjs --tree              # tree's FRONTEND, production backend
//   tests/e2e/audit/remote_backend.sh start             # tree's backend on 127.0.0.1:18094
//   MS_URL=http://127.0.0.1:18094 node tests/e2e/audit/remote.mjs   # tree, end to end
//   tests/e2e/audit/remote_backend.sh stop              # removes the scratch copy + record
//
// Options: --vp=phone,desktop (default; add tablet), --keep (leave Up Next playlists),
// --no-sendto (skip "Send to Y while controlling X", a third device e2e-remote-c),
// --no-local (skip the local queue regression: search list copy, album Play all + Add all).
// Browser suites one at a time:  flock /home/lucas/music-seeker/notes/impl/.prejimka.lock node …
// Data: zz-audit-fixture is only READ (and checked unchanged at the end). The Up Next
// playlists of the two test devices are deleted at the end; likes made here are undone.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS, VIEWPORTS, makeReport } from './helpers.mjs';

const { chromium, devices } = pw;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const TREE = argv.includes('--tree') ? path.resolve(HERE, '../../..') : null;
const KEEP = argv.includes('--keep');
const VPS = ((argv.find(a => a.startsWith('--vp=')) || '--vp=phone,desktop').slice(5)).split(',').filter(Boolean);
const CTRL_ID = 'e2e-remote-a';
const THIRD_ID = 'e2e-remote-c';   // "Send to Y while controlling X"
const SKIP_SENDTO = argv.includes('--no-sendto');
const SKIP_LOCAL = argv.includes('--no-local');
const TGT_ID = 'e2e-remote-b';
const FIXTURE = 'zz-audit-fixture';
const R = makeReport(`remote (${BASE}${TREE ? ', frontend from tree' : ''})`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

// ── API (node side) ────────────────────────────────────────────────────────
let TOKEN = null;
async function api(p, { method = 'GET', body, device } = {}) {
  const h = { 'User-Agent': 'ms-e2e/1.0', 'Content-Type': 'application/json' };
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  if (device) h['X-Device-ID'] = device;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? J(body) : undefined });
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}
async function fixtureTracks() {
  const pls = (await api('/api/library/playlists')).body?.playlists || [];
  const fx = pls.find(p => p.name === FIXTURE);
  if (!fx) throw new Error(`${FIXTURE} not found for ${USER}`);
  const pl = (await api(`/api/library/playlist/${fx.id}`)).body;
  return { id: fx.id, tracks: (pl?.tracks || []).map(t => ({ name: t.name, artist: t.artist, album: t.album, image: t.image || '', id: t.id, duration_ms: t.duration_ms, type: 'track' })) };
}
const upnextOf = async (device) => (await api('/api/library/upnext', { device })).body;
async function likes() {
  const b = (await api('/api/library/likes')).body;
  return Array.isArray(b) ? b : (b?.likes || b?.tracks || []);
}
const likeId = (l) => `${(l.artist || '').toLowerCase()}|${(l.name || '').toLowerCase()}`;

// ── Pages ──────────────────────────────────────────────────────────────────
// Observation only: every node connected to the destination is ALSO connected to one
// analyser per context, so the page's real output can be measured.
function initScript(s) {
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  const orig = AudioNode.prototype.connect;
  window.__an = [];
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = orig.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode) {
        const ctx = this.context;
        if (!ctx.__msAn) { ctx.__msAn = ctx.createAnalyser(); ctx.__msAn.fftSize = 2048; window.__an.push(ctx.__msAn); }
        orig.call(this, ctx.__msAn);
      }
    } catch {}
    return r;
  };
}

async function newContext(browser, vp) {
  const v = VIEWPORTS[vp];
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height }, isMobile: v.isMobile, hasTouch: v.hasTouch,
    deviceScaleFactor: v.deviceScaleFactor, userAgent: v.isMobile ? devices['Pixel 5'].userAgent : undefined,
  });
  if (TREE) await serveWorktree(context, TREE);
  // Nothing un-owned may reach a YouTube lookup from a test, and the recommender /
  // radio must not put tracks of their own into either queue.
  await context.route('**/api/player/recommendations**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"recommendations":[],"tracks":[]}' }));
  await context.route('**/api/radio**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"tracks":[]}' }));
  return context;
}

async function openPage(context, device, { login = true } = {}) {
  const page = await context.newPage();
  page.__errors = [];
  page.__cmds = [];
  page.on('pageerror', (e) => page.__errors.push(String(e.message).slice(0, 200)));
  page.on('request', (rq) => {
    if (rq.method() === 'POST' && rq.url().includes('/api/remote/command')) {
      let a = '?'; try { a = JSON.parse(rq.postData() || '{}').action; } catch {}
      page.__cmds.push({ action: a, at: Date.now(), rq });
    }
  });
  await page.addInitScript(initScript, { ms_device_id: device, ms_player_engine: 'dj', ms_dj_smart_queue: 'off' });
  await page.goto(BASE, { waitUntil: 'load' });
  // A page of a context that is already logged in shows the form for a moment while
  // the stored token is checked; only a form that stays is a real logout.
  const loggedIn = () => { const l = document.querySelector('#loginScreen'); return !!l && getComputedStyle(l).display === 'none'; };
  const needLogin = await page.waitForFunction(loggedIn, null, { timeout: login ? 4000 : 20000 }).then(() => 'in', () => 'form');
  if (needLogin === 'form') {
    if (!login) throw new Error('page is not logged in');
    await page.waitForSelector('#loginUser', { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.fill('#loginUser', USER);
    await page.fill('#loginPass', PASS);
    await page.click('button:has-text("Sign In")');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#loginScreen')).display === 'none', null, { timeout: 25000 });
  }
  await page.waitForTimeout(1500);
  await gesture(page);
  await bind(page);
  return page;
}

/** A user activation without touching any control: a transient full-screen overlay. */
async function gesture(page) {
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = '__msGesture';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
    document.body.appendChild(d);
  });
  await page.click('#__msGesture', { position: { x: 3, y: 3 } });
  await page.evaluate(() => document.getElementById('__msGesture')?.remove());
}

/** The page's own module instances (same cache-bust stamp as the app). */
async function bind(page) {
  await page.evaluate(async () => {
    const src = [...document.scripts].map(s => s.src).find(s => /\/static\/js\/app\.js/.test(s)) || '';
    const v = (src.match(/\?v=([^&]+)/) || [])[1];
    const imp = (f) => import(`/static/js/${f}.js${v ? `?v=${v}` : ''}`);
    const { store } = await imp('store');
    const eng = await (await imp('player_active')).getPlayerModule();
    window.__t = { store, eng, upnext: await imp('upnext'), queue: await imp('queue'), fp: await imp('fullplayer'), likes: await imp('likes') };
  });
}

// ── Observation ────────────────────────────────────────────────────────────
const state = (page) => page.evaluate(() => {
  const { store, eng, fp } = window.__t;
  const decks = [...document.querySelectorAll('audio')];
  const a = eng.getAudio();
  return {
    idx: store.playerIndex,
    names: store.playerQueue.map(x => x.name),
    cur: store.playerQueue[store.playerIndex]?.name || null,
    curHasDur: !!store.playerQueue[store.playerIndex]?.duration_ms,
    playing: decks.some(d => !d.paused),
    t: a ? +a.currentTime.toFixed(1) : 0,
    dur: a && isFinite(a.duration) ? +a.duration.toFixed(1) : null,
    vol: store.playerVolume,
    deckVols: decks.map(d => +d.volume.toFixed(2)),
    shuffle: !!store.shuffleEnabled,
    repeat: store.repeatMode,
    muted: typeof fp.isMuted === 'function' ? fp.isMuted() : null,
    plId: store.playlistMode?.id || null,
    remoteTarget: store.remoteTarget || null,
    remoteActive: document.body.classList.contains('remote-active'),
  };
});

/** Peak of the page's output over ~0.8 s (0 when nothing is routed or it is silent). */
const peak = (page) => page.evaluate(async () => {
  let p = 0;
  for (let k = 0; k < 8; k++) {
    for (const an of (window.__an || [])) {
      const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
      for (const v of b) p = Math.max(p, Math.abs(v));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return +p.toFixed(4);
});

/** The controller is silent: every deck paused, none advancing, the analyser flat. */
async function silent(page) {
  const t0 = await page.evaluate(() => [...document.querySelectorAll('audio')].map(a => ({ p: a.paused, t: a.currentTime })));
  const pk = await peak(page);
  const t1 = await page.evaluate(() => [...document.querySelectorAll('audio')].map(a => ({ p: a.paused, t: a.currentTime })));
  const moving = t1.some((d, i) => !d.p || Math.abs(d.t - (t0[i]?.t ?? d.t)) > 0.05);
  return { ok: !moving && pk < 0.002, detail: `decks ${J(t1.map(d => d.p ? 'paused' : 'PLAYING'))}, peak ${pk}` };
}

async function audible(page) {
  const s = await state(page);
  const t0 = s.t;
  const pk = await peak(page);
  const s1 = await state(page);
  return { ok: s1.playing && s1.t > t0 && pk > 0.003, s: s1, pk };
}

async function poll(fn, ms = 8000, step = 400) {
  const end = Date.now() + ms;
  let v;
  for (;;) {
    v = await fn();
    if (v && v.ok) return v;
    if (Date.now() > end) return v || { ok: false };
    await sleep(step);
  }
}

// ── Controller UI ──────────────────────────────────────────────────────────
const TOUCH = (vp) => VIEWPORTS[vp].hasTouch;
// Phone: the mini-bar keeps only play/pause, like and queue (responsive.css), so the
// controller works from the full player. Tablet and desktop use the mini-bar.
function ui(vp) {
  return vp === 'phone'
    ? { next: '#fpNext', play: '#fpPlayPause', bar: '#fpProgressBar', shuffle: '#fpShuffle', repeat: '#fpRepeat', mute: null /* the volume row is hidden on phones (responsive.css) */, like: '#fpLike', devices: '#fpDevicesBtn', full: true }
    : { next: '#playerNext', play: '#playerPlayPause', bar: '#playerProgressBar', shuffle: '#playerShuffle', repeat: '#playerRepeat', mute: '#playerMute', like: '#playerLike', devices: '#playerDevicesBtn', full: false };
}
async function press(page, vp, sel) {
  // A full-player control needs the full player on screen (a step before may have
  // navigated away, e.g. to the Library).
  if (sel.startsWith('#fp')) await page.evaluate(() => { if (!window.__t.store.fullPlayerOpen) window.__t.fp.openFullPlayer(); });
  if (TOUCH(vp)) await page.tap(sel, { timeout: 5000 });
  else await page.click(sel, { timeout: 5000 });
  await page.evaluate(() => document.activeElement?.blur?.());
}
const openFull = (page) => page.evaluate(() => { if (!window.__t.store.fullPlayerOpen) window.__t.fp.openFullPlayer(); }).then(() => sleep(700));
const closeFull = (page) => page.evaluate(() => { if (window.__t.store.fullPlayerOpen) window.__t.fp.closeFullPlayer(); }).then(() => sleep(500));

async function cdpTouch(context, page, pts) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
  for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); await sleep(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
async function artBox(page) {
  return page.evaluate(() => { const r = document.querySelector('#fpImg').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
}

async function enterControl(page, vp, targetId) {
  const u = ui(vp);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (u.full) await openFull(page);
    const open = await page.evaluate(() => { const p = document.querySelector('#remoteDevicesPanel'); return !!p && p.style.display !== 'none'; });
    if (!open) await press(page, vp, u.devices);
    const sel = `[data-remote-action="control"][data-remote-id="${targetId}"]`;
    await page.waitForSelector(sel, { state: 'visible', timeout: 15000 });
    await page.click(sel);
    const ok = await poll(async () => ({ ok: await page.evaluate((id) => window.__t.store.remoteTarget === id, targetId) }), 5000, 250);
    if (ok.ok) { await sleep(1200); return true; }
  }
  return false;
}
async function exitControl(page) {
  // The banner's ⨯ first; then the devices panel's "Stop controlling".
  if (!await page.evaluate(() => !!window.__t.store.remoteTarget)) return;
  const viaBanner = await page.evaluate(() => {
    const b = document.querySelector('#remoteControllingBanner button');
    if (!b || b.getBoundingClientRect().width === 0) return false;
    b.click(); return true;
  });
  if (!viaBanner) {
    await page.evaluate(() => {
      const b = ['#playerDevicesBtn', '#fpDevicesBtn'].map(s => document.querySelector(s)).find(x => x && x.getBoundingClientRect().width > 0);
      b?.click();
    });
    await sleep(600);
    await page.evaluate(() => document.querySelector('[data-remote-action="stop"]')?.click());
  }
  await sleep(1000);
}

async function openQueue(page, vp) {
  if (vp === 'phone') {
    await openFull(page);
    await press(page, vp, '#fpQueueTop');
  } else {
    await closeFull(page);
    await press(page, vp, '#playerQueueBtn');
  }
  await sleep(1200);
}
const closeQueue = (page) => page.evaluate(() => {
  const q = window.__t.queue;
  if (window.__t.store.fpQueuePanelOpen) q.closeFpQueuePanel(); else if (window.__t.store.queuePanelOpen) q.closeQueuePanel();
}).then(() => sleep(500));
// Which queue list is on screen. The panels are position:fixed and slide, so their
// rects say nothing; the store flags do (CLAUDE.md, "Kontrakty").
const QLIST = `(() => {
  const st = window.__t.store;
  const id = st.fpQueuePanelOpen ? '#fpQueuePanelList' : st.queuePanelOpen ? '#queueList' : st.fullPlayerOpen ? '#fpQueueList' : null;
  return id ? { id, el: document.querySelector(id) } : { id: null, el: null };
})()`;
const queueRows = (page) => page.evaluate((QLIST) => {
  const { id, el } = eval(QLIST);
  if (!el) return { list: id, rows: [], open: { qp: window.__t.store.queuePanelOpen, fqp: window.__t.store.fpQueuePanelOpen, fp: window.__t.store.fullPlayerOpen } };
  const rows = [...el.querySelectorAll('.queue-item')];
  return { list: id, text: el.textContent.trim().slice(0, 60), rows: rows.map(x => ({ title: x.querySelector('.qi-title')?.textContent || '', now: x.classList.contains('now-playing'), qi: x.dataset.qi })) };
}, QLIST);

// ── Checks ─────────────────────────────────────────────────────────────────
// One step that throws (a selector the old code does not have, a timeout) is reported
// and the run goes on: against the deployed code most steps are EXPECTED to misbehave.
async function block(id, fn) {
  try { await fn(); } catch (e) {
    R.check(id, 'step ran without a harness error', false, String(e && e.message || e).split('\n').slice(0, 3).join(' | '));
  }
}
async function checkSilent(id, label, C) {
  const s = await silent(C);
  R.check(id, `${label}: the controller stays silent`, s.ok, s.detail);
}

async function scenarioUI({ vp, C, Cctx, T, first, last, fx }) {
  const u = ui(vp);
  const P = `[${vp}]`;

  // R0 — Control: remote mode, local audio stopped, the target keeps playing.
  await block(`STEP ${P}`, async () => {
    await enterControl(C, vp, TGT_ID);
    const c0 = await state(C);
    R.check(`R0 ${P}`, 'Control puts the controller in remote mode', c0.remoteActive && c0.remoteTarget === TGT_ID, J({ remoteActive: c0.remoteActive, remoteTarget: c0.remoteTarget }));
    await checkSilent(`R0 ${P}`, 'after Control', C);
    const tA = await poll(() => audible(T), 6000);
    R.check(`R0 ${P}`, 'the target keeps playing', tA.ok, `peak ${tA.pk}, ${J(tA.s && { cur: tA.s.cur, t: tA.s.t })}`);
  });

  await block(`STEP ${P}`, async () => {
    // B16 — cast button hidden under remote.
    const cast = await C.evaluate(() => ['#playerCastBtn', '#fpCastBtn'].map(s => {
      const el = document.querySelector(s); if (!el) return null;
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { s, shown: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' };
    }).filter(Boolean));
    if (u.full) await openFull(C);
    const cast2 = await C.evaluate(() => { const el = document.querySelector('#fpCastBtn'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).display !== 'none'; });
    R.check(`B16 ${P}`, 'the cast button is hidden while controlling', cast.every(c => !c.shown) && !cast2, J({ bar: cast, fullPlayer: cast2 }));
    if (!u.full) await closeFull(C);
  });

  // B8 — the queue panel is the TARGET's queue; ✕ and Play next act on the target.
  await block(`STEP ${P}`, async () => {
    await openQueue(C, vp);
    let tq = await state(T);
    let qr = await poll(async () => { const q = await queueRows(C); return { ok: J(q.rows.map(r => r.title)) === J(tq.names), q }; }, 6000);
    R.check(`B8 ${P}`, 'the queue panel shows the target\'s queue', qr.ok, `panel ${J(qr.q.rows.map(r => r.title))} (${qr.q.list || J(qr.q.open)}${qr.q.rows.length ? '' : `: "${qr.q.text}"`}) vs target ${J(tq.names)}`);
    const nowRow = qr.q.rows.find(r => r.now);
    R.check(`B8 ${P}`, 'its current row is the target\'s current track', nowRow && nowRow.title === tq.cur, `${nowRow?.title} vs ${tq.cur}`);
  });

  // ✕ on the last row (never the current one).
  await block(`STEP ${P}`, async () => {
      const before = await state(T);
      const k = before.names.length - 1 === before.idx ? before.names.length - 2 : before.names.length - 1;
      const name = before.names[k];
      const clicked = await C.evaluate(({ k, name, QLIST }) => {
        const list = eval(QLIST).el;
        const rows = list ? [...list.querySelectorAll('.queue-item')] : [];
        const row = rows[k];
        if (!row || row.querySelector('.qi-title')?.textContent !== name) return `row ${k} is not ${name}`;
        row.querySelector('.qi-remove').click();
        return 'ok';
      }, { k, name, QLIST });
      const after = await poll(async () => { const s = await state(T); return { ok: s.names.length === before.names.length - 1, s }; }, 8000);
      const cnt = (arr) => arr.filter(n => n === name).length;
      R.check(`B8 ${P}`, '✕ on a queue row removes that row from the TARGET\'s queue',
        clicked === 'ok' && after.ok && cnt(after.s.names) === cnt(before.names) - 1 && after.s.cur === before.cur,
        `${clicked}; target ${before.names.length} -> ${after.s.names.length} rows, cur ${after.s.cur}`);
      await checkSilent(`B8 ${P}`, '✕', C);
  });

  // Play next (row kebab) on a row two or more after the current one.
  await block(`STEP ${P}`, async () => {
      const before = await state(T);
      const k = before.idx + 2 < before.names.length ? before.idx + 2 : -1;
      if (k < 0) R.skip(`B8 ${P}`, 'Play next on a queue row', 'target queue too short');
      else {
        const name = before.names[k];
        const opened = await C.evaluate(({ k, name, QLIST }) => {
          const list = eval(QLIST).el;
          const row = list ? [...list.querySelectorAll('.queue-item')][k] : null;
          if (!row || row.querySelector('.qi-title')?.textContent !== name) return `row ${k} is not ${name}`;
          const kb = row.querySelector('.kebab-btn'); if (!kb) return 'no kebab';
          kb.click(); return 'ok';
        }, { k, name, QLIST });
        let picked = 'menu not opened';
        if (opened === 'ok') {
          picked = await C.evaluate(() => {
            const it = [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find(b => /^Play next$/.test(b.querySelector('.ctx-menu-label')?.textContent || ''));
            if (!it) return 'no "Play next" item'; it.click(); return 'ok';
          });
        }
        const after = await poll(async () => { const s = await state(T); return { ok: s.names[s.idx + 1] === name && s.names.length === before.names.length, s }; }, 8000);
        R.check(`B8 ${P}`, 'Play next on a queue row moves it after the TARGET\'s current track', opened === 'ok' && picked === 'ok' && after.ok,
          `${opened}/${picked}; target ${J(after.s.names)} idx ${after.s.idx}, wanted ${name} next`);
      }
  });
  await closeQueue(C);

  // B1 — art tap and swipe drive the target; the controller never plays.
  await block(`STEP ${P}`, async () => { if (TOUCH(vp)) {
      await openFull(C);
      const box = await artBox(C);
      const before = await state(T);
      await cdpTouch(Cctx, C, [{ x: box.x, y: box.y }]);
      const p1 = await poll(async () => { const s = await state(T); return { ok: s.playing === !before.playing, s }; }, 6000);
      R.check(`B1 ${P}`, 'art tap toggles the target', p1.ok, `target playing ${before.playing} -> ${p1.s.playing}`);
      await checkSilent(`B1 ${P}`, 'art tap', C);
      await sleep(1200);
      await cdpTouch(Cctx, C, [{ x: box.x, y: box.y }]);
      const p2 = await poll(async () => { const s = await state(T); return { ok: s.playing === before.playing, s }; }, 6000);
      R.check(`B1 ${P}`, 'a second art tap toggles it back', p1.ok && p2.ok, `target playing -> ${p2.s.playing}`);
      await checkSilent(`B1 ${P}`, 'second art tap', C);
    } else {
      R.skip(`B1 ${P}`, 'art tap / swipe', 'no touch on this viewport');
  } });
  if (!u.full) await closeFull(C);

  // B12 — play/pause: one press pauses, one resumes, two quick presses end where they began.
  await poll(() => audible(T), 8000);
  await block(`STEP ${P}`, async () => {
      await press(C, vp, u.play);
      const a = await poll(async () => { const s = await state(T); return { ok: !s.playing, s }; }, 6000);
      R.check(`B12 ${P}`, 'play/pause pauses the target', a.ok, `playing ${a.s.playing}`);
      await sleep(1500);
      await press(C, vp, u.play);
      const b = await poll(async () => { const s = await state(T); return { ok: s.playing, s }; }, 6000);
      R.check(`B12 ${P}`, 'play/pause again resumes it', a.ok && b.ok, `playing ${b.s.playing}`);
      await checkSilent(`B12 ${P}`, 'play/pause', C);
      await sleep(1500);
      await press(C, vp, u.play);
      await sleep(350);
      await press(C, vp, u.play);
      await sleep(6000);
      const c = await state(T);
      R.check(`B12 ${P}`, 'two quick play/pause presses leave the target playing (toggle decided by the target)', c.playing, `playing ${c.playing}`);
      if (!c.playing) { await press(C, vp, u.play); await sleep(3000); }
  });

  // B1/B21 — Space toggles the target.
  await block(`STEP ${P}`, async () => {
      await C.evaluate(() => document.activeElement?.blur?.());
      await C.keyboard.press('Space');
      const a = await poll(async () => { const s = await state(T); return { ok: !s.playing, s }; }, 6000);
      R.check(`B1 ${P}`, 'Space pauses the target', a.ok, `playing ${a.s.playing}`);
      await sleep(1200);
      await C.keyboard.press('Space');
      const b = await poll(async () => { const s = await state(T); return { ok: s.playing, s }; }, 6000);
      R.check(`B1 ${P}`, 'Space again resumes it', a.ok && b.ok, `playing ${b.s.playing}`);
      await checkSilent(`B1 ${P}`, 'Space', C);
  });

  // B1 — swipe on the art = Next on the target.
  await block(`STEP ${P}`, async () => { if (TOUCH(vp)) {
      await openFull(C);
      const box = await artBox(C);
      const before = await state(T);
      const pts = []; for (let i = 0; i <= 10; i++) pts.push({ x: box.x + 60 - i * 14, y: box.y });
      await cdpTouch(Cctx, C, pts);
      const a = await poll(async () => { const s = await state(T); return { ok: s.idx !== before.idx, s }; }, 8000);
      await sleep(3000);
      const s = await state(T);
      R.check(`B1 ${P}`, 'swipe left on the art advances the target by one', a.ok && s.idx === before.idx + 1, `idx ${before.idx} -> ${s.idx}`);
      await checkSilent(`B1 ${P}`, 'swipe', C);
      if (!u.full) await closeFull(C);
  } });

  // B12 — one Next = exactly one track on the target.
  await block(`STEP ${P}`, async () => {
      await poll(() => audible(T), 10000);
      const before = await state(T);
      await press(C, vp, u.next);
      const a = await poll(async () => { const s = await state(T); return { ok: s.idx !== before.idx, s }; }, 8000);
      await sleep(4000);
      const s = await state(T);
      R.check(`B12 ${P}`, 'one Next advances the target by exactly one', a.ok && s.idx === before.idx + 1, `idx ${before.idx} -> ${s.idx} (${s.cur})`);
      await checkSilent(`B12 ${P}`, 'Next', C);
  });

  // B6 — seek on an item without duration_ms (a mix, a clip) lands where pressed.
  await block(`STEP ${P}`, async () => {
      const ok = await poll(() => audible(T), 15000);
      // Precondition on the TARGET: near the start of its track, so only a real seek
      // forward can pass (a seek to 0, or no seek, stays below 40 %).
      await T.evaluate(() => { const a = window.__t.eng.getAudio(); if (a && a.currentTime > 20) a.currentTime = 5; });
      await sleep(3500); // one state report with the new track's duration
      const s0 = await state(T);
      const dur = s0.dur || (fx.find(t => t.name === s0.cur)?.duration_ms || 0) / 1000;
      const box = await C.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x + r.width * 0.6, y: r.y + r.height / 2, w: r.width }; }, u.bar);
      if (TOUCH(vp)) await C.touchscreen.tap(box.x, box.y); else await C.mouse.click(box.x, box.y);
      const a = await poll(async () => { const s = await state(T); return { ok: dur > 0 && s.t >= dur * 0.4, s }; }, 8000);
      R.check(`B6 ${P}`, 'seek at 60 % on an item without duration_ms moves the target there, not to 0',
        ok.ok && !s0.curHasDur && s0.t < dur * 0.25 && a.ok, `item has duration_ms: ${s0.curHasDur}; target ${s0.t}s -> ${a.s.t}s of ${dur}s`);
      await checkSilent(`B6 ${P}`, 'seek', C);
  });

  // B7 — shuffle / repeat / mute act on the target.
  await block(`STEP ${P}`, async () => {
      if (u.full) await openFull(C);
      const before = await state(T);
      await press(C, vp, u.shuffle);
      const a = await poll(async () => { const s = await state(T); return { ok: s.shuffle !== before.shuffle, s }; }, 6000);
      R.check(`B7 ${P}`, 'shuffle on the controller switches the target\'s shuffle', a.ok, `${before.shuffle} -> ${a.s.shuffle}`);
      await sleep(800);
      await press(C, vp, u.shuffle);
      const b = await poll(async () => { const s = await state(T); return { ok: s.shuffle === before.shuffle, s }; }, 6000);
      R.check(`B7 ${P}`, 'shuffle again switches it back', a.ok && b.ok, `-> ${b.s.shuffle}`);

      await press(C, vp, u.repeat);
      const c = await poll(async () => { const s = await state(T); return { ok: s.repeat !== before.repeat, s }; }, 6000);
      R.check(`B7 ${P}`, 'repeat on the controller changes the target\'s repeat', c.ok, `${before.repeat} -> ${c.s.repeat}`);
      for (let i = 0; i < 3; i++) {
        const s = await state(T); if (s.repeat === before.repeat) break;
        await sleep(800); await press(C, vp, u.repeat); await sleep(2500);
      }
      const c2 = await state(T);
      if (c2.repeat !== before.repeat) await T.evaluate((m) => { const { fp, store } = window.__t; if (fp.setRepeat) fp.setRepeat(m); else store.repeatMode = m; }, before.repeat);

      if (!u.mute) R.skip(`B7 ${P}`, 'mute / unmute', 'no mute button on this layout');
      else {
      await press(C, vp, u.mute);
      const d = await poll(async () => { const s = await state(T); return { ok: s.muted === true || s.deckVols.every(v => v === 0), s }; }, 6000);
      R.check(`B7 ${P}`, 'mute on the controller mutes the target', d.ok, `muted ${d.s.muted}, decks ${J(d.s.deckVols)}`);
      await sleep(800);
      await press(C, vp, u.mute);
      const e = await poll(async () => { const s = await state(T); return { ok: s.muted !== true && s.deckVols.some(v => v > 0), s }; }, 6000);
      R.check(`B7 ${P}`, 'unmute restores it', d.ok && e.ok, `muted ${e.s.muted}, decks ${J(e.s.deckVols)}`);
      R.check(`B4 ${P}`, 'mute/unmute leaves the target\'s volume level as it was', Math.abs(e.s.vol - before.vol) < 0.01, `${before.vol} -> ${e.s.vol}`);
      }
      await checkSilent(`B7 ${P}`, 'shuffle/repeat/mute', C);
  });

  // B7 — like acts on the target's CURRENT track.
  await block(`STEP ${P}`, async () => {
      // A person likes what they SEE: wait until the controller shows the target's
      // current track, then press, and record what the controller was pointed at.
      const s = await state(T);
      const shown = await poll(async () => {
        const v = await C.evaluate((id) => ({ shows: window.__t.store.remoteDevices?.[id]?.track?.name || null, target: window.__t.store.remoteTarget }), TGT_ID);
        return { ok: v.shows === s.cur, v };
      }, 10000);
      const before = new Set((await likes()).map(likeId));
      const atPress = await C.evaluate(() => window.__t.store.remoteTarget);
      await press(C, vp, u.like);
      const a = await poll(async () => {
        const added = (await likes()).filter(l => !before.has(likeId(l))).map(l => l.name);
        return { ok: added.length > 0, added };
      }, 6000);
      R.check(`B7 ${P}`, 'like on the controller likes the TARGET\'s current track', atPress === TGT_ID && a.ok && a.added.length === 1 && a.added[0] === s.cur,
        `liked ${J(a.added)}, target plays ${s.cur}; controller showed ${J(shown.v?.shows)} (waited ${shown.ok ? 'ok' : 'TIMEOUT'}), remoteTarget at press ${atPress}`);
      await sleep(800);
      await press(C, vp, u.like);
      const b = await poll(async () => ({ ok: !(await likes()).some(l => !before.has(likeId(l))) }), 6000);
      R.check(`B7 ${P}`, 'like again takes it back', a.ok && b.ok);
  });

  // B19 — DJ panel under remote: banner, no "saved ✓", no Preload, no engine selector.
  await block(`STEP ${P}`, async () => {
      await openFull(C);
      const lsBefore = await C.evaluate(() => localStorage.getItem('ms_dj_smart_queue'));
      const opened = await C.evaluate(() => { const b = document.querySelector('#fpDjPanelBtn'); if (!b || b.getBoundingClientRect().width === 0) return false; b.click(); return true; });
      await sleep(900);
      const dj = await C.evaluate(() => {
        const vis = (el) => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
        const banner = document.querySelector('#fpDjRemoteBanner');
        const sq = document.querySelector('#fpDjSmartQueue');
        return {
          banner: vis(banner) ? banner.textContent.trim() : null,
          preload: vis(document.querySelector('#fpDjPreloadBtn')),
          engine: vis(document.querySelector('#fpPlayerEngine')),
          sqDisabled: !!sq && (sq.disabled || sq.closest('fieldset')?.disabled === true),
        };
      });
      // Try to change a knob the way a user would; it must not save anything here.
      await C.evaluate(() => {
        const sq = document.querySelector('#fpDjSmartQueue');
        if (!sq || sq.disabled) return;
        const other = [...sq.options].find(o => o.value !== sq.value);
        if (other) { sq.value = other.value; sq.dispatchEvent(new Event('change', { bubbles: true })); }
      });
      await sleep(700);
      const saved = await C.evaluate(() => document.querySelector('#fpDjSavedStatus')?.textContent.trim() || '');
      const lsAfter = await C.evaluate(() => localStorage.getItem('ms_dj_smart_queue'));
      R.check(`B19 ${P}`, 'DJ panel under remote shows the "settings of <device>" banner', opened && !!dj.banner && /settings of/i.test(dj.banner), J({ opened, banner: dj.banner }));
      R.check(`B19 ${P}`, 'Preload set and the engine selector are hidden', opened && !dj.preload && !dj.engine, J({ preload: dj.preload, engine: dj.engine }));
      R.check(`B19 ${P}`, 'changing a knob saves nothing on the controller (no "saved ✓")', opened && !/saved/i.test(saved) && lsAfter === lsBefore,
        J({ disabled: dj.sqDisabled, saved, ms_dj_smart_queue: [lsBefore, lsAfter] }));
      if (lsAfter !== lsBefore) await C.evaluate((v) => { if (v === null) localStorage.removeItem('ms_dj_smart_queue'); else localStorage.setItem('ms_dj_smart_queue', v); }, lsBefore);
      await C.keyboard.press('Escape'); await sleep(500);
      await C.evaluate(() => { const c = document.querySelector('#fpDjPanelClose'); if (c && c.getBoundingClientRect().width > 0) c.click(); });
      if (!u.full) await closeFull(C);
  });
}

// Once per run (first viewport): transfer, enqueue, reload, two tabs, mutual control.
async function scenarioOnce({ vp, C, T, Tctx, fx, tgtUpnextId, ctlUpnextId, tgtVol }) {
  const P = `[${vp}]`;

  // B4 — a transfer keeps the target's volume and its own playlist context.
  await block(`STEP ${P}`, async () => {
      const before = await state(T);
      // Start the list on a track the target is NOT playing and would not reach next, or
      // a transfer that never arrived would look like one that did.
      const nextName = before.names[before.idx + 1];
      const head = fx.find(t => t.name !== before.cur && t.name !== nextName);
      const list = [head, ...fx.filter(t => t !== head)];
      await C.evaluate((tr) => window.__t.upnext.playTracks(tr, 0), list);
      const a = await poll(async () => { const s = await state(T); return { ok: s.cur === head.name && s.playing && s.names.length === list.length, s }; }, 20000);
      R.check(`B4 ${P}`, 'playing a list on the controller starts it on the target', a.ok, `target cur ${a.s.cur} (wanted ${head.name}), ${a.s.names.length} rows, playing ${a.s.playing}`);
      R.check(`B4 ${P}`, 'the transfer leaves the target\'s volume as it was', a.ok && Math.abs(a.s.vol - tgtVol) < 0.01, `target volume ${tgtVol} -> ${a.s.vol} (controller's own is 0.3)`);
      R.check(`B4 ${P}`, 'the target keeps its own Up Next as its playlist context', a.ok && a.s.plId === before.plId, `plId ${before.plId} -> ${a.s.plId} (controller's Up Next ${ctlUpnextId})`);
      await checkSilent(`B4 ${P}`, 'transfer', C);
  });

  // B5 — one Add to queue = one row in the target's queue and one in ITS Up Next.
  await block(`STEP ${P}`, async () => {
      await sleep(3000);
      const before = await state(T);
      const tUp0 = (await api(`/api/library/playlist/${tgtUpnextId}`)).body?.tracks?.length ?? null;
      const cUp0 = (await api(`/api/library/playlist/${ctlUpnextId}`)).body?.tracks?.length ?? null;
      await closeFull(C);
      // Library → Downloaded → the fixture → kebab on its last row → "Add to queue".
      await C.evaluate(() => {
        const b = [...document.querySelectorAll('.bnav-btn[data-page="library"], .nav-btn[data-page="library"]')].find(x => x.offsetParent !== null);
        b?.click();
      });
      await sleep(2500);
      await C.evaluate(() => document.querySelector('[data-lib-tab="downloaded"]')?.click());
      await sleep(2500);
      const opened = await C.evaluate((n) => {
        const row = [...document.querySelectorAll('#libraryGrid .coll-row')].find(r => r.querySelector('.coll-title')?.textContent === n);
        if (!row) return false; row.click(); return true;
      }, FIXTURE);
      await sleep(3000);
      const want = fx[3];
      const kb = opened ? await C.evaluate((name) => {
        const row = [...document.querySelectorAll('#libraryTracks .song-row')].find(r => r.textContent.includes(name));
        const k = row?.querySelector('.kebab-btn'); if (!k) return 'no kebab'; k.click(); return 'ok';
      }, want.name) : 'fixture not opened';
      await sleep(600);
      const picked = kb === 'ok' ? await C.evaluate(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find(b => /^Add to queue$/.test(b.querySelector('.ctx-menu-label')?.textContent || ''));
        if (!it) return 'no "Add to queue"'; it.click(); return 'ok';
      }) : kb;
      const a = await poll(async () => { const s = await state(T); return { ok: s.names.length > before.names.length, s }; }, 10000);
      await sleep(6000); // the playlist mirror is fire-and-forget
      const s = await state(T);
      const tUp1 = (await api(`/api/library/playlist/${tgtUpnextId}`)).body?.tracks?.length ?? null;
      const cUp1 = (await api(`/api/library/playlist/${ctlUpnextId}`)).body?.tracks?.length ?? null;
      R.check(`B5 ${P}`, 'one Add to queue adds exactly one row to the target\'s queue', picked === 'ok' && a.ok && s.names.length === before.names.length + 1 && s.names[s.names.length - 1] === want.name,
        `${picked}; ${before.names.length} -> ${s.names.length}, last ${s.names[s.names.length - 1]}`);
      R.check(`B5 ${P}`, '... and exactly one row to the target\'s Up Next playlist', tUp0 !== null && tUp1 === tUp0 + 1, `${tUp0} -> ${tUp1}`);
      R.check(`B5 ${P}`, '... and nothing to the controller\'s own Up Next', cUp0 !== null && cUp1 === cUp0, `${cUp0} -> ${cUp1}`);
      await checkSilent(`B5 ${P}`, 'Add to queue', C);
  });

  // B9 — a target reload keeps the controller in remote mode.
  let T1 = T;
  await block(`STEP ${P}`, async () => {
      const samples = [];
      let stop = false;
      const sampler = (async () => { while (!stop) { samples.push(await C.evaluate(() => document.body.classList.contains('remote-active') && !!window.__t.store.remoteTarget).catch(() => null)); await sleep(250); } })();
      await T.reload({ waitUntil: 'load' });
      await T.waitForFunction(() => { const l = document.querySelector('#loginScreen'); return l && getComputedStyle(l).display === 'none'; }, null, { timeout: 25000 });
      await sleep(1500);
      await gesture(T);
      await bind(T);
      const back = await poll(async () => { const d = await C.evaluate((id) => window.__t.store.remoteDevices?.[id] || null, TGT_ID); return { ok: !!d && d.online, d }; }, 25000);
      stop = true; await sampler;
      const dropped = samples.filter(x => x === false).length;
      R.check(`B9 ${P}`, 'the controller stays in remote mode while the target reloads', dropped === 0 && samples.length >= 6, `${dropped}/${samples.length} samples out of remote mode`);
      R.check(`B9 ${P}`, 'the controller sees the target online again', back.ok, J({ online: back.d?.online }));
      await sleep(3500);
      const sb = await state(T);
      if (!sb.playing) await press(C, vp, ui(vp).play);
      const p = await poll(async () => { const s = await state(T); return { ok: s.playing, s }; }, 15000);
      R.check(`B9 ${P}`, 'play on the controller plays the reloaded target', p.ok, `playing ${p.s.playing}, cur ${p.s.cur}`);
      await checkSilent(`B9 ${P}`, 'after the target reload', C);
  });

  // B3 — two tabs of the target device: only one plays a command.
  await block(`STEP ${P}`, async () => {
      const T2 = await openPage(Tctx, TGT_ID, { login: false });
      await sleep(5000);
      await poll(() => audible(T1), 10000);
      const before1 = await state(T1);
      await press(C, vp, ui(vp).next);
      await sleep(7000);
      const s1 = await state(T1);
      const s2 = await state(T2);
      const playingTabs = [s1.playing, s2.playing].filter(Boolean).length;
      R.check(`B3 ${P}`, 'with two tabs of the target open, exactly one plays', playingTabs === 1, `tab1 ${s1.playing} (idx ${before1.idx}->${s1.idx}), tab2 ${s2.playing} (idx ${s2.idx})`);
      R.check(`B3 ${P}`, 'the command went to the tab that was playing', s1.playing && s1.idx === before1.idx + 1, `tab1 idx ${before1.idx} -> ${s1.idx}`);
      await T2.close();
      await sleep(2500);
  });

  // B2 — mutual control is refused and does not loop. Two acceptable designs: the
  // target refuses to take control of a device that is controlling (M7, with the toast),
  // or it takes control and the server answers the controller's command with 409.
  await block(`STEP ${P}`, async () => {
      await T1.evaluate(() => document.activeElement?.blur?.());
      // One attempt by hand: a refusal is an answer here, not a reason to retry.
      // Three acceptable shapes: no Control button for that device, with the reason
      // shown in its row; or the button, refused with a toast; or control taken and the
      // server answering the controller with 409.
      await T1.click('#playerDevicesBtn');
      const sel = `[data-remote-action="control"][data-remote-id="${CTRL_ID}"]`;
      const offer = await poll(async () => {
        const v = await T1.evaluate((sel) => ({
          button: !!document.querySelector(sel),
          hint: [...document.querySelectorAll('#remoteDevicesPanel .rdr-hint')].map(e => e.textContent.trim()).find(t => /controlling another/i.test(t)) || null,
        }), sel);
        return { ok: v.button || !!v.hint, v };
      }, 15000);
      let tToast = '';
      if (offer.v.button) {
        await T1.click(sel);
        await sleep(600);
        tToast = await T1.evaluate(() => document.querySelector('#toastMsg')?.textContent || '');
      }
      await sleep(1500);
      const tc = await state(T1);
      const refused = !tc.remoteTarget;
      if (refused) {
        R.check(`B2 ${P}`, 'taking control of a device that controls this one is refused with a message',
          !tc.remoteActive && (offer.v.hint ? true : /controlling another/i.test(tToast)),
          J({ remoteTarget: tc.remoteTarget, controlButton: offer.v.button, rowHint: offer.v.hint, toast: tToast }));
      }
      const t0 = Date.now();
      C.__cmds.length = 0; T1.__cmds.length = 0;
      const statuses = [];
      const onResp = (r) => { if (r.url().includes('/api/remote/command')) statuses.push(r.status()); };
      C.on('response', onResp); T1.on('response', onResp);
      await press(C, vp, ui(vp).next);
      await sleep(8000);
      C.off('response', onResp); T1.off('response', onResp);
      const cmds = [...C.__cmds, ...T1.__cmds].filter(c => c.at >= t0).map(c => c.action);
      const toast = await C.evaluate(() => document.querySelector('#toastMsg')?.textContent || '');
      R.check(`B2 ${P}`, 'after the attempt at mutual control, a command does not ping-pong', cmds.length >= 1 && cmds.length <= 2 && !cmds.includes('transfer'),
        `target controlling ${tc.remoteTarget}; commands in 8 s: ${J(cmds)}, statuses ${J(statuses)}`);
      if (!refused) {
        R.check(`B2 ${P}`, 'the controller is told the device is controlling another device', statuses.includes(409) || /controlling another/i.test(toast), J({ statuses, toast }));
        const both = [await silent(C), await silent(T1)];
        R.check(`B2 ${P}`, 'neither device starts playing', both.every(x => x.ok), both.map(x => x.detail).join(' | '));
      } else {
        R.check(`B2 ${P}`, 'the refused device stays a plain target: the command is accepted (2xx)', statuses.length >= 1 && statuses.every(x => x >= 200 && x < 300), J({ statuses }));
        await checkSilent(`B2 ${P}`, 'mutual-control attempt', C);
      }
      await T1.evaluate(() => { const p = document.querySelector('#remoteDevicesPanel'); if (p) p.style.display = 'none'; });
      await exitControl(T1);
      // Cleanup if the old code is looping: the loop needs both devices in remote mode.
      await T1.evaluate(() => { const { store } = window.__t; if (store.remoteTarget) { store.remoteTarget = null; document.body.classList.remove('remote-active'); } });
      await sleep(2000);
  });

  // Send to Y while controlling X: X stops, Y plays X's queue, the controller follows Y.
  if (SKIP_SENDTO) R.skip(`SENDTO ${P}`, 'Send to Y while controlling X', '--no-sendto');
  else await block(`STEP ${P}`, async () => {
      const Yctx = await newContext(C.context().browser(), 'desktop');
      try {
        const Y = await openPage(Yctx, THIRD_ID);
        await poll(async () => ({ ok: await C.evaluate((id) => !!window.__t.store.remoteDevices?.[id]?.online, THIRD_ID) }), 15000);
        const pa = await poll(() => audible(T1), 8000);
        if (!pa.ok) { await press(C, vp, ui(vp).play); await poll(() => audible(T1), 10000); }
        await sleep(3500);
        const x0 = await state(T1);
        const u = ui(vp);
        if (u.full) await openFull(C);
        await press(C, vp, u.devices);
        const sel = `[data-remote-action="transfer"][data-remote-id="${THIRD_ID}"]`;
        await C.waitForSelector(sel, { state: 'visible', timeout: 15000 });
        await C.click(sel);
        const y = await poll(async () => { const s = await state(Y); return { ok: s.playing && J(s.names) === J(x0.names), s }; }, 25000);
        const x = await poll(async () => { const s = await state(T1); return { ok: !s.playing, s }; }, 8000);
        const c = await state(C);
        R.check(`SENDTO ${P}`, 'Send to Y while controlling X: Y plays X\'s queue', y.ok,
          `X ${x0.names.length} rows at ${x0.idx} (${x0.cur}); Y ${y.s.names.length} rows at ${y.s.idx} (${y.s.cur}), playing ${y.s.playing}`);
        R.check(`SENDTO ${P}`, '... at X\'s track', y.s.cur === x0.cur, `${y.s.cur} vs ${x0.cur}`);
        R.check(`SENDTO ${P}`, '... and X stops', x.ok, `X playing ${x.s.playing}`);
        R.check(`SENDTO ${P}`, '... and the controller now controls Y', c.remoteTarget === THIRD_ID && c.remoteActive, J({ remoteTarget: c.remoteTarget }));
        await checkSilent(`SENDTO ${P}`, 'Send to', C);
        // Back to X for the rest of the run; Y goes quiet and away.
        await enterControl(C, vp, TGT_ID);
        await Y.evaluate(() => { for (const a of document.querySelectorAll('audio')) a.pause(); });
      } finally {
        await Yctx.close().catch(() => {});
      }
  });
  return T1;
}

// Local regression (no remote control): the queue is a COPY of the list it started
// from. Adding to the queue must not grow the list, and an album's Play all + Add all
// must not stall the page. Streams are stubbed (404): nothing here needs sound, and no
// search result may reach a YouTube lookup from a test.
async function localRegression(browser) {
  const ctx = await newContext(browser, 'desktop');
  await ctx.route((u) => /\/api\/player\/(stream|stream-duration|resolve-source)$/.test(new globalThis.URL(u).pathname),
    r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"stubbed by remote.mjs"}' }));
  await ctx.route('**/api/player/prewarm**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  try {
    const page = await openPage(ctx, CTRL_ID);
    const q = () => page.evaluate(async () => {
      const src = [...document.scripts].map(s => s.src).find(s => /\/static\/js\/app\.js/.test(s)) || '';
      const v = (src.match(/\?v=([^&]+)/) || [])[1];
      const pc = await import(`/static/js/playcontext.js${v ? `?v=${v}` : ''}`);
      const row = document.querySelector('#searchResults .song-row[data-item]');
      const list = row ? pc.getPlayContext(row) : null;
      const qq = window.__t.store.playerQueue;
      return { q: qq.length, list: list ? list.length : null, same: !!list && qq === list, remote: !!window.__t.store.remoteTarget };
    });
    const settle = async (ms = 30000) => {
      let last = -1, since = Date.now(); const end = Date.now() + ms;
      while (Date.now() < end) {
        const n = await page.evaluate(() => window.__t.store.playerQueue.length);
        if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since > 3500) return n;
        await sleep(500);
      }
      return last;
    };
    const kebabPick = async (rowSel, label) => {
      const k = await page.evaluate((rowSel) => {
        const kb = document.querySelector(rowSel)?.querySelector('.kebab-btn');
        if (!kb) return 'no kebab'; kb.click(); return 'ok';
      }, rowSel);
      if (k !== 'ok') return k;
      await sleep(500);
      return page.evaluate((label) => {
        const it = [...document.querySelectorAll('.ctx-menu .ctx-menu-item')].find(b => (b.querySelector('.ctx-menu-label')?.textContent || '') === label);
        if (!it) return `no "${label}"`;
        it.click(); return 'ok';
      }, label);
    };

    // Search → play a result → Add to queue one track.
    await page.fill('#searchInput', 'Daft Punk');
    await page.keyboard.press('Enter');
    await sleep(3000);
    await page.evaluate(() => document.querySelector('.type-btn[data-type="track"]')?.click());
    await page.waitForSelector('#searchResults .song-row[data-item]', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#searchResults .song-row[data-item] .card-play-btn')?.click());
    await sleep(2000);
    await settle();
    const a = await q();
    const picked = await kebabPick('#searchResults .song-row[data-item]:nth-child(2)', 'Add to queue');
    await sleep(3000);
    await settle(10000);
    const b = await q();
    R.check('LOCAL', 'not in remote mode for the local checks', !a.remote && !b.remote, J({ a: a.remote, b: b.remote }));
    R.check('LOCAL', 'playing a search result starts the queue as a copy of the list, not the list itself', a.list !== null && !a.same, J(a));
    R.check('LOCAL', 'Add to queue on a search row grows the queue by exactly 1', picked === 'ok' && b.q === a.q + 1, `${picked}; queue ${a.q} -> ${b.q}`);
    R.check('LOCAL', '... and the search list itself does not grow', a.list !== null && b.list === a.list, `list ${a.list} -> ${b.list}`);

    // Album: Play all (replace Up Next), then Add all to queue — within 5 s (a freeze never finishes; network time counts too), page responsive.
    await page.fill('#searchInput', 'Discovery Daft Punk');
    await page.keyboard.press('Enter');
    await sleep(3000);
    await page.evaluate(() => document.querySelector('.type-btn[data-type="album"]')?.click());
    await sleep(3500);
    const albumSel = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#searchResults [data-item]')].find(e => { try { return JSON.parse(e.dataset.item).type === 'album'; } catch { return false; } });
      if (!el) return null; el.setAttribute('data-ms-album', '1'); return '[data-ms-album="1"]';
    });
    if (!albumSel) { R.check('LOCAL', 'an album result to test with', false, 'no album card'); return; }
    const p1 = await kebabPick(albumSel, 'Play all (replace Up Next)');
    await sleep(2000);
    const n = await settle(20000);
    const t0 = Date.now();
    const p2 = await kebabPick(albumSel, 'Add all to queue');
    let lag = 0, done = null;
    while (Date.now() - t0 < 6000) {
      const s0 = Date.now();
      const len = await page.evaluate(() => window.__t.store.playerQueue.length);
      lag = Math.max(lag, Date.now() - s0);
      if (len >= 2 * n) { done = Date.now() - t0; break; }
      await sleep(100);
    }
    await sleep(2000);
    const fin = await page.evaluate(() => window.__t.store.playerQueue.length);
    R.check('LOCAL', 'album Play all + Add all: the queue doubles within 5 s', p1 === 'ok' && p2 === 'ok' && n > 0 && done !== null && done <= 5000 && fin === 2 * n,
      `${p1}/${p2}; album ${n} tracks, queue ${fin} after, doubled in ${done} ms`);
    R.check('LOCAL', '... and the page stays responsive meanwhile', lag < 1000, `slowest evaluate round trip ${lag} ms`);
    R.check('LOCAL', 'no uncaught page errors', page.__errors.length === 0, J(page.__errors.slice(0, 5)));
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── Run ────────────────────────────────────────────────────────────────────
const tokRes = await api('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
TOKEN = tokRes.body?.token;
if (!TOKEN) { console.error('login failed', tokRes.status); process.exit(2); }
const FX = await fixtureTracks();
if (FX.tracks.length < 4) { console.error(`${FIXTURE} has ${FX.tracks.length} tracks, need 4`); process.exit(2); }
const fx = FX.tracks;
const likesAtStart = new Set((await likes()).map(likeId));
// The target plays the fixture twice over, every item WITHOUT duration_ms (as a mix or
// a clip): the controller must seek with the target's own duration (B6).
const targetQueue = [...fx, ...fx].map(t => { const c = { ...t }; delete c.duration_ms; return c; });

const browser = await chromium.launch();
let T = null, Tctx = null, tgtUpnextId = null, ctlUpnextId = null;
const TGT_VOL = 0.8;
try {
  Tctx = await newContext(browser, 'desktop');
  T = await openPage(Tctx, TGT_ID);
  tgtUpnextId = (await upnextOf(TGT_ID))?.id || null;
  ctlUpnextId = (await upnextOf(CTRL_ID))?.id || null;

  for (let vi = 0; vi < VPS.length; vi++) {
    const vp = VPS[vi];
    console.log(`\n── controller ${vp} ──`);
    // Target: a fresh queue of its own, playing, at its own volume.
    await T.evaluate(async (tracks) => {
      const { store, upnext, queue, fp } = window.__t;
      if (store.remoteTarget) { store.remoteTarget = null; document.body.classList.remove('remote-active'); }
      if (fp.setShuffle) fp.setShuffle(false); else store.shuffleEnabled = false;
      if (fp.setRepeat) fp.setRepeat('off'); else store.repeatMode = 'off';
      if (fp.setMuted) fp.setMuted(false);
      queue.resetShuffleOrder?.();
      await upnext.playTracks(tracks, 0);
    }, targetQueue);
    await T.evaluate((v) => { const el = document.querySelector('#playerVolume'); el.value = Math.round(v * 100); el.dispatchEvent(new Event('input', { bubbles: true })); }, TGT_VOL);
    const ta = await poll(() => audible(T), 60000, 1000);
    if (!ta.ok) { R.check(`SETUP [${vp}]`, 'the target plays its queue', false, `peak ${ta.pk}, ${J(ta.s)}`); continue; }

    // Controller: plays a queue of its own first (so its decks hold a source), at 0.3.
    const Cctx = await newContext(browser, vp);
    const C = await openPage(Cctx, CTRL_ID);
    try {
      await C.evaluate(() => { for (const s of ['#playerVolume', '#fpVolume']) { const el = document.querySelector(s); if (el) { el.value = 30; el.dispatchEvent(new Event('input', { bubbles: true })); } } });
      await C.evaluate((tr) => window.__t.upnext.playTracks(tr, 0), [fx[3], fx[2]]);
      const ca = await poll(() => audible(C), 60000, 1000);
      if (!ca.ok) R.skip(`SETUP [${vp}]`, 'the controller plays a local queue first', `never audible (peak ${ca.pk}) — "silent" checks are weaker`);
      const ctlLocal = (await state(C)).names;
      await sleep(3500); // a state report from the target with its queue and duration

      await scenarioUI({ vp, C, Cctx, T, first: vi === 0, last: vi === VPS.length - 1, fx });
      if (vi === 0) T = await scenarioOnce({ vp, C, T, Tctx, fx, tgtUpnextId, ctlUpnextId, tgtVol: TGT_VOL });

      // B8 — Clear on the controller clears the TARGET's queue (last viewport only).
      if (vi === VPS.length - 1) {
        const tb = await state(T);
        await openQueue(C, vp);
        const clicked = await C.evaluate((QLIST) => {
          const id = eval(QLIST).id;
          const sel = { '#fpQueuePanelList': '#fpQueueClear', '#queueList': '#clearQueue', '#fpQueueList': '#fpClearQueue' }[id];
          const b = sel && document.querySelector(sel);
          if (!b) return null;
          b.click(); return sel;
        }, QLIST);
        const a = await poll(async () => { const s = await state(T); return { ok: s.names.length === 0, s }; }, 8000);
        R.check(`B8 [${vp}]`, 'Clear on the controller clears the TARGET\'s queue', !!clicked && a.ok, `${clicked}; target ${tb.names.length} -> ${a.s.names.length} rows`);
        await checkSilent(`B8 [${vp}]`, 'Clear', C);
        await closeQueue(C);
      }

      // Leaving remote mode gives the controller its own queue back, silently.
      await exitControl(C);
      const ce = await state(C);
      R.check(`EXIT [${vp}]`, 'Stop controlling leaves remote mode', !ce.remoteActive && !ce.remoteTarget, J({ remoteActive: ce.remoteActive, remoteTarget: ce.remoteTarget }));
      R.check(`EXIT [${vp}]`, 'the controller gets its own queue back', J(ce.names) === J(ctlLocal), `${J(ce.names)} vs before ${J(ctlLocal)}`);
      await checkSilent(`EXIT [${vp}]`, 'Stop controlling', C);
      const errs = [...C.__errors, ...T.__errors];
      R.check(`ERR [${vp}]`, 'no uncaught page errors', errs.length === 0, J(errs.slice(0, 5)));
      C.__errors.length = 0; T.__errors.length = 0;
    } catch (e) {
      R.check(`CRASH [${vp}]`, 'scenario ran to the end', false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | '));
    } finally {
      await Cctx.close().catch(() => {});
    }
  }
  if (SKIP_LOCAL) R.skip('LOCAL', 'local queue regression', '--no-local');
  else {
    console.log('\n── local (no remote) ──');
    if (T) await T.evaluate(() => { for (const a of document.querySelectorAll('audio')) a.pause(); }).catch(() => {});
    try { await localRegression(browser); } catch (e) { R.check('LOCAL', 'step ran without a harness error', false, String(e && e.message || e).split('\n')[0]); }
  }
} finally {
  // ── Cleanup ──
  try {
    if (T) await T.evaluate(() => { for (const a of document.querySelectorAll('audio')) a.pause(); }).catch(() => {});
    await browser.close();
  } catch {}
  try {
    for (const l of await likes()) {
      if (!likesAtStart.has(likeId(l))) await api('/api/library/unlike', { method: 'POST', body: { name: l.name, artist: l.artist, album: l.album, id: l.id } });
    }
  } catch (e) { console.log('cleanup likes:', e.message); }
  if (!KEEP) {
    for (const dev of [TGT_ID, CTRL_ID, THIRD_ID]) {
      try {
        const u = await upnextOf(dev);
        if (u?.id && String(u.name || '').startsWith('__upnext_')) await api(`/api/library/playlist/${u.id}`, { method: 'DELETE' });
      } catch (e) { console.log('cleanup upnext:', e.message); }
    }
  }
  const fxAfter = await fixtureTracks().catch(() => null);
  R.check('FIXTURE', `${FIXTURE} is unchanged`, fxAfter && J(fxAfter.tracks.map(t => t.id)) === J(fx.map(t => t.id)), fxAfter ? `${fxAfter.tracks.length} tracks` : 'unreadable');
}

const ok = R.done();
const failed = R.rows.filter(r => r.ok === false);
if (failed.length) console.log('\nFailed:\n' + failed.map(r => `  ${r.id}  ${r.popis}`).join('\n'));
process.exit(ok ? 0 : 1);
