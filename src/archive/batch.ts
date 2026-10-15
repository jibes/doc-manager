import { folders, type FolderEntry, type Place as FolderPlace } from '@/lib/folders';
import { shareDocs } from '@/lib/fileActions';
import { useLibrary } from '@/state/library';
import type { DocRecord } from '@/storage';
import { forget } from './indexer';
import { importFromFolder } from './Results';
import type { IndexedDoc, Place } from './search';
import type { Trashed } from './sync';
import { moveToTrash, restore, trashes } from './trash';

/** What can be done with several documents picked in Documents at once. */

type InFolder = IndexedDoc & { place: Extract<Place, { kind: 'folder' }> };
const inFolder = (d: IndexedDoc): d is InFolder => d.place.kind === 'folder';
const libraryDoc = (d: IndexedDoc) => (d.place.kind === 'library' ? useLibrary.getState().docs.find((x) => x.id === (d.place as { id: string }).id) : undefined);

/** Files grouped by the folder they are in (as the clipboard and file operations take them). */
export function byFolder(docs: IndexedDoc[]): { from: FolderPlace; entries: FolderEntry[] }[] {
  const groups = new Map<string, { from: FolderPlace; entries: FolderEntry[] }>();
  for (const d of docs.filter(inFolder)) {
    const key = `${d.place.root}\n${d.place.dir ?? ''}`;
    const g = groups.get(key) ?? { from: { root: d.place.root, dir: d.place.dir }, entries: [] };
    g.entries.push(d.place.entry);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Whether all of them are files in folders (copies only in this library can't be copied or moved to a folder). */
export const allInFolders = (docs: IndexedDoc[]) => docs.length > 0 && docs.every(inFolder);

/** Files of one folder (the file browser's), as the reading list takes them. */
export const filesAsDocs = (root: string, dir: string | undefined, entries: FolderEntry[]): IndexedDoc[] =>
  entries.map((entry) => ({
    key: `${root}:${entry.id}`,
    place: { kind: 'folder', root, rootName: '', dir, entry },
    name: entry.name,
    size: entry.size,
    modified: entry.modified,
    title: '',
    sender: '',
    type: '',
    tags: [],
    date: '',
  }));

/** Puts them on the reading list (files come into the library for it); returns how many were added. */
export async function addToReading(docs: IndexedDoc[]): Promise<number> {
  let added = 0;
  for (const d of docs) {
    const rec: DocRecord | undefined = inFolder(d) ? await importFromFolder(d.place) : libraryDoc(d);
    if (!rec) continue;
    const now = useLibrary.getState().docs.find((x) => x.id === rec.id);
    if (now && !now.reading) {
      useLibrary.getState().toggleReading(rec.id);
      added++;
    }
  }
  return added;
}

/** One share sheet for the files, one for library copies. */
export async function shareAll(docs: IndexedDoc[]) {
  const files = docs.filter(inFolder);
  if (files.length) await folders.share(files[0].place.root, files.map((d) => d.place.entry));
  const copies = docs.map(libraryDoc).filter((d): d is DocRecord => !!d);
  if (copies.length) await shareDocs(copies);
}

/** Whether deleting them can't be undone: anything outside the archive (files elsewhere, library copies). */
export const deletesForGood = (docs: IndexedDoc[]) => docs.some((d) => !inFolder(d) || !trashes(d.place.root));

const urisOf = (entries: FolderEntry[]) => entries.flatMap((e) => (e.uri ? [e.uri] : []));

/**
 * Deletes them: files in the archive go to its trash, files elsewhere are deleted, library copies leave the
 * library. Returns what went to the trash, to undo, and `settle` for when that can't be undone any more: then the
 * library forgets its documents of those files too (until then Undo brings them back as they were).
 */
export async function deleteAll(docs: IndexedDoc[]): Promise<{ trashed: { root: string; items: Trashed[] }[]; settle: () => void }> {
  const trashed: { root: string; items: Trashed[] }[] = [];
  const [gone, kept]: string[][] = [[], []];
  for (const { from, entries } of byFolder(docs)) {
    if (trashes(from.root)) {
      trashed.push({ root: from.root, items: await moveToTrash(from.root, from.dir, entries) });
      kept.push(...urisOf(entries));
    } else {
      await folders.delete(from.root, from.dir, entries);
      gone.push(...urisOf(entries));
    }
  }
  const library = useLibrary.getState();
  await library.forgetFiles(gone);
  for (const d of docs) {
    const rec = libraryDoc(d);
    if (rec) await library.remove(rec.id);
  }
  forget(docs.map((d) => d.key));
  return { trashed, settle: () => void library.forgetFiles(kept).catch(() => {}) };
}

/** Renames a file (in its folder; library documents linked to it follow). */
export async function renameDoc(d: IndexedDoc, name: string) {
  if (!inFolder(d)) return;
  const { root, dir, entry } = d.place;
  const to = await folders.rename(root, dir, entry, /\.(pdf|epub)$/i.test(name) ? name : `${name}${entry.name.match(/\.(pdf|epub)$/i)?.[0] ?? ''}`);
  if (to && entry.uri) await useLibrary.getState().followFiles([{ from: entry.uri, to }]);
  forget([d.key]);
}

/** Puts back what deleteAll moved to the trash. */
export async function undoDelete(trashed: { root: string; items: Trashed[] }[]) {
  for (const { root, items } of trashed) await restore(root, items);
}
