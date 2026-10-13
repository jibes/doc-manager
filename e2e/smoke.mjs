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

/** Page ↔ text view: the Text view button in the bar. */
async function switchView(page) {
  await page.getByTestId('view-toggle').click();
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
  await page.getByTestId('open-find').click();
  await page.getByTestId('find-panel').waitFor();
  await page.waitForTimeout(400);
  await shot('3-contents');
  await page.getByTestId('find-panel').getByText('The reading list', { exact: true }).click();
  await page.waitForTimeout(500);
  const afterToc = await page.getByTestId('page-label').innerText().catch(() => '');
  check(parseInt(afterToc, 10) === 5, `${name}: TOC jump to "The reading list" → page ${parseInt(afterToc, 10)}`);
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
  await page.getByTestId('bookmark').click();

  // Reading list: the toggle switches to reading behaviour (progress in the page pill).
  // It lives in the More menu (a document action).
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-reading').click();
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
  await switchView(page);
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
  // Leaving with unsaved edits asks first, in the app's own dialog (cancelled here: stay).
  await page.getByTestId('back').click();
  const asked = await page.getByTestId('ask-confirm').waitFor({ timeout: 3000 }).then(() => true, () => false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click().catch(() => {});
  check(asked && (await page.getByTestId('reader').count()) === 1, 'forms: leaving with unsaved edits asks first');
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
  await select(/^Use Open file on the home screen/);
  await page.getByTestId('highlight-note').click();
  await page.getByTestId('note-input').fill('Try dragging a file in');
  await page.getByTestId('note-save').click();
  await page.getByTestId('save').waitFor();
  await page.getByTestId('open-find').click();
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
  await page.getByTestId('open-find').click();
  await page.getByTestId('tab-notes').click();
  await rows.first().waitFor({ timeout: 5000 });
  const kept = (await rows.count()) === 1 && /Drop it anywhere/.test(await rows.first().innerText()) && /Use Open file/.test(await rows.first().innerText());
  check(kept, 'annotations: edits and deletions saved into the PDF');
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
  // A last page taller than the screen kept reading-list documents from ever finishing.
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-reading').click();
  await page.keyboard.press('End');
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await page.getByTestId('reading-list').waitFor();
  check(/Finished · 1/i.test(await page.getByTestId('reading-list').innerText()), 'regression: reaching the end finishes a reading-list document');
  await ctx.close();
}

// EPUB books: straight onto the reading list; contents, footnotes, inline formatting, figures, search,
// position, finishing; EPUB 2 contents; a broken file explained.
async function books() {
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`books: ${e.message}`));
  await openFixture(page, 'book.epub');
  const view = page.getByTestId('text-view');
  await view.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  const label = async () => (await page.getByTestId('page-label').innerText()).replace(/\s+/g, ' ');
  check(/^1 \/ \d+ · 0%/.test(await label()), `books: opens at the start, on the reading list (${await label()})`);
  const fmt = await view.evaluate((root) => {
    const span = (re) => [...root.querySelectorAll('span, div')].find((e) => e.children.length === 0 && re.test(e.textContent));
    const em = span(/^the tide$/);
    const strong = span(/^very$/);
    const para = em?.parentElement;
    const cs = (e) => e && getComputedStyle(e);
    return { em: cs(em)?.fontStyle, strong: cs(strong)?.fontWeight, same: cs(em)?.fontFamily === cs(para)?.fontFamily };
  });
  check(fmt.em === 'italic' && Number(fmt.strong) >= 600 && fmt.same, `books: inline emphasis keeps the text font (${JSON.stringify(fmt)})`);
  // Footnote reference → the note.
  await view.getByRole('link', { name: '1', exact: true }).first().click();
  await page.waitForTimeout(800);
  const noteShown = await view.evaluate((root) => [...root.querySelectorAll('div')].some((e) => e.children.length === 0 && /first ferry leaves/.test(e.textContent) && e.getBoundingClientRect().top < innerHeight && e.getBoundingClientRect().bottom > 0));
  check(noteShown, 'books: a footnote reference jumps to the note');
  // Reading hides the toolbars; a tap on the text brings them back.
  await page.keyboard.press('Home');
  await page.waitForTimeout(500);
  await page.mouse.move(640, 430);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 250);
  await page.waitForTimeout(700);
  const toolbar = () => page.getByTestId('back').evaluate((e) => { for (let n = e; n; n = n.parentElement) if (getComputedStyle(n).opacity === '0') return false; return true; });
  const hidden = !(await toolbar());
  await page.mouse.click(640, 430);
  await page.waitForTimeout(500);
  check(hidden && (await toolbar()), `books: a tap on the text shows the hidden toolbar (hidden before: ${hidden})`);
  // Contents.
  await page.getByTestId('open-find').click();
  await page.getByTestId('find-panel').getByText('The Harbour', { exact: true }).click();
  await page.waitForTimeout(800);
  check(/^1 \//.test(await label()), `books: contents jump to chapter one (${await label()})`);
  const img = await view.evaluate((root) => { const i = root.querySelector('img'); return i ? i.naturalWidth : -1; });
  check(img > 0, 'books: images from the book are shown');
  await page.getByTestId('find-panel').getByText('At dusk').click();
  await page.waitForTimeout(800);
  const dusk = await view.evaluate((root) => [...root.querySelectorAll('div')].some((e) => e.children.length === 0 && e.textContent === 'At dusk' && e.getBoundingClientRect().top > 50 && e.getBoundingClientRect().top < innerHeight));
  check(dusk, 'books: contents jump to a section');
  await page.keyboard.press('Escape');
  await page.getByTestId('find-panel').waitFor({ state: 'detached' });
  // Search.
  await page.keyboard.press('Control+f');
  await page.getByTestId('search-input').fill('first ferry');
  await page.waitForTimeout(500);
  await page.getByTestId('search-input').press('Enter');
  // Esc in the (focused) field closes the panel and keeps the matches.
  await page.getByTestId('search-input').press('Escape');
  await page.waitForTimeout(800);
  check((await page.getByTestId('find-panel').count()) === 0 && (await page.getByTestId('find-clear').count()) === 1, 'books: Esc in the search field closes search, keeps matches');
  const marked = await view.evaluate((root) => [...root.querySelectorAll('span')].filter((e) => /^first ferry$/i.test(e.textContent) && getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)').length);
  check(marked > 0, `books: search highlights matches (${marked})`);
  await page.getByTestId('find-clear').click();
  // Position is kept; reaching the end finishes the book.
  await page.keyboard.press('Home');
  await page.waitForTimeout(500);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1000);
  const before = await label();
  await page.keyboard.press('Escape');
  await page.getByTestId('reading-list').waitFor();
  const card = await page.getByTestId('reading-list').innerText();
  check(/Harbour Notes/.test(card) && /EPUB/.test(await page.getByTestId('recent-row').first().innerText()), 'books: listed as EPUB on the reading list');
  await page.reload();
  await page.getByTestId('continue').click();
  await view.waitFor();
  await page.waitForTimeout(1200);
  check((await label()) === before, `books: reopens where it was left (${before} → ${await label()})`);
  // Jumping to the end isn't reading it; scrolling there is.
  await page.keyboard.press('End');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Escape');
  await page.getByTestId('reading-list').waitFor();
  check(!/Finished/i.test(await page.getByTestId('reading-list').innerText()), 'books: jumping to the end does not finish the book');
  await page.getByTestId('continue').click();
  await view.waitFor();
  await page.waitForTimeout(800);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press(' ');
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.getByTestId('reading-list').waitFor();
  check(/Finished · 1/i.test(await page.getByTestId('reading-list').innerText()), 'books: reading to the end finishes the book');
  // EPUB 2 with an NCX table of contents.
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL('./fixtures/book2.epub', import.meta.url).pathname);
  await view.waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.getByTestId('open-find').click();
  await page.getByTestId('find-panel').getByText('Departure').waitFor({ timeout: 5000 }).then(
    () => check(true, 'books: EPUB 2 contents (NCX)'),
    () => check(false, 'books: EPUB 2 contents (NCX)'),
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // Not really an EPUB.
  await page.getByTestId('recent-row').first().waitFor();
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc2.setFiles({ name: 'broken.epub', mimeType: 'application/epub+zip', buffer: Buffer.from('not a zip') });
  await page.getByText('couldn’t be read as an EPUB book').waitFor({ timeout: 5000 }).then(
    () => check(true, 'books: a broken EPUB is explained'),
    () => check(false, 'books: a broken EPUB is explained'),
  );
  await ctx.close();
}

// Android app glue (window.TesselShell), faked here: files from "Open with" are added and opened,
// Save/Share go through the bridge with the exact bytes, and the system bars follow the theme.
async function shellBridge() {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) TesselShell/1.0' });
  await ctx.addInitScript(() => {
    const log = (window.__shell = { pending: [{ url: '/__shell/file/one', name: 'columns.pdf', type: 'application/pdf' }], calls: [], bytes: 0 });
    window.TesselShell = {
      pending: () => JSON.stringify(log.pending.splice(0)),
      begin: (name, mime) => (log.calls.push(['begin', name, mime]), 't1'),
      append: (_t, b64) => void (log.bytes += atob(b64).length),
      finish: (_t, action) => void log.calls.push(['finish', action]),
      theme: (bg, dark) => void log.calls.push(['theme', bg, dark]),
      hasLightSensor: () => true,
      light: (on) => void log.calls.push(['light', on]),
      request: (id, method) =>
        setTimeout(() => window.dispatchEvent(new CustomEvent('tessel-shell-reply', { detail: { id, ok: true, value: method === 'folders' ? [] : { allFiles: false } } })), 10),
    };
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
  await page.waitForTimeout(500);
  await page.getByTestId('open-more').click();
  await page.getByText('Share', { exact: true }).click();
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => window.__shell);
  const shared = log.calls.some((c) => c[0] === 'finish' && c[1] === 'share') && log.calls.some((c) => c[0] === 'begin' && c[1] === 'columns.pdf' && c[2] === 'application/pdf');
  check(shared && log.bytes === pdf.length, `shell: share hands the exact file to the app (${log.bytes} of ${pdf.length} bytes)`);
  check(log.calls.some((c) => c[0] === 'theme' && /^#/.test(c[1])), 'shell: system bars follow the theme');
  check((await page.getByTestId('install').count()) === 0, 'shell: no install button inside the app');
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
  await page.getByTestId('open-find').click();
  await page.getByTestId('search-input').fill('tessel');
  await page.waitForFunction(() => /\d+ Treffer/.test(document.body.innerText), null, { timeout: 10000 });
  check((await page.locator('html').getAttribute('lang')) === 'de', 'german: UI and <html lang> follow de-DE locale');
  await ctx.close();
}

// Files (desktop Chromium): a picked folder, browsed as a grid with thumbnails. The folder lives in the
// origin-private file system, standing in for the picker (Playwright can't answer it).
async function foldersDesktop() {
  const ctx = await newContext({ viewport: { width: 1280, height: 800 } }, { fsa: true });
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Library');
  });
  const page = await ctx.newPage();
  // Screens below the top of the stack stay mounted (hidden): look at the visible one only.
  const vis = (id) => page.getByTestId(id).locator('visible=true');
  page.on('pageerror', (e) => errors.push(`folders: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && errors.push(`folders: ${m.text()}`));
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
  await page.getByTestId('tab-files').locator('visible=true').click();
  await vis('add-folder').click();
  await vis('folder-grid').waitFor();
  const docs = vis('folder-doc');
  check((await docs.count()) === 2 && (await vis('folder-dir').count()) === 1, 'folders: a picked folder lists its PDFs and subfolders, nothing else');
  const thumbs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="folder-doc"] img')].filter((i) => i.checkVisibility()).filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="folder-doc"] img')].filter((i) => i.checkVisibility()).filter((i) => i.naturalWidth > 0).length === 2, null, { timeout: 15000 }).catch(() => {});
  check((await thumbs()) === 2, `folders: PDFs show their first page as a thumbnail (${await thumbs()})`);
  const names = async () => (await docs.allInnerTexts()).map((x) => x.split('\n')[0]);
  const byName = await names();
  await vis('sort').click();
  const byDate = await names();
  check(byName[0] === 'columns' && byDate[0] === 'form', `folders: sorts by name and by date (${byName} / ${byDate})`);
  await page.screenshot({ path: `${OUT}folders-grid.png` });
  await vis('folder-dir').click();
  await page.getByText('book', { exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="folder-doc"] img')].filter((i) => i.checkVisibility()).some((i) => i.naturalWidth > 0), null, { timeout: 10000 }).catch(() => {});
  check((await thumbs()) === 1, 'folders: books show their cover');
  await vis('screen-back').click();
  await page.getByText('columns', { exact: true }).locator('visible=true').first().click();
  await page.getByTestId('reader').waitFor();
  check((await page.getByTestId('page-label').innerText()).includes('2'), 'folders: a document opens from the grid');
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().waitFor();
  check((await page.getByTestId('recent-row').first().innerText()).includes('In place'), 'folders: opened documents stay where they are (in place)');
  // Thumbnails are kept: on return they come from the cache, without reading the files again.
  await page.getByTestId('tab-files').locator('visible=true').click();
  await vis('folder-root').click();
  await vis('folder-grid').waitFor();
  await page.waitForTimeout(400);
  check((await thumbs()) === 2 && (await vis('thumb-pending').count()) === 0, 'folders: thumbnails are cached');
  // File operations on the folder itself.
  // Tiles show document names without their extension.
  const text = (x) => page.getByText(x.replace(/\.(pdf|epub)$/, ''), { exact: true }).locator('visible=true');
  const inOpfs = (path) =>
    page.evaluate(async (path) => {
      let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Library');
      const parts = path.split('/');
      try {
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
        await dir.getFileHandle(parts.at(-1)).catch(() => dir.getDirectoryHandle(parts.at(-1)));
        return true;
      } catch {
        return false;
      }
    }, path);
  await vis('new-folder').click();
  await page.getByTestId('ask-input').fill('Archive');
  await page.getByTestId('ask-confirm').click();
  await text('Archive').waitFor({ timeout: 5000 }).catch(() => {});
  check(await inOpfs('Archive'), 'folders: a new folder is made in the folder');
  await text('form.pdf').click({ button: 'right' });
  await vis('act-rename').click();
  await page.getByTestId('ask-input').fill('visit.pdf');
  await page.getByTestId('ask-confirm').click();
  await text('visit.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await inOpfs('visit.pdf')) && !(await inOpfs('form.pdf')), 'folders: right-click selects; a document can be renamed');
  await text('visit.pdf').click({ button: 'right' });
  await vis('act-move').click();
  await text('Archive').click();
  await vis('paste').click();
  await text('visit.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await inOpfs('Archive/visit.pdf')) && !(await inOpfs('visit.pdf')), 'folders: a document moves into another folder');
  await vis('select').click();
  await text('visit.pdf').click();
  await vis('act-copy').click();
  await vis('screen-back').click();
  await vis('paste').click();
  await text('visit.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await inOpfs('visit.pdf')) && (await inOpfs('Archive/visit.pdf')), 'folders: a document can be copied');
  await text('Archive').click({ button: 'right' });
  await vis('act-delete').click();
  await page.getByTestId('ask-confirm').click();
  await page.waitForTimeout(500);
  check(!(await inOpfs('Archive')) && (await text('Archive').count()) === 0, 'folders: a folder can be deleted with what is in it');
  await vis('screen-back').click();
  await vis('home-settings').click();
  check((await vis('all-files').count()) === 0, 'folders: no all-files switch outside the Android app');
  await vis('remove-folder').click();
  await page.waitForTimeout(300);
  check((await vis('settings-folders').count()) === 0, 'folders: a folder can be removed in settings');
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
      list: ({ root, dir }) => {
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
  const names = async () => (await vis('folder-grid').innerText()).split('\n');
  const shownThumbs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="folder-doc"] img')].filter((i) => i.checkVisibility() && i.naturalWidth > 0).length);
  await page.goto(BASE);
  await page.getByText('Every document').waitFor();
  await vis('tab-files').click();
  await vis('add-folder').click();
  await vis('folder-grid').waitFor({ timeout: 10000 }).catch(() => {});
  check((await vis('folder-grid').count()) === 1, 'folders-shell: a picked folder opens (its ID survives the route)');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="folder-doc"] img')].filter((i) => i.checkVisibility() && i.naturalWidth > 0).length === 2, null, { timeout: 15000 }).catch(() => {});
  check((await shownThumbs()) === 2, `folders-shell: the folder is listed with a thumbnail for the PDF and the book (${await shownThumbs()})`);
  await page.screenshot({ path: `${OUT}folders-shell-grid.png` });
  // A long press on a phone also fires a context menu, and its release a tap: the item stays selected.
  await text('columns.pdf').click({ button: 'right' });
  await text('columns.pdf').dispatchEvent('contextmenu');
  await text('columns.pdf').click();
  await page.waitForTimeout(200);
  check((await page.getByText('1 selected').locator('visible=true').count()) === 1, 'folders-shell: a long press selects the item and it stays selected');
  // The bars fit on a phone: nothing sticks out past the screen.
  const fits = (id) =>
    page.evaluate((id) => {
      const bar = [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => e.checkVisibility());
      return !!bar && [...bar.querySelectorAll('*')].every((e) => e.getBoundingClientRect().right <= innerWidth + 0.5);
    }, id);
  check(await fits('action-bar'), 'folders-shell: the selection actions fit on a phone');
  await vis('select-cancel').click();

  // Edits to a document opened from a folder are written back to it.
  await text('Papers').click();
  await text('form.pdf').click();
  await page.getByTestId('field-name').click();
  await page.keyboard.type('Grace Hopper');
  await page.keyboard.press('Enter');
  await page.getByTestId('save').click();
  await page.getByText('Saved to “form.pdf”').waitFor({ timeout: 5000 }).catch(() => {});
  const written = await page.evaluate(() => Object.entries(window.__shell.written).find(([u]) => u.includes('/form/'))?.[1] ?? '');
  check(written.includes('Grace Hopper'), 'folders-shell: saving writes the filled form back to the file in its folder');
  await vis('back').click();
  await vis('screen-back').click();

  // New folder, then move a document into it (via select → Move → open the folder → paste).
  await vis('new-folder').click();
  await page.getByTestId('ask-input').fill('Archive');
  await page.getByTestId('ask-confirm').click();
  await text('Archive').waitFor({ timeout: 5000 }).catch(() => {});
  check((await names()).includes('Archive'), 'folders-shell: a new folder can be made');
  await text('columns.pdf').click();
  await page.getByTestId('reader').waitFor();
  await vis('back').click();
  await vis('select').click();
  await text('columns.pdf').click();
  await page.screenshot({ path: `${OUT}folders-shell-select.png` });
  await vis('act-move').click();
  await page.screenshot({ path: `${OUT}folders-shell-paste.png` });
  check(await fits('paste-bar'), 'folders-shell: the paste bar fits on a phone');
  await text('Archive').click();
  await vis('paste').click();
  await text('columns.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await names()).includes('columns'), 'folders-shell: a document moves into another folder');
  await vis('screen-back').click();
  await page.waitForTimeout(300);
  check(!(await names()).includes('columns'), 'folders-shell: …and is gone from where it was');
  // Rename it there; the library follows the file through the move and the rename.
  await text('Archive').click();
  await page.locator('[data-testid="folder-doc"]:visible').first().click({ button: 'right' }).catch(() => {});
  if (!(await vis('action-bar').count())) {
    await vis('select').click();
    await text('columns.pdf').click();
  }
  await vis('act-rename').click();
  await page.getByTestId('ask-input').fill('two columns.pdf');
  await page.getByTestId('ask-confirm').click();
  await text('two columns.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await names()).includes('two columns'), 'folders-shell: a document can be renamed');
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().waitFor();
  const rows = await page.getByTestId('recent-row').allInnerTexts();
  const row = page.getByTestId('recent-row').filter({ hasText: 'Orderly Notes' });
  check(rows.some((r) => r.includes('Orderly Notes')), 'folders-shell: the library keeps a moved and renamed document');
  await row.first().click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(500);
  check((await page.getByTestId('open-error').count()) === 0 && (await page.getByTestId('page-label').innerText()).includes('2'), 'folders-shell: …and opens it from its new place');

  // Copy back to the top folder, share, then delete the copy (and its library entry with it).
  await page.goto(BASE);
  await vis('tab-files').click();
  await vis('folder-root').filter({ hasText: 'Docs' }).click();
  await text('Archive').click();
  await vis('select').click();
  await text('two columns.pdf').click();
  await vis('act-share').click();
  await page.waitForTimeout(200);
  check((await page.evaluate(() => window.__shell.shared.length)) === 1, 'folders-shell: documents can be shared to other apps');
  await vis('select').click();
  await text('two columns.pdf').click();
  await vis('act-copy').click();
  await vis('screen-back').click();
  await vis('paste').click();
  await text('two columns.pdf').waitFor({ timeout: 5000 }).catch(() => {});
  check((await names()).includes('two columns'), 'folders-shell: a document can be copied to another folder');
  await text('Archive').click();
  await vis('select').click();
  await text('two columns.pdf').click();
  await vis('act-delete').click();
  await page.getByTestId('ask-confirm').click();
  await page.waitForTimeout(500);
  check(!(await names()).includes('two columns'), 'folders-shell: a document can be deleted');
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().waitFor();
  const left = await page.getByTestId('recent-row').allInnerTexts();
  check(!left.some((r) => r.includes('Orderly Notes')), `folders-shell: a deleted document leaves the library (${left.length} left)`);

  // All files access (Settings): every document on the device, and internal storage.
  await vis('tab-files').click();
  await vis('home-settings').click();
  await vis('all-files').click();
  await page.waitForTimeout(300);
  await vis('screen-back').click();
  await text('All documents').waitFor({ timeout: 5000 }).catch(() => {});
  const roots = await vis('folder-root').allInnerTexts();
  check(roots.join('|').includes('All documents') && roots.join('|').includes('Internal storage'), `folders-shell: all files access adds every document and internal storage (${roots.join(', ')})`);
  await text('All documents').click();
  await vis('folder-grid').waitFor();
  const all = await vis('folder-doc').allInnerTexts();
  check(all.length === 3 && all[0].startsWith('form\n') && all[0].includes('Papers'), `folders-shell: all documents, newest first, with their folder (${all.map((x) => x.split('\n')[0])})`);
  check((await vis('new-folder').count()) === 0, 'folders-shell: no new folder in “All documents”');

  // A scan saved into a folder through the app.
  await page.goto(BASE);
  await page.getByTestId('scan').click();
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  await vis('scan-title').fill('Receipt');
  await vis('scan-destination').click();
  await page.getByRole('radio', { name: 'Docs' }).click();
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const created = await page.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem('fake')).nodes).find((n) => n.name === 'Receipt.pdf'));
  check(created?.parent === 'root' && created.data.startsWith('%PDF-'), 'folders-shell: a scan is saved into the folder');
  // Details written into the file in the folder (in place, through the app).
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('ACME Instruments');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  // What the app was asked to write back to the file (the fake app logs it).
  const rewritten = await page.evaluate(() => Object.entries(window.__shell.written).find(([u]) => u.includes('/created/'))?.[1] ?? '');
  check(rewritten.startsWith(created.data.slice(0, 200)) && /\/Author \(ACME Instruments\)/.test(rewritten) && rewritten.length > created.data.length, `folders-shell: details are appended to the file in its folder (${rewritten.length} bytes)`);
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().waitFor();
  check((await page.getByTestId('recent-row').first().innerText()).includes('Receipt'), 'folders-shell: the saved scan is in the library');

  // A file opened from elsewhere (system picker) becomes a real file in Documents/Tessel, not a hidden copy.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await chooser.setFiles(new URL('./fixtures/tagged.pdf', import.meta.url).pathname);
  await page.waitForURL(/\/read\//, { timeout: 30000 });
  const kept = await page.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem('fake')).nodes).find((n) => n.name === 'tagged.pdf'));
  check(kept?.parent === 'app', 'folders-shell: a file opened from elsewhere is kept in the Tessel folder');
  await page.goto(BASE);
  await vis('tab-files').click();
  const first = await vis('folder-root').first().innerText();
  check(first.startsWith('Tessel'), `folders-shell: the Tessel folder is the first place in Files (${first.split('\n')[0]})`);
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
  await ctx.route('https://ai.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = req.postDataJSON();
    sent.push({ url: req.url(), headers: req.headers(), body });
    if (failing) return route.fulfill({ status: 500, headers: cors, body: 'down for maintenance' });
    const text = JSON.stringify(reply);
    if (req.url().endsWith('/v1/messages')) {
      return route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) });
    }
    return route.fulfill({ headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }) });
  });

  await page.goto(BASE);
  await vis('tab-files').click();
  await vis('home-settings').click();
  await vis('ai-api-anthropic').click();
  await vis('ai-url').fill('https://ai.test');
  await vis('ai-key').fill('sk-test');
  await vis('ai-model').fill('test-model');
  await vis('ai-test').click();
  await page.getByText('It works.').waitFor({ timeout: 15000 }).then(() => check(true, 'ai: Test reaches the model'), () => check(false, 'ai: Test reaches the model'));
  const probe = sent.at(-1);
  check(probe?.headers['x-api-key'] === 'sk-test' && probe?.body.model === 'test-model' && probe?.body.output_config?.format?.type === 'json_schema', 'ai: Anthropic request carries key, model and the JSON schema');

  // A scan read with AI: no title typed, so the model's names the file.
  await page.goto(BASE);
  await page.getByTestId('scan').click();
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  await vis('scan-ai').click();
  check((await vis('scan-ai').getAttribute('aria-checked')) === 'true' && (await page.getByText(/Sends the pages to ai\.test/).count()) > 0, 'ai: the scan offers AI reading, naming the host');
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const call = sent.at(-1);
  const content = call?.body.messages?.[0]?.content ?? [];
  check(content.some((c) => c.type === 'image' && c.source?.data?.length > 1000) && /1\.1\t/.test(content.at(-1)?.text ?? ''), 'ai: the page image and the device’s lines are sent');
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().waitFor();
  const row = await page.getByTestId('recent-row').first().innerText();
  check(row.includes('2026-10-02 Musterwerke Zürich – Rechnung 40217'), `ai: the model names the file (${row.split('\n')[0]})`);
  await page.getByTestId('recent-row').first().click();
  await switchView(page);
  await page.waitForFunction(() => /bez zum 30\.10\.2026/.test(document.body.innerText) && /ACME Instruments GmbH/.test(document.body.innerText), null, { timeout: 30000 }).then(
    () => check(true, 'ai: corrected and added text is in the PDF'),
    () => check(false, 'ai: corrected and added text is in the PDF'),
  );

  // OpenAI-compatible, and the server fails: saved anyway, with the device's text, and the user is told.
  await page.goto(BASE);
  await vis('tab-files').click();
  await vis('home-settings').click();
  await vis('ai-api-openai').click();
  await vis('ai-url').fill('https://ai.test/v1');
  failing = true;
  await page.goto(BASE);
  await page.getByTestId('scan').click();
  await page.locator('input[type=file]').setInputFiles(new URL('./fixtures/scan-photo.jpg', import.meta.url).pathname);
  await vis('scan-tile').first().waitFor({ timeout: 120000 });
  await vis('scan-title').fill('Offline');
  await vis('scan-save').click();
  await page.getByText('AI reading failed').waitFor({ timeout: 300000 }).then(() => check(true, 'ai: a failure is reported'), () => check(false, 'ai: a failure is reported'));
  const oa = sent.at(-1);
  check(oa?.url === 'https://ai.test/v1/chat/completions' && oa?.headers.authorization === 'Bearer sk-test' && oa?.body.messages[0].content.some((c) => c.type === 'image_url'), 'ai: OpenAI-compatible request to /chat/completions with the image');
  await page.getByTestId('ask-confirm').click();
  await page.waitForURL(/\/read\//, { timeout: 30000 });
  check(true, 'ai: the scan is saved anyway');
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
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
    await fc.setFiles(new URL(`./fixtures/${fixture}`, import.meta.url).pathname);
    await page.getByTestId('reader').waitFor();
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
    await page.getByTestId('recent-row').first().waitFor();
    check((await page.getByTestId('recent-row').first().innerText()).includes(`Rechnung 40217 ${kind}`), `details: the library shows the new title (${kind})`);
  }
  // A bad date is caught before anything is written.
  await page.getByTestId('recent-row').first().click();
  await page.getByTestId('reader').waitFor();
  await panel();
  await page.getByTestId('detail-date').fill('2.10.2026');
  await page.getByTestId('details-save').click();
  check(await page.getByText('Write the date as YYYY-MM-DD.').isVisible(), 'details: a date not in YYYY-MM-DD is refused');
  await page.keyboard.press('Escape');

  // Protected PDF.
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL('./fixtures/locked.pdf', import.meta.url).pathname);
  await page.getByTestId('password-input').fill('tessel');
  await page.getByTestId('password-submit').click();
  await page.getByTestId('reader').waitFor();
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
  await vis('tab-files').click();
  await vis('add-folder').click();
  await vis('folder-grid').waitFor();
  // One document in the library too.
  await page.goto(BASE);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('add').click()]);
  await fc.setFiles(new URL('./fixtures/xrefstream.pdf', import.meta.url).pathname);
  await page.getByTestId('reader').waitFor();
  await page.goto(BASE);
  // The search field appears once something is indexed.
  await vis('library-search').waitFor({ timeout: 30000 });
  const hits = async (q) => {
    await vis('library-search').fill(q);
    await page.waitForTimeout(600);
    return vis('archive-hit').allInnerTexts();
  };
  // Indexing may still be going: wait for the folder's document to be found.
  let found = [];
  for (let i = 0; i < 30 && !found.length; i++) found = await hits('Orderly');
  check(found.length === 1 && /Archive/.test(found[0]), `search: a document in a folder's subfolder is found by its text (${found.map((x) => x.split('\n')[0])})`);
  check((await hits('Old title')).length === 0, 'search: a library document already listed above is not repeated');
  // "Cross references" in the folder's document matches too.
  let inLibrary = [];
  for (let i = 0; i < 30 && !inLibrary.some((x) => x.startsWith('Old title')); i++) inLibrary = await hits('cross-reference');
  check(inLibrary.some((x) => x.startsWith('Old title')), `search: a library document is found by its text (${inLibrary.map((x) => x.replace(/\n/g, ' / '))})`);
  const hidden = await hits('Annual');
  check(hidden.every((x) => !/old/.test(x)), 'search: hidden folders (.stversions) are left out');

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
  await page.getByTestId('recent-row').filter({ hasText: 'Old title' }).first().click();
  await page.getByTestId('reader').waitFor();
  await page.getByTestId('open-more').click();
  await page.getByTestId('menu-details').click();
  await page.getByTestId('detail-sender').fill('Haferflocken Handels GmbH');
  await page.getByTestId('details-save').click();
  await page.getByText('Details saved in the file.').waitFor({ timeout: 15000 });
  await page.goto(BASE);
  await vis('library-search').waitFor({ timeout: 30000 });
  // It is in the library, so it shows there (by its sender); search the text it was indexed with plus the new sender.
  let byDetails = [];
  for (let i = 0; i < 20 && !byDetails.length; i++) byDetails = await hits('Haferflocken Stream');
  const listed = await page.getByTestId('recent-row').filter({ hasText: 'Old title' }).count();
  check(byDetails.length === 1 || listed === 1, `search: details saved in a document are found (${byDetails.length} in all documents, ${listed} in the library)`);
  // The same file opened from the folder isn't counted twice.
  check((await hits('Orderly')).length === 1, 'search: a folder file opened into the library is listed once');
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
  await page.getByTestId('scan').click();
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
  await page.getByTestId('scan').click();
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

  await vis('scan-title').fill('Invoice ACME');
  await vis('scan-destination').click();
  await page.getByText(/^Other folder/).click();
  await page.getByText('Scans').first().waitFor();
  await vis('scan-save').click();
  await page.waitForURL(/\/read\//, { timeout: 300000 });
  const saved = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('Scans');
    const file = await (await dir.getFileHandle('Invoice ACME.pdf')).getFile();
    return new TextDecoder().decode((await file.slice(0, 5).arrayBuffer()));
  }).catch(() => null);
  check(saved === '%PDF-', 'scanner: PDF written into the chosen folder');
  await switchView(page);
  await page.waitForFunction(() => /ACME/.test(document.body.innerText) && /INVOICE/i.test(document.body.innerText), null, { timeout: 30000 }).then(
    () => check(true, 'scanner: recognised text is in the PDF'),
    () => check(false, 'scanner: recognised text is in the PDF'),
  );
  await page.goto(BASE);
  await page.getByTestId('scan').click();
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
    check((await vis('tab-library').getAttribute('aria-selected')) === 'true', `tabs (${name}): Library is the current tab`);
    await vis('tab-files').click();
    await vis('add-folder').first().waitFor();
    check((await vis('tab-files').getAttribute('aria-selected')) === 'true', `tabs (${name}): Files opens from its tab`);
    check((await vis('open-other').count()) === 1, `tabs (${name}): Files offers other locations (system picker)`);
    await vis('tab-library').click();
    await page.getByText('Open sample').waitFor();
    // Switching back returns to the library rather than stacking it over Files (stacked screens stay mounted).
    check((await page.getByTestId('open-other').count()) === 0, `tabs (${name}): switching tabs does not stack screens`);
    await vis('scan').click();
    await page.waitForURL(/\/scan/);
    check(true, `tabs (${name}): Scan opens the camera`);
    await ctx.close();
  }
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
  // The switch itself turns it back (the tap must not reach both the switch and its row).
  await page.getByTestId('open-appearance').click();
  const knob = page.getByTestId('invert-toggle').getByRole('switch');
  await knob.click();
  await page.waitForTimeout(300);
  const off = await filter();
  await knob.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(!/invert/.test(off) && /invert/.test(await filter()), `appearance: the switch itself toggles Invert colours (${off || 'none'})`);
  // Reopened from the library (the static test server has no fallback for deep links).
  await page.goto(BASE);
  await page.getByTestId('recent-row').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.offsetParent && c.width > 200), null, { timeout: 20000 });
  check(/invert/.test(await filter()), 'appearance: the document stays inverted');
  await page.keyboard.press('v');
  await page.getByTestId('text-view').waitFor();
  await page.getByTestId('open-appearance').click();
  check((await page.getByTestId('invert-toggle').count()) === 0, 'appearance: text view follows the appearance (no Invert colours)');
  await ctx.close();
}

const step = (name, fn) => (!only || only.includes(name) ? fn() : undefined);
await step('german', german);
await step('locked', locked);
await step('tagged', tagged);
await step('columns', columns);
await step('scan', scan);
await step('scanner', scanner);
await step('ai', aiReading);
await step('details', details);
await step('search', searchArchive);
await step('tabs', tabs);
await step('appearance', appearance);
await step('regressions', regressions);
await step('books', books);
await step('shell', shellBridge);
await step('forms', forms);
await step('annotations', annotations);
await step('linked', linked);
await step('folders', foldersDesktop);
await step('folders-shell', foldersShell);
await step('desktop', () => run('desktop', { width: 1440, height: 900 }, false));
await step('mobile', () => run('mobile', { width: 390, height: 844 }, true));
await browser.close();

for (const e of errors) console.log('console error:', e);
check(errors.length === 0, 'no console errors');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
