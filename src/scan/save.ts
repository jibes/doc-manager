import { aiMessage, t } from '@/i18n';
import { anySignal } from '@/lib/signals';
import { folders, type Place } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import type { DocRecord } from '@/storage';
import { aiTitle, applyReading, pageLines, readWithAi, type AiSettings } from './ai';
import type { PdfPage } from './engine/pdf/writer';
import { exportPdf, pdfFilename } from './export';
import { processor, renderJob } from './services';
import type { Page, ScanSettings } from './types';

export type SaveProgress = { phase: 'render' | 'read' | 'ai'; done: number; total: number };

/** How long AI reading may take: a few minutes, more for long documents. */
const aiTime = (pages: number) => Math.min(15 * 60_000, 120_000 + pages * 30_000);

/** Long edge of the page images sent for AI reading: models see about this much anyway. */
const AI_EDGE = 1568;

async function aiImage(page: Page): Promise<Blob> {
  const bitmap = await processor().render(renderJob(page, AI_EDGE));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

/**
 * Builds the PDF (with its text layer when recognition is on), writes it into the folder (or keeps it in the
 * library only), and adds it to the library, linked to the file where it has one. With `ai`, the pages are also
 * read by the model set up in Settings, whose text replaces the device's and whose title names the file when the
 * user gave none; if that fails, the scan is saved with the device's text and `aiError` says why. `unread`: pages
 * saved without text because recognition couldn't run. Throws when the PDF was kept nowhere.
 */
export async function saveScan(
  pages: Page[],
  settings: ScanSettings,
  /** As typed: empty for none. */
  title: string,
  /** The name when neither the user nor the model gave one. */
  fallback: string,
  to: Place | null,
  onProgress: (p: SaveProgress) => void,
  signal?: AbortSignal,
  ai?: AiSettings,
): Promise<{ doc?: DocRecord; aiError?: string; unread: number }> {
  let found = '';
  let aiError: string | undefined;
  let unread = 0;
  const enrich =
    ai && settings.ocr
      ? async (done: { pdf: PdfPage; page: Page }[]) => {
          onProgress({ phase: 'ai', done: 0, total: done.length });
          try {
            const sent = await Promise.all(
              done.map(async ({ pdf, page }, i) => ({
                jpeg: await aiImage(page),
                lines: pageLines(pdf.words ?? [], i).map((l) => ({ id: l.id, text: l.words.map((w) => w.text).join(' ') })),
              })),
            );
            // A model that doesn't answer in time leaves the scan with the device's text (not unsaved).
            const reading = await readWithAi(ai, sent, anySignal([signal, AbortSignal.timeout(aiTime(done.length))]));
            done.forEach(({ pdf }, i) => (pdf.words = applyReading(pdf.words ?? [], i, reading.pages[i], pdf.pixelWidth, pdf.pixelHeight)));
            found = aiTitle(reading);
            return { author: reading.sender || undefined, subject: reading.type || undefined, keywords: reading.keywords, date: reading.date || undefined };
          } catch (e) {
            if (signal?.aborted) throw e;
            aiError = aiMessage(e);
            return undefined;
          }
        }
      : undefined;
  const name = () => title.trim() || found || fallback;
  const pdf = await exportPdf(pages, settings, name, (done, total) => onProgress({ phase: 'render', done, total }), {
    searchable: settings.ocr,
    onReading: (page, total) => onProgress({ phase: 'read', done: page, total }),
    signal,
    enrich,
    onUnread: () => unread++,
  });
  const file = pdfFilename(name());
  const library = useLibrary.getState();
  if (!to) {
    // Only the library keeps it: not kept there is not saved at all (the scan stays, to try again).
    const [doc] = await library.importFiles([{ name: file, size: pdf.size, file: pdf }]);
    if (!doc) {
      const why = useLibrary.getState().error;
      library.clearError();
      throw new Error(why ?? t.scanNotKept);
    }
    return { doc, aiError, unread };
  }
  // In a folder it is saved, even if the library can't take it in (it says so).
  const entry = await folders.create(to, file, pdf);
  return { doc: (await library.importFiles([{ name: entry.name, size: pdf.size, file: pdf, handle: entry.handle, link: entry.uri }]))[0], aiError, unread };
}
