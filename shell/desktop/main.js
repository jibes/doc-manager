// Tessel on macOS, Windows and Linux: the web app (www/, the same build as the website) in its own window.
// Chromium does folders, storage and the PDF engine as in the browser; this file adds what a browser tab can't:
// AI requests without the browser's cross-origin rules, "Open with" for PDFs, and access to the chosen folder
// that survives a restart.
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, net, protocol, screen, session, shell, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://tessel`;
const WWW = path.join(__dirname, 'www');

// A secure, standard origin of its own: IndexedDB, the browser's own file system, module workers and WebAssembly
// behave as on the website.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

/** Where new releases are published (the update check reads the latest one). */
const RELEASES = 'https://api.github.com/repos/jibes/doc-manager/releases/latest';

// One app: a second launch (or "Open with" on Windows and Linux) hands its files to the running one.
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

// ---------- the main window's place on the screen, kept across starts ----------

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // Only where a screen still is (a display unplugged since).
    const on = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
    return on ? b : null;
  } catch {
    return null;
  }
}

function keepBounds(w) {
  const save = () => {
    if (w.isDestroyed() || w.isMinimized()) return;
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...w.getNormalBounds(), maximized: w.isMaximized() }));
    } catch {
      // Not kept: the next start opens at the usual size.
    }
  };
  w.on('close', save);
  w.on('resize', debounce(save, 500));
  w.on('move', debounce(save, 500));
}

function debounce(fn, ms) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

const background = () => (nativeTheme.shouldUseDarkColors ? '#1B1A17' : '#ECE8DF');

const webPreferences = () => ({ preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true });

/** What every window of the app does: its own user agent (no service worker), links outside it in the browser. */
function dress(w) {
  w.webContents.setUserAgent(`${w.webContents.getUserAgent()} TesselDesktop`);
  // The app's own pages (a document in a window of its own) open in a window of the app; other sites in the browser.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(ORIGIN)) {
      const at = w.getBounds();
      return { action: 'allow', overrideBrowserWindowOptions: { x: at.x + 32, y: at.y + 32, width: Math.max(900, Math.round(at.width * 0.8)), height: at.height, backgroundColor: background(), title: 'Tessel', webPreferences: webPreferences() } };
    }
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('did-create-window', (child) => dress(child));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
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
  // Where it was last time; else room for the list, a document and its details, where the screen has it.
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const saved = savedBounds();
  win = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: Math.min(1440, width), height: Math.min(900, height) }),
    minWidth: 380,
    minHeight: 520,
    backgroundColor: background(),
    title: 'Tessel',
    webPreferences: webPreferences(),
  });
  if (saved?.maximized) win.maximize();
  keepBounds(win);
  dress(win);
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  void win.loadURL(`${ORIGIN}/`);
}

// ---------- the menu bar ----------

/** A command for the window in front: the page does it as its own key would (the key itself reaches the page too). */
const command = (name) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', name);
/** Shown with its key, which the page handles itself (the menu doesn't take the key from it). */
const item = (label, accelerator, name) => ({ label, accelerator, registerAccelerator: false, click: command(name) });

function menu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        item('Scan…', 'CmdOrCtrl+N', 'scan'),
        item('Open File…', 'CmdOrCtrl+O', 'open'),
        { type: 'separator' },
        item('Save', 'CmdOrCtrl+S', 'save'),
        item('Print…', 'CmdOrCtrl+P', 'print'),
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'CmdOrCtrl+Z', 'undo'),
        item('Redo', 'Shift+CmdOrCtrl+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find', 'CmdOrCtrl+F', 'find'),
        item('Go to…', 'CmdOrCtrl+K', 'goto'),
      ],
    },
    {
      label: 'View',
      submenu: [item('Zoom In', 'CmdOrCtrl+Plus', 'zoomIn'), item('Zoom Out', 'CmdOrCtrl+-', 'zoomOut'), item('Actual Size', 'CmdOrCtrl+0', 'zoomReset'), { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => void checkUpdate(true) },
        { label: 'Tessel on GitHub', click: () => void shell.openExternal('https://github.com/jibes/doc-manager') },
      ],
    },
  ]);
}

// ---------- updates (the app isn't signed: it can't replace itself, it says where the new one is) ----------

const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkUpdate(asked) {
  const latest = await net
    .fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const version = latest?.tag_name?.replace(/^v/, '');
  const target = win ?? BrowserWindow.getAllWindows()[0];
  if (!target) return;
  if (version && newer(version, app.getVersion())) target.webContents.send('update', { version, url: latest.html_url });
  else if (asked) target.webContents.send('update', { version: null, url: null });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(menu());
  nativeTheme.on('updated', () => BrowserWindow.getAllWindows().forEach((w) => w.setBackgroundColor(background())));
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
  // Another window of the app (a document of its own) takes no files: the first one does.
  if (!win || e.sender !== win.webContents) return;
  const first = !ready;
  ready = true;
  if (waiting.length) e.sender.send('open', waiting);
  waiting = [];
  // Once a start, a while after it: a newer version is said (not on every window, not while starting).
  if (first && app.isPackaged) setTimeout(() => void checkUpdate(false), 8000);
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
