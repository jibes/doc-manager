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
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile, hasTouch: isMobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (errors.push(`${name}: ${e.message}`), console.log('pageerror:', e.message.slice(0, 400))));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && (errors.push(`${name}: ${m.text()}`), console.log('console:', m.text().slice(0, 600))));
  const shot = (n) => page.screenshot({ path: `${OUT}${name}-${n}.png` });

  await page.goto(BASE);
  await page.getByText('A quiet place').waitFor();
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
  check(/^\s*[3-9]|1\d/.test(label), `${name}: page indicator advanced (${label.replace(/\s+/g, ' ')})`);

  // Chrome hides while reading forward; a short scroll back reveals it.
  const reveal = async () => {
    await page.mouse.wheel(0, -160);
    await page.waitForTimeout(350);
  };
  await reveal();
  await page.getByTestId('open-contents').click();
  await page.getByTestId('contents-panel').waitFor();
  await page.waitForTimeout(400);
  await shot('3-contents');
  await page.getByText('The Margin', { exact: true }).click();
  await page.waitForTimeout(500);
  const afterToc = await page.getByTestId('page-label').innerText().catch(() => '');
  check(afterToc.trim().startsWith('10'), `${name}: TOC jump to "The Margin" → page ${afterToc.trim().split(/\s/)[0]}`);
  if (!isMobile) await page.getByTestId('open-contents').click();

  await reveal();
  await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill('quire');
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
  const marks = await page.getByTestId('hit').count() + (await page.getByTestId('hit-active').count());
  check(marks > 0 && (await page.getByTestId('hit-active').count()) > 0, `${name}: ${marks} highlights on page with panel closed`);
  await page.getByTestId('find-next').click();
  await page.waitForTimeout(500);
  const findStatus = await page.getByTestId('find-bar').innerText();
  check(/2 of \d+/.test(findStatus), `${name}: find bar stepped → ${findStatus.replace(/\s+/g, ' ')}`);
  await shot('4b-findbar');
  await page.getByTestId('find-clear').click();
  await page.waitForTimeout(300);
  check((await page.getByTestId('hit').count()) === 0 && !(await page.getByTestId('find-bar').isVisible().catch(() => false)), `${name}: clearing removes highlights`);

  await reveal();
  await page.getByTestId('open-appearance').click();
  await page.getByLabel('Night').click();
  await page.waitForTimeout(500);
  await shot('5-night');
  await page.getByLabel('Sepia').click();
  await page.waitForTimeout(400);
  await shot('6-sepia');
  await page.getByLabel('Automatic').click();
  await page.keyboard.press('Escape');

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
  check(scrubbed >= 15, `${name}: scrubber seek → page ${scrubbed}`);

  await reveal();
  await page.getByTestId('bookmark').click();
  await page.getByTestId('back').click();
  await page.getByTestId('continue').waitFor();
  await page.waitForTimeout(800);
  await shot('8-library');

  // Persistence: reload, reopen, expect the same page.
  await page.reload();
  await page.getByTestId('continue').click();
  await page.getByTestId('reader').waitFor();
  await page.waitForTimeout(1200);
  const resumed = parseInt((await page.getByTestId('page-label').innerText()).trim(), 10);
  check(Math.abs(resumed - scrubbed) <= 1, `${name}: resumed at page ${resumed} (left at ${scrubbed})`);
  await ctx.close();
}

await run('desktop', { width: 1440, height: 900 }, false);
await run('mobile', { width: 390, height: 844 }, true);
await browser.close();

for (const e of errors) console.log('console error:', e);
check(errors.length === 0, 'no console errors');
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
