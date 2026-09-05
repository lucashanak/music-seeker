// test_player_flow.mjs — Comprehensive player V3 flow test
// Tests: playlist playback, time progress, source badges, skip stability, stall detection
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const SCREENSHOTS = '/tmp/player-flow-screenshots';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

let browser, context, page;
const errors = [];
const warnings = [];

async function screenshot(name) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: false });
}

function log(msg) { console.log(msg); }
function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.log(`  ❌ ${msg}`); warnings.push(msg); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }

async function getPlayerState() {
  return page.evaluate(() => {
    const allAudio = [...document.querySelectorAll('audio')];
    const active = allAudio.find(a => !a.paused && a.src) || allAudio[0];
    const anyPlaying = allAudio.some(a => !a.paused && a.src);
    return {
      title: document.getElementById('playerTitle')?.textContent || '',
      artist: document.getElementById('playerArtist')?.textContent || '',
      paused: active?.paused,
      currentTime: active?.currentTime || 0,
      duration: active?.duration || 0,
      anyPlaying,
      sourceBadge: document.getElementById('playerSourceBadge')?.textContent || '',
      prefetch: document.getElementById('prefetchStatus')?.innerHTML || '',
      barActive: document.getElementById('playerBar')?.classList.contains('active'),
    };
  });
}

async function waitForProgress(seconds = 5, timeout = 15000) {
  const start = Date.now();
  const initial = await page.evaluate(() => {
    const all = [...document.querySelectorAll('audio')];
    const a = all.find(a => !a.paused && a.src) || all[0];
    return a?.currentTime || 0;
  });
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(500);
    const now = await page.evaluate(() => {
      const all = [...document.querySelectorAll('audio')];
      const a = all.find(a => !a.paused && a.src) || all[0];
      return a?.currentTime || 0;
    });
    if (now - initial >= seconds) return { ok: true, elapsed: now - initial };
  }
  const final = await page.evaluate(() => {
    const all = [...document.querySelectorAll('audio')];
    const a = all.find(a => !a.paused && a.src) || all[0];
    return a?.currentTime || 0;
  });
  return { ok: false, elapsed: final - initial };
}

async function main() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    if (!crypto.randomUUID) crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', err => { errors.push(err.message); });
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text());
  });

  try {
    // ═══ LOGIN ═══
    log('\n═══ LOGIN ═══');
    await page.goto(BASE);
    await page.waitForSelector('#loginForm', { timeout: 10000 });
    await page.fill('#loginUser', USER);
    await page.fill('#loginPass', PASS);
    await page.click('#loginBtn');
    await page.waitForSelector('#pageSearch', { state: 'visible', timeout: 10000 });

    // Set DJ engine
    await page.evaluate(() => {
      localStorage.setItem('ms_player_engine', 'dj');
      localStorage.setItem('ms_dj_smart_queue', 'bpm');
      localStorage.setItem('ms_dj_crossfade_sec', '5');
      localStorage.setItem('ms_dj_crossfade_beats', '16');
    });
    await page.reload();
    await page.waitForSelector('#pageSearch', { state: 'visible', timeout: 10000 });
    pass('Logged in, DJ engine set');

    // Check no fallback
    const fallback = await page.evaluate(() => window._playerFallback || false);
    const consoleHasFallback = errors.some(e => e.includes('falling back'));
    if (consoleHasFallback) fail('Player V3 fell back to classic!');
    else pass('Player V3 loaded successfully');

    // ═══ TEST 1: Library track playback ═══
    log('\n═══ TEST 1: Library track search + play ═══');
    await page.fill('#searchInput', 'Metallica');
    await page.press('#searchInput', 'Enter');
    await page.waitForSelector('.card', { timeout: 15000 });

    // Play first result
    const firstCard = await page.$('.card');
    await firstCard.click();
    await page.waitForSelector('.modal-overlay.open', { timeout: 5000 }).catch(() => {});
    await page.$eval('#modalPlay', el => el.click());
    await page.waitForTimeout(2000);

    let state = await getPlayerState();
    if (state.barActive) pass(`Playing: ${state.title} — ${state.artist}`);
    else fail('Player bar not active after play');

    // Check time progresses
    const prog1 = await waitForProgress(2, 10000);
    if (prog1.ok) pass(`Time progressed ${prog1.elapsed.toFixed(1)}s`);
    else fail(`Time stalled! Only ${prog1.elapsed.toFixed(1)}s in 10s`);

    // Check source badge
    await page.waitForTimeout(1000);
    state = await getPlayerState();
    info(`Source badge: "${state.sourceBadge}"`);
    info(`Prefetch: ${state.prefetch.replace(/<[^>]+>/g, ' ').trim()}`);
    await screenshot('01-first-track');

    // ═══ TEST 2: Build queue with multiple tracks ═══
    log('\n═══ TEST 2: Build queue ═══');
    const searches = ['Linkin Park', 'Eminem', 'AC/DC', 'Nirvana', 'System of a Down'];
    for (const q of searches) {
      await page.fill('#searchInput', q);
      await page.press('#searchInput', 'Enter');
      await page.waitForSelector('.card', { timeout: 10000 }).catch(() => {});
      const c = await page.$('.card');
      if (c) {
        await c.click();
        await page.waitForSelector('.modal-overlay.open', { timeout: 3000 }).catch(() => {});
        const qBtn = await page.$('#modalAddQueue');
        if (qBtn) { await qBtn.click(); await page.waitForTimeout(300); }
      }
    }
    state = await getPlayerState();
    info(`Queue built, currently playing: ${state.title}`);

    // ═══ TEST 3: Skip through tracks — check for stalls ═══
    log('\n═══ TEST 3: Skip through tracks ═══');
    for (let i = 1; i <= 4; i++) {
      await page.click('#playerNext');
      await page.waitForTimeout(1500);

      state = await getPlayerState();
      info(`Skip ${i}: ${state.title} — ${state.artist} [badge: ${state.sourceBadge || '?'}]`);

      // Check time is progressing (not stalled at 0)
      const prog = await waitForProgress(1, 8000);
      if (prog.ok) pass(`Track ${i} progressing (${prog.elapsed.toFixed(1)}s)`);
      else fail(`Track ${i} STALLED! (${prog.elapsed.toFixed(1)}s in 8s) — "${state.title}"`);

      await screenshot(`02-skip-${i}`);
    }

    // ═══ TEST 4: Rapid skip stress test ═══
    log('\n═══ TEST 4: Rapid skip (500ms intervals) ═══');
    // Go back to start first
    for (let i = 0; i < 3; i++) {
      await page.click('#playerPrev');
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1000);

    for (let i = 0; i < 3; i++) {
      await page.click('#playerNext');
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(3000);

    state = await getPlayerState();
    if (state.anyPlaying) pass(`After rapid skip, still playing: ${state.title}`);
    else fail(`After rapid skip, NOTHING PLAYING! Title: ${state.title}`);

    const prog4 = await waitForProgress(2, 10000);
    if (prog4.ok) pass(`Post-rapid-skip progress: ${prog4.elapsed.toFixed(1)}s`);
    else fail(`Post-rapid-skip STALL: ${prog4.elapsed.toFixed(1)}s in 10s`);
    await screenshot('03-rapid-skip');

    // ═══ TEST 5: Long play — verify no stall over 30s ═══
    log('\n═══ TEST 5: Long play (30s) ═══');
    const t5start = await page.evaluate(() => {
      const all = [...document.querySelectorAll('audio')];
      const a = all.find(a => !a.paused && a.src) || all[0];
      return a?.currentTime || 0;
    });
    await page.waitForTimeout(30000);
    const t5end = await page.evaluate(() => {
      const all = [...document.querySelectorAll('audio')];
      const a = all.find(a => !a.paused && a.src) || all[0];
      return a?.currentTime || 0;
    });
    const t5delta = t5end - t5start;
    if (t5delta >= 25) pass(`30s play: ${t5delta.toFixed(1)}s progressed`);
    else if (t5delta >= 15) info(`30s play: only ${t5delta.toFixed(1)}s (possible stream buffering)`);
    else fail(`30s play: STALL — only ${t5delta.toFixed(1)}s progressed!`);

    state = await getPlayerState();
    info(`After 30s: ${state.title} at ${state.currentTime.toFixed(1)}s, badge: ${state.sourceBadge}`);
    await screenshot('04-long-play');

    // ═══ SUMMARY ═══
    log('\n═══════════════════════════');
    log('═══ SUMMARY ═══');
    log(`Page errors: ${errors.length}`);
    if (errors.length) errors.slice(0, 10).forEach(e => log(`  ERR: ${e}`));
    log(`Warnings: ${warnings.length}`);
    if (warnings.length) warnings.forEach(w => log(`  ⚠️  ${w}`));
    if (!warnings.length && !errors.length) log('  🎉 ALL TESTS PASSED');

  } catch (err) {
    fail(`TEST CRASHED: ${err.message}`);
    await screenshot('error-crash');
  } finally {
    await browser.close();
    log(`\nScreenshots: ${SCREENSHOTS}`);
  }
}

main();
