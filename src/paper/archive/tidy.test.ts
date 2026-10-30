import { describe, expect, it } from 'vitest';

import type { Details } from './pdfInfo';
import type { IndexedDoc } from './search';
import { changedBy, directCoverage, editFor, namesOf, repeatsCount, resultCounts, spellingFixes, suggestedCategories, type Destination, type Plan } from './tidy';

const doc = (type: string, tags: string[], sender = ''): IndexedDoc => ({ key: Math.random().toString(36), type, tags, sender, title: '', date: '' }) as unknown as IndexedDoc;
const details = (d: IndexedDoc): Details => ({ title: '', date: '', sender: d.sender, type: d.type, tags: d.tags });

const docs = [
  doc('Rechnung', ['Gesundheit', 'Zahnarzt'], 'Dr. Muster'),
  doc('rechnung', ['gesundheit', 'Hausarzt']),
  doc('Brief', ['Zurich', 'Versicherung']),
  doc('Brief', ['Dr. Muster', 'Steuer'], 'Dr. Muster'),
];
const plan = (over: Partial<Plan>): Plan => ({ kind: 'tag', cleanup: true, categories: [], destinations: new Map(), companies: new Set(), ...over });

describe('tidy', () => {
  it('lists the names in use, spellings together, and counts what part 1 cleans up', () => {
    expect(namesOf(docs, 'tag').map((n) => [n.name, n.count])).toEqual([['Gesundheit', 2], ['Dr. Muster', 1], ['Hausarzt', 1], ['Steuer', 1], ['Versicherung', 1], ['Zahnarzt', 1], ['Zurich', 1]]);
    expect(spellingFixes(docs, 'tag')).toBe(1);
    expect(spellingFixes(docs, 'type')).toBe(1);
    expect(repeatsCount(docs)).toBe(1);
  });

  it('starts from the model’s categories, else the most used until nearly every document has one', () => {
    const names = namesOf(docs, 'tag');
    expect(suggestedCategories(docs, names, 'tag', ['Gesundheit', 'Finanzen'])).toEqual(['Gesundheit', 'Finanzen']);
    expect(suggestedCategories(docs, names, 'tag', null, 3)).toEqual(['Gesundheit', 'Dr. Muster', 'Hausarzt']);
    expect(directCoverage(docs, ['Gesundheit', 'Versicherung'], 'tag')).toBe(3);
  });

  it('changes each document: spellings, repeats and company names first, then the categories and destinations', () => {
    const names = namesOf(docs, 'tag');
    const dest = new Map<string, Destination>([
      ['zahnarzt', { to: 'category', category: 'Gesundheit' }],
      ['hausarzt', { to: 'category', category: 'Gesundheit' }],
      ['steuer', { to: 'remove' }],
    ]);
    const edit = editFor(plan({ categories: ['Gesundheit', 'Versicherung'], destinations: dest, companies: new Set(['zurich']) }), names);
    expect(edit(details(docs[0]))).toMatchObject({ tags: ['Gesundheit'] });
    expect(edit(details(docs[1]))).toMatchObject({ tags: ['Gesundheit'] });
    // A company's name goes to the sender where there is none.
    expect(edit(details(docs[2]))).toMatchObject({ sender: 'Zurich', tags: ['Versicherung'] });
    // The sender repeated as a tag goes; a removed tag goes.
    expect(edit(details(docs[3])).tags).toEqual([]);
    expect(changedBy(docs, edit)).toHaveLength(4);
    expect(resultCounts(docs, edit, 'tag')).toEqual([['Gesundheit', 2], ['Versicherung', 1]]);
    // Without clean-up, the spellings, repeats and companies stay.
    const plain = editFor(plan({ cleanup: false, categories: ['Gesundheit'] }), names);
    expect(plain(details(docs[3])).tags).toEqual(['Dr. Muster', 'Steuer']);
  });

  it('works on types the same way', () => {
    const names = namesOf(docs, 'type');
    const edit = editFor(plan({ kind: 'type', categories: ['Rechnung'], destinations: new Map([['brief', { to: 'category', category: 'Rechnung' }]]) }), names);
    expect(docs.map((d) => edit(details(d)).type)).toEqual(['Rechnung', 'Rechnung', 'Rechnung', 'Rechnung']);
  });
});
