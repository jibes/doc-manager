import { describe, expect, it } from 'vitest';

import { docDate, facetCounts, matches, parseViews, serializeViews, sortDocs, type SavedView } from './facets';
import type { IndexedDoc } from './search';

const doc = (key: string, over: Partial<IndexedDoc>): IndexedDoc => ({
  key,
  place: { kind: 'library', id: key },
  name: `${key}.pdf`,
  size: 1,
  modified: Date.UTC(2025, 5, 1),
  title: key,
  sender: '',
  type: '',
  tags: [],
  date: '',
  pages: [],
  ...over,
});

const docs = [
  doc('energie', { sender: 'Musterwerke Zürich', type: 'Rechnung', tags: ['Strom', 'Steuer'], date: '2026-10-02' }),
  doc('korn', { sender: 'Nordkorn', type: 'Lieferschein', tags: ['Steuer'], date: '2026-09-28' }),
  doc('wheel', { sender: 'Velowerk', type: 'rechnung', date: '2025-03-10' }),
  doc('old', { title: 'Zettel' }),
];

describe('filters', () => {
  it('uses the document date, else the file date', () => {
    expect(docDate(docs[0])).toBe('2026-10-02');
    expect(docDate(docs[3])).toBe('2025-06-01');
  });

  it('matches every chosen facet, ignoring case', () => {
    const keys = (f: Parameters<typeof matches>[1]) => docs.filter((d) => matches(d, f)).map((d) => d.key);
    expect(keys({ type: 'Rechnung' })).toEqual(['energie', 'wheel']);
    expect(keys({ tag: 'steuer', year: '2026' })).toEqual(['energie', 'korn']);
    expect(keys({ tag: 'Steuer', sender: 'Nordkorn' })).toEqual(['korn']);
    expect(keys({})).toHaveLength(4);
  });

  it('counts each facet within the other choices', () => {
    const all = facetCounts(docs, {});
    expect(all.type).toEqual([{ value: 'Rechnung', count: 2 }, { value: 'Lieferschein', count: 1 }]);
    expect(all.year).toEqual([{ value: '2026', count: 2 }, { value: '2025', count: 2 }]);
    expect(all.tag).toEqual([{ value: 'Steuer', count: 2 }, { value: 'Strom', count: 1 }]);
    // With a tag chosen, the other facets count only its documents; the tag facet itself still lists every tag.
    const steuer = facetCounts(docs, { tag: 'Steuer' });
    expect(steuer.sender.map((s) => s.value)).toEqual(['Musterwerke Zürich', 'Nordkorn']);
    expect(steuer.tag.map((s) => s.value)).toEqual(['Steuer', 'Strom']);
  });

  it('sorts newest first or by name', () => {
    expect(sortDocs(docs, 'date').map((d) => d.key)).toEqual(['energie', 'korn', 'old', 'wheel']);
    expect(sortDocs(docs, 'name').map((d) => d.key)).toEqual(['energie', 'korn', 'wheel', 'old']);
  });

  it('stores views as JSON and drops what it cannot read', () => {
    const views: SavedView[] = [{ id: 'v1', name: 'Steuer 2026', query: '', filter: { tag: 'Steuer', year: '2026' }, sort: 'date' }];
    expect(parseViews(serializeViews(views))).toEqual(views);
    expect(parseViews('{"views":[{"id":"x"},{"id":"y","name":"Y","filter":{"tag":3,"type":"Brief"},"sort":"weird"}]}')).toEqual([
      { id: 'y', name: 'Y', query: '', filter: { type: 'Brief' }, sort: 'date' },
    ]);
    expect(parseViews('not json')).toEqual([]);
  });
});
