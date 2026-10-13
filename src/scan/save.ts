import { folders, type FolderRoot } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import type { DocRecord } from '@/storage';
import { aiTitle, applyReading, pageLines, readWithAi, type AiSettings } from './ai';
import type { PdfPage } from './engine/pdf/writer';
import { exportPdf, pdfFilename } from './export';
import { processor, renderJob } from './services';
import type { Page, ScanSettings } from './types';

export type SaveProgress = { phase: 'render' | 'read' | 'ai'; done: number; total: number };

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
 * user gave none; if that fails, the scan is saved with the device's text and `aiError` says why.
 */
export async function saveScan(
  pages: Page[],
  settings: ScanSettings,
  /** As typed: empty for none. */
  title: string,
  /** The name when neither the user nor the model gave one. */
  fallback: string,
  to: FolderRoot | null,
  onProgress: (p: SaveProgress) => void,
  signal?: AbortSignal,
  ai?: AiSettings,
): Promise<{ doc?: DocRecord; aiError?: string }> {
  let found = '';
  let aiError: string | undefined;
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
            const reading = await readWithAi(ai, sent, signal);
            done.forEach(({ pdf }, i) => (pdf.words = applyReading(pdf.words ?? [], i, reading.pages[i], pdf.pixelWidth, pdf.pixelHeight)));
            found = aiTitle(reading);
            return { author: reading.sender || undefined, subject: reading.type || undefined, keywords: reading.keywords };
          } catch (e) {
            if (signal?.aborted) throw e;
            aiError = e instanceof Error ? e.message : String(e);
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
  });
  const file = pdfFilename(name());
  const { importFiles } = useLibrary.getState();
  if (!to) return { doc: (await importFiles([{ name: file, size: pdf.size, file: pdf }]))[0], aiError };
  const entry = await folders.create({ root: to.id }, file, pdf);
  return { doc: (await importFiles([{ name: entry.name, size: pdf.size, file: pdf, handle: entry.handle, link: entry.uri }]))[0], aiError };
}
