import { describe, expect, it } from 'vitest';

import { lineRects } from './selection';

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
