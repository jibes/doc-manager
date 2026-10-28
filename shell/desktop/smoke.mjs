// The desktop app, started for real (Electron, under a virtual display on Linux CI): it opens on Documents from its
// own origin, is cross-origin isolated (the scanner's threads), skips the service worker, makes AI requests itself
// (no CORS), and opens a PDF handed to it on the command line. Run: npm run smoke (after npm run build:desktop-web).
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = fileURLToPath(new URL('../../e2e/fixtures/columns.pdf', import.meta.url));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed++;
};

// A model's address that, like most, says nothing about cross-origin requests.
let asked = null;
const ai = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    asked = { method: req.method, url: req.url, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"title":"T","date":"","sender":"","type":"","keywords":[]}' } }] }));
  });
});
await new Promise((r) => ai.listen(0, '127.0.0.1', r));
const port = ai.address().port;

// A launch on CI now and then never gets its debugger connected (the app itself isn't reached): tried once more.
const launch = () => electron.launch({ timeout: 90000, executablePath: electronPath, args: [here, '--no-sandbox', fixture], cwd: here, env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' } });
const app = await launch().catch((e) => {
  console.log(`launch failed, once more: ${String(e?.message ?? e).split('\n')[0]}`);
  return launch();
});
const errors = [];
const page = await app.firstWindow();
page.on('pageerror', (e) => errors.push(e.message));
try {
  // The PDF on the command line ("Open with" on Windows and Linux; macOS hands it over the same way) is opened.
  const opened = await page.getByTestId('reader').waitFor({ timeout: 60000 }).then(() => true, () => false);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  check(opened, 'a PDF opened with Tessel is shown');
  check(page.url().startsWith('app://tessel/'), `opens from its own origin (${page.url()})`);
  check(await page.evaluate(() => crossOriginIsolated), 'cross-origin isolated (the scanner may use several threads)');
  check(!(await page.evaluate(() => navigator.serviceWorker.controller)), 'no service worker');
  // AI requests go through the app, so an address without CORS headers still answers.
  const reply = await page.evaluate(
    (url) => window.TesselDesktop.http({ url, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"q":1}' }),
    `http://127.0.0.1:${port}/v1/chat/completions`,
  );
  check(reply.status === 200 && asked?.body === '{"q":1}', `AI requests are made by the app (${reply.status}, ${asked?.url})`);
  // Folders: Chromium's own picker is there (the Tessel folder can be chosen as on the website).
  check(await page.evaluate(() => typeof window.showDirectoryPicker === 'function'), 'folders can be chosen');
  // The menu bar: the app's commands, each reaching the page as its key does (⌘F opens Find).
  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);
  // In the system's language (English or German).
  check([['File', 'Edit', 'View'], ['Datei', 'Bearbeiten', 'Ansicht']].some((ls) => ls.every((l) => labels.includes(l))), `a menu bar (${labels.join(', ')})`);
  await page.getByTestId('find-panel').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  const findBefore = await page.getByTestId('find-panel').count();
  if (findBefore) await page.getByTestId('open-find').click();
  // Sent again while the page may still be settling (a slow machine): the first that lands opens Find.
  let found = false;
  for (let i = 0; i < 5 && !found; i++) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu', 'find'));
    found = await page.getByTestId('find-panel').waitFor({ timeout: 3000 }).then(() => true, () => false);
  }
  const state = found ? '' : await page.evaluate(() => `${location.pathname}, ${innerWidth}px, active ${document.activeElement?.tagName}`);
  check(found, `a menu command does what its key does (Find) ${state}`);
  // Print (⌘P): the pages, drawn by the app, go to the system's print dialog from a window of their own
  // (Electron prints no PDF in a frame). The dialog is stood in for: what it was handed is kept.
  await app.evaluate(({ BrowserWindow }) => {
    const proto = Object.getPrototypeOf(BrowserWindow.getAllWindows()[0].webContents);
    globalThis.printed = null;
    proto.print = function (options, done) {
      this.capturePage().then((img) => {
        globalThis.printed = { url: this.getURL(), size: img.getSize() };
        done(true, '');
      });
    };
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p');
  let printed = null;
  for (let i = 0; i < 40 && !printed; i++) {
    await new Promise((r) => setTimeout(r, 250));
    printed = await app.evaluate(() => globalThis.printed);
  }
  check(!!printed && /print\.html$/.test(printed.url), `print hands the pages to the print dialog (${printed?.url ?? 'nothing printed'})`);
  // A document in a window of its own: the app's own page, in a window of the app.
  const [second] = await Promise.all([app.waitForEvent('window', { timeout: 15000 }), page.evaluate(() => window.open('/', '_blank'))]);
  check(!!second && second.url().startsWith('app://tessel/'), `opens a second window of the app (${second?.url()})`);
  check(!errors.length, `no page errors (${errors.join('; ')})`);
} finally {
  await app.close();
  ai.close();
}
console.log(failed ? `${failed} check(s) failed` : 'desktop smoke passed');
process.exit(failed ? 1 : 0);
