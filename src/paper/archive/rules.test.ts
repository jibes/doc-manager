import { describe, expect, it } from 'vitest';

import type { Details } from './pdfInfo';
import { applyRules, findDate, parseRules, pathFor, ruleMatches, serializeRules, type Rule } from './rules';

const none: Details = { title: '', sender: '', type: '', tags: [], date: '' };
const rule = (over: Partial<Rule>): Rule => ({ id: 'r', match: '', sender: '', type: '', tags: [], ...over });

describe('rules', () => {
  it('match all words of any alternative, ignoring case', () => {
    const text = 'Nordkorn Handels GmbH · Lieferschein NKL4471902';
    expect(ruleMatches(text, rule({ match: 'nordkorn lieferschein' }))).toBe(true);
    expect(ruleMatches(text, rule({ match: 'nordkorn rechnung' }))).toBe(false);
    expect(ruleMatches(text, rule({ match: 'Musterwerke, Nordkorn Handels' }))).toBe(true);
    expect(ruleMatches(text, rule({ match: ' , ' }))).toBe(false);
  });

  it('match short words only at a word start, and ß as ss', () => {
    expect(ruleMatches('Kakaokekse 200 g', rule({ match: 'AOK' }))).toBe(false);
    expect(ruleMatches('Ihre AOK Bayern', rule({ match: 'aok' }))).toBe(true);
    expect(ruleMatches('HAUPTSTRASSE 5, Zürich', rule({ match: 'Hauptstraße' }))).toBe(true);
    // Longer words may end a compound.
    expect(ruleMatches('Ihre Stromrechnung', rule({ match: 'rechnung' }))).toBe(true);
  });

  it('fill in what is missing and add tags', () => {
    const rules = [rule({ match: 'korn', sender: 'Nordkorn', type: 'Lieferschein', tags: ['Lebensmittel'] }), rule({ match: 'gmbh', sender: 'Other', tags: ['lebensmittel', 'Firma'] })];
    expect(applyRules('Nordkorn Handels GmbH', none, rules)).toEqual({ ...none, sender: 'Nordkorn', type: 'Lieferschein', tags: ['Lebensmittel', 'Firma'] });
    // A document's own details stay.
    expect(applyRules('Nordkorn', { ...none, sender: 'Mine', tags: ['x'] }, rules)).toEqual({ ...none, sender: 'Mine', type: 'Lieferschein', tags: ['x', 'Lebensmittel'] });
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

  it('reads dates written without spaces, with slashes, or as an AI may give them', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(findDate('Zürich, 3.Oktober 2026', now)).toBe('2026-10-03');
    expect(findDate('Bern, den 3.Okt.2026', now)).toBe('2026-10-03');
    expect(findDate('Invoice date 03/10/2026', now)).toBe('2026-10-03');
    expect(findDate('Datum 03. 10. 2026', now)).toBe('2026-10-03');
    expect(findDate('2026-10-03T00:00:00Z', now)).toBe('2026-10-03');
    expect(findDate('2026-10-3', now)).toBe('2026-10-03');
    expect(findDate('Seite 1/2 von 3', now)).toBe('');
  });

  it('puts two-digit years in the right century, skips birthdays and far-off dates', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    expect(findDate('geb. 03.04.67, Rechnung vom 02.10.26', now)).toBe('2026-10-02');
    expect(findDate('Vertrag vom 15.09.98', now)).toBe('1998-09-15');
    expect(findDate('Gültig bis 01.01.2031, ausgestellt 12.10.2026', now)).toBe('2026-10-12');
    // Version and section numbers before the date aren't dates.
    expect(findDate('Version 1.2.34 vom 02.10.2026', now)).toBe('2026-10-02');
    expect(findDate('Release 2.1.19, Stand 3.10.2026', now)).toBe('2026-10-03');
    expect(findDate('Abschnitt 4.5.6.12 – 02.10.26', now)).toBe('2026-10-02');
  });
});

describe('file paths', () => {
  const fallback = { title: 'Scan', date: '2026-01-05', sender: 'Unknown' };
  it('fills the template: a file name only', () => {
    expect(pathFor('{date} {sender} {title}', { ...none, title: 'Lieferschein', sender: 'Nordkorn', date: '2026-09-28' }, fallback)).toEqual(['2026-09-28 Nordkorn Lieferschein.pdf']);
    expect(pathFor('{type} {year}-{month} {title}', { ...none, title: 'A', type: 'Rechnung', date: '2025-03-10' }, fallback)).toEqual(['Rechnung 2025-03 A.pdf']);
  });

  it('makes no folders: the old default is the new one, a "/" is a space', () => {
    expect(pathFor('{year}/{sender}/{date} {title}', { ...none, title: 'Lieferschein', sender: 'Nordkorn', date: '2026-09-28' }, fallback)).toEqual(['2026-09-28 Nordkorn Lieferschein.pdf']);
    expect(pathFor('{type}/{title}', { ...none, title: 'A', type: 'Rechnung' }, fallback)).toEqual(['Rechnung A.pdf']);
  });

  it('uses fallbacks and drops stray separators', () => {
    expect(pathFor('{date} – {type} – {title}', none, fallback)).toEqual(['2026-01-05 – Scan.pdf']);
    expect(pathFor('{title} - {sender}', { ...none, title: 'X', sender: '' }, { ...fallback, sender: '' })).toEqual(['X.pdf']);
    expect(pathFor('{sender} - {type} - {title}', { ...none, title: 'Rechnung', sender: 'Telekom' }, fallback)).toEqual(['Telekom - Rechnung.pdf']);
    expect(pathFor('{date}_{type}_{title}', { ...none, title: 'Rechnung', date: '2026-10-02' }, fallback)).toEqual(['2026-10-02_Rechnung.pdf']);
    expect(pathFor('{type}', { ...none, date: '2026-10-02' }, fallback)).toEqual(['Scan.pdf']);
  });

  it('keeps names safe to sync', () => {
    expect(pathFor('{title} {sender}', { ...none, sender: 'A/B: C', title: '..Re: "x"?.' }, fallback)).toEqual(['Re x . A B C.pdf']);
  });
});

describe('stored rules', () => {
  it('round-trip and drop what they cannot read', () => {
    const rules = { template: '{year} {title}', rules: [rule({ id: 'a', match: 'korn', tags: ['x'] })] };
    expect(parseRules(serializeRules(rules))).toEqual(rules);
    expect(parseRules('{"rules":[{"id":"a"},{"id":"b","match":"m","tags":[1,"t"]}]}')).toEqual({ template: '{date} {sender} {title}', rules: [rule({ id: 'b', match: 'm', tags: ['t'] })] });
    expect(parseRules('nope').rules).toEqual([]);
  });
});
