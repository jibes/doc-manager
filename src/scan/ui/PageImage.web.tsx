import { useEffect, useRef, useState } from 'react';

import { AbortedError } from '../engine/worker/clients';
import { getRender, putRender, renderKey } from '../renderCache';
import { processor, renderJob } from '../services';
import type { Page } from '../types';

export type PageImageProps = {
  page: Page;
  /** Long edge of the render, in pixels. */
  longEdge: number;
  /** Renders on the same channel replace each other, so a fast change never builds a backlog. */
  channel: string;
  /** The rectified page without its filter ("hold to compare"). */
  unfiltered?: boolean;
  onRendering?: (rendering: boolean) => void;
};

/** A scanned page as it will be saved, rendered by the processing worker and kept in the render cache. */
export function PageImage({ page, longEdge, channel, unfiltered = false, onRendering }: PageImageProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState<string | null>(null);
  const key = renderKey(page, longEdge, unfiltered);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = (bitmap: ImageBitmap) => {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      setDrawn(key);
      onRendering?.(false);
    };
    const cached = getRender(key);
    if (cached) {
      queueMicrotask(() => draw(cached));
      return;
    }
    const job = renderJob(page, longEdge);
    const controller = new AbortController();
    let stale = false;
    onRendering?.(true);
    processor()
      .latest(channel, () => (unfiltered ? processor().rectified(job, controller.signal) : processor().render(job, controller.signal)))
      .then((bitmap) => {
        if (!bitmap) return;
        putRender(key, bitmap);
        if (!stale) draw(bitmap);
      })
      .catch((error) => {
        if (!stale && !(error instanceof AbortedError)) onRendering?.(false);
      });
    return () => {
      stale = true;
      // A render nobody will see should not hold up the ones that will.
      controller.abort();
    };
    // `key` covers the page's photo and spec, the size and the filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, channel]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      data-rendered={drawn === key ? '' : undefined}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', opacity: drawn ? 1 : 0, transition: 'opacity 120ms' }}
    />
  );
}
