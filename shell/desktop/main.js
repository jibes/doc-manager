// Tessel on macOS, Windows and Linux: the web app (www/, the same build as the website) in its own window.
// Chromium does folders, storage and the PDF engine as in the browser; this file adds what a browser tab can't:
// AI requests without the browser's cross-origin rules, "Open with" for PDFs, and access to the chosen folder
// that survives a restart.
const { app, BrowserWindow, ipcMain, net, protocol, screen, session, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://tessel`;
const WWW = path.join(__dirname, 'www');

// A secure, standard origin of its own: IndexedDB, the browser's own file system, module workers and WebAssembly
// behave as on the website.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// One window: a second launch (or "Open with" on Windows and Linux) hands its files to the running one.
if (!app.requestSingleInstanceLock()) app.quit();

/** PDFs to open, until the page says it is ready for them. */
let waiting = [];
let ready = false;
let win = null;

const pdfsIn = (args) => args.filter((a) => /\.pdf$/i.test(a) && fs.existsSync(a));

function open(paths) {
  const files = paths.map((p) => ({ name: path.basename(p), bytes: fs.readFileSync(p) }));
  if (!files.length) return;
  if (ready && win) {
    win.webContents.send('open', files);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else waiting.push(...files);
}

// macOS: Finder's "Open with", a PDF dropped on the Dock icon (may come before the app is ready).
app.on('open-file', (e, file) => {
  e.preventDefault();
  open([file]);
});
app.on('second-instance', (_e, argv) => {
  open(pdfsIn(argv.slice(1)));
  if (win) win.focus();
});

/** The app's files; paths without an extension are app routes and get index.html (the router takes them). */
async function serve(request) {
  const url = new URL(request.url);
  const clean = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const last = clean.split('/').pop() ?? '';
  const file = path.normalize(path.join(WWW, !clean || !last.includes('.') ? 'index.html' : clean));
  if (!file.startsWith(WWW)) return new Response('Not found', { status: 404 });
  const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
  if (!res || !res.ok) return new Response('Not found', { status: 404 });
  const headers = new Headers(res.headers);
  // Cross-origin isolation: the scanner's text recognition may use several threads (everything comes from here).
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cache-Control', 'no-cache');
  return new Response(res.body, { status: res.status, headers });
}

const ours = (origin) => typeof origin === 'string' && origin.startsWith(ORIGIN);

function createWindow() {
  // Room for the pages with Find and Details beside them, where the screen has it.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 380,
    minHeight: 520,
    backgroundColor: '#ECE8DF',
    title: 'Tessel',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  // The page skips its service worker in the app (the files are on the disk already).
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} TesselDesktop`);
  // Links to other sites open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  void win.loadURL(`${ORIGIN}/`);
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  const s = session.defaultSession;
  // The folder chosen in Settings (and files opened from it) stay accessible after a restart, as in the Android
  // app: the app's own pages are trusted with what the user picked. The camera, for the scanner. Nothing else.
  s.setPermissionCheckHandler((_wc, permission, origin) => ours(origin) && (permission === 'fileSystem' || permission === 'media'));
  s.setPermissionRequestHandler((wc, permission, done) => {
    const allowed = ours(wc.getURL()) && (permission === 'fileSystem' || permission === 'media');
    if (allowed && permission === 'media' && process.platform === 'darwin') {
      void systemPreferences.askForMediaAccess('camera').then(done, () => done(false));
      return;
    }
    done(allowed);
  });
  open(pdfsIn(process.argv.slice(1)));
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// The page is listening: what came before it was, now.
ipcMain.on('ready-for-files', (e) => {
  ready = true;
  if (waiting.length) e.sender.send('open', waiting);
  waiting = [];
});

/** AI requests, made by the app (a model's address doesn't allow the app's own origin, as it wouldn't a page's). */
const running = new Map();
ipcMain.handle('http', async (e, { id, url, method, headers, body }) => {
  if (!ours(e.senderFrame?.url) || !/^https?:\/\//i.test(url)) throw new Error('Not allowed');
  const stop = new AbortController();
  running.set(id, stop);
  try {
    const res = await net.fetch(url, { method, headers, body, signal: stop.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    running.delete(id);
  }
});
ipcMain.on('http-abort', (_e, id) => running.get(id)?.abort());
