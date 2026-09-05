// test_remove_track.mjs — Reproduce remove/delete from playlist context menu bug
import { chromium } from 'playwright';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }

const log = m => console.log(m);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
  page.on('console', m => console.log(`[${m.type()}] ${m.text()}`));

  await page.goto(BASE);
  await page.waitForSelector('#loginUser', { timeout: 8000 });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#searchInput', { timeout: 8000 });
  log('Logged in');

  // Navigate to Library
  await page.click('.nav-btn[data-page="library"]');
  await page.waitForTimeout(2000);
  log('Library page');

  // Click MyZouk playlist
  await page.click('text=MyZouk').catch(() => {});
  await page.waitForSelector('#libraryTracks .card', { timeout: 10000 });
  await page.waitForTimeout(1500);
  log('Opened MyZouk playlist');

  // Right-click first track
  const firstCard = await page.$('#libraryTracks .card[data-item]');
  if (!firstCard) { log('NO CARD'); await browser.close(); return; }
  await firstCard.click({ button: 'right' });
  await page.waitForTimeout(500);

  // Inspect menu
  const labels = await page.$$eval('.ctx-menu .ctx-menu-label', els => els.map(e => e.textContent.trim()));
  log(`Menu labels: ${JSON.stringify(labels)}`);

  // Click "Remove from" item
  const removeIdx = labels.findIndex(l => l.startsWith('Remove from'));
  log(`Remove index: ${removeIdx}`);
  if (removeIdx < 0) { log('No remove action!'); await browser.close(); return; }

  // Monitor the request
  const reqPromise = page.waitForRequest(r => r.url().includes('/remove-by-name') && r.method() === 'POST', { timeout: 8000 }).catch(() => null);
  // Click by text content
  await page.click('.ctx-menu .ctx-menu-item:has-text("Remove from")');
  const req = await reqPromise;
  log(`Remove request fired: ${req ? req.url() : 'NO'}`);

  await page.waitForTimeout(3000);
  await browser.close();
})();
