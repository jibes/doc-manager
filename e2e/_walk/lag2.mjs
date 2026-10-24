import { browser, ctxFor, watch, vis, docRows, openFile, chooseTessel, painted, BASE } from './lib.mjs';
for (let run = 0; run < 3; run++) {
const ctx = await ctxFor({ size: process.argv[2] ?? 'desktop' });
const page = await ctx.newPage();
const shot = watch(page, 'lag2-' + run);
await page.goto(BASE);
await vis(page, 'add-menu').waitFor();
await page.waitForTimeout(800);
await chooseTessel(page); await page.goBack(); await vis(page, 'docs-search').waitFor();
const names = () => docRows(page).evaluateAll((els) => els.map((e) => e.innerText.split('\n')[0]));
await openFile(page, 'columns.pdf'); await painted(page); await page.waitForTimeout(600);
await vis(page, 'back').click(); await page.waitForTimeout(500);
const t0 = Date.now();
await openFile(page, 'form.pdf');
const seen = [];
for (let i = 0; i < 40; i++) { const n = JSON.stringify(await names()); if (seen.at(-1)?.[1] !== n) seen.push([Date.now() - t0, n]); await page.waitForTimeout(150); }
console.log(run, JSON.stringify(seen));
await ctx.close();
}
await browser.close();
