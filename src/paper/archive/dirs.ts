import { folders } from '@/core/lib/folders';

/** The Tessel folder's inbox: where kept files, scans and files from other devices land, to be filed. */
export const INBOX = 'Inbox';

/** The ID of the folder `name` in `dir` (the root when undefined), or null. */
export async function childDir(root: string, dir: string | undefined, name: string): Promise<string | null> {
  const found = (await folders.list(root, dir)).find((e) => e.kind === 'dir' && e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  return found ? found.id : null;
}

/** The folder at `names` below the root, made where missing; its ID (undefined: the root itself). */
export async function ensureDir(root: string, names: string[]): Promise<string | undefined> {
  let dir: string | undefined;
  for (const name of names) {
    let id = await childDir(root, dir, name);
    if (!id) {
      await folders.mkdir(root, dir, name);
      id = await childDir(root, dir, name);
      if (!id) throw new Error(`Can't make the folder ${name}`);
    }
    dir = id;
  }
  return dir;
}

/** The inbox folder of the archive, made when missing. */
export const inboxDir = (archive: string) => ensureDir(archive, [INBOX]);

