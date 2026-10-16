import { folders } from '@/core/lib/folders';
import { readStored, writeStored } from '@/core/lib/stored';

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


/**
 * Once per Tessel folder (3.1): `.tessel/state`, where versions before 3.0 shared reading between devices, goes;
 * nothing reads it any more. Tried again next time when it can't be done now (no write access yet).
 */
export async function dropOldState(root: string): Promise<void> {
  const done = `tessel-state-dropped:${root}`;
  if (readStored(done)) return;
  const dir = await folders.dirAt(root, ['.tessel'], false);
  const state = dir ? (await folders.list(root, dir)).find((e) => e.kind === 'dir' && e.name === 'state') : undefined;
  if (state) await folders.delete(root, dir ?? undefined, [state]);
  writeStored(done, '1');
}
