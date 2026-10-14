import type { IndexedDoc } from './search';

/**
 * Living with Syncthing: the conflict copies it makes when two devices changed a file, the same document
 * filed twice, and a trash for what is deleted from the archive (so a deletion that syncs everywhere can be
 * undone).
 */

/** "Rechnung.sync-conflict-20261013-213000-ABCDEF7.pdf" → the file it conflicts with, when and from which device. */
export type ConflictName = { original: string; at: string; device: string };

export function parseConflict(name: string): ConflictName | null {
  const m = /^(.*)\.sync-conflict-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([A-Z0-9]{7})(\.[^.]*)?$/.exec(name);
  if (!m) return null;
  return { original: `${m[1]}${m[9] ?? ''}`, at: `${m[2]}-${m[3]}-${m[4]} ${m[5]}:${m[6]}`, device: m[8] };
}

/** Files Syncthing is still writing (hidden or "~syncthing~" temporaries): not documents yet. */
export const syncTemporary = (name: string) => name.startsWith('.') || name.startsWith('~syncthing~');

/**
 * Documents in the archive with the same content, in groups of two or more (library copies, and copies
 * elsewhere on the device, aside: they are not the archive's to tidy).
 */
export function duplicates(docs: IndexedDoc[], archive: string | null): IndexedDoc[][] {
  const groups = new Map<string, IndexedDoc[]>();
  for (const d of docs) {
    if (!d.hash || d.place.kind !== 'folder' || d.place.root !== archive) continue;
    groups.set(d.hash, [...(groups.get(d.hash) ?? []), d]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.modified - b.modified));
}

/** What the trash remembers of a file: its name there, the folder it came from (an ID), and when. */
export type Trashed = { name: string; root: string; dir?: string; original: string; deletedAt: number };

/** Days a file stays in the trash. */
export const KEEP_DAYS = 30;

export function parseTrash(json: string): Trashed[] {
  try {
    const raw = JSON.parse(json) as { items?: unknown };
    return (Array.isArray(raw?.items) ? raw.items : []).filter(
      (t): t is Trashed => !!t && typeof t === 'object' && typeof (t as Trashed).name === 'string' && typeof (t as Trashed).root === 'string' && typeof (t as Trashed).deletedAt === 'number',
    ).map((t) => ({ name: t.name, root: t.root, dir: typeof t.dir === 'string' ? t.dir : undefined, original: typeof t.original === 'string' ? t.original : t.name, deletedAt: t.deletedAt }));
  } catch {
    return [];
  }
}

export const serializeTrash = (items: Trashed[]) => `${JSON.stringify({ version: 1, items }, null, 2)}\n`;

/** Items older than KEEP_DAYS, to delete for good. */
export const expired = (items: Trashed[], now = Date.now()) => items.filter((t) => now - t.deletedAt > KEEP_DAYS * 86_400_000);
