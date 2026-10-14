import { describe, expect, it } from 'vitest';

import { createIndex, rank, snippetFor, type Indexable } from './search';

const doc = (key: string, over: Partial<Indexable>): Indexable => ({
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
  doc('energie', { title: 'Rechnung 40217', sender: 'Musterwerke Zürich', tags: ['Strom'], pages: ['Rechnung Nr. 40217', 'Zahlbar bis 01.11.2026. Konto CH93 0076 2011 6238 5295 7'] }),
  doc('korn', { title: 'Lieferschein NKL4471902', sender: 'Nordkorn Handels GmbH', pages: ['Bio Haferflocken 1 kg', 'Die Bestellung ist hiermit abgeschlossen.'] }),
  doc('wheel', { name: 'Scan 2026-10-03.pdf', pages: ['Velowerk Musterweg 1 8000 Zürich Total-EFT CHF: 96.00'] }),
];

describe('search across documents', () => {
  const index = createIndex();
  index.addAll(docs);
  const byKey = new Map(docs.map((d) => [d.key, d]));
  // As the search worker answers: the best documents, each with a snippet from its text.
  const searchIndex = (_i: unknown, docs: Map<string, Indexable>, q: string) =>
    rank(index, q).map((r) => ({ doc: docs.get(r.key)!, score: r.score, ...snippetFor(docs.get(r.key)!.pages, r.terms) }));
  const keys = (q: string) => searchIndex(index, byKey, q).map((h) => h.doc.key);

  it('finds text, details and file names', () => {
    expect(keys('Haferflocken')).toEqual(['korn']);
    expect(keys('strom')).toEqual(['energie']);
    expect(keys('Zürich')).toEqual(expect.arrayContaining(['energie', 'wheel']));
    expect(keys('2026-10-03')).toEqual(['wheel']);
  });

  it('matches prefixes and small typos, and needs every word', () => {
    expect(keys('Haferflock')).toEqual(['korn']);
    expect(keys('Bestelung')).toEqual(['korn']);
    expect(keys('Zürich Haferflocken')).toEqual([]);
  });

  it('keeps dates and numbers whole', () => {
    expect(keys('01.11.2026')).toEqual(['energie']);
    expect(keys('96.00')).toEqual(['wheel']);
  });

  it('ranks details above body text', () => {
    // "Rechnung" is the Musterwerke title; nothing else has it.
    expect(searchIndex(index, byKey, 'Musterwerke')[0].doc.key).toBe('energie');
  });

  it('points at the page with the match, with the words around it', () => {
    const [hit] = searchIndex(index, byKey, 'zahlbar');
    expect(hit.page).toBe(1);
    expect(hit.snippet).toEqual({ before: '', match: 'Zahlbar', after: ' bis 01.11.2026. Konto CH93 0076 2011 6238 5295 7' });
    expect(snippetFor(docs[1].pages, ['hiermit']).snippet?.match).toBe('hiermit');
    expect(snippetFor(docs[1].pages, ['nothing'])).toEqual({ page: 0, snippet: null });
  });

  it('ignores one-letter queries', () => {
    expect(keys('a')).toEqual([]);
  });
});
