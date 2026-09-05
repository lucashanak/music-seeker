// test_contextmenu.mjs — Verify universal context menu on search, queue, rec items
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const SHOTS = '/tmp/ctx-shots';
fs.mkdirSync(SHOTS, { recursive: true });

function log(m) { console.log(m); }
function ok(m) { console.log(`  ✅ ${m}`); }
function bad(m) { console.log(`  ❌ ${m}`); failures.push(m); }

const failures = [];

async function login(page) {
  await page.goto(BASE);
  await page.waitForSelector('#loginUser', { timeout: 8000 });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#searchInput', { timeout: 8000 });
}

async function search(page, q) {
  await page.fill('#searchInput', q);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#searchResults .card', { timeout: 10000 });
}

async function rightClickFirstCard(page) {
  const card = await page.$('#searchResults .card');
  if (!card) throw new Error('No card in search results');
  const box = await card.boundingBox();
  await page.mouse.click(box.x + 40, box.y + 40, { button: 'right' });
}

async function ctxMenuVisible(page) {
  return await page.$('.ctx-menu') != null;
}

async function ctxMenuLabels(page) {
  return await page.$$eval('.ctx-menu .ctx-menu-label', els => els.map(e => e.textContent.trim()));
}

async function closeCtxMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });

  try {
    log('▶ Login');
    await login(page);
    ok('Logged in');

    // Clear any leftover queue from prior runs
    await page.evaluate(async () => {
      const tok = localStorage.getItem('ms_token');
      await fetch('/api/player/queue', { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
    });

    log('▶ Search & open context menu on track card');
    await search(page, 'daft punk one more time');
    await page.waitForTimeout(800);
    await rightClickFirstCard(page);
    await page.waitForTimeout(200);
    if (await ctxMenuVisible(page)) {
      const labels = await ctxMenuLabels(page);
      ok(`Context menu visible with ${labels.length} actions: ${labels.join(', ')}`);
      const needed = ['Play', 'Add to playlist', 'Download'];
      for (const n of needed) {
        if (labels.some(l => l.includes(n))) ok(`Has "${n}"`);
        else bad(`Missing "${n}"`);
      }
    } else {
      bad('Context menu did not appear on track card');
    }
    await page.screenshot({ path: `${SHOTS}/01-track-ctx.png` });
    await closeCtxMenu(page);

    log('▶ Click "Add to playlist" via context menu');
    await rightClickFirstCard(page);
    await page.waitForTimeout(200);
    // Find "Add to playlist" button
    const addBtn = await page.$('.ctx-menu .ctx-menu-item:has-text("Add to playlist")');
    if (addBtn) {
      await addBtn.click();
      await page.waitForTimeout(800);
      const queueLen = await page.evaluate(() => {
        // store is module-private; read DOM instead
        const items = document.querySelectorAll('#queueList .queue-item, #fpQueueList .queue-item');
        return items.length;
      });
      // Open queue panel to verify
      const queueBtn = await page.$('#playerQueueBtn, #queueOpenBtn, [data-action="open-queue"]');
      if (queueBtn) await queueBtn.click();
      await page.waitForTimeout(400);
      const qItems = await page.$$('#queueList .queue-item, #fpQueuePanelList .queue-item');
      if (qItems.length > 0) ok(`Queue has ${qItems.length} item(s) after add`);
      else bad('Queue still empty after "Add to playlist"');
      await page.screenshot({ path: `${SHOTS}/02-queue-added.png` });
    } else {
      bad('Could not find "Add to playlist" button in menu');
    }

    log('▶ Right-click on queue item');
    // Open queue panel via the visible button if not already
    const fpOpenBtn = await page.$('#fpQueueToggleBtn, #playerQueueToggle, .player-queue-btn, button[title*="Queue" i]');
    if (fpOpenBtn) { await fpOpenBtn.click().catch(() => {}); await page.waitForTimeout(400); }
    let qItem = await page.$('#fpQueuePanelList .queue-item, #fpQueueList .queue-item, #queueList .queue-item');
    if (qItem) {
      await qItem.scrollIntoViewIfNeeded().catch(() => {});
      await qItem.click({ button: 'right' }).catch(async () => {
        const box = await qItem.boundingBox();
        if (box) await page.mouse.click(box.x + 80, box.y + 20, { button: 'right' });
      });
      await page.waitForTimeout(300);
      if (await ctxMenuVisible(page)) {
        const labels = await ctxMenuLabels(page);
        ok(`Queue context menu: ${labels.join(', ')}`);
        if (labels.some(l => l.includes('Remove from playlist'))) ok('Has "Remove from playlist"');
        else bad('Missing "Remove from playlist"');
        if (labels.some(l => l.includes('Add to other playlist'))) ok('Has "Add to other playlist"');
        else bad('Missing "Add to other playlist"');
      } else {
        bad('Queue context menu did not appear');
      }
      await page.screenshot({ path: `${SHOTS}/03-queue-ctx.png` });
      await closeCtxMenu(page);
    } else {
      bad('No queue items found to right-click');
    }

    log('▶ Escape closes the menu');
    await rightClickFirstCard(page);
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (!(await ctxMenuVisible(page))) ok('Escape closed menu');
    else bad('Escape did not close menu');

    log('▶ Click outside closes the menu');
    await rightClickFirstCard(page);
    await page.waitForTimeout(200);
    await page.mouse.click(10, 10);
    await page.waitForTimeout(200);
    if (!(await ctxMenuVisible(page))) ok('Outside click closed menu');
    else bad('Outside click did not close menu');

    log('▶ Mobile-style long-press simulation');
    // Touch emulation
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const mp = await mobile.newPage();
    mp.on('pageerror', e => console.log(`[mobile pageerror] ${e.message}`));
    await mp.goto(BASE);
    await mp.waitForSelector('#loginUser', { timeout: 8000 });
    await mp.fill('#loginUser', USER);
    await mp.fill('#loginPass', PASS);
    await mp.click('#loginBtn');
    await mp.waitForSelector('#searchInput', { timeout: 8000 });
    await mp.fill('#searchInput', 'beatles');
    await mp.keyboard.press('Enter');
    await mp.waitForSelector('#searchResults .card', { timeout: 10000 });
    const mcard = await mp.$('#searchResults .card');
    const mbox = await mcard.boundingBox();
    // Dispatch touch events for long-press
    await mp.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, radiusX: 5, radiusY: 5, force: 1 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true, cancelable: true }));
    }, { x: mbox.x + 60, y: mbox.y + 60 });
    await mp.waitForTimeout(600); // > LONG_PRESS_MS
    if (await mp.$('.ctx-menu')) ok('Long-press opened menu on mobile');
    else bad('Long-press did not open menu (mobile)');
    await mp.screenshot({ path: `${SHOTS}/04-mobile-ctx.png` });
    await mobile.close();

  } catch (e) {
    bad(`Exception: ${e.message}\n${e.stack}`);
  }

  await browser.close();

  console.log('\n──────── SUMMARY ────────');
  console.log(`Failures: ${failures.length}`);
  if (failures.length) {
    failures.forEach(f => console.log(`  ❌ ${f}`));
    process.exit(1);
  }
  console.log('All checks passed.');
})();
