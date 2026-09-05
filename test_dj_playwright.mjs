// test_dj_playwright.mjs — Verify DJ mode / Player V3 loads and works
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const SCREENSHOTS = '/tmp/dj-test-screenshots';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

let browser, context, page;
const errors = [];
const consoleLog = [];

async function screenshot(name) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
  console.log(`  📸 ${name}.png`);
}

async function main() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);

  page.on('console', msg => {
    const text = msg.text();
    consoleLog.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') errors.push(text);
  });
  page.on('pageerror', err => {
    errors.push(err.message);
    console.log(`  ❌ PAGE ERROR: ${err.message}`);
  });

  try {
    // ── Step 1: Login ──
    console.log('\n1. Login...');
    await page.goto(BASE);
    await page.waitForSelector('#loginForm', { timeout: 10000 });
    await page.fill('#loginUser', USER);
    await page.fill('#loginPass', PASS);
    await page.click('#loginBtn');
    await page.waitForSelector('#pageSearch', { state: 'visible', timeout: 10000 });
    console.log('  ✅ Logged in');

    // ── Step 2: Set player engine to DJ (V3) via localStorage ──
    console.log('\n2. Set player engine to DJ...');
    const currentEngine = await page.evaluate(() => localStorage.getItem('ms_player_engine'));
    console.log(`  Current engine: ${currentEngine || 'classic (default)'}`);
    await page.evaluate(() => {
      localStorage.setItem('ms_player_engine', 'dj');
      localStorage.setItem('ms_dj_smart_queue', 'bpm');
      localStorage.setItem('ms_dj_crossfade_beats', '16');
      localStorage.setItem('ms_dj_transition_style', 'auto');
    });
    // Reload to apply engine change
    await page.reload();
    await page.waitForSelector('#pageSearch', { state: 'visible', timeout: 10000 });
    console.log('  ✅ Engine set to DJ, reloaded');

    // ── Step 3: Check if player_v3.js loaded (no fallback to classic) ──
    console.log('\n3. Check player module loaded...');
    // Check for import errors in console
    const importErrors = errors.filter(e =>
      e.includes('player_v3') || e.includes('SyntaxError') || e.includes('Unexpected')
    );
    if (importErrors.length > 0) {
      console.log('  ❌ PLAYER V3 IMPORT ERRORS:');
      importErrors.forEach(e => console.log(`    ${e}`));
    } else {
      console.log('  ✅ No import errors detected');
    }

    // Check fallback message
    const fallbackMsg = consoleLog.find(l => l.includes('falling back to classic'));
    if (fallbackMsg) {
      console.log(`  ❌ FALLBACK TRIGGERED: ${fallbackMsg}`);
    } else {
      console.log('  ✅ No fallback to classic player');
    }

    // ── Step 4: Verify Web Audio context can be created ──
    console.log('\n4. Verify AudioContext...');
    const hasAudioCtx = await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext));
    console.log(`  AudioContext available: ${hasAudioCtx}`);

    // ── Step 5: Search and play a track ──
    console.log('\n5. Search and play a track...');
    await page.fill('#searchInput', 'Eminem Lose Yourself');
    await page.press('#searchInput', 'Enter');
    await page.waitForSelector('.card', { timeout: 15000 });
    await screenshot('01-search-results');

    // Click Play on first result
    const firstCard = await page.$('.card');
    if (firstCard) {
      // Click the card to open modal, then play
      await firstCard.click();
      await page.waitForSelector('#downloadModal.open, .modal-overlay.open', { timeout: 5000 }).catch(() => {});
      const playBtn = await page.$('#modalPlay');
      if (playBtn) {
        await playBtn.click();
        console.log('  ✅ Clicked Play on first result');
      } else {
        console.log('  ⚠️ No play button found in modal');
      }
    }

    // Wait for player bar to appear
    await page.waitForSelector('#playerBar.active', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await screenshot('02-playing');

    // ── Step 6: Check player state ──
    console.log('\n6. Check player state...');
    const playerState = await page.evaluate(() => {
      const deck = document.getElementById('audioElement');
      return {
        playerBarActive: document.getElementById('playerBar')?.classList.contains('active'),
        title: document.getElementById('playerTitle')?.textContent,
        artist: document.getElementById('playerArtist')?.textContent,
        deckSrc: deck?.src ? (deck.src.startsWith('blob:') ? 'blob' : deck.src.substring(0, 80)) : 'none',
        deckPaused: deck?.paused,
        deckDuration: deck?.duration,
        prefetchEl: document.getElementById('prefetchStatus')?.innerHTML,
        sourceBadge: document.getElementById('playerSourceBadge')?.textContent,
      };
    });
    console.log(`  Title: ${playerState.title}`);
    console.log(`  Artist: ${playerState.artist}`);
    console.log(`  Source: ${playerState.deckSrc}`);
    console.log(`  Paused: ${playerState.deckPaused}`);
    console.log(`  Duration: ${playerState.deckDuration}`);
    console.log(`  Prefetch indicator: ${playerState.prefetchEl || '(empty)'}`);
    console.log(`  Source badge: ${playerState.sourceBadge || '(empty)'}`);
    console.log(`  Player bar active: ${playerState.playerBarActive}`);

    // ── Step 7: Add more tracks to queue ──
    console.log('\n7. Add more tracks to queue...');
    // Search for another track
    await page.fill('#searchInput', 'Linkin Park Numb');
    await page.press('#searchInput', 'Enter');
    await page.waitForSelector('.card', { timeout: 15000 });
    const secondCard = await page.$('.card');
    if (secondCard) {
      await secondCard.click();
      await page.waitForSelector('#downloadModal.open, .modal-overlay.open', { timeout: 5000 }).catch(() => {});
      const queueBtn = await page.$('#modalAddQueue');
      if (queueBtn) {
        await queueBtn.click();
        console.log('  ✅ Added second track to queue');
      }
    }
    await page.waitForTimeout(1000);
    // Add a third track
    await page.fill('#searchInput', 'Metallica Nothing Else Matters');
    await page.press('#searchInput', 'Enter');
    await page.waitForSelector('.card', { timeout: 15000 });
    const thirdCard = await page.$('.card');
    if (thirdCard) {
      await thirdCard.click();
      await page.waitForSelector('#downloadModal.open, .modal-overlay.open', { timeout: 5000 }).catch(() => {});
      const queueBtn = await page.$('#modalAddQueue');
      if (queueBtn) {
        await queueBtn.click();
        console.log('  ✅ Added third track to queue');
      }
    }

    // ── Step 8: Wait for DJ data analysis ──
    console.log('\n8. Wait for DJ data to load (10s)...');
    await page.waitForTimeout(10000);

    const djState = await page.evaluate(() => {
      const store = window.__store || {};
      return {
        queueLength: store.playerQueue?.length || 0,
        playerIndex: store.playerIndex,
        engine: localStorage.getItem('ms_player_engine'),
        smartQueue: localStorage.getItem('ms_dj_smart_queue'),
      };
    });
    console.log(`  Queue: ${djState.queueLength} tracks, index: ${djState.playerIndex}`);
    console.log(`  Engine: ${djState.engine}, Smart Queue: ${djState.smartQueue}`);

    // ── Step 9: Check BPM/DJ data availability ──
    console.log('\n9. Check BPM API...');
    const bpmCheck = await page.evaluate(async () => {
      const token = localStorage.getItem('ms_token');
      const deviceId = localStorage.getItem('ms_device_id') || 'test';
      try {
        const resp = await fetch('/api/bpm/track?name=Lose%20Yourself&artist=Eminem', {
          headers: { 'Authorization': `Bearer ${token}`, 'X-Device-ID': deviceId }
        });
        const data = await resp.json();
        return { status: resp.status, bpm: data.bpm, key: data.key, hasBeatGrid: !!data.beat_grid };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log(`  BPM API response: ${JSON.stringify(bpmCheck)}`);

    // ── Step 10: Try to skip to next track (test crossfade) ──
    console.log('\n10. Skip to next track (crossfade test)...');
    await screenshot('03-before-skip');
    const nextBtn = await page.$('#playerNext');
    if (nextBtn) {
      await nextBtn.click();
      console.log('  ✅ Clicked Next');
    }
    await page.waitForTimeout(3000);
    await screenshot('04-after-skip');

    const afterSkip = await page.evaluate(() => {
      const deckA = document.getElementById('audioElement');
      const deckB = document.querySelectorAll('audio')[1];
      return {
        title: document.getElementById('playerTitle')?.textContent,
        deckASrc: deckA?.src ? 'yes' : 'no',
        deckAPaused: deckA?.paused,
        deckBSrc: deckB?.src ? 'yes' : 'no',
        deckBPaused: deckB?.paused,
        prefetch: document.getElementById('prefetchStatus')?.innerHTML,
      };
    });
    console.log(`  After skip — Title: ${afterSkip.title}`);
    console.log(`  Deck A: src=${afterSkip.deckASrc}, paused=${afterSkip.deckAPaused}`);
    console.log(`  Deck B: src=${afterSkip.deckBSrc}, paused=${afterSkip.deckBPaused}`);
    console.log(`  Prefetch: ${afterSkip.prefetch || '(empty)'}`);

    // ── Summary ──
    console.log('\n═══ SUMMARY ═══');
    console.log(`Total console errors: ${errors.length}`);
    if (errors.length > 0) {
      console.log('Errors:');
      errors.forEach(e => console.log(`  ❌ ${e}`));
    }

    // Print all console messages related to player/DJ
    const djLogs = consoleLog.filter(l =>
      l.includes('player') || l.includes('Player') || l.includes('DJ') || l.includes('dj') ||
      l.includes('crossfade') || l.includes('fallback') || l.includes('error') || l.includes('Error')
    );
    if (djLogs.length > 0) {
      console.log('\nRelevant console output:');
      djLogs.forEach(l => console.log(`  ${l}`));
    }

  } catch (err) {
    console.log(`\n❌ TEST FAILED: ${err.message}`);
    await screenshot('error-state');
  } finally {
    await browser.close();
    console.log(`\nScreenshots saved to ${SCREENSHOTS}`);
  }
}

main();
