// DJ desk + headphone cue (batch dj-pult): acceptance in a real Chromium.
//
// What is measured, and how:
//  - Sound is measured with AnalyserNodes, never with element state alone. cuebus.js
//    `_debugTaps()` gives the master (after the limiter), the cue bus (after the cue
//    volume) and each deck AFTER its crossfade gain (post.A / post.B). This script adds
//    one analyser per deck BEFORE the crossfade gain (on `levelGain`): an extra branch
//    that only listens, so the cue level can be read relative to the music that feeds it
//    (music is not stationary; a raw RMS ratio between two windows says little).
//  - "Master is unchanged by the cue" is measured as how much of the master signal the
//    LIVE deck alone explains (r², best lag; the limiter delays by ~6 ms). A lent deck
//    that leaks into the master by ANY path lowers it — not only through its own
//    crossfade gain.
//  - Audio-graph edges are OBSERVED by wrapping AudioNode.connect/disconnect before the
//    app loads (they call the originals). That is how "master → destination restored"
//    is read after the desk closes; nothing in the engine is replaced.
//
// Oracle: production, account claude_test. Without --tree the page runs the DEPLOYED
// code, which has no desk: every scenario must fail there. With --tree the page gets
// the real files of a working tree (helpers.serveWorktree, the live cache-bust stamp →
// the app's own module instances; modules are imported here under exactly the URLs the
// app uses, never under another one).
//
//   node tests/e2e/audit/dj_desk.mjs [--tree[=/path]] [cue manual viewports cast]
//   MS_TREE=/path overrides the served tree (default: the tree this file lives in).
//
// Chromium runs with --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream:
// it lists "Fake Audio Output 1/2", so the 'devices' mode builds its real second output
// path. Fake devices cannot prove two physical outputs or their latency (see the end).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, makeReport, URL as BASE, USER, PASS, VIEWPORTS, SHOT_DIR } from './helpers.mjs';

const { chromium } = pw;
const HERE_TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const treeArg = process.argv.find(a => a === '--tree' || a.startsWith('--tree='));
const TREE = treeArg ? (treeArg.includes('=') ? treeArg.slice(7) : (process.env.MS_TREE || HERE_TREE)) : null;
const want = process.argv.slice(2).filter(a => !a.startsWith('--'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const R = makeReport('dj_desk');
const check = (id, ok, detail) => R.check(id, '', ok, typeof detail === 'string' ? detail : JSON.stringify(detail));
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── owned, analysed tracks from the server's BPM cache; local files first ──
async function api(p, body, tok) {
  const h = { 'User-Agent': 'ms-review/1.0', 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const tok = (await api('/api/auth/login', { username: USER, password: PASS })).token;
let lib = await api('/api/bpm/cache', null, tok);
lib = (Array.isArray(lib) ? lib : Object.values(lib.tracks || lib))
  .filter(t => t && t.name && t.artist && t.bpm && t.confidence >= 0.5 && !/[&<>"']/.test(t.name + t.artist));
async function pickTracks(n) {
  const out = [], seen = new Set();
  for (const t of lib) {
    if (out.length >= n) break;
    if (seen.has(t.artist)) continue;
    const q = new URLSearchParams({ name: t.name, artist: t.artist });
    const src = await api(`/api/player/resolve-source?${q}`, null, tok).catch(() => ({}));
    if (src.source !== 'local') continue;               // a library file: loads fast, has a length
    seen.add(t.artist);
    out.push({ name: t.name, artist: t.artist, type: 'track' });
  }
  if (out.length < n) throw new Error(`only ${out.length} local tracks found`);
  return out;
}
const TRACKS = await pickTracks(7);
console.log(`# ${TREE ? 'working tree ' + TREE : 'DEPLOYED'} against ${BASE}`);
console.log('# tracks: ' + TRACKS.map(t => `${t.artist} – ${t.name}`).join(' | '));

// ── a logged-in page with the DJ engine and fake audio devices ──
async function session(vpName = 'desktop', extraInit = {}) {
  const vp = VIEWPORTS[vpName];
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
  });
  await context.grantPermissions(['microphone'], { origin: BASE }); // Chromium shows output labels/ids with it
  if (TREE) await serveWorktree(context, TREE);
  // No test may start a YouTube lookup or let the recommender queue tracks of its own.
  await context.route('**/api/player/recommendations**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"recommendations":[],"tracks":[]}' }));
  await context.route('**/api/radio**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"tracks":[]}' }));
  const page = await context.newPage();
  const settings = { ms_device_id: 'e2e-djdesk', ms_player_engine: 'dj', ms_dj_debug: '1', ms_dj_smart_queue: 'off', ms_cue_mode: 'split', ...extraInit };
  await page.addInitScript((s) => {
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    // Observe the audio graph's edges (originals are called; nothing is replaced).
    const ids = new WeakMap(); let n = 0;
    const id = (x) => { if (!ids.has(x)) ids.set(x, ++n); return ids.get(x); };
    const edges = new Set();
    window.__nodeId = id; window.__edges = edges;
    const P = AudioNode.prototype, oc = P.connect, od = P.disconnect;
    P.connect = function (dst, ...r) {
      const out = oc.call(this, dst, ...r);
      if (dst instanceof AudioNode) edges.add(id(this) + '>' + id(dst));
      return out;
    };
    P.disconnect = function (...a) {
      const out = od.apply(this, a);
      const d = a[0];
      if (d instanceof AudioNode) edges.delete(id(this) + '>' + id(d));
      else if (!a.length || typeof d === 'number') { const pre = id(this) + '>'; for (const k of [...edges]) if (k.startsWith(pre)) edges.delete(k); }
      return out;
    };
  }, settings);
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[DJ')) logs.push(t); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#loginUser', { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => { const l = document.querySelector('#loginScreen'); return l && getComputedStyle(l).display === 'none'; }, null, { timeout: 25000 });
  await page.waitForTimeout(1500);
  // A real gesture for the AudioContext; a tap on touch devices so no mouse hovers anything.
  if (vp.hasTouch) await page.touchscreen.tap(vp.width / 2, 10); else await page.mouse.click(vp.width / 2, 10);
  return { browser, context, page, logs, errors, vp, vpName };
}

/** Load the modules under the app's own URLs, start the queue, install the probes. */
async function start(page, tracks) {
  await page.evaluate(async (tracks) => {
    const v = [...document.scripts].map(s => s.src).find(s => /app\.js\?v=/.test(s)).split('?v=')[1];
    const imp = (f) => import(`/static/js/${f}.js?v=${v}`);
    const { store } = await imp('store');
    const eng = await (await imp('player_active')).getPlayerModule();
    window.__m = { store, eng, bpm: await imp('bpm'), prefetch: await imp('prefetch'), queue: await imp('queue') };
    // The feature under test: on the deployed code these do not exist and this throws.
    window.__m.cue = await imp('cuebus');
    window.__m.desk = await imp('djdesk');
    if (typeof eng.deskInfo !== 'function') throw new Error('engine has no desk API (deskInfo)');
    store.playlistMode = null; store.radioMode = false; store.repeatMode = 'off'; store.shuffleEnabled = false;
    window.__m.queue.resetShuffleOrder();
    store.playerQueue = tracks; store.playerIndex = 0;
    await Promise.all(tracks.map(t => window.__m.bpm.fetchTrackBpm(t.name, t.artist).catch(() => null)));
    eng.loadAndPlay();

    // ── probes ──
    const rmsOf = (d) => { let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); };
    const buf = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); return d; };
    // Leak of the lent deck into the master, independent of how loud either track is:
    // fit master ≈ a·live(t−L) at the best lag L (the limiter looks ahead ~6 ms; a render
    // quantum may pass between two reads), then regress what is left on the lent deck's
    // own PRE-fader signal at the same lag. b ≈ 0: nothing of it in the master; b ≈ 1:
    // the lent deck is in the master at full level, by whatever path.
    const leakOf = (m, p, q) => {
      const N = m.length; let best = -1, bestL = 0, bestA = 0;
      for (let L = -384; L <= 768; L++) {
        let mp = 0, pp = 0, mm = 0;
        const i0 = Math.max(0, L), i1 = Math.min(N, N + L);
        for (let i = i0; i < i1; i++) { const x = p[i - L], y = m[i]; mp += y * x; pp += x * x; mm += y * y; }
        if (pp > 1e-9 && mm > 1e-9) { const r2 = (mp * mp) / (pp * mm); if (r2 > best) { best = r2; bestL = L; bestA = mp / pp; } }
      }
      if (best < 0 || !q) return { r2: best < 0 ? null : best, b: null };
      let eq = 0, qq = 0;
      const i0 = Math.max(0, bestL), i1 = Math.min(N, N + bestL);
      for (let i = i0; i < i1; i++) { const x = q[i - bestL]; eq += (m[i] - bestA * p[i - bestL]) * x; qq += x * x; }
      return { r2: best, b: qq > 1e-6 ? eq / qq : null };
    };
    window.__pre = null;
    window.__probe = async (ms = 1500, explainKey = null, lentKey = null) => {
      const cue = window.__m.cue, g = window.__m.eng.deskGraph();
      const t = cue._debugTaps();
      if (!t) throw new Error('_debugTaps() returned null');
      if (!window.__pre || window.__pre.g !== g) {
        const mk = () => { const a = g.ctx.createAnalyser(); a.fftSize = 2048; return a; };
        window.__pre = { g, A: mk(), B: mk() };
        g.nodes.A.levelGain.connect(window.__pre.A);
        g.nodes.B.levelGain.connect(window.__pre.B);
      }
      const pre = window.__pre;
      const acc = { master: 0, cue: 0, postA: 0, postB: 0, preA: 0, preB: 0 }, r2s = [], rel = [], leaks = [];
      let n = 0, k = 0;
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const tt = cue._debugTaps();                 // the cue tap exists only while routed
        const pA = buf(t.post.A), pB = buf(t.post.B), m = buf(t.master);
        acc.master += rmsOf(m); acc.postA += rmsOf(pA); acc.postB += rmsOf(pB);
        const qA = buf(pre.A), qB = buf(pre.B), c = tt && tt.cue ? buf(tt.cue) : null;
        acc.preA += rmsOf(qA); acc.preB += rmsOf(qB);
        acc.cue += c ? rmsOf(c) : 0;
        // cue level relative to the lent deck that feeds it, in the SAME snapshot
        if (lentKey && c) { const src = rmsOf(lentKey === 'A' ? qA : qB); if (src > 0.003) rel.push(rmsOf(c) / src); }
        if (explainKey && (k++ % 3 === 0) && rmsOf(m) > 0.005) {
          const other = explainKey === 'A' ? qB : qA;
          const r = leakOf(m, explainKey === 'A' ? pA : pB, rmsOf(other) > 0.003 ? other : null);
          if (r.r2 != null) r2s.push(r.r2);
          if (r.b != null) leaks.push(Math.abs(r.b));
        }
        n++;
        await new Promise(r => setTimeout(r, 40));
      }
      for (const key in acc) acc[key] = +(acc[key] / n).toFixed(5);
      r2s.sort((a, b) => a - b);
      acc.r2 = r2s.length ? +r2s[Math.floor(r2s.length / 2)].toFixed(3) : null;
      leaks.sort((a, b) => a - b);
      acc.leak = leaks.length ? +leaks[Math.floor(leaks.length / 2)].toFixed(4) : null;
      rel.sort((a, b) => a - b);
      acc.rel = rel.length ? +rel[Math.floor(rel.length / 2)].toFixed(4) : null;
      return acc;
    };
    window.__state = () => {
      const i = window.__m.eng.deskInfo(), g = window.__m.eng.deskGraph();
      const el = g.els[i.active], d = g.ctx.destination;
      return {
        active: i.active, index: i.index, loan: i.loan, manual: i.manual, mixing: i.mixing, crossfading: i.crossfading, next: i.next,
        items: { A: i.items.A && i.items.A.name, B: i.items.B && i.items.B.name },
        t: el.currentTime, rate: el.playbackRate, vol: el.volume, paused: el.paused, src: String(el.src).slice(-60),
        volA: g.els.A.volume, volB: g.els.B.volume,
        dest: { c: d.channelCount, m: d.channelCountMode, i: d.channelInterpretation },
        masterToDest: window.__edges.has(window.__nodeId(g.master) + '>' + window.__nodeId(d)),
        route: window.__m.cue.cueStatus ? window.__m.cue.cueStatus() : null,
        deskOpen: !!window.__m.store.deskOpen, title: document.querySelector('#playerTitle')?.textContent,
      };
    };
  }, tracks);
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > 0.5), null, { timeout: 60000 });
  // The saved queue state restores the device's last volume; every scenario starts at full.
  await slide(page, '#playerVolume', 100);
  await page.waitForFunction(() => [...document.querySelectorAll('audio')].every(a => a.volume === 1), null, { timeout: 3000 });
}

const st = (page) => page.evaluate(() => window.__state());
const probe = (page, ms, key, lent = null) => page.evaluate(([ms, key, lent]) => window.__probe(ms, key, lent), [ms, key, lent]);
const cueSet = (page, patch) => page.evaluate((p) => window.__m.cue.setCueSettings(p), patch);
const slide = (page, sel, v) => page.evaluate(([s, v]) => { const el = document.querySelector(s); el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, v]);
const lentPlaying = (page, ms = 30000) => page.waitForFunction(() => {
  const i = window.__m.eng.deskInfo(), g = window.__m.eng.deskGraph();
  return i.loan && i.items[i.loan] && !g.els[i.loan].paused && g.els[i.loan].currentTime > 0.5;
}, null, { timeout: ms });

async function openDeskUi(page) {
  await page.evaluate(() => { if (!window.__m.store.fullPlayerOpen) document.querySelector('#playerImg').click(); });
  await page.waitForFunction(() => window.__m.store.fullPlayerOpen, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const b = document.querySelector('#fpDeskBtn');
    if (!b || getComputedStyle(b).display === 'none') throw new Error('#fpDeskBtn is not shown in the full player');
    b.click();
  });
  await page.waitForFunction(() => window.__m.store.deskOpen === true, null, { timeout: 8000 });
  await page.waitForTimeout(1200);
}
async function closeDeskUi(page) {
  await page.click('#ddClose');
  await page.waitForFunction(() => !window.__m.store.deskOpen, null, { timeout: 5000 });
  await page.waitForTimeout(600);
}
async function clickRow(page, qi, act) {
  const b = page.locator(`#ddQueue .dd-row[data-qi="${qi}"] button[data-act="${act}"]`);
  await b.scrollIntoViewIfNeeded();
  await b.click();
}

// ── 1 + 2: cue isolation and the two faders ──
// One cue measurement: master deck keeps playing, the cue bus carries the LENT deck only.
async function isolation(s, tag, startCue, pauseCue) {
  const { page } = s;
  await cueSet(page, { mix: 0, volume: 1, pfl: { A: false, B: false } });
  await page.evaluate(() => window.__m.cue.cueGraph());
  const m0 = await st(page);
  const base = await probe(page, 1500, m0.active);
  await startCue();
  await lentPlaying(page);
  await sleep(800);
  const m1 = await st(page);
  const w0 = Date.now();
  const lv = await probe(page, 2500, m1.active);
  const m2 = await st(page);
  const wall = (Date.now() - w0) / 1000;
  const lent = m1.loan;
  const post = lent === 'A' ? lv.postA : lv.postB;
  check(`${tag}: the lent deck is not the master deck`, lent && lent !== m1.active && m1.active === m0.active, { before: m0.active, active: m1.active, loan: lent });
  check(`${tag}: cue bus carries signal`, lv.cue > 0.01, `cue RMS ${lv.cue}`);
  check(`${tag}: lent deck silent after its crossfade gain`, post < 1e-4, `post.${lent} RMS ${post} (its pre-fader RMS ${lent === 'A' ? lv.preA : lv.preB})`);
  check(`${tag}: nothing of the lent deck in the master`, lv.leak != null && lv.leak < 0.05,
    `leak coefficient ${lv.leak} (0 = isolated, 1 = full level; live deck explains r² ${lv.r2} of the master, ${base.r2} before the cue)`);
  const ratio = lv.master / base.master;
  check(`${tag}: master level does not jump`, ratio > 0.5 && ratio < 2, `master RMS ${base.master} → ${lv.master} (×${ratio.toFixed(2)})`);
  const adv = (m2.t - m1.t) / m1.rate;
  check(`${tag}: master deck plays on (same deck, same source, same volume, real-time position)`,
    !m2.paused && m2.active === m0.active && m2.src === m0.src && m2.vol === m0.vol && Math.abs(adv - wall) < 0.6,
    `${adv.toFixed(2)} s in ${wall.toFixed(2)} s, vol ${m0.vol}→${m2.vol}, active ${m0.active}→${m2.active}`);
  // The cue IS the lent deck: pausing it silences the bus, the master does not notice.
  await pauseCue();
  await sleep(500);
  const pz = await probe(page, 1200, m1.active);
  const pzLent = await page.evaluate((k) => window.__m.eng.deskGraph().els[k].paused, lent);
  check(`${tag}: pausing the cue silences the cue bus, master unchanged`,
    pzLent && pz.cue < 1e-3 && pz.master > 0.01 && pz.master / lv.master > 0.5 && pz.master / lv.master < 2,
    `cue ${lv.cue} → ${pz.cue}, master ${lv.master} → ${pz.master}, lent paused ${pzLent}`);
  return { lent, active: m1.active };
}

/** Master fader moves the master only; the cue level (relative to its source) stays. */
async function masterFader(s, tag, lent, sel) {
  const { page } = s;
  const a = await probe(page, 1500, null, lent);
  await slide(page, sel, 30);
  await sleep(300);
  const b = await probe(page, 1500, null, lent);
  const v = await st(page);
  const lentVol = await page.evaluate((k) => window.__m.eng.deskGraph().els[k].volume, lent);
  await slide(page, sel, 100);
  const cueRel = b.rel / a.rel;
  const mRatio = b.master / a.master;
  check(`${tag}: master fader 100→30 lowers the master`, mRatio < 0.6 && Math.abs(v.vol - 0.3) < 0.01, `master ×${mRatio.toFixed(2)}, live el.volume ${v.vol}`);
  check(`${tag}: master fader leaves the cue deck alone`, lentVol === 1 && cueRel > 0.95 && cueRel < 1.05,
    `lent el.volume ${lentVol}, cue/source ${a.rel}→${b.rel} (×${cueRel.toFixed(3)}; raw cue RMS ${a.cue}→${b.cue})`);
}

const scenarios = {
  // 1 + 2. Both entry points, both modes that fake devices can run.
  async cue() {
    const s = await session('desktop');
    try {
      await start(s.page, TRACKS);
      const { page } = s;
      // (a) split, from the queue row's headphones button (desk closed).
      await cueSet(page, { mode: 'split', deviceId: '', deviceLabel: '' });
      await page.click('#playerQueueBtn');
      await page.waitForFunction(() => window.__m.store.queuePanelOpen, null, { timeout: 5000 });
      await page.waitForSelector('#queueList .queue-item[data-qi="2"] .cue-btn', { timeout: 6000, state: 'attached' });
      const r1 = await isolation(s, 'cue split (queue row)', async () => {
        await page.hover('#queueList .queue-item[data-qi="2"]');
        await page.click('#queueList .queue-item[data-qi="2"] .cue-btn');
        await page.waitForTimeout(300);
        await page.keyboard.press('Escape');                     // the queue panel goes; the mini bar stays
        const sp = await st(page);
        check('cue split (queue row): the route really is split (master off the destination, 2 discrete ch)',
          sp.route && sp.route.active && sp.route.mode === 'split' && !sp.masterToDest && sp.dest.i === 'discrete', { route: sp.route, dest: sp.dest, masterToDest: sp.masterToDest });
      }, async () => { await page.click('#cueMini .cm-play'); });
      await page.click('#cueMini .cm-play');                     // resume for the fader check
      await sleep(800);
      await masterFader(s, 'faders split (preview)', r1.lent, '#playerVolume');
      await page.click('#cueMini .cm-stop');
      await sleep(800);
      const after1 = await st(page);
      check('cue split: stopping the preview gives the deck back and restores master → destination (2 ch, speakers)',
        after1.loan === null && !after1.route.active && after1.masterToDest && after1.dest.c === 2 && after1.dest.m === 'explicit' && after1.dest.i === 'speakers' && !after1.paused,
        { loan: after1.loan, route: after1.route, masterToDest: after1.masterToDest, dest: after1.dest, paused: after1.paused });

      // (b) devices (a second output), from the desk's Load button.
      const dev = await page.evaluate(async () => {
        const o = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default');
        const pick = o.find(d => /Fake Audio Output 2/.test(d.label)) || o[o.length - 1];
        if (pick) window.__m.cue.setCueSettings({ mode: 'devices', deviceId: pick.deviceId, deviceLabel: pick.label });
        return { all: o.map(d => d.label), pick: pick && pick.label };
      });
      check('devices: Chromium lists fake outputs to pick from', !!dev.pick, dev);
      await openDeskUi(page);
      const r2 = await isolation(s, 'cue devices (desk Load)', async () => {
        await clickRow(page, 2, 'load');
        await page.waitForFunction(() => window.__m.cue.cueStatus().active, null, { timeout: 8000 });
        const sp = await st(page);
        check('cue devices (desk Load): the route is a separate output, master stays on the destination',
          sp.route.mode === 'devices' && !!sp.route.variant && sp.masterToDest && sp.dest.c === 2,
          { route: sp.route, masterToDest: sp.masterToDest, dest: sp.dest });
      }, async () => {
        const k = (await st(page)).loan;
        await page.click(`#ddDeck${k} [data-act="play"]`);
      });
      await page.click(`#ddDeck${r2.lent} [data-act="play"]`);  // resume
      await sleep(800);
      await masterFader(s, 'faders devices (desk)', r2.lent, '#fpVolume');
      // Cue volume knob: the cue moves, the master does not.
      const a = await probe(page, 1500, r2.active, r2.lent);
      const va = await st(page);
      await slide(page, '#ddCueVol', 30);
      await sleep(300);
      const b = await probe(page, 1500, r2.active, r2.lent);
      const vb = await st(page);
      await slide(page, '#ddCueVol', 100);
      const cueRel = b.rel / a.rel;
      check('faders devices (desk): phones knob 100→30 lowers the cue', cueRel < 0.35 && cueRel > 0.25, `cue/source ${a.rel}→${b.rel} (×${cueRel.toFixed(3)})`);
      check('faders devices (desk): phones knob leaves the master alone',
        vb.vol === va.vol && b.leak != null && b.leak < 0.05 && b.master / a.master > 0.6 && b.master / a.master < 1.6,
        `live el.volume ${va.vol}→${vb.vol}, master ×${(b.master / a.master).toFixed(2)}, leak ${a.leak}→${b.leak}`);
      check('cue: no page errors', s.errors.length === 0, s.errors.slice(0, 4).join(' | '));
    } finally { await s.browser.close(); }
  },

  // 3 + 4. Manual transitions on the desk, manual mode at a track end, then the desk closed
  // and the automatic DJ transition as before.
  async manual() {
    const s = await session('desktop');
    try {
      await start(s.page, TRACKS);
      const { page } = s;
      await openDeskUi(page);
      // Mix now into a track loaded on the free deck.
      await clickRow(page, 1, 'load');
      await lentPlaying(page);
      const b0 = await st(page);
      await page.click('#ddMixNow');
      await page.waitForFunction((b) => { const i = window.__m.eng.deskInfo(); return i.index !== b.index && i.active !== b.active; }, b0, { timeout: 20000 }).catch(() => {});
      const b1 = await st(page);
      check('manual: "Mix now" makes the loaded track live', b1.index === 1 && b1.active !== b0.active && b1.title === TRACKS[1].name,
        `index ${b0.index}→${b1.index}, active ${b0.active}→${b1.active}, title "${b1.title}"`);
      await page.waitForFunction(() => !window.__m.eng.deskInfo().crossfading, null, { timeout: 60000 });
      await sleep(800);

      // Crossfader: a real pointer drag from the live side to the far side.
      await clickRow(page, 2, 'load');
      await lentPlaying(page);
      const c0 = await st(page);
      const box = await page.locator('#ddXfader').boundingBox();
      const y = box.y + box.height / 2;
      const xFrom = c0.active === 'A' ? box.x + 1 : box.x + box.width - 1;
      const xTo = c0.active === 'A' ? box.x + box.width + 8 : box.x - 8;
      await page.mouse.move(xFrom, y);
      await page.mouse.down();
      let mid = null;
      for (let i = 1; i <= 20; i++) {
        await page.mouse.move(xFrom + (xTo - xFrom) * i / 20, y);
        await sleep(90);
        if (i === 10) mid = await st(page);
      }
      await page.mouse.up();
      await sleep(600);
      const c1 = await st(page);
      check('manual: crossfader half-way = a manual mix in progress', mid && mid.mixing, mid && { mixing: mid.mixing, active: mid.active, index: mid.index });
      const outPaused = await page.evaluate((k) => window.__m.eng.deskGraph().els[k].paused, c0.active);
      check('manual: crossfader at the far side commits the mix', c1.index === 2 && c1.active !== c0.active && !c1.mixing && outPaused && c1.title === TRACKS[2].name,
        `index ${c0.index}→${c1.index}, active ${c0.active}→${c1.active}, mixing ${c1.mixing}, outgoing paused ${outPaused}`);

      // Manual mode: near the end no automatic transition, but the track continues on its end.
      await page.click('#ddMode button[data-v="manual"]');
      await sleep(300);
      const m0 = await st(page);
      check('manual: Manual mode on', m0.manual === true);
      const dur = await page.evaluate(() => window.__m.eng.deskDur(window.__m.eng.deskInfo().active));
      const autoBefore = s.logs.filter(l => l.startsWith('[DJ auto]')).length;
      await page.evaluate((to) => window.__m.eng.seekLocal(to), dur - 22);
      let maxT = 0, xfadeEarly = null, nextAt = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        const x = await st(page);
        if (x.index === m0.index && x.active === m0.active) maxT = Math.max(maxT, x.t);
        // any transition that starts while the old track still has more than 1 s to go
        if (x.crossfading && dur - maxT > 1 && xfadeEarly == null) xfadeEarly = +(dur - maxT).toFixed(1);
        if (x.index === m0.index + 1 && !x.paused && x.t > 0.3) { nextAt = Date.now() - t0; break; }
        await sleep(200);
      }
      const autoFired = s.logs.filter(l => l.startsWith('[DJ auto]')).length - autoBefore;
      check('manual: no automatic transition near the end', autoFired === 0 && xfadeEarly == null,
        `auto-trigger fired ${autoFired}×, crossfade started ${xfadeEarly == null ? 'never' : xfadeEarly + ' s before the end'}`);
      check('manual: the track plays to its end', dur - maxT < 1.0, `reached ${maxT.toFixed(1)} of ${dur.toFixed(1)} s`);
      const m1 = await st(page);
      check('manual: then the next track follows (no silence)', nextAt != null && m1.index === m0.index + 1,
        `index ${m0.index}→${m1.index}, next playing after ${nextAt == null ? '-' : (nextAt / 1000).toFixed(1) + ' s'} of the 22 s wait`);

      // 4. Close the desk: manual off, deck released, routing restored.
      await clickRow(page, m1.index + 2, 'load').catch(() => {});   // leave something on the free deck
      await lentPlaying(page, 20000).catch(() => {});
      const pre = await st(page);
      await closeDeskUi(page);
      const c = await st(page);
      check('close: manual off, free deck released, cue route gone',
        !c.deskOpen && c.manual === false && c.loan === null && c.route && !c.route.active,
        { deskOpen: c.deskOpen, manual: c.manual, loan: c.loan, route: c.route, loanBefore: pre.loan, routeBefore: pre.route && pre.route.mode });
      check('close: master → destination again, 2 ch / explicit / speakers',
        c.masterToDest && c.dest.c === 2 && c.dest.m === 'explicit' && c.dest.i === 'speakers', { masterToDest: c.masterToDest, dest: c.dest, wasSplit: pre.route && pre.route.mode, masterToDestBefore: pre.masterToDest });
      const vols = await page.evaluate(() => [...document.querySelectorAll('audio')].map(a => a.volume));
      check('close: both decks back at the master volume', vols.every(v => v === c.vol), JSON.stringify(vols));
      // The automatic DJ transition works as it did without the desk.
      const up = TRACKS[c.next];
      await page.waitForFunction((t) => window.__m.prefetch.getStatus(t.name, t.artist)?.state === 'ready', up, { timeout: 90000 }).catch(() => {});
      const autoB = s.logs.filter(l => l.startsWith('[DJ auto]')).length;
      const d2 = await page.evaluate(() => window.__m.eng.deskDur(window.__m.eng.deskInfo().active));
      await page.evaluate((to) => window.__m.eng.seekLocal(to), d2 - 24);
      let fadeAt = null;
      const t1 = Date.now();
      while (Date.now() - t1 < 45000) {
        const x = await st(page);
        if (x.crossfading && fadeAt == null && x.index === c.index + 1) fadeAt = Date.now() - t1;
        if (fadeAt != null && !x.crossfading) break;
        await sleep(200);
      }
      const trig = s.logs.slice(autoB).filter(l => l.startsWith('[DJ auto]')).pop() || '';
      const rem = parseFloat((trig.match(/rem=([\d.]+)/) || [])[1]);
      const e = await st(page);
      check('after close: the automatic DJ transition fires before the end and swaps the track',
        trig && rem > 2 && fadeAt != null && e.index === c.index + 1 && e.title === up.name && !e.paused,
        `auto rem=${rem}s, crossfade seen after ${fadeAt == null ? '-' : (fadeAt / 1000).toFixed(1) + ' s'}, index ${c.index}→${e.index}`);
      check('manual: no page errors', s.errors.length === 0, s.errors.slice(0, 4).join(' | '));
    } finally { await s.browser.close(); }
  },

  // 5. Three viewports: the desk opens, controls are visible without hover, no overflow.
  async viewports() {
    for (const vpName of ['phone', 'tablet', 'desktop']) {
      const s = await session(vpName);
      try {
        await start(s.page, TRACKS.slice(0, 4));
        const { page } = s;
        await openDeskUi(page);
        await clickRow(page, 1, 'load').catch(() => {});
        await sleep(1500);
        await page.screenshot({ path: path.join(SHOT_DIR, `dj_desk-${vpName}.png`) });
        const r = await page.evaluate(async () => {
          const vw = innerWidth;
          const root = document.querySelector('#djDesk');
          const rr = root.getBoundingClientRect();
          const sels = ['#ddClose', '#ddMode button[data-v="auto"]', '#ddMode button[data-v="manual"]', '#ddMixNow', '#ddMixPhrase', '#ddXfader',
            '#ddDeckA [data-act="play"]', '#ddDeckB [data-act="play"]', '#ddDeckA [data-act="pfl"]', '#ddDeckB [data-act="pfl"]',
            '#ddDeckA [data-act="sync"]', '#ddDeckA .dd-pitch-range', '#ddCueVol', '#ddCueMix',
            '#ddQueue .dd-row [data-act="load"]', '#ddQueue .dd-row [data-act="cue"]'];
          const bad = [];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) { bad.push(sel + ': missing'); continue; }
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const b = el.getBoundingClientRect();
            let op = 1, vis = getComputedStyle(el).visibility;
            for (let n = el; n && n !== document.documentElement; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            const why = [];
            if (!(b.width > 0 && b.height > 0)) why.push('no box');
            if (b.left < -1 || b.right > vw + 1) why.push(`x ${b.left.toFixed(0)}–${b.right.toFixed(0)}`);
            if (op < 0.9) why.push('opacity ' + op.toFixed(2));
            if (vis !== 'visible') why.push(vis);
            if (!(hit && (hit === el || el.contains(hit)))) why.push('covered by ' + (hit ? (hit.id || hit.className || hit.tagName) : 'nothing'));
            if (why.length) bad.push(`${sel}: ${why.join(', ')}`);
          }
          const offenders = [];
          for (const el of root.querySelectorAll('*')) {
            const b = el.getBoundingClientRect();
            if (!b.width || !b.height || getComputedStyle(el).visibility === 'hidden') continue;
            if (b.right <= vw + 1 && b.left >= -1) continue;
            let clipped = false;
            for (let n = el.parentElement; n && n !== root; n = n.parentElement) if (getComputedStyle(n).overflowX !== 'visible') { clipped = true; break; }
            if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${b.left.toFixed(0)}–${b.right.toFixed(0)}`);
          }
          return {
            open: !!window.__m.store.deskOpen && getComputedStyle(root).display !== 'none' && rr.width >= vw - 1,
            hover: matchMedia('(hover: hover)').matches, coarse: matchMedia('(pointer: coarse)').matches,
            bad, offenders: offenders.slice(0, 6),
            docScroll: document.documentElement.scrollWidth, deskScroll: root.scrollWidth, deskClient: root.clientWidth, vw,
          };
        });
        check(`viewport ${vpName}: the desk opens from the full player`, r.open, { open: r.open });
        check(`viewport ${vpName}: controls visible without hover`, r.bad.length === 0, `hover=${r.hover} coarse=${r.coarse}; ${r.bad.join(' | ') || 'all visible'}`);
        check(`viewport ${vpName}: nothing overflows horizontally`, r.docScroll <= r.vw && r.deskScroll <= r.deskClient && r.offenders.length === 0,
          `doc ${r.docScroll}/${r.vw}, desk ${r.deskScroll}/${r.deskClient}; ${r.offenders.join(' | ') || 'no element past the edge'}`);
        await closeDeskUi(page);
        check(`viewport ${vpName}: no page errors`, s.errors.length === 0, s.errors.slice(0, 4).join(' | '));
      } catch (e) {
        check(`viewport ${vpName}: ran to completion`, false, String(e.message).split('\n')[0]);
      } finally { await s.browser.close(); }
    }
  },

  // 6. Cast: a faked store.castDevice. Every DLNA/cast request is answered here, so
  // nothing can reach a receiver.
  async cast() {
    const s = await session('desktop');
    const sent = [];
    await s.context.route(/\/api\/(dlna|cast)\b/, (r) => { sent.push(r.request().method() + ' ' + new URL(r.request().url()).pathname); r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
    try {
      await start(s.page, TRACKS.slice(0, 4));
      const { page } = s;
      const menuHas = async () => {
        await page.click('#queueList .queue-item[data-qi="1"] .kebab-btn');
        await sleep(500);
        const has = await page.evaluate(() => [...document.querySelectorAll('body *')].some(e => e.children.length === 0 && /Preview in headphones/.test(e.textContent) && e.getBoundingClientRect().width > 0));
        await page.keyboard.press('Escape');
        await sleep(300);
        return has;
      };
      const rowBtns = () => page.evaluate(() => document.querySelectorAll('#queueList .cue-btn').length);
      await page.click('#playerQueueBtn');
      await page.waitForFunction(() => window.__m.store.queuePanelOpen, null, { timeout: 5000 });
      await sleep(1800);
      const before = { btns: await rowBtns(), menu: await menuHas() };
      check('cast: before casting the cue entries exist (row buttons, menu item)', before.btns > 0 && before.menu, before);
      if (await page.evaluate(() => window.__m.store.queuePanelOpen)) await page.keyboard.press('Escape');
      await openDeskUi(page);
      await clickRow(page, 2, 'load');
      await lentPlaying(page);
      await page.evaluate(() => { window.__m.store.castDevice = { id: 'e2e-fake-receiver', name: 'E2E fake receiver' }; });
      await sleep(2500);
      const d = await page.evaluate(() => {
        const vis = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; };
        const i = window.__m.eng.deskInfo();
        return { blocked: vis('#ddBlocked'), main: vis('#ddMain'), title: document.querySelector('#ddBlockedTitle')?.textContent,
          loan: i.loan, engBlocked: i.blocked, route: window.__m.cue.cueStatus(), lentPaused: [...document.querySelectorAll('audio')].filter(a => a.paused).length };
      });
      check('cast: the open desk switches to "not available"', d.blocked && !d.main && /casting/i.test(d.title || ''), d);
      check('cast: the lent deck is taken back and the cue route torn down', d.loan === null && d.engBlocked === 'cast' && !d.route.active, d);
      await closeDeskUi(page);
      await openDeskUi(page);
      const d2 = await page.evaluate(() => ({ blocked: !document.querySelector('#ddBlocked').hidden, main: !document.querySelector('#ddMain').hidden }));
      check('cast: a desk opened while casting shows "not available" only', d2.blocked && !d2.main, d2);
      await closeDeskUi(page);
      await page.evaluate(() => { if (window.__m.store.fullPlayerOpen) history.back(); });
      await sleep(600);
      await page.click('#playerQueueBtn');
      await sleep(1800);
      const after = { btns: await rowBtns(), menu: await menuHas() };
      check('cast: cue buttons and the menu item are hidden while casting', after.btns === 0 && !after.menu, after);
      check('cast: nothing went to a receiver (every DLNA/cast call answered by the test)', true, `${sent.length} intercepted: ${[...new Set(sent)].join(', ') || 'none'}`);
      check('cast: no page errors', s.errors.length === 0, s.errors.slice(0, 4).join(' | '));
    } finally {
      await s.page.evaluate(() => { try { window.__m.store.castDevice = null; } catch {} }).catch(() => {});
      await s.browser.close();
    }
  },
};

for (const name of (want.length ? want : Object.keys(scenarios))) {
  try { await scenarios[name](); } catch (e) { check(`${name}: ran to completion`, false, String(e.message).split('\n')[0]); }
}
const ok = R.done();
console.log(`# ${R.rows.filter(r => r.ok === true).length} passed, ${R.rows.filter(r => r.ok === false).length} failed`);
process.exit(ok ? 0 : 1);
