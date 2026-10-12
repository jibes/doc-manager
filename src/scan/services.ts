import type { Page } from './types';
import { DetectorClient, ProcessorClient } from './engine/worker/clients';
import type { RenderJob } from './engine/worker/protocol';

let processorInstance: ProcessorClient | null = null;
let detectorInstance: DetectorClient | null = null;

/** The image-processing worker, created on first use and again after a failure. */
export function processor(): ProcessorClient {
  if (!processorInstance || processorInstance.dead) processorInstance = new ProcessorClient();
  return processorInstance;
}

/** Let the processing worker drop what it keeps for a page that is gone. */
export function forgetPage(pageId: string): void {
  processorInstance?.forget(pageId);
}

/**
 * The page detector (ONNX model) worker, created on first use and again after
 * a failure. Hold on to the returned client rather than calling this per
 * frame, so a detector that keeps failing is not restarted in a loop.
 */
export function detector(): DetectorClient {
  if (!detectorInstance || detectorInstance.dead) detectorInstance = new DetectorClient();
  return detectorInstance;
}

/** Long edge of the first-page thumbnail kept with each history entry. */
const THUMB_EDGE = 200;

/** A small JPEG of `page` as it will be exported, or undefined if it cannot be made. */
export async function pageThumbnail(page: Page | undefined): Promise<Blob | undefined> {
  if (!page) return undefined;
  try {
    const bitmap = await processor().render(renderJob(page, THUMB_EDGE));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  } catch {
    return undefined;
  }
}

/** The worker job for rendering `page` at `longEdge`. */
export function renderJob(page: Page, longEdge: number): RenderJob {
  return {
    pageId: page.id,
    source: page.source,
    sourceWidth: page.width,
    sourceHeight: page.height,
    spec: page.spec,
    longEdge,
  };
}
