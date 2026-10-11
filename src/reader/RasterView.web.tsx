import { useLayoutEffect, useRef } from 'react';

import type { Raster } from '@/engine/types';

/** Draws an ImageBitmap into a canvas; theme tint is a GPU CSS filter, so no re-render on theme change. */
export function RasterView({ raster, filter }: { raster: Raster | undefined; filter: string; blend?: unknown }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<Raster | undefined>(undefined);

  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !raster || raster.kind !== 'bitmap' || drawn.current === raster) return;
    try {
      c.width = raster.width;
      c.height = raster.height;
      c.getContext('2d', { alpha: false })!.drawImage(raster.bitmap, 0, 0);
      drawn.current = raster;
    } catch {
      // Bitmap evicted between render and paint; the next raster will land shortly.
    }
  }, [raster]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', filter, display: 'block' }}
    />
  );
}
