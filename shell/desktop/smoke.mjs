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

const app = await electron.launch({ executablePath: electronPath, args: [here, '--no-sandbox', fixture], cwd: here, env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' } });
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
  check(!errors.length, `no page errors (${errors.join('; ')})`);
} finally {
  await app.close();
  ai.close();
}
console.log(failed ? `${failed} check(s) failed` : 'desktop smoke passed');
process.exit(failed ? 1 : 0);
