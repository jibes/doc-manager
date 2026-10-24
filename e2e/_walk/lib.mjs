import { chromium } from 'playwright-core';
import { mkdirSync, appendFileSync } from 'node:fs';
export const BASE = 'http://localhost:8081';
export const OUT = '/tmp/claude-0/audit2-ui/';
mkdirSync(OUT, { recursive: true });
export const FIX = '/home/user/doc-reader/e2e/fixtures/';
export const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', env: { ...process.env, LANG: 'C.UTF-8' } });
export const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 900, height: 1200 }, desktop: { width: 1440, height: 900 } };
export async function ctxFor({ size = 'desktop', scheme = 'light', locale = 'en-US', folder = 'Library' } = {}) {
  const mobile = size === 'phone';
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: scheme, locale, acceptDownloads: true });
  await ctx.addInitScript((folder) => {
    delete window.showOpenFilePicker;
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(window.__pick ?? folder, { create: true });
  }, folder);
  return ctx;
}
export function watch(page, name) {
  const log = (s) => { appendFileSync(OUT + 'console.log', `[${name}] ${s}\n`); };
  page.on('pageerror', (e) => log('PAGEERROR ' + e.message.slice(0, 500)));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && log(m.type().toUpperCase() + ' ' + m.text().slice(0, 500)));
  return (n) => page.screenshot({ path: `${OUT}${name}-${n}.png` }).catch((e) => console.log('shot fail', n, e.message));
}
export const vis = (page, id) => page.getByTestId(id).locator('visible=true').first();
export const docRows = (page) => page.locator('[data-testid="archive-hit"]:visible');
export async function keepOpen(page) {
  const keep = page.getByTestId('menu-keep').locator('visible=true');
  if (!(await keep.count())) await page.getByTestId('open-more').locator('visible=true').click();
  await keep.click({ timeout: 4000 }).catch((e) => console.log('keep fail', e.message.slice(0, 100)));
  await page.waitForTimeout(800);
}
export async function openFile(page, file, { keep = true } = {}) {
  await vis(page, 'add-menu').click();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('action-add-open').click()]);
  await fc.setFiles(file.startsWith('/') ? file : FIX + file);
  await page.getByTestId('reader').or(page.getByTestId('text-view')).first().waitFor({ timeout: 15000 });
  if (keep) await keepOpen(page);
}
export async function more(page, key) {
  const own = page.getByTestId(`more-${key}`).locator('visible=true');
  if (await own.count()) return own.first().click();
  await vis(page, 'docs-more').click();
  await page.getByTestId(`action-more-${key}`).click();
}
export async function chooseTessel(page) {
  await vis(page, 'home-settings').click();
  await vis(page, 'tessel-folder').waitFor();
  const before = await vis(page, 'tessel-folder').innerText();
  await vis(page, 'tessel-folder').click();
  await page.getByTestId('action-tessel-choose').click({ timeout: 1500 }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    const s = page.getByTestId('action-tessel-move');
    if (await s.count()) { await s.click(); break; }
    if ((await vis(page, 'tessel-folder').innerText()) !== before) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  return { before, after: await vis(page, 'tessel-folder').innerText() };
}
export async function painted(page) {
  return page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 300), null, { timeout: 15000 }).then(() => true, () => false);
}
