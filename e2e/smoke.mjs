// End-to-end smoke test against a running web build (default: expo dev server on :8081).
// Usage: BASE=http://localhost:8081 node e2e/smoke.mjs
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:8081';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Use a preinstalled Chromium when present, else Playwright's own (`npx playwright-core install chromium`).
const preinstalled = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(preinstalled) ? { executablePath: preinstalled } : {});
const errors = [];
let failures = 0;

function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
}

async function run(name, viewport, isMobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile, hasTouch: isMobile, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (errors.push(`${name}: ${e.message}`), console.log('pageerror:', e.message.slice(0, 400))));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && (errors.push(`${name}: ${m.text()}`), console.log('console:', m.text().slice(0, 600))));
  const shot = (n) => page.screenshot({ path: `${OUT}${name}-${n}.png` });

  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await page.waitForTimeout(700);
  await shot('1-empty');

  await page.getByTestId('sample').click();
  await page.getByTestId('reader').waitFor();
  const t0 = Date.now();
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 300), null, { timeout: 15000 });
  check(true, `${name}: first page painted in ${Date.now() - t0} ms after reader mount`);
  await page.waitForTimeout(500);
  await shot('2-reader');

  // Scroll a few pages and confirm the indicator follows.
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 700);
  await page.waitForTimeout(600);
  const label = await page.getByTestId('page-label').innerText().catch(() => '');
  check(parseInt(label, 10) >= 3, `${name}: page indicator advanced (${label.replace(/\s+/g, ' ')})`);
  // Plain viewer: the toolbar never hides.
  check(await page.getByTestId('open-contents').isVisible(), `${name}: viewer keeps toolbar visible after scrolling`);

  if (!isMobile) {
    // Text layer: drag-select a heading and read the selection back.
    await page.waitForSelector('[data-testid=text-layer] span', { timeout: 10000 });
    const span = page.locator('[data-testid=text-layer] span', { hasText: /^Opening files$/ }).first();
    await span.scrollIntoViewIfNeeded();
    const sb = await span.boundingBox();
    await page.mouse.move(sb.x + 1, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width - 1, sb.y + sb.height / 2, { steps: 6 });
    await page.mouse.up();
    const sel = await page.evaluate(() => getSelection().toString().trim());
    check(sel === 'Opening files', `${name}: text selection → "${sel}"`);
    await page.evaluate(() => getSelection().removeAllRanges());

    // Links: internal jumps; external is exposed with its URL.
    await page.getByTestId('page-label').click();
    await page.getByTestId('page-input').fill('3');
    await page.getByTestId('page-input').press('Enter');
    await page.getByTestId('link-page').first().click();
    await page.waitForTimeout(600);
    check(parseInt(await page.getByTestId('page-label').innerText(), 10) === 7, `${name}: internal link jumps to page 7`);
    const url = await page.getByTestId('link-url').first().getAttribute('aria-label');
    check(/github\.com\/jibes\/doc-reader/.test(url ?? ''), `${name}: external link detected (${url})`);

    // Download from the menu; print via the shortcut prints the PDF, not the app.
    await page.getByTestId('open-more').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-download').click()]);
    check(dl.suggestedFilename() === 'welcome-to-tessel.pdf', `${name}: download keeps the file name (${dl.suggestedFilename()})`);
    await page.keyboard.press('Control+p');
    const frame = await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.src.startsWith('blob:')), null, { timeout: 5000 }).then(() => true, () => false);
    check(frame, `${name}: print loads the PDF into a print frame`);
    await page.keyboard.press('Home');
  }

  // Reading-list documents hide chrome while reading forward; a short scroll back reveals it.
  const reveal = async () => {
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(350);
  };
  await reveal();
  await page.getByTestId('open-contents').click();
  await page.getByTestId('contents-panel').waitFor();
  await page.waitForTimeout(400);
  await shot('3-contents');
  await page.getByTestId('contents-panel').getByText('The reading list', { exact: true }).click();
  await page.waitForTimeout(500);
  const afterToc = await page.getByTestId('page-label').innerText().catch(() => '');
  check(parseInt(afterToc, 10) === 5, `${name}: TOC jump to "The reading list" → page ${parseInt(afterToc, 10)}`);
  if (!isMobile) await page.getByTestId('open-contents').click();

  await reveal();
  await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => document.body.innerText.match(/\d+ results?/), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  await page.getByTestId('search-input').press('Enter');
  await page.waitForTimeout(700);
  await shot('4-search');
  const status = await page.getByText(/results?$/).first().innerText();
  check(/of \d+ results?/.test(status), `${name}: search "${status}"`);
  await page.keyboard.press('Escape');

  // Find-in-page persists after the panel closes: highlights stay, the bar steps and clears.
  await page.getByTestId('find-bar').waitFor();
  const marks = await page.evaluate(() => [...document.querySelectorAll('[data-testid=hits]')].reduce((n, c) => n + Number(c.dataset.count), 0));
  const activeShown = await page.evaluate(() => [...document.querySelectorAll('[data-testid=hits]')].some((c) => c.dataset.active === 'true'));
  check(marks > 0 && activeShown, `${name}: ${marks} highlights on page with panel closed`);
  const nth = async () => parseInt((await page.getByTestId('find-bar').innerText()).match(/(\d+) of/)?.[1] ?? '0', 10);
  const before = await nth();
  await page.getByTestId('find-next').click();
  await page.waitForTimeout(500);
  const after = await nth();
  check(after === before + 1 || (after === 1 && before > 1), `${name}: find bar stepped ${before} → ${after}`);
  await shot('4b-findbar');
  await page.getByTestId('find-clear').click();
  await page.waitForTimeout(300);
  check((await page.locator('[data-testid=hits]').count()) === 0 && !(await page.getByTestId('find-bar').isVisible().catch(() => false)), `${name}: clearing removes highlights`);

  await reveal();
  await page.getByTestId('open-appearance').click();
  await page.getByLabel('Black').click();
  await page.waitForTimeout(500);
  await shot('5-night');
  await page.getByLabel('Sepia').click();
  await page.waitForTimeout(400);
  await shot('6-sepia');
  await page.getByLabel('Automatic').click();
  await page.keyboard.press('Escape');

  // Text view: reflowed from the page you're on, footers gone, and back to the same page.
  await page.getByTestId('page-label').click();
  await page.getByTestId('page-input').fill('3');
  await page.getByTestId('page-input').press('Enter');
  await page.waitForTimeout(400);
  await page.getByTestId('view-toggle').click();
  await page.getByTestId('text-view').waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const textLabel = parseInt(await page.getByTestId('page-label').innerText(), 10);
  const flowText = await page.getByTestId('text-view').innerText();
  check(textLabel === 3 && flowText.includes('Finding your way'), `${name}: text view opens at page ${textLabel} with reflowed text`);
  await shot('5b-text');
  await page.getByTestId('view-toggle').click();
  await page.waitForTimeout(800);
  check(parseInt(await page.getByTestId('page-label').innerText(), 10) === 3, `${name}: back in page view at the same page`);
  if (!isMobile) {
    // Search hits live on pages: picking one from text view switches to page view.
    await page.getByTestId('view-toggle').click();
    await page.getByTestId('text-view').waitFor();
    await page.getByTestId('open-search').click();
    await page.getByTestId('search-input').fill('scrubber');
    await page.waitForFunction(() => /\d+ results?/.test(document.body.innerText), null, { timeout: 10000 });
    await page.getByTestId('search-input').press('Enter');
    await page.waitForTimeout(800);
    const backToPages = (await page.getByTestId('pages').count()) > 0 && (await page.getByTestId('text-view').count()) === 0;
    check(backToPages, `${name}: picking a search hit from text view shows it in page view`);
    await page.keyboard.press('Escape');
    await page.getByTestId('find-clear').click();
  }

  // Spine scrubber: press and drag to 75%.
  const box = await page.getByTestId('scrubber').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(400);
  await shot('7-scrub');
  await page.mouse.up();
  await page.waitForTimeout(600);
  const scrubbed = parseInt((await page.getByTestId('page-label').innerText()).trim(), 10);
  check(scrubbed >= 5, `${name}: scrubber seek → page ${scrubbed}`);

  await reveal();
  await page.getByTestId('bookmark').click();

  // Reading list: the toggle switches to reading behaviour (progress in the page pill).
  // On narrow screens it lives in the More menu.
  if (isMobile) {
    await page.getByTestId('open-more').click();
    await page.getByTestId('menu-reading').click();
  } else await page.getByTestId('reading-toggle').click();
  await page.waitForTimeout(300);
  check(/%/.test(await page.getByTestId('page-label').innerText()), `${name}: reading-list document shows progress`);
  await page.getByTestId('back').click();
  await page.getByTestId('continue').waitFor();
  check(await page.getByTestId('recent-row').first().isVisible(), `${name}: home shows Reading list and Recent`);
  await page.waitForTimeout(800);
  await shot('8-home');

  // Persistence: reload, reopen, expect the same page.
  await page.reload();
  await page.getByTestId('continue').click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(1200);
  const resumed = parseInt((await page.getByTestId('page-label').innerText()).trim(), 10);
  check(Math.abs(resumed - scrubbed) <= 1, `${name}: resumed at page ${resumed} (left at ${scrubbed})`);

  // Reaching the last page moves it to Finished.
  if (!isMobile) {
    await page.keyboard.press('End');
    await page.waitForTimeout(1200);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.getByText(/Finished · 1/).waitFor({ timeout: 5000 }).then(
      () => check(true, `${name}: last page moves the document to Finished`),
      () => check(false, `${name}: last page moves the document to Finished`),
    );
    await shot('9-finished');
  }
  await ctx.close();
}

// Encrypted PDFs: wrong password is rejected, right one opens, nothing is persisted.
async function locked() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`locked: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL('./fixtures/locked.pdf', import.meta.url).pathname);
  await page.getByTestId('password-input').fill('nope');
  await page.getByTestId('password-submit').click();
  const rejected = await page.getByText(/didn’t work/).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.getByTestId('password-input').fill('tessel');
  await page.getByTestId('password-submit').click();
  await page.getByTestId('reader').waitFor();
  const opened = await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 300), null, { timeout: 10000 }).then(() => true, () => false);
  // Reload on the home screen (static servers without SPA fallback can't reload deep links), then reopen.
  await page.getByTestId('back').click();
  await page.getByTestId('recent-row').first().waitFor();
  await page.reload();
  await page.getByTestId('recent-row').first().click();
  const asksAgain = await page.getByTestId('password-dialog').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(rejected && opened && asksAgain, `locked: wrong password rejected (${rejected}), right one opens (${opened}), asked again after reload (${asksAgain})`);
  await ctx.close();
}

// Tagged PDFs reflow from their structure: headings kept, running header/footer (artifacts) dropped.
async function tagged() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`tagged: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL('./fixtures/tagged.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('view-toggle').click();
  await page.getByTestId('text-view').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const text = await page.getByTestId('text-view').innerText();
  const ok = text.includes('Section 1.1') && !text.includes('running header') && !/^Page \d+$/m.test(text);
  check(ok, 'tagged: text view keeps headings and drops running header/footer');
  // The view choice is remembered per document (reload from home: CI's static server has no SPA fallback).
  await page.getByTestId('back').click();
  await page.getByTestId('recent-row').first().waitFor();
  await page.reload();
  await page.getByTestId('recent-row').first().click();
  await page.getByTestId('text-view').waitFor({ timeout: 15000 }).then(
    () => check(true, 'tagged: text view remembered after reload'),
    () => check(false, 'tagged: text view remembered after reload'),
  );
  await ctx.close();
}

// Interface language follows the OS/browser locale.
async function german() {
  const ctx = await browser.newContext({ locale: 'de-DE', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`german: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Jedes Dokument').waitFor();
  await page.getByTestId('sample').click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => /\d+ Treffer/.test(document.body.innerText), null, { timeout: 10000 });
  check((await page.locator('html').getAttribute('lang')) === 'de', 'german: UI and <html lang> follow de-DE locale');
  await ctx.close();
}

await german();
await locked();
await tagged();
await run('desktop', { width: 1440, height: 900 }, false);
await run('mobile', { width: 390, height: 844 }, true);
await browser.close();

for (const e of errors) console.log('console error:', e);
check(errors.length === 0, 'no console errors');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
