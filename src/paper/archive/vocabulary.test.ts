import { describe, expect, it } from 'vitest';

import { inWords, wording } from '@/paper/scan/ai';
import { defaultKinds, parseKinds, serializeKinds } from './kindList';
import { nameKey, snapName, snapTags, vocabularyOf } from './vocabulary';

describe('vocabulary', () => {
  it('takes case, accents, ß and plural endings as the same name', () => {
    expect(nameKey('Rechnungen')).toBe(nameKey('rechnung'));
    expect(nameKey('Ärzte')).toBe(nameKey('Arzt'));
    expect(nameKey('Steuern')).toBe(nameKey('Steuer'));
    expect(nameKey('Strasse')).toBe(nameKey('Straße'));
    expect(nameKey('Invoices')).toBe(nameKey('invoice'));
    expect(nameKey('Auto')).not.toBe(nameKey('Autor'));
  });

  it('writes a name as the archive does, a typo included, and leaves a new one as it is', () => {
    const known = ['Rechnung', 'Versicherung', 'Krankenkasse', 'Auto'];
    expect(snapName('rechnungen', known)).toBe('Rechnung');
    expect(snapName('Versicherrung', known)).toBe('Versicherung');
    expect(snapName('Krankenkase', known)).toBe('Krankenkasse');
    expect(snapName('Miete', known)).toBe('Miete');
    // Short words are compared exactly: "Auto" is no typo of "Akte".
    expect(snapName('Akte', known)).toBe('Akte');
  });

  it('keeps each tag once and at most three', () => {
    expect(snapTags(['steuer', 'Steuern', 'Haus', 'Auto', 'Bank'], ['Steuer'])).toEqual(['Steuer', 'Haus', 'Auto']);
  });

  it('counts names, the most used spelling standing for each', () => {
    const v = vocabularyOf([
      { type: 'Rechnung', tags: ['Steuer', 'Haus'] },
      { type: 'rechnung', tags: ['steuer'] },
      { type: 'Rechnung', tags: ['Steuer'] },
      { type: 'Brief', tags: [] },
    ]);
    expect(v.types).toEqual([['Rechnung', 3], ['Brief', 1]]);
    expect(v.tags).toEqual([['Steuer', 3], ['Haus', 1]]);
  });
});

describe('AI wording', () => {
  it('asks for one type from the list by its description, and topics as keywords, in the app’s language', () => {
    const used = wording({ types: [['Rechnung', 3]], tags: [['Steuer', 2]] }, 'de').join('\n');
    expect(used).toContain('in German');
    expect(used).toContain('- Rechnung: Fordert Geld');
    expect(used).toContain('If none fits, use "Sonstiges"');
    expect(used).toContain('Keywords already in use: Steuer.');
    expect(used).toContain('never a type of document, the sender');
    const none = wording({ types: [], tags: [] }, 'en').join('\n');
    expect(none).toContain('- Invoice: Asks for money');
    expect(none).not.toContain('Keywords already in use');
  });

  it('offers the listed tags first, or only them', () => {
    const kinds = { ...defaultKinds('en'), tags: [{ name: 'Health', about: 'Doctors, insurance' }], onlyTags: false };
    const prefer = wording({ types: [], tags: [['Health', 1], ['Car', 2]] }, 'en', kinds).join('\n');
    expect(prefer).toContain('Keywords to prefer, by their descriptions:\n- Health: Doctors, insurance');
    expect(prefer).toContain('Keywords already in use: Car.');
    const only = wording({ types: [], tags: [['Car', 2]] }, 'en', { ...kinds, onlyTags: true }).join('\n');
    expect(only).toContain('only from this list');
    expect(only).not.toContain('Car');
  });

  it('matches the model’s type onto the list (any other: the last one) and keeps types and the sender out of the keywords', () => {
    const r = { title: 'x', date: '', sender: 'Allianz', type: 'Rechnungen', keywords: ['steuern', 'Haus', 'Allianz', 'Vertrag', 'Neu'] };
    const out = inWords(r, { types: [['Rechnung', 3]], tags: [['Steuer', 2]] }, 'de');
    expect(out.type).toBe('Rechnung');
    expect(out.keywords).toEqual(['Steuer', 'Haus', 'Neu']);
    expect(inWords({ ...r, type: 'Versicherung' }, { types: [], tags: [] }, 'de').type).toBe('Sonstiges');
    expect(inWords({ ...r, type: 'invoices' }, { types: [], tags: [] }, 'en').type).toBe('Invoice');
    const only = { ...defaultKinds('de'), tags: [{ name: 'Gesundheit', about: '' }], onlyTags: true };
    expect(inWords({ ...r, keywords: ['gesundheit', 'Haus'] }, { types: [], tags: [['Haus', 4]] }, 'de', only).keywords).toEqual(['Gesundheit']);
  });
});

describe('types and tags list', () => {
  it('reads what was stored, without empty or repeated names; the defaults where it has no types', () => {
    const k = parseKinds(JSON.stringify({ types: [{ name: ' Rechnung ', about: 'Geld' }, { name: 'rechnung' }, { name: '' }], tags: [], onlyTags: true }), 'de');
    expect(k).toEqual({ types: [{ name: 'Rechnung', about: 'Geld' }], tags: [], onlyTags: false });
    expect(parseKinds('{}', 'en').types[0].name).toBe('Invoice');
    expect(parseKinds(serializeKinds(defaultKinds('de')), 'de')).toEqual(defaultKinds('de'));
  });
});
