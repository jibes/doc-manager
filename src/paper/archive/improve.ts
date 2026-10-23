import type { DocHandle, PageWords } from '@/core/engine/types';
import { anySignal } from '@/core/lib/signals';
import { applyReading, pageLines, readWithAi, type AiDescription, type AiPage, type AiSettings } from '@/paper/scan/ai';
import type { PdfWord } from '@/paper/scan/engine/pdf/writer';
import { readPage } from './searchable';

/**
 * Improving a document's text with AI: each page's invisible text (an earlier recognition's, or this device's
 * where a page has none) goes to the model with the page's image, as for a new scan; its corrections and what it
 * finds besides (handwriting) replace the page's invisible text (the earlier text leaves the file). Pages with text of their
 * own (typed, sideways or nested text) are left as they are.
 */

/** Long edge of the page images sent: as for scans. */
const AI_EDGE = 1568;
/** Pages per request: replies stay well within a model's length, and progress shows. */
const BATCH = 4;
/** The page in virtual pixels across: words are placed in these, as on a scan's image. */
const ACROSS = 1000;
/** How long one request may take. */
const aiTime = (pages: number) => 120_000 + pages * 30_000;

/** A page to read again: its words now, whether they are a layer to replace, and a sideways device reading's turn. */
export type Improvable = { page: number; words: PageWords['words']; layer: boolean; turn?: number };

/** Pages that can be read again, with their current words; null for a page whose text is its own. */
export async function improvable(handle: DocHandle, page: number, signal?: AbortSignal): Promise<Improvable | null> {
  const layer = await handle.ocrLayer(page);
  if (layer.other) return null;
  if (layer.words.length) return { page, words: layer.words, layer: true };
  // No text at all: read on the device first. A page read sideways keeps that reading (its words are upright, the
  // page the model would see isn't).
  const read = await readPage(handle, page, signal);
  return { page, words: read.words, layer: false, turn: read.turn };
}

/**
 * Whether the model has anything to read again: a page that is a picture (recognised text, or none yet) among the
 * first `limit`. A document whose pages all have text of their own (typed) has nothing. `stop`: given up.
 */
export async function anyImprovable(handle: DocHandle, limit: number, stop?: () => boolean): Promise<boolean> {
  for (let p = 0; p < Math.min(handle.pageCount, limit); p++) {
    if (stop?.()) return false;
    const layer = await handle.ocrLayer(p).catch(() => null);
    if (layer && !layer.other) return true;
  }
  return false;
}

async function pageImage(handle: DocHandle, page: number, signal?: AbortSignal): Promise<Blob> {
  const { width: w, height: h } = handle.pageSizes[page];
  const raster = await handle.renderPage(page, { width: Math.round(w >= h ? AI_EDGE : (AI_EDGE * w) / h), signal });
  if (raster.kind !== 'bitmap') throw new Error('Pages can’t be read here');
  const canvas = new OffscreenCanvas(raster.bitmap.width, raster.bitmap.height);
  const ctx = canvas.getContext('2d')!;
  // Pages without a background of their own are white on paper.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(raster.bitmap, 0, 0);
  raster.bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/** Normalized boxes ⇄ the virtual pixels the reading is applied in. */
export const toPixels = (words: PageWords['words'], height: number): PdfWord[] =>
  words.map(({ text, box }) => ({ text, x0: box.x * ACROSS, y0: box.y * height, x1: (box.x + box.w) * ACROSS, y1: (box.y + box.h) * height }));
export const fromPixels = (words: PdfWord[], height: number): PageWords['words'] =>
  words
    .filter((w) => w.text.trim() && w.x1 > w.x0 && w.y1 > w.y0)
    .map((w) => ({ text: w.text, box: { x: w.x0 / ACROSS, y: w.y0 / height, w: (w.x1 - w.x0) / ACROSS, h: (w.y1 - w.y0) / height } }));

/**
 * The file with the pages' text read again by the model, or null when no page could be (all have text of their
 * own). `skipped`: pages left as they were.
 */
export async function improveWithAi(
  handle: DocHandle,
  ai: AiSettings,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ bytes: ArrayBuffer; pages: number; skipped: number; found?: AiDescription } | null> {
  const out: PageWords[] = [];
  // What the model says the document is (its first pages say it best).
  let found: AiDescription | undefined;
  let skipped = 0;
  let read = 0;
  const send = async (batch: Improvable[]) => {
    const sized = batch.map((b) => {
      const { width, height } = handle.pageSizes[b.page];
      const h = (ACROSS * height) / width;
      return { ...b, h, px: toPixels(b.words, h) };
    });
    const sent: AiPage[] = await Promise.all(
      sized.map(async (b, i) => ({
        jpeg: await pageImage(handle, b.page, signal),
        lines: pageLines(b.px, i).map((l) => ({ id: l.id, text: l.words.map((w) => w.text).join(' ') })),
      })),
    );
    const reading = await readWithAi(ai, sent, anySignal([signal, AbortSignal.timeout(aiTime(batch.length))]));
    if (!found) {
      const { pages: _pages, ...description } = reading;
      found = description;
    }
    sized.forEach((b, i) => {
      const words = reading.pages[i] ? fromPixels(applyReading(b.px, i, reading.pages[i], ACROSS, b.h), b.h) : b.words;
      out.push({ page: b.page, words, replace: b.layer });
    });
    read += batch.length;
  };
  let batch: Improvable[] = [];
  onProgress(0, handle.pageCount);
  for (let p = 0; p < handle.pageCount; p++) {
    signal?.throwIfAborted();
    const page = await improvable(handle, p, signal);
    if (!page) skipped++;
    else if (page.turn) {
      out.push({ page: p, words: page.words, turn: page.turn });
      read++;
    } else batch.push(page);
    if (batch.length === BATCH) {
      await send(batch);
      batch = [];
    }
    onProgress(p + 1, handle.pageCount);
  }
  if (batch.length) await send(batch);
  if (!read) return null;
  return { bytes: await handle.addTextLayer(out), pages: read, skipped, found };
}
