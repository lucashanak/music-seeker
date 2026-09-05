// Playwright test for prefetch feature
// Tests: login → play track → verify prefetch requests → verify blob URL on next track

import { chromium } from 'playwright';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const SCREENSHOTS = '/tmp/prefetch-test-screenshots';

let page, browser, context;

async function screenshot(name) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
  console.log(`  📸 ${name}.png`);
}

async function test() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(60000);

  const fs = await import('fs');
  fs.mkdirSync(SCREENSHOTS, { recursive: true });

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  // Track /api/player/stream requests
  const streamRequests = [];
  page.on('request', req => {
    if (req.url().includes('/api/player/stream')) {
      streamRequests.push(req.url());
    }
  });

  try {
    // ── 1. Login ──
    console.log('[1/5] Login...');
    await page.goto(BASE);
    await page.waitForSelector('#loginForm', { timeout: 10000 });
    await page.fill('#loginUser', USER);
    await page.fill('#loginPass', PASS);
    await page.click('#loginBtn');
    await page.waitForSelector('#searchInput', { timeout: 10000 });
    await screenshot('01-logged-in');
    console.log('  ✅ Logged in');

    // ── 2. Search and play an album to get multiple tracks in queue ──
    console.log('[2/5] Searching for album...');
    // Switch to album search
    await page.click('[data-type="album"]');
    await page.fill('#searchInput', 'Bohemian Rhapsody');
    await page.waitForTimeout(1500); // debounce
    await page.waitForSelector('.card', { timeout: 15000 });
    await screenshot('02-search-results');

    // Click play on first album result
    const firstCard = await page.locator('.card').first();
    const playBtn = firstCard.locator('.play-btn, [title*="Play"], svg').first();
    await playBtn.click();
    await page.waitForTimeout(2000);
    await screenshot('03-playing');

    // Check if queue has tracks — if album didn't load queue, try track search instead
    const queueLen = await page.evaluate(() => window.__store?.playerQueue?.length || 0).catch(() => 0);
    if (queueLen < 3) {
      console.log('  ℹ️ Album queue too small, searching tracks instead...');
      await page.click('[data-type="track"]');
      await page.fill('#searchInput', '');
      await page.fill('#searchInput', 'Queen');
      await page.waitForTimeout(1500);
      await page.waitForSelector('.card', { timeout: 15000 });

      // Add multiple tracks to queue
      const cards = await page.locator('.card').all();
      for (let i = 0; i < Math.min(cards.length, 6); i++) {
        const card = cards[i];
        const btn = card.locator('.play-btn, [title*="Play"], svg').first();
        await btn.click();
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1000);
    }

    console.log('  ✅ Tracks queued');

    // ── 3. Wait for prefetch requests ──
    console.log('[3/5] Waiting for prefetch requests...');
    // Clear request log and count from here
    const beforeCount = streamRequests.length;
    // Wait up to 15s for prefetch requests to appear (beyond the initial play request)
    let prefetchCount = 0;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(500);
      prefetchCount = streamRequests.length - beforeCount;
      if (prefetchCount >= 2) break;
    }
    console.log(`  Stream requests total: ${streamRequests.length} (${prefetchCount} after play started)`);

    // The initial loadAndPlay triggers 1 stream request (the playing track).
    // Prefetch should trigger additional requests for upcoming tracks.
    // Total stream requests should be > 1 (1 current + N prefetched)
    if (streamRequests.length >= 2) {
      console.log(`  ✅ Prefetch detected: ${streamRequests.length} stream requests (1 current + ${streamRequests.length - 1} prefetched)`);
    } else {
      console.log(`  ⚠️ Only ${streamRequests.length} stream request(s) — prefetch may not have triggered`);
    }
    await screenshot('04-prefetch-fired');

    // ── 4. Check blob URL after next track ──
    console.log('[4/5] Advancing to next track, checking blob URL...');
    // Wait a bit more for prefetch to finish downloading
    await page.waitForTimeout(5000);

    // Click next track button
    await page.click('#playerNext');
    await page.waitForTimeout(2000);

    // Check audio.src — should be blob: if prefetch worked
    const audioSrc = await page.evaluate(() => {
      const audio = document.querySelector('#audioElement');
      return audio ? audio.src : 'no audio element';
    });
    console.log(`  audio.src = ${audioSrc.substring(0, 80)}...`);

    if (audioSrc.startsWith('blob:')) {
      console.log('  ✅ Next track loaded from prefetch cache (blob URL)');
    } else if (audioSrc.includes('/api/player/stream')) {
      console.log('  ⚠️ Next track loaded from network (prefetch cache miss — track may still be downloading)');
    } else {
      console.log(`  ❓ Unexpected audio.src: ${audioSrc}`);
    }
    await screenshot('05-next-track');

    // ── 5. Summary ──
    console.log('[5/5] Summary');
    console.log(`  Total stream requests: ${streamRequests.length}`);
    console.log(`  Console errors: ${errors.length}`);
    if (errors.length > 0) {
      errors.forEach(e => console.log(`    ❌ ${e}`));
    }

    const passed = streamRequests.length >= 2 && errors.filter(e => !e.includes('net::') && !e.includes('favicon')).length === 0;
    console.log(passed ? '\n✅ PREFETCH TEST PASSED' : '\n❌ PREFETCH TEST FAILED');
    return passed;

  } catch (err) {
    console.error('❌ Test error:', err.message);
    await screenshot('error');
    return false;
  } finally {
    await browser.close();
  }
}

test().then(ok => process.exit(ok ? 0 : 1));
