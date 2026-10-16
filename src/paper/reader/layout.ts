import type { Size } from '@/core/engine/types';
import type { FitMode } from '@/paper/state/prefs';

export type PageLayout = {
  widths: number[];
  heights: number[];
  /** Top of each page (incl. leading padding). */
  offsets: number[];
  total: number;
  gap: number;
  padTop: number;
  /** Widest page; drives horizontal scroll when zoomed. */
  maxWidth: number;
  /** Side margin around pages. */
  gutter: number;
};

export type Viewport = { width: number; height: number; padTop: number; padBottom: number };

/** Comfortable reading column on large screens; zoom goes past it. */
const MAX_COLUMN = 920;

export function computeLayout(sizes: Size[], vp: Viewport, fit: FitMode, zoom: number): PageLayout {
  const compact = vp.width < 600;
  const gap = compact ? 10 : 20;
  const gutter = compact ? 6 : 32;
  const column = Math.min(vp.width - gutter * 2, MAX_COLUMN);
  const fitH = Math.max(200, vp.height - vp.padTop - vp.padBottom - gap * 2);

  const widths: number[] = [];
  const heights: number[] = [];
  const offsets: number[] = [];
  let y = vp.padTop + gap;
  let maxWidth = 0;
  for (const s of sizes) {
    const base = fit === 'page' ? Math.min(column, (fitH * s.width) / s.height) : column;
    const w = Math.round(base * zoom);
    const h = Math.round((w * s.height) / s.width);
    widths.push(w);
    heights.push(h);
    offsets.push(y);
    y += h + gap;
    maxWidth = Math.max(maxWidth, w);
  }
  return { widths, heights, offsets, total: y + vp.padBottom, gap, padTop: vp.padTop, maxWidth, gutter };
}

/** Page whose band contains the given y (binary search). */
export function pageAt(l: PageLayout, y: number): number {
  let lo = 0;
  let hi = l.offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Scroll band owned by a page: from the gap above it to the gap above the next (page 0 owns the top padding). */
function band(l: PageLayout, i: number) {
  const start = i === 0 ? 0 : l.offsets[i] - l.gap;
  const end = i + 1 < l.offsets.length ? l.offsets[i + 1] - l.gap : l.total;
  return { start, len: Math.max(1, end - start) };
}

/** Scroll y → { page, offset 0..1 } of the band at the top edge. Inverse of scrollYFor. */
export function positionAt(l: PageLayout, scrollY: number) {
  const page = pageAt(l, scrollY + l.gap);
  const b = band(l, page);
  return { page, offset: Math.min(1, Math.max(0, (scrollY - b.start) / b.len)) };
}

/** Page under the reading line (~1/3 down the viewport) — what the reader "is on". */
export function readingPage(l: PageLayout, scrollY: number, viewportH: number) {
  return pageAt(l, scrollY + Math.min(viewportH * 0.33, 260));
}

export function scrollYFor(l: PageLayout, page: number, offset = 0): number {
  const b = band(l, Math.min(Math.max(0, page), l.offsets.length - 1));
  return b.start + offset * b.len;
}

/** Scrolled content width: the viewport, or the widest page and its margins when zoomed past it. */
export const contentWidth = (l: PageLayout, viewportW: number) => Math.max(viewportW, l.maxWidth + l.gutter * 2);

/** A point of the document: a page and where on it (0..1 across and down; outside in the margins and gaps). */
export type Anchor = { page: number; u: number; v: number };

/** The document point under a viewport point, at a scroll position. Pages are centred across the content. */
export function anchorAt(l: PageLayout, viewportW: number, scroll: { x: number; y: number }, at: { x: number; y: number }): Anchor {
  const y = scroll.y + at.y;
  const page = pageAt(l, y);
  const left = (contentWidth(l, viewportW) - l.widths[page]) / 2;
  return { page, u: (scroll.x + at.x - left) / l.widths[page], v: (y - l.offsets[page]) / l.heights[page] };
}

/** The scroll position that puts a document point under a viewport point (inverse of anchorAt, within the scroll range). */
export function scrollForAnchor(l: PageLayout, viewport: { width: number; height: number }, a: Anchor, at: { x: number; y: number }) {
  const page = Math.min(Math.max(0, a.page), l.offsets.length - 1);
  const cw = contentWidth(l, viewport.width);
  const left = (cw - l.widths[page]) / 2;
  const clamp = (n: number, max: number) => Math.min(Math.max(0, n), Math.max(0, max));
  return {
    x: clamp(left + a.u * l.widths[page] - at.x, cw - viewport.width),
    y: clamp(l.offsets[page] + a.v * l.heights[page] - at.y, l.total - viewport.height),
  };
}
