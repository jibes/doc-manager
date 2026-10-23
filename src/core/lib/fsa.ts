/**
 * File System Access API (Chromium): lets the library point at the user's own file instead of a copy.
 * Not in TypeScript's DOM lib yet, hence the minimal types.
 */
export type FileHandle = {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  queryPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<{ write(data: BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
  isSameEntry(other: FileHandle): Promise<boolean>;
};

type Picker = (o: object) => Promise<FileHandle[]>;
const picker = (): Picker | undefined =>
  typeof window !== 'undefined' ? (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker : undefined;

/** Whether files can be opened in place here (otherwise the library keeps a copy). */
export const canOpenInPlace = () => !!picker();

export const isFileHandle = (v: unknown): v is FileHandle =>
  typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'file' && typeof (v as FileHandle).getFile === 'function';

const TYPES = { description: 'PDF', accept: { 'application/pdf': ['.pdf'] } };

/** Picks documents as handles; [] when cancelled. */
export async function pickHandles(multiple = true): Promise<FileHandle[]> {
  try {
    return await picker()!({ multiple, types: [TYPES], excludeAcceptAllOption: false, id: 'tessel-open' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return [];
    throw e;
  }
}

/** Whether a handle may be read (or written) now. The browser's own file system (Firefox, Safari) has no permissions to ask. */
export async function isGranted(h: FileHandle | DirHandle, write = false): Promise<boolean> {
  if (typeof h.queryPermission !== 'function') return true;
  return (await h.queryPermission({ mode: write ? 'readwrite' : 'read' }).catch(() => 'denied')) === 'granted';
}

/** Permission to read (or write) a linked file; asks only if not yet granted. Prompts need a user gesture. */
export async function ensurePermission(h: FileHandle, write = false): Promise<boolean> {
  if (await isGranted(h, write)) return true;
  return (await h.requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted';
}

/** The browser's own file system: Tessel's folder in it (where no other is chosen). */
export async function ownFolder(): Promise<DirHandle> {
  const root = (await navigator.storage.getDirectory()) as unknown as DirHandle;
  return root.getDirectoryHandle('Tessel', { create: true });
}

// Safari writes files of the browser's own file system only from a worker (no createWritable in the page).
const WRITER = `onmessage = async ({ data: { path, data } }) => {
  try {
    let dir = await navigator.storage.getDirectory();
    for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const name = path[path.length - 1];
    const bytes = new Uint8Array(await data.arrayBuffer());
    const put = async (h) => {
      const file = await h.createSyncAccessHandle();
      file.truncate(0);
      file.write(bytes, { at: 0 });
      file.flush();
      file.close();
    };
    // Whole or not at all: written beside it first, then moved over it (a tab closed midway leaves the old file).
    const tmp = await dir.getFileHandle(name + '.tessel-writing', { create: true });
    await put(tmp);
    let moved = false;
    if (typeof tmp.move === 'function') {
      try {
        await tmp.move(name);
        moved = true;
      } catch {}
    }
    if (!moved) {
      await put(await dir.getFileHandle(name, { create: true }));
      await dir.removeEntry(name + '.tessel-writing').catch(() => {});
    }
    postMessage({ ok: true });
  } catch (e) {
    postMessage({ ok: false, error: String(e) });
  }
};`;

/** Replaces a file's contents: in place, or (the browser's own files, without createWritable) through a worker. */
export async function writeFile(h: FileHandle, data: Blob | BufferSource): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  if (typeof h.createWritable === 'function') {
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const root = (await navigator.storage.getDirectory()) as unknown as DirHandle;
  const path = await root.resolve(h);
  if (!path) throw new Error('This file can’t be written here.');
  const url = URL.createObjectURL(new Blob([WRITER], { type: 'text/javascript' }));
  const worker = new Worker(url);
  try {
    const done = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => resolve({ ok: false, error: e.message });
      worker.postMessage({ path, data: blob });
    });
    if (!done.ok) throw new Error(done.error);
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

/** A folder the user picked (Chromium). */
export type DirHandle = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FileHandle | DirHandle]>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
  queryPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  /** The names leading from this folder down to `other`, or null when it isn't inside. */
  resolve(other: FileHandle | DirHandle): Promise<string[] | null>;
};

type DirPicker = (o: object) => Promise<DirHandle>;
const dirPicker = (): DirPicker | undefined =>
  typeof window !== 'undefined' ? (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker : undefined;

/** Whether folders can be browsed here (desktop Chromium). */
export const canPickFolders = () => !!dirPicker();

/** Picks a folder; null when cancelled. */
export async function pickDirectory(): Promise<DirHandle | null> {
  try {
    return await dirPicker()!({ id: 'tessel-folder', mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}
