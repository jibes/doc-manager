import { create } from 'zustand';

import { folders } from '@/lib/folders';
import { PartlyDone, type FolderEntry } from '@/lib/folderTypes';
import { sameOrRenamed } from '@/lib/names';
import { readStored, writeStored } from '@/lib/stored';
import { usePrefs } from '@/state/prefs';
import { ensureDir } from './inbox';
import { schedule } from './indexer';
import { readSettings } from './settingsFile';
import { expired, KEEP_DAYS, parseTrash, serializeTrash, type Trashed } from './sync';

/**
 * The archive's trash: what is deleted from the archive folder goes to `.tessel/trash` (synced like the rest),
 * so a deletion that reaches every device can still be undone. `.tessel/trash.json` remembers where each item
 * came from; items go for good after 30 days.
 */

const TRASH = ['.tessel', 'trash'];
const MANIFEST = ['.tessel', 'trash.json'];
/** Entries whose file has been gone this long are dropped: a file still on its way has long arrived by then. */
const STALE_MS = (KEEP_DAYS + 14) * 86_400_000;
/** This device's own dates for files in the trash that the manifest doesn't know (yet). */
const SEEN = 'tessel.trashSeen';

/** An item in the trash: what is remembered of it, and its file there. `unrecorded`: not in the manifest. */
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

/**
 * Reads, changes and writes back the manifest; nothing when it can't be read. With the trash's files (`present`),
 * entries whose file has long been gone are dropped.
 */
async function changeManifest(root: string, edit: (items: Trashed[]) => Trashed[], present?: Set<string>) {
  const items = await readManifest(root);
  if (!items) return;
  const now = Date.now();
  await writeManifest(root, edit(present ? items.filter((t) => present.has(t.name) || now - t.deletedAt < STALE_MS) : items));
}

/** The newest entry for a name (an older one may be left from a file of that name deleted before). */
const entryFor = (items: Trashed[], name: string) =>
  items.filter((t) => t.name === name).reduce<Trashed | undefined>((a, b) => (!a || b.deletedAt > a.deletedAt ? b : a), undefined);

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
  // What did arrive when one fails is recorded all the same (then the error is told).
  let failed: unknown;
  await folders.transfer({ root, dir }, entries, { root, dir: trash }, true).catch((e: unknown) => {
    if (!(e instanceof PartlyDone)) throw e;
    failed = e;
  });
  const there = await folders.list(root, trash);
  const arrived = there.filter((e) => !before.has(e.name));
  const now = Date.now();
  const path = namesOf(root, dir);
  // Which arrival is which: its own name first, then a name made free ("X (2).pdf").
  const found = new Map<FolderEntry, FolderEntry>();
  for (const e of entries) {
    const same = arrived.find((a) => a.name === e.name);
    if (same) found.set(e, arrived.splice(arrived.indexOf(same), 1)[0]);
  }
  for (const e of entries) {
    if (found.has(e)) continue;
    const renamed = arrived.find((a) => sameOrRenamed(a.name, e.name));
    if (renamed) found.set(e, arrived.splice(arrived.indexOf(renamed), 1)[0]);
  }
  const items = entries.filter((e) => !failed || found.has(e)).map((e) => ({ name: found.get(e)?.name ?? e.name, root, dir, ...(path ? { path } : {}), original: e.name, deletedAt: now }));
  // An entry left from an earlier file of the same name must not date this one.
  const names = new Set(items.map((i) => i.name));
  await changeManifest(root, (known) => [...known.filter((k) => !names.has(k.name)), ...items], new Set(there.map((e) => e.name)));
  schedule(1000);
  if (failed) throw failed;
  return items;
}

/** Deletes: to the trash in the archive folder, for good elsewhere. Returns what was trashed, if anything. */
export async function discard(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<Trashed[] | null> {
  if (trashes(root)) return moveToTrash(root, dir, entries);
  await folders.delete(root, dir, entries);
  return null;
}

/** What a trash file is to this device: its name, size and date (a later file of that name is another). */
const seenKey = (root: string, e: FolderEntry) => `${root}|${e.name}|${e.size}|${e.modified}`;

/** What copies of the manifest Syncthing kept aside (changed on two devices at once) know. */
async function conflictCopies(root: string): Promise<Trashed[]> {
  const names = (await folders.listNames(root, ['.tessel']).catch(() => [] as string[])).filter((n) => /^trash\.sync-conflict-.*\.json$/.test(n));
  const lists = await Promise.all(names.map((n) => folders.readText(root, ['.tessel', n]).then((text) => parseTrash(text ?? ''), () => [] as Trashed[])));
  return lists.flat();
}

/**
 * What is in the trash now: its files, with what the manifest remembers of them (newest first). A file it doesn't
 * know (trashed on a device whose manifest hasn't arrived, or whose entry a sync conflict lost) is taken from
 * a copy Syncthing kept aside, else dated when this device first saw it: its own file date may be years old,
 * and must not have it deleted for good at once. That date is this device's own (written to the shared manifest,
 * it would conflict with the one still on its way).
 */
export async function loadTrash(root: string): Promise<TrashItem[]> {
  const trash = await folders.dirAt(root, TRASH, false);
  if (trash === null) {
    useTrash.setState({ items: [] });
    return [];
  }
  const [files, manifest] = await Promise.all([folders.list(root, trash), readManifest(root)]);
  const unknown = files.filter((f) => !manifest || !entryFor(manifest, f.name));
  const aside = unknown.length ? await conflictCopies(root) : [];
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(readStored(SEEN) ?? '{}') as Record<string, number>;
  } catch {
    // Started again.
  }
  const now = Date.now();
  const keep: Record<string, number> = Object.fromEntries(Object.entries(seen).filter(([k]) => !k.startsWith(`${root}|`)));
  const items = files
    .map((entry) => {
      const known = manifest && entryFor(manifest, entry.name);
      if (known) return { ...known, entry };
      const kept = entryFor(aside, entry.name);
      if (kept) return { ...kept, entry, unrecorded: true };
      const key = seenKey(root, entry);
      const first = (keep[key] = seen[key] ?? now);
      // Its folder isn't known: it goes back to the top of the archive.
      return { name: entry.name, root, original: entry.name, deletedAt: first, entry, unrecorded: true };
    })
    .sort((a, b) => b.deletedAt - a.deletedAt);
  writeStored(SEEN, JSON.stringify(keep));
  useTrash.setState({ items });
  return items;
}

async function forget(root: string, names: string[]) {
  if (!names.length) return;
  const trash = await folders.dirAt(root, TRASH, false).catch(() => null);
  const present = trash === null ? undefined : new Set((await folders.list(root, trash).catch(() => [] as FolderEntry[])).map((e) => e.name));
  await changeManifest(root, (items) => items.filter((t) => !names.includes(t.name)), present);
}

/**
 * Puts items back where they came from: the same folder (made again if it's gone), else the top of the archive;
 * under their own name again when it is free. What couldn't be put back stays in the trash (and its entry too).
 */
export async function restore(root: string, items: Trashed[]): Promise<void> {
  const trash = (await folders.dirAt(root, TRASH, false)) ?? undefined;
  const files = await folders.list(root, trash);
  const done: string[] = [];
  let failed: unknown;
  for (const item of items) {
    const entry = files.find((f) => f.name === item.name);
    if (!entry) {
      done.push(item.name);
      continue;
    }
    try {
      const to = item.path ? await ensureDir(root, item.path).catch(() => item.dir) : item.dir;
      let dir = to;
      const namesIn = async (d: string | undefined) => new Set((await folders.list(root, d).catch(() => [] as FolderEntry[])).map((f) => f.name));
      let before = await namesIn(to);
      await folders.transfer({ root, dir: trash }, [entry], { root, dir: to }, true).catch(async () => {
        dir = undefined;
        before = await namesIn(undefined);
        await folders.transfer({ root, dir: trash }, [entry], { root }, true);
      });
      if (item.original !== item.name) {
        // The file the move made (the one not there before), not another of that name.
        const here = await folders.list(root, dir).catch(() => [] as FolderEntry[]);
        const back = here.find((f) => !before.has(f.name) && sameOrRenamed(f.name, item.name));
        if (back && !here.some((f) => f.name === item.original)) await folders.rename(root, dir, back, item.original).catch(() => {});
      }
      done.push(item.name);
    } catch (e) {
      failed ??= e;
    }
  }
  await forget(root, done);
  schedule(1000);
  await loadTrash(root);
  if (failed) throw failed;
}

/** Deletes items in the trash for good. */
export async function deleteForever(root: string, names: string[]): Promise<void> {
  const trash = (await folders.dirAt(root, TRASH, false)) ?? undefined;
  const files = (await folders.list(root, trash)).filter((f) => names.includes(f.name));
  if (files.length) await folders.delete(root, trash, files);
  await forget(root, names);
  await loadTrash(root);
}

/** Deletes what has been in the trash longer than 30 days (by its recorded date, or since this device first saw it). */
export async function purge(root: string): Promise<void> {
  const old = expired(await loadTrash(root));
  if (old.length) await deleteForever(root, old.map((t) => t.name));
}
