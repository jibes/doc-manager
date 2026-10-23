// What the desktop app adds to the page, as window.TesselDesktop (see src/core/lib/desktop.ts).
const { contextBridge, ipcRenderer } = require('electron');

let next = 0;

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
});
