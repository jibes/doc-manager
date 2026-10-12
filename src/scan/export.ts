import { cropShapeUnknown } from './engine/imaging/quad';
import { pageSizePoints, type PageSize } from './engine/pdf/paper';
import { buildPdf, type PdfPage } from './engine/pdf/writer';
import { encodedPage, turnedPage, uprightPage, type PageText } from './exportCache';
import type { Page, ScanSettings } from './types';

/**
 * Physical size of a page rendered at `width` x `height` pixels: from its
 * shape (pdf/paper.ts), unless the crop is a guess or clipped to the photo,
 * whose shape says nothing about the paper.
 */
export function pagePaperSize(page: Page, width: number, height: number): PageSize {
  const known = !cropShapeUnknown(page.spec.quad, page.width, page.height);
  return pageSizePoints(width, height, { known });
}

export function defaultTitle(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}`;
}

export function pdfFilename(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'scan';
  return `${safe}.pdf`;
}

/** How often an export starts over with pages edited while it ran, before it gives up on them. */
const MAX_ROUNDS = 4;

function aborted(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(aborted());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Render every page at export resolution and assemble the PDF. With
 * `searchable`, pages carry an invisible OCR text layer (when OCR is enabled
 * in the settings).
 *
 * With `latest`, the export follows the document while it runs: once every
 * page is done, pages edited, added, deleted or moved meanwhile are done
 * again (only those: a page is replaced, never mutated, so an unchanged one
 * is reused), so the PDF holds the document as it is when it is finished.
 */
export async function exportPdf(
  pages: Page[],
  settings: ScanSettings,
  title: string | (() => string),
  onProgress: (done: number, total: number) => void,
  {
    searchable = false,
    onReading,
    skipText,
    onTurn,
    latest,
    signal,
  }: {
    searchable?: boolean;
    /** Called while waiting for a page's text recognition. */
    onReading?: (page: number, total: number) => void;
    /** Resolves when the user chooses to save without the remaining text. */
    skipText?: Promise<void>;
    /** Called when OCR finds a page sideways or upside down (clockwise quarter turns). */
    onTurn?: (page: number, turn: number) => void;
    /** The pages as they are now; see above. An empty list cancels the export. */
    latest?: () => Page[];
    /** Cancels the export (it rejects with an AbortError). */
    signal?: AbortSignal;
  } = {},
): Promise<Blob> {
  let skipped = false;
  void skipText?.then(() => (skipped = true));
  const none: PageText = { words: [], turn: 0 };
  // The page's text, or none once the user chooses to skip the text.
  const waitForText = (text: Promise<PageText>, index: number, total: number) => {
    onReading?.(index, total);
    return skipText ? Promise.race([text, skipText.then(() => none)]) : text;
  };
  const one = async (page: Page, i: number, total: number): Promise<PdfPage> => {
    const encoded = await unlessAborted(encodedPage(page, settings, { text: searchable }), signal);
    let { image, width, height } = encoded;
    const reading = encoded.text;
    const text =
      searchable && reading && !skipped
        ? await unlessAborted(waitForText(reading, i, total), signal)
        : undefined;
    let found = text?.words;
    if (text?.turn) {
      // OCR found the page sideways or upside down: put it in upright.
      onTurn?.(i, text.turn);
      ({
        image,
        width,
        height,
        words: found,
      } = await unlessAborted(uprightPage(page, settings, text), signal));
    }
    const upright = text?.turn ? turnedPage(page, text.turn) : page;
    const size = pagePaperSize(upright, width, height);
    return {
      pixelWidth: width,
      pixelHeight: height,
      width: size.width,
      height: size.height,
      image,
      words: found,
    };
  };

  const built = new Map<Page, PdfPage>();
  let list = latest?.() ?? pages;
  for (let round = 1; ; round++) {
    if (list.length === 0) throw aborted();
    for (let i = 0; i < list.length; i++) {
      if (signal?.aborted) throw aborted();
      const page = list[i];
      if (built.has(page)) continue;
      onProgress(list.filter((p) => built.has(p)).length, list.length);
      built.set(page, await one(page, i, list.length));
    }
    const now = latest?.() ?? list;
    const same = now.length === list.length && now.every((p, i) => p === list[i]);
    if (same || round >= MAX_ROUNDS) break;
    list = now;
  }
  onProgress(list.length, list.length);
  return buildPdf(
    list.map((p) => built.get(p)!),
    { title: typeof title === 'function' ? title() : title },
  );
}
