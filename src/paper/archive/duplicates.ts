import { startsWith } from '@/core/lib/bytes';
import type { IndexedDoc } from './search';

/**
 * Documents there more than once. `identical`: the same file (same bytes); the one in the Tessel folder stays, else
 * the oldest. `versions`: the same document changed (its content key, docKey.ts, alike; the bytes not), where the
 * newer one is known to continue the older (`isVersion`); the newest stays. `freed`: bytes the others take up.
 */
export type DuplicateGroup = { kind: 'identical' | 'versions'; keep: IndexedDoc; others: IndexedDoc[]; freed: number };

/** Whether `newer` is `older` changed: its bytes start with all of older's (edits are appended). */
export type IsVersion = (older: IndexedDoc, newer: IndexedDoc) => boolean;

/** Usable for groups: read, with a hash, not waiting in the inbox. */
const usableDocs = (docs: IndexedDoc[]) => docs.filter((d) => !d.failed && d.hash && !(d.place.kind === 'folder' && d.place.inbox));

/**
 * Per content key with differing bytes: the newest, and the others that could be older versions of it. Only
 * strictly smaller ones: two filled-in copies of one form share the key, and neither continues the other.
 */
function versionCandidates(usable: IndexedDoc[]): { keep: IndexedDoc; older: IndexedDoc[] }[] {
  const byShare = new Map<string, IndexedDoc[]>();
  for (const d of usable) if (d.share) byShare.set(d.share, [...(byShare.get(d.share) ?? []), d]);
  const out: { keep: IndexedDoc; older: IndexedDoc[] }[] = [];
  for (const list of byShare.values()) {
    if (new Set(list.map((d) => d.hash)).size < 2) continue;
    const keep = [...list].sort((a, b) => b.modified - a.modified)[0];
    const older = list.filter((d) => d.hash !== keep.hash && d.size < keep.size);
    if (older.length) out.push({ keep, older });
  }
  return out;
}

/**
 * Without `isVersion` no versions are offered: the index can't tell a changed document from another copy of the
 * same form filled in differently, and offering that to delete would lose it (identical files still group).
 */
export function duplicateGroups(docs: IndexedDoc[], inTessel: (d: IndexedDoc) => boolean, isVersion: IsVersion = () => false): DuplicateGroup[] {
  const usable = usableDocs(docs);
  const out: DuplicateGroup[] = [];
  const handled = new Set<string>();
  const group = (kind: DuplicateGroup['kind'], keep: IndexedDoc, others: IndexedDoc[]) => {
    for (const d of others) handled.add(d.key);
    out.push({ kind, keep, others, freed: others.reduce((n, d) => n + d.size, 0) });
  };
  // Versions first: an older version's copies go with it (the kept one's copies are identical, below).
  for (const { keep, older } of versionCandidates(usable)) {
    const others = older.filter((d) => isVersion(d, keep));
    if (others.length) group('versions', keep, others);
  }
  const byHash = new Map<string, IndexedDoc[]>();
  for (const d of usable) if (!handled.has(d.key)) byHash.set(d.hash!, [...(byHash.get(d.hash!) ?? []), d]);
  for (const list of byHash.values()) {
    if (list.length < 2) continue;
    const oldest = (xs: IndexedDoc[]) => [...xs].sort((a, b) => a.modified - b.modified)[0];
    const tessel = list.filter(inTessel);
    const keep = oldest(tessel.length ? tessel : list);
    group('identical', keep, list.filter((d) => d !== keep));
  }
  return out.sort((a, b) => b.freed - a.freed);
}

/**
 * Looks at the files to tell versions apart: an `isVersion` for duplicateGroups that is true only where the newer
 * file starts with the older one's bytes. `read`: a document's bytes, null when it can't be read (then no version).
 */
export async function checkVersions(docs: IndexedDoc[], read: (d: IndexedDoc) => Promise<ArrayBuffer | null>): Promise<IsVersion> {
  const pairs = new Set<string>();
  const pair = (older: IndexedDoc, newer: IndexedDoc) => `${older.hash}>${newer.hash}`;
  for (const { keep, older } of versionCandidates(usableDocs(docs))) {
    const whole = await read(keep).catch(() => null);
    if (!whole) continue;
    // One read per distinct older file (its copies have the same bytes).
    const seen = new Set<string>();
    for (const d of older) {
      if (seen.has(d.hash!)) continue;
      seen.add(d.hash!);
      const head = await read(d).catch(() => null);
      if (head && startsWith(whole, head)) pairs.add(pair(d, keep));
    }
  }
  return (older, newer) => pairs.has(pair(older, newer));
}
