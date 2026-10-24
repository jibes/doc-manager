import { browser, ctxFor, watch, vis, docRows, openFile, chooseTessel, BASE } from './lib.mjs';
const withTessel = process.argv[2] === 't';
const size = process.argv[3] ?? 'desktop';
const ctx = await ctxFor({ size });
const page = await ctx.newPage();
const shot = watch(page, `lag-${size}-${withTessel ? 't' : 'n'}`);
await page.goto(BASE);
await vis(page, 'add-menu').waitFor();
if (withTessel) { await chooseTessel(page); await page.goBack(); await page.waitForTimeout(500); }
const names = () => docRows(page).evaluateAll((els) => els.map((e) => e.innerText.split('\n')[0]));
for (const f of ['columns.pdf', 'form.pdf', 'mixed.pdf']) {
  const t0 = Date.now();
  await openFile(page, f);
  for (let i = 0; i < 12; i++) { console.log(f, Date.now() - t0, JSON.stringify(await names())); await page.waitForTimeout(700); }
  await vis(page, 'back').click(); await page.waitForTimeout(300); console.log('after back', JSON.stringify(await names()));
}
await shot('end');
await browser.close();
