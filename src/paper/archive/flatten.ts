import { folders, type FolderEntry } from '@/core/lib/folders';
import { INBOX } from './dirs';

/** What flattening came to: PDFs moved up, those of them given a free name ("(2)"), folders left (other files in them). */
export type Flattened = { moved: number; renamed: number; kept: number };

/** Folders of the Tessel folder that are its own: the inbox (and hidden ones, which aren't listed). */
const own = (e: FolderEntry) => e.kind === 'dir' && e.name === INBOX;

/** Whether the Tessel folder still has folders with documents in them (from before it was flat). */
export async function hasFolders(root: string): Promise<boolean> {
  const holdsPdfs = async (dir?: string): Promise<boolean> => {
    const inside = await folders.list(root, dir).catch(() => []);
    if (dir && inside.some((e) => e.kind !== 'dir')) return true;
    for (const sub of inside) if (sub.kind === 'dir' && (dir || !own(sub)) && (await holdsPdfs(sub.id))) return true;
    return false;
  };
  return holdsPdfs();
}

/**
 * Once, from Settings: the PDFs in the Tessel folder's folders move up into it, a name already taken getting a free
 * one (nothing is overwritten); folders left empty go, those with other files in them stay.
 */
export async function flatten(root: string): Promise<Flattened> {
  const taken = new Set((await folders.list(root)).filter((e) => e.kind !== 'dir').map((e) => key(e.name)));
  const out: Flattened = { moved: 0, renamed: 0, kept: 0 };
  const walk = async (dir: FolderEntry, path: string[]): Promise<boolean> => {
    const inside = await folders.list(root, dir.id);
    let empty = true;
    for (const sub of inside.filter((e) => e.kind === 'dir')) if (!(await walk(sub, [...path, sub.name]))) empty = false;
    const pdfs = inside.filter((e) => e.kind !== 'dir');
    if (pdfs.length) {
      await folders.transfer({ root, dir: dir.id }, pdfs, { root }, true);
      for (const e of pdfs) {
        if (taken.has(key(e.name))) out.renamed++;
        taken.add(key(e.name));
      }
      out.moved += pdfs.length;
    }
    // Other files (notes, pictures) keep their folder.
    if (empty && (await isEmpty(root, dir.id, path))) {
      // Its parent not found: not the root's folder of that name instead.
      const parent = path.length > 1 ? await folders.dirAt(root, path.slice(0, -1), false) : undefined;
      if (parent !== null) {
        await folders.delete(root, parent, [dir]).catch(() => {});
        return true;
      }
    }
    out.kept++;
    return false;
  };
  for (const dir of (await folders.list(root)).filter((e) => e.kind === 'dir' && !own(e))) await walk(dir, [dir.name]);
  return out;
}

const key = (name: string) => name.normalize('NFC').toLocaleLowerCase();

/** Hidden folders `list` doesn't show (and `listNames`, files only, neither): Syncthing's old versions, repositories. */
const HIDDEN_DIRS = ['.stversions', '.stfolder', '.git', '.svn', '.hg', '.tessel', '.trash', '.Trash'];

/**
 * Whether a folder is empty, so it can go (it goes with all that is in it): no entries listed, no files (hidden
 * ones too), none of the usual hidden folders. Anything that can't be read counts as not empty.
 */
async function isEmpty(root: string, id: string, path: string[]): Promise<boolean> {
  try {
    if ((await folders.list(root, id)).length) return false;
    if ((await folders.listNames(root, path)).length) return false;
    for (const name of HIDDEN_DIRS) if ((await folders.dirAt(root, [...path, name], false)) != null) return false;
    // listNames answers [] for a folder it can't read: it must still be found to count as empty.
    return (await folders.dirAt(root, path, false)) != null;
  } catch {
    return false;
  }
}
