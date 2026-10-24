import type { Annotation, NormRect } from '@/core/engine/types';

export type Box = { left: number; top: number; width: number; height: number };

/** Highlight colours offered for a selection (PDF annotations store plain RGB). */
export const HIGHLIGHT_COLORS = [
  { key: 'yellow', hex: '#ffd54f' },
  { key: 'green', hex: '#a5d6a7' },
  { key: 'blue', hex: '#90caf9' },
  { key: 'pink', hex: '#f48fb1' },
] as const;

/**
 * Screen boxes of selected text on one page → one normalized rect per line: pieces sharing a line
 * merge, so a highlight is one clean band per line, as in other apps.
 */
export function lineRects(boxes: Box[], page: Box): NormRect[] {
  const rects = boxes
    .filter((b) => b.width > 0.5 && b.height > 0.5)
    .map((b) => ({ x: (b.left - page.left) / page.width, y: (b.top - page.top) / page.height, w: b.width / page.width, h: b.height / page.height }))
    .filter((r) => r.x + r.w > 0 && r.x < 1 && r.y + r.h > 0 && r.y < 1)
    .sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines: NormRect[] = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.y + r.h / 2 - (last.y + last.h / 2)) < Math.min(r.h, last.h) * 0.5) {
      const x0 = Math.min(last.x, r.x);
      const y0 = Math.min(last.y, r.y);
      last.w = Math.max(last.x + last.w, r.x + r.w) - x0;
      last.h = Math.max(last.y + last.h, r.y + r.h) - y0;
      last.x = x0;
      last.y = y0;
    } else lines.push({ ...r });
  }
  return lines;
}

/** Kinds whose colour Tessel changes: marks over text. */
export const RECOLORABLE = new Set<Annotation['kind']>(['highlight', 'underline', 'strikeout', 'squiggly']);

/** Kinds a click opens a menu for: marks over text and notes (not drawings or stamps, which fill their box). */
const CLICKABLE = new Set<Annotation['kind']>([...RECOLORABLE, 'note', 'freetext']);

/**
 * The annotation under a point on a page (0..1 across and down), the smallest where several overlap. A mark over
 * text counts on its lines only, not the ends of them its box also spans.
 */
export function markAt(list: Annotation[], page: number, at: { x: number; y: number }): Annotation | null {
  const slack = 0.004;
  const inside = (r: NormRect) => at.x >= r.x - slack && at.x <= r.x + r.w + slack && at.y >= r.y - slack && at.y <= r.y + r.h + slack;
  let best: Annotation | null = null;
  for (const a of list) {
    if (a.page !== page || !CLICKABLE.has(a.kind)) continue;
    if (!(a.lines?.length ? a.lines.some(inside) : inside(a.rect))) continue;
    if (!best || a.rect.w * a.rect.h < best.rect.w * best.rect.h) best = a;
  }
  return best;
}
