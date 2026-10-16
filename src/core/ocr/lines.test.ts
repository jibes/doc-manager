import { describe, expect, it } from 'vitest';

import { ocrLines, type OcrBlock } from './lines';

const line = (text: string, y0: number, h: number, confidence = 90) => ({
  text: `${text}\n`,
  confidence,
  bbox: { x0: 100, y0, x1: 900, y1: y0 + h },
  rowAttributes: { rowHeight: h },
});

describe('ocrLines', () => {
  it('normalizes boxes, evens out sizes per paragraph, keeps headings apart and drops noise', () => {
    const blocks: OcrBlock[] = [
      { paragraphs: [{ lines: [line('Second Page', 100, 60), line('Body text runs on', 180, 30), line('and on here-', 220, 32), line('~~', 260, 30, 12)] }] },
    ];
    const out = ocrLines(blocks, 1000, 2000, 500);
    expect(out.map((l) => l.text)).toEqual(['Second Page', 'Body text runs on', 'and on here-']);
    expect(out[0].size).toBe(30);
    expect(out[1].size).toBe(out[2].size);
    expect(out[2].hyphen).toBe(true);
    expect(out[1].rect).toEqual({ x: 0.1, y: 0.09, w: 0.8, h: 0.015 });
  });
});
