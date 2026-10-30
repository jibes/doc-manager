import { describe, expect, it } from 'vitest';

import { inWords, wording } from '@/paper/scan/ai';
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
  it('asks for the app’s language and the words in use, or starter types', () => {
    const used = wording({ types: [['Rechnung', 3]], tags: [['Steuer', 2]] }, 'de').join('\n');
    expect(used).toContain('in German');
    expect(used).toContain('Types already in use: Rechnung');
    expect(used).toContain('Keywords already in use: Steuer');
    const none = wording({ types: [], tags: [] }, 'en').join('\n');
    expect(none).toContain('Types to choose from: Invoice');
    expect(none).not.toContain('Keywords already in use');
  });

  it('matches the model’s type and keywords onto them', () => {
    const r = { title: 'x', date: '', sender: '', type: 'Rechnungen', keywords: ['steuern', 'Haus', 'Neu', 'Vier'] };
    const out = inWords(r, { types: [['Rechnung', 3]], tags: [['Steuer', 2]] }, 'de');
    expect(out.type).toBe('Rechnung');
    expect(out.keywords).toEqual(['Steuer', 'Haus', 'Neu']);
    expect(inWords({ ...r, type: 'invoices' }, { types: [], tags: [] }, 'en').type).toBe('Invoice');
  });
});
