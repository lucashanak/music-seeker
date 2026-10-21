// Sdílený postroj pro kontroly z UX auditu (notes/impl/audit-2026-10/).
//
// Oracle téhle série je produkce: kontrola musí PADAT proti nasazenému starému
// kódu a PROCHÁZET po nasazení. Proto tu není žádný mock — jede se proti živé
// instanci účtem claude_test.
//
// Vlastní vedení dávky. Autoři celků ho needitují; když potřebují něco navíc,
// napíšou si to ve svém souboru nebo o změnu požádají.

import pw from '/home/lucas/music-seeker/node_modules/playwright/index.js';

const { chromium, devices } = pw;

export const URL = process.env.MS_URL || 'https://musicseeker.hanaktech.org';
export const USER = 'claude_test';
export const PASS = 'TestPass2026!';

// Tři režimy, ve kterých musí dávka obstát. Tablet na šířku je past: leží NAD
// breakpointem 640 px, takže dostane desktopová pravidla (ovládání odkryté až
// při hoveru, sloupce tlačítek) na zařízení, které hover nemá.
export const VIEWPORTS = {
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { width: 1280, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

export const SHOT_DIR = process.env.MS_SHOTS || '/tmp/ms-audit-shots';

/**
 * Přihlásí se a vrátí { browser, context, page, cdp }.
 * `waitUntil: 'load'` plus usazení: s 'domcontentloaded' klik na Sign In předběhl
 * navěšení handleru a požadavek na /api/auth/login nikdy neodešel.
 */
export async function open({ viewport = 'desktop', device = 'audit', login = true } = {}) {
  const vp = typeof viewport === 'string' ? VIEWPORTS[viewport] : viewport;
  if (!vp) throw new Error(`neznámý viewport: ${viewport}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    userAgent: vp.isMobile ? devices['Pixel 5'].userAgent : undefined,
  });
  const page = await context.newPage();
  // Vlastní id zařízení na dráhu: fronta a Up Next jsou per-zařízení, takže dvě
  // dráhy se stejným id si navzájem přepisují playlist.
  await page.addInitScript((d) => localStorage.setItem('ms_device_id', d), `e2e-${device}`);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(URL, { waitUntil: 'load' });
  if (login) {
    await page.waitForSelector('#loginUser', { timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.fill('#loginUser', USER);
    await page.fill('#loginPass', PASS);
    await page.click('button:has-text("Sign In")');
    await page.waitForFunction(() => {
      const l = document.querySelector('#loginScreen');
      return l && getComputedStyle(l).display === 'none';
    }, { timeout: 25000 });
    await page.waitForTimeout(1200);
  }
  return { browser, context, page, errors, viewport: vp };
}

/** Vyhledání; `type` přepne záložku (track/album/artist/playlist/show). */
export async function search(page, q, type) {
  await page.fill('#searchInput', q);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  if (type) {
    await page.click(`.type-btn[data-type="${type}"]`);
    await page.waitForTimeout(3500);
  }
}

/** Klikne na položku v navigaci; pod 640 px je horní lišta skrytá, dole je bnav. */
export async function goPage(page, name) {
  await page.evaluate((n) => {
    const b = [...document.querySelectorAll(`.bnav-btn[data-page="${n}"], .nav-btn[data-page="${n}"]`)]
      .find((x) => x.offsetParent !== null);
    if (!b) throw new Error(`navigace: ${n} není vidět`);
    b.click();
  }, name);
  await page.waitForTimeout(2500);
}

/** Skutečný dotykový tah přes CDP — myší se gesta v tomhle UI netestují. */
export async function swipe(context, page, { x, fromY, toY, steps = 14 }) {
  const cdp = await context.newCDPSession(page);
  const dy = (toY - fromY) / steps;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: fromY + dy * i }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(600);
}

// ── Sběr výsledků ───────────────────────────────────────────────────────────
// Kontrola je dvojice (co tvrdím, čím to dokládám). `detail` se tiskne vždy,
// i u PASS — bez čísla se výsledek nedá přečíst zpětně.

export function makeReport(nazev) {
  const rows = [];
  return {
    check(id, popis, ok, detail) {
      rows.push({ id, popis, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${popis}${detail !== undefined ? `  ${detail}` : ''}`);
      return !!ok;
    },
    skip(id, popis, duvod) {
      rows.push({ id, popis, ok: null, detail: `PŘESKOČENO: ${duvod}` });
      console.log(`SKIP  ${id}  ${popis}  (${duvod})`);
    },
    rows,
    done() {
      const pass = rows.filter((r) => r.ok === true).length;
      const fail = rows.filter((r) => r.ok === false).length;
      const skip = rows.filter((r) => r.ok === null).length;
      console.log(`\n${nazev}: ${pass} prošlo, ${fail} padlo, ${skip} přeskočeno`);
      console.log(`JSON ${JSON.stringify({ nazev, pass, fail, skip, rows })}`);
      return fail === 0;
    },
  };
}
