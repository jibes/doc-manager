import { create } from 'zustand';

import { folders } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import { sameOrRenamed } from '@/lib/names';
import { usePrefs } from '@/state/prefs';
import { ensureDir } from './inbox';
import { schedule } from './indexer';
import { readSettings } from './settingsFile';
import { expired, parseTrash, serializeTrash, type Trashed } from './sync';

/**
 * The archive's trash: what is deleted from the archive folder goes to `.tessel/trash` (synced like the rest),
 * so a deletion that reaches every device can still be undone. `.tessel/trash.json` remembers where each item
 * came from; items go for good after 30 days.
 */

const TRASH = ['.tessel', 'trash'];
const MANIFEST = ['.tessel', 'trash.json'];

/** An item in the trash: what is remembered of it, and its file there. `unrecorded`: no date known for it yet. */
export type TrashItem = Trashed & { entry: FolderEntry; unrecorded?: boolean };

export const useTrash = create<{ items: TrashItem[] }>(() => ({ items: [] }));

/** The manifest; null when it is there but can't be read now (then it isn't written either: that would lose it). */
const readManifest = async (root: string): Promise<Trashed[] | null> => {
  try {
    return parseTrash((await readSettings(root, MANIFEST)) ?? '');
  } catch {
    return null;
  }
};
const writeManifest = (root: string, items: Trashed[]) => folders.writeText(root, MANIFEST, serializeTrash(items));
/** Reads, changes and writes back the manifest; nothing when it can't be read. */
async function changeManifest(root: string, edit: (items: Trashed[]) => Trashed[]) {
  const items = await readManifest(root);
  if (items) await writeManifest(root, edit(items));
}

/**
 * A folder's place below the root as names, which every device understands (IDs are this device's own), where it
 * can be told from its ID: browsers' IDs are those paths; Android's documents have the tree's path in theirs.
 */
function namesOf(root: string, dir: string | undefined): string[] | undefined {
  if (!dir) return [];
  if (!root.startsWith('content://')) return dir.startsWith('/') ? undefined : dir.split('/').filter(Boolean);
  const tree = /\/tree\/([^/]+)/.exec(root)?.[1];
  const treeId = tree ? decodeURIComponent(tree) : '';
  return treeId && dir.startsWith(`${treeId}/`) ? dir.slice(treeId.length + 1).split('/').filter(Boolean) : undefined;
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
  const path = namesOf(root, dir);
  const items = entries.map((e) => {
    const found = arrived.find((a) => sameOrRenamed(a.name, e.name));
    if (found) arrived.splice(arrived.indexOf(found), 1);
    return { name: found?.name ?? e.name, root, dir, ...(path ? { path } : {}), original: e.name, deletedAt: now };
  });
  await changeManifest(root, (known) => [...known, ...items]);
  schedule(1000);
  return items;
}

/** Deletes: to the trash in the archive folder, for good elsewhere. Returns what was trashed, if anything. */
export async function discard(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<Trashed[] | null> {
  if (trashes(root)) return moveToTrash(root, dir, entries);
  await folders.delete(root, dir, entries);
  return null;
}

/**
 * What is in the trash now: its files, with what the manifest remembers of them (newest first). A file it doesn't
 * know (trashed on a device whose manifest hasn't arrived) is dated when first seen, and that date recorded:
 * its own file date may be years old, and must not have it deleted for good at once.
 */
export async function loadTrash(root: string): Promise<TrashItem[]> {
  const trash = await folders.dirAt(root, TRASH, false);
  if (trash === null) {
    useTrash.setState({ items: [] });
    return [];
  }
  const [files, manifest] = await Promise.all([folders.list(root, trash), readManifest(root)]);
  const now = Date.now();
  const unknown: Trashed[] = [];
  const items = files
    .map((entry) => {
      const known = manifest?.find((t) => t.name === entry.name);
      if (known) return { ...known, entry };
      // Its folder isn't known: it goes back to the top of the archive.
      const first = { name: entry.name, root, original: entry.name, deletedAt: now };
      unknown.push(first);
      return { ...first, entry, unrecorded: !manifest };
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
  if (manifest && unknown.length) await writeManifest(root, [...manifest, ...unknown]).catch(() => {});
  useTrash.setState({ items });
  return items;
}

async function forget(root: string, names: string[]) {
  await changeManifest(root, (items) => items.filter((t) => !names.includes(t.name)));
}

/**
 * Puts items back where they came from: the same folder (made again if it's gone), else the top of the archive;
 * under their own name again when it is free.
 */
export async function restore(root: string, items: Trashed[]): Promise<void> {
  const trash = (await folders.dirAt(root, TRASH, false)) ?? undefined;
  const files = await folders.list(root, trash);
  for (const item of items) {
    const entry = files.find((f) => f.name === item.name);
    if (!entry) continue;
    const to = item.path ? await ensureDir(root, item.path).catch(() => item.dir) : item.dir;
    let dir = to;
    await folders.transfer({ root, dir: trash }, [entry], { root, dir: to }, true).catch(async () => {
      dir = undefined;
      await folders.transfer({ root, dir: trash }, [entry], { root }, true);
    });
    if (item.original !== item.name) {
      const here = await folders.list(root, dir).catch(() => [] as FolderEntry[]);
      const back = here.find((f) => f.name === item.name);
      if (back && !here.some((f) => f.name === item.original)) await folders.rename(root, dir, back, item.original).catch(() => {});
    }
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

/** Deletes what has been in the trash longer than 30 days (only items whose date is recorded). */
export async function purge(root: string): Promise<void> {
  const old = expired((await loadTrash(root)).filter((t) => !t.unrecorded));
  if (old.length) await deleteForever(root, old.map((t) => t.name));
}
