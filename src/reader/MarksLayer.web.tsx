import { memo, useLayoutEffect, useRef } from 'react';

import type { Palette } from '@/design/tokens';
import type { SearchHit } from '@/engine/types';

type Props = { hits: SearchHit[]; active: SearchHit | null | undefined; width: number; height: number; palette: Palette };

/**
 * All of a page's highlights in one canvas: a single blended layer instead of hundreds of
 * blended divs, which kept style/paint cheap on match-dense pages.
 */
export const MarksLayer = memo(function MarksLayer({ hits, active, width, height, palette }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  useLayoutEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = (r: SearchHit['rects'][number]) => [r.x * width - 1.5, r.y * height - 1, r.w * width + 3, r.h * height + 2] as const;
    ctx.fillStyle = palette.mark;
    for (const h of hits) if (h !== active) for (const r of h.rects) ctx.fillRect(...box(r));
    if (active && hits.includes(active)) {
      ctx.fillStyle = palette.markActive;
      ctx.strokeStyle = palette.markRing;
      ctx.lineWidth = 1.5;
      for (const r of active.rects) {
        ctx.fillRect(...box(r));
        ctx.strokeRect(...box(r));
      }
    }
  }, [hits, active, width, height, palette, dpr]);

  const hasActive = !!active && hits.includes(active);
  return (
    <canvas
      ref={ref}
      aria-hidden
      data-testid="hits"
      data-count={hits.length}
      data-active={hasActive ? 'true' : 'false'}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', mixBlendMode: palette.dark ? 'screen' : 'multiply' }}
    />
  );
});
