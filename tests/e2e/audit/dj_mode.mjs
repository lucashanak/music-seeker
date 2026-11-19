// DJ mode: a song is heard to its end, a broken track does not stop the set, and the
// track that gets prefetched is the one that plays next.
//
// Oracle (same as the rest of tests/e2e/audit): PRODUCTION. Without --tree the page
// runs the deployed code; with --tree it gets the REAL files from the working tree
// (helpers.serveWorktree, same cache-bust stamp → the same module instances the app
// itself uses). A check is worth something only if it FAILS deployed and PASSES over
// the tree — measured 2026-11-17, before the fixes were deployed:
//
//   clash    7.7 s of the ending unheard   → 0.0 s
//   error    no toast, 30.8 s of silence   → toast, next track in 1.5 s, 0 s silent
//   shuffle  queue[i+1] prefetched         → the shuffle-next track prefetched
//   last     stopped 10.4 s early          → played to the end
//
// Nothing here replaces engine code: gain automation is OBSERVED by wrapping
// AudioContext.createGain before the app loads. Account claude_test, device id
// e2e-djreview; tracks come from the server's own BPM cache (= owned tracks), the
// recommender and radio are stubbed empty so no test can start a YouTube lookup.
//
//   node tests/e2e/audit/dj_mode.mjs --tree [clash blend error cold progressive shuffle last]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const { chromium } = pw;
const TREE = process.argv.includes('--tree') ? '/home/lucas/music-seeker' : null;
const want = process.argv.slice(2).filter(a => !a.startsWith('--'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── analysed (= owned) tracks, straight from the server's BPM cache ──
async function api(path, body, tok) {
  const h = { 'User-Agent': 'ms-review/1.0', 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: h, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const parseCam = (c) => (c ? { n: parseInt(c), l: c.slice(-1).toUpperCase() } : null);
function styleOf(a, b) {
  a = parseCam(a); b = parseCam(b);
  if (!a || !b || a.n === b.n) return 'blend';
  if (a.l === b.l) { const d = Math.abs(a.n - b.n); if (Math.min(d, 12 - d) <= 2) return 'blend'; }
  return 'drop_cut';
}
const tok = (await api('/api/auth/login', { username: USER, password: PASS })).token;
let lib = await api('/api/bpm/cache', null, tok);
lib = (Array.isArray(lib) ? lib : Object.values(lib.tracks || lib))
  .filter(t => t && t.name && t.artist && t.camelot && t.bpm && t.confidence >= 0.5 && !/[&<>"']/.test(t.name + t.artist));
const item = (t) => ({ name: t.name, artist: t.artist, type: 'track' });
function pair(style) {
  for (let i = 0; i < lib.length; i++) for (let j = i + 1; j < lib.length; j++) {
    if (lib[i].artist !== lib[j].artist && styleOf(lib[i].camelot, lib[j].camelot) === style
        && Math.abs(lib[i].bpm - lib[j].bpm) < 4) return [lib[i], lib[j]];
  }
  throw new Error('no pair for ' + style);
}

async function session(extraInit = {}) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (TREE) await serveWorktree(context, TREE);
  // Nothing un-owned may reach the server's YouTube arm from a test, and the
  // recommender must not start tracks of its own.
  await context.route('**/api/player/recommendations**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"recommendations":[],"tracks":[]}' }));
  await context.route('**/api/radio**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"tracks":[]}' }));
  const page = await context.newPage();
  const settings = { ms_device_id: 'e2e-djreview', ms_player_engine: 'dj', ms_dj_debug: '1', ms_dj_smart_queue: 'off', ...extraInit };
  await page.addInitScript((s) => {
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    // Record what the engine schedules on its gain nodes — observation only.
    window.__gain = [];
    const AC = window.AudioContext || window.webkitAudioContext;
    const orig = AC.prototype.createGain;
    let seq = 0;
    AC.prototype.createGain = function () {
      const node = orig.call(this); const id = seq++; const ctx = this; const p = node.gain;
      for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'setValueCurveAtTime']) {
        const f = p[m].bind(p);
        p[m] = (...a) => {
          const last = m === 'setValueCurveAtTime' ? a[0][a[0].length - 1] : a[0];
          const end = m === 'setValueCurveAtTime' ? a[1] + a[2] : a[1];
          window.__gain.push({ id, m, v: last, end, at: ctx.currentTime, wall: performance.now() });
          return f(...a);
        };
      }
      return node;
    };
  }, settings);
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[DJ')) logs.push({ t, wall: Date.now() }); });
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
  await page.mouse.click(640, 450); // a real gesture, for the AudioContext
  return { browser, context, page, logs, errors };
}

/** Start a queue through the real engine; returns after the first track is audible. */
async function start(page, tracks, opts = {}) {
  await page.evaluate(async ({ tracks, opts }) => {
    const v = [...document.scripts].map(s => s.src).find(s => /app\.js\?v=/.test(s)).split('?v=')[1];
    const imp = (f) => import(`/static/js/${f}.js?v=${v}`);
    const { store } = await imp('store');
    const eng = await (await imp('player_active')).getPlayerModule();
    window.__m = { store, eng, prefetch: await imp('prefetch'), queue: await imp('queue'), bpm: await imp('bpm') };
    store.playlistMode = null;
    store.radioMode = false;
    store.repeatMode = opts.repeat || 'off';
    store.shuffleEnabled = !!opts.shuffle;
    window.__m.queue.resetShuffleOrder();
    store.playerQueue = tracks;
    store.playerIndex = 0;
    // The engine reads BPM/key from this cache; warm it the way a playlist view does.
    await Promise.all(tracks.map(t => window.__m.bpm.fetchTrackBpm(t.name, t.artist).catch(() => null)));
    eng.loadAndPlay();
  }, { tracks, opts });
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('audio')].some(a => !a.paused && a.currentTime > 0.5), null, { timeout: 60000 });
  } catch (e) {
    e.diag = JSON.stringify({ decks: await decks(page), title: await title(page),
      st: await page.evaluate(() => ({ idx: window.__m.store.playerIndex, playing: window.__m.store.playerPlaying, toast: document.body.innerText.match(/Stream error[^\n]*/)?.[0] })) });
    throw e;
  }
  if (process.env.MS_DIAG) console.log('  start:', JSON.stringify(await decks(page)));
}
const decks = (page) => page.evaluate(() => [...document.querySelectorAll('audio')].map(a => ({
  paused: a.paused, ended: a.ended, t: a.currentTime, d: a.duration, rate: a.playbackRate,
  blob: String(a.src).startsWith('blob:'), has: !!a.getAttribute('src'), err: a.error ? a.error.code : 0,
})));
const title = (page) => page.evaluate(() => document.querySelector('#playerTitle').textContent);
async function waitCached(page, t, ms = 90000) {
  try {
    await page.waitForFunction((t) => window.__m.prefetch.getStatus(t.name, t.artist)?.state === 'ready', t, { timeout: ms });
  } catch (e) {
    e.diag = 'prefetch of the next track never became ready: ' + JSON.stringify({
      status: await page.evaluate((t) => window.__m.prefetch.getStatus(t.name, t.artist) || null, t).catch(() => '?'),
      decks: await decks(page).catch(() => '?'), title: await title(page).catch(() => '?') });
    throw e;
  }
}
async function seekToEnd(page, secBefore) {
  return page.evaluate((s) => {
    const a = [...document.querySelectorAll('audio')].find(x => !x.paused);
    a.currentTime = a.duration - s; return a.duration;
  }, secBefore);
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/** Seconds of the outgoing track that were never audible in an auto transition. */
async function lostAtEnd(s, a, b) {
  const { page, logs } = s;
  await start(page, [item(a), item(b)]);
  await waitCached(page, b);
  await page.evaluate(() => { window.__gain.length = 0; });
  if (process.env.MS_DIAG) console.log('  cached:', JSON.stringify(await decks(page)), await title(page));
  await seekToEnd(page, 24);
  try {
    await page.waitForFunction(() => window.__gain.some(g => g.v < 1e-6 && g.m !== 'setValueAtTime'), null, { timeout: 45000 });
  } catch (e) {
    e.diag = JSON.stringify({ decks: await decks(page), title: await title(page), logs: logs.map(l => l.t).slice(-8),
      gain: await page.evaluate(() => window.__gain.slice(-6)) }, null, 1);
    throw e;
  }
  await sleep(300);
  const trig = logs.map(l => l.t).filter(t => t.startsWith('[DJ auto]')).pop() || '';
  const rem = parseFloat((trig.match(/rem=([\d.]+)/) || [])[1]);
  const g = await page.evaluate(() => window.__gain);
  const zero = g.filter(x => x.v < 1e-6 && x.m !== 'setValueAtTime').sort((x, y) => x.end - y.end)[0];
  const silentIn = zero.end - zero.at;           // s after the fade started
  return { rem, silentIn, lost: rem - silentIn, trig, kind: zero.m };
}

const scenarios = {
  // 1. Clashing keys: the outgoing track must be audible to its end.
  async clash() {
    const [a, b] = pair('drop_cut');
    const s = await session();
    try {
      const r = await lostAtEnd(s, a, b);
      check('clash: outgoing audible to its end', r.lost < 1.0,
        `${a.camelot}→${b.camelot}  trigger rem=${r.rem}s, outgoing silent after ${r.silentIn.toFixed(2)}s → ${r.lost.toFixed(1)}s of the ending unheard`);
      check('clash: no page errors', s.errors.length === 0, s.errors.join(' | '));
    } finally { await s.browser.close(); }
  },
  // 2. Compatible keys: unchanged full-length blend ending on the track end.
  async blend() {
    const [a, b] = pair('blend');
    const s = await session();
    try {
      const r = await lostAtEnd(s, a, b);
      check('blend: fade ends on the track end', Math.abs(r.lost) < 1.0 && r.rem > 6,
        `${a.camelot}→${b.camelot}  rem=${r.rem}s, silent after ${r.silentIn.toFixed(2)}s (${r.kind})`);
      // And the swap really happened, onto the next track, which keeps playing.
      await sleep(Math.max(0, r.rem) * 1000 + 1500);
      const d = await decks(s.page);
      check('blend: next track playing alone afterwards', d.filter(x => !x.paused).length === 1 && (await title(s.page)) === b.name);
    } finally { await s.browser.close(); }
  },
  // 3. The next track cannot load: say so, keep the current one, move on quickly.
  async error() {
    const [a, c] = pair('blend');
    const bad = { name: 'ZZ Review Missing Track', artist: 'Nobody At All', type: 'track' };
    const s = await session();
    try {
      await s.context.route(/\/api\/player\/stream\?.*ZZ\+Review\+Missing\+Track/, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"nope"}' }));
      await s.context.route(/\/api\/bpm\/track\?.*ZZ\+Review/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"owned":false}' }));
      await start(s.page, [item(a), bad, item(c)]);
      await sleep(4000);
      const dur = await seekToEnd(s.page, 9);
      const t0 = Date.now();
      let toast = false, playingC = -1, silentMs = 0, last = Date.now();
      while (Date.now() - t0 < 40000) {
        const d = await decks(s.page);
        const now = Date.now();
        if (!d.some(x => !x.paused && !x.err && x.has)) silentMs += now - last;
        last = now;
        if (!toast) toast = await s.page.evaluate(() => /Stream error/.test(document.body.innerText));
        if ((await title(s.page)) === c.name && d.some(x => !x.paused && x.t > 0.3 && !x.err)) { playingC = now - t0; break; }
        await sleep(150);
      }
      check('error: "Stream error" is shown', toast);
      check('error: the track after the broken one plays', playingC >= 0, `after ${(playingC / 1000).toFixed(1)}s`);
      check('error: no long silence on the way', silentMs < 4000, `${(silentMs / 1000).toFixed(1)}s with no deck playing (track had 9s left)`);
    } finally { await s.browser.close(); }
  },
  // 3b. The FIRST track cannot load (nothing is playing): the next one must come
  // straight in — not fade up from silence over a beat-length "crossfade" out of a
  // deck that never produced sound.
  async cold() {
    const [, c] = pair('blend');
    const bad = { name: 'ZZ Review Missing Track', artist: 'Nobody At All', type: 'track' };
    const s = await session();
    try {
      await s.context.route(/\/api\/player\/stream\?.*ZZ\+Review\+Missing\+Track/, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"nope"}' }));
      await s.context.route(/\/api\/bpm\/track\?.*ZZ\+Review/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"owned":false}' }));
      const t0 = Date.now();
      await start(s.page, [bad, item(c)]);
      const took = Date.now() - t0;
      await sleep(1500);
      const g = await s.page.evaluate(() => window.__gain);
      const up = g.filter(x => x.v === 1 && x.m !== 'setValueAtTime').pop();
      const rise = up ? up.end - up.at : 0; // 0 = gain set straight to 1
      check('cold: the track after a broken first one is playing', (await title(s.page)) === c.name, `after ${(took / 1000).toFixed(1)}s`);
      check('cold: it comes in at once, not over a long fade', rise < 1, `gain reaches 1 in ${rise.toFixed(2)}s`);
    } finally { await s.browser.close(); }
  },
  // 3c. A track that is not on disk (served through Navidrome) and whose server cache
  // is cold: it must start at once, the deck must learn its real length, and the
  // transition out of it must still end on the track's end.
  async progressive() {
    // A cold cache is not enough: Navidrome keeps its own transcodes, and a song it can
    // hand over within a moment is built before the router's 1 s wait ends — a plain file,
    // correctly not progressive. So candidates are tried until one really is served
    // while it is built (the same first cold track used to be picked after every deploy).
    const cold = async (from) => {
      for (let i = from; i < 160; i++) {
        const t = lib[i];
        if (!t) break;
        const q = new URLSearchParams({ name: t.name, artist: t.artist });
        const src = await api(`/api/player/resolve-source?${q}`, null, tok);
        if (src.source !== 'navidrome' || src.raw) continue;   // served untouched: a plain file, never progressive
        const d = await (await fetch(`${BASE}/api/player/stream-duration?${q}&token=${encodeURIComponent(tok)}`, { headers: { 'User-Agent': 'ms-review/1.0' } })).json().catch(() => ({}));
        if (d.ready === false) return [t, i];           // resolved, but no finished cache file
      }
      return [null, 160];
    };
    let nav = null, s = null, prog = false, t0 = 0, b = null, at = 40;
    const quick = [];
    for (let tries = 0; tries < 5 && !prog; tries++) {
      [nav, at] = await cold(at); at++;
      if (!nav) break;
      b = lib.find(t => t.artist !== nav.artist && styleOf(nav.camelot, t.camelot) === 'blend');
      s = await session();
      s.page.on('response', (r) => { if (r.url().includes('/api/player/stream?') && r.headers()['x-stream-progressive'] === '1') prog = true; });
      t0 = Date.now();
      await start(s.page, [item(nav), item(b)]);
      if (!prog) { quick.push(nav.name); await s.browser.close(); s = null; }
    }
    if (!s) { check('progressive: a cold Navidrome-only track that takes time to build exists to test with', false, quick.length ? `built within a moment: ${quick.join(', ')}` : 'none found (all warm, all served untouched, or endpoint not deployed)'); return; }
    try {
      const took = Date.now() - t0;
      check('progressive: the stream is served while it is being built', prog, `${nav.artist} – ${nav.name}`);
      check('progressive: playback starts at once', took < 6000, `audible after ${(took / 1000).toFixed(1)}s (BPM warm-up included)`);
      const t1 = Date.now();
      let learned = null;
      while (Date.now() - t1 < 90000 && !learned) {
        const l = s.logs.map(x => x.t).find(x => x.startsWith('[DJ dur] learned'));
        if (l) learned = parseFloat(l.match(/learned ([\d.]+)s/)[1]);
        else await sleep(500);
      }
      const d0 = await decks(s.page);
      const elDur = d0.find(x => !x.paused)?.d;
      check('progressive: the deck learns the real length', learned > 30, `learned ${learned}s; element reports ${elDur}`);
      // The point of learning it: the engine must be USING it while the element still
      // cannot tell (null here = Infinity through JSON). The total-time label is drawn
      // from the same value the transition trigger reads.
      await sleep(1200);
      const total = await s.page.evaluate(() => document.querySelector('#playerTimeTotal').textContent);
      const want = `${Math.floor(learned / 60)}:${String(Math.floor(learned % 60)).padStart(2, '0')}`;
      check('progressive: the engine uses it while the element still reports no duration', !Number.isFinite(elDur) && total === want, `element=${elDur}, shown total=${total}, learned=${want}`);
      if (!learned) return;
      await waitCached(s.page, b);
      await s.page.evaluate(() => { window.__gain.length = 0; });
      await s.page.evaluate((to) => window.__m.eng.seekLocal(to), learned - 24); // the engine's seek: reloads the finished file
      await s.page.waitForFunction(() => window.__gain.some(g => g.v < 1e-6 && g.m !== 'setValueAtTime'), null, { timeout: 45000 });
      await sleep(300);
      const trig = s.logs.map(l => l.t).filter(t => t.startsWith('[DJ auto]')).pop() || '';
      const rem = parseFloat((trig.match(/rem=([\d.]+)/) || [])[1]);
      const g = await s.page.evaluate(() => window.__gain);
      const zero = g.filter(x => x.v < 1e-6 && x.m !== 'setValueAtTime').sort((x, y) => x.end - y.end)[0];
      const lost = rem - (zero.end - zero.at);
      check('progressive: its transition still ends on the track end', Math.abs(lost) < 1.0 && rem > 2, `rem=${rem}s, silent after ${(zero.end - zero.at).toFixed(2)}s`);
    } finally { await s.browser.close(); }
  },
  // 4. Shuffle: what gets prefetched is what shuffle plays next.
  async shuffle() {
    const tracks = lib.slice(0, 12).map(item);
    const s = await session();
    try {
      const fetched = [];
      s.page.on('request', (r) => {
        if (r.resourceType() === 'fetch' && r.url().includes('/api/player/stream?')) fetched.push(new URL(r.url()).searchParams.get('name'));
      });
      await start(s.page, tracks, { shuffle: true });
      await sleep(6000);
      const next = await s.page.evaluate(() => {
        const q = window.__m.queue; const i = q.peekShuffleNext ? q.peekShuffleNext() : q.playOrder()[q.playOrder().indexOf(window.__m.store.playerIndex) + 1];
        return window.__m.store.playerQueue[i].name;
      });
      const seq = tracks[1].name;
      check('shuffle: the shuffle-next track is prefetched', fetched.includes(next), `next=${next}; fetched=[${fetched.join(', ')}]`);
      if (next !== seq) check('shuffle: the storage neighbour is NOT fetched first', fetched[0] !== seq, `first fetch=${fetched[0]}`);
    } finally { await s.browser.close(); }
  },
  // 5. Last track, nothing to follow (Smart Queue on → the trigger fires): plays out.
  async last() {
    const a = lib[3];
    const s = await session({ ms_dj_smart_queue: 'bpm' });
    try {
      await start(s.page, [item(a)]);
      await sleep(3000);
      const dur = await seekToEnd(s.page, 20);
      let maxT = 0, endedSeen = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const d = await decks(s.page);
        for (const x of d) if (x.has && x.d && Math.abs(x.d - dur) < 1) { maxT = Math.max(maxT, x.t); endedSeen = endedSeen || x.ended; }
        if (endedSeen) break;
        await sleep(200);
      }
      check('last: the final track plays to its end', dur - maxT < 0.7, `reached ${maxT.toFixed(1)}s of ${dur.toFixed(1)}s (stopped ${(dur - maxT).toFixed(1)}s early)`);
    } finally { await s.browser.close(); }
  },
};

console.log(`# ${TREE ? 'working tree' : 'DEPLOYED'} against ${BASE}`);
for (const name of (want.length ? want : Object.keys(scenarios))) {
  try { await scenarios[name](); }
  catch (e) { check(`${name}: ran to completion`, false, String(e.message).split('\n')[0] + (e.diag ? '\n' + e.diag : '')); }
}
const bad = results.filter(r => !r.ok).length;
console.log(`# ${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
