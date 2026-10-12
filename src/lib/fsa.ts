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
};

type Picker = (o: object) => Promise<FileHandle[]>;
const picker = (): Picker | undefined =>
  typeof window !== 'undefined' ? (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker : undefined;

/** Whether files can be opened in place here (otherwise the library keeps a copy). */
export const canOpenInPlace = () => !!picker();

export const isFileHandle = (v: unknown): v is FileHandle =>
  typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'file' && typeof (v as FileHandle).getFile === 'function';

const TYPES = { description: 'PDF, EPUB', accept: { 'application/pdf': ['.pdf'], 'application/epub+zip': ['.epub'] } };

/** Picks documents as handles; [] when cancelled. */
export async function pickHandles(multiple = true): Promise<FileHandle[]> {
  try {
    return await picker()!({ multiple, types: [TYPES], excludeAcceptAllOption: false, id: 'tessel-open' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return [];
    throw e;
  }
}

/** Permission to read (or write) a linked file; asks only if not yet granted. Prompts need a user gesture. */
export async function ensurePermission(h: FileHandle, write = false): Promise<boolean> {
  const mode = write ? 'readwrite' : 'read';
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  return (await h.requestPermission({ mode })) === 'granted';
}

/** A folder the user picked (Chromium). */
export type DirHandle = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FileHandle | DirHandle]>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  queryPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
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
