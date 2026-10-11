// End-to-end smoke test against a running web build (default: expo dev server on :8081).
// Usage: BASE=http://localhost:8081 node e2e/smoke.mjs
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:8081';
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Use a preinstalled Chromium when present, else Playwright's own (`npx playwright-core install chromium`).
const preinstalled = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(existsSync(preinstalled) ? { executablePath: preinstalled } : {});
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
    // Search from text view: matches are highlighted in the text, and picking a hit stays there.
    await page.getByTestId('view-toggle').click();
    await page.getByTestId('text-view').waitFor();
    await page.getByTestId('open-search').click();
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
    await page.getByTestId('view-toggle').click();
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
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
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
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
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

async function openFixture(page, file) {
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL(`./fixtures/${file}`, import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
}

// Text view v2: two columns read in order, figures and tables inline, figure tap opens its page.
async function columns() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`columns: ${e.message}`));
  await openFixture(page, 'columns.pdf');
  await page.getByTestId('view-toggle').click();
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
  await page.getByTestId('view-toggle').click();
  await page.getByTestId('ocr-start').click({ timeout: 15000 });
  const recognized = () => page.waitForFunction(() => /scanned pages/i.test(document.body.innerText) && /kept so it never runs twice/i.test(document.body.innerText), null, { timeout: 120000 });
  await recognized().then(
    () => check(true, 'scan: OCR recognizes the scanned text'),
    () => check(false, 'scan: OCR recognizes the scanned text'),
  );
  await page.getByTestId('back').click();
  await page.getByTestId('recent-row').first().waitFor();
  await page.reload();
  await page.getByTestId('recent-row').first().click();
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
  // Leaving with unsaved edits asks first (dismissed here: stay).
  page.once('dialog', (d) => d.dismiss());
  await page.getByTestId('back').click();
  check((await page.getByTestId('reader').count()) === 1, 'forms: leaving with unsaved edits asks first');
  await page.getByTestId('save').click();
  await page.getByText('Saved in Tessel').waitFor({ timeout: 5000 });
  await page.getByTestId('back').click();
  await page.getByTestId('recent-row').first().waitFor();
  await page.reload();
  await page.getByTestId('recent-row').first().click();
  await name.waitFor({ timeout: 10000 });
  const kept =
    (await name.inputValue()) === 'Ada Lovelace' &&
    (await page.getByTestId('field-size').nth(2).getAttribute('aria-checked')) === 'true' &&
    (await page.getByTestId('field-site').inputValue()) === '2' &&
    (await page.getByTestId('field-agree').getAttribute('aria-checked')) === 'true';
  check(kept, 'forms: text, radio, dropdown and checkbox values saved');
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
  await select(/^Every PDF you open lands in Recent/);
  await page.getByTestId('highlight-green').click();
  await select(/^Use Open PDF on the home screen/);
  await page.getByTestId('highlight-note').click();
  await page.getByTestId('note-input').fill('Try dragging a file in');
  await page.getByTestId('note-save').click();
  await page.getByTestId('save').waitFor();
  await page.getByTestId('open-contents').click();
  await page.getByTestId('tab-notes').click();
  const rows = page.getByTestId('note-row');
  await rows.nth(1).waitFor({ timeout: 5000 });
  const listed = (await rows.count()) === 2 && /Every PDF you open/.test(await rows.nth(0).innerText()) && /Try dragging a file in/.test(await rows.nth(1).innerText());
  check(listed, 'annotations: highlight and note listed with their text');
  await rows.nth(1).getByTestId('note-edit').click();
  await page.getByTestId('note-input').fill('Drop it anywhere');
  await page.getByTestId('note-save').click();
  await page.getByText('Drop it anywhere').waitFor({ timeout: 3000 });
  await rows.nth(0).getByTestId('note-delete').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=note-row]').length === 1, null, { timeout: 3000 });
  await page.getByTestId('save').click();
  await page.getByText('Saved in Tessel').waitFor({ timeout: 5000 });
  await page.getByTestId('back').click();
  await page.getByTestId('recent-row').first().waitFor();
  await page.reload();
  await page.getByTestId('recent-row').first().click();
  await page.getByTestId('open-contents').click();
  await page.getByTestId('tab-notes').click();
  await rows.first().waitFor({ timeout: 5000 });
  const kept = (await rows.count()) === 1 && /Drop it anywhere/.test(await rows.first().innerText()) && /Use Open PDF/.test(await rows.first().innerText());
  check(kept, 'annotations: edits and deletions saved into the PDF');
  await ctx.close();
}

// Open in place (Chromium): the library links to the user's file. Handles come from the origin-private
// file system, standing in for the picker; they behave like real ones (read, write, vanish).
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
  await page.getByTestId('add').click();
  await page.getByTestId('reader').waitFor();
  check((await page.getByTestId('page-label').innerText()).includes('2'), 'linked: opens the picked file in place');
  await page.getByTestId('back').click();
  check((await page.getByTestId('recent-row').first().innerText()).includes('In place'), 'linked: library marks it as opened in place');
  // Edited elsewhere: the library reads the file as it is now.
  await put('linked.pdf', 'tagged.pdf');
  await page.getByTestId('recent-row').first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(500);
  check(/\/\s*4/.test(await page.getByTestId('page-label').innerText()), 'linked: changes to the original show up on reopen');
  await page.getByTestId('back').click();
  // Moved away: say so, and let the reader find it again.
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('linked.pdf'));
  await page.getByTestId('recent-row').first().click();
  await page.getByTestId('open-error').waitFor();
  check(/isn’t where it was/.test(await page.getByTestId('open-error').innerText()), 'linked: a moved file is reported as moved');
  await put('found.pdf', 'columns.pdf');
  await page.evaluate(() => window.localStorage.setItem('pick', 'found.pdf'));
  await page.getByTestId('locate-file').click();
  await page.getByTestId('reader').waitFor({ timeout: 5000 }).then(
    () => check(true, 'linked: finding the file again reopens it'),
    () => check(false, 'linked: finding the file again reopens it'),
  );
  // Saving edits writes back into the user's own file.
  await page.getByTestId('back').click();
  await put('form.pdf', 'form.pdf');
  await page.evaluate(() => window.localStorage.setItem('pick', 'form.pdf'));
  await page.getByTestId('add').click();
  await page.getByTestId('field-name').click();
  await page.keyboard.type('Grace Hopper');
  await page.keyboard.press('Enter');
  await page.getByTestId('save').click();
  await page.getByText('Saved to “form.pdf”').waitFor({ timeout: 5000 });
  const written = await page.evaluate(async () => {
    const f = await (await (await navigator.storage.getDirectory()).getFileHandle('form.pdf')).getFile();
    return new TextDecoder('latin1').decode(await f.arrayBuffer()).includes('Grace Hopper');
  });
  check(written, 'linked: saving writes the filled form into the original file');
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
  await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => /\d+ Treffer/.test(document.body.innerText), null, { timeout: 10000 });
  check((await page.locator('html').getAttribute('lang')) === 'de', 'german: UI and <html lang> follow de-DE locale');
  await ctx.close();
}

// ONLY=linked,scan runs a subset while iterating.
const only = process.env.ONLY?.split(',');
const step = (name, fn) => (!only || only.includes(name) ? fn() : undefined);
await step('german', german);
await step('locked', locked);
await step('tagged', tagged);
await step('columns', columns);
await step('scan', scan);
await step('forms', forms);
await step('annotations', annotations);
await step('linked', linked);
await step('desktop', () => run('desktop', { width: 1440, height: 900 }, false));
await step('mobile', () => run('mobile', { width: 390, height: 844 }, true));
await browser.close();

for (const e of errors) console.log('console error:', e);
check(errors.length === 0, 'no console errors');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
