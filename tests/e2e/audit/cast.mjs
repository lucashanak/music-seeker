// DLNA cast against a FAKE receiver: the page never talks to a real renderer.
//
// Every /api/dlna/* request the page makes is answered by `page.route` from a scripted
// receiver held in this process (see `makeFake`). An /api/dlna request the fake does not
// know is ABORTED and counted as a failure, and every /api/dlna request the page sends is
// compared with what the fake answered — so nothing in this suite can reach the server's
// DLNA router, let alone the Onkyo. The saved queue (GET/PUT /api/player/queue) is faked
// as well, so the suite does not overwrite a queue on production either. Only scenario
// `handover` streams real audio (a fixture track, owned → local file, no YouTube).
//
// Contract: notes/impl/cast-opravy-kontrakt.md. Findings: notes/impl/cast-review-2026-11-19.md.
//
//   restore   page reload while casting → cast state restored from GET /api/dlna/status,
//             poll runs, the server's track is adopted, no POST /cast; play/pause go to
//             the receiver, never to a local deck                         (findings 2, 9)
//   sleep     status answers stall (held) and the page is frozen (CDP lifecycle) while
//             the server-side follower advances the queue → the page shows the new track,
//             sends no POST /cast for it, and never has two status requests in flight
//                                                                       (findings 1, 6, 8)
//   seek      status reports duration 7200 (a 2 h mix) while the local deck holds nothing
//             → 50 % on the progress bar seeks the receiver to ~3600 s (mini bar and
//             full player)                                                   (finding 4)
//   handover  a track playing locally at N s, press cast → POST /cast start_seconds ≈ N,
//             both local decks paused                                   (findings 3, 18)
//   midstop   the receiver stops mid-track (70/300 s; midstopmix: 3300/3600 s) while the
//             server follows → no cast, no queue move, the icon goes to paused, one tap
//             sends exactly one POST /play                                     (finding 9)
//   superseded POST /cast answers 409 cause "superseded" (first cast, and Next while
//             casting) → no "Cast failed" toast, no local deck plays
//   abandoned status {"active": false, "abandoned": "..."} → that message as a toast,
//             cast state off                                                 (finding 7)
//   autoplay  the cast sits on the queue's LAST row: the page hands the recommender's next
//             picks to the server (next-hint `autoplay`) without consuming them; the server
//             appends them to the saved queue and casts them (track.autoplay) — awake and
//             frozen, the page pushes those rows behind the "Autoplay" divider, shows them,
//             and sends no POST /cast of its own; a queue save pending at the freeze does
//             not overwrite the server's rows on wake            (screen-off stop, 2026-11-21)
//
// Oracle: production, account claude_test (never lucas). Must FAIL on the deployed code and
// PASS over the tree:
//   node tests/e2e/audit/cast.mjs                       # deployed frontend
//   node tests/e2e/audit/cast.mjs --tree                # this checkout's static/ (serveWorktree)
//   MS_TREE=/path/to/tree node tests/e2e/audit/cast.mjs
//   ... --vp=desktop,phone  restore sleep              # viewports / scenario subset
// Default viewports: phone, tablet, desktop. Run through the shared lock:
//   flock /home/lucas/music-seeker/notes/impl/.prejimka.lock node tests/e2e/audit/cast.mjs --tree
import path from 'node:path';
import { fileURLToPath, URL as WebURL } from 'node:url';
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS, VIEWPORTS, makeReport } from './helpers.mjs';

const { chromium } = pw;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = process.env.MS_TREE || (process.argv.includes('--tree') ? path.resolve(HERE, '../../..') : null);
const vpArg = process.argv.find(a => a.startsWith('--vp='));
const VPS = (vpArg ? vpArg.slice(5) : (process.env.MS_VIEWPORTS || 'phone,tablet,desktop')).split(',').filter(Boolean);
const ALL = ['restore', 'sleep', 'seek', 'handover', 'midstop', 'midstopmix', 'superseded', 'abandoned', 'autoplay'];
const want = process.argv.slice(2).filter(a => !a.startsWith('--'));
const SCEN = want.length ? want : ALL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = 'ms-audit/1.0';

const R = makeReport(`cast${TREE ? ' (tree ' + TREE + ')' : ' (deployed)'}`);

// ── Fixture data straight from the server (read only) ──
async function api(p, tok) {
  const r = await fetch(BASE + p, { headers: { 'User-Agent': UA, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } });
  return r.json();
}
const tok = (await (await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})).json()).token;
if (!tok) throw new Error('login claude_test failed');
const fixture = ((await api('/api/library/playlists', tok)).playlists || []).find(p => p.name === 'zz-audit-fixture');
if (!fixture) throw new Error('fixture zz-audit-fixture missing');
const FIX = ((await api(`/api/library/playlist/${fixture.id}`, tok)).tracks || [])
  .map(t => ({ name: t.name, artist: t.artist, album: t.album || '', image: t.image || '', duration_ms: t.duration_ms || 0, type: 'track' }));
if (FIX.length < 3) throw new Error('fixture has < 3 tracks');
// The page resolves the renderer from the app-wide preference; the fake renderer has to
// be the one the user chose or the page refuses to cast (cast.js _resolveRenderer).
const SAVED_RENDERER = (await api('/api/settings', tok)).dlna_renderer_url || 'http://192.0.2.10:8080/description.xml';
const DEV = { id: 'uuid:e2e-fake-renderer', name: 'E2E Fake Receiver', ip: '192.0.2.10', location: SAVED_RENDERER };

// ── The scripted receiver ──
function makeFake() {
  const f = {
    active: false, state: 'STOPPED', base: 0, baseAt: Date.now(), dur: 0, durOverride: 0,
    volume: 35, cast_seq: 0, track: null, pendingAbandon: null, session_id: 'e2e-session-1',
    castReply: null,       // one-shot override for the next POST /cast: { status, body }
    hold: false, held: [],
    log: [],              // every /api/dlna request the fake answered: { op, body, t }
    unknown: [],          // /api/dlna requests the fake does not implement (aborted)
    inflight: new Set(), maxInflight: 0, inflightAt: [],
    pos() { return this.state === 'PLAYING' ? this.base + (Date.now() - this.baseAt) / 1000 : this.base; },
    setPos(p) { this.base = p; this.baseAt = Date.now(); },
    play(track, pos) {
      this.active = true; this.state = 'PLAYING'; this.cast_seq++;
      this.track = track; this.setPos(pos || 0);
      this.dur = this.durOverride || (track.duration_ms ? track.duration_ms / 1000 : 240);
    },
    // The server-side follower moved on by itself (contract: track.by == "server").
    advance(qi, item, pos = 3) {
      this.play({ queue_index: qi, name: item.name, artist: item.artist, album: item.album, image: item.image, duration_ms: item.duration_ms, by: 'server' }, pos);
    },
    abandon(msg) { this.active = false; this.state = 'STOPPED'; this.pendingAbandon = msg; },
    status() {
      if (!this.active) {
        if (this.pendingAbandon) { const m = this.pendingAbandon; this.pendingAbandon = null; return { active: false, abandoned: m }; }
        return { active: false };
      }
      return {
        active: true, device: DEV.name, device_id: DEV.id, location: DEV.location, state: this.state,
        position_seconds: Math.round(Math.min(this.pos(), this.dur) * 10) / 10, duration_seconds: this.dur,
        volume: this.volume, follow: true, cast_seq: this.cast_seq, session_id: this.session_id, track: { ...this.track }, queue_ended: false,
      };
    },
    ops(op, since = 0) { return this.log.filter(l => l.op === op && l.t >= since); },
  };
  return f;
}

async function fakeRoute(fake, route) {
  const req = route.request();
  const u = new WebURL(req.url());
  const op = `${req.method()} ${u.pathname.replace(/^\/api\/dlna\//, '')}`;
  let body = null;
  try { body = req.postDataJSON(); } catch { /* no body */ }
  fake.log.push({ op, body, t: Date.now() });
  const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) }).catch(() => {});
  switch (op) {
    case 'GET devices':
    case 'POST scan':
      return json({ devices: [DEV] });
    case 'GET status': {
      fake.inflight.add(req);
      if (fake.inflight.size > fake.maxInflight) { fake.maxInflight = fake.inflight.size; fake.inflightAt.push(Date.now()); }
      const answer = async () => { await json(fake.status()); fake.inflight.delete(req); };
      if (fake.hold) { fake.held.push(answer); return; }
      return answer();
    }
    case 'POST cast': {
      if (fake.castReply) { const r = fake.castReply; fake.castReply = null; return json(r.body, r.status); }
      const b = body || {};
      fake.play({ queue_index: Number.isInteger(b.queue_index) ? b.queue_index : -1, name: b.name, artist: b.artist,
        album: b.album, image: b.image, duration_ms: b.duration_ms || 0, by: 'client' }, b.start_seconds || 0);
      return json({ status: 'casting', cast_seq: fake.cast_seq, session_id: fake.session_id });
    }
    case 'POST next-hint':
      if (!fake.active) return json({ detail: 'no session' }, 400);
      if (body && fake.track && body.queue_index === fake.track.queue_index) return json({ status: 'ok' });
      return json({ stale: true }, 409);
    case 'POST play': fake.setPos(fake.pos()); fake.state = 'PLAYING'; return json({ status: 'playing' });
    case 'POST pause': fake.setPos(fake.pos()); fake.state = 'PAUSED_PLAYBACK'; return json({ status: 'paused' });
    case 'POST stop': fake.active = false; fake.state = 'STOPPED'; return json({ status: 'stopped' });
    case 'POST seek': fake.setPos((body && body.position_seconds) || 0); return json({ status: 'ok' });
    case 'POST volume': fake.volume = (body && body.volume) ?? fake.volume; return json({ status: 'ok', volume: fake.volume });
    default:
      fake.unknown.push(op);
      return route.abort();
  }
}

async function release(fake) {
  fake.hold = false;
  const h = fake.held.splice(0);
  for (const a of h) await a();
}

// ── A browser context wired to the fake ──
async function session(browser, vpName, queueInit) {
  const vp = VIEWPORTS[vpName];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    userAgent: vp.isMobile ? pw.devices['Pixel 5'].userAgent : undefined,
    serviceWorkers: 'block', // page.route must see every request
  });
  if (TREE) await serveWorktree(context, TREE);
  const fake = makeFake();
  const seen = [];            // every /api/dlna request the page sent, routed or not
  await context.route(/\/api\/dlna\//, (route) => fakeRoute(fake, route));
  // Saved queue: faked, so nothing on production is overwritten and a reload sees what
  // the page last saved.
  const saved = { queue: queueInit.queue, current_index: queueInit.index ?? 0, position_seconds: 0,
    volume: 0.8, shuffle_order: null, playlist_mode: null };
  const puts = [];
  await context.route(/\/api\/player\/queue(\?|$)/, async (route) => {
    const m = route.request().method();
    if (m === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) });
    if (m === 'PUT') {
      let b = null; try { b = route.request().postDataJSON(); } catch {}
      if (b) { puts.push({ t: Date.now(), current_index: b.current_index }); Object.assign(saved, b); }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"saved"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
  });
  // No recommender / radio track may start a YouTube lookup from a test.
  await context.route('**/api/player/recommendations**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"recommendations":[],"tracks":[]}' }));
  await context.route('**/api/radio**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"tracks":[]}' }));

  const page = await context.newPage();
  page.on('request', (r) => { if (/\/api\/dlna\//.test(r.url())) seen.push(r.method() + ' ' + new WebURL(r.url()).pathname); });
  page.on('requestfailed', (r) => fake.inflight.delete(r)); // a request the page gave up on is not in flight
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.addInitScript(() => {
    localStorage.setItem('ms_device_id', 'e2e-cast');
    localStorage.setItem('ms_player_engine', 'dj');
    localStorage.setItem('ms_dj_smart_queue', 'off');
    // Observation only: every text the toast shows.
    window.__toasts = [];
    new MutationObserver(() => {
      const t = document.getElementById('toastMsg');
      const s = t && t.textContent;
      if (s && s !== window.__lastToast) { window.__lastToast = s; window.__toasts.push(s); }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    window.__mods = async () => {
      if (window.__m) return window.__m;
      const src = [...document.scripts].map(s => s.src).find(s => /\/app\.js/.test(s)) || '';
      const q = src.includes('?v=') ? '?v=' + src.split('?v=')[1] : '';
      const imp = (f) => import(`/static/js/${f}.js${q}`);
      window.__m = { store: (await imp('store')).store, eng: await (await imp('player_active')).getPlayerModule(), fp: await imp('fullplayer') };
      return window.__m;
    };
  });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#loginUser', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => { const l = document.querySelector('#loginScreen'); return l && getComputedStyle(l).display === 'none'; }, null, { timeout: 25000 });
  await page.waitForTimeout(2000);
  return { context, page, fake, seen, saved, puts, errors, vpName };
}

// ── Page probes ──
const st = (page) => page.evaluate(async () => {
  const { store } = await window.__mods();
  const decks = [...document.querySelectorAll('audio')].map(a => ({ paused: a.paused, t: a.currentTime, src: !!a.getAttribute('src') }));
  const btns = ['#playerCastBtn', '#fpCastBtn'].map(s => document.querySelector(s)).filter(Boolean);
  const castOn = btns.some(b => !!b.style.color || b.classList.contains('casting') || b.classList.contains('active')
    || b.getAttribute('aria-pressed') === 'true');
  return {
    cast: store.castDevice ? (store.castDevice.id || store.castDevice.name || true) : null,
    castOn, idx: store.playerIndex, playing: store.playerPlaying, full: !!store.fullPlayerOpen,
    title: document.querySelector('#playerTitle')?.textContent || '',
    fpTitle: document.querySelector('#fpTitle')?.textContent || '',
    decks, localPlaying: decks.some(d => !d.paused), toasts: window.__toasts.slice(),
  };
});

async function waitFor(fn, ms, step = 250) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}

async function visible(page, sel) {
  const h = await page.$(sel);
  return !!(h && await h.isVisible());
}

async function openFull(page) {
  if ((await st(page)).full) return;
  await page.evaluate(async () => (await window.__mods()).fp.openFullPlayer());
  await page.waitForTimeout(800);
}

// The visible cast button: the bar's on wide screens, the full player's on phones
// (responsive.css hides #playerCastBtn under 640 px).
async function pressCast(page) {
  if (await visible(page, '#playerCastBtn')) { await page.click('#playerCastBtn'); return 'bar'; }
  await openFull(page);
  await page.click('#fpCastBtn');
  return 'full player';
}

async function pressPlayPause(page) {
  if ((await st(page)).full) { await page.click('#fpPlayPause'); return 'full player'; }
  if (await visible(page, '#playerPlayPause')) { await page.click('#playerPlayPause'); return 'bar'; }
  await openFull(page);
  await page.click('#fpPlayPause');
  return 'full player';
}

// Click (or tap) at a fraction of an element's width.
async function hitBar(s, sel, frac) {
  const box = await (await s.page.$(sel)).boundingBox();
  const x = box.x + box.width * frac, y = box.y + box.height / 2;
  if (VIEWPORTS[s.vpName].hasTouch) await s.page.touchscreen.tap(x, y);
  else await s.page.mouse.click(x, y);
}

// Bring the page into an active cast through the normal UI: cast button → POST /cast.
async function startCasting(s, tag) {
  const how = await pressCast(s.page);
  const ok = await waitFor(async () => s.fake.ops('POST cast').length > 0 && (await st(s.page)).cast, 8000);
  R.check(`${tag}.setup`, `casting starts from the ${how} cast button (fake receiver)`, !!ok,
    `POST /cast=${s.fake.ops('POST cast').length}, castDevice=${JSON.stringify((await st(s.page)).cast)}`);
  return !!ok;
}

function routingChecks(s, tag) {
  R.check(`${tag}.routed`, 'every /api/dlna request was answered by the fake (none unknown, none unrouted)',
    s.fake.unknown.length === 0 && s.seen.length === s.fake.log.length,
    `seen=${s.seen.length} answered=${s.fake.log.length} unknown=[${s.fake.unknown.join(', ')}]`);
  R.check(`${tag}.errors`, 'no page errors', s.errors.length === 0, s.errors.slice(0, 3).join(' | '));
}

async function pressNext(page) {
  if ((await st(page)).full) { await page.click('#fpNext'); return 'full player'; }
  if (await visible(page, '#playerNext')) { await page.click('#playerNext'); return 'bar'; }
  await openFull(page);
  await page.click('#fpNext');
  return 'full player';
}

async function midstopRun(browser, vp, name, dur, at) {
  const tag = `${vp}.${name}`;
  const q = Q();
  const s = await session(browser, vp, { queue: q, index: 0 });
  try {
    s.fake.durOverride = dur;
    if (!(await startCasting(s, tag))) return;
    s.fake.setPos(at);
    const iconPlay = () => s.page.evaluate(() => (document.querySelector('#playPauseIcon')?.innerHTML || '').includes('M8 5v14'));
    const playing = await waitFor(async () => (await st(s.page)).playing && !(await iconPlay()), 8000);
    R.check(`${tag}.icon-playing`, 'while the receiver plays, the play/pause icon shows playing (synced from status)', !!playing,
      `store.playerPlaying=${(await st(s.page)).playing} iconIsPlay=${await iconPlay()}`);
    await sleep(2500); // the page has seen the position
    const casts0 = s.fake.ops('POST cast').length;
    const idx0 = (await st(s.page)).idx;
    s.fake.state = 'STOPPED'; s.fake.setPos(0); // the Onkyo zeroes the position at STOP
    const stoppedAt = Date.now();
    // at least three status answers on the same cast_seq
    await waitFor(() => s.fake.ops('GET status', stoppedAt).length >= 3, 15000);
    await waitFor(async () => !(await st(s.page)).playing && await iconPlay(), 4000);
    const x = await st(s.page);
    const polls = s.fake.ops('GET status', stoppedAt).length;
    R.check(`${tag}.icon-paused`, `a mid-track STOPPED (${at} s of ${dur} s) turns the icon to paused`, polls >= 3 && !x.playing && await iconPlay(),
      `store.playerPlaying=${x.playing} iconIsPlay=${await iconPlay()} STOPPED polls=${polls}`);
    R.check(`${tag}.nocast`, 'no POST /api/dlna/cast and no queue move', s.fake.ops('POST cast').length === casts0 && x.idx === idx0,
      `POST /cast after stop: ${s.fake.ops('POST cast').length - casts0}, playerIndex ${idx0} → ${x.idx}`);
    R.check(`${tag}.cast-kept`, 'the cast session stays on', !!x.cast && x.castOn, `castDevice=${JSON.stringify(x.cast)} castOn=${x.castOn}`);
    const t = Date.now();
    const where = await pressPlayPause(s.page);
    await waitFor(() => s.fake.ops('POST play', t).length + s.fake.ops('POST pause', t).length > 0, 4000);
    await sleep(2500);
    const y = await st(s.page);
    R.check(`${tag}.resume`, `one tap (${where}) sends exactly one POST /api/dlna/play, no /pause, no /cast`,
      s.fake.ops('POST play', t).length === 1 && s.fake.ops('POST pause', t).length === 0 && s.fake.ops('POST cast', t).length === 0,
      `POST /play=${s.fake.ops('POST play', t).length} /pause=${s.fake.ops('POST pause', t).length} /cast=${s.fake.ops('POST cast', t).length}`);
    R.check(`${tag}.silent`, 'no local deck plays', !y.localPlaying && !x.localPlaying, JSON.stringify(y.decks));
    routingChecks(s, tag);
  } finally { await s.context.close(); }
}

const Q = () => FIX.map(t => ({ ...t }));

// ── Scenarios ──
const scenarios = {
  // 1. A reload while casting must pick the session up from the server.
  async restore(browser, vp) {
    const tag = `${vp}.restore`;
    const q = Q();
    const s = await session(browser, vp, { queue: q, index: 0 });
    try {
      // The server has an active session from before the reload: track 1 of the queue,
      // which the follower started after track 0 (saved current_index is still 0).
      s.fake.advance(1, q[1], 95);
      const reloadAt = Date.now();
      await s.page.reload({ waitUntil: 'load' });
      await s.page.waitForFunction(() => { const l = document.querySelector('#loginScreen'); return l && getComputedStyle(l).display === 'none'; }, null, { timeout: 25000 });
      const restored = await waitFor(async () => { const x = await st(s.page); return x.cast && x.castOn ? x : null; }, 12000);
      const x = restored || await st(s.page);
      R.check(`${tag}.state`, 'after reload the page is in cast state (store.castDevice + cast button lit)',
        !!(x.cast && x.castOn), `castDevice=${JSON.stringify(x.cast)} castOn=${x.castOn}`);
      R.check(`${tag}.device`, 'the restored device is the one the server reports (device_id)', x.cast === DEV.id, `castDevice=${JSON.stringify(x.cast)}`);
      const t0 = Date.now();
      await sleep(6500);
      const polls = s.fake.ops('GET status', t0).length;
      R.check(`${tag}.poll`, 'a status poll runs after the restore (>= 2 GET /status in 6.5 s)', polls >= 2, `GET /status in 6.5 s: ${polls}`);
      const y = await st(s.page);
      R.check(`${tag}.adopt`, 'the track the server is playing is adopted (index + title)', y.idx === 1 && y.title === q[1].name,
        `playerIndex=${y.idx} title="${y.title}" want "${q[1].name}"`);
      R.check(`${tag}.nocast`, 'no POST /api/dlna/cast after the reload', s.fake.ops('POST cast', reloadAt).length === 0,
        `POST /cast=${s.fake.ops('POST cast', reloadAt).length}`);
      R.check(`${tag}.silent`, 'no local deck plays after the restore', !y.localPlaying, JSON.stringify(y.decks));

      // Play/pause: the receiver reports PLAYING, so the first press must pause IT.
      const p0 = Date.now();
      const where = await pressPlayPause(s.page);
      await waitFor(() => s.fake.ops('POST pause', p0).length + s.fake.ops('POST play', p0).length > 0, 4000);
      await sleep(1500);
      const pa = s.fake.ops('POST pause', p0).length, pl = s.fake.ops('POST play', p0).length;
      let z = await st(s.page);
      R.check(`${tag}.toggle`, `play/pause (${where}) goes to the receiver`, pa + pl > 0, `POST /pause=${pa} POST /play=${pl}`);
      R.check(`${tag}.pause-first`, 'the first press on a PLAYING receiver is a pause (icon synced from status)', pa === 1 && pl === 0,
        `POST /pause=${pa} POST /play=${pl}`);
      R.check(`${tag}.nolocal1`, 'no local deck playing after the press', !z.localPlaying, JSON.stringify(z.decks));
      const p1 = Date.now();
      await sleep(2500); // let a poll see PAUSED_PLAYBACK
      await pressPlayPause(s.page);
      await waitFor(() => s.fake.ops('POST pause', p1).length + s.fake.ops('POST play', p1).length > 0, 4000);
      await sleep(1500);
      z = await st(s.page);
      R.check(`${tag}.resume`, 'the second press resumes the receiver (POST /play), no local deck',
        s.fake.ops('POST play', p1).length === 1 && s.fake.ops('POST pause', p1).length === 0 && !z.localPlaying,
        `POST /play=${s.fake.ops('POST play', p1).length} POST /pause=${s.fake.ops('POST pause', p1).length} local=${z.localPlaying}`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 2. The phone page sleeps; the server follower advances the queue meanwhile.
  async sleep(browser, vp) {
    const tag = `${vp}.sleep`;
    const q = Q();
    const s = await session(browser, vp, { queue: q, index: 0 });
    try {
      if (!(await startCasting(s, tag))) return;
      await sleep(4500);
      const casts0 = s.fake.ops('POST cast').length;

      // (a) Status answers stall for 12 s; meanwhile the follower starts queue[1].
      s.fake.hold = true;
      s.fake.advance(1, q[1], 2);
      await sleep(12000);
      const heldN = s.fake.held.length;
      await release(s.fake);
      const a = await waitFor(async () => { const x = await st(s.page); return x.idx === 1 && x.title === q[1].name ? x : null; }, 9000) || await st(s.page);
      R.check(`${tag}.stall-adopt`, 'after a 12 s status stall the page shows the track the server moved to',
        a.idx === 1 && a.title === q[1].name, `playerIndex=${a.idx} title="${a.title}" want "${q[1].name}"`);
      R.check(`${tag}.stall-queued`, 'while one status was held, the page did not pile up more (held <= 1)', heldN <= 1, `held status requests: ${heldN}`);

      // (b) The page is frozen (no script runs, timers stop — a phone with the screen
      // off) for 20 s; the follower moves on to queue[2] meanwhile. The freeze is the
      // JS debugger pausing the page: Page.setWebLifecycleState('frozen') was measured
      // NOT to stop timers in headless Chromium (10 ticks of a 200 ms interval in 2 s).
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Debugger.enable');
      await cdp.send('Debugger.pause');
      await sleep(2500); // the pause takes hold at the next statement, i.e. the next timer
      const frozenAt = Date.now();
      s.fake.advance(2, q[2], 4);
      await sleep(20000);
      const duringFreeze = s.fake.ops('GET status', frozenAt).length;
      await cdp.send('Debugger.resume');
      await cdp.send('Debugger.disable');
      const b = await waitFor(async () => { const x = await st(s.page); return x.idx === 2 && x.title === q[2].name ? x : null; }, 10000) || await st(s.page);
      await sleep(3000);
      R.check(`${tag}.freeze`, 'the page really was frozen (no status requests while frozen)', duringFreeze === 0, `GET /status while frozen: ${duringFreeze}`);
      R.check(`${tag}.wake-adopt`, 'after the page wakes it shows the track the server moved to',
        b.idx === 2 && b.title === q[2].name, `playerIndex=${b.idx} title="${b.title}" want "${q[2].name}"`);
      if (b.full) R.check(`${tag}.wake-fp`, 'the open full player shows it too', b.fpTitle === q[2].name, `fpTitle="${b.fpTitle}"`);
      const extra = s.fake.ops('POST cast').length - casts0;
      R.check(`${tag}.nocast`, 'no POST /api/dlna/cast for a track the server already started', extra === 0,
        `extra POST /cast: ${extra} ${JSON.stringify(s.fake.ops('POST cast').slice(casts0).map(x => x.body && x.body.name))}`);

      // (c) The track ends while the page is awake: the receiver reports STOPPED with the
      // position zeroed (what the Onkyo does), the follower takes a few seconds to start
      // the next one. With `follow: true` the page must leave that to the server.
      const qn = 3 % q.length;
      s.fake.setPos(s.fake.dur - 4);
      await sleep(4500);                      // a poll sees the near-end position
      s.fake.state = 'STOPPED'; s.fake.setPos(0);
      const stoppedAt = Date.now();
      await sleep(7000);
      const ownAdvance = s.fake.ops('POST cast', stoppedAt).length;
      s.fake.advance(qn, q[qn], 1);
      const c = await waitFor(async () => { const x = await st(s.page); return x.idx === qn && x.title === q[qn].name ? x : null; }, 8000) || await st(s.page);
      R.check(`${tag}.end-left-to-server`, 'a STOPPED receiver at the end of a track does not make the page cast the next one itself (follow: true)',
        ownAdvance === 0, `POST /cast while the server was between tracks: ${ownAdvance} ${JSON.stringify(s.fake.ops('POST cast', stoppedAt).map(x => x.body && x.body.name))}`);
      R.check(`${tag}.end-adopt`, 'the track the server then starts is shown', c.idx === qn && c.title === q[qn].name,
        `playerIndex=${c.idx} title="${c.title}" want "${q[qn].name}"`);
      R.check(`${tag}.single-flight`, 'never more than one status request in flight', s.fake.maxInflight <= 1, `max in flight: ${s.fake.maxInflight}`);
      R.check(`${tag}.cast-kept`, 'the cast session is still on after the stall, the freeze and the track change', !!c.cast && c.castOn,
        `castDevice=${JSON.stringify(c.cast)} castOn=${c.castOn}`);
      R.check(`${tag}.silent`, 'no local deck plays', !b.localPlaying && !c.localPlaying, JSON.stringify(c.decks));
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 3. Seek on a 2 h mix: the duration comes from the receiver, not from the local deck.
  async seek(browser, vp) {
    const tag = `${vp}.seek`;
    const q = Q();
    q[0] = { ...q[0], duration_ms: 0 }; // like a mix or a clip item: no duration in the queue
    const s = await session(browser, vp, { queue: q, index: 0 });
    try {
      s.fake.durOverride = 7200;
      if (!(await startCasting(s, tag))) return;
      s.fake.setPos(600);
      await sleep(5000);
      const x0 = await st(s.page);
      R.check(`${tag}.precond`, 'no local deck is playing the cast track', !x0.localPlaying, JSON.stringify(x0.decks));

      if (!x0.full && await visible(s.page, '#playerProgressBar')) {
        const t = Date.now();
        await hitBar(s, '#playerProgressBar', 0.5);
        await waitFor(() => s.fake.ops('POST seek', t).length > 0, 4000);
        const sk = s.fake.ops('POST seek', t);
        const pos = sk[0] && sk[0].body && sk[0].body.position_seconds;
        R.check(`${tag}.bar`, '50 % on the bar progress seeks the receiver to ~3600 s', sk.length === 1 && Math.abs(pos - 3600) <= 120,
          `POST /seek=${sk.length} position_seconds=${pos}`);
      } else {
        R.skip(`${tag}.bar`, '50 % on the bar progress seeks the receiver to ~3600 s', 'the bar has no progress bar at this width');
      }
      await openFull(s.page);
      await sleep(2500); // a poll fills the full player
      const t = Date.now();
      await hitBar(s, '#fpProgressBar', 0.5);
      await waitFor(() => s.fake.ops('POST seek', t).length > 0, 4000);
      const sk = s.fake.ops('POST seek', t);
      const pos = sk[0] && sk[0].body && sk[0].body.position_seconds;
      R.check(`${tag}.full`, '50 % on the full-player progress seeks the receiver to ~3600 s', sk.length === 1 && Math.abs(pos - 3600) <= 120,
        `POST /seek=${sk.length} position_seconds=${pos}`);
      await sleep(2500);
      const tot = await s.page.evaluate(() => document.querySelector('#fpTimeTotal')?.textContent || '');
      R.check(`${tag}.total`, 'the full player shows the receiver\'s 2 h length', /^2:00:00$|^120:00$/.test(tot.trim()), `#fpTimeTotal="${tot}"`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 4. Casting a track that plays locally continues where it was.
  async handover(browser, vp) {
    const tag = `${vp}.handover`;
    const q = Q();
    const s = await session(browser, vp, { queue: q, index: 0 });
    try {
      await s.page.evaluate(async () => { const { store, eng } = await window.__mods(); store.playerIndex = 0; eng.loadAndPlay(); });
      const playing = await waitFor(async () => (await st(s.page)).decks.some(d => !d.paused && d.t > 0.5), 60000, 500);
      if (!playing) { R.check(`${tag}.setup`, 'the fixture track plays locally', false, JSON.stringify((await st(s.page)).decks)); return; }
      await s.page.evaluate(() => { const a = [...document.querySelectorAll('audio')].find(x => !x.paused); a.currentTime = 45; });
      let at = await waitFor(async () => (await st(s.page)).decks.some(d => !d.paused && d.t >= 44.5), 20000, 500);
      if (!at) at = await waitFor(async () => (await st(s.page)).decks.some(d => !d.paused && d.t >= 8), 15000, 500);
      R.check(`${tag}.setup`, 'the fixture track plays locally, well past its start', !!at, JSON.stringify((await st(s.page)).decks));
      if (!at) return;
      if (!(await visible(s.page, '#playerCastBtn'))) await openFull(s.page);
      const n = await s.page.evaluate(() => Math.max(...[...document.querySelectorAll('audio')].filter(a => !a.paused).map(a => a.currentTime)));
      const how = await pressCast(s.page);
      await waitFor(() => s.fake.ops('POST cast').length > 0, 8000);
      const c = s.fake.ops('POST cast')[0];
      const ss = c && c.body ? c.body.start_seconds : undefined;
      R.check(`${tag}.start`, `POST /cast (${how}) carries start_seconds ≈ the local position`, c && typeof ss === 'number' && Math.abs(ss - n) <= 4 && ss > 1,
        `local=${n.toFixed(1)} start_seconds=${ss}`);
      R.check(`${tag}.index`, 'POST /cast names the queue position (queue_index)', c && c.body && c.body.queue_index === 0, `queue_index=${c && c.body && c.body.queue_index}`);
      await sleep(2500);
      const y = await st(s.page);
      R.check(`${tag}.paused`, 'both local decks are paused once casting', !y.localPlaying && !!y.cast, `cast=${JSON.stringify(y.cast)} decks=${JSON.stringify(y.decks)}`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 6. The receiver stops in the middle of a track (input switched, stopped on its own
  // remote) while the server follows and the queue has not ended. That is not the end of
  // the track: the page must not cast anything or move the queue, the icon goes to
  // paused (after two STOPPED answers on the same cast_seq), and one tap resumes the
  // receiver. `midstop`: 70 s into a 300 s track. `midstopmix`: ~3300 s into a 3600 s
  // mix — past 85 %, which the old end detector counted as "near the end".
  midstop: (browser, vp) => midstopRun(browser, vp, 'midstop', 300, 70),
  midstopmix: (browser, vp) => midstopRun(browser, vp, 'midstopmix', 3600, 3300),

  // 7. A cast superseded by a later one (or a stop): POST /cast answers 409 with cause
  // "superseded". That is not a failure the user has to hear about, and it must not
  // fall back to local playback.
  async superseded(browser, vp) {
    const tag = `${vp}.superseded`;
    const q = Q();
    const s = await session(browser, vp, { queue: q, index: 0 });
    const reply409 = { status: 409, body: { detail: { message: 'superseded', superseded: true, cause: 'superseded' } } };
    const failedToast = (x) => x.toasts.filter(t => /cast failed/i.test(t));
    try {
      // (a) the very first cast from the button
      s.fake.castReply = reply409;
      const how = await pressCast(s.page);
      await waitFor(() => s.fake.ops('POST cast').length > 0, 8000);
      await sleep(4000);
      let x = await st(s.page);
      R.check(`${tag}.first-toast`, `a superseded first cast (${how}) shows no "Cast failed" toast`, s.fake.ops('POST cast').length === 1 && failedToast(x).length === 0,
        `POST /cast=${s.fake.ops('POST cast').length} toasts=${JSON.stringify(x.toasts.slice(-3))}`);
      R.check(`${tag}.first-silent`, 'no local deck plays', !x.localPlaying, JSON.stringify(x.decks));
      // (b) a track change while casting. The superseding cast of (a) came from somewhere
      // else: if the page still holds the session, the receiver plays track 0 for it;
      // otherwise start a normal cast.
      s.fake.castReply = null;
      x = await st(s.page);
      if (x.cast) s.fake.play({ queue_index: 0, name: q[0].name, artist: q[0].artist, album: q[0].album, image: q[0].image, duration_ms: q[0].duration_ms, by: 'client' }, 5);
      else if (!(await startCasting(s, tag))) return;
      await sleep(4500);
      const t = Date.now();
      const n0 = x.toasts.length;
      s.fake.castReply = reply409;
      const where = await pressNext(s.page);
      await waitFor(() => s.fake.ops('POST cast', t).length > 0, 10000);
      await sleep(4000);
      x = await st(s.page);
      R.check(`${tag}.next-sent`, `Next (${where}) while casting goes to the receiver as a cast`, s.fake.ops('POST cast', t).length >= 1,
        `POST /cast after Next: ${s.fake.ops('POST cast', t).length}`);
      R.check(`${tag}.next-toast`, 'a superseded cast on Next shows no "Cast failed" toast', failedToast({ toasts: x.toasts.slice(n0) }).length === 0,
        `toasts=${JSON.stringify(x.toasts.slice(n0))}`);
      R.check(`${tag}.next-silent`, 'no local deck plays after it', !x.localPlaying, JSON.stringify(x.decks));
      R.check(`${tag}.next-kept`, 'the cast session stays on', !!x.cast && x.castOn, `castDevice=${JSON.stringify(x.cast)} castOn=${x.castOn}`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 5. The server gave up on the receiver.
  async abandoned(browser, vp) {
    const tag = `${vp}.abandoned`;
    const q = Q();
    const s = await session(browser, vp, { queue: q, index: 0 });
    try {
      if (!(await startCasting(s, tag))) return;
      await sleep(4500);
      const msg = 'E2E Fake Receiver neodpovídá — přehrávání ukončeno';
      s.fake.abandon(msg);
      const gone = await waitFor(async () => { const x = await st(s.page); return !x.cast ? x : null; }, 9000) || await st(s.page);
      await sleep(800);
      const x = await st(s.page);
      R.check(`${tag}.toast`, 'the abandoned message is shown as a toast', x.toasts.some(t => t.includes(msg)), `toasts=${JSON.stringify(x.toasts.slice(-3))}`);
      R.check(`${tag}.off`, 'cast state is off (store.castDevice null, button not lit)', !gone.cast && !x.castOn, `castDevice=${JSON.stringify(x.cast)} castOn=${x.castOn}`);
      const t = Date.now();
      await sleep(4500);
      R.check(`${tag}.poll-stops`, 'the status poll stops after the session ended', s.fake.ops('GET status', t).length === 0,
        `GET /status in the next 4.5 s: ${s.fake.ops('GET status', t).length}`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },

  // 6. The queue runs out while casting: the recommender's picks continue it, and it is
  // the SERVER that plays them (the page may be frozen).
  async autoplay(browser, vp) {
    const tag = `${vp}.autoplay`;
    const q = Q();
    const last = q.length - 1;
    const s = await session(browser, vp, { queue: q, index: last });
    try {
      // Fake picks: never streamed (the receiver is a fake, local decks stay paused).
      const RECS = [1, 2, 3].map(n => ({ name: `zz-e2e autoplay ${n}`, artist: 'zz-e2e reco', album: '', image: '', duration_ms: 200000 + n, type: 'track' }));
      let recReqs = 0;
      await s.page.route('**/api/player/recommendations**', (r) => {
        recReqs++;
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tracks: RECS }) });
      });
      const qstate = () => s.page.evaluate(async () => {
        const { store } = await window.__mods();
        const src = [...document.scripts].map(x => x.src).find(x => /\/app\.js/.test(x)) || '';
        const v = src.includes('?v=') ? '?v=' + src.split('?v=')[1] : '';
        const Qm = await import(`/static/js/queue.js${v}`);
        if (!window.__q0) window.__q0 = store.playerQueue;
        return { names: store.playerQueue.map(x => x.name), idx: store.playerIndex, sameArray: store.playerQueue === window.__q0,
          autoAt: typeof Qm.autoplayStart === 'function' ? Qm.autoplayStart() : null,
          seps: document.querySelectorAll('.qi-autoplay-sep').length };
      });
      await qstate(); // remember the queue array before anything is appended
      if (!(await startCasting(s, tag))) return;
      const withList = () => s.fake.log.filter(l => (l.op === 'POST cast' || l.op === 'POST next-hint') && l.body && Array.isArray(l.body.autoplay));
      await waitFor(() => withList().length > 0, 15000);
      const sent = withList()[0];
      R.check(`${tag}.handed-over`, 'on the last row the page hands the recommender\'s picks to the server (autoplay in cast / next-hint)',
        !!sent && sent.body.queue_index === last && sent.body.next == null
        && JSON.stringify(sent.body.autoplay.map(x => x.name)) === JSON.stringify(RECS.map(x => x.name)),
        sent ? `${sent.op} queue_index=${sent.body.queue_index} next=${JSON.stringify(sent.body.next)} autoplay=${JSON.stringify(sent.body.autoplay.map(x => x.name))}` : 'no request carried `autoplay`');
      const recs0 = recReqs, lists0 = withList().length;
      await sleep(9000); // four more polls
      const a = await qstate();
      R.check(`${tag}.peek-only`, 'handing the picks over consumes nothing: the queue is unchanged, the list is not sent or loaded again',
        a.names.length === q.length && a.idx === last && withList().length === lists0 && recReqs === recs0 && a.autoAt === -1,
        `queue=${a.names.length} idx=${a.idx} lists sent=${withList().length}/${lists0} rec loads=${recReqs}/${recs0} autoplayStart=${a.autoAt}`);

      // (a) Awake: the track ends; the server appends pick 1 to the saved queue and casts it.
      const row = (r) => ({ name: r.name, artist: r.artist, album: r.album, image: r.image, duration_ms: r.duration_ms });
      const serverAppends = (r, pos = 2) => {
        s.saved.queue = [...s.saved.queue, row(r)];
        s.saved.current_index = s.saved.queue.length - 1;
        s.fake.play({ queue_index: s.saved.current_index, ...row(r), by: 'server', autoplay: true }, pos);
      };
      const casts0 = s.fake.ops('POST cast').length;
      s.fake.state = 'STOPPED'; s.fake.setPos(0);
      const endedAt = Date.now();
      await sleep(6000);
      const own = s.fake.ops('POST cast', endedAt).length;
      const mid = await qstate();
      R.check(`${tag}.end-left-to-server`, 'at the end of the last row an awake page appends and casts nothing itself',
        own === 0 && mid.names.length === q.length, `POST /cast=${own} queue rows=${mid.names.length}`);
      serverAppends(RECS[0]);
      const b = await waitFor(async () => { const x = await qstate(); return x.idx === last + 1 ? x : null; }, 10000) || await qstate();
      const z = await st(s.page);
      R.check(`${tag}.adopt`, 'the appended row is pushed into the page\'s queue and shown as the current track',
        b.idx === last + 1 && b.names.length === q.length + 1 && b.names[last + 1] === RECS[0].name && z.title === RECS[0].name,
        `idx=${b.idx} rows=${b.names.length} last="${b.names[b.names.length - 1]}" title="${z.title}"`);
      R.check(`${tag}.same-array`, 'store.playerQueue is still the same array (push, not replace)', b.sameArray, `sameArray=${b.sameArray}`);
      R.check(`${tag}.divider`, 'the "Autoplay" divider starts at the first appended row', b.autoAt === last + 1,
        `autoplayStart=${b.autoAt} want ${last + 1}; dividers drawn=${b.seps}`);
      await sleep(5000);
      const hints = s.fake.ops('POST next-hint').filter(l => l.body && l.body.queue_index === last + 1);
      const h = hints[hints.length - 1];
      R.check(`${tag}.next-list`, 'the page then hands over what follows — without the pick just played',
        !!h && Array.isArray(h.body.autoplay) && JSON.stringify(h.body.autoplay.map(x => x.name)) === JSON.stringify(RECS.slice(1).map(x => x.name)),
        h ? `autoplay=${JSON.stringify((h.body.autoplay || []).map(x => x.name))}` : 'no next-hint for the adopted row');

      // (b) Frozen (the phone's screen is off): the server plays picks 2 and 3 meanwhile.
      // A queue save sits in its 2 s debounce when the page freezes: fired on wake as it
      // is, it would write the queue from BEFORE the sleep over the server's rows.
      const cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Debugger.enable');
      await s.page.evaluate(async () => { (await window.__mods()).eng.saveQueueDebounced(); });
      await cdp.send('Debugger.pause');
      await sleep(2500);
      const frozenAt = Date.now();
      serverAppends(RECS[1]);
      await sleep(6000);
      serverAppends(RECS[2], 5);
      await sleep(6000);
      const duringFreeze = s.fake.ops('GET status', frozenAt).length;
      await cdp.send('Debugger.resume');
      await cdp.send('Debugger.disable');
      const c = await waitFor(async () => { const x = await qstate(); return x.idx === last + 3 ? x : null; }, 12000) || await qstate();
      await sleep(3000);
      const y = await st(s.page);
      R.check(`${tag}.freeze`, 'the page really was frozen (no status requests while frozen)', duringFreeze === 0, `GET /status while frozen: ${duringFreeze}`);
      R.check(`${tag}.wake-adopt`, 'after waking, both rows the server appended are in the queue and the playing one is current',
        c.idx === last + 3 && JSON.stringify(c.names.slice(last + 1)) === JSON.stringify(RECS.map(x => x.name)) && y.title === RECS[2].name && c.sameArray,
        `idx=${c.idx} tail=${JSON.stringify(c.names.slice(last + 1))} title="${y.title}" sameArray=${c.sameArray}`);
      R.check(`${tag}.divider-kept`, 'the divider stays at the first autoplay row', c.autoAt === last + 1, `autoplayStart=${c.autoAt}`);
      const extra = s.fake.ops('POST cast').length - casts0;
      R.check(`${tag}.nocast`, 'no POST /api/dlna/cast from the page for anything the server appended', extra === 0,
        `extra POST /cast: ${extra} ${JSON.stringify(s.fake.ops('POST cast').slice(casts0).map(x => x.body && x.body.name))}`);
      R.check(`${tag}.nolocal`, 'no local deck plays, the cast is still on', !y.localPlaying && !!y.cast, `local=${y.localPlaying} cast=${JSON.stringify(y.cast)}`);
      R.check(`${tag}.saved`, 'the save that was pending when the page froze did not erase the server\'s rows: the saved queue holds all of them',
        Array.isArray(s.saved.queue) && JSON.stringify(s.saved.queue.slice(last + 1).map(x => x.name)) === JSON.stringify(RECS.map(x => x.name)),
        `saved tail=${JSON.stringify((s.saved.queue || []).slice(last + 1).map(x => x.name))}`);
      routingChecks(s, tag);
    } finally { await s.context.close(); }
  },
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const vp of VPS) {
    if (!VIEWPORTS[vp]) throw new Error('unknown viewport ' + vp);
    for (const name of SCEN) {
      if (!scenarios[name]) throw new Error('unknown scenario ' + name);
      console.log(`\n── ${vp} · ${name}`);
      try { await scenarios[name](browser, vp); }
      catch (e) { R.check(`${vp}.${name}.run`, 'scenario ran to the end', false, String(e && e.message || e).split('\n')[0]); }
    }
  }
} finally { await browser.close(); }

process.exit(R.done() ? 0 : 1);
