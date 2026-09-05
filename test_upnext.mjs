// test_upnext.mjs — Verify Stage 1A: Up Next temp playlist init + filter
import { chromium } from 'playwright';

const BASE = 'http://192.168.1.22:8090';
const USER = 'claude_test';
const PASS = process.env.MS_TEST_PASS;
if (!PASS) { console.error('Set MS_TEST_PASS before running this harness.'); process.exit(1); }

const failures = [];
const ok = m => console.log('  ✅ ' + m);
const bad = m => { console.log('  ❌ ' + m); failures.push(m); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));

  await page.goto(BASE);
  await page.waitForSelector('#loginUser', { timeout: 8000 });
  await page.fill('#loginUser', USER);
  await page.fill('#loginPass', PASS);
  await page.click('#loginBtn');
  await page.waitForSelector('#searchInput', { timeout: 8000 });
  ok('Logged in');

  // Wait for initUpNext to complete (it's async after initApp)
  await page.waitForTimeout(2000);

  const tok = await page.evaluate(() => localStorage.getItem('ms_token'));

  // 1. /api/library/upnext exists and returns a playlist
  const upnextResp = await fetch(`${BASE}/api/library/upnext`, { headers: { Authorization: `Bearer ${tok}` } });
  if (upnextResp.status !== 200) { bad(`upnext returned ${upnextResp.status}`); }
  else {
    const pl = await upnextResp.json();
    if (pl.id && pl.name && pl.name.startsWith('__upnext_lucas_')) {
      ok(`Up Next playlist created/found: id=${pl.id} name=${pl.name}`);
    } else {
      bad(`Unexpected upnext payload: ${JSON.stringify(pl)}`);
    }
  }

  // 2. /api/library/playlists hides __upnext_ entries
  const listResp = await fetch(`${BASE}/api/library/playlists`, { headers: { Authorization: `Bearer ${tok}` } });
  const list = await listResp.json();
  const leaked = (list.playlists || []).filter(p => (p.name || '').startsWith('__upnext_'));
  if (leaked.length === 0) ok(`/playlists hides Up Next (${list.playlists.length} visible)`);
  else bad(`Up Next leaked into /playlists: ${leaked.map(p => p.name).join(', ')}`);

  // 3. Frontend UI badge reflects Up Next (read DOM since modules are URL-versioned)
  await page.waitForTimeout(1000); // let initUpNext finish
  const badgeText = await page.evaluate(() => {
    const el = document.getElementById('fpPlaylistBadge');
    return el ? { text: el.textContent, visible: el.style.display !== 'none' && el.offsetParent !== null } : null;
  });
  if (badgeText && badgeText.text === 'Up Next') ok(`fpPlaylistBadge shows "Up Next"`);
  else bad(`fpPlaylistBadge not "Up Next": ${JSON.stringify(badgeText)}`);

  // Read playlistMode via API (queue state contains it after save)
  const playlistMode = badgeText;

  // 4. replace-by-name endpoint accepts a track list
  const upnextResp2 = await fetch(`${BASE}/api/library/upnext`, { headers: { Authorization: `Bearer ${tok}` } });
  const upnextPl = upnextResp2.ok ? await upnextResp2.json() : null;
  if (upnextPl && upnextPl.id) {
    const replaceResp = await fetch(`${BASE}/api/library/playlist/${upnextPl.id}/replace-by-name`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracks: [{ name: 'NonExistentTrackXYZ', artist: 'NobodyArtist' }] }),
    });
    if (replaceResp.status === 200) {
      const r = await replaceResp.json();
      if (r.matched === 0 && r.missing && r.missing.length === 1) ok(`replace-by-name handles missing tracks: matched=${r.matched} missing=${r.missing.length}`);
      else bad(`Unexpected replace response: ${JSON.stringify(r)}`);
    } else {
      bad(`replace-by-name returned ${replaceResp.status}`);
    }
  }

  await browser.close();
  console.log(`\nFailures: ${failures.length}`);
  if (failures.length) process.exit(1);
})();
