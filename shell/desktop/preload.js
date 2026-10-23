// What the desktop app adds to the page, as window.TesselDesktop (see src/core/lib/desktop.ts).
const { contextBridge, ipcRenderer } = require('electron');

let next = 0;

const listen = (channel, cb) => {
  const on = (_e, value) => cb(value);
  ipcRenderer.on(channel, on);
  return () => void ipcRenderer.removeListener(channel, on);
};

contextBridge.exposeInMainWorld('TesselDesktop', {
  /** A request made by the app: { url, method, headers, body } → { status, body }. Stopped with the signal's abort. */
  http: (request, onAbort) => {
    const id = ++next;
    onAbort?.(() => ipcRenderer.send('http-abort', id));
    return ipcRenderer.invoke('http', { ...request, id });
  },
  /** PDFs opened with Tessel (Finder's "Open with", the Dock icon, a double click): { name, bytes }[]. */
  onOpen: (cb) => {
    ipcRenderer.on('open', (_e, files) => cb(files));
    ipcRenderer.send('ready-for-files');
  },
  /** A command chosen in the menu bar ('undo', 'find', 'scan', …). Returns what stops listening. */
  onMenu: (cb) => listen('menu', cb),
  /** A newer version is out ({ version, url }), or (asked for) none newer { version: null } or the check failed
   *  { version: null, failed: true }. Returns what stops listening. */
  onUpdate: (cb) => listen('update', cb),
});
