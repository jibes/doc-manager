import { browser, ctxFor, watch, vis, docRows, keepOpen, painted, BASE } from './lib.mjs';
const size = process.argv[2] ?? 'desktop', scheme = process.argv[3] ?? 'light', locale = process.argv[4] ?? 'en-US';
const ctx = await ctxFor({ size, scheme, locale });
const page = await ctx.newPage();
const N = `rd-${size}-${scheme}-${locale.slice(0,2)}`;
const shot = watch(page, N);
const log = (...a) => console.log(N, ...a);
const step = async (name, fn) => { try { await fn(); } catch (e) { log('FAIL', name, e.message.split('\n')[0].slice(0, 200)); await shot('fail-' + name); } };
await page.goto(BASE);
await vis(page, 'sample').click();
await page.getByTestId('reader').waitFor();
await painted(page);
await keepOpen(page);
await page.waitForSelector('[data-testid=text-layer] span');
const selSpan = async (re) => {
  const span = page.locator('[data-testid=text-layer] span', { hasText: re }).first();
  await span.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
  const b = await span.boundingBox();
  await page.mouse.move(b.x + 1, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 6 }); await page.mouse.up();
  await page.getByTestId('selection-bubble').waitFor({ timeout: 3000 });
  return b;
};
const tid = (id) => vis(page, id);
const saveVisible = async () => (await page.getByTestId('save').locator('visible=true').count()) > 0;
const hlCount = () => page.evaluate(() => document.querySelectorAll('[data-testid^=hl], [data-annot], .hl').length);
let hb;
await step('highlight', async () => {
  hb = await selSpan(/^Everything comes in one way/);
  await page.getByTestId('highlight-yellow').click();
  await page.waitForTimeout(500);
  log('after highlight: save visible', await saveVisible(), 'undo', await page.getByTestId('undo').locator('visible=true').count());
  await shot('01-highlight');
});
await step('undo-redo', async () => {
  await tid('undo').click(); await page.waitForTimeout(400); await shot('02-undo');
  log('after undo: save', await saveVisible(), 'redo vis', await page.getByTestId('redo').locator('visible=true').count());
  await tid('redo').click(); await page.waitForTimeout(400); await shot('03-redo');
  log('after redo: save', await saveVisible());
  await page.keyboard.press('ControlOrMeta+z'); await page.waitForTimeout(400);
  log('after ctrl+z: save', await saveVisible());
  await page.keyboard.press('ControlOrMeta+Shift+z'); await page.waitForTimeout(400);
  log('after ctrl+shift+z: save', await saveVisible());
  await shot('04-keyredo');
});
await step('click-highlight', async () => {
  await page.mouse.click(hb.x + 20, hb.y + hb.height / 2); await page.waitForTimeout(600); await shot('05-click-hl');
  log('after click on highlight: dialogs', await page.locator('[role=dialog]:visible').count(), 'menu', await page.getByTestId('more-menu').count(), 'sel', JSON.stringify(await page.evaluate(() => getSelection().toString())));
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
});
await step('note', async () => {
  await selSpan(/^Adding documents$/);
  await page.getByTestId('highlight-note').click();
  await page.getByTestId('note-dialog').waitFor({ timeout: 3000 });
  await shot('06-note-dialog');
  await page.getByTestId('note-input').fill('A walkthrough note');
  await page.getByTestId('note-save').click(); await page.waitForTimeout(500); await shot('07-note-saved');
});
await step('page-note', async () => {
  await tid('page-note').click(); await page.waitForTimeout(600); await shot('08-page-note');
  log('page-note dialog', await page.getByTestId('note-dialog').count());
  if (await page.getByTestId('note-dialog').count()) { await page.getByTestId('note-input').fill('Page level note'); await page.getByTestId('note-save').click(); }
  await page.waitForTimeout(500); await shot('09-page-note-after');
});
await step('leave-discard', async () => {
  await tid('back').click();
  await page.getByTestId('ask-dialog').waitFor({ timeout: 3000 });
  await shot('10-leave-dialog');
  log('leave dialog text', JSON.stringify(await page.getByTestId('ask-dialog').innerText()));
  await page.getByTestId('ask-other').click();
  await page.waitForTimeout(800); await shot('11-after-discard');
  log('after discard reader open', await page.getByTestId('reader').locator('visible=true').count());
});
await step('reopen-check', async () => {
  if (!(await page.getByTestId('reader').locator('visible=true').count())) await docRows(page).first().click();
  await page.getByTestId('reader').waitFor(); await painted(page); await page.waitForTimeout(800);
  await tid('open-find').click(); await page.getByTestId('tab-notes').click(); await page.waitForTimeout(500);
  log('notes after discard', await page.getByTestId('note-row').count());
  await shot('12-notes-after-discard');
  await page.keyboard.press('Escape');
});
await step('save-path', async () => {
  await selSpan(/^Adding documents$/);
  await page.getByTestId('highlight-green').click(); await page.waitForTimeout(400);
  await tid('back').click(); await page.getByTestId('ask-dialog').waitFor({ timeout: 3000 });
  await page.getByTestId('ask-confirm').click(); await page.waitForTimeout(1500); await shot('13-after-save-leave');
  if (!(await page.getByTestId('reader').locator('visible=true').count())) await docRows(page).first().click();
  await page.getByTestId('reader').waitFor(); await painted(page); await page.waitForTimeout(800);
  await tid('open-find').click(); await page.getByTestId('tab-notes').click(); await page.waitForTimeout(500);
  log('notes after save', await page.getByTestId('note-row').count()); await shot('14-notes-after-save');
});
await step('find', async () => {
  await tid('open-find').click().catch(() => {});
  const input = page.getByTestId('find-bar').or(page.locator('input[placeholder*="ind"]')).first();
  await page.locator('[data-testid=find-panel] input, [data-testid=find-bar] input, input[placeholder^="Find"]').first().fill('Tessel');
  await page.keyboard.press('Enter'); await page.waitForTimeout(1200); await shot('15-find');
  log('find panel text', JSON.stringify((await page.getByTestId('find-panel').locator('visible=true').first().innerText().catch(() => '')).slice(0, 300)));
  await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  log('page after 2 enters', await tid('page-label').innerText());
  await page.keyboard.press('Escape');
});
await step('details', async () => {
  const d = page.getByTestId('menu-details').locator('visible=true');
  if (!(await d.count())) await tid('open-more').click();
  await page.getByTestId('menu-details').locator('visible=true').first().click(); await page.waitForTimeout(600); await shot('16-details');
  await page.keyboard.press('Escape');
});
await step('text-view', async () => {
  await tid('view-toggle').click(); await page.getByTestId('text-view').waitFor({ timeout: 15000 }); await page.waitForTimeout(800); await shot('17-textview');
  await tid('view-toggle').click(); await page.waitForTimeout(800);
});
await step('links', async () => {
  await tid('page-label').click(); await page.getByTestId('page-input').fill('3'); await page.getByTestId('page-input').press('Enter'); await page.waitForTimeout(800);
  const l = page.getByTestId('link-page').first(); const b = await l.boundingBox();
  await shot('18-links-page');
  await page.mouse.click(b.x + 3, b.y + b.height / 2); await page.waitForTimeout(800);
  log('after link click page', await tid('page-label').innerText());
  const u = page.getByTestId('link-url').first(); await u.scrollIntoViewIfNeeded();
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 3000 }).catch(() => null), u.click()]);
  await page.waitForTimeout(600); await shot('19-ext-link');
  log('ext link popup', popup ? popup.url() : 'none', 'dialogs', await page.locator('[role=dialog]:visible, [role=alertdialog]:visible').count());
  if (popup) await popup.close();
});
await step('more-menu', async () => { await tid('open-more').click(); await page.waitForTimeout(500); await shot('20-more'); await page.keyboard.press('Escape'); });
await step('appearance', async () => { await tid('open-appearance').click(); await page.waitForTimeout(500); await shot('21-appearance'); await page.keyboard.press('Escape'); });
await browser.close();
