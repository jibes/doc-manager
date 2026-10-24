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
 * Where the selection's end goes for a point: in the word under it; over white space, at the nearest word that the
 * space belongs to. Past a line's end (a short line, a gutter, the margin): that line, not the next column's.
 * Between lines or below a paragraph: the column under the point, the nearest line above or below. Elsewhere (the
 * margin left of the text): the nearest word. Its end when right of or below it, its start when left of or above.
 */
function endAt(x: number, y: number): { node: Node; offset: number } | null {
  const over = document.elementFromPoint(x, y);
  if (over?.tagName === 'SPAN' && over.closest('.tl')) {
    const at = caretAt(x, y);
    if (at?.node.nodeType === Node.TEXT_NODE) return at;
  }
  const tl = layerAt(x, y);
  if (!tl) return null;
  type Hit = { span: Element; rect: DOMRect; d: number };
  let lineEnd: Hit | null = null;
  let column: Hit | null = null;
  let near: Hit | null = null;
  for (const span of tl.querySelectorAll('span')) {
    const rect = span.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    if (dy === 0 && x > rect.right && (!lineEnd || dx < lineEnd.d)) lineEnd = { span, rect, d: dx };
    if (dx === 0 && (!column || dy < column.d)) column = { span, rect, d: dy };
    const d = dy * 1000 + dx;
    if (!near || d < near.d) near = { span, rect, d };
  }
  const best = lineEnd ?? column ?? near;
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
  let last: { x: number; y: number } | null = null;
  // Near the top or bottom of the pages while dragging: they scroll, as the browser's own selecting would.
  let scroller: HTMLElement | null = null;
  const extend = (from: { node: Node; offset: number }, x: number, y: number) => {
    const end = endAt(x, y);
    if (end) document.getSelection()?.setBaseAndExtent(from.node, from.offset, end.node, end.offset);
  };
  const tick = () => {
    frame = 0;
    const from = start;
    if (!from || !last) return;
    extend(from, last.x, last.y);
    const box = scroller?.getBoundingClientRect();
    if (!scroller || !box) return;
    const edge = 48;
    const by = last.y < box.top + edge ? -(box.top + edge - last.y) : last.y > box.bottom - edge ? last.y - (box.bottom - edge) : 0;
    if (by) {
      scroller.scrollTop += Math.max(-40, Math.min(40, by / 2));
      frame = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('mousedown', (e) => {
    start = null;
    const tl = (e.target as Element | null)?.closest?.('.tl');
    // The left button alone: Ctrl-click (a Mac's right click), ⌘ and Alt clicks, Shift-clicks, double and triple
    // clicks stay the browser's.
    if (!tl || e.button !== 0 || e.detail > 1 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    // Pressed beside the text (the margin, a gutter, between lines): from the word it belongs to, as an end would.
    const caret = caretAt(e.clientX, e.clientY);
    const at = caret?.node.nodeType === Node.TEXT_NODE && tl.contains(caret.node) ? caret : endAt(e.clientX, e.clientY);
    if (!at || !tl.contains(at.node)) return;
    e.preventDefault();
    // The press would have taken the focus (a field being typed in is done, the keys go to the pages): it still does.
    (document.activeElement as HTMLElement | null)?.blur?.();
    (tl.closest('[tabindex]') as HTMLElement | null)?.focus({ preventScroll: true });
    start = at;
    last = { x: e.clientX, y: e.clientY };
    scroller = scrollParent(tl);
    document.getSelection()?.setBaseAndExtent(at.node, at.offset, at.node, at.offset);
  });
  document.addEventListener('mousemove', (e) => {
    if (!start || !(e.buttons & 1)) return;
    last = { x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(tick);
  });
  // The pages scrolled under a still pointer (the wheel, or the edge): the end follows.
  document.addEventListener(
    'scroll',
    () => {
      if (start && last && !frame) frame = requestAnimationFrame(tick);
    },
    true,
  );
  document.addEventListener('mouseup', (e) => {
    // Released before the frame: where it was released counts.
    if (start) extend(start, e.clientX, e.clientY);
    cancelAnimationFrame(frame);
    frame = 0;
    start = null;
    last = null;
    scroller = null;
  });
}

/** The element that scrolls the pages a layer is on. */
function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
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
