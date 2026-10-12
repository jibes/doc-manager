import { createStore, del, entries, set } from 'idb-keyval';

import { t } from '@/i18n';
import type { FolderEntry, FolderRoot, FoldersApi } from './folderTypes';
import { canPickFolders, pickDirectory, type DirHandle, type FileHandle } from './fsa';
import { shell, shellDocUrl, shellRequest } from './shell';

export type { FolderEntry, FolderRoot } from './folderTypes';

const kindOf = (name: string): FolderEntry['kind'] | null => (/\.pdf$/i.test(name) ? 'pdf' : /\.epub$/i.test(name) ? 'epub' : null);

/**
 * Android app: folders granted through the system picker (and, with all files access, the whole device),
 * listed and served by the app (see shell/android Folders.kt).
 */
const shellFolders: FoldersApi = {
  supported: true,
  allFilesSupported: true,
  async roots(showAll) {
    const picked = await shellRequest<{ uri: string; name: string }[]>('folders');
    const roots: FolderRoot[] = picked.map((f) => ({ id: f.uri, name: f.name, kind: 'folder' }));
    if (showAll && (await this.allFiles())) roots.unshift({ id: 'all', name: t.allDocuments, kind: 'all' }, { id: 'device', name: t.internalStorage, kind: 'device' });
    return roots;
  },
  async add() {
    const f = await shellRequest<{ uri: string; name: string } | null>('pickFolder');
    return f && { id: f.uri, name: f.name, kind: 'folder' };
  },
  remove: (id) => shellRequest('forgetFolder', { uri: id }),
  unlock: async () => true,
  list: (root, dir) => shellRequest<FolderEntry[]>('list', { root, dir: dir ?? '' }),
  async read(_root, e) {
    const res = await fetch(shellDocUrl(e.uri!));
    if (!res.ok) throw new Error(t.fileGone);
    return res.blob();
  },
  allFiles: async () => (await shellRequest<{ allFiles: boolean }>('access')).allFiles,
  requestAllFiles: () => shellRequest<boolean>('requestAllFiles'),
};

// Desktop Chromium: picked folders are kept as handles; the browser may ask again after a restart.
const store = createStore('tessel-folders', 'folders');
type Saved = { name: string; handle: DirHandle };

async function savedFolders(): Promise<[string, Saved][]> {
  return (await entries<string, Saved>(store)).sort((a, b) => a[1].name.localeCompare(b[1].name));
}

async function folderHandle(root: string): Promise<DirHandle> {
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

const browserFolders: FoldersApi = {
  supported: true,
  allFilesSupported: false,
  async roots() {
    return Promise.all(
      (await savedFolders()).map(async ([id, f]) => ({
        id,
        name: f.name,
        kind: 'folder' as const,
        locked: (await f.handle.queryPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted',
      })),
    );
  },
  async add() {
    const handle = await pickDirectory();
    if (!handle) return null;
    const id = `dir-${Date.now().toString(36)}`;
    await set(id, { name: handle.name, handle } satisfies Saved, store);
    return { id, name: handle.name, kind: 'folder' };
  },
  remove: (id) => del(id, store),
  async unlock(id) {
    const h = await folderHandle(id);
    return (await h.requestPermission({ mode: 'read' })) === 'granted';
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
  allFiles: async () => false,
  requestAllFiles: async () => false,
};

const unsupported: FoldersApi = {
  ...browserFolders,
  supported: false,
  roots: async () => [],
  add: async () => null,
};

export const folders: FoldersApi = shell ? shellFolders : canPickFolders() ? browserFolders : unsupported;
