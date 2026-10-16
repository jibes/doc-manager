import { describe, expect, it } from 'vitest';

import { duplicateGroups } from './duplicates';
import type { IndexedDoc } from './search';

const doc = (key: string, root: string, hash: string, share: string, modified: number, size = 1_000_000): IndexedDoc => ({
  key,
  place: { kind: 'folder', root, rootName: root, entry: { id: key, name: `${key}.pdf`, kind: 'pdf', size, modified } },
  name: `${key}.pdf`,
  size,
  modified,
  title: '',
  sender: '',
  type: '',
  tags: [],
  date: '',
  hash,
  share,
});
const tessel = (d: IndexedDoc) => d.place.kind === 'folder' && d.place.root === 'T';

describe('duplicates', () => {
  it('keeps the copy in the Tessel folder, else the oldest', () => {
    const [g] = duplicateGroups([doc('a', 'S', 'h1', 'k1', 1), doc('b', 'T', 'h1', 'k1', 5), doc('c', 'S', 'h1', 'k1', 3)], tessel);
    expect(g.kind).toBe('identical');
    expect(g.keep.key).toBe('b');
    expect(g.others.map((d) => d.key).sort()).toEqual(['a', 'c']);
    expect(g.freed).toBe(2_000_000);
    const [h] = duplicateGroups([doc('a', 'S', 'h1', 'k1', 4), doc('c', 'S', 'h1', 'k1', 3)], tessel);
    expect(h.keep.key).toBe('c');
  });

  it('keeps the newest version, and its copies are identical', () => {
    const groups = duplicateGroups([doc('old', 'T', 'h1', 'k1', 1, 500), doc('new', 'T', 'h2', 'k1', 9, 800), doc('copy', 'S', 'h2', 'k1', 2, 800)], tessel);
    const versions = groups.find((g) => g.kind === 'versions')!;
    expect(versions.keep.key).toBe('new');
    expect(versions.others.map((d) => d.key)).toEqual(['old']);
    expect(versions.freed).toBe(500);
    const identical = groups.find((g) => g.kind === 'identical')!;
    expect(identical.keep.key).toBe('new');
    expect(identical.others.map((d) => d.key)).toEqual(['copy']);
  });

  it('leaves the inbox, unreadable files and single documents alone', () => {
    const inbox = { ...doc('i', 'T', 'h1', 'k1', 1), place: { kind: 'folder' as const, root: 'T', rootName: 'T', entry: { id: 'i', name: 'i.pdf', kind: 'pdf' as const, size: 1, modified: 1 }, inbox: true } };
    expect(duplicateGroups([inbox, doc('a', 'T', 'h1', 'k1', 2), doc('b', 'T', 'h3', 'k3', 2), { ...doc('f', 'T', 'h3', 'k3', 2), failed: true }], tessel)).toEqual([]);
  });
});
