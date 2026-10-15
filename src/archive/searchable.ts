import type { DocHandle, PageWords } from '@/engine/types';
import { OcrClient } from '@/scan/engine/worker/clients';

/**
 * Making image-only PDFs searchable: pages without text are rendered, read on the device with PaddleOCR (the
 * scanner's recogniser), and get invisible text over each word, appended to the file. The document looks the
 * same; its text can then be searched, selected, copied and indexed.
 */

/** Long edge of the page image read: as the scanner reads its pages (text lines ~35 px tall). */
const OCR_EDGE = 2600;
/** A page with fewer characters than this has no real text layer (a stray page number doesn't count). */
const MIN_CHARS = 20;
/** The OCR worker keeps its models in memory; it is closed after this long unused. */
const IDLE_MS = 60_000;

let client: OcrClient | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let users = 0;

async function withOcr<T>(fn: (c: OcrClient) => Promise<T>): Promise<T> {
  clearTimeout(idle);
  users++;
  if (!client || client.dead) client = new OcrClient();
  try {
    return await fn(client);
  } finally {
    if (--users === 0)
      idle = setTimeout(() => {
        client?.dispose();
        client = null;
      }, IDLE_MS);
  }
}

const textless = async (handle: DocHandle, page: number) =>
  (await handle.pageText(page).catch(() => [])).reduce((n, r) => n + r.text.trim().length, 0) < MIN_CHARS;

/** The pages (of the first `limit`) that have no text of their own. */
export async function pagesWithoutText(handle: DocHandle, limit = Infinity): Promise<number[]> {
  const out: number[] = [];
  for (let p = 0; p < Math.min(limit, handle.pageCount); p++) if (await textless(handle, p)) out.push(p);
  return out;
}

/**
 * Whether any of the first `limit` pages has no text (a scan, or scanned pages after typed ones), stopping at
 * the first; `stop` ends the search (the document was closed).
 */
export async function anyPageWithoutText(handle: DocHandle, limit: number, stop?: () => boolean): Promise<boolean> {
  for (let p = 0; p < Math.min(limit, handle.pageCount); p++) {
    if (stop?.()) return false;
    if (await textless(handle, p)) return true;
  }
  return false;
}

/** Reads one page: its words, with boxes normalized to the page as shown. */
export async function readPage(handle: DocHandle, page: number, signal?: AbortSignal): Promise<PageWords> {
  const size = handle.pageSizes[page];
  const width = Math.round(size.width >= size.height ? OCR_EDGE : (OCR_EDGE * size.width) / size.height);
  const raster = await handle.renderPage(page, { width, signal });
  if (raster.kind !== 'bitmap') throw new Error('Pages can’t be read here');
  const { bitmap } = raster;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  // Renders are transparent where the page is blank: read on white.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  // Sideways and upside-down scans are found and read upright; their words come in the upright image's pixels.
  const { words, turn } = await withOcr((c) => c.recognise({ data: image.data, width: image.width, height: image.height }, { orient: true }));
  const [w, h] = turn % 2 ? [image.height, image.width] : [image.width, image.height];
  return {
    page,
    turn,
    words: words
      .filter((x) => x.text.trim())
      .map((x) => ({ text: x.text.trim(), box: { x: x.x0 / w, y: x.y0 / h, w: (x.x1 - x.x0) / w, h: (x.y1 - x.y0) / h } })),
  };
}

/** The text read on each page, joined into lines of words (for rules and dates before filing). */
export const textOf = (pages: PageWords[]) => pages.map((p) => p.words.map((w) => w.text).join(' ')).join('\n');

/** Reads `pages` one by one, reporting progress. */
export async function readPages(handle: DocHandle, pages: number[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<PageWords[]> {
  const out: PageWords[] = [];
  onProgress?.(0, pages.length);
  for (const [i, page] of pages.entries()) {
    signal?.throwIfAborted();
    out.push(await readPage(handle, page, signal));
    onProgress?.(i + 1, pages.length);
  }
  return out;
}

/**
 * The file with text over the pages that had none; 'has-text' when every page had text already, 'no-text' when
 * nothing could be read. `known`: pages read before (the inbox reads the first one early), not read again.
 */
export async function makeSearchable(
  handle: DocHandle,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  known: PageWords[] = [],
): Promise<ArrayBuffer | 'has-text' | 'no-text'> {
  const missing = await pagesWithoutText(handle);
  if (!missing.length) return 'has-text';
  const todo = missing.filter((p) => !known.some((k) => k.page === p));
  const read = [...known.filter((k) => missing.includes(k.page)), ...(await readPages(handle, todo, onProgress, signal))];
  if (!read.some((p) => p.words.length)) return 'no-text';
  return handle.addTextLayer(read.sort((a, b) => a.page - b.page));
}
