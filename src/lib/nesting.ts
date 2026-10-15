import type { FolderRoot } from './folderTypes';
import type { DirHandle } from './fsa';

/**
 * Folders added inside one another (the archive inside "Documents", the Tessel folder inside a picked folder): each
 * file is still listed once. `outer` holds `inner`; walking `outer`, the folder with ID `dir` is `inner` itself.
 */
export type Nesting = { outer: string; inner: string; dir: string };

/** The Android app's own folder (Documents/Tessel), as a root's ID. */
export const APP_ROOT_ID = 'app';
const APP_PATH = 'primary:Documents/Tessel';
const STORAGE = '/storage/';
const PRIMARY = '/storage/emulated/0';

/**
 * Where an Android folder is, as "volume:path" ("primary:Documents/Archive"): a picked folder (its tree URI), a
 * folder inside one (its document ID), the Tessel folder, or a path on the device. Null where it can't be told
 * (a cloud provider's folder).
 */
export function storagePath(id: string): string | null {
  if (id === APP_ROOT_ID) return APP_PATH;
  const tree = /^content:\/\/com\.android\.externalstorage\.documents\/tree\/([^/]+)/.exec(id);
  if (tree) return decodeURIComponent(tree[1]);
  if (id.startsWith(`${PRIMARY}/`) || id === PRIMARY) return `primary:${id.slice(PRIMARY.length + 1)}`;
  if (id.startsWith(STORAGE)) {
    const [volume, ...rest] = id.slice(STORAGE.length).split('/');
    return volume ? `${volume}:${rest.join('/')}` : null;
  }
  // A document ID inside a picked folder ("primary:Documents/Tessel"); not a URI of another provider.
  return /^[\w-]+:/.test(id) && !id.includes('://') ? id : null;
}

/** Whether `inner` is a folder below `outer` (both "volume:path"). */
function below(outer: string, inner: string): boolean {
  if (outer === inner) return false;
  // A whole volume ("primary:") holds everything on it.
  return outer.endsWith(':') ? inner.startsWith(outer) : inner.startsWith(`${outer}/`);
}

/** The ID a listing of `outer` gives the folder at `path`: a document ID in a picked folder, a file path in the Tessel folder. */
function idIn(outer: FolderRoot, path: string): string {
  if (outer.id !== APP_ROOT_ID) return path;
  const [volume, rest] = [path.slice(0, path.indexOf(':')), path.slice(path.indexOf(':') + 1)];
  return volume === 'primary' ? `${PRIMARY}/${rest}` : `${STORAGE}${volume}/${rest}`;
}

const walkable = (r: FolderRoot) => r.kind === 'folder' || r.kind === 'app';

/** Android app: folders inside other added folders, told from their places on the device. */
export function shellNestings(roots: FolderRoot[]): Nesting[] {
  const placed = roots.filter(walkable).map((r) => ({ root: r, path: storagePath(r.id) }));
  const out: Nesting[] = [];
  for (const a of placed) {
    for (const b of placed) {
      if (a === b || !a.path || !b.path || !below(a.path, b.path)) continue;
      out.push({ outer: a.root.id, inner: b.root.id, dir: idIn(a.root, b.path) });
    }
  }
  return out;
}

/** Desktop browsers: picked folders inside other picked folders, asked of their handles (dir IDs are relative paths). */
export async function handleNestings(roots: { id: string; handle: DirHandle }[]): Promise<Nesting[]> {
  const out: Nesting[] = [];
  for (const a of roots) {
    for (const b of roots) {
      if (a === b) continue;
      const path = await a.handle.resolve(b.handle).catch(() => null);
      if (path?.length) out.push({ outer: a.id, inner: b.id, dir: path.join('/') });
    }
  }
  return out;
}
