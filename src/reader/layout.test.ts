import { describe, expect, it } from 'vitest';

import { anchorAt, computeLayout, scrollForAnchor } from './layout';

const sizes = Array.from({ length: 5 }, () => ({ width: 600, height: 800 }));
const vp = { width: 400, height: 700, padTop: 60, padBottom: 80 };

describe('zooming about a point', () => {
  it('keeps the document point under the fingers', () => {
    const before = computeLayout(sizes, vp, 'width', 1);
    const after = computeLayout(sizes, vp, 'width', 2.5);
    const at = { x: 300, y: 500 };
    const a = anchorAt(before, vp.width, { x: 0, y: 1200 }, at);
    const s = scrollForAnchor(after, vp, a, at);
    // The same point, seen from the new scroll position, is the same place on the same page.
    const back = anchorAt(after, vp.width, s, at);
    expect(back.page).toBe(a.page);
    expect(back.u).toBeCloseTo(a.u, 2);
    expect(back.v).toBeCloseTo(a.v, 2);
    expect(s.x).toBeGreaterThan(0);
  });

  it('stays within the scroll range', () => {
    const l = computeLayout(sizes, vp, 'width', 1);
    // Zoomed out to fit: nothing to scroll across; at the top: not above it.
    expect(scrollForAnchor(l, vp, { page: 0, u: 0.1, v: 0 }, { x: 300, y: 600 })).toEqual({ x: 0, y: 0 });
    const end = scrollForAnchor(l, vp, { page: 4, u: 0.5, v: 1 }, { x: 0, y: 0 });
    expect(end.y).toBe(l.total - vp.height);
  });
});
