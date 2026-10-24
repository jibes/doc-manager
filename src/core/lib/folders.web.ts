import { createStore, del, entries, set } from 'idb-keyval';
import { traced } from './log';

import { t } from '@/core/i18n';
import { PartlyDone, type FolderEntry, type FolderRoot, type FoldersApi } from './folderTypes';
import { canPickFolders, isGranted, ownFolder, pickDirectory, writeFile, type DirHandle, type FileHandle } from './fsa';
import { APP_ROOT_ID, handleNestings, shellNestings } from './nesting';
import { shell, shellDocUrl, shellRequest, stageForShell } from './shell';

export type { FolderEntry, FolderRoot, Place } from './folderTypes';

const kindOf = (name: string): FolderEntry['kind'] | null => (/\.pdf$/i.test(name) ? 'pdf' : null);

const shellAccess = () => shellRequest<{ allFiles: boolean; app?: boolean }>('access').then((a) => ({ allFiles: a.allFiles, app: a.app ?? false }));
const APP_ROOT: FolderRoot = { id: APP_ROOT_ID, name: 'Tessel', kind: 'app' };

/**
 * Android app: folders granted through the system folder picker, listed, served and changed by the app (see
 * shell/android Folders.kt).
 */
const shellFolders: FoldersApi = {
  supported: true,
  canAdd: true,
  allFilesSupported: true,
  async roots() {
    const [picked, access] = await Promise.all([shellRequest<{ uri: string; name: string }[]>('folders'), shellAccess()]);
    // The sources added (no whole device: Tessel reads what it is given).
    const roots: FolderRoot[] = picked.map((f) => ({ id: f.uri, name: f.name, kind: 'folder' }));
    // Android 8–10 need the storage permission for it: shown locked until then.
    roots.unshift({ ...APP_ROOT, locked: !access.app });
    return roots;
  },
  appFolder: async () => ((await shellAccess()).app ? APP_ROOT : null),
  async add() {
    const f = await shellRequest<{ uri: string; name: string } | null>('pickFolder');
    return f && { id: f.uri, name: f.name, kind: 'folder' };
  },
  forget: (id) => shellRequest('forgetFolder', { uri: id }),
  nestings: async (roots) => shellNestings(roots),
  unlock: async (id) => (id === APP_ROOT_ID ? shellRequest<boolean>('requestAllFiles').then(async () => (await shellAccess()).app) : true),
  list: (root, dir) => shellRequest<FolderEntry[]>('list', { root, dir: dir ?? '' }),
  async read(_root, e) {
    const res = await fetch(shellDocUrl(e.uri!));
    if (!res.ok) throw new Error(t.fileGone);
    return res.blob();
  },
  canEdit: (root, entry) => root !== 'all' || !!entry?.uri?.startsWith('file:'),
  canShare: true,
  mkdir: (root, dir, name) => shellRequest('mkdir', { root, dir: dir ?? '', name }),
  async create(at, name, data) {
    const token = await stageForShell(data, name, data.type || 'application/octet-stream');
    const made = await shellRequest<{ uri: string; name: string }>('create', { root: at.root, dir: at.dir ?? '', name, mime: data.type || 'application/octet-stream', token });
    return { id: made.uri, uri: made.uri, name: made.name, kind: kindOf(made.name) ?? 'pdf', size: data.size, modified: Date.now() };
  },
  rename: (_root, _dir, e, name) => shellRequest<string>('rename', { uri: e.uri, name }),
  async delete(_root, _dir, list) {
    const failed = (await shellRequest<{ uri: string; error: string }[] | null>('delete', { uris: list.map((e) => e.uri) })) ?? [];
    if (failed.length) throw new PartlyDone(failed[0].error, list.map((e) => e.uri!).filter((u) => !failed.some((f) => f.uri === u)));
  },
  async transfer(from, list, to, move) {
    const out = await shellRequest<{ from: string; to?: string; error?: string }[]>('transfer', {
      items: list.map((e) => ({ uri: e.uri, name: e.name, dir: e.kind === 'dir' })),
      srcRoot: from.root,
      srcDir: from.dir ?? '',
      root: to.root,
      dir: to.dir ?? '',
      move,
    });
    const done = out.filter((x): x is { from: string; to: string } => !!x.to);
    const failed = out.find((x) => x.error);
    if (failed) throw new PartlyDone(failed.error!, done);
    return done;
  },
  share: (_root, list) => shellRequest('share', { uris: list.map((e) => e.uri) }),
  dirAt: async (root, path, create) => (path.length ? shellRequest<string | null>('dirAt', { root, path, create }) : undefined),
  listNames: (root, path) => shellRequest<string[]>('names', { root, path }),
  readText: (root, path) => shellRequest<string | null>('readText', { root, path }),
  writeText: (root, path, text) => shellRequest('writeText', { root, path, text }),
  allFiles: async () => (await shellAccess()).allFiles,
  requestAllFiles: () => shellRequest<boolean>('requestAllFiles'),
};

const store = createStore('tessel-folders', 'folders');
type Saved = { name: string; handle: DirHandle };

async function savedFolders(): Promise<[string, Saved][]> {
  return (await entries<string, Saved>(store)).sort((a, b) => a[1].name.localeCompare(b[1].name));
}

async function folderHandle(root: string): Promise<DirHandle> {
  if (root === APP_ROOT_ID) return ownFolder();
  const saved = (await savedFolders()).find(([id]) => id === root)?.[1];
  if (!saved) throw new Error(t.fileGone);
  return saved.handle;
}

/** Walks from the picked folder down a "a/b/c" path. */
async function dirAt(root: string, path?: string): Promise<DirHandle> {
  let dir = await folderHandle(root);
  for (const part of (path ?? '').split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
  return dir;
}

/** Changing a folder needs the browser's OK to write (asked once; needs the user's tap). */
async function writable(root: string, path?: string): Promise<DirHandle> {
  const top = await folderHandle(root);
  if (!(await isGranted(top, true)) && (await top.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error(t.writeDenied);
  }
  return dirAt(root, path);
}

/**
 * The names in a folder (any kind), for comparing. Listed rather than asked one by one: Chromium's own file system
 * answers a lookup of a name with letters beyond ASCII as an existing folder, whether there is one or not.
 */
async function namesIn(dir: DirHandle): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const [n] of dir.entries()) out.add(n.normalize('NFC').toLocaleLowerCase());
  return out;
}

const exists = async (dir: DirHandle, name: string) => (await namesIn(dir)).has(name.normalize('NFC').toLocaleLowerCase());

/** "name", or "name (2)", "name (3)"… if taken (ignoring case, as most file systems do). */
async function freeName(dir: DirHandle, name: string, isDir: boolean): Promise<string> {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const taken = await namesIn(dir);
  let candidate = name;
  for (let n = 2; taken.has(candidate.normalize('NFC').toLocaleLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

async function copyEntry(from: DirHandle, name: string, isDir: boolean, into: DirHandle, as = name): Promise<void> {
  if (!isDir) {
    const file = await (await from.getFileHandle(name)).getFile();
    await writeFile(await into.getFileHandle(as, { create: true }), file);
    return;
  }
  const src = await from.getDirectoryHandle(name);
  const dest = await into.getDirectoryHandle(as, { create: true });
  for await (const [child, h] of src.entries()) await copyEntry(src, child, h.kind === 'directory', dest);
}

/**
 * Moves (or renames) an entry in place, no bytes copied: Chromium (its own file system and picked folders) and
 * Safari (its own) can. False where the browser can't (older ones, folders, across file systems): then copy.
 */
async function moveEntry(from: DirHandle, name: string, isDir: boolean, as: string, into?: DirHandle): Promise<boolean> {
  const h = isDir ? await from.getDirectoryHandle(name) : await from.getFileHandle(name);
  const move = (h as unknown as { move?: (...to: unknown[]) => Promise<void> }).move;
  if (!move) return false;
  return move.apply(h, into ? [into, as] : [as]).then(() => true, () => false);
}

/**
 * Browsers: Tessel's own folder in the browser's file system (the Tessel folder where no other is chosen), and in
 * desktop Chromium folders the user picked, kept as handles (the browser may ask again after a restart).
 */
const browserFolders: FoldersApi = {
  supported: true,
  canAdd: canPickFolders(),
  allFilesSupported: false,
  appFolder: async () => APP_ROOT,
  async roots() {
    const picked = await Promise.all(
      (await savedFolders()).map(async ([id, f]) => ({ id, name: f.name, kind: 'folder' as const, locked: !(await isGranted(f.handle)) })),
    );
    return [APP_ROOT, ...picked];
  },
  async add() {
    if (!canPickFolders()) return null;
    const handle = await pickDirectory();
    if (!handle) return null;
    const id = `dir-${Date.now().toString(36)}`;
    await set(id, { name: handle.name, handle } satisfies Saved, store);
    return { id, name: handle.name, kind: 'folder' };
  },
  forget: (id) => del(id, store),
  async nestings(roots) {
    const saved = new Map(await savedFolders());
    const known = roots.filter((r) => saved.has(r.id)).map((r) => ({ id: r.id, handle: saved.get(r.id)!.handle }));
    return handleNestings(known);
  },
  async unlock(id, write = false) {
    if (id === APP_ROOT_ID) return true;
    const h = await folderHandle(id);
    return (await h.requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted';
  },
  async list(root, dir) {
    const out: FolderEntry[] = [];
    for await (const [name, h] of (await dirAt(root, dir)).entries()) {
      if (name.startsWith('.')) continue;
      const id = dir ? `${dir}/${name}` : name;
      if (h.kind === 'directory') {
        out.push({ id, name, kind: 'dir', size: 0, modified: 0 });
        continue;
      }
      const kind = kindOf(name);
      if (!kind) continue;
      const file = await (h as FileHandle).getFile();
      out.push({ id, name, kind, size: file.size, modified: file.lastModified, handle: h as FileHandle });
    }
    return out;
  },
  read: (_root, e) => e.handle!.getFile(),
  canEdit: () => true,
  canShare: typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',
  async mkdir(root, dir, name) {
    await (await writable(root, dir)).getDirectoryHandle(name, { create: true });
  },
  async create(at, name, data) {
    const dir = await writable(at.root, at.dir);
    const free = await freeName(dir, name, false);
    const handle = await dir.getFileHandle(free, { create: true });
    await writeFile(handle, data);
    return { id: at.dir ? `${at.dir}/${free}` : free, name: free, kind: kindOf(free) ?? 'pdf', size: data.size, modified: Date.now(), handle };
  },
  async rename(root, dir, e, name) {
    const parent = await writable(root, dir);
    if (await exists(parent, name)) throw new Error(`exists:${name}`);
    // Renamed in place where the browser can; elsewhere copied, then the old one removed.
    if (await moveEntry(parent, e.name, e.kind === 'dir', name)) return undefined;
    await copyEntry(parent, e.name, e.kind === 'dir', parent, name);
    await parent.removeEntry(e.name, { recursive: true });
    return undefined;
  },
  async delete(root, dir, list) {
    const parent = await writable(root, dir);
    for (const [i, e] of list.entries()) {
      try {
        await parent.removeEntry(e.name, { recursive: true });
      } catch (err) {
        if (!i) throw err;
        throw new PartlyDone(err instanceof Error ? err.message : String(err), []);
      }
    }
  },
  async transfer(from, list, to, move) {
    const src = await writable(from.root, from.dir);
    const dest = await writable(to.root, to.dir);
    for (const [i, e] of list.entries()) {
      try {
        const as = await freeName(dest, e.name, e.kind === 'dir');
        // Moved in place where the browser can (a large archive isn't copied byte by byte).
        if (move && (await moveEntry(src, e.name, e.kind === 'dir', as, dest))) continue;
        await copyEntry(src, e.name, e.kind === 'dir', dest, as);
        if (move) await src.removeEntry(e.name, { recursive: true });
      } catch (err) {
        if (!i) throw err;
        throw new PartlyDone(err instanceof Error ? err.message : String(err), []);
      }
    }
    return [];
  },
  async share(root, list) {
    const files = await Promise.all(list.filter((e) => e.handle).map((e) => e.handle!.getFile()));
    if (files.length && navigator.canShare?.({ files })) await navigator.share({ files }).catch(() => {});
  },
  async dirAt(root, path, create) {
    if (!path.length) return undefined;
    try {
      let dir = create ? await writable(root) : await folderHandle(root);
      for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
      return path.join('/');
    } catch (e) {
      if (create) throw e;
      return null;
    }
  },
  async listNames(root, path) {
    try {
      let dir = await folderHandle(root);
      for (const part of path) dir = await dir.getDirectoryHandle(part);
      const out: string[] = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') out.push(name);
      return out;
    } catch {
      return [];
    }
  },
  async readText(root, path) {
    try {
      let dir = await folderHandle(root);
      for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(path[path.length - 1])).getFile()).text();
    } catch (e) {
      // Not there is no text; not allowed (after a browser restart) or unreadable is an error, not "empty".
      if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  },
  async writeText(root, path, text) {
    let dir = await writable(root);
    for (const part of path.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    await writeFile(await dir.getFileHandle(path[path.length - 1], { create: true }), new Blob([text], { type: 'application/json' }));
  },
  allFiles: async () => false,
  requestAllFiles: async () => false,
};

// Without a file system of its own (old browsers): no folders at all.
const unsupported: FoldersApi = {
  ...browserFolders,
  supported: false,
  canAdd: false,
  appFolder: async () => null,
  roots: async () => [],
  add: async () => null,
  canEdit: () => false,
  canShare: false,
};

const ownFileSystem = typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
export const folders: FoldersApi = traced('folders', shell ? shellFolders : ownFileSystem ? browserFolders : unsupported);
