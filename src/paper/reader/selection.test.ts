import { describe, expect, it } from 'vitest';

import type { Annotation } from '@/core/engine/types';
import { lineRects, markAt } from './selection';

describe('lineRects', () => {
  const page = { left: 100, top: 50, width: 500, height: 1000 };
  it('merges pieces of one line, keeps lines apart, drops empty boxes', () => {
    const out = lineRects(
      [
        { left: 150, top: 100, width: 100, height: 20 },
        { left: 252, top: 101, width: 80, height: 19 },
        { left: 150, top: 130, width: 200, height: 20 },
        { left: 400, top: 130, width: 0, height: 20 },
      ],
      page,
    );
    expect(out).toHaveLength(2);
    expect(out[0].x).toBeCloseTo(0.1);
    expect(out[0].w).toBeCloseTo(0.364);
    expect(out[0].y).toBeCloseTo(0.05);
    expect(out[1].y).toBeCloseTo(0.08);
  });
});

describe('markAt', () => {
  const a = (index: number, page: number, x: number, y: number, w: number, h: number): Annotation => ({ page, index, kind: 'highlight', rect: { x, y, w, h }, contents: '', author: '', quote: '' });
  it('finds the annotation under the point, the smallest of overlapping ones, on that page only', () => {
    const list = [a(0, 0, 0.1, 0.1, 0.5, 0.2), a(1, 0, 0.2, 0.15, 0.1, 0.02), a(2, 1, 0.1, 0.1, 0.5, 0.2)];
    expect(markAt(list, 0, { x: 0.25, y: 0.16 })?.index).toBe(1);
    expect(markAt(list, 0, { x: 0.5, y: 0.25 })?.index).toBe(0);
    expect(markAt(list, 0, { x: 0.9, y: 0.9 })).toBeNull();
    expect(markAt(list, 1, { x: 0.25, y: 0.16 })?.page).toBe(1);
  });
});
