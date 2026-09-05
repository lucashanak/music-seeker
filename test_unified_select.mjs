// test_unified_select.mjs — Verify unified checkbox/_selectSet state in playlist detail
// Usage: node test_unified_select.mjs
// Does NOT fail the process on Navidrome state mismatches — logs outcomes only.

import { chromium } from 'playwright';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const PLAYLIST_NAME = 'MyZouk';

async function login(page) {
  await page.goto(BASE);
  await page.fill('input[name="username"], input[type="text"]', USER);
  await page.fill('input[name="password"], input[type="password"]', PASS);
  await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
  await page.waitForTimeout(1500);
}

async function openPlaylist(page, name) {
  // Click Library tab
  await page.click('[data-tab="library"], button:has-text("Library"), a:has-text("Library")');
  await page.waitForTimeout(1000);
  // Find playlist card
  const card = page.locator(`.lib-card, .card`).filter({ hasText: name }).first();
  await card.click();
  await page.waitForTimeout(1500);
}

async function getCards(page) {
  return page.locator('#libraryTracks .card').all();
}

async function getSelectCount(page) {
  const text = await page.locator('#libBulkCount').textContent().catch(() => '0 selected');
  const m = text.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

async function getSelectedDataAttr(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#libraryTracks .card'))
      .map(c => c.dataset.selected === 'true')
  );
}

async function getCheckboxStates(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#libraryTracks .card .lib-bulk-cb'))
      .map(cb => cb.checked)
  );
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.error(`  FAIL: ${msg}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });

  try {
    console.log('--- Login ---');
    await login(page);
    console.log('  OK');

    console.log(`--- Open playlist: ${PLAYLIST_NAME} ---`);
    await openPlaylist(page, PLAYLIST_NAME);
    const cards = await getCards(page);
    const total = cards.length;
    console.log(`  Found ${total} tracks`);
    if (total < 4) {
      console.warn(`  WARNING: Need at least 4 tracks for full test; got ${total}. Some steps may be skipped.`);
    }

    // ── Step 1: Click 3 checkboxes ──
    console.log('\n--- Step 1: Click 3 checkboxes ---');
    for (let i = 0; i < Math.min(3, total); i++) {
      const cb = page.locator(`#libraryTracks .card`).nth(i).locator('.lib-bulk-cb');
      await cb.click({ force: true });
      await page.waitForTimeout(200);
    }
    const count1 = await getSelectCount(page);
    const sel1 = await getSelectedDataAttr(page);
    const cbs1 = await getCheckboxStates(page);
    const expected1 = Math.min(3, total);
    assert(count1 === expected1, `Bulk bar shows "${expected1} selected" (got ${count1})`);
    assert(sel1.slice(0, expected1).every(v => v), `First ${expected1} cards have data-selected="true"`);
    assert(cbs1.slice(0, expected1).every(v => v), `First ${expected1} checkboxes are checked`);

    // ── Step 2: Shift-click 4th card ──
    if (total >= 4) {
      console.log('\n--- Step 2: Shift-click 4th card ---');
      const card3 = page.locator('#libraryTracks .card').nth(3);
      await card3.click({ modifiers: ['Shift'] });
      await page.waitForTimeout(300);
      const count2 = await getSelectCount(page);
      const cbs2 = await getCheckboxStates(page);
      const sel2 = await getSelectedDataAttr(page);
      assert(count2 >= 4, `Bulk bar shows at least 4 selected (got ${count2})`);
      assert(cbs2[3], `4th card checkbox is checked after shift-click`);
      assert(sel2[3], `4th card has data-selected="true" after shift-click`);
    }

    // ── Step 3: Cmd-click a selected card to deselect ──
    console.log('\n--- Step 3: Cmd-click 1st card to deselect ---');
    const beforeCount = await getSelectCount(page);
    const card0 = page.locator('#libraryTracks .card').nth(0);
    await card0.click({ modifiers: ['Meta'] });
    await page.waitForTimeout(300);
    const count3 = await getSelectCount(page);
    const cbs3 = await getCheckboxStates(page);
    const sel3 = await getSelectedDataAttr(page);
    assert(count3 === beforeCount - 1, `Bulk bar decremented by 1 (was ${beforeCount}, now ${count3})`);
    assert(!cbs3[0], `1st card checkbox unchecked after cmd-click deselect`);
    assert(!sel3[0], `1st card data-selected removed after cmd-click deselect`);

    // ── Step 4: Right-click a selected card — context menu shows multi-select title ──
    console.log('\n--- Step 4: Right-click selected card → multi-select context menu ---');
    // Re-select card 0 first so we have a multi-selection
    await card0.click({ modifiers: ['Meta'] });
    await page.waitForTimeout(200);
    const countBefore4 = await getSelectCount(page);
    if (countBefore4 > 1) {
      // Right-click card 0 (which is now selected)
      await card0.click({ button: 'right' });
      await page.waitForTimeout(500);
      const menuTitle = await page.locator('.ctx-title, .context-menu-title, [class*="ctx"] [class*="title"]').first().textContent().catch(() => '');
      assert(menuTitle.includes('selected') || menuTitle.includes('tracks'), `Context menu title indicates multi-select (got: "${menuTitle}")`);
      // Dismiss menu
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      console.log('  SKIP: not enough selected tracks for multi-select menu test');
    }

    // ── Step 5: Master toggle select-all ──
    console.log('\n--- Step 5: Master toggle — select all ---');
    const masterToggle = page.locator('#libBulkToggle');
    await masterToggle.evaluate(el => { el.checked = false; el.indeterminate = false; });
    // Click it to select all
    await masterToggle.click();
    await page.waitForTimeout(400);
    const count5 = await getSelectCount(page);
    const cbs5 = await getCheckboxStates(page);
    assert(count5 === total, `Select-all: bulk bar shows ${total} selected (got ${count5})`);
    assert(cbs5.every(v => v), `Select-all: all ${total} checkboxes checked`);

    // ── Step 6: Master toggle uncheck — deselect all ──
    console.log('\n--- Step 6: Master toggle — deselect all ---');
    await masterToggle.click();
    await page.waitForTimeout(400);
    const count6 = await getSelectCount(page);
    const cbs6 = await getCheckboxStates(page);
    assert(count6 === 0, `Deselect-all: bulk bar shows 0 selected (got ${count6})`);
    assert(cbs6.every(v => !v), `Deselect-all: all checkboxes unchecked`);

    // ── Step 7: Indeterminate state ──
    console.log('\n--- Step 7: Indeterminate state on partial selection ---');
    const cb0 = page.locator('#libraryTracks .card').nth(0).locator('.lib-bulk-cb');
    await cb0.click({ force: true });
    await page.waitForTimeout(200);
    const isIndeterminate = await masterToggle.evaluate(el => el.indeterminate);
    const isChecked7 = await masterToggle.evaluate(el => el.checked);
    if (total > 1) {
      assert(isIndeterminate && !isChecked7, `Master toggle is indeterminate when 1 of ${total} selected`);
    } else {
      // Only 1 track: selecting it means "all" → should be checked, not indeterminate
      assert(!isIndeterminate && isChecked7, `Master toggle checked (all 1 tracks selected)`);
    }

    console.log('\n=== All steps completed ===');
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
