import { Fragment, memo, useMemo } from 'react';

import type { TextRun } from '@/engine/types';

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
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measure(text: string, px: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = `${px}px sans-serif`;
  return measureCtx.measureText(text).width;
}

export const TextLayer = memo(function TextLayer({ runs, width, height }: { runs: TextRun[]; width: number; height: number }) {
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
    <div className="tl" data-testid="text-layer">
      {spans.map(({ r, fontSize, scaleX }, i) => (
        <Fragment key={i}>
          <span style={{ left: r.rect.x * width, top: r.rect.y * height, fontSize, transform: `scaleX(${scaleX})` }}>{r.text}</span>
          {r.eol ? <br /> : ' '}
        </Fragment>
      ))}
    </div>
  );
});
