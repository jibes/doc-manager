import type { Page } from './types';

/**
 * Finished renders, kept on the main thread so that going back to the
 * document grid or the camera redraws instantly instead of re-running the
 * pipeline. Least recently used first out, bounded by total pixels.
 */
const BUDGET_PIXELS = 16_000_000;

const entries = new Map<string, { bitmap: ImageBitmap; pixels: number }>();
let total = 0;

const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 1;

/** Identifies a render: the photo itself, the full spec, the size, filtered or not. */
export function renderKey(page: Page, longEdge: number, unfiltered: boolean): string {
  let blobId = blobIds.get(page.source);
  if (!blobId) {
    blobId = nextBlobId++;
    blobIds.set(page.source, blobId);
  }
  return `${blobId}|${longEdge}|${unfiltered ? 1 : 0}|${JSON.stringify(page.spec)}`;
}

/** Close and drop every render of this photo (its page was deleted or retaken). */
export function dropRenders(source: Blob): void {
  const blobId = blobIds.get(source);
  if (!blobId) return;
  const prefix = `${blobId}|`;
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    entries.delete(key);
    total -= entry.pixels;
    entry.bitmap.close();
  }
}

export function getRender(key: string): ImageBitmap | null {
  const hit = entries.get(key);
  if (!hit) return null;
  entries.delete(key);
  entries.set(key, hit);
  return hit.bitmap;
}

export function putRender(key: string, bitmap: ImageBitmap): void {
  const existing = entries.get(key);
  if (existing) {
    total -= existing.pixels;
    entries.delete(key);
    if (existing.bitmap !== bitmap) existing.bitmap.close();
  }
  const pixels = bitmap.width * bitmap.height;
  entries.set(key, { bitmap, pixels });
  total += pixels;
  for (const [oldKey, entry] of entries) {
    if (total <= BUDGET_PIXELS || oldKey === key) break;
    entries.delete(oldKey);
    total -= entry.pixels;
    entry.bitmap.close();
  }
}
