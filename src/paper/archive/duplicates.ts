import type { IndexedDoc } from './search';

/**
 * Documents there more than once. `identical`: the same file (same bytes); the one in the Tessel folder stays, else
 * the oldest. `versions`: the same document changed (its content key, docKey.ts, alike; the bytes not); the newest
 * stays. `freed`: bytes the others take up.
 */
export type DuplicateGroup = { kind: 'identical' | 'versions'; keep: IndexedDoc; others: IndexedDoc[]; freed: number };

export function duplicateGroups(docs: IndexedDoc[], inTessel: (d: IndexedDoc) => boolean): DuplicateGroup[] {
  const usable = docs.filter((d) => !d.failed && d.hash && !(d.place.kind === 'folder' && d.place.inbox));
  const out: DuplicateGroup[] = [];
  const handled = new Set<string>();
  const group = (kind: DuplicateGroup['kind'], keep: IndexedDoc, others: IndexedDoc[]) => {
    for (const d of others) handled.add(d.key);
    out.push({ kind, keep, others, freed: others.reduce((n, d) => n + d.size, 0) });
  };
  // Versions first: an older version's copies go with it (the kept one's copies are identical, below).
  const byShare = new Map<string, IndexedDoc[]>();
  for (const d of usable) if (d.share) byShare.set(d.share, [...(byShare.get(d.share) ?? []), d]);
  for (const list of byShare.values()) {
    if (new Set(list.map((d) => d.hash)).size < 2) continue;
    const keep = [...list].sort((a, b) => b.modified - a.modified)[0];
    group('versions', keep, list.filter((d) => d.hash !== keep.hash));
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
