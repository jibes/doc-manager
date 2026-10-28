import { folders, type FolderEntry } from '@/core/lib/folders';
import { log } from '@/core/lib/log';
import { APP_ROOT_ID } from '@/core/lib/nesting';
import { shell, shellRequest } from '@/core/lib/shell';
import { readStored, writeStored } from '@/core/lib/stored';
import { repo } from '@/core/storage';
import { useLibrary } from '@/paper/state/library';
import { usePrefs } from '@/paper/state/prefs';
import { INBOX, inboxDir } from './dirs';
import { flatten, hasFolders } from './flatten';
import { allDocs, forget, schedule } from './indexer';
import { readAdded } from './intake';
import { moveTrash } from './trash';
import { setArchive } from './views';

/**
 * The Tessel folder: the one folder Tessel keeps documents in. A folder chosen in Settings (often one Syncthing
 * syncs), else this device's own (Documents/Tessel in the Android app, the browser's own storage).
 */
export const tesselRoot = () => usePrefs.getState().archive ?? APP_ROOT_ID;

/** The documents Tessel lists from a folder (the index knows them). */
const docsIn = async (root: string) => (await allDocs()).filter((d) => d.place.kind === 'folder' && d.place.root === root);

/** Whether a folder just picked is the Tessel folder itself (picked again: another ID for the same folder). */
export const isTessel = async (id: string) => id === tesselRoot() || !!(await folders.same?.(id, tesselRoot()).catch(() => false));

/** How many documents the Tessel folder has now (what changing it would leave behind or move). */
export const documentsHere = async () => (await docsIn(tesselRoot())).length;

/** The library's records of files in a folder: they would point at nothing once the files move or stop counting. */
async function recordsOf(root: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const d of await docsIn(root)) {
    if (d.place.kind !== 'folder') continue;
    const { entry } = d.place;
    const found = entry.handle ? await repo.linkedToHandle(entry.handle).catch(() => []) : entry.uri ? ((await repo.linkedTo([entry.uri]).catch(() => new Map())).get(entry.uri) ?? []) : [];
    for (const id of found) ids.add(id);
  }
  return [...ids];
}

const pdfs = (list: FolderEntry[]) => list.filter((e) => e.kind !== 'dir');

/** What a Tessel folder keeps for every device besides its documents (each device's own state isn't moved). */
const SETTINGS = [
  ['.tessel', 'rules.json'],
  ['.tessel', 'views.json'],
];

/**
 * Makes `to` the Tessel folder (null: this device's own). `move`: its documents go along (the inbox's to the new
 * inbox; old folders flattened first); else they stay where they are and stop being listed. Where each was left
 * is kept either way (this device's cache knows documents by their content). A folder picked for the old one is
 * let go of.
 */
export async function changeTessel(to: string | null, move: boolean): Promise<number> {
  const from = tesselRoot();
  const target = to ?? APP_ROOT_ID;
  if (from === target) return 0;
  // One inside the other: moving would move documents into (or out of) a folder of the same tree.
  const roots = (await folders.roots(false).catch(() => [])).filter((r) => r.id === from || r.id === target);
  if ((await folders.nestings(roots).catch(() => [])).length) throw new Error('inside-itself');
  const stale = await recordsOf(from);
  const listed = (await docsIn(from)).map((d) => d.key);
  let moved = 0;
  if (move) {
    if (!(await folders.unlock(target, true).catch(() => false))) throw new Error('denied');
    // The rules and saved views go along where the new folder has none (copied: the old folder keeps working).
    for (const path of SETTINGS) {
      const text = await folders.readText(from, path).catch(() => null);
      if (text && !(await folders.readText(target, path).catch(() => null))) await folders.writeText(target, path, text);
    }
  }
  // The new folder is the Tessel folder before anything moves: a folder that can't take it is told before.
  await setArchive(to);
  if (move) {
    try {
      if (await hasFolders(from)) await flatten(from);
      const top = pdfs(await folders.list(from));
      if (top.length) await folders.transfer({ root: from }, top, { root: target }, true);
      moved += top.length;
      const inbox = (await folders.list(from)).find((e) => e.kind === 'dir' && e.name.toLowerCase() === INBOX.toLowerCase());
      const waiting = inbox ? pdfs(await folders.list(from, inbox.id)) : [];
      if (waiting.length) await folders.transfer({ root: from, dir: inbox!.id }, waiting, { root: target, dir: await inboxDir(target) }, true);
      moved += waiting.length;
    } catch (error) {
      // Stopped part way: the old folder stays the Tessel folder, with its documents listed, so trying again
      // moves the rest (what moved already is in the new folder).
      await setArchive(from === APP_ROOT_ID ? null : from);
      throw error;
    }
    // This device's own storage keeps no trash (nothing there would show or empty it): a folder left for it
    // keeps its own, on the disk where it is.
    if (to !== null) await moveTrash(from, target).catch((e: unknown) => log.warn('tessel', 'trash not moved', e));
  }
  // Out of the list at once (the new folder's come as it is read).
  forget(listed);
  // The records of the files there: found again, by their content, where they are listed now.
  for (const id of stale) await useLibrary.getState().remove(id);
  if (from !== APP_ROOT_ID) await folders.forget(from).catch(() => {});
  schedule(300);
  return moved;
}

/**
 * Once, from Settings: every PDF in a folder (and its folders) is copied into the Tessel folder (its Inbox, where
 * it has one), as anything added is; the folder itself is left as it was and not kept.
 */
export async function importFolder(onProgress: (done: number, total: number) => void): Promise<number | null> {
  const picked = await folders.add();
  if (!picked) return null;
  try {
    // The Tessel folder itself, or one inside it or around it: its own documents would come in again.
    const roots = (await folders.roots(false).catch(() => [])).filter((r) => r.id === picked.id || r.id === tesselRoot());
    if ((await isTessel(picked.id)) || (await folders.nestings(roots).catch(() => [])).length) throw new Error('inside-itself');
    const found: { dir?: string; entry: FolderEntry }[] = [];
    const walk = async (dir: string | undefined, depth: number) => {
      for (const e of await folders.list(picked.id, dir)) {
        if (e.kind === 'dir') {
          if (depth < 8) await walk(e.id, depth + 1);
        } else found.push({ dir, entry: e });
      }
    };
    await walk(undefined, 0);
    const library = useLibrary.getState();
    // Counted as new only where the library didn't have it (a folder imported again adds nothing).
    const had = new Set(useLibrary.getState().docs.map((d) => d.id));
    let done = 0;
    let added = 0;
    for (const { entry } of found) {
      onProgress(done, found.length);
      const file = await folders.read(picked.id, entry);
      const recs = await library.importFiles([{ name: entry.name, size: entry.size || file.size, file }]);
      added += recs.filter((r) => !had.has(r.id)).length;
      readAdded(recs);
      done++;
    }
    return added;
  } finally {
    // Let go of, unless it is the Tessel folder's own (the same ID where a folder has one: the Android app's).
    if (picked.id !== tesselRoot()) await folders.forget(picked.id).catch(() => {});
    schedule(300);
  }
}

/**
 * Once (3.2): folders added as sources by 3.0 and 3.1 are let go of; only the Tessel folder is read. Their files
 * stay where they are (Settings → Import a folder copies them in).
 */
export async function dropSources(): Promise<void> {
  const done = 'tessel-sources-dropped';
  if (readStored(done) || !folders.supported) return;
  const archive = usePrefs.getState().archive;
  const roots = await folders.roots(false);
  for (const r of roots) {
    if (r.kind !== 'folder' || r.id === archive) continue;
    for (const id of await recordsOf(r.id)) await useLibrary.getState().remove(id);
    await folders.forget(r.id).catch(() => {});
  }
  writeStored(done, '1');
  schedule(300);
}

/**
 * In the Android app: the system's file picker shows the Tessel folder as "Tessel", with the first page of each PDF
 * as its picture, and (Settings, with All files access) all of internal storage, with previews. Told which folder
 * that is, and whether to show the storage, now and whenever it changes.
 */
export function showInPicker(): () => void {
  if (!shell) return () => {};
  const tell = (archive: string | null) => void shellRequest('tesselRoot', { root: archive ?? APP_ROOT_ID }).catch(() => {});
  const device = (on: boolean) => void shellRequest('pickerDevice', { on }).catch(() => {});
  tell(usePrefs.getState().archive);
  device(usePrefs.getState().pickerDevice);
  return usePrefs.subscribe((s, before) => {
    if (s.archive !== before.archive) tell(s.archive);
    if (s.pickerDevice !== before.pickerDevice) device(s.pickerDevice);
  });
}
