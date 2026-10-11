import type { NormRect } from '@/engine/types';
import type { Palette } from '@/design/tokens';

export type PageRects = { page: number; rects: NormRect[] };

/** Native: no selectable text layer yet, so nothing to highlight from. */
export function SelectionBubble(_: { palette: Palette; onHighlight: (groups: PageRects[], color: string, note: boolean, quote: string) => void }) {
  return null;
}
