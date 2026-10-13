import { describe, expect, it } from 'vitest';

import type { Details } from './pdfInfo';
import { applyRules, findDate, parseRules, pathFor, ruleMatches, serializeRules, type Rule } from './rules';

const none: Details = { title: '', sender: '', type: '', tags: [], date: '' };
const rule = (over: Partial<Rule>): Rule => ({ id: 'r', match: '', sender: '', type: '', tags: [], ...over });

describe('rules', () => {
  it('match all words of any alternative, ignoring case', () => {
    const text = 'KoRo Handels GmbH · Lieferschein VAH7663219';
    expect(ruleMatches(text, rule({ match: 'koro lieferschein' }))).toBe(true);
    expect(ruleMatches(text, rule({ match: 'koro rechnung' }))).toBe(false);
    expect(ruleMatches(text, rule({ match: 'Caritas, KoRo Handels' }))).toBe(true);
    expect(ruleMatches(text, rule({ match: ' , ' }))).toBe(false);
  });

  it('fill in what is missing and add tags', () => {
    const rules = [rule({ match: 'koro', sender: 'KoRo', type: 'Lieferschein', tags: ['Lebensmittel'] }), rule({ match: 'gmbh', sender: 'Other', tags: ['lebensmittel', 'Firma'] })];
    expect(applyRules('KoRo Handels GmbH', none, rules)).toEqual({ ...none, sender: 'KoRo', type: 'Lieferschein', tags: ['Lebensmittel', 'Firma'] });
    // A document's own details stay.
    expect(applyRules('KoRo', { ...none, sender: 'Mine', tags: ['x'] }, rules)).toEqual({ ...none, sender: 'Mine', type: 'Lieferschein', tags: ['x', 'Lebensmittel'] });
  });
});

describe('dates', () => {
  it('finds the first date in common forms', () => {
    expect(findDate('Rechnung vom 02.10.2026, zahlbar bis 01.11.2026')).toBe('2026-10-02');
    expect(findDate('Datum: 2.10.26')).toBe('2026-10-02');
    expect(findDate('Zürich, 28. September 2026')).toBe('2026-09-28');
    expect(findDate('Issued October 2, 2026')).toBe('2026-10-02');
    expect(findDate('2026-03-10 and 01.01.2020')).toBe('2026-03-10');
    expect(findDate('Total CHF 96.00, Tel. 044 123 45 67')).toBe('');
    expect(findDate('31.02.2026')).toBe('');
  });
});

describe('file paths', () => {
  const fallback = { title: 'Scan', date: '2026-01-05', sender: 'Unknown' };
  it('fills the template', () => {
    expect(pathFor('{year}/{sender}/{date} {title}', { ...none, title: 'Lieferschein', sender: 'KoRo', date: '2026-09-28' }, fallback)).toEqual(['2026', 'KoRo', '2026-09-28 Lieferschein.pdf']);
    expect(pathFor('{type}/{year}-{month} {title}', { ...none, title: 'A', type: 'Rechnung', date: '2025-03-10' }, fallback)).toEqual(['Rechnung', '2025-03 A.pdf']);
  });

  it('uses fallbacks, drops empty folders and stray separators', () => {
    expect(pathFor('{year}/{type}/{date} – {title}', none, fallback)).toEqual(['2026', '2026-01-05 – Scan.pdf']);
    expect(pathFor('{type}/{title} - {sender}', { ...none, title: 'X', sender: '' }, { ...fallback, sender: '' })).toEqual(['X.pdf']);
  });

  it('keeps names safe to sync', () => {
    expect(pathFor('{sender}/{title}', { ...none, sender: 'A/B: C', title: '..Re: "x"?.' }, fallback)).toEqual(['A B C', 'Re x.pdf']);
  });
});

describe('stored rules', () => {
  it('round-trip and drop what they cannot read', () => {
    const rules = { template: '{year}/{title}', rules: [rule({ id: 'a', match: 'koro', tags: ['x'] })] };
    expect(parseRules(serializeRules(rules))).toEqual(rules);
    expect(parseRules('{"rules":[{"id":"a"},{"id":"b","match":"m","tags":[1,"t"]}]}')).toEqual({ template: '{year}/{sender}/{date} {title}', rules: [rule({ id: 'b', match: 'm', tags: ['t'] })] });
    expect(parseRules('nope').rules).toEqual([]);
  });
});
