import { describe, expect, it } from 'vitest';

import { applyReading, pageLines } from '@/paper/scan/ai';
import { fromPixels, toPixels } from './improve';

describe('improving text', () => {
  const words = [
    { text: 'Rechnung', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } },
    { text: '4O217', box: { x: 0.32, y: 0.1, w: 0.1, h: 0.02 } },
    { text: 'Musterwerke', box: { x: 0.1, y: 0.2, w: 0.25, h: 0.02 } },
  ];
  const h = 1414;

  it('keeps boxes through the virtual pixels the reading is applied in', () => {
    const back = fromPixels(toPixels(words, h), h);
    back.forEach((w, i) => {
      expect(w.text).toBe(words[i].text);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(w.box[k]).toBeCloseTo(words[i].box[k], 6);
    });
  });

  it('puts a corrected line and added text over the page', () => {
    const px = toPixels(words, h);
    expect(pageLines(px, 0).map((l) => l.id)).toEqual(['1.1', '1.2']);
    const read = { lines: [{ id: '1.1', text: 'Rechnung 40217' }], added: [{ text: 'bezahlt', box: [500, 900, 700, 930] }] };
    const out = fromPixels(applyReading(px, 0, read, 1000, h), h);
    expect(out.map((w) => w.text)).toEqual(['Rechnung', '40217', 'Musterwerke', 'bezahlt']);
    expect(out[3].box.x).toBeCloseTo(0.5, 3);
    expect(out[3].box.y).toBeCloseTo(0.9, 3);
  });
});
