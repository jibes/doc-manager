import { describe, expect, it } from 'vitest';

import type { TidyAnswer } from '@/paper/scan/ai';
import type { IndexedDoc } from './search';
import { changedBy, editFor, groupsFor, repeatsCount } from './tidy';

const doc = (type: string, tags: string[], sender = ''): IndexedDoc => ({ key: Math.random().toString(36), type, tags, sender, title: '', date: '' }) as unknown as IndexedDoc;

const docs = [
  doc('Rechnung', ['Steuer', 'Zahnarzt'], 'Dr. Muster'),
  doc('rechnung', ['steuern', 'Hausarzt']),
  doc('Invoice', ['Tax', 'Rechnung']),
  doc('Brief', ['Dr. Muster'], 'Dr. Muster'),
];

const answer: TidyAnswer = {
  tags: [
    { tag: 'Steuer', same: 'Steuer', broader: 'Finanzen' },
    { tag: 'Tax', same: 'Steuer', broader: 'Finanzen' },
    { tag: 'Zahnarzt', same: 'Zahnarzt', broader: 'Gesundheit' },
    { tag: 'Hausarzt', same: 'Hausarzt', broader: 'Gesundheit' },
  ],
  types: [{ type: 'Invoice', same: 'Rechnung' }],
};

describe('tidy', () => {
  it('makes spellings one without the model', () => {
    const g = groupsFor(docs, 'spelling', null);
    expect(g.map((x) => [x.kind, x.to, x.members.map((m) => m.name)])).toEqual([
      ['type', 'Rechnung', ['Rechnung', 'rechnung']],
      ['tag', 'Steuer', ['Steuer', 'steuern']],
    ]);
  });

  it('puts together what means the same, then broader topics', () => {
    const same = groupsFor(docs, 'same', answer);
    expect(same.find((g) => g.kind === 'type')?.members.map((m) => m.name)).toEqual(['Rechnung', 'Invoice']);
    expect(same.find((g) => g.kind === 'tag' && g.to === 'Steuer')?.members.map((m) => m.name)).toEqual(['Steuer', 'Tax']);
    const broader = groupsFor(docs, 'broader', answer);
    expect(broader.find((g) => g.to === 'Gesundheit')?.members.map((m) => m.name).sort()).toEqual(['Hausarzt', 'Zahnarzt']);
    expect(broader.find((g) => g.to === 'Finanzen')?.members.map((m) => m.name).sort()).toEqual(['Steuer', 'Tax']);
  });

  it('changes each document as the groups that are on say, spellings and repeats included', () => {
    const groups = groupsFor(docs, 'same', answer);
    const edit = editFor(groups, true);
    const one = (d: IndexedDoc) => edit({ title: '', date: '', sender: d.sender, type: d.type, tags: d.tags });
    expect(one(docs[1])).toMatchObject({ type: 'Rechnung', tags: ['Steuer', 'Hausarzt'] });
    // "Rechnung" repeated the type once it is "Rechnung"; the sender as a tag goes too.
    expect(one(docs[2])).toMatchObject({ type: 'Rechnung', tags: ['Steuer'] });
    expect(one(docs[3]).tags).toEqual([]);
    expect(repeatsCount(docs)).toBe(1); // the sender as a tag (the type repeated only once the types are made one)
    // A member switched off stays as it is.
    const off = groups.map((g) => (g.kind === 'tag' && g.to === 'Steuer' ? { ...g, members: g.members.map((m) => ({ ...m, on: m.name !== 'Tax' })) } : g));
    expect(editFor(off, false)({ title: '', date: '', sender: '', type: 'Invoice', tags: ['Tax'] }).tags).toEqual(['Tax']);
    expect(changedBy(docs, editFor([], false))).toHaveLength(0);
    expect(changedBy(docs, edit)).toHaveLength(3); // the first has nothing to change
  });
});
