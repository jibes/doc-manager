import { describe, expect, it } from 'vitest';

import type { IndexedDoc } from './search';
import { conflictTime, duplicates, expired, parseConflict, parseTrash, serializeTrash, syncTemporary, type Trashed } from './sync';

const doc = (key: string, over: Partial<IndexedDoc>): IndexedDoc => ({
  key,
  place: { kind: 'folder', root: 'r', rootName: 'Archive', entry: { id: key, name: `${key}.pdf`, kind: 'pdf', size: 1, modified: 0 } },
  name: `${key}.pdf`,
  size: 1,
  modified: 0,
  title: '',
  sender: '',
  type: '',
  tags: [],
  date: '',
  ...over,
});

describe('sync conflicts', () => {
  it('are recognised by Syncthing’s naming', () => {
    expect(parseConflict('Rechnung 40217.sync-conflict-20261013-213005-ABCDEF7.pdf')).toEqual({ original: 'Rechnung 40217.pdf', at: '2026-10-13 21:30', device: 'ABCDEF7' });
    expect(parseConflict('notes.sync-conflict-20260101-000000-ZZZZZZZ')).toEqual({ original: 'notes', at: '2026-01-01 00:00', device: 'ZZZZZZZ' });
    expect(parseConflict('Rechnung.pdf')).toBeNull();
    expect(parseConflict('x.sync-conflict-2026.pdf')).toBeNull();
  });

  it('say when they were made, as a time to show', () => {
    expect(conflictTime('2026-10-13 21:30')).toBe(new Date(2026, 9, 13, 21, 30).getTime());
    expect(conflictTime('soon')).toBeNaN();
  });

  it('temporaries are left alone', () => {
    expect(syncTemporary('.syncthing.Rechnung.pdf.tmp')).toBe(true);
    expect(syncTemporary('~syncthing~Rechnung.pdf.tmp')).toBe(true);
    expect(syncTemporary('Rechnung.pdf')).toBe(false);
  });
});

describe('duplicates', () => {
  it('group archive documents with the same content, oldest first', () => {
    const elsewhere = doc('e', { hash: 'h1' });
    const other = { ...elsewhere, place: { ...(elsewhere.place as Extract<IndexedDoc['place'], { kind: 'folder' }>), root: 'other' } };
    const groups = duplicates([doc('a', { hash: 'h1', modified: 5 }), doc('b', { hash: 'h2' }), doc('c', { hash: 'h1', modified: 1 }), doc('lib', { hash: 'h2', place: { kind: 'library', id: 'x' } }), doc('d', {}), other], 'r');
    expect(groups.map((g) => g.map((d) => d.key))).toEqual([['c', 'a']]);
    expect(duplicates([doc('a', { hash: 'h1' }), doc('c', { hash: 'h1' })], null)).toEqual([]);
  });
});

describe('trash', () => {
  it('round-trips and expires after 30 days', () => {
    const now = Date.UTC(2026, 9, 13);
    const items: Trashed[] = [
      { name: 'a.pdf', root: 'r', dir: '2026/Nordkorn', original: 'a.pdf', deletedAt: now - 31 * 86_400_000 },
      { name: 'b (2).pdf', root: 'r', original: 'b.pdf', deletedAt: now - 86_400_000, title: 'Rechnung 40217' },
    ];
    expect(parseTrash(serializeTrash(items))).toEqual(items);
    expect(expired(items, now).map((t) => t.name)).toEqual(['a.pdf']);
    expect(parseTrash('{"items":[{"name":1},{"name":"x","root":"r","deletedAt":1}]}')).toEqual([{ name: 'x', root: 'r', dir: undefined, original: 'x', deletedAt: 1 }]);
  });
});
