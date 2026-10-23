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
  } else {
    waiting.push(...files);
    // macOS keeps running with no window open: a file opened then gets one (which takes it once it's ready).
    if (!win && app.isReady()) createWindow();
  }
}

// ---------- the main window's place on the screen, kept across starts ----------

const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isInteger)) return null;
    // Only where a screen still is (a display unplugged since).
    const on = screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
    if (!on) return null;
    // All of it on that screen, as the screen is now (a lower resolution, the Dock or taskbar moved).
    const { workArea: a } = screen.getDisplayMatching(b);
    const width = Math.min(b.width, a.width);
    const height = Math.min(b.height, a.height);
    const x = Math.min(Math.max(b.x, a.x), a.x + a.width - width);
    const y = Math.min(Math.max(b.y, a.y), a.y + a.height - height);
    return { ...b, x, y, width, height };
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

// The canvas colours of src/core/design/tokens.ts (dark, light): no flash of another colour while the page loads.
const background = () => (nativeTheme.shouldUseDarkColors ? '#18191C' : '#ECE8DF');

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
  // Launched again: the window comes back (from the taskbar or the Dock too), or there is one again.
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (app.isReady()) createWindow();
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

/** The menu's own words in the app's languages (the page's are in src/core/i18n; the roles' come with Electron). */
const LABELS = {
  en: { file: 'File', scan: 'Scan…', open: 'Open File…', save: 'Save', print: 'Print…', edit: 'Edit', undo: 'Undo', redo: 'Redo', find: 'Find', goto: 'Go to…', view: 'View', zoomIn: 'Zoom In', zoomOut: 'Zoom Out', zoomReset: 'Actual Size', update: 'Check for Updates…', github: 'Tessel on GitHub' },
  de: { file: 'Datei', scan: 'Scannen…', open: 'Datei öffnen…', save: 'Speichern', print: 'Drucken…', edit: 'Bearbeiten', undo: 'Rückgängig', redo: 'Wiederholen', find: 'Suchen', goto: 'Gehe zu…', view: 'Ansicht', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', zoomReset: 'Originalgröße', update: 'Nach Updates suchen…', github: 'Tessel auf GitHub' },
};

function menu() {
  const mac = process.platform === 'darwin';
  const l = app.getLocale().toLowerCase().startsWith('de') ? LABELS.de : LABELS.en;
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: l.file,
      submenu: [
        item(l.scan, 'CmdOrCtrl+N', 'scan'),
        item(l.open, 'CmdOrCtrl+O', 'open'),
        { type: 'separator' },
        item(l.save, 'CmdOrCtrl+S', 'save'),
        item(l.print, 'CmdOrCtrl+P', 'print'),
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: l.edit,
      submenu: [
        item(l.undo, 'CmdOrCtrl+Z', 'undo'),
        item(l.redo, 'Shift+CmdOrCtrl+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item(l.find, 'CmdOrCtrl+F', 'find'),
        item(l.goto, 'CmdOrCtrl+K', 'goto'),
      ],
    },
    {
      label: l.view,
      submenu: [item(l.zoomIn, 'CmdOrCtrl+Plus', 'zoomIn'), item(l.zoomOut, 'CmdOrCtrl+-', 'zoomOut'), item(l.zoomReset, 'CmdOrCtrl+0', 'zoomReset'), { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: l.update, click: () => void checkUpdate(true) },
        { label: l.github, click: () => void shell.openExternal('https://github.com/jibes/doc-manager') },
      ],
    },
  ]);
}

// ---------- updates (the app isn't signed: it can't replace itself, it says where the new one is) ----------

/** Whether version a is newer than b: by 1.2.3 first; with those equal, a release is newer than its pre-releases. */
const newer = (a, b) => {
  const parse = (v) => {
    const at = v.indexOf('-');
    return { n: (at < 0 ? v : v.slice(0, at)).split('.').map((s) => parseInt(s, 10) || 0), pre: at < 0 ? '' : v.slice(at + 1) };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (!x.pre || !y.pre) return !x.pre && !!y.pre;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
};

async function checkUpdate(asked) {
  const latest = await net
    .fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const version = latest?.tag_name?.replace(/^v/, '');
  const target = win ?? BrowserWindow.getAllWindows()[0];
  if (!target) return;
  // No answer (offline, rate-limited): said only when asked for, and not as "up to date".
  if (!version) {
    if (asked) target.webContents.send('update', { version: null, url: null, failed: true });
    return;
  }
  // Only a version there is a build of for this computer: releases have the macOS one alone.
  const built = process.platform === 'darwin' && (latest.assets ?? []).some((f) => /-mac\.dmg$/i.test(f?.name ?? ''));
  if (built && newer(version, app.getVersion())) target.webContents.send('update', { version, url: latest.html_url });
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
  if (!win) createWindow();
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
// Each window counts its requests from 1: they are told apart by the window too.
const running = new Map();
ipcMain.handle('http', async (e, { id, url, method, headers, body }) => {
  if (!ours(e.senderFrame?.url) || !/^https?:\/\//i.test(url)) throw new Error('Not allowed');
  const key = `${e.sender.id}:${id}`;
  const stop = new AbortController();
  running.set(key, stop);
  try {
    const res = await net.fetch(url, { method, headers, body, signal: stop.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    running.delete(key);
  }
});
ipcMain.on('http-abort', (e, id) => running.get(`${e.sender.id}:${id}`)?.abort());
