import { create } from 'zustand';

import { folders } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import { usePrefs } from '@/state/prefs';
import { schedule } from './indexer';
import { expired, parseTrash, serializeTrash, type Trashed } from './sync';

/**
 * The archive's trash: what is deleted from the archive folder goes to `.tessel/trash` (synced like the rest),
 * so a deletion that reaches every device can still be undone. `.tessel/trash.json` remembers where each item
 * came from; items go for good after 30 days.
 */

const TRASH = ['.tessel', 'trash'];
const MANIFEST = ['.tessel', 'trash.json'];

/** An item in the trash: what is remembered of it, and its file there. */
export type TrashItem = Trashed & { entry: FolderEntry };

export const useTrash = create<{ items: TrashItem[] }>(() => ({ items: [] }));

const readManifest = async (root: string) => parseTrash((await folders.readText(root, MANIFEST).catch(() => null)) ?? '');
const writeManifest = (root: string, items: Trashed[]) => folders.writeText(root, MANIFEST, serializeTrash(items));

/** "name (2).pdf" for "name.pdf": the name a file gets when its own is taken. */
function renamedFrom(name: string, original: string): boolean {
  if (name === original) return true;
  const dot = original.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [original.slice(0, dot), original.slice(dot)] : [original, ''];
  return name.startsWith(`${stem} (`) && name.endsWith(`)${ext}`) && /^\d+$/.test(name.slice(stem.length + 2, name.length - ext.length - 1));
}

/** Whether deleting in `root` goes to the trash (the archive folder) rather than for good. */
export const trashes = (root: string) => root === usePrefs.getState().archive;

/** Moves files and folders to the archive's trash. Returns what was trashed (for Undo). */
export async function moveToTrash(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<Trashed[]> {
  const trash = (await folders.dirAt(root, TRASH, true)) ?? undefined;
  const before = new Set((await folders.list(root, trash)).map((e) => e.name));
  await folders.transfer({ root, dir }, entries, { root, dir: trash }, true);
  const arrived = (await folders.list(root, trash)).filter((e) => !before.has(e.name));
  const now = Date.now();
  const items = entries.map((e) => {
    const found = arrived.find((a) => renamedFrom(a.name, e.name));
    if (found) arrived.splice(arrived.indexOf(found), 1);
    return { name: found?.name ?? e.name, root, dir, original: e.name, deletedAt: now };
  });
  await writeManifest(root, [...(await readManifest(root)), ...items]);
  schedule(1000);
  return items;
}

/** Deletes: to the trash in the archive folder, for good elsewhere. Returns what was trashed, if anything. */
export async function discard(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<Trashed[] | null> {
  if (trashes(root)) return moveToTrash(root, dir, entries);
  await folders.delete(root, dir, entries);
  return null;
}

/** What is in the trash now: its files, with what the manifest remembers of them (newest first). */
export async function loadTrash(root: string): Promise<TrashItem[]> {
  const trash = await folders.dirAt(root, TRASH, false);
  if (trash === null) {
    useTrash.setState({ items: [] });
    return [];
  }
  const [files, manifest] = await Promise.all([folders.list(root, trash), readManifest(root)]);
  const items = files
    .map((entry) => {
      const known = manifest.find((t) => t.name === entry.name);
      // Trashed on a device whose manifest didn't sync: it came from the top of the archive.
      return { ...(known ?? { name: entry.name, root, original: entry.name, deletedAt: entry.modified || Date.now() }), entry };
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
  useTrash.setState({ items });
  return items;
}

async function forget(root: string, names: string[]) {
  await writeManifest(root, (await readManifest(root)).filter((t) => !names.includes(t.name)));
}

/** Puts items back where they came from (the top of the archive if that folder is gone). */
export async function restore(root: string, items: Trashed[]): Promise<void> {
  const trash = (await folders.dirAt(root, TRASH, false)) ?? undefined;
  const files = await folders.list(root, trash);
  for (const item of items) {
    const entry = files.find((f) => f.name === item.name);
    if (!entry) continue;
    await folders.transfer({ root, dir: trash }, [entry], { root, dir: item.dir }, true).catch(() => folders.transfer({ root, dir: trash }, [entry], { root }, true));
  }
  await forget(root, items.map((i) => i.name));
  schedule(1000);
  await loadTrash(root);
}

/** Deletes items in the trash for good. */
export async function deleteForever(root: string, names: string[]): Promise<void> {
  const trash = (await folders.dirAt(root, TRASH, false)) ?? undefined;
  const files = (await folders.list(root, trash)).filter((f) => names.includes(f.name));
  if (files.length) await folders.delete(root, trash, files);
  await forget(root, names);
  await loadTrash(root);
}

/** Deletes what has been in the trash longer than 30 days. */
export async function purge(root: string): Promise<void> {
  const old = expired(await loadTrash(root));
  if (old.length) await deleteForever(root, old.map((t) => t.name));
}
