import { Fragment, memo, useMemo } from 'react';

import type { TextRun } from '@/core/engine/types';

// Invisible text over the raster: the browser handles selection, copy, find and accessibility.
const STYLE_ID = 'tessel-text-layer';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
    .tl { position:absolute; inset:0; overflow:hidden; contain:strict; line-height:1; user-select:text; -webkit-user-select:text; cursor:text; }
    .tl span { position:absolute; white-space:pre; color:transparent; transform-origin:0 0; font-family:sans-serif; }
    .tl span::selection { background:rgba(47,79,134,0.28); color:transparent; }
    .tl br::selection { background:transparent; }
  `;
  document.head.appendChild(el);
  followSelection();
}

/** Where a point is in the text: the character under it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The layer under a point, if any. */
const layerAt = (x: number, y: number) =>
  [...document.querySelectorAll('.tl')].find((l) => {
    const r = l.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });

/**
 * Where the selection's end goes for a point: in the word under it; over white space (past a line's end, between
 * lines, in a gutter), at the nearest word on the line, its end when right of it, its start when left of it.
 */
function endAt(x: number, y: number): { node: Node; offset: number } | null {
  const over = document.elementFromPoint(x, y);
  if (over?.tagName === 'SPAN' && over.closest('.tl')) {
    const at = caretAt(x, y);
    if (at?.node.nodeType === Node.TEXT_NODE) return at;
  }
  const tl = layerAt(x, y);
  if (!tl) return null;
  let best: { span: Element; rect: DOMRect; d: number } | null = null;
  for (const span of tl.querySelectorAll('span')) {
    const rect = span.getBoundingClientRect();
    // On the line first (by height), then across it.
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const d = dy * 1000 + dx;
    if (!best || d < best.d) best = { span, rect, d };
  }
  const text = best?.span.firstChild;
  if (!best || !text || text.nodeType !== Node.TEXT_NODE) return null;
  const after = y > best.rect.bottom || (y >= best.rect.top && x > best.rect.left + best.rect.width / 2);
  return { node: text, offset: after ? (text.textContent ?? '').length : 0 };
}

/**
 * Selecting with the mouse: the browser takes white space between the words (past a line's end, between lines,
 * a gutter) for the layer's very end, and the selection jumps far past the pointer. A drag that starts on the
 * text is followed here instead: from where it was pressed to the word at (or nearest) the pointer. Double and
 * triple clicks, Shift-clicks and fingers stay the browser's.
 */
function followSelection() {
  let start: { node: Node; offset: number } | null = null;
  let frame = 0;
  document.addEventListener('mousedown', (e) => {
    start = null;
    const tl = (e.target as Element | null)?.closest?.('.tl');
    if (!tl || e.button !== 0 || e.detail > 1 || e.shiftKey) return;
    const at = caretAt(e.clientX, e.clientY);
    if (!at || at.node.nodeType !== Node.TEXT_NODE || !tl.contains(at.node)) return;
    e.preventDefault();
    start = at;
    document.getSelection()?.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
  });
  document.addEventListener('mousemove', (e) => {
    if (!start || !(e.buttons & 1)) return;
    const { clientX: x, clientY: y } = e;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const end = start && endAt(x, y);
      if (start && end) document.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    });
  });
  document.addEventListener('mouseup', () => (start = null));
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, px: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = `${px}px sans-serif`;
  return measureCtx.measureText(text).width;
}

export const TextLayer = memo(function TextLayer({ page, runs, width, height }: { page: number; runs: TextRun[]; width: number; height: number }) {
  // Each run is stretched horizontally to its true width so selection boxes match the glyphs underneath.
  const spans = useMemo(
    () =>
      runs.map((r) => {
        const fontSize = Math.max(1, r.rect.h * height);
        const natural = measure(r.text, fontSize);
        const scaleX = natural > 0 ? (r.rect.w * width) / natural : 1;
        return { r, fontSize, scaleX };
      }),
    [runs, width, height],
  );
  return (
    <div className="tl" data-testid="text-layer" data-page={page}>
      {spans.map(({ r, fontSize, scaleX }, i) => (
        <Fragment key={i}>
          <span style={{ left: r.rect.x * width, top: r.rect.y * height, fontSize, transform: `scaleX(${scaleX})` }}>{r.text}</span>
          {r.eol ? <br /> : ' '}
        </Fragment>
      ))}
    </div>
  );
});
