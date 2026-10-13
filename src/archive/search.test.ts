import { describe, expect, it } from 'vitest';

import { createIndex, searchIndex, snippetFor, type IndexedDoc } from './search';

const doc = (key: string, over: Partial<IndexedDoc>): IndexedDoc => ({
  key,
  place: { kind: 'library', id: key },
  name: `${key}.pdf`,
  size: 1,
  modified: 1,
  title: '',
  sender: '',
  type: '',
  tags: [],
  date: '',
  pages: [],
  ...over,
});

const docs = [
  doc('caritas', { title: 'Rechnung 61106', sender: 'Caritas Zürich', tags: ['KulturLegi'], pages: ['Rechnung Nr. 61106', 'Zahlbar bis 01.11.2026. Konto CH60 3000 0001 8890 6477 9'] }),
  doc('koro', { title: 'Lieferschein VAH7663219', sender: 'KoRo Handels GmbH', pages: ['Geschälte Bio Hanfsamen 1 kg', 'Die Bestellung ist hiermit abgeschlossen.'] }),
  doc('wheel', { name: 'Scan 2026-10-03.pdf', pages: ['Wheel House Bertastrasse 18 8003 Zürich Total-EFT CHF: 96.00'] }),
];

describe('search across documents', () => {
  const index = createIndex();
  index.addAll(docs);
  const byKey = new Map(docs.map((d) => [d.key, d]));
  const keys = (q: string) => searchIndex(index, byKey, q).map((h) => h.doc.key);

  it('finds text, details and file names', () => {
    expect(keys('Hanfsamen')).toEqual(['koro']);
    expect(keys('kulturlegi')).toEqual(['caritas']);
    expect(keys('Zürich')).toEqual(expect.arrayContaining(['caritas', 'wheel']));
    expect(keys('2026-10-03')).toEqual(['wheel']);
  });

  it('matches prefixes and small typos, and needs every word', () => {
    expect(keys('Hanfsam')).toEqual(['koro']);
    expect(keys('Bestelung')).toEqual(['koro']);
    expect(keys('Zürich Hanfsamen')).toEqual([]);
  });

  it('keeps dates and numbers whole', () => {
    expect(keys('01.11.2026')).toEqual(['caritas']);
    expect(keys('96.00')).toEqual(['wheel']);
  });

  it('ranks details above body text', () => {
    // "Rechnung" is the Caritas title; nothing else has it.
    expect(searchIndex(index, byKey, 'Caritas')[0].doc.key).toBe('caritas');
  });

  it('points at the page with the match, with the words around it', () => {
    const [hit] = searchIndex(index, byKey, 'zahlbar');
    expect(hit.page).toBe(1);
    expect(hit.snippet).toEqual({ before: '', match: 'Zahlbar', after: ' bis 01.11.2026. Konto CH60 3000 0001 8890 6477 9' });
    expect(snippetFor(docs[1], ['hiermit']).snippet?.match).toBe('hiermit');
    expect(snippetFor(docs[1], ['nothing'])).toEqual({ page: 0, snippet: null });
  });

  it('ignores one-letter queries', () => {
    expect(keys('a')).toEqual([]);
  });
});
