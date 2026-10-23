// End-to-end smoke test against a running web build (default: expo dev server on :8081).
// Usage: BASE=http://localhost:8081 node e2e/smoke.mjs
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:8081';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Use a preinstalled Chromium when present, else Playwright's own (`npx playwright-core install chromium`).
const preinstalled = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
// A UTF-8 locale, as CI has: without one, Chromium can't give files in its own storage names like “Zürich”.
const env = { ...process.env, LANG: process.env.LANG || 'C.UTF-8' };
const browser = await chromium.launch(existsSync(preinstalled) ? { executablePath: preinstalled, env } : { env });
const errors = [];
let failures = 0;

/**
 * Most checks use the copy-into-library path (Firefox, Safari, and Chromium without a picker):
 * Playwright can't answer the File System Access picker, so it's removed here and faked in linked().
 */
async function newContext(opts, { fsa = false } = {}) {
  const ctx = await browser.newContext(opts);
  if (!fsa) await ctx.addInitScript(() => delete window.showOpenFilePicker);
  return ctx;
}

/** Documents in the list (the app's one screen), last opened first. */
const docRows = (page) => page.locator('[data-testid="archive-hit"]:visible');

/** Page ↔ text view: the Text view button in the bar. */
async function switchView(page) {
  await page.getByTestId('view-toggle').click();
}

/** Documents (the app's one screen). */
async function toReading(page) {
  await page.waitForTimeout(300);
  await openDocs(page);
}
async function openDocs(page) {
  const tessel = page.getByTestId('scope-tessel').locator('visible=true');
  if (await tessel.count()) await tessel.click();
}
/**
 * Settings → Choose a folder (the picker faked by the suite): it becomes the Tessel folder. With documents in the
 * old one, `answer` says whether they move along ('move') or stay ('leave'). `stay`: still in Settings after.
 */
async function chooseTessel(page, { stay = false, answer = 'move' } = {}) {
  await page.getByTestId('home-settings').locator('visible=true').click();
  const before = await page.getByTestId('tessel-folder').locator('visible=true').innerText();
  // A tap on the folder: choosing is the only thing to do, or one of two (another folder, this device's own).
  await page.getByTestId('tessel-folder').locator('visible=true').click();
  await page.getByTestId('action-tessel-choose').click({ timeout: 1500 }).catch(() => {});
  const sheet = page.getByTestId(`action-tessel-${answer}`);
  for (let i = 0; i < 40; i++) {
    if (await sheet.count()) {
      await sheet.click();
      break;
    }
    if ((await page.getByTestId('tessel-folder').locator('visible=true').innerText()) !== before) break;
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 60 && (await page.getByTestId('tessel-folder').locator('visible=true').innerText()) === before; i++) await page.waitForTimeout(250);
  if (stay) return;
  await page.goBack();
  await page.getByTestId('docs-search').locator('visible=true').waitFor();
}
/** ⋯ → Inbox. */
async function openInbox(page) {
  await page.getByTestId('docs-more').locator('visible=true').click();
  await page.getByTestId('action-more-inbox').click();
}
/** Add → Camera: the scanner. */
async function openScan(page) {
  await page.getByTestId('add-menu').locator('visible=true').click();
  await page.getByTestId('action-add-camera').click();
}

function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
}

async function run(name, viewport, isMobile) {
  const ctx = await newContext({ viewport, deviceScaleFactor: 2, isMobile, hasTouch: isMobile, acceptDownloads: true });
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
  check(await page.getByTestId('open-find').isVisible(), `${name}: viewer keeps toolbar visible after scrolling`);

  if (isMobile) {
    // Pinch: the spot between the fingers stays there while pinching and after letting go.
    const spot = { x: 280, y: 420 };
    const under = () =>
      page.evaluate(({ x, y }) => {
        const el = document.elementsFromPoint(x, y).find((e) => e.getAttribute('role') === 'group' && /^Page/.test(e.getAttribute('aria-label') ?? ''));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { page: el.getAttribute('aria-label'), u: +((x - r.left) / r.width).toFixed(3), v: +((y - r.top) / r.height).toFixed(3) };
      }, spot);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, d) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: spot.x - d, y: spot.y, id: 1 }, { x: spot.x + d, y: spot.y, id: 2 }] });
    const before = await under();
    await touch('touchStart', 30);
    for (let d = 30; d <= 90; d += 5) {
      await touch('touchMove', d);
      await page.waitForTimeout(16);
    }
    const during = await under();
    await touch('touchEnd', 0);
    await page.waitForTimeout(800);
    const after = await under();
    const same = (a, b) => !!a && !!b && a.page === b.page && Math.abs(a.u - b.u) < 0.01 && Math.abs(a.v - b.v) < 0.01;
    check(same(before, during) && same(before, after), `${name}: pinch keeps the point between the fingers (${JSON.stringify([before, during, after])})`);
    // Back to 100% for the steps that follow.
    await page.getByTestId('open-appearance').click();
    await page.getByTestId('appearance-panel').getByLabel('Reset zoom').click();
    await page.getByLabel('Close').first().click();
  }

  if (!isMobile) {
    // Text layer: drag-select a heading and read the selection back.
    await page.waitForSelector('[data-testid=text-layer] span', { timeout: 10000 });
    const span = page.locator('[data-testid=text-layer] span', { hasText: /^Adding documents$/ }).first();
    await span.scrollIntoViewIfNeeded();
    const sb = await span.boundingBox();
    await page.mouse.move(sb.x + 1, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width - 1, sb.y + sb.height / 2, { steps: 6 });
    await page.mouse.up();
    const sel = await page.evaluate(() => getSelection().toString().trim());
    check(sel === 'Adding documents', `${name}: text selection → "${sel}"`);
    await page.evaluate(() => getSelection().removeAllRanges());

    // Links: internal jumps; external is exposed with its URL.
    await page.getByTestId('page-label').click();
    await page.getByTestId('page-input').fill('3');
    await page.getByTestId('page-input').press('Enter');
    await page.getByTestId('link-page').first().click();
    await page.waitForTimeout(600);
    check(parseInt(await page.getByTestId('page-label').innerText(), 10) === 7, `${name}: internal link jumps to page 7`);
    const url = await page.getByTestId('link-url').first().getAttribute('aria-label');
    check(/github\.com\/jibes\/doc-manager/.test(url ?? ''), `${name}: external link detected (${url})`);

    // Download from the menu; print via the shortcut prints the PDF, not the app.
    await page.getByTestId('open-more').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-download').click()]);
    check(dl.suggestedFilename() === 'welcome-to-tessel.pdf', `${name}: download keeps the file name (${dl.suggestedFilename()})`);
    await page.keyboard.press('Control+p');
    const frame = await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.src.startsWith('blob:')), null, { timeout: 5000 }).then(() => true, () => false);
    check(frame, `${name}: print loads the PDF into a print frame`);
    await page.keyboard.press('Home');

    // Zooming (trackpad pinch: ctrl+wheel) keeps the spot under the cursor where it was (once the page is wider
    // than the window: until then it stays centred). ⌘+ zooms about the middle first.
    for (let i = 0; i < 4; i++) await page.getByLabel(/^Zoom in/).first().click();
    await page.getByText('207%').first().waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const spot = { x: 900, y: 420 };
    const under = () =>
      page.evaluate(({ x, y }) => {
        const el = document.elementsFromPoint(x, y).find((e) => e.getAttribute('role') === 'group' && /^Page/.test(e.getAttribute('aria-label') ?? ''));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { page: el.getAttribute('aria-label'), u: (x - r.left) / r.width, v: (y - r.top) / r.height };
      }, spot);
    const before = await under();
    await page.mouse.move(spot.x, spot.y);
    await page.keyboard.down('Control');
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -60);
    await page.keyboard.up('Control');
    await page.waitForTimeout(700);
    const after = await under();
    const zoomed = await page.getByText(/^\d+%$/).first().innerText().catch(() => '');
    check(
      !!before && !!after && before.page === after.page && Math.abs(before.u - after.u) < 0.02 && Math.abs(before.v - after.v) < 0.02 && zoomed !== '100%',
      `${name}: zoom keeps the point under the cursor (${JSON.stringify(before)} → ${JSON.stringify(after)}, ${zoomed})`,
    );
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(300);
    await page.keyboard.press('Home');
  }

  // Reading-list documents hide chrome while reading forward; a short scroll back reveals it.
  const reveal = async () => {
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(350);
  };
  await reveal();
  await page.getByTestId('open-find').click();
  await page.getByTestId('find-panel').waitFor();
  await page.waitForTimeout(400);
  await shot('3-contents');
  await page.getByTestId('find-panel').getByText('Finding documents', { exact: true }).click();
  await page.waitForTimeout(500);
  const afterToc = await page.getByTestId('page-label').innerText().catch(() => '');
  check(parseInt(afterToc, 10) === 5, `${name}: TOC jump to "Finding documents" → page ${parseInt(afterToc, 10)}`);
  if (!isMobile) await page.getByTestId('open-find').click();

  await reveal();
  await page.getByTestId('open-find').click();
  check((await page.getByTestId('contents-body').count()) === 1, `${name}: Find shows the contents under its search field`);
  check(await page.getByTestId('view-toggle').isVisible(), `${name}: Text view is in the bar`);
  // A long press on a control (holding a button, a row) must not select its text; the document's text stays selectable.
  const selectable = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('*')].filter(
      (e) => e.offsetParent && getComputedStyle(e).cursor === 'pointer' && e.getAttribute('role') !== 'group' && e.closest('[role=link]') == null,
    );
    return labels.flatMap((e) => [e, ...e.querySelectorAll('*')]).filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && getComputedStyle(n).userSelect !== 'none').map((n) => n.textContent.trim().slice(0, 24));
  });
  const docText = await page.evaluate(() => [...document.querySelectorAll('.tl span')].some((e) => getComputedStyle(e).userSelect !== 'none'));
  check(selectable.length === 0 && docText, `${name}: controls don't select their text, the document's does (${selectable.slice(0, 3).join(' | ') || 'none'})`);
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => document.body.innerText.match(/\d+ results?/), null, { timeout: 10000 });
  check((await page.getByTestId('contents-body').count()) === 0 && (await page.getByTestId('search-results').count()) === 1, `${name}: typing in Find replaces the contents with matches`);
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
  await page.getByTestId('appearance-dark').click();
  await page.waitForTimeout(500);
  await shot('5-dark');
  await page.getByTestId('appearance-light').click();
  await page.waitForTimeout(400);
  await shot('6-light');
  await page.getByTestId('appearance-auto').click();
  await page.keyboard.press('Escape');

  // Text view: reflowed from the page you're on, footers gone, and back to the same page.
  await page.getByTestId('page-label').click();
  await page.getByTestId('page-input').fill('3');
  await page.getByTestId('page-input').press('Enter');
  await page.waitForTimeout(400);
  await switchView(page);
  await page.getByTestId('text-view').waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const textLabel = parseInt(await page.getByTestId('page-label').innerText(), 10);
  const flowText = await page.getByTestId('text-view').innerText();
  check(textLabel === 3 && flowText.includes('Finding your way'), `${name}: text view opens at page ${textLabel} with reflowed text`);
  await shot('5b-text');
  await switchView(page);
  await page.waitForTimeout(800);
  check(parseInt(await page.getByTestId('page-label').innerText(), 10) === 3, `${name}: back in page view at the same page`);
  if (!isMobile) {
    // Search from text view: matches are highlighted in the text, and picking a hit stays there.
    await switchView(page);
    await page.getByTestId('text-view').waitFor();
    await page.getByTestId('open-find').click();
    await page.getByTestId('search-input').fill('scrubber');
    await page.waitForFunction(() => /\d+ results?/.test(document.body.innerText), null, { timeout: 10000 });
    await page.getByTestId('search-input').press('Enter');
    await page.waitForTimeout(800);
    const marked = await page.getByTestId('text-view').evaluate(
      (el) => [...el.querySelectorAll('span')].filter((s) => /^scrubber$/i.test(s.textContent) && getComputedStyle(s).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
    );
    check((await page.getByTestId('text-view').count()) === 1 && marked > 0, `${name}: search in text view highlights matches in place`);
    await page.keyboard.press('Escape');
    await page.getByTestId('find-clear').click();
    await switchView(page);
    await page.getByTestId('pages').waitFor();
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

  // No reading list any more: the More menu has none; back, the document is first in Documents (last opened).
  await page.getByTestId('open-more').click();
  check((await page.getByTestId('menu-reading').count()) === 0, `${name}: no reading list in the document's menu`);
  await page.keyboard.press('Escape');
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  check(/Welcome to Tessel|Tessel/.test(await docRows(page).first().innerText()), `${name}: back in Documents, it is listed first (last opened)`);
  await page.waitForTimeout(800);
  await shot('8-home');

  // Persistence: reload, reopen, expect the same page.
  await page.reload();
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(1200);
  const resumed = parseInt((await page.getByTestId('page-label').innerText()).trim(), 10);
  check(Math.abs(resumed - scrubbed) <= 1, `${name}: resumed at page ${resumed} (left at ${scrubbed})`);

  await ctx.close();
}

// Encrypted PDFs: wrong password is rejected, right one opens, nothing is persisted.
async function locked() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`locked: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/locked.pdf', import.meta.url).pathname);
  await page.getByTestId('password-input').fill('nope');
  await page.getByTestId('password-submit').click();
  const rejected = await page.getByText(/didn’t work/).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.getByTestId('password-input').fill('tessel');
  await page.getByTestId('password-submit').click();
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  const opened = await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 300), null, { timeout: 10000 }).then(() => true, () => false);
  // Reload on the home screen (static servers without SPA fallback can't reload deep links), then reopen.
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.reload();
  await docRows(page).first().click();
  const asksAgain = await page.getByTestId('password-dialog').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(rejected && opened && asksAgain, `locked: wrong password rejected (${rejected}), right one opens (${opened}), asked again after reload (${asksAgain})`);
  await ctx.close();
}

// Tagged PDFs reflow from their structure: headings kept, running header/footer (artifacts) dropped.
async function tagged() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`tagged: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/tagged.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await switchView(page);
  await page.getByTestId('text-view').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const text = await page.getByTestId('text-view').innerText();
  const ok = text.includes('Section 1.1') && !text.includes('running header') && !/^Page \d+$/m.test(text);
  check(ok, 'tagged: text view keeps headings and drops running header/footer');
  // The view choice is remembered per document (reload from home: CI's static server has no SPA fallback).
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.reload();
  await docRows(page).first().click();
  await page.getByTestId('text-view').waitFor({ timeout: 15000 }).then(
    () => check(true, 'tagged: text view remembered after reload'),
    () => check(false, 'tagged: text view remembered after reload'),
  );
  await ctx.close();
}

/** Opened from elsewhere, a document is only viewed: ⋯ → Keep in Tessel makes it the library's. */
async function keepOpen(page) {
  // Wide desktop windows have the actions in the bar.
  const keep = page.getByTestId('menu-keep').locator('visible=true');
  if (!(await keep.count())) await page.getByTestId('open-more').locator('visible=true').click();
  await keep.click();
  await page.getByText('Kept in Tessel.').waitFor({ timeout: 10000 }).catch(() => {});
  // The menu has closed and the reader shows the kept document before anything else is pressed.
  await page.waitForTimeout(500);
}

/** + → Open file: the system's file picker (a file chosen there is opened to look at). */
async function openFile(page) {
  await page.getByTestId('add-menu').locator('visible=true').first().click();
  await page.getByTestId('action-add-open').click();
}

/** A fixture through Open file, kept (as most suites read it again later); `view: true` leaves it viewed. */
async function openFixture(page, file, { view = false } = {}) {
  await page.goto(BASE);
  await page.getByTestId('add-menu').locator('visible=true').first().waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL(`./fixtures/${file}`, import.meta.url).pathname);
  await page.getByTestId('reader').or(page.getByTestId('text-view')).first().waitFor();
  if (!view) await keepOpen(page);
}

// Text view v2: two columns read in order, figures and tables inline, figure tap opens its page.
async function columns() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`columns: ${e.message}`));
  await openFixture(page, 'columns.pdf');
  await switchView(page);
  await page.getByTestId('text-view').waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  const list = page.getByTestId('text-view');
  const text = await list.innerText();
  const order = ['Why order matters', 'Figure 1:', 'Keeping place', 'The column ends'].map((s) => text.indexOf(s));
  check(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'columns: two-column page reads column by column');
  // A paragraph split by the column break would start mid-sentence (lowercase).
  check(!/^\p{Ll}/mu.test(text), 'columns: paragraphs carry across the column break');
  const drawn = await page.getByTestId('figure').first().evaluate((el) => el.querySelector('canvas')?.width ?? 0);
  check(drawn > 0, 'columns: figure is drawn inline from the page');
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(800);
  const table = await page.getByRole('img', { name: /^Table:.*Harbour/ }).count();
  check(table === 1, 'columns: table kept as drawn, with its text as label');
  await page.getByTestId('figure').last().click();
  await page.getByTestId('pages').waitFor({ timeout: 5000 });
  check(parseInt(await page.getByTestId('page-label').innerText(), 10) === 2, 'columns: tapping a figure shows it on its page');
  await ctx.close();
}

// Scanned PDF: on-device OCR feeds text view, page by page, and is kept for next time.
async function scan() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`scan: ${e.message}`));
  await openFixture(page, 'scan.pdf');
  await switchView(page);
  await page.getByTestId('ocr-start').click({ timeout: 15000 });
  const recognized = () => page.waitForFunction(() => /scanned pages/i.test(document.body.innerText) && /kept so it never runs twice/i.test(document.body.innerText), null, { timeout: 120000 });
  await recognized().then(
    () => check(true, 'scan: OCR recognizes the scanned text'),
    () => check(false, 'scan: OCR recognizes the scanned text'),
  );
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.reload();
  await docRows(page).first().click();
  await recognized().then(
    () => check(true, 'scan: recognized text is kept for next time'),
    () => check(false, 'scan: recognized text is kept for next time'),
  );
  await ctx.close();
}

// Forms: fill every kind of field, save, and find the values again after a reload.
async function forms() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`forms: ${e.message}`));
  await openFixture(page, 'form.pdf');
  const name = page.getByTestId('field-name');
  await name.waitFor({ timeout: 10000 });
  await name.click();
  await page.keyboard.type('Ada Lovelace');
  await page.keyboard.press('Enter');
  await page.getByTestId('field-size').nth(2).click();
  await page.getByTestId('field-site').selectOption('2');
  await page.getByTestId('field-agree').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="field-agree"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 5000 });
  check(await page.getByTestId('save').isVisible(), 'forms: editing fields offers Save');
  // Leaving with unsaved edits asks first, in the app's own dialog (cancelled here: stay).
  await page.getByTestId('back').click();
  const asked = await page.getByTestId('ask-confirm').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click().catch(() => {});
  check(asked && (await page.getByTestId('reader').count()) === 1, 'forms: leaving with unsaved edits asks first');
  await page.getByTestId('save').click();
  await page.getByText(/^Saved (in Tessel|to “)/).first().waitFor({ timeout: 5000 });
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.reload();
  await docRows(page).first().click();
  await name.waitFor({ timeout: 10000 });
  const kept =
    (await name.inputValue()) === 'Ada Lovelace' &&
    (await page.getByTestId('field-size').nth(2).getAttribute('aria-checked')) === 'true' &&
    (await page.getByTestId('field-site').inputValue()) === '2' &&
    (await page.getByTestId('field-agree').getAttribute('aria-checked')) === 'true';
  check(kept, 'forms: text, radio, dropdown and checkbox values saved');
  // Typing in a field and leaving straight away (no Enter, no tap elsewhere): asked first, nothing lost.
  await name.click();
  await page.keyboard.type(' Jr');
  await page.getByTestId('back').click();
  const askedTyping = await page.getByTestId('ask-confirm').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click().catch(() => {});
  check(askedTyping && (await page.getByTestId('reader').count()) === 1 && /Jr$/.test(await name.inputValue()), 'forms: leaving while a field is being typed in asks first');
  await ctx.close();
}

// Highlights and notes: select → highlight / note; list, edit, delete; saved into the PDF.
async function annotations() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`annotations: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await page.getByTestId('sample').click();
  await page.getByTestId('reader').waitFor();
  const select = async (re) => {
    const span = page.locator('[data-testid=text-layer] span', { hasText: re }).first();
    await span.waitFor({ timeout: 10000 });
    await span.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const b = await span.boundingBox();
    await page.mouse.move(b.x + 1, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.getByTestId('selection-bubble').waitFor({ timeout: 3000 });
  };
  await select(/^Everything comes in one way/);
  await page.getByTestId('highlight-green').click();
  await select(/^Press \+ and choose Camera/);
  await page.getByTestId('highlight-note').click();
  await page.getByTestId('note-input').fill('Try dragging a file in');
  await page.getByTestId('note-save').click();
  await page.getByTestId('save').waitFor();
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  const rows = page.getByTestId('note-row');
  await rows.nth(1).waitFor({ timeout: 5000 });
  const listed = (await rows.count()) === 2 && /Everything comes in one way/.test(await rows.nth(0).innerText()) && /Try dragging a file in/.test(await rows.nth(1).innerText());
  check(listed, 'annotations: highlight and note listed with their text');
  await rows.nth(1).getByTestId('note-edit').click();
  await page.getByTestId('note-dialog').waitFor();
  check((await page.getByRole('dialog', { name: 'Note' }).count()) === 1, 'annotations: the note is edited in a dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await page.getByTestId('note-dialog').count()) === 0 && (await page.getByTestId('reader').count()) === 1, 'annotations: Esc closes the note, not the document');
  await rows.nth(1).getByTestId('note-edit').click();
  await page.getByTestId('note-input').fill('Drop it anywhere');
  await page.getByTestId('note-save').click();
  await page.getByText('Drop it anywhere').waitFor({ timeout: 3000 });
  await rows.nth(0).getByTestId('note-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=note-row]').length === 1, null, { timeout: 3000 });
  await page.getByTestId('save').click();
  await page.getByText(/^Saved (in Tessel|to “)/).first().waitFor({ timeout: 5000 });
  // Details written after a save were added to the file as it was opened, losing the saved notes.
  await page.keyboard.press('Escape');
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-title').fill('Welcome, annotated');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  await rows.first().waitFor({ timeout: 5000 });
  check((await rows.count()) === 1, `annotations: saving details after a save keeps the notes (${await rows.count()})`);
  await page.keyboard.press('Escape');
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.reload();
  await docRows(page).first().click();
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  await rows.first().waitFor({ timeout: 5000 });
  const kept = (await rows.count()) === 1 && /Drop it anywhere/.test(await rows.first().innerText()) && /Press \+ and choose Camera/.test(await rows.first().innerText());
  check(kept, 'annotations: edits and deletions saved into the PDF');
  // The browser's Back with unsaved edits left the document and lost them without a word.
  await page.keyboard.press('Escape');
  await select(/^Everything comes in one way/);
  await page.getByTestId('highlight-green').click();
  await page.getByTestId('save').waitFor();
  await page.goBack();
  await page.getByTestId('ask-dialog').waitFor({ timeout: 3000 }).catch(() => {});
  check((await page.getByTestId('ask-dialog').count()) === 1 && (await page.getByTestId('reader').isVisible()), 'annotations: the browser’s Back asks before unsaved edits are lost');
  await page.getByTestId('ask-cancel').click();
  await page.waitForTimeout(400);
  check((await page.getByTestId('save').isVisible()) && /\/read\//.test(page.url()), 'annotations: staying keeps the edits (and the address)');
  await page.goBack();
  await page.getByTestId('ask-confirm').click();
  await docRows(page).first().waitFor({ timeout: 5000 });
  check(true, 'annotations: discarding them goes back');
  await ctx.close();
}

// Regressions found in the full audit (each line names the bug it guards).
async function regressions() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`regressions: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await page.getByTestId('sample').click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(800);
  const pageNo = async () => parseInt(await page.getByTestId('page-label').innerText(), 10);
  // End scrolled to the top of the last page, not the end of the document.
  await page.keyboard.press('End');
  await page.waitForTimeout(800);
  const atBottom = await page.evaluate(() => { const e = document.querySelector('[data-testid=pages]'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 2; });
  check(atBottom, 'regression: End scrolls to the end of the document');
  // Esc with the More menu open left the document.
  await page.getByTestId('open-more').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await page.getByTestId('reader').count()) === 1 && (await page.getByTestId('more-menu').count()) === 0, 'regression: Esc closes the More menu, not the document');
  // Pages grid opened at the last page rendered no rows above it.
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-pages').click();
  await page.waitForTimeout(800);
  check(await page.getByTestId('find-panel').getByText('1', { exact: true }).isVisible(), 'regression: pages grid renders all rows');
  check((await page.getByTestId('open-find').getAttribute('aria-pressed')) === 'true', 'regression: toolbar toggles report aria-pressed');
  await page.keyboard.press('Escape');
  await page.getByTestId('open-appearance').click();
  check((await page.getByRole('radio', { name: 'Auto' }).first().getAttribute('aria-checked')) === 'true', 'regression: theme radios report aria-checked');
  await page.keyboard.press('Escape');
  // Text view page jumps landed on the previous page's carried-over paragraph.
  await page.keyboard.press('v');
  await page.getByTestId('text-view').waitFor();
  // Wait for the jump to land: → from wherever the view still was proves nothing (it once read page 7). A text view
  // still being built can restore its earlier place after the key, so Home is pressed until page 1 is reached.
  for (let i = 0; i < 25 && (await pageNo()) !== 1; i++) {
    await page.keyboard.press('Home');
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 25 && (await pageNo()) === 1; i++) await page.waitForTimeout(200);
  await page.waitForTimeout(300);
  check((await pageNo()) === 2, `regression: → in text view goes to the next page (${await pageNo()})`);
  // The scroll keys moved the (hidden) page view, not the text.
  const textY = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid=text-view]');
    const scroller = [el, ...el.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 10 && getComputedStyle(x).overflowY !== 'visible');
    return scroller ? scroller.scrollTop : -1;
  });
  const y0 = await textY();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(700);
  check((await textY()) > y0 + 100, `regression: PageDown scrolls text view (${y0} → ${await textY()})`);
  await page.keyboard.press('End');
  await page.waitForTimeout(800);
  check((await pageNo()) === 7, `regression: End in text view reaches the last page (${await pageNo()})`);
  await page.keyboard.press('v');
  await page.getByTestId('pages').waitFor();
  // A selection taller than the screen put the highlight bubble off screen.
  await page.keyboard.press('Home');
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelectorAll('.tl[data-page="2"] span')[1].scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const spans = (p) => [...document.querySelectorAll(`.tl[data-page="${p}"] span`)].filter((s) => /\w{6,}/.test(s.textContent));
    const a = spans(1).at(-1);
    const b = spans(2)[1];
    getSelection().setBaseAndExtent(a.firstChild, 0, b.firstChild, b.textContent.length);
  });
  const bubble = await page.getByTestId('selection-bubble').boundingBox({ timeout: 3000 }).catch(() => null);
  check(!!bubble && bubble.y >= 0 && bubble.y + bubble.height <= 860, 'regression: highlight bubble stays on screen for long selections');
  await ctx.close();
}

// EPUB books aren't Tessel's: opening one says so and adds nothing.
async function books() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`books: ${e.message}`));
  await page.goto(BASE);
  await page.getByTestId('add-menu').locator('visible=true').first().waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/book.epub', import.meta.url).pathname);
  const said = await page.getByText(/is a book\. Tessel opens PDFs/).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  check(said && (await page.getByTestId('reader').count()) === 0 && (await docRows(page).count()) === 0, 'books: an EPUB is not opened or added, and Tessel says why');
  await ctx.close();
}

// Android app glue (window.TesselShell), faked here: files from "Open with" are added and opened,
// Save/Share go through the bridge with the exact bytes, and the system bars follow the theme.
async function shellBridge() {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) TesselShell/1.0' });
  await ctx.addInitScript(() => {
    // Handed over once, as the app does (not again on every page load).
    const handed = sessionStorage.getItem('handed');
    const log = (window.__shell = { pending: handed ? [] : [{ url: '/__shell/file/one', name: 'columns.pdf', type: 'application/pdf' }], calls: [], bytes: 0 });
    window.TesselShell = {
      pending: () => {
        if (log.pending.length) sessionStorage.setItem('handed', '1');
        return JSON.stringify(log.pending.splice(0));
      },
      begin: (name, mime) => (log.calls.push(['begin', name, mime]), 't1'),
      append: (_t, b64) => void (log.bytes += atob(b64).length),
      finish: (_t, action) => void log.calls.push(['finish', action]),
      theme: (bg, dark) => void log.calls.push(['theme', bg, dark]),
      hasLightSensor: () => true,
      light: (on) => void log.calls.push(['light', on]),
      request: (id, method) =>
        setTimeout(() => window.dispatchEvent(new CustomEvent('tessel-shell-reply', { detail: { id, ok: true, value: method === 'folders' || method === 'list' || method === 'names' ? [] : { allFiles: false } } })), 10),
    };
    // Whether the home screen was ever there to see (not under the cover) before the reader.
    window.__homeSeen = false;
    new MutationObserver(() => {
      if (window.__homeSeen || document.querySelector('[data-testid="reader"]')) return;
      for (const el of document.querySelectorAll('[data-testid="tab-reading"], [data-testid="sample"], [data-testid="add"]')) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (top && el.contains(top)) window.__homeSeen = true;
      }
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  const pdf = readFileSync(new URL('./fixtures/columns.pdf', import.meta.url));
  await ctx.route('**/__shell/file/one', (r) => r.fulfill({ body: pdf, contentType: 'application/pdf' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`shell: ${e.message}`));
  await page.goto(BASE);
  await page.getByTestId('reader').waitFor({ timeout: 10000 }).then(
    () => check(true, 'shell: a file opened from another app is added and opened'),
    () => check(false, 'shell: a file opened from another app is added and opened'),
  );
  check(!(await page.evaluate(() => window.__homeSeen)), 'shell: the home screen does not flash by before it opens');
  await page.waitForTimeout(500);
  await page.getByTestId('open-more').click();
  await page.getByText('Share', { exact: true }).click();
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => window.__shell);
  const shared = log.calls.some((c) => c[0] === 'finish' && c[1] === 'share') && log.calls.some((c) => c[0] === 'begin' && c[1] === 'columns.pdf' && c[2] === 'application/pdf');
  check(shared && log.bytes === pdf.length, `shell: share hands the exact file to the app (${log.bytes} of ${pdf.length} bytes)`);
  check(log.calls.some((c) => c[0] === 'theme' && /^#/.test(c[1])), 'shell: system bars follow the theme');
  check((await page.getByTestId('install').count()) === 0, 'shell: no install button inside the app');
  // Only viewed: after a restart it isn't in the library (nothing was saved about it).
  await page.goto(BASE);
  await page.getByText('Every document').waitFor({ timeout: 10000 }).catch(() => {});
  check((await docRows(page).count()) === 0, 'shell: a file from another app is only viewed, not added to the library');
  // Light sensor theme: Light in a bright room, Black in the dark, once the light has held for a moment.
  await page.keyboard.press('Escape');
  await page.getByTestId('home-settings').locator('visible=true').click();
  await page.getByTestId('appearance-auto').locator('visible=true').click();
  const bg = () => page.evaluate(() => document.documentElement.style.backgroundColor);
  const lux = (v) => page.evaluate((v) => window.dispatchEvent(new CustomEvent('tessel-light', { detail: v })), v);
  await lux(800);
  await page.waitForTimeout(200);
  const bright = await bg();
  for (let i = 0; i < 8; i++) {
    await lux(1);
    await page.waitForTimeout(400);
  }
  const dark = await bg();
  await page.screenshot({ path: `${OUT}shell-settings-sensor.png` });
  const calls = (await page.evaluate(() => window.__shell.calls)).filter((c) => c[0] === 'light');
  check(calls.some((c) => c[1] === true) && bright !== dark && /rgb\((\d{1,2}), \1, \1\)|rgb\(\d{1,2}, \d{1,2}, \d{1,2}\)/.test(dark), `shell: Auto follows the light sensor (${bright} → ${dark})`);
  await lux(1);
  await page.getByRole('radio', { name: 'Light', exact: true }).click();
  await page.waitForTimeout(200);
  const off = (await page.evaluate(() => window.__shell.calls)).filter((c) => c[0] === 'light').at(-1);
  check(off?.[1] === false, 'shell: the sensor stops when Light is chosen');
  // The system's dark mode wins over a bright room.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('appearance-auto').locator('visible=true').click();
  for (let i = 0; i < 8; i++) {
    await lux(800);
    await page.waitForTimeout(400);
  }
  check((await bg()) === dark, `shell: Auto stays Dark in system dark mode, however bright the room (${await bg()})`);
  await ctx.close();
}

// Tidying the Tessel folder: its old folders flattened once (nothing overwritten), and documents there twice found.
async function tidy() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`tidy: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  const edited = Buffer.concat([readFileSync(new URL('./fixtures/xrefstream.pdf', import.meta.url)), Buffer.from('\n% edited\n%%EOF\n')]).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
      for (const [path, b64] of files) {
        const parts = path.split('/');
        let dir = root;
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(b64 === null ? 'notes' : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
        await new Promise((r) => setTimeout(r, 30));
      }
    },
    [
      ['columns.pdf', fixture('columns.pdf')],
      ['2026/columns.pdf', fixture('columns.pdf')],
      ['2026/notes.txt', null],
      ['Old/Arzt/letter.pdf', fixture('xrefstream.pdf')],
      ['letter edited.pdf', edited],
    ],
  );
  const names = (path) =>
    page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      try {
        for (const d of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(d);
      } catch {
        return null;
      }
      const out = [];
      for await (const name of dir.keys()) out.push(name);
      return out.sort();
    }, path);
  await chooseTessel(page, { stay: true });
  await vis('flatten').waitFor({ timeout: 10000 }).catch(() => {});
  check((await vis('flatten').count()) === 1, 'tidy: Settings offers to flatten a Tessel folder with folders in it');
  await vis('flatten').click();
  await page.getByTestId('ask-confirm').click();
  const said = await page.getByText(/moved up/).innerText({ timeout: 15000 }).catch(() => '');
  check(/2 documents moved up, 1 renamed .*1 folder kept/.test(said), `tidy: flattening says what it did (${said})`);
  const top = await names('');
  check(
    ['columns.pdf', 'columns (2).pdf', 'letter.pdf', 'letter edited.pdf'].every((n) => top.includes(n)) && (await names('2026')).join() === 'notes.txt' && (await names('Old')) === null,
    `tidy: PDFs moved up, nothing overwritten, emptied folders gone, others kept (${top} | ${await names('2026')} | ${await names('Old')})`,
  );
  check((await vis('flatten').count()) === 0, 'tidy: …and the offer goes');

  // Duplicates: the same file twice, and an older version.
  await vis('screen-back').click();
  let menu = '';
  for (let i = 0; i < 60 && !/2 duplicates/.test(menu); i++) {
    await page.waitForTimeout(500);
    await vis('docs-more').click();
    await page.getByTestId('action-more-trash').waitFor();
    menu = await page.getByTestId('action-sheet').innerText().catch(() => '');
    await page.keyboard.press('Escape');
  }
  check(/2 duplicates/.test(menu), `tidy: ⋯ says how many documents are there twice (${menu.replace(/\n/g, ' / ')})`);
  await vis('docs-more').click();
  await page.getByTestId('action-more-duplicates').click();
  await vis('duplicate-group').first().waitFor();
  const groups = await vis('duplicate-group').allInnerTexts();
  const versions = groups.find((g) => /Older versions/i.test(g)) ?? '';
  check(groups.length === 2 && groups.some((g) => /Identical files · frees \d+ KB/i.test(g)) && /Stays/i.test(versions), `tidy: identical files and older versions, each with what removing frees (${groups.map((g) => g.split('\n')[0])})`);
  const stays = await vis('duplicate-group').filter({ hasText: 'Older versions' }).getByTestId('duplicate-keep').innerText();
  check(/Old title/.test(stays) && (await vis('duplicate-group').filter({ hasText: 'Older versions' }).getByTestId('duplicate-other').count()) === 1, 'tidy: of versions, the newest stays');
  await vis('duplicate-group').filter({ hasText: 'Identical files' }).getByTestId('duplicate-resolve').click();
  await page.getByText(/^Removed: /).waitFor({ timeout: 10000 }).catch(() => {});
  const left = (await names('')).filter((n) => n.startsWith('columns'));
  check(left.length === 1 && (await names('.tessel/trash')).some((n) => n.startsWith('columns')), `tidy: the others go to the trash (${left})`);
  await ctx.close();
}

// Picked files (Chromium): only viewed; kept, they are copied into the Tessel folder, and saving goes into the
// copy. Handles come from the origin-private file system, standing in for the picker.
async function linked() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle(window.localStorage.getItem('pick') ?? 'linked.pdf')];
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`linked: ${e.message}`));
  const put = (name, file) =>
    page.evaluate(
      async ([name, b64]) => {
        const h = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      },
      [name, readFileSync(new URL(`./fixtures/${file}`, import.meta.url)).toString('base64')],
    );
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await put('linked.pdf', 'columns.pdf');
  await page.getByTestId('sample').click();
  await page.getByTestId('back').click();
  const inTessel = (name) =>
    page.evaluate(async (name) => {
      try {
        const f = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Tessel')).getFileHandle(name)).getFile();
        return new TextDecoder('latin1').decode(await f.arrayBuffer());
      } catch {
        return null;
      }
    }, name);
  await openFile(page);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  check((await page.getByTestId('page-label').innerText()).includes('2'), 'linked: a picked file opens');
  check(!!(await inTessel('linked.pdf')), 'linked: kept, it is copied into the Tessel folder');
  await page.getByTestId('back').click();
  let listed = [];
  for (let i = 0; i < 40 && !listed.some((r) => /Orderly Notes/.test(r)); i++) listed = await page.waitForTimeout(250).then(() => docRows(page).allInnerTexts());
  check(listed.filter((r) => /Orderly Notes/.test(r)).length === 1 && /Orderly Notes/.test(listed[0]), `linked: the kept file is listed once, first (${listed.map((r) => r.split('\n')[0])})`);
  // The original is the user's: changed elsewhere, Tessel's copy stays as it was kept.
  await put('linked.pdf', 'tagged.pdf');
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(500);
  check(/\/\s*2/.test(await page.getByTestId('page-label').innerText()), 'linked: Tessel keeps its own copy, whatever happens to the original');
  await page.getByTestId('back').click();
  // Saving edits to a picked file: kept first (a copy), and the edits go into the copy.
  await put('form.pdf', 'form.pdf');
  await page.evaluate(() => window.localStorage.setItem('pick', 'form.pdf'));
  await openFile(page);
  await page.getByTestId('field-name').click();
  await page.keyboard.type('Grace Hopper');
  await page.keyboard.press('Enter');
  await page.getByTestId('save').click();
  const keepAsked = await page.getByText('Keep in Tessel?').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(keepAsked && /a copy goes to the Tessel folder/.test(await page.getByTestId('ask-dialog').innerText()), 'linked: saving a viewed file asks to keep it, as a copy');
  await page.getByTestId('ask-confirm').click();
  await page.getByText('Saved to “form.pdf”').waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const original = await page.evaluate(async () => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle('form.pdf')).getFile();
    return new TextDecoder('latin1').decode(await f.arrayBuffer()).includes('Grace Hopper');
  });
  check(/Grace Hopper/.test((await inTessel('form.pdf')) ?? '') && !original, 'linked: the filled form is saved into Tessel’s copy, the original left alone');
  await ctx.close();
}

// Interface language follows the OS/browser locale.
async function german() {
  const ctx = await newContext({ locale: 'de-DE', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`german: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Jedes Dokument').waitFor();
  await page.getByTestId('sample').click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-find').click();
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => /\d+ Treffer/.test(document.body.innerText), null, { timeout: 10000 });
  check((await page.locator('html').getAttribute('lang')) === 'de', 'german: UI and <html lang> follow de-DE locale');
  await ctx.close();
}

// The Tessel folder (desktop Chromium): importing a folder, choosing another one (documents moved along) and going
// back (documents left). Folders live in the origin-private file system, standing in for the picker.
async function tesselFolder() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(window.__pick ?? 'Library', { create: true });
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`tessel folder: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(`tessel folder: ${m.text()}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Library', { create: true });
      for (const [path, b64] of files) {
        const parts = path.split('/');
        let dir = root;
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    [['columns.pdf', fixture('columns.pdf')], ['notes.txt', btoa('not a document')], ['Books/book.epub', fixture('book.epub')], ['form.pdf', fixture('form.pdf')]],
  );
  const names = (dir) =>
    page.evaluate(async (dir) => {
      try {
        const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(dir);
        const out = [];
        for await (const [n, e] of h.entries()) if (e.kind === 'file') out.push(n);
        return out.sort();
      } catch {
        return null;
      }
    }, dir);
  // No sources: the one Tessel folder, shown in Settings.
  await vis('home-settings').click();
  check((await vis('app-version').innerText()) === `Tessel ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`, `settings: says which version this is (${await vis('app-version').innerText()})`);
  check(/This browser/.test(await vis('tessel-folder').innerText()) && (await vis('settings-add-folder').count()) === 0 && (await vis('remove-folder').count()) === 0, 'tessel folder: Settings shows the one Tessel folder, no sources to add');
  // Import a folder: its PDFs (in its folders too) are copied in, once; the folder stays as it was.
  await vis('import-folder').click();
  const said = await page.getByText(/documents? imported/).innerText({ timeout: 30000 }).catch(() => '');
  check(said === '2 documents imported.', `tessel folder: importing a folder copies its PDFs in (${said})`);
  check((await names('Tessel'))?.join() === 'columns.pdf,form.pdf' && (await names('Library'))?.join() === 'columns.pdf,form.pdf,notes.txt', `tessel folder: …into the Tessel folder, the folder left as it was (${await names('Tessel')} | ${await names('Library')})`);
  await page.goBack();
  for (let i = 0; i < 40 && (await docRows(page).count()) < 2; i++) await page.waitForTimeout(250);
  check((await docRows(page).count()) === 2 && (await vis('scope-sources').count()) === 0, `tessel folder: Documents lists them, with no Sources to switch to (${await docRows(page).count()})`);
  const firstLines = (rows) => rows.map((r) => r.split('\n')[0]).join();
  const before = firstLines(await docRows(page).allInnerTexts());
  // Another folder: the documents go along when asked to.
  await page.evaluate(() => (window.__pick = 'Archive'));
  await chooseTessel(page, { stay: true, answer: 'move' });
  check(/Archive/.test(await vis('tessel-folder').innerText()), `tessel folder: a chosen folder is the Tessel folder (${await vis('tessel-folder').innerText()})`);
  await page.getByText(/2 documents moved/).waitFor({ timeout: 15000 }).catch(() => {});
  check((await names('Archive'))?.join() === 'columns.pdf,form.pdf' && (await names('Tessel'))?.length === 0, `tessel folder: …and the documents moved there (${await names('Archive')} | ${await names('Tessel')})`);
  await page.goBack();
  let rows = [];
  for (let i = 0; i < 60 && rows.length !== 2; i++) rows = await page.waitForTimeout(250).then(() => docRows(page).allInnerTexts());
  check(rows.length === 2 && rows.every((r) => !/Archive|Tessel folder/.test(r)), `tessel folder: …listed from there, rows not saying where (one folder) (${rows.map((r) => r.replace(/\n/g, ' · '))})`);
  check(firstLines(rows) === before, `tessel folder: …still last added first (this device remembers them by content) (${firstLines(rows)} | ${before})`);
  await docRows(page).filter({ hasText: 'Orderly Notes' }).click();
  await page.getByTestId('reader').waitFor();
  check((await page.getByTestId('open-error').count()) === 0, 'tessel folder: a moved document opens from its new place');
  await page.getByTestId('back').click();
  // Back to this browser's own, leaving them where they are: Tessel lists only its folder's.
  await vis('home-settings').click();
  await vis('tessel-folder').click();
  check((await page.getByTestId('action-tessel-choose').count()) === 1, 'tessel folder: a tap on it offers another folder or this browser');
  await page.getByTestId('action-tessel-device').click();
  await page.getByTestId('action-tessel-leave').click();
  await page.waitForTimeout(800);
  check(/This browser/.test(await vis('tessel-folder').innerText()) && (await names('Archive'))?.length === 2, 'tessel folder: switched back, the documents stay where they were');
  await page.goBack();
  for (let i = 0; i < 40 && (await docRows(page).count()) > 0; i++) await page.waitForTimeout(250);
  check((await docRows(page).count()) === 0, `tessel folder: …and are no longer listed (${await docRows(page).count()})`);
  await ctx.close();
}

// Files in the Android app: folders, all files access and file operations come from the app (faked here as
// window.TesselShell over a small in-memory file tree), documents are served by it and edits written back.
async function foldersShell() {
  const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
  const files = { columns: fx('columns.pdf'), book: fx('book.epub'), form: fx('form.pdf') };
  const sizes = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length]));
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) TesselShell/1.0' });
  await ctx.addInitScript((sizes) => {
    // A real tree URI: its folder ID is percent-encoded, as Android gives it.
    const tree = 'content://com.android.externalstorage.documents/tree/primary%3ADocs';
    const fresh = {
      trees: [],
      all: false,
      next: 10,
      nodes: {
        root: { name: 'Docs', kind: 'dir' },
        app: { name: 'Tessel', kind: 'dir' },
        d1: { name: 'Papers', kind: 'dir', parent: 'root' },
        f1: { name: 'columns.pdf', kind: 'pdf', parent: 'root', key: 'columns', modified: 1.7e12 },
        f2: { name: 'Harbour Notes.epub', kind: 'epub', parent: 'root', key: 'book', modified: 1.71e12 },
        f3: { name: 'form.pdf', kind: 'pdf', parent: 'd1', key: 'form', modified: 1.72e12 },
        // Elsewhere on the device: only all files access sees it.
        dl: { name: 'Download', kind: 'dir' },
        f4: { name: 'Leaflet.pdf', kind: 'pdf', parent: 'dl', key: 'form', modified: 1.73e12 },
      },
    };
    const state = JSON.parse(sessionStorage.getItem('fake') ?? JSON.stringify(fresh));
    const save = () => sessionStorage.setItem('fake', JSON.stringify(state));
    const nodes = state.nodes;
    // Document URIs carry the fixture to serve and the node ID (which changes on rename and move, as on Android).
    const uriOf = (id) => `content://fake/doc/${nodes[id].key ?? 'dir'}/${id}`;
    const idOf = (uri) => uri.split('/').pop();
    const entry = (id) => ({ id, name: nodes[id].name, kind: nodes[id].kind, size: sizes[nodes[id].key] ?? 0, modified: nodes[id].modified ?? 0, uri: uriOf(id) });
    const kids = (parent) => Object.keys(nodes).filter((id) => nodes[id].parent === parent);
    const newId = () => `n${state.next++}`;
    const reId = (id) => {
      const n = newId();
      nodes[n] = nodes[id];
      delete nodes[id];
      for (const k of kids(id)) nodes[k].parent = n;
      return n;
    };
    const copy = (id, parent) => {
      const n = newId();
      nodes[n] = { ...nodes[id], parent };
      for (const k of kids(id)) copy(k, n);
      return n;
    };
    const drop = (id) => {
      for (const k of kids(id)) drop(k);
      delete nodes[id];
    };
    const log = (window.__shell = { calls: [], written: {}, shared: [] });
    const chunks = {};
    const handlers = {
      folders: () => state.trees.map((uri) => ({ uri, name: 'Docs' })),
      pickFolder: () => ((state.trees = [tree]), { uri: tree, name: 'Docs' }),
      forgetFolder: ({ uri }) => ((state.trees = state.trees.filter((u) => u !== uri)), null),
      access: () => ({ allFiles: state.all, app: true }),
      requestAllFiles: () => ((state.all = true), true),
      // The app lists PDFs only (Folders.kt).
      list: (args) => handlers.listAll(args).filter((e) => e.kind !== 'epub'),
      listAll: ({ root, dir }) => {
        if (root === 'all') return Object.keys(nodes).filter((id) => nodes[id].kind !== 'dir').map((id) => ({ ...entry(id), where: nodes[nodes[id].parent].name }));
        if (root === 'device') return [{ id: '/storage/emulated/0/Documents', name: 'Documents', kind: 'dir', size: 0, modified: 0 }];
        if (root === 'app') return kids(dir || 'app').map(entry);
        if (root !== tree) throw new Error(`No access to ${root}`);
        return kids(dir || 'root').map(entry);
      },
      mkdir: ({ dir, name }) => ((nodes[newId()] = { name, kind: 'dir', parent: dir || 'root' }), null),
      rename: ({ uri, name }) => {
        nodes[idOf(uri)].name = name;
        return uriOf(reId(idOf(uri)));
      },
      delete: ({ uris }) => (uris.forEach((u) => drop(idOf(u))), null),
      transfer: ({ items, dir, move }) =>
        items.map(({ uri }) => {
          const id = idOf(uri);
          if (!move) return { from: uri, to: uriOf(copy(id, dir || 'root')) };
          nodes[id].parent = dir || 'root';
          return { from: uri, to: uriOf(reId(id)) };
        }),
      share: ({ uris }) => ((log.shared = uris), null),
      // Which folder the system's file picker shows as "Tessel".
      tesselRoot: ({ root }) => ((log.pickerRoots = [...(log.pickerRoots ?? []), root]), null),
      pickerDevice: ({ on }) => ((log.pickerDevice = on), null),
      // AI requests go through the app (the WebView's own host isn't an origin a server's CORS knows).
      http: ({ url, headers, body }) => {
        log.http = { url, headers, body: JSON.parse(body) };
        const text = JSON.stringify({ title: 'T', date: '', sender: '', type: '', keywords: [], pages: [] });
        return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) };
      },
      dirAt: ({ root, path, create }) => {
        let dir = root === 'app' ? 'app' : 'root';
        for (const name of path) {
          let id = kids(dir).find((k) => nodes[k].kind === 'dir' && nodes[k].name === name);
          if (!id) {
            if (!create) return null;
            id = newId();
            nodes[id] = { name, kind: 'dir', parent: dir };
          }
          dir = id;
        }
        return dir;
      },
      names: ({ root, path }) =>
        Object.keys(state.texts ?? {})
          .filter((k) => k.startsWith(`${root}|${path.join('/')}/`))
          .map((k) => k.slice(`${root}|${path.join('/')}/`.length))
          .filter((n) => !n.includes('/')),
      readText: ({ root, path }) => (state.texts ?? {})[`${root}|${path.join('/')}`] ?? null,
      writeText: ({ root, path, text }) => (((state.texts ??= {})[`${root}|${path.join('/')}`] = text), null),
      write: ({ token, uri }) => ((log.written[uri] = chunks[token].join('')), null),
      create: ({ root, dir, name, token }) => {
        const id = newId();
        nodes[id] = { name, kind: 'pdf', parent: dir || (root === 'app' ? 'app' : 'root'), key: 'created', data: chunks[token].join(''), modified: Date.now() };
        return { uri: uriOf(id), name };
      },
    };
    // Documents that no longer exist (renamed, moved, deleted) are gone, as on the device.
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input?.url ?? input);
      if (url.includes('/__shell/doc?u=')) {
        const uri = decodeURIComponent(url.split('u=')[1]);
        const node = nodes[idOf(uri)];
        if (!node) return Promise.resolve(new Response(null, { status: 404 }));
        if (node.data) return Promise.resolve(new Response(Uint8Array.from(node.data, (c) => c.charCodeAt(0)), { headers: { 'Content-Type': 'application/pdf' } }));
      }
      return realFetch(input, init);
    };
    window.TesselShell = {
      pending: () => '[]',
      begin: () => {
        const t = `t${Object.keys(chunks).length}`;
        chunks[t] = [];
        return t;
      },
      append: (t, b64) => void chunks[t].push(atob(b64)),
      finish: () => {},
      theme: () => {},
      request: (id, method, args) => {
        log.calls.push(method);
        setTimeout(() => {
          let detail;
          try {
            detail = { id, ok: true, value: handlers[method](JSON.parse(args)) };
            save();
          } catch (e) {
            detail = { id, ok: false, error: String(e) };
          }
          window.dispatchEvent(new CustomEvent('tessel-shell-reply', { detail }));
        }, 10);
      },
    };
  }, sizes);
  const served = {};
  await ctx.route('**/__shell/doc?u=*', (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).searchParams.get('u')).split('/')[4];
    served[key] = (served[key] ?? 0) + 1;
    return files[key] ? r.fulfill({ body: files[key], contentType: key === 'book' ? 'application/epub+zip' : 'application/pdf' }) : r.fulfill({ status: 404 });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`folders-shell: ${e.message}`));
  // Screens below the top of the stack stay mounted (hidden): look at the visible one only.
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  // Tiles show document names without their extension.
  const text = (s) => page.getByText(s.replace(/\.(pdf|epub)$/, ''), { exact: true }).locator('visible=true');
  const nodes = () => page.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem('fake')).nodes));
  // The folder a node is in, by name.
  const parentName = (node) => page.evaluate((parent) => JSON.parse(sessionStorage.getItem('fake')).nodes[parent]?.name ?? parent, node?.parent);
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  // A folder picked through the system's folder picker is the Tessel folder.
  await chooseTessel(page);
  // The system's file picker is told which folder to show as "Tessel": this device's own first, then the chosen one.
  const pickerRoots = await page.evaluate(() => window.__shell.pickerRoots ?? []);
  check(pickerRoots[0] === 'app' && /^content:\/\/.+tree/.test(pickerRoots.at(-1) ?? ''), `folders-shell: the file picker shows the Tessel folder (${pickerRoots})`);
  // Settings → File picker: all of internal storage too, once All files access is granted (asked for here).
  await vis('home-settings').click();
  await vis('picker-device').click();
  for (let i = 0; i < 20 && (await vis('picker-device').getAttribute('aria-checked')) !== 'true'; i++) await page.waitForTimeout(150);
  const device = await page.evaluate(() => [window.__shell.pickerDevice, window.__shell.calls.includes('requestAllFiles')]);
  check((await vis('picker-device').getAttribute('aria-checked')) === 'true' && device[0] === true, `folders-shell: the file picker can show all files, after asking for All files access (${device})`);
  await page.goBack();
  let listed = [];
  for (let i = 0; i < 40 && listed.length < 2; i++) listed = await page.waitForTimeout(250).then(() => docRows(page).allInnerTexts());
  check(listed.length === 2 && listed.some((r) => r.includes('Orderly Notes')) && listed.some((r) => r.includes('Visit request')) && !listed.some((r) => r.includes('Harbour Notes')), `folders-shell: the chosen Tessel folder's PDFs are listed, in its folders too, without the EPUB book (${listed.map((r) => r.split('\n')[0])})`);
  await page.screenshot({ path: `${OUT}folders-shell-sources.png` });
  const row = (title) => docRows(page).filter({ hasText: title });
  // A long press on a phone also fires a context menu, and its release a tap: the item stays selected.
  await row('Orderly Notes').click({ button: 'right' });
  await row('Orderly Notes').dispatchEvent('contextmenu');
  await row('Orderly Notes').click();
  await page.waitForTimeout(200);
  check((await page.getByText('1 selected').locator('visible=true').count()) === 1, 'folders-shell: a long press selects the item and it stays selected');
  // Held longer (a slow finger, the emulator): the menu event and the release still don't take it back.
  await vis('select-cancel').click();
  await page.waitForTimeout(900);
  const box = await row('Orderly Notes').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const at = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
  await page.waitForTimeout(700);
  await row('Orderly Notes').dispatchEvent('contextmenu');
  await page.waitForTimeout(900);
  await row('Orderly Notes').dispatchEvent('contextmenu');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  check((await page.getByText('1 selected').locator('visible=true').count()) === 1, `folders-shell: held for 1.6 s, the item is still selected (${await page.getByText(/selected$/).locator('visible=true').innerText().catch(() => 'not picking')})`);
  // The bars fit on a phone: nothing sticks out past the screen.
  const fits = (id) =>
    page.evaluate((id) => {
      const bar = [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => e.checkVisibility());
      return !!bar && [...bar.querySelectorAll('*')].every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5);
    }, id);
  check(await fits('action-bar'), 'folders-shell: the selection actions fit on a phone');
  // Shared to other apps from the bar.
  await vis('act-share').click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__shell.shared.length)) === 1, 'folders-shell: documents can be shared to other apps');
  // ✕ ends picking, with a touch as on a phone (it ends the touch press on the row too).
  await page.waitForTimeout(900);
  await row('Orderly Notes').click({ button: 'right' });
  const x = await vis('select-cancel').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x.x + x.width / 2, y: x.y + x.height / 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  check((await page.getByText(/selected$/).locator('visible=true').count()) === 0, 'folders-shell: ✕ ends picking');

  // Edits to a document are written back to its file.
  await page.waitForTimeout(900);
  await row('Visit request').click();
  await page.getByTestId('field-name').click();
  await page.keyboard.type('Grace Hopper');
  await page.keyboard.press('Enter');
  await page.getByTestId('save').click();
  await page.getByText('Saved to “form.pdf”').waitFor({ timeout: 5000 }).catch(() => {});
  const written = await page.evaluate(() => Object.entries(window.__shell.written).find(([u]) => u.includes('/form/'))?.[1] ?? '');
  check(written.includes('Grace Hopper'), 'folders-shell: saving writes the filled form back to the file in the Tessel folder');
  await vis('back').click();

  // Deleted: to the Tessel folder's trash.
  await page.waitForTimeout(900);
  await row('Visit request').click({ button: 'right' });
  await vis('act-delete').click();
  await page.waitForTimeout(1500);
  const form = (await nodes()).find((n) => n.name === 'form.pdf');
  check(!form || (await parentName(form)) === 'trash', `folders-shell: a document deleted goes to the trash (${form ? await parentName(form) : 'gone'})`);

  // A scan goes where anything added goes: the Tessel folder, through the app.
  await page.goto(BASE);
  await openScan(page);
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  await vis('scan-title').fill('Receipt');
  check((await vis('scan-destination').count()) === 0, 'folders-shell: no choice of folder for a scan');
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const created = (await nodes()).find((n) => n.name === 'Receipt.pdf');
  check((await parentName(created)) === 'Inbox' && created.data.startsWith('%PDF-'), `folders-shell: a scan is saved into the Tessel folder's Inbox (${await parentName(created)})`);
  // Details written into the file (in place, through the app).
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('ACME Instruments');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  // What the app was asked to write back to the file (the fake app logs it).
  const rewritten = await page.evaluate(() => Object.entries(window.__shell.written).find(([u]) => u.includes('/created/'))?.[1] ?? '');
  check(rewritten.startsWith(created.data.slice(0, 200)) && /\/Author \(ACME Instruments\)/.test(rewritten) && rewritten.length > created.data.length, `folders-shell: details are appended to the file (${rewritten.length} bytes)`);
  await page.goto(BASE);
  await toReading(page);
  let scans = 0;
  for (let i = 0; i < 40 && !scans; i++) scans = await page.waitForTimeout(250).then(() => docRows(page).filter({ hasText: 'Receipt' }).count());
  check(scans === 1, 'folders-shell: the saved scan is in the library');

  // A file opened from elsewhere (system picker) is only viewed; kept, it becomes a real file in Documents/Tessel.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await chooser.setFiles(new URL('./fixtures/tagged.pdf', import.meta.url).pathname);
  await page.waitForURL(/\/read\//, { timeout: 30000 });
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(1000);
  const copied = async () => (await nodes()).find((n) => n.name === 'tagged.pdf');
  check(!(await copied()), 'folders-shell: a file opened from elsewhere is only viewed (no copy made)');
  await keepOpen(page);
  await page.waitForTimeout(500);
  check((await parentName(await copied())) === 'Inbox', 'folders-shell: kept, it is a file in the Tessel folder’s Inbox');
  await page.goto(BASE);

  // AI reading in the app: the request is made by the app, not the WebView (no CORS, no "Failed to fetch").
  let direct = 0;
  await page.route('https://ai.test/**', (route) => (direct++, route.abort()));
  await vis('home-settings').click();
  await vis('ai-api-anthropic').click();
  await vis('ai-url').fill('https://ai.test/v1');
  await vis('ai-key').fill('sk-test');
  await vis('ai-model').fill('test-model');
  await vis('ai-test').click();
  const works = await page.getByText('It works.').waitFor({ timeout: 15000 }).then(() => true, () => false);
  const http = await page.evaluate(() => window.__shell.http);
  check(
    works && direct === 0 && http?.url === 'https://ai.test/v1/messages' && http.headers['x-api-key'] === 'sk-test' && http.body.model === 'test-model',
    `folders-shell: AI requests go through the app (${http?.url}, ${direct} from the page)`,
  );
  // Thinking: off unless switched on (asked not to think), then the model's own (adaptive, for Anthropic).
  check(http?.body.thinking?.type === 'disabled' && (await vis('ai-thinking').getAttribute('aria-checked')) === 'false', `ai: the model is asked not to think by default (${JSON.stringify(http?.body.thinking)})`);
  await vis('ai-thinking').click();
  await vis('ai-test').click();
  await page.getByText('It works.').waitFor({ timeout: 15000 }).catch(() => {});
  const thinking = (await page.evaluate(() => window.__shell.http))?.body.thinking;
  check(thinking?.type === 'adaptive', `ai: …and thinks when switched on (${JSON.stringify(thinking)})`);
  await ctx.close();
}

// AI reading (Settings → address, key, model): a fake server stands in for the model. The scan's pages are sent with
// the device's lines; the reply corrects them, adds handwriting, and names the file. A failing server still saves.
async function aiReading() {
  const ctx = await newContext({ viewport: { width: 412, height: 860 } });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`ai: ${e.message}`));
  const reply = {
    title: 'Rechnung 40217', date: '2026-10-02', sender: 'Musterwerke Zürich', type: 'Rechnung', keywords: ['Strom'],
    pages: [{ lines: [{ id: '1.1', text: 'ACME Instruments GmbH' }], added: [{ text: 'bez zum 30.10.2026', box: [500, 900, 900, 950] }] }],
  };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const sent = [];
  let failing = false;
  // A slow model: the scan is open (and says it is being read) before the answer comes.
  let slow = 0;
  await ctx.route('https://ai.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON();
    sent.push({ url: req.url(), headers: req.headers(), body });
    if (slow) await new Promise((r) => setTimeout(r, slow));
    if (failing) return route.fulfill({ status: 500, headers: cors, body: 'down for maintenance' });
    const text = JSON.stringify(reply);
    if (req.url().endsWith('/v1/messages')) {
      // Asked to stream, it streams (the text in two parts), as the real API does.
      if (body.stream) {
        const half = Math.floor(text.length / 2);
        const events = [
          { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ];
        return route.fulfill({ headers: { ...cors, 'content-type': 'text/event-stream' }, body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') });
      }
      return route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) });
    }
    return route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }) });
  });

  await page.goto(BASE);
  await vis('home-settings').click();
  await vis('ai-api-anthropic').click();
  // An address without its scheme would send the key to the app's own site: refused.
  await vis('ai-url').fill('ai.test');
  check((await vis('ai-url-bad').count()) === 1 && (await vis('ai-test').getAttribute('aria-disabled')) === 'true', 'ai: an address without https:// is refused');
  await vis('ai-url').fill('https://ai.test');
  await vis('ai-key').fill('sk-test');
  await vis('ai-model').fill('test-model');
  await vis('ai-test').click();
  await page.getByText('It works.').waitFor({ timeout: 15000 }).then(() => check(true, 'ai: Test reaches the model'), () => check(false, 'ai: Test reaches the model'));
  const probe = sent.at(-1);
  check(probe?.headers['x-api-key'] === 'sk-test' && probe?.body.model === 'test-model' && probe?.body.output_config?.format?.type === 'json_schema' && probe?.body.stream === true, 'ai: Anthropic request carries key, model and the JSON schema, and asks for a stream');

  // A scan read with AI: no title typed, so the model's names the file.
  await page.goto(BASE);
  await openScan(page);
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  check((await vis('scan-ai').getAttribute('aria-checked')) === 'false', 'ai: reading with AI starts off for a scan');
  await vis('scan-ai').click();
  check((await vis('scan-ai').getAttribute('aria-checked')) === 'true' && (await page.getByText(/Sends the pages to ai\.test/).count()) > 0, 'ai: the scan offers AI reading, naming the host');
  slow = 4000;
  const asked = sent.length;
  await vis('scan-save').click();
  // Saved and opened at once; the model reads it in the background, and the reader says so until it is done.
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const told = await page.getByTestId('searchable-progress').waitFor({ timeout: 15000 }).then(() => page.getByTestId('searchable-progress').innerText(), () => '');
  check(/AI|text/i.test(told), `ai: the scan opens at once, saying it is being read (${told})`);
  await page.getByTestId('searchable-progress').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  slow = 0;
  const call = sent.slice(asked).find((c) => c.body.messages?.[0]?.content?.some((x) => x.type === 'image'));
  const content = call?.body.messages?.[0]?.content ?? [];
  check(content.some((c) => c.type === 'image' && c.source?.data?.length > 1000) && /1\.1\t/.test(content.at(-1)?.text ?? ''), 'ai: the page image and the device’s lines are sent');
  await page.goto(BASE);
  await docRows(page).first().waitFor();
  let row = '';
  for (let i = 0; i < 40 && !row.includes('2026-10-02 Musterwerke Zürich – Rechnung 40217'); i++) row = await page.waitForTimeout(500).then(() => docRows(page).first().innerText());
  check(row.includes('2026-10-02 Musterwerke Zürich – Rechnung 40217'), `ai: the model names the document (${row.replace(/\n/g, ' · ')})`);
  const named = await page.evaluate(async () => {
    const names = [];
    const walk = async (dir) => {
      for await (const [n, e] of dir.entries()) if (e.kind === 'file') names.push(n);
      else if (!n.startsWith('.')) await walk(e);
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('Tessel').catch(() => navigator.storage.getDirectory()));
    return names;
  });
  check(named.includes('2026-10-02 Musterwerke Zürich – Rechnung 40217.pdf'), `ai: …and its file (${named})`);
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(2600);
  await vis('open-more').click();
  check((await page.getByTestId('menu-improve').count()) === 1, 'ai: a scan can be read with AI again');
  await page.keyboard.press('Escape');
  await switchView(page);
  await page.waitForFunction(() => /bez zum 30\.10\.2026/.test(document.body.innerText) && /ACME Instruments GmbH/.test(document.body.innerText), null, { timeout: 30000 }).then(
    () => check(true, 'ai: corrected and added text is in the PDF'),
    () => check(false, 'ai: corrected and added text is in the PDF'),
  );

  // A document with text of its own: nothing for the model to read again, but it suggests the details still empty.
  await openFixture(page, 'columns.pdf');
  await page.waitForTimeout(2600);
  await vis('open-more').click();
  check((await page.getByTestId('menu-improve').count()) === 0, 'ai: a typed document isn’t offered to be read with AI');
  await page.getByTestId('menu-details').click();
  await vis('detail-sender').fill('');
  const before = sent.length;
  await vis('details-suggest').click();
  let suggested = '';
  for (let i = 0; i < 40 && suggested !== 'Musterwerke Zürich'; i++) suggested = await page.waitForTimeout(250).then(() => vis('detail-sender').inputValue());
  const prompt = JSON.stringify(sent.slice(before).at(-1)?.body ?? {});
  check(suggested === 'Musterwerke Zürich' && (await vis('detail-type').inputValue()) === 'Rechnung' && /columns/i.test(prompt), `ai: the model suggests the details of a document already kept (${suggested})`);
  await vis('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 }).catch(() => {});

  // OpenAI-compatible, and the server fails: saved anyway, with the device's text, and the user is told.
  await page.goto(BASE);
  await vis('home-settings').click();
  await vis('ai-api-openai').click();
  await vis('ai-url').fill('https://ai.test/v1');
  failing = true;
  await page.goto(BASE);
  await openScan(page);
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  check((await vis('scan-ai').getAttribute('aria-checked')) === 'false', 'ai: switched on for one scan only, not the next');
  await vis('scan-ai').click();
  await vis('scan-title').fill('Offline');
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  check(true, 'ai: the scan is saved anyway');
  await page.getByTestId('searchable-progress').waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByTestId('searchable-progress').waitFor({ state: 'detached', timeout: 60000 }).catch(() => {});
  const oa = sent.at(-1);
  check(oa?.url === 'https://ai.test/v1/chat/completions' && oa?.headers.authorization === 'Bearer sk-test' && oa?.body.messages[0].content.some((c) => c.type === 'image_url'), 'ai: OpenAI-compatible request to /chat/completions with the image');
  // Back in Documents (the app still open): told the model couldn't, the scan keeping the device's text.
  await page.getByTestId('back').locator('visible=true').click();
  await page.getByText(/The model couldn’t read 1 document/).waitFor({ timeout: 30000 }).then(() => check(true, 'ai: a failure is reported'), () => check(false, 'ai: a failure is reported'));
  await ctx.close();
}

// Details in the file: written by an incremental update (cross-reference table and stream), read back by PDFium
// after the reopen; the library follows the new title. A protected PDF can't take them.
async function details() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`details: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const open = async (fixture) => {
    await page.goto(BASE);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
    await fc.setFiles(new URL(`./fixtures/${fixture}`, import.meta.url).pathname);
    await page.getByTestId('reader').waitFor();
    await keepOpen(page);
  };
  const panel = async () => {
    await page.getByTestId('open-more').click();
    await page.getByTestId('menu-details').click();
    await page.getByTestId('details-panel').waitFor();
  };
  for (const [fixture, kind] of [['xrefstream.pdf', 'stream'], ['columns.pdf', 'table']]) {
    await open(fixture);
    await panel();
    if (kind === 'stream') check((await page.getByTestId('detail-title').inputValue()) === 'Old title', 'details: the PDF’s own title is shown');
    await page.getByTestId('detail-title').fill(`Rechnung 40217 ${kind}`);
    await page.getByTestId('detail-sender').fill('Musterwerke Zürich');
    await page.getByTestId('detail-type').fill('Rechnung');
    await page.getByTestId('detail-date').fill('2026-10-02');
    await page.getByTestId('detail-tag-input').fill('Strom,');
    await page.getByTestId('detail-tag-input').fill('Steuer 2026');
    await page.getByTestId('details-save').click();
    await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
    // Reopened from the file: what PDFium reads now is what was written.
    await panel();
    const got = {
      title: await page.getByTestId('detail-title').inputValue(),
      sender: await page.getByTestId('detail-sender').inputValue(),
      type: await page.getByTestId('detail-type').inputValue(),
      date: await page.getByTestId('detail-date').inputValue(),
      tags: await page.getByTestId('detail-tag').allInnerTexts(),
    };
    check(
      got.title === `Rechnung 40217 ${kind}` && got.sender === 'Musterwerke Zürich' && got.type === 'Rechnung' && got.date === '2026-10-02' && got.tags.join('|') === 'Strom|Steuer 2026',
      `details: written into a PDF with a cross-reference ${kind} and read back (${JSON.stringify(got)})`,
    );
    await page.keyboard.press('Escape');
    await page.goto(BASE);
    let top = '';
    for (let i = 0; i < 40 && !top.includes(`Rechnung 40217 ${kind}`); i++) top = await page.waitForTimeout(250).then(() => docRows(page).first().innerText().catch(() => ''));
    check(top.includes(`Rechnung 40217 ${kind}`), `details: the library shows the new title (${kind}: ${top.split('\n')[0]})`);
  }
  // A bad date is caught before anything is written.
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await panel();
  await page.getByTestId('detail-date').fill('2.10.2026');
  await page.getByTestId('details-save').click();
  check(await page.getByText('Write the date as YYYY-MM-DD.').isVisible(), 'details: a date not in YYYY-MM-DD is refused');
  // Details typed in and not saved: closing the panel, or leaving the document, asks first.
  await page.keyboard.press('Escape');
  const askedClose = await page.getByTestId('ask-dialog').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.getByTestId('ask-cancel').click().catch(() => {});
  await page.getByTestId('back').click();
  const askedLeave = await page.getByTestId('ask-dialog').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.getByTestId('ask-cancel').click().catch(() => {});
  check(askedClose && askedLeave && (await page.getByTestId('details-panel').isVisible()), `details: unsaved details are asked about before they go (close ${askedClose}, leave ${askedLeave})`);
  await page.keyboard.press('Escape');
  await page.getByTestId('ask-confirm').click();

  // Protected PDF.
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/locked.pdf', import.meta.url).pathname);
  await page.getByTestId('password-input').fill('tessel');
  await page.getByTestId('password-submit').click();
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await panel();
  await page.getByTestId('detail-title').fill('Changed');
  await page.getByTestId('details-save').click();
  await page.getByText(/protected: its details/).waitFor({ timeout: 10000 }).then(() => check(true, 'details: a protected PDF says it can’t take them'), () => check(false, 'details: a protected PDF says it can’t take them'));
  await ctx.close();
}

// Search across documents: a picked folder (walked, subfolders too, hidden ones skipped) and the library are
// indexed in the background; a hit opens at its page with the query highlighted; new details are found.
async function searchArchive() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    // Single files come through the file chooser (a library copy), folders through the picker above.
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`search: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
      for (const [path, b64] of files) {
        const parts = path.split('/');
        let dir = root;
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    [['2026/columns.pdf', fixture('columns.pdf')], ['.stversions/old.pdf', fixture('tagged.pdf')]],
  );
  await chooseTessel(page);
  // One document in the library too.
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/xrefstream.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await page.goto(BASE);
  // One search, in Documents: library documents and folder files alike.
  await openDocs(page);
  const hits = async (q) => {
    await vis('docs-search').fill(q);
    await page.waitForTimeout(600);
    return vis('archive-hit').allInnerTexts();
  };
  // Indexing may still be going: wait for the folder's document to be found.
  let found = [];
  for (let i = 0; i < 30 && !found.length; i++) found = await hits('Orderly');
  check(found.length === 1 && /Orderly/.test(found[0]), `search: a document in a folder's subfolder is found by its text (${found.map((x) => x.split('\n')[0])})`);
  // Kept into the inbox just now: found once its file there is read.
  let byTitle = [];
  for (let i = 0; i < 30 && !byTitle.length; i++) byTitle = await hits('Old title');
  check(byTitle.length === 1, `search: a library document is found by its title, once (${byTitle.map((x) => x.replace(/\n/g, ' / '))})`);
  // "Cross references" in the folder's document matches too.
  let inLibrary = [];
  for (let i = 0; i < 30 && !inLibrary.some((x) => x.startsWith('Old title')); i++) inLibrary = await hits('cross-reference');
  check(inLibrary.some((x) => x.startsWith('Old title')), `search: a library document is found by its text (${inLibrary.map((x) => x.replace(/\n/g, ' / '))})`);
  const hidden = await hits('Annual');
  check(hidden.every((x) => !/old/.test(x)), 'search: hidden folders (.stversions) are left out');

  // Moved elsewhere (as another device or a file manager would): found there, by its text, as before.
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const file = await (await root.getDirectoryHandle('2026')).getFileHandle('columns.pdf');
    await file.move(await root.getDirectoryHandle('2027', { create: true }));
  });
  await page.goto(BASE);
  await openDocs(page);
  let moved = [];
  // Found once, and (once the folder is read again) it opens from where it is now: rows don't say where.
  let opened = false;
  for (let i = 0; i < 15 && !opened; i++) {
    for (let j = 0; j < 30 && moved.length !== 1; j++) moved = await hits('Orderly');
    await vis('archive-hit').first().click();
    opened = await page.getByTestId('reader').waitFor({ timeout: 4000 }).then(async () => (await page.getByTestId('open-error').count()) === 0, () => false);
    if (!opened) {
      await page.goto(BASE);
      await openDocs(page);
      moved = [];
    }
  }
  check(moved.length === 1 && opened, `search: a moved document is found where it is now (${moved.map((x) => x.replace(/\n/g, ' / '))})`);
  await page.goto(BASE);
  await openDocs(page);

  // Opening a hit: at its page, with the query highlighted.
  await hits('Orderly');
  await vis('archive-hit').first().click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('find-bar').waitFor({ timeout: 15000 }).then(
    () => check(true, 'search: a hit opens with the query highlighted'),
    () => check(false, 'search: a hit opens with the query highlighted'),
  );

  // New details are searchable once saved.
  await page.goto(BASE);
  await docRows(page).filter({ hasText: 'Old title' }).first().click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('Haferflocken Handels GmbH');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  await page.goto(BASE);
  await openDocs(page);
  let byDetails = [];
  for (let i = 0; i < 20 && !byDetails.length; i++) byDetails = await hits('Haferflocken Stream');
  check(byDetails.length === 1, `search: details saved in a document are found (${byDetails.length})`);
  // The same file opened from the folder isn't counted twice.
  check((await hits('Orderly')).length === 1, 'search: a folder file opened into the library is listed once');
  await ctx.close();
}

// Documents screen: narrow by details, save a view, keep it in the archive folder.
async function documentsScreen() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`documents: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = readFileSync(new URL('./fixtures/columns.pdf', import.meta.url)).toString('base64');
  await page.evaluate(async (b64) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
    const w = await (await (await root.getDirectoryHandle('2026', { create: true })).getFileHandle('columns.pdf', { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
  }, fixture);
  await chooseTessel(page);
  // A library document with details.
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/xrefstream.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('Nordkorn');
  await page.getByTestId('detail-type').fill('Rechnung');
  await page.getByTestId('detail-date').fill('2026-09-28');
  await page.getByTestId('detail-tag-input').fill('Steuer');
  await page.getByTestId('detail-tag-input').press('Enter');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });

  await page.goto(BASE);
  await openDocs(page);
  const count = () => vis('docs-count').innerText();
  // Both documents, the library one with its new details (indexing may still be going).
  let rows = [];
  for (let i = 0; i < 60 && !(rows.length === 2 && rows.some((r) => /Nordkorn/.test(r))); i++) rows = await page.waitForTimeout(500).then(() => vis('archive-hit').allInnerTexts());
  check(rows.length === 2 && rows.some((r) => /Nordkorn · Sep 28, 2026/.test(r)), `documents: every document is listed with its details (${rows.map((r) => r.replace(/\n/g, ' / '))})`);

  // Sorting: what by is chosen from a menu, which shows it; the arrow beside it turns the order round.
  const titles = async () => (await vis('archive-hit').allInnerTexts()).map((r) => r.split('\n')[0]);
  await vis('docs-sort').click();
  await page.getByTestId('action-sort-date').click();
  const newest = await titles();
  check(/^Date$/.test(await vis('docs-sort').innerText()) && (await vis('docs-sort-turn').getAttribute('aria-label')).startsWith('Descending'), `documents: by date, newest first, says so (${await vis('docs-sort').innerText()})`);
  await vis('docs-sort-turn').click();
  check((await titles()).join() === [...newest].reverse().join() && (await vis('docs-sort-turn').getAttribute('aria-label')).startsWith('Ascending'), `documents: the arrow turns it round: oldest first (${await titles()})`);
  await vis('docs-sort').click();
  await page.getByTestId('action-sort-size').click();
  const sizes = (await vis('archive-hit').count()) === 2;
  check(sizes && /^Size$/.test(await vis('docs-sort').innerText()) && (await vis('docs-sort-turn').getAttribute('aria-label')).startsWith('Descending'), 'documents: another order starts its usual way round: largest first');
  await vis('docs-sort').click();
  await page.getByTestId('action-sort-date').click();

  // Filters: on a wide list each has its chip (those with values here), showing what is chosen.
  const offered = (await page.locator('[data-testid^="facet-"]:visible').allInnerTexts()).join(' / ');
  check((await vis('docs-filter').count()) === 0 && /Type/.test(offered) && !/Place/.test(offered), `documents: every filter is in reach (no place: that is the switch) (${offered})`);
  await vis('facet-type').click();
  await page.getByTestId('action-sheet').getByText('Rechnung · 1').click();
  check((await count()) === '1 DOCUMENT' && /Old title/.test(await vis('archive-hit').first().innerText()) && /Rechnung/.test(await vis('facet-type').innerText()), 'documents: choosing a type narrows the list, and shows it');
  await vis('facet-tag').click();
  const tagged = await page.getByTestId('action-sheet').getByText('Steuer · 1').waitFor({ timeout: 5000 }).then(() => true, () => false);
  await page.getByTestId('action-any').click();
  check(tagged, 'documents: tags are counted within the chosen type');
  // A phone's list has one button for them, the chosen ones as chips beside it.
  await page.setViewportSize({ width: 390, height: 800 });
  await vis('docs-filter').waitFor();
  check((await vis('facet-tag').count()) === 0 && /Rechnung/.test(await vis('facet-type').innerText()), 'documents: narrow, the filters are behind one button');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Save the view: it is kept in Archive/.tessel.
  await vis('save-view').click();
  await page.getByTestId('ask-input').fill('Invoices');
  await page.getByTestId('ask-confirm').click();
  await page.getByText('“Invoices” saved.').waitFor();
  check((await vis('view-chip').allInnerTexts()).join() === 'Invoices', 'documents: a view is saved and shown');
  await vis('home-settings').click();
  await page.waitForTimeout(500);
  const stored = await page.evaluate(async () => {
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      return await (await (await (await root.getDirectoryHandle('.tessel')).getFileHandle('views.json')).getFile()).text();
    } catch (e) {
      return String(e);
    }
  });
  check(/"name": "Invoices"/.test(stored) && /"type": "Rechnung"/.test(stored), `documents: views are kept in the archive folder (${stored.slice(0, 80)})`);
  // Another device's view in the same file shows up.
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const h = await (await root.getDirectoryHandle('.tessel')).getFileHandle('views.json');
    const data = JSON.parse(await (await h.getFile()).text());
    data.views.push({ id: 'other', name: 'Columns', query: 'Orderly', filter: {}, sort: 'name' }, { id: 'here', name: 'Here', query: '', filter: {}, sort: 'name', place: 'device' });
    const w = await h.createWritable();
    await w.write(JSON.stringify(data));
    await w.close();
  });
  await vis('screen-back').click();
  await openDocs(page);
  await vis('docs-count').waitFor();
  // Read from the file as the screen opens.
  await page.getByTestId('view-chip').filter({ hasText: 'Columns' }).waitFor({ timeout: 5000 }).catch(() => {});
  check((await vis('view-chip').allInnerTexts()).join() === 'Invoices,Columns,Here', `documents: views from the archive folder are listed (${await vis('view-chip').allInnerTexts()})`);
  await vis('view-chip').filter({ hasText: 'Here' }).click();
  const hereOn = await vis('view-chip').filter({ hasText: 'Here' }).getAttribute('aria-pressed');
  check(hereOn === 'true', `documents: an old view's “this device” is the Tessel folder (${hereOn})`);
  await vis('view-chip').filter({ hasText: 'Columns' }).click();
  let byText = '';
  for (let i = 0; i < 10 && byText !== '1 DOCUMENT'; i++) byText = await page.waitForTimeout(300).then(count);
  check(byText === '1 DOCUMENT' && (await vis('docs-search').inputValue()) === 'Orderly', 'documents: a view brings back its search');
  await vis('view-chip').filter({ hasText: 'Invoices' }).click();
  check((await count()) === '1 DOCUMENT' && (await vis('docs-search').inputValue()) === '', 'documents: and its filter');
  // Removing a view rewrites the file.
  await vis('view-chip').filter({ hasText: 'Invoices' }).click();
  await page.getByTestId('action-view-remove').click();
  await page.waitForTimeout(500);
  check((await vis('view-chip').allInnerTexts()).join() === 'Columns,Here', 'documents: a view can be removed');
  await ctx.close();
}

// Inbox: rules fill in details, the template places the file, filing writes the details and moves it.
async function inbox() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`inbox: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
      const inbox = await root.getDirectoryHandle('Inbox', { create: true });
      for (const [name, b64] of files) {
        const w = await (await inbox.getFileHandle(name, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    [['scan-1.pdf', fixture('xrefstream.pdf')], ['notes.pdf', fixture('columns.pdf')]],
  );
  await chooseTessel(page, { stay: true });
  check(/Archive/.test(await vis('tessel-folder').innerText()), 'settings: the chosen folder is the Tessel folder');
  check((await vis('settings-index').innerText()).includes('Sync'), 'settings: the index lists the sections');
  await vis('inbox-here-switch').click();
  check((await vis('inbox-here-switch').getAttribute('aria-checked')) === 'true', 'inbox: this device sorts the inbox');
  await vis('screen-back').click();
  await openDocs(page);
  await openInbox(page);
  const card = (name) => page.getByTestId('inbox-item').filter({ hasText: name });
  await card('scan-1.pdf').waitFor({ timeout: 20000 });
  await card('notes.pdf').waitFor({ timeout: 20000 });
  check((await card('scan-1.pdf').getByTestId('inbox-title').inputValue()) === 'Old title', 'inbox: a document keeps its own title');
  await card('scan-1.pdf').locator('[data-testid="inbox-preview"] img').first().waitFor({ timeout: 20000 });
  check(true, 'inbox: each card shows its first page');

  // A rule (on its own screen): its words in the text give the sender, type and tags.
  await vis('inbox-rules').click();
  await vis('rule-match').fill('stream cross-reference');
  await vis('rule-sender').fill('Stream Co');
  await vis('rule-type').fill('Letter');
  await vis('rule-tags').fill('Test, Demo');
  await vis('rule-add').click();
  await page.getByTestId('rule').first().waitFor();
  await vis('screen-back').click();
  check(/Rules · 1/.test(await vis('inbox-rules').innerText()), 'inbox: the Rules button counts the rules');
  const sender = await card('scan-1.pdf').getByTestId('inbox-sender').inputValue();
  const other = await card('notes.pdf').getByTestId('inbox-sender').inputValue();
  check(sender === 'Stream Co' && other !== 'Stream Co', `inbox: a rule fills in the documents it matches (${sender} / ${other})`);
  const stored = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    return (await (await (await root.getDirectoryHandle('.tessel')).getFileHandle('rules.json')).getFile()).text();
  });
  check(/"match": "stream cross-reference"/.test(stored), 'inbox: rules are kept in the archive folder');

  // The destination follows the details; a bad date blocks filing.
  await card('scan-1.pdf').getByTestId('inbox-date').fill('28.09');
  check((await card('scan-1.pdf').getByTestId('inbox-file').getAttribute('aria-disabled')) === 'true', 'inbox: a date that is not YYYY-MM-DD blocks filing');
  await card('scan-1.pdf').getByTestId('inbox-date').fill('2026-09-28');
  const dest = await card('scan-1.pdf').getByTestId('inbox-dest').innerText();
  check(dest === '→ 2026-09-28 Stream Co Old title.pdf', `inbox: the template names it, in the Tessel folder itself (${dest})`);
  await card('scan-1.pdf').getByTestId('inbox-file').click();
  await page.getByText('Filed: 2026-09-28 Stream Co Old title.pdf').waitFor({ timeout: 15000 });
  const filed = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const bytes = new Uint8Array(await (await (await root.getFileHandle('2026-09-28 Stream Co Old title.pdf')).getFile()).arrayBuffer());
    const inbox = [];
    for await (const name of (await root.getDirectoryHandle('Inbox')).keys()) inbox.push(name);
    return { tail: new TextDecoder('latin1').decode(bytes.slice(-1500)), inbox };
  });
  check(
    /\/Author \(Stream Co\)/.test(filed.tail) && /\/Keywords \(Test, Demo\)/.test(filed.tail) && /\/DocumentDate \(2026-09-28\)/.test(filed.tail),
    'inbox: filing writes the details into the PDF',
  );
  check(filed.inbox.join() === 'notes.pdf', `inbox: and takes it out of the inbox (${filed.inbox})`);
  check((await page.getByTestId('inbox-item').count()) === 1, 'inbox: the filed document leaves the list');
  await ctx.close();
}

// Image-only PDFs made searchable: from the reader, and when filed from the inbox.
async function searchable() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`searchable: ${e.message}`));

  // Asked for (a document only viewed: kept first), read in the background while it stays open.
  await openFixture(page, 'scan.pdf', { view: true });
  await page.waitForTimeout(800);
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-searchable').click();
  await page.getByTestId('ask-confirm').click();
  const told = await page.getByTestId('searchable-progress').waitFor({ timeout: 15000 }).then(() => true, () => false);
  check(told, 'searchable: the reader says the text is being read');
  await page.getByText('Text added: the document can now be searched, selected and copied.').waitFor({ timeout: 180000 });
  await page.waitForSelector('[data-testid=text-layer] span', { timeout: 15000 });
  const text = await page.$$eval('[data-testid=text-layer] span', (s) => s.map((x) => x.textContent).join(' '));
  check(/quick brown fox/.test(text) && /Second Page/.test(text), `searchable: a scanned PDF gets its text, on every page (${text.slice(0, 60)}…)`);
  await page.getByTestId('open-more').click();
  check((await page.getByTestId('menu-searchable').count()) === 0, 'searchable: and is no longer offered for it');
  await page.keyboard.press('Escape');

  // Typed pages, then a scanned one: offered all the same (looked for once the first pages are drawn).
  await page.goto(BASE);
  const [mixed] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await mixed.setFiles(new URL('./fixtures/mixed.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  // Kept: its scanned pages are read by themselves, in the background, and the document opens again with them;
  // the app closed meanwhile (here: reloaded), the reading goes on when it is opened again.
  await page.getByTestId('searchable-progress').waitFor({ timeout: 15000 }).catch(() => {});
  await page.goto(BASE);
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  // Read on (or already done while Documents showed): either way it ends with the text in the file.
  await page.getByText('Text added: the document can now be searched, selected and copied.').waitFor({ timeout: 20000 }).catch(() => {});
  await page.getByTestId('searchable-progress').waitFor({ state: 'detached', timeout: 180000 }).catch(() => {});
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-find').click();
  await page.getByTestId('search-input').fill('quick brown');
  const found = await page.waitForFunction(() => /\d+ results?/.test(document.body.innerText), null, { timeout: 15000 }).then(() => true, () => false);
  check(found, 'searchable: a kept document whose later pages are scans gets their text by itself, even after a reload');
  await page.keyboard.press('Escape');

  // The inbox reads an image-only document's first page for its details, and files it searchable.
  const b64 = readFileSync(new URL('./fixtures/scan.pdf', import.meta.url)).toString('base64');
  await page.evaluate(async (data) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
    const inbox = await root.getDirectoryHandle('Inbox', { create: true });
    const w = await (await inbox.getFileHandle('letter.pdf', { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    await w.close();
  }, b64);
  await page.goto(BASE);
  await chooseTessel(page, { stay: true });
  await vis('inbox-here-switch').click();
  await vis('screen-back').click();
  await openDocs(page);
  await openInbox(page);
  const card = page.getByTestId('inbox-item').filter({ hasText: 'letter.pdf' });
  await card.getByTestId('inbox-no-text').waitFor({ timeout: 120000 });
  check(true, 'inbox: an image-only document is marked to be made searchable');
  // A rule matches words that are only in the picture.
  await vis('inbox-rules').click();
  await vis('rule-match').fill('quick brown fox');
  await vis('rule-sender').fill('Fox Ltd');
  await vis('rule-add').click();
  await page.getByTestId('rule').first().waitFor();
  await vis('screen-back').click();
  await page.waitForTimeout(300);
  check(
    (await card.getByTestId('inbox-sender').inputValue()) === 'Fox Ltd' && (await card.getByTestId('inbox-title').inputValue()) === 'letter',
    'inbox: rules match its recognised text (a tool’s placeholder details count as none)',
  );
  await card.getByTestId('inbox-file').click();
  await page.getByText(/^Filed: /).waitFor({ timeout: 180000 });
  // Found by the words in its picture, in all documents.
  await page.goto(BASE);
  await openDocs(page);
  let hits = [];
  for (let i = 0; i < 40 && !hits.some((h) => /Fox Ltd/.test(h)); i++) {
    await vis('docs-search').fill('');
    await vis('docs-search').fill('continues page');
    await page.waitForTimeout(800);
    hits = await vis('archive-hit').allInnerTexts();
  }
  check(hits.some((h) => /Fox Ltd/.test(h)), `searchable: the filed document is found by its recognised text (${hits.map((h) => h.split('\n')[0])})`);
  await ctx.close();
}

// Sync safety: deleting in the archive goes to its trash (undoable), Syncthing's conflict copies and duplicates
// are listed and resolved, the inbox spots a document that is already filed.
async function syncSafety() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  const text = (x) => page.getByText(x.replace(/\.(pdf|epub)$/, ''), { exact: true }).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`sync: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
      for (const [path, b64] of files) {
        const parts = path.split('/');
        let dir = root;
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, { create: true });
        const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    [
      ['keepme.pdf', fixture('locked.pdf')],
      ['2026/letter.pdf', fixture('xrefstream.pdf')],
      ['2026/letter.sync-conflict-20261013-213005-ABCDEF7.pdf', fixture('columns.pdf')],
      ['dup-one.pdf', fixture('tagged.pdf')],
      ['Copies/dup-two.pdf', fixture('tagged.pdf')],
    ],
  );
  const names = (path) =>
    page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      try {
        for (const d of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(d);
      } catch {
        return [];
      }
      const out = [];
      for await (const name of dir.keys()) out.push(name);
      return out.sort();
    }, path);
  const sizeOf = (path) =>
    page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      const parts = path.split('/');
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
      return (await (await dir.getFileHandle(parts.at(-1))).getFile()).size;
    }, path);

  await chooseTessel(page);

  // Deleting in the archive: to its trash, without asking, and undoable.
  await openDocs(page);
  const keepme = docRows(page).filter({ hasText: 'keepme' });
  await keepme.waitFor({ timeout: 30000 });
  await keepme.click({ button: 'right' });
  await vis('act-delete').click();
  await page.getByText('Moved to the trash.').waitFor({ timeout: 10000 });
  check((await names('.tessel/trash')).includes('keepme.pdf') && !(await names('')).includes('keepme.pdf'), 'sync: deleting in the archive moves to its trash');
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(800);
  check((await names('')).includes('keepme.pdf') && !(await names('.tessel/trash')).includes('keepme.pdf'), 'sync: and Undo puts it back');

  // Conflicts and duplicates, once the archive is read: noted at the top of Documents.
  await page.goto(BASE);
  await openDocs(page);
  await vis('sync-banner').waitFor({ timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 40 && !/2 sync issues/.test(await vis('sync-banner').innerText().catch(() => '')); i++) await page.waitForTimeout(500);
  const banner = await vis('sync-banner').innerText().catch(() => '');
  check(/2 sync issues/.test(banner), `sync: a conflict copy and a duplicate are noticed (${banner})`);
  await vis('sync-banner').click();
  await vis('sync-conflict').waitFor();
  check((await vis('sync-conflict').count()) === 1 && (await vis('sync-duplicate').count()) === 1, 'sync: listed to resolve');
  const copySize = await sizeOf('2026/letter.sync-conflict-20261013-213005-ABCDEF7.pdf');
  await vis('sync-keep-copy').click();
  await page.getByText('Kept. The other version is in the trash.').waitFor({ timeout: 10000 });
  check(
    (await names('2026')).join() === 'letter.pdf' && (await sizeOf('2026/letter.pdf')) === copySize && (await names('.tessel/trash')).includes('letter.pdf'),
    `sync: keeping the other version puts it in place, the first in the trash (${await names('2026')})`,
  );
  check((await vis('sync-conflict').count()) === 0, 'sync: a resolved conflict leaves the list at once');
  await vis('sync-duplicate').getByTestId('sync-keep-one').first().click();
  await page.waitForTimeout(150);
  check((await vis('sync-duplicate').count()) === 0, 'sync: a resolved duplicate leaves the list at once');
  await page.waitForTimeout(650);
  const left = [...(await names('')), ...(await names('Copies'))].filter((n) => n.startsWith('dup'));
  check(left.length === 1, `sync: keeping one duplicate trashes the others (${left})`);
  // And stays gone while the folders are read again.
  await page.waitForTimeout(3000);
  check((await vis('sync-duplicate').count()) === 0 && (await vis('sync-conflict').count()) === 0, 'sync: resolved items stay resolved');

  // The trash (Documents → ⋯): restore one, delete one for good.
  await vis('screen-back').click();
  await vis('docs-more').click();
  await page.getByTestId('action-more-trash').click();
  await vis('trash-item').first().waitFor();
  check(/30 days left|29 days left/.test(await vis('trash-item').first().innerText()), 'sync: the trash says how long each item stays');
  const before = await vis('trash-item').count();
  await vis('trash-item').filter({ hasText: 'dup' }).getByTestId('trash-restore').click();
  await page.waitForTimeout(800);
  const back = [...(await names('')), ...(await names('Copies'))].filter((n) => n.startsWith('dup'));
  check(before === 2 && back.length === 2, `sync: a trashed document is restored where it was (${back})`);
  await vis('trash-item').first().getByTestId('trash-delete').click();
  await page.getByTestId('ask-confirm').click();
  await page.waitForTimeout(800);
  check((await vis('trash-item').count()) === 0 && !(await names('.tessel/trash')).length, 'sync: and deleted for good from the trash');
  const manifest = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    return (await (await (await root.getDirectoryHandle('.tessel')).getFileHandle('trash.json')).getFile()).text();
  });
  check(JSON.parse(manifest).items.length === 0, 'sync: the trash remembers nothing it no longer has');

  // The inbox: a document that is already filed.
  await page.evaluate(async (b64) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const inbox = await root.getDirectoryHandle('Inbox', { create: true });
    const w = await (await inbox.getFileHandle('again.pdf', { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
  }, fixture('tagged.pdf'));
  await vis('screen-back').click();
  await vis('home-settings').click();
  await vis('inbox-here-switch').click();
  await vis('screen-back').click();
  await openDocs(page);
  await openInbox(page);
  await vis('inbox-duplicate').waitFor({ timeout: 30000 }).catch(() => {});
  check(/Already in the Tessel folder: dup-/.test(await vis('inbox-duplicate').innerText().catch(() => '')), 'inbox: a document already filed is pointed out');
  await vis('inbox-discard').click();
  await page.waitForTimeout(800);
  check(!(await names('Inbox')).length && (await names('.tessel/trash')).includes('again.pdf'), 'inbox: and can go to the trash instead');
  await ctx.close();
}

// Reading isn't shared between devices any more: nothing goes to .tessel/state, and Settings has no switch for it.
async function sharedReading() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`shared: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(async (b64) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
    const w = await (await (await root.getDirectoryHandle('Books', { create: true })).getFileHandle('notes.pdf', { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
    // What a device before 3.0 shared: removed once (3.1).
    const state = await (await root.getDirectoryHandle('.tessel', { create: true })).getDirectoryHandle('state', { create: true });
    const s = await (await state.getFileHandle('phone.json', { create: true })).createWritable();
    await s.write('{"docs":{}}');
    await s.close();
  }, fixture('columns.pdf'));
  await chooseTessel(page, { stay: true });
  check((await vis('share-reading-switch').count()) === 0, 'shared: no switch for sharing reading');
  await vis('screen-back').click();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/scan.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await page.waitForTimeout(1500);
  await page.goto(BASE);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(3000);
  const written = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    try {
      await (await root.getDirectoryHandle('.tessel')).getDirectoryHandle('state');
      return true;
    } catch {
      return false;
    }
  });
  check(!written, 'shared: the old shared reading state is gone from the Tessel folder, and nothing new is written there');
  await ctx.close();
}

// Places: a document only on this device can be kept in the archive (its Inbox), the inbox shows as a badge,
// Documents filters by place.
async function places() {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`places: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await page.evaluate(async (b64) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
    const w = await (await (await root.getDirectoryHandle('2026', { create: true })).getFileHandle('notes.pdf', { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    await w.close();
  }, readFileSync(new URL('./fixtures/columns.pdf', import.meta.url)).toString('base64'));
  await chooseTessel(page, { stay: true });
  check(/Archive/.test(await vis('tessel-folder').innerText()), 'places: a folder is made the Tessel folder in Settings');
  await vis('inbox-here-switch').click();
  await vis('screen-back').click();

  // A document from elsewhere: viewed, then kept, it goes into the Tessel folder's Inbox (and syncs).
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), openFile(page)]);
  await fc.setFiles(new URL('./fixtures/xrefstream.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await keepOpen(page);
  await page.waitForTimeout(500);
  await page.getByTestId('open-more').click();
  check((await page.getByTestId('menu-keep-archive').count()) === 0, 'places: kept, it is in the Tessel folder already (nothing more to keep)');
  await page.keyboard.press('Escape');
  const inbox = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    const out = [];
    for await (const name of (await root.getDirectoryHandle('Inbox')).keys()) out.push(name);
    return out;
  });
  check(inbox.join() === 'xrefstream.pdf', `places: kept in the Tessel folder's Inbox (${inbox})`);
  await page.goto(BASE);
  await docRows(page).first().waitFor();
  await page.waitForTimeout(2000);
  const rows = await docRows(page).filter({ hasText: 'Old title' }).count();
  check(rows === 1, `places: Documents has it once (${rows})`);
  await page.waitForTimeout(500);
  check(/1 document to review/.test(await vis('inbox-review').innerText().catch(() => '')), 'places: Documents says what is waiting in the inbox');
  await vis('inbox-review').click();
  await page.waitForURL(/\/inbox/);
  check(true, 'places: …and the line opens it');
  await page.goto(BASE);

  // Documents: Tessel's own; without sources, no switch to them.
  let all = 0;
  for (let i = 0; i < 40 && all < 2; i++) all = await page.waitForTimeout(500).then(() => vis('archive-hit').count());
  check(all === 2, `places: both are in the Tessel folder (${all})`);

  await ctx.close();
}

// Last opened: Documents opens sorted so (where you were, first); a document opens again where it was left, also at its very end.
async function lastRead() {
  const ctx = await newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`last-read: ${e.message}`));
  await openFixture(page, 'tagged.pdf');
  await page.keyboard.press('Escape');
  await openFixture(page, 'columns.pdf');
  // Read to the very end (the top of the screen is still partway down the last page).
  await page.waitForTimeout(800);
  await page.mouse.move(195, 420);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 800).then(() => page.waitForTimeout(150));
  await page.waitForTimeout(1500);
  await page.keyboard.press('Escape');
  let first = '';
  for (let i = 0; i < 40 && !first.includes('Orderly Notes'); i++) first = await page.waitForTimeout(250).then(() => docRows(page).first().innerText().catch(() => ''));
  check((await page.getByTestId('docs-sort').locator('visible=true').innerText()).includes('Last opened') && first.includes('Orderly Notes'), `last read: Documents lists everything, last opened first (${first.split('\n')[0]})`);
  check((await page.getByTestId('continue').count()) === 0 && (await page.getByTestId('tab-reading').count()) === 0, 'last read: no Reading screen and no Continue card');
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(1000);
  check(/^2/.test((await page.getByTestId('page-label').innerText()).trim()), `last read: opened again, it is at the end where it was left (${await page.getByTestId('page-label').innerText()})`);
  await ctx.close();
}

// A long list: the first rows at once, more as the end comes near (no button to press).
async function manyDocs() {
  const ctx = await newContext({ viewport: { width: 390, height: 844 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Many', { create: true });
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`many: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const pdf = readFileSync(new URL('./fixtures/xrefstream.pdf', import.meta.url)).toString('base64');
  await page.evaluate(async (b64) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Many', { create: true });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    for (let i = 1; i <= 130; i++) {
      const w = await (await dir.getFileHandle(`doc-${String(i).padStart(3, '0')}.pdf`, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    }
  }, pdf);
  await chooseTessel(page);
  for (let i = 0; i < 120 && !/^130 /.test(await vis('docs-count').innerText().catch(() => '')); i++) await page.waitForTimeout(500);
  const rows = () => vis('archive-hit').count();
  check((await vis('docs-count').innerText()).startsWith('130') && (await rows()) === 100, `many: 130 documents, the first 100 listed (${await rows()})`);
  check((await vis('show-more').count()) === 0, 'many: no Show more button');
  for (let i = 0; i < 20 && (await rows()) < 130; i++) {
    await vis('docs-scroll').evaluate((el) => {
      const s = [el, ...el.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 10 && getComputedStyle(e).overflowY !== 'visible');
      s.scrollTop = s.scrollHeight;
    });
    await page.waitForTimeout(300);
  }
  check((await rows()) === 130 && (await vis('docs-loading').count()) === 0, `many: scrolling near the end lists the rest (${await rows()})`);
  await ctx.close();
}

// Notes on a page (what bookmarks were): the ribbon adds one, saved into the file; bookmarks from before become notes.
async function pageNotes() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`page notes: ${e.message}`));
  await openFixture(page, 'columns.pdf');
  await page.getByTestId('page-note').click();
  await page.getByTestId('note-input').fill('Read again');
  await page.getByTestId('note-save').click();
  await page.getByTestId('save').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  const rows = page.getByTestId('note-row');
  await rows.first().waitFor({ timeout: 5000 }).catch(() => {});
  check(/Read again/.test(await rows.first().innerText().catch(() => '')), 'page notes: the ribbon adds a note on the page, listed with the notes');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // A bookmark from before (as 2.x kept it, in the library): it becomes a note in the file, once.
  const records = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('quire-meta');
          req.onsuccess = () => {
            const all = req.result.transaction('docs').objectStore('docs').getAll();
            all.onsuccess = () => resolve(all.result);
          };
        }),
    );
  const [rec] = await records();
  await page.evaluate(
    (rec) =>
      new Promise((resolve) => {
        const req = indexedDB.open('quire-meta');
        req.onsuccess = () => {
          const tx = req.result.transaction('docs', 'readwrite');
          tx.objectStore('docs').put({ ...rec, bookmarks: [1] }, rec.id);
          tx.oncomplete = () => resolve(null);
        };
      }),
    rec,
  );
  await page.goto(BASE);
  let after = [1];
  for (let i = 0; i < 30 && after.length; i++) after = await page.waitForTimeout(500).then(async () => (await records())[0]?.bookmarks ?? []);
  check(after.length === 0, 'page notes: a bookmark from before is gone from the library');
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  await rows.nth(1).waitFor({ timeout: 5000 }).catch(() => {});
  const texts = await rows.allInnerTexts();
  check(texts.some((r) => /Bookmark/.test(r) && /2/.test(r)) && texts.some((r) => /Read again/.test(r)), `page notes: …and is a note on its page, in the file (${texts.map((r) => r.replace(/\n/g, ' '))})`);
  await ctx.close();
}

// A PDF scanned by another app, cleaned up in the scanner: its pages come in, get a filter, and go back into
// the same file (no second document), its details kept and its text read.
async function again() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`again: ${e.message}`));
  await openFixture(page, 'scan.pdf');
  // Kept, its text is read first (nothing is offered meanwhile).
  await page.getByTestId('searchable-progress').waitFor({ timeout: 15000 }).catch(() => {});
  await page.getByTestId('searchable-progress').waitFor({ state: 'detached', timeout: 180000 });
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('Nordkorn');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  await page.waitForTimeout(2600);
  const bytes = () => page.evaluate(async () => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('Tessel')).getFileHandle('scan.pdf')).getFile()).size);
  const before = await bytes().catch(() => 0);
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-again').click();
  await page.waitForURL(/\/scan\/review/, { timeout: 60000 });
  await page.getByTestId('scan-tile').nth(1).waitFor({ timeout: 60000 });
  check((await page.getByTestId('scan-tile').count()) === 2 && (await page.getByTestId('scan-again').isVisible()), 'again: the document’s pages are in the scanner, saying they replace its own');
  await page.getByTestId('scan-filter-bw').click();
  await page.getByTestId('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  await page.getByText('Pages cleaned up.').waitFor({ timeout: 60000 }).then(() => check(true, 'again: saved back into the document'), () => check(false, 'again: saved back into the document'));
  await page.waitForSelector('[data-testid=text-layer] span', { timeout: 30000 }).catch(() => {});
  const text = await page.$$eval('[data-testid=text-layer] span', (s) => s.map((x) => x.textContent).join(' '));
  const after = await bytes().catch(() => 0);
  check(before > 0 && after > 0 && after !== before && /quick brown fox/.test(text), `again: its file has the new pages, with their text (${before} → ${after} bytes; ${text.slice(0, 40)}…)`);
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  check((await page.getByTestId('detail-sender').inputValue()) === 'Nordkorn', 'again: its details are kept');
  await page.keyboard.press('Escape');
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor();
  await page.waitForTimeout(800);
  check((await docRows(page).count()) === 1, 'again: no second document');
  await ctx.close();
}

// Undo and redo: notes and highlights come and go again, Save follows whether the file differs from the saved one.
async function undoRedo() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`undo: ${e.message}`));
  await openFixture(page, 'columns.pdf');
  // The notes listed beside the pages (read again after every change).
  const notes = async () => {
    await page.waitForTimeout(800);
    return (await page.getByTestId('note-row').allInnerTexts()).join(' | ');
  };
  check((await page.getByTestId('undo').count()) === 0, 'undo: nothing to undo at first');
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  await page.getByTestId('page-note').click();
  await page.getByTestId('note-input').fill('First');
  await page.getByTestId('note-save').click();
  await page.getByTestId('page-note').click();
  await page.getByTestId('note-input').fill('Second');
  await page.getByTestId('note-save').click();
  await page.getByTestId('undo').waitFor();
  check(/First/.test(await notes()) && /Second/.test(await notes()), 'undo: two notes added');
  await page.getByTestId('undo').click();
  await page.waitForTimeout(500);
  const once = await notes();
  check(/First/.test(once) && !/Second/.test(once) && (await page.getByTestId('redo').count()) === 1, `undo: the last note is undone (${once})`);
  await page.getByTestId('page-label').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  check(!/First|Second/.test(await notes()) && (await page.getByTestId('save').count()) === 0, 'undo: ⌘Z undoes the first too: nothing left to save');
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(500);
  const again = await notes();
  check(/First/.test(again) && /Second/.test(again) && (await page.getByTestId('save').count()) === 1 && (await page.getByTestId('redo').count()) === 0, `undo: redo brings both back (${again})`);
  // Saved, then undone: the file differs from the saved one again; redone, it doesn't.
  await page.getByTestId('save').click();
  await page.getByTestId('save').waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await page.getByTestId('undo').click();
  await page.getByTestId('save').waitFor({ timeout: 5000 }).catch(() => {});
  const dirty = (await page.getByTestId('save').count()) === 1;
  await page.getByTestId('redo').click();
  await page.waitForTimeout(500);
  check(dirty && (await page.getByTestId('save').count()) === 0, 'undo: Save is offered only while the document differs from the saved file');
  await ctx.close();
}

// Wide desktop windows: Find and Details stay open beside the pages, each closed on its own (and remembered);
// the document's actions are in the bar, one click each.
async function docked() {
  const ctx = await newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`docked: ${e.message}`));
  await openFixture(page, 'columns.pdf');
  const side = page.getByTestId('side-panels');
  const shown = (id) => side.getByTestId(id).isVisible().catch(() => false);
  check((await shown('find-panel')) && (await shown('details-panel')), 'docked: Find and Details are open beside the pages');
  const sideBox = await side.boundingBox();
  const pagesBox = await page.getByTestId('pages').boundingBox();
  check(!!sideBox && !!pagesBox && pagesBox.x + pagesBox.width <= sideBox.x + 1, 'docked: the pages make room for them (nothing covered)');
  check((await page.getByTestId('open-more').count()) === 0 && (await page.getByTestId('menu-print').isVisible()) && (await page.getByTestId('menu-share').isVisible()), 'docked: every action is in the bar, no ⋯ menu');
  await page.getByTestId('open-find').click();
  check(!(await shown('find-panel')) && (await shown('details-panel')), 'docked: Find closes on its own');
  await page.getByTestId('menu-details').click();
  check((await side.count()) === 0, 'docked: with both closed the pages have the whole window');
  await page.goto(BASE);
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(800);
  check((await side.count()) === 0, 'docked: closed stays closed');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(400);
  check((await shown('find-panel')) && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'search-input', 'docked: ⌘F opens Find with its field ready');
  await page.keyboard.type('the');
  await page.waitForFunction(() => /\d+ results?/.test(document.body.innerText), null, { timeout: 10000 }).then(() => check(true, 'docked: searching beside the pages'), () => check(false, 'docked: searching beside the pages'));
  await page.getByTestId('menu-details').click();
  await side.getByTestId('detail-title').fill('Rechnung 40217');
  await side.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  check((await side.getByTestId('detail-title').inputValue()) === 'Rechnung 40217' && (await shown('details-panel')), 'docked: Details stay open after saving, showing what was saved');
  await ctx.close();
}

// A browser library from 2.x (a copy in IndexedDB, where it was left on the record): the copy becomes a file in the
// browser's own Tessel folder, and where it was left is in this device's cache, by its content.
async function upgrade() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`upgrade: ${e.message}`));
  await page.goto(BASE);
  await page.getByTestId('add-menu').locator('visible=true').first().waitFor();
  const b64 = readFileSync(new URL('./fixtures/columns.pdf', import.meta.url)).toString('base64');
  await page.evaluate(async (b64) => {
    const put = (db, store, key, value) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onupgradeneeded = () => open.result.createObjectStore(store);
        open.onsuccess = () => {
          const tx = open.result.transaction(store, 'readwrite');
          tx.objectStore(store).put(value, key);
          tx.oncomplete = () => resolve(null);
          tx.onerror = () => reject(tx.error);
        };
      });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await put('quire-files', 'files', 'old1', new Blob([bytes], { type: 'application/pdf' }));
    await put('quire-meta', 'docs', 'old1', { id: 'old1', title: 'Orderly Notes', fileName: 'columns.pdf', bytes: bytes.length, pageCount: 2, coverAspect: 1.29, addedAt: Date.now() - 1000, openedAt: Date.now() - 500, bookmarks: [], position: { page: 1, offset: 0.1 } });
  }, b64);
  await page.goto(BASE);
  const state = () =>
    page.evaluate(async () => {
      let file = false;
      try {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Tessel');
        for await (const [n] of dir.entries()) if (n === 'columns.pdf') file = true;
      } catch {}
      const cached = await new Promise((resolve) => {
        const open = indexedDB.open('tessel-cache');
        open.onupgradeneeded = () => open.result.createObjectStore('docs');
        open.onsuccess = () => {
          const all = open.result.transaction('docs').objectStore('docs').getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => resolve([]);
        };
        open.onerror = () => resolve([]);
      });
      const record = await new Promise((resolve) => {
        const open = indexedDB.open('quire-meta');
        open.onsuccess = () => {
          const one = open.result.transaction('docs').objectStore('docs').get('old1');
          one.onsuccess = () => resolve(one.result);
          one.onerror = () => resolve(null);
        };
        open.onerror = () => resolve(null);
      });
      return { file, cached, record };
    });
  let now = { file: false, cached: [], record: null };
  for (let i = 0; i < 40 && !(now.file && now.cached.length && now.record && !now.record.position); i++) now = await page.waitForTimeout(500).then(state);
  check(now.file, 'upgrade: the copy kept in the browser is a file in the browser’s own Tessel folder');
  check(now.cached.some((c) => c.position?.page === 1), `upgrade: where it was left is in this device’s cache (${JSON.stringify(now.cached)})`);
  check(!!now.record && !now.record.position && now.record.openedAt === undefined && !!now.record.shareKey, `upgrade: …and no longer in the library's record (${JSON.stringify(now.record && { position: now.record.position, openedAt: now.record.openedAt })})`);
  await page.goto(BASE);
  await docRows(page).first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(800);
  check(/^2/.test((await page.getByTestId('page-label').innerText()).trim()), `upgrade: it opens where it was left (${await page.getByTestId('page-label').innerText()})`);
  await ctx.close();
}

// ONLY=linked,scan runs a subset while iterating.
const only = process.env.ONLY?.split(',');
// Scanner: import a phone photo, change the filter, keep the draft over a reload, save a searchable PDF into a folder.
async function scanner() {
  const ctx = await newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Scans', { create: true });
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`scanner: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404|getUserMedia|NotFoundError|Requested device/i.test(m.text()) && errors.push(`scanner: ${m.text()}`));
  await page.goto(BASE);
  await openScan(page);
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  check((await vis('scan-tile').count()) === 1, 'scanner: imported photo becomes page 1');
  // The page was found in the photo: the preview is the cropped page, portrait.
  const ratio = await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('canvas[data-rendered]')].find((x) => x.offsetParent);
    return c && c.height / c.width;
  }, null, { timeout: 60000 }).then((h) => h.jsonValue());
  check(ratio > 1.2 && ratio < 1.6, `scanner: page found and straightened (aspect ${ratio?.toFixed(2)})`);

  await vis('scan-tile').first().click();
  // Holding Original shows the photo for as long as it is held, past the browser's long-press time, and selects no text.
  const compare = await vis('scan-compare').boundingBox();
  await page.mouse.move(compare.x + compare.width / 2, compare.y + compare.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  const held = await page.evaluate(() => document.querySelectorAll('canvas').length);
  const selected = await page.evaluate(() => String(getSelection()));
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelectorAll('canvas').length);
  check(held > after && !selected, `scanner: holding Original shows the photo until let go (${held} → ${after} pictures, selection "${selected}")`);
  check((await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=scan-compare]')).touchAction)) === 'none', 'scanner: Original takes the finger (no touch gestures on it)');
  await vis('scan-filter-bw').click();
  check((await vis('scan-filter-bw').getAttribute('aria-checked')) === 'true', 'scanner: filter chosen on the page');
  await vis('screen-back').click();
  // Open the app afresh (the static test server has no fallback for deep links): the draft comes back.
  await page.goto(BASE);
  await openScan(page);
  await vis('scan-done').click({ timeout: 30000 });
  await vis('scan-tile').first().waitFor({ timeout: 30000 });
  check((await vis('scan-filter-bw').getAttribute('aria-checked')) === 'true', 'scanner: draft and filter survive a reload');

  // Order and select mode: a second page, turned so it can be told apart, then moved around.
  await vis('scan-add').click();
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  // An imported photo takes the camera back to the document by itself.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=scan-tile]')].filter((t) => t.offsetParent).length === 2, null, { timeout: 60000 });
  // Height over width of each tile's page, once drawn: below 1 is a turned (landscape) page.
  const shapes = () =>
    page.waitForFunction(() => {
      const tiles = [...document.querySelectorAll('[data-testid=scan-tile]')].filter((t) => t.offsetParent);
      const r = tiles.map((t) => t.querySelector('canvas[data-rendered]')).map((c) => c && c.height / c.width);
      return r.every(Boolean) && r.map((x) => (x < 1 ? 'L' : 'P')).join('');
    }, null, { timeout: 60000 }).then((h) => h.jsonValue());
  await vis('scan-select').click();
  const anyFilterOn = await page.locator('[data-testid^=scan-filter-][aria-checked=true]').locator('visible=true').count();
  check((await vis('scan-filter-document').isDisabled()) && !anyFilterOn, 'scanner: with no page picked, the filters are off');
  await vis('scan-tile').nth(1).click();
  check((await vis('scan-selected').innerText()).includes('1 page'), 'scanner: select mode picks pages');
  await vis('bulk-rotate').click();
  await page.waitForTimeout(800);
  check((await shapes()) === 'PL', 'scanner: selected pages turn together');
  await vis('toast-action').click();
  await page.waitForTimeout(800);
  check((await shapes()) === 'PP', 'scanner: a bulk action can be undone');
  await vis('bulk-rotate').click();
  await vis('bulk-start').click();
  await page.waitForTimeout(800);
  check((await shapes()) === 'LP', 'scanner: selected pages move to the start');
  await vis('scan-select').click();
  // Drag the first page onto the second (a mouse drags straight away; a finger holds first).
  const box = async (i) => vis('scan-tile').nth(i).boundingBox();
  const [a, b] = [await box(0), await box(1)];
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x - a.x) * i) / 10, a.y + a.height / 2 + ((b.y - a.y) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(800);
  check((await shapes()) === 'PL' && /\/scan\/review/.test(page.url()), `scanner: a page can be dragged to a new place (${page.url().split('/').pop()})`);
  await vis('scan-select').click();
  await vis('scan-tile').nth(1).click();
  await vis('bulk-delete').click();
  await page.waitForTimeout(500);
  check((await vis('scan-tile').count()) === 1, 'scanner: selected pages can be deleted');
  // Deleting the last page on its own screen goes back to the document, with Undo there.
  await vis('scan-tile').first().click();
  await vis('scan-delete').click();
  await page.waitForURL(/\/scan\/review/);
  // The page screen's toast fades out as the document's comes in.
  await page.waitForTimeout(600);
  await vis('toast-action').click({ timeout: 10000 });
  await page.waitForTimeout(500);
  check((await vis('scan-tile').count()) === 1, 'scanner: a page deleted on its own screen can be undone');

  await vis('scan-title').fill('Invoice ACME');
  check((await vis('scan-destination').count()) === 0, 'scanner: no folder to choose (scans go where anything added goes)');
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const saved = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Tessel');
    const file = await (await dir.getFileHandle('Invoice ACME.pdf')).getFile();
    return new TextDecoder().decode((await file.slice(0, 5).arrayBuffer()));
  }).catch(() => null);
  check(saved === '%PDF-', 'scanner: PDF written into the Tessel folder');
  await switchView(page);
  await page.waitForFunction(() => /ACME/.test(document.body.innerText) && /INVOICE/i.test(document.body.innerText), null, { timeout: 30000 }).then(
    () => check(true, 'scanner: recognised text is in the PDF'),
    () => check(false, 'scanner: recognised text is in the PDF'),
  );
  await page.goto(BASE);
  await openScan(page);
  await page.locator('input[type=file]').waitFor({ state: 'attached' });
  check((await vis('scan-done').count()) === 0, 'scanner: saving starts a new document');
  await ctx.close();
}

// Navigation: Library | Files tabs (bottom bar on phones, header tabs on wide windows) and the Scan action.
async function tabs() {
  for (const [name, viewport] of [['phone', { width: 390, height: 800 }], ['wide', { width: 1280, height: 800 }]]) {
    const ctx = await newContext({ viewport });
    const page = await ctx.newPage();
    const vis = (id) => page.getByTestId(id).locator('visible=true');
    page.on('pageerror', (e) => errors.push(`tabs: ${e.message}`));
    await page.goto(BASE);
    await vis('docs-search').waitFor();
    // One screen: Documents, with Add on it; no tab bar, no sidebar, no Reading.
    check((await page.getByTestId('tab-reading').count()) === 0 && (await page.getByTestId('tab-documents').count()) === 0 && (await page.getByTestId('side-folders').count()) === 0, `tabs (${name}): one screen, no tab bar or sidebar`);
    await vis('add-menu').click();
    await page.getByTestId('action-add-files').waitFor();
    const offered = await page.getByTestId('action-sheet').innerText();
    check(/Camera/.test(offered) && /Files/.test(offered), `tabs (${name}): Add offers the camera and files`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check((await vis('docs-folders').count()) === 0 && (await vis('add-folder').count()) === 0, `tabs (${name}): no Folders view (sources are added in Settings)`);
    check((await vis('docs-more').count()) === 0, `tabs (${name}): no ⋯ with fewer than two things in it`);
    await openScan(page);
    await page.waitForURL(/\/scan/);
    check(true, `tabs (${name}): Add → Camera opens the camera`);
    await ctx.close();
  }
  // A document dropped anywhere opens (not only on Reading).
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`tabs: ${e.message}`));
  await page.goto(BASE);
  await openDocs(page);
  await page.getByTestId('docs-search').locator('visible=true').waitFor();
  const pdf = readFileSync(new URL('./fixtures/columns.pdf', import.meta.url)).toString('base64');
  await page.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, pdf);
  await page.waitForURL(/\/read\//, { timeout: 15000 }).catch(() => {});
  check(/\/read\//.test(page.url()), 'tabs: a document dropped on Documents opens');
  // A file that can't be added says so on Settings too.
  await page.goto(BASE);
  await page.getByTestId('home-settings').locator('visible=true').click();
  await page.waitForURL(/\/settings/);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode('not a pdf at all')], 'broken.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.getByRole('alert').filter({ hasText: /broken\.pdf/ }).waitFor({ timeout: 15000 }).then(
    () => check(true, 'tabs: a file that can’t be added says so on any screen'),
    () => check(false, 'tabs: a file that can’t be added says so on any screen'),
  );
  await ctx.close();
}

// Appearance: Light / Dark / Auto; in Dark pages are dimmed, not inverted; "Invert colours" is per document.
async function appearance() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  // Someone who chose Black before 1.4 gets Dark.
  await ctx.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('quire.prefs', JSON.stringify({ theme: 'night' }));
      sessionStorage.setItem('seeded', '1');
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`appearance: ${e.message}`));
  await page.goto(BASE);
  await page.getByTestId('home-settings').locator('visible=true').click();
  check((await page.getByTestId('appearance-dark').locator('visible=true').getAttribute('aria-checked')) === 'true', 'appearance: an earlier Black theme becomes Dark');
  await page.goBack();
  await page.getByText('Open sample').click();
  const filter = () => page.evaluate(() => [...document.querySelectorAll('canvas')].find((c) => c.offsetParent && c.width > 200)?.style.filter ?? '');
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.offsetParent && c.width > 200), null, { timeout: 20000 });
  const dim = await filter();
  check(/brightness\(0\.7/.test(dim) && !/invert/.test(dim), `appearance: in Dark, pages are dimmed, not inverted (${dim})`);
  await page.getByTestId('open-appearance').click();
  await page.getByTestId('invert-toggle').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(/invert/.test(await filter()), 'appearance: Invert colours inverts the pages');
  // The switch turns it back, once per tap (the row is the switch: a tap doesn't reach two controls).
  await page.getByTestId('open-appearance').click();
  const knob = page.getByTestId('invert-toggle');
  check((await knob.getAttribute('role')) === 'switch' && (await knob.getAttribute('aria-checked')) === 'true', 'appearance: Invert colours is a switch, and says it is on');
  await knob.click();
  await page.waitForTimeout(300);
  const off = await filter();
  await knob.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!/invert/.test(off) && /invert/.test(await filter()), `appearance: the switch itself toggles Invert colours (${off || 'none'})`);
  // Reopened from the library (the static test server has no fallback for deep links).
  await page.goto(BASE);
  await docRows(page).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.offsetParent && c.width > 200), null, { timeout: 20000 });
  check(/invert/.test(await filter()), 'appearance: the document stays inverted');
  await page.keyboard.press('v');
  await page.getByTestId('text-view').waitFor();
  await page.getByTestId('open-appearance').click();
  check((await page.getByTestId('invert-toggle').count()) === 0, 'appearance: text view follows the appearance (no Invert colours)');
  await ctx.close();
}

// Picking several documents: in Documents (files in the archive) and in Reading (the library).
async function batch() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
    delete window.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`batch: ${e.message}`));
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString('base64');
  await page.evaluate(
    async (files) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive', { create: true });
      await root.getDirectoryHandle('Done', { create: true });
      for (const [name, b64] of files) {
        const w = await (await root.getFileHandle(name, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        await w.close();
      }
    },
    [
      ['one.pdf', fixture('columns.pdf')],
      ['two.pdf', fixture('tagged.pdf')],
      ['three.pdf', fixture('xrefstream.pdf')],
    ],
  );
  const names = (path) =>
    page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Archive');
      try {
        for (const d of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(d);
      } catch {
        return [];
      }
      const out = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push(name);
      return out.sort();
    }, path);
  await chooseTessel(page);

  await openDocs(page);
  for (let i = 0; i < 60 && (await vis('archive-hit').count()) < 3; i++) await page.waitForTimeout(500);
  const hit = (title) => vis('archive-hit').filter({ hasText: title });
  // Esc ends picking (as Back does on Android).
  await hit('Orderly Notes').click({ button: 'right' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await page.getByText(/selected$/).locator('visible=true').count()) === 0 && (await hit('Orderly Notes').getAttribute('aria-checked')) === null, 'batch: Esc ends picking');
  // A press on the same row right after a long press is taken as part of it: start again a moment later.
  await page.waitForTimeout(900);
  // No Select button: a right click (a long press) starts picking; a tap adds one more.
  check((await vis('select').count()) === 0, 'batch: no Select button (a long press starts picking)');
  await hit('Orderly Notes').click({ button: 'right' });
  await hit('Old title').click();
  check(/2 selected/.test(await page.getByText(/selected$/).locator('visible=true').innerText()), 'batch: documents are picked with a right click and a tap');
  check((await hit('Old title').getAttribute('aria-checked')) === 'true', 'batch: picked rows say so');
  check((await vis('act-move').count()) === 0 && (await vis('act-copy').count()) === 0, 'batch: no copy or move (Tessel has no folders)');
  // The bar with the count stays at the top while the list scrolls.
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(400);
  const barTop = (await vis('select-cancel').boundingBox())?.y ?? -1;
  check(barTop >= 0 && barTop < 120, `batch: the select bar stays at the top when the list scrolls (${barTop})`);

  // To the trash, and back.
  await page.goto(BASE);
  await openDocs(page);
  for (let i = 0; i < 60 && (await vis('archive-hit').count()) < 3; i++) await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  await hit('Orderly Notes').click({ button: 'right' });
  await hit('Old title').click();
  await vis('act-delete').click();
  await page.getByText('Moved 2 items to the trash.').waitFor({ timeout: 10000 });
  check((await names('')).join() === 'two.pdf' && (await vis('archive-hit').count()) === 1, `batch: deleting in the archive goes to its trash, and leaves the list (${await names('')})`);
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(1000);
  check((await names('')).join() === 'one.pdf,three.pdf,two.pdf', 'batch: and Undo puts them back');

  // One layout for every list: rows or tiles, chosen with the button.
  for (let i = 0; i < 40 && (await vis('archive-hit').count()) < 3; i++) await page.waitForTimeout(500);
  const wide = async (id) => ((await vis(id).first().boundingBox())?.width ?? 0) > 400;
  const listed = await wide('archive-hit');
  await vis('layout-toggle').click();
  const tiled = !(await wide('archive-hit'));
  await vis('layout-toggle').click();
  check(listed && tiled && (await wide('archive-hit')), 'layout: rows or tiles, chosen with the button');
  check((await vis('act-reading').count()) === 0, 'batch: no reading list to put documents on');
  await ctx.close();
}

// Improve text with AI: a document's recognised text is read again by the model and replaces the invisible text;
// typed pages stay as they are. The fake model gives its corrections from what it is sent.
async function improve() {
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`improve: ${e.message}`));
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const sent = [];
  let first = 'Improved Line One';
  await ctx.route('https://ai.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON();
    sent.push(body);
    const prompt = body.messages[0].content.at(-1).text;
    const images = body.messages[0].content.filter((c) => c.type === 'image_url').length;
    // Every line sent comes back as it was, but the first; one page gets handwriting.
    const ids = [...prompt.matchAll(/^(\d+\.\d+)\t(.*)$/gm)].map((m) => [m[1], m[2]]);
    const pages = Array.from({ length: images }, (_, i) => ({
      page: i + 1,
      lines: ids.filter(([id]) => id.startsWith(`${i + 1}.`)).map(([id, text], j) => ({ id, text: j === 0 ? first : text })),
      added: i === 0 ? [{ text: 'handwritten note', box: [100, 900, 500, 950] }] : [],
    }));
    const text = JSON.stringify({ title: '', date: '', sender: '', type: '', keywords: [], pages });
    return route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }) });
  });
  await page.goto(BASE);
  await vis('home-settings').click();
  await vis('ai-api-openai').click();
  await vis('ai-url').fill('https://ai.test/v1');
  await vis('ai-key').fill('sk-test');
  await vis('ai-model').fill('test-model');
  await page.waitForTimeout(300);

  await openFixture(page, 'mixed.pdf');
  await page.waitForTimeout(800);
  // How often the document has `q` (the find panel's count, once the search has settled).
  const found = async (q) => {
    if (!(await vis('find-panel').count())) await vis('open-find').click();
    await vis('search-input').fill(q);
    await page.waitForTimeout(1500);
    return vis('find-panel')
      .innerText()
      .then((x) => /\d+ results?|No matches/.exec(x)?.[0] ?? 'none');
  };
  const closeFind = async () => {
    // One Esc at a time: a second one while the panel is still closing would close the document.
    for (let i = 0; i < 3 && (await vis('find-panel').count()); i++) await page.keyboard.press('Escape').then(() => page.waitForTimeout(400));
    if (await vis('find-clear').count()) await vis('find-clear').click();
  };
  const run = async () => {
    await closeFind();
    // Read as it was added (or the last time) first: Improve is offered once that is done.
    await page.getByTestId('searchable-progress').waitFor({ state: 'detached', timeout: 180000 }).catch(() => {});
    await page.getByTestId('reader').waitFor();
    await page.waitForTimeout(500);
    await page.getByTestId('open-more').click();
    await page.getByTestId('menu-improve').click();
    const asked = await page.getByText(/go to ai\.test as images/).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await page.getByTestId('ask-confirm').click();
    const said = await page.getByText(/Text improved on/).waitFor({ timeout: 240000 }).then(() => page.getByText(/Text improved on/).innerText(), () => '');
    await page.getByTestId('reader').waitFor();
    await page.waitForTimeout(800);
    return { asked, said };
  };
  const one = await run();
  check(one.asked, 'improve: asks first, naming where the pages go');
  check(/on 1 page; 1 page with typed text left as it is/.test(one.said), `improve: the scanned page is read again, the typed one left alone (${one.said})`);
  const req = sent.at(-1);
  check(sent.length === 1 && req.messages[0].content.filter((c) => c.type === 'image_url').length === 1 && /2\.1|1\.1\t\S/.test(req.messages[0].content.at(-1).text), 'improve: the page image goes with the text read on the device');
  check((await found('Improved Line One')) === '1 result' && (await found('handwritten note')) === '1 result', 'improve: the corrected text and what the model added are in the document');
  check((await found('Orderly Notes')) !== 'No matches', 'improve: the typed page keeps its own text');
  // Again: the layer is replaced, not added to.
  first = 'Second Pass Line';
  const two = await run();
  check(/on 1 page/.test(two.said) && (await found('Improved Line One')) === 'No matches' && (await found('Second Pass Line')) === '1 result', `improve: done again, the earlier text is replaced (${two.said})`);
  check((await found('handwritten note')) === '1 result', 'improve: …once, not twice');
  await ctx.close();
}

// Viewing without keeping: a file opened from elsewhere isn't listed, its page is remembered on this device, and
// the first save asks to keep it (Cancel leaves it viewed, Keep makes it the library's).
async function viewed() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`viewed: ${e.message}`));
  await openFixture(page, 'columns.pdf', { view: true });
  await page.waitForTimeout(600);
  await page.keyboard.press('End');
  await page.waitForTimeout(1500);
  const left = (await page.getByTestId('page-label').innerText()).replace(/\s+/g, ' ').trim();
  await page.getByTestId('back').click();
  await page.getByText('Every document').waitFor({ timeout: 10000 }).then(
    () => check(true, 'viewed: closed, it isn’t in the library (Reading stays empty)'),
    () => check(false, 'viewed: closed, it isn’t in the library (Reading stays empty)'),
  );
  // The same file again: where it was left.
  await openFixture(page, 'columns.pdf', { view: true });
  await page.waitForTimeout(1200);
  const again = (await page.getByTestId('page-label').innerText()).replace(/\s+/g, ' ').trim();
  check(left.startsWith('2') && again === left, `viewed: opened again, it is where it was left (${left} → ${again})`);
  // A note is saved into it: asked to keep it first; Cancel leaves it viewed.
  await vis('page-note').click();
  await page.getByTestId('note-input').fill('Check');
  await page.getByTestId('note-save').click();
  await vis('save').click();
  await page.getByText('Keep in Tessel?').waitFor({ timeout: 5000 });
  check(/copy goes to the Tessel folder|stays where it is/.test(await page.getByTestId('ask-dialog').innerText()), 'viewed: saving a note asks to keep it first, saying where it goes');
  await page.getByTestId('ask-cancel').click();
  await page.waitForTimeout(300);
  check((await vis('save').count()) === 1, 'viewed: Cancel leaves it viewed, the note not saved yet');
  await vis('save').click();
  await page.getByTestId('ask-confirm').click();
  await page.waitForTimeout(1000);
  check((await vis('save').count()) === 0, 'viewed: Keep keeps it, and the note is saved');
  await page.getByTestId('back').click();
  await docRows(page).first().waitFor({ timeout: 10000 }).then(
    () => check(true, 'viewed: kept, it is the library’s'),
    () => check(false, 'viewed: kept, it is the library’s'),
  );
  // The history can be forgotten.
  await openFixture(page, 'tagged.pdf', { view: true });
  await page.getByTestId('back').click();
  await vis('home-settings').click();
  await vis('viewed-forget').click();
  await page.getByText('Forgotten.').waitFor({ timeout: 5000 }).then(
    () => check(true, 'viewed: Settings forgets the viewed documents'),
    () => check(false, 'viewed: Settings forgets the viewed documents'),
  );
  await ctx.close();
}

// A suite that throws is a failed check; the others still run.
const step = async (name, fn) => {
  if (only && !only.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    check(false, `${name}: stopped: ${String(e?.message ?? e).split('\n').slice(0, 3).join(' ')}`);
  }
};
await step('german', german);
await step('locked', locked);
await step('tagged', tagged);
await step('columns', columns);
await step('scan', scan);
await step('scanner', scanner);
await step('ai', aiReading);
await step('details', details);
await step('search', searchArchive);
await step('documents', documentsScreen);
await step('inbox', inbox);
await step('searchable', searchable);
await step('improve', improve);
await step('sync', syncSafety);
await step('batch', batch);
await step('many', manyDocs);
await step('shared', sharedReading);
await step('places', places);
await step('tabs', tabs);
await step('lastread', lastRead);
await step('viewed', viewed);
await step('appearance', appearance);
await step('regressions', regressions);
await step('books', books);
await step('shell', shellBridge);
await step('forms', forms);
await step('annotations', annotations);
await step('page-notes', pageNotes);
await step('undo', undoRedo);
await step('again', again);
await step('docked', docked);
await step('upgrade', upgrade);
await step('linked', linked);
await step('tessel-folder', tesselFolder);
await step('tidy', tidy);
await step('folders-shell', foldersShell);
await step('desktop', () => run('desktop', { width: 1280, height: 860 }, false));
await step('mobile', () => run('mobile', { width: 390, height: 844 }, true));
await browser.close();

for (const e of errors) console.log('console error:', e);
check(errors.length === 0, 'no console errors');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
