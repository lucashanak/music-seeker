// The user's volume must sit on BOTH decks of the DJ engine. The full-player slider and
// the mute button used to set only the deck that was playing: the next transition faded
// into the other deck's old level (reported 2026-11-19 as "the volume stayed lowered
// after a transition until I moved the slider"), and a mute came back as a silent track.
//
// Oracle: production, account claude_test.   node tests/e2e/audit/volume_decks.mjs [--tree]
import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';
import { serveWorktree, URL as BASE, USER, PASS } from '/home/lucas/music-seeker/tests/e2e/audit/helpers.mjs';

const TREE = process.argv.includes('--tree') ? '/home/lucas/music-seeker' : null;
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const browser = await pw.chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (TREE) await serveWorktree(context, TREE);
  const page = await context.newPage();
  await page.addInitScript(() => { localStorage.setItem('ms_device_id', 'e2e-volume'); localStorage.setItem('ms_player_engine', 'dj'); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#loginUser'); await page.waitForTimeout(2500);
  await page.fill('#loginUser', USER); await page.fill('#loginPass', PASS); await page.click('button:has-text("Sign In")');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#loginScreen')).display === 'none', null, { timeout: 25000 });
  await page.waitForTimeout(1500);

  const vols = () => page.evaluate(() => [...document.querySelectorAll('audio')].map(a => Math.round(a.volume * 100)));
  const slide = (sel, pct) => page.evaluate(([s, v]) => {
    const el = document.querySelector(s); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [sel, pct]);

  check('the engine has two decks in the page', (await vols()).length === 2, JSON.stringify(await vols()));

  await slide('#playerVolume', 80);
  check('bar slider: both decks', (await vols()).every(v => v === 80), JSON.stringify(await vols()));

  await slide('#fpVolume', 40);
  check('full-player slider: both decks', (await vols()).every(v => v === 40), JSON.stringify(await vols()));

  await page.evaluate(() => document.querySelector('#playerMute, #fpMute').click());
  check('mute: both decks silent', (await vols()).every(v => v === 0), JSON.stringify(await vols()));
  await page.evaluate(() => document.querySelector('#playerMute, #fpMute').click());
  check('unmute: both decks back at the level before', (await vols()).every(v => v === 40), JSON.stringify(await vols()));

  await slide('#fpVolume', 100);
  check('back to full: both decks', (await vols()).every(v => v === 100), JSON.stringify(await vols()));
} finally { await browser.close(); }

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
