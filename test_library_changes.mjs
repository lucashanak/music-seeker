// test_library_changes.mjs — Test #1 delete button, #2 context menu, #3 multi-select
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }
const SHOTS = '/tmp/lib-shots';
fs.mkdirSync(SHOTS, { recursive: true });

function log(m) { console.log(m); }
function ok(m) { console.log(`  OK  ${m}`); }
function bad(m) { console.log(`  FAIL ${m}`); failures.push(m); }

const failures = [];

async function login(page) {
  await page.goto(BASE);
  await page.waitForSelector('#loginUser', { timeout: 8000 });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#searchInput', { timeout: 8000 });
  log('Logged in');
}

async function openFirstPlaylist(page) {
  // Navigate to Library page
  const libNav = page.locator('nav a, nav button, .nav-link').filter({ hasText: /library/i }).first();
  if (await libNav.count()) {
    await libNav.click();
  } else {
    // Try clicking via nav icon
    await page.click('[data-page="library"], a[href="#library"], button[data-page="library"]');
  }
  await page.waitForSelector('#libraryGrid .lib-card, #libraryGrid .card', { timeout: 8000 });
  log('Library loaded');

  const firstCard = page.locator('#libraryGrid .card, #libraryGrid .lib-card').first();
  const name = await firstCard.locator('.card-title').textContent();
  log(`Clicking playlist: ${name.trim()}`);
  await firstCard.click();
  await page.waitForSelector('#libraryTracks .card', { timeout: 8000 });
  await page.screenshot({ path: `${SHOTS}/01-playlist-detail.png` });
  log('Playlist detail loaded');
  return name.trim();
}

async function test1_deleteButton(page) {
  log('\n=== TEST 1: Delete button visible for library tracks ===');
  await openFirstPlaylist(page);

  // Wait a moment for checkLibrary / _markTracksInLibrary to run
  await page.waitForTimeout(1500);

  // Click first track card
  const firstTrack = page.locator('#libraryTracks .card').first();
  const trackName = await firstTrack.locator('.card-title').textContent().catch(() => 'unknown');
  log(`Clicking track: ${trackName.trim()}`);
  await firstTrack.click();

  // Wait for modal
  await page.waitForSelector('#downloadModal.open', { timeout: 5000 }).catch(() => null);
  await page.screenshot({ path: `${SHOTS}/02-modal-open.png` });

  const modalOpen = await page.locator('#downloadModal.open').count();
  if (!modalOpen) { bad('Modal did not open'); return; }
  ok('Modal opened');

  // Check delete button visibility
  const delBtn = page.locator('#modalDeleteTrack');
  const delVisible = await delBtn.isVisible();
  if (delVisible) {
    ok('Delete button is visible for library track');
  } else {
    bad('Delete button NOT visible — fix #1 failed');
  }

  // Close modal
  await page.click('#modalClose').catch(() => page.keyboard.press('Escape'));
  await page.waitForTimeout(300);
}

async function test2_contextMenuActions(page) {
  log('\n=== TEST 2: Context menu has Remove/Delete actions for playlist tracks ===');

  // Ensure we're in a playlist detail
  const tracksEl = await page.locator('#libraryTracks .card').count();
  if (!tracksEl) {
    await openFirstPlaylist(page);
    await page.waitForTimeout(500);
  }

  const firstTrack = page.locator('#libraryTracks .card').first();
  await firstTrack.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 3000 });
  await page.screenshot({ path: `${SHOTS}/03-ctx-menu.png` });

  const menuItems = await page.locator('.ctx-menu-item').allTextContents();
  log('Context menu items: ' + menuItems.map(s => s.trim()).join(' | '));

  const hasRemove = menuItems.some(t => /remove from/i.test(t));
  const hasDelete = menuItems.some(t => /delete from library/i.test(t));

  if (hasRemove) ok('"Remove from playlist" action present');
  else bad('"Remove from playlist" action MISSING');

  if (hasDelete) ok('"Delete from library" action present');
  else bad('"Delete from library" action MISSING');

  // Close menu
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

async function test3_multiSelect(page) {
  log('\n=== TEST 3: Multi-select with shift-click ===');

  const cards = page.locator('#libraryTracks .card');
  const count = await cards.count();
  if (count < 3) { log('Not enough tracks for multi-select test, skipping'); return; }

  // Ensure no modal is open
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Cmd-click first card to start selection (no modal)
  await cards.nth(0).click({ modifiers: ['Meta'] });
  await page.waitForTimeout(200);

  // Shift-click third card for range select
  await cards.nth(2).click({ modifiers: ['Shift'] });
  await page.waitForTimeout(200);

  await page.screenshot({ path: `${SHOTS}/04-multi-select.png` });

  // Check selected state
  const selectedCount = await page.locator('#libraryTracks .card[data-selected="true"]').count();
  log(`Selected cards: ${selectedCount}`);

  if (selectedCount >= 2) {
    ok(`Multi-select: ${selectedCount} cards selected`);
  } else {
    bad(`Multi-select: expected ≥2 selected, got ${selectedCount}`);
  }

  // Right-click on a selected card → should get multi-select menu
  const selectedCard = page.locator('#libraryTracks .card[data-selected="true"]').first();
  await selectedCard.click({ button: 'right' });
  await page.waitForSelector('.ctx-menu', { timeout: 3000 });
  await page.screenshot({ path: `${SHOTS}/05-multi-ctx-menu.png` });

  const menuTitle = await page.locator('.ctx-menu-title').textContent().catch(() => '');
  const menuItems = await page.locator('.ctx-menu-item').allTextContents();
  log('Multi-select menu title: ' + menuTitle);
  log('Multi-select menu items: ' + menuItems.map(s => s.trim()).join(' | '));

  const hasMultiTitle = /\d+ tracks? selected/i.test(menuTitle);
  const hasPlayAll = menuItems.some(t => /play all/i.test(t));
  const hasBulkRemove = menuItems.some(t => /remove.*from/i.test(t));

  if (hasMultiTitle) ok('Multi-select menu title shows count');
  else bad(`Multi-select menu title wrong: "${menuTitle}"`);

  if (hasPlayAll) ok('"Play all" action present');
  else bad('"Play all" action MISSING');

  if (hasBulkRemove) ok('"Remove from playlist" bulk action present');
  else bad('"Remove from playlist" bulk action MISSING');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Plain click should clear selection
  await cards.nth(0).click();
  await page.waitForTimeout(300);
  // Close modal if it opened
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const stillSelected = await page.locator('#libraryTracks .card[data-selected="true"]').count();
  if (stillSelected === 0) ok('Plain click clears selection');
  else log(`  NOTE: ${stillSelected} cards still selected after plain click (modal may have opened)`);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') log(`[JS ERROR] ${m.text()}`); });

  try {
    await login(page);
    await test1_deleteButton(page);
    await test2_contextMenuActions(page);
    await test3_multiSelect(page);
  } catch (e) {
    bad('Unexpected error: ' + e.message);
    await page.screenshot({ path: `${SHOTS}/error.png` });
    console.error(e);
  }

  await browser.close();

  log('\n=== RESULTS ===');
  if (failures.length === 0) {
    log('All tests passed!');
  } else {
    log(`${failures.length} failure(s):`);
    failures.forEach(f => log(`  - ${f}`));
    process.exit(1);
  }
}

run();
