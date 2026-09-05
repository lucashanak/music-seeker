// test_rec_playback.mjs — Reproduce broken controls after clicking a rec track
import { chromium } from 'playwright';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }

const log = m => console.log(m);
const ok = m => console.log('  ✅ ' + m);
const bad = m => console.log('  ❌ ' + m);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });

  await page.goto(BASE);
  await page.evaluate(() => localStorage.setItem('ms_player_engine', 'dj'));
  await page.reload();
  await page.waitForSelector('#loginUser', { timeout: 8000 });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#searchInput', { timeout: 8000 });
  ok('Logged in');

  // Make sure search type is 'track' (so cards have play buttons)
  await page.click('.type-btn[data-type="track"]').catch(() => {});
  await page.fill('#searchInput', 'daft punk one more time');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#searchResults .card .card-play-btn', { timeout: 10000 });
  await page.click('#searchResults .card:first-child .card-play-btn');
  await page.waitForTimeout(4500);
  const queueLen = await page.evaluate(() => {
    return document.querySelectorAll('#fpQueueList .queue-item, #queueList .queue-item').length;
  });
  log(`After play click, queue UI items: ${queueLen}`);
  const after1 = await page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find(x => !x.paused && x.src) || document.querySelectorAll('audio')[0];
    return { src: a?.src?.slice(0, 80), paused: a?.paused, dur: a?.duration || 0, t: a?.currentTime || 0 };
  });
  log(`Initial track state: ${JSON.stringify(after1)}`);
  if (!after1.paused) ok('Initial playback running'); else bad('Initial playback not running');

  // Click the queue button on the player bar to open the queue panel
  const recsPromise = page.waitForResponse(r => r.url().includes('/api/player/recommendations'), { timeout: 30000 }).catch(() => null);
  await page.click('#playerQueueBtn').catch(() => {});
  await page.waitForTimeout(300);
  const recsResp = await recsPromise;
  log(`Recs response status: ${recsResp ? recsResp.status() : 'TIMED OUT'}`);
  await page.waitForTimeout(3000);
  // Debug: dump containers
  const dbg = await page.evaluate(() => {
    return {
      qPanelOpen: document.getElementById('queuePanel')?.classList.contains('open'),
      qListChildren: document.getElementById('queueList')?.children.length,
      qListRecs: document.querySelectorAll('#queueList .rec-item').length,
      recsAny: document.querySelectorAll('.rec-item').length,
      fpQueueListRecs: document.querySelectorAll('#fpQueueList .rec-item').length,
      fpPanelRecs: document.querySelectorAll('#fpQueuePanelList .rec-item').length,
    };
  });
  log(`Debug containers: ${JSON.stringify(dbg)}`);

  const recItems = await page.$$('.rec-item');
  log(`Rec items rendered: ${recItems.length}`);
  if (!recItems.length) { bad('No rec items — cannot reproduce'); await browser.close(); return; }

  // Click a rec item
  await recItems[0].click();
  await page.waitForTimeout(3500);

  const after2 = await page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find(x => !x.paused && x.src) || document.querySelectorAll('audio')[0];
    return {
      src: a?.src?.slice(0, 80),
      paused: a?.paused,
      dur: a?.duration || 0,
      t: a?.currentTime || 0,
      barActive: document.getElementById('playerBar')?.classList.contains('active'),
      playIcon: document.querySelector('#playerPlayPause use')?.getAttribute('href') || '',
    };
  });
  log(`After rec click: ${JSON.stringify(after2)}`);

  // Try clicking play/pause
  await page.click('#playerPlayPause');
  await page.waitForTimeout(800);
  const after3 = await page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find(x => !x.paused && x.src) || document.querySelectorAll('audio')[0];
    return { paused: a?.paused, t: a?.currentTime || 0 };
  });
  log(`After play/pause click: ${JSON.stringify(after3)}`);
  if (after2.paused !== after3.paused) ok('Play/pause toggles');
  else bad('Play/pause does NOT toggle (paused state unchanged)');

  // Try clicking next
  await page.click('#playerNext');
  await page.waitForTimeout(2500);
  const after4 = await page.evaluate(() => {
    return {
      title: document.getElementById('playerTitle')?.textContent,
      artist: document.getElementById('playerArtist')?.textContent,
    };
  });
  log(`After Next click: ${JSON.stringify(after4)}`);

  await browser.close();
})();
