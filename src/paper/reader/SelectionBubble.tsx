import type { NormRect } from '@/core/engine/types';
import type { Palette } from '@/core/design/tokens';

export type PageRects = { page: number; rects: NormRect[] };

/** Native: no selectable text layer yet, so nothing to highlight from. */
export function SelectionBubble(_: { palette: Palette; onHighlight: (groups: PageRects[], color: string, note: boolean, quote: string) => void }) {
  return null;
}
