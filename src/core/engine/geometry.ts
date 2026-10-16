import type { Graphic, NormRect } from './types';

const union = (a: NormRect, b: NormRect): NormRect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Rects closer than `gap` (or overlapping) on both axes. */
export const near = (a: NormRect, b: NormRect, gap: number) =>
  a.x <= b.x + b.w + gap && b.x <= a.x + a.w + gap && a.y <= b.y + b.h + gap && b.y <= a.y + a.h + gap;

/**
 * Clusters drawing objects into regions: chart = axes + bars + markers, photo = one image.
 * Repeats until stable, since a union can bring new neighbours into reach. O(n²) per pass; callers cap n.
 */
export function mergeGraphics(items: Graphic[], gap = 0.012): Graphic[] {
  let cur = items.map((g) => ({ ...g, rect: { ...g.rect } }));
  for (let changed = true; changed; ) {
    changed = false;
    const out: Graphic[] = [];
    for (const g of cur) {
      const hit = out.find((o) => near(o.rect, g.rect, gap));
      if (hit) {
        hit.rect = union(hit.rect, g.rect);
        hit.image ||= g.image;
        hit.parts += g.parts;
        changed = true;
      } else out.push(g);
    }
    cur = out;
  }
  return cur;
}

/** Bounding box of many rects (null when empty). */
export function bounds(rects: NormRect[]): NormRect | null {
  return rects.length ? rects.reduce(union) : null;
}
