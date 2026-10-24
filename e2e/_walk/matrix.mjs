import { browser, ctxFor, watch, vis, docRows, openFile, chooseTessel, painted, more, BASE } from './lib.mjs';
const only = process.argv[2];
for (const size of ['phone', 'tablet', 'desktop'])
  for (const scheme of ['light', 'dark'])
    for (const locale of ['en-US', 'de-DE']) {
      const name = `m-${size}-${scheme}-${locale.slice(0, 2)}`;
      if (only && !name.includes(only)) continue;
      const ctx = await ctxFor({ size, scheme, locale });
      const page = await ctx.newPage();
      const shot = watch(page, name);
      try {
        await page.goto(BASE);
        await vis(page, 'add-menu').waitFor({ timeout: 15000 });
        await page.waitForTimeout(800);
        await shot('01-first');
        const t = await chooseTessel(page);
        console.log(name, 'tessel', JSON.stringify(t));
        await shot('02-settings');
        await page.goBack();
        await vis(page, 'docs-search').waitFor({ timeout: 5000 }).catch(() => console.log(name, 'no docs-search after back'));
        await shot('03-after-tessel');
        await openFile(page, 'columns.pdf');
        await painted(page);
        await page.waitForTimeout(600);
        await shot('04-reader-columns');
        await vis(page, 'back').click();
        await page.waitForTimeout(500);
        await openFile(page, 'form.pdf');
        await page.waitForTimeout(800);
        await shot('05-reader-form');
        await vis(page, 'back').click();
        await openFile(page, 'mixed.pdf');
        await vis(page, 'back').click();
        await page.waitForTimeout(800);
        console.log(name, 'rows', await docRows(page).count());
        await shot('06-docs');
        await vis(page, 'add-menu').click(); await page.waitForTimeout(400); await shot('07-addmenu'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        await vis(page, 'docs-sort').click().catch(() => console.log(name, 'no sort')); await page.waitForTimeout(400); await shot('08-sort'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        await vis(page, 'docs-filter').click().catch(() => console.log(name, 'no filter')); await page.waitForTimeout(400); await shot('09-filter'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
        await vis(page, 'docs-more').click().catch(() => console.log(name, 'no docs-more')); await page.waitForTimeout(400); await shot('10-more'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      } catch (e) { console.log(name, 'ERR', e.message.slice(0, 300)); await shot('zz-err'); }
      await ctx.close();
    }
await browser.close();
