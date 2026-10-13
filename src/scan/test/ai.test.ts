import { describe, expect, it } from 'vitest';

import { aiTitle, applyReading, pageLines, parseResult, prompt, spread, type AiResult } from '../ai';

const w = (text: string, x0: number, y0: number, x1: number, y1: number) => ({ text, x0, y0, x1, y1 });

describe('AI reading', () => {
  const words = [w('Zahlbar', 0, 0, 70, 20), w('bis:', 74, 1, 100, 21), w('Wahrung', 0, 40, 80, 60), w('CHF', 0, 80, 30, 100), w('20.00', 40, 80, 90, 100)];

  it('groups the words into lines with ids, as sent', () => {
    expect(pageLines(words, 1).map((l) => [l.id, l.words.map((x) => x.text).join(' ')])).toEqual([
      ['2.1', 'Zahlbar bis:'],
      ['2.2', 'Wahrung'],
      ['2.3', 'CHF 20.00'],
    ]);
    expect(prompt([{ jpeg: new Blob(), lines: [{ id: '1.1', text: 'Zahlbar bis:' }] }])).toContain('1.1\tZahlbar bis:');
  });

  it('puts the corrected text in place, drops what is not text, and places what was added', () => {
    const reading: AiResult['pages'][number] = {
      lines: [
        { id: '1.2', text: 'Währung' },
        { id: '1.3', text: '' },
      ],
      added: [{ text: 'bez zum 30.10.2026', box: [500, 900, 900, 950] }],
    };
    const out = applyReading(words, 0, reading, 1000, 1000);
    expect(out.map((x) => x.text)).toEqual(['Zahlbar', 'bis:', 'Währung', 'bez', 'zum', '30.10.2026']);
    // Same word count: the word keeps its own box.
    expect(out[2]).toMatchObject({ x0: 0, x1: 80, y0: 40 });
    // Added text spread over its box, in page pixels.
    expect(out[3].x0).toBe(500);
    expect(out[5].x1).toBeCloseTo(900);
    expect(out[3].y0).toBe(900);
  });

  it('spreads a corrected line with a different word count over the line', () => {
    const out = spread('Zahlbar bis', { x0: 0, y0: 0, x1: 110, y1: 20 });
    expect(out.map((x) => [x.text, x.x0, x.x1])).toEqual([
      ['Zahlbar', 0, 70],
      ['bis', 80, 110],
    ]);
  });

  it('reads the JSON out of a wrapped reply and keeps only what is well formed', () => {
    const reply = 'Here you go:\n```json\n{"title":"Rechnung 61106","date":"02.10.2026","sender":"Caritas Zürich","type":"Rechnung","keywords":["KulturLegi",3],"pages":[{"lines":[{"id":"1.1","text":"x"},{"id":2}],"added":[{"text":"bez","box":[1,2,3]}]}]}\n```';
    const r = parseResult(reply, 2);
    expect(r.title).toBe('Rechnung 61106');
    expect(r.date).toBe(''); // not YYYY-MM-DD
    expect(r.keywords).toEqual(['KulturLegi']);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0].lines).toEqual([{ id: '1.1', text: 'x' }]);
    expect(r.pages[0].added).toEqual([]);
    expect(r.pages[1]).toEqual({ lines: [], added: [] });
    expect(() => parseResult('no json', 1)).toThrow();
  });

  it('names the file by date, sender and title', () => {
    const r = { title: 'Rechnung 61106', date: '2026-10-02', sender: 'Caritas Zürich', type: 'Rechnung', keywords: [], pages: [] };
    expect(aiTitle(r)).toBe('2026-10-02 Caritas Zürich – Rechnung 61106');
    expect(aiTitle({ ...r, title: 'Caritas Zürich Rechnung' })).toBe('2026-10-02 Caritas Zürich Rechnung');
    expect(aiTitle({ ...r, date: '', sender: '', title: '' })).toBe('Rechnung');
  });
});
