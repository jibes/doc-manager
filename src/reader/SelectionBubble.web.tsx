import { useEffect, useState } from 'react';

import type { Palette } from '@/design/tokens';
import { t } from '@/i18n';
import { HIGHLIGHT_COLORS, lineRects } from './selection';
import type { PageRects } from './SelectionBubble';

export type { PageRects } from './SelectionBubble';

type Props = { palette: Palette; onHighlight: (groups: PageRects[], color: string, note: boolean, quote: string) => void };

/** Selected text inside page text layers, as line rects per page (only the spans, not the gaps between them). */
function selectedRects(): PageRects[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const groups: PageRects[] = [];
  for (const layer of document.querySelectorAll<HTMLElement>('.tl[data-page]')) {
    if (!range.intersectsNode(layer)) continue;
    const boxes: DOMRect[] = [];
    for (const span of layer.querySelectorAll('span')) {
      const node = span.firstChild;
      if (!node || !range.intersectsNode(span)) continue;
      const part = document.createRange();
      part.selectNodeContents(node);
      if (span.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
      if (span.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      if (!part.collapsed) boxes.push(part.getBoundingClientRect());
    }
    const rects = lineRects(boxes, layer.getBoundingClientRect());
    if (rects.length) groups.push({ page: Number(layer.dataset.page), rects });
  }
  return groups;
}

/** Floating actions over a text selection on the page: highlight in a colour, or highlight with a note. */
export function SelectionBubble({ palette: p, onHighlight }: Props) {
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      // Wait for the selection to settle (drag, double-click, shift+arrows) before offering actions.
      timer = setTimeout(() => {
        const sel = window.getSelection();
        const inLayer = sel && !sel.isCollapsed && sel.anchorNode?.parentElement?.closest('.tl');
        if (!inLayer) return setAt(null);
        // Anchor at the end of the selection, where the pointer let go: a long selection's overall box can
        // reach past the screen on both sides. Keep it on screen either way.
        const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.bottom > 0 && r.top < innerHeight);
        const box = rects.at(-1) ?? sel.getRangeAt(0).getBoundingClientRect();
        const below = box.top < 120;
        const y = Math.min(Math.max(below ? box.bottom + 10 : box.top - 10, 70), innerHeight - 70);
        setAt({ x: box.left + box.width / 2, y, below });
      }, 220);
    };
    const hide = () => setAt(null);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  if (!at) return null;
  const act = (color: string, note: boolean) => {
    const groups = selectedRects();
    const quote = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
    window.getSelection()?.removeAllRanges();
    setAt(null);
    if (groups.length) onHighlight(groups, color, note, quote);
  };
  const x = Math.min(Math.max(at.x, 130), window.innerWidth - 130);
  return (
    <div
      role="toolbar"
      aria-label={t.highlight}
      data-testid="selection-bubble"
      // Keep the selection alive while pressing the buttons.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: x,
        top: at.y,
        transform: `translate(-50%, ${at.below ? '0' : '-100%'})`,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 6,
        borderRadius: 999,
        background: p.surface,
        border: `1px solid ${p.hairline}`,
        boxShadow: `0 6px 24px ${p.shadow}`,
        zIndex: 50,
      }}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-label={t.highlightIn(t.colors[c.key])}
          title={t.highlightIn(t.colors[c.key])}
          data-testid={`highlight-${c.key}`}
          onClick={() => act(c.hex, false)}
          style={{ width: 28, height: 28, borderRadius: 14, border: `1px solid ${p.hairline}`, background: c.hex, cursor: 'pointer', padding: 0 }}
        />
      ))}
      <span style={{ width: 1, height: 20, background: p.hairline, margin: '0 2px' }} />
      <button
        type="button"
        aria-label={t.addNoteLong}
        title={t.addNoteLong}
        data-testid="highlight-note"
        onClick={() => act(HIGHLIGHT_COLORS[0].hex, true)}
        style={{ height: 28, padding: '0 12px', borderRadius: 14, border: 0, background: 'transparent', color: p.ink, font: '500 14px Inter, system-ui, sans-serif', cursor: 'pointer' }}
      >
        {t.addNote}
      </button>
    </div>
  );
}
