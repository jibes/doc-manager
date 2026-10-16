import { t } from '@/core/i18n';
import { folders, type Place } from '@/core/lib/folders';
import { useLibrary } from '@/paper/state/library';
import type { DocRecord } from '@/core/storage';
import { exportPdf, pdfFilename } from './export';
import type { Page, ScanSettings } from './types';

export type SaveProgress = { phase: 'render' | 'read'; done: number; total: number };

/**
 * Builds the PDF (with its text layer when recognition is on), writes it into the folder (or keeps it in the
 * library only), and adds it to the library, linked to the file where it has one. Reading by the model comes
 * after, in the background (see intake). `unread`: pages saved without text because recognition couldn't run.
 * Throws when the PDF was kept nowhere.
 */
export async function saveScan(
  pages: Page[],
  settings: ScanSettings,
  /** As typed: empty for none. */
  title: string,
  /** The name when the user gave none (the model may give a better one later). */
  fallback: string,
  to: Place | null,
  onProgress: (p: SaveProgress) => void,
  signal?: AbortSignal,
): Promise<{ doc?: DocRecord; unread: number }> {
  let unread = 0;
  const name = () => title.trim() || fallback;
  const pdf = await exportPdf(pages, settings, name, (done, total) => onProgress({ phase: 'render', done, total }), {
    searchable: settings.ocr,
    onReading: (page, total) => onProgress({ phase: 'read', done: page, total }),
    signal,
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
    return { doc, unread };
  }
  // In a folder it is saved, even if the library can't take it in (it says so).
  const entry = await folders.create(to, file, pdf);
  return { doc: (await library.importFiles([{ name: entry.name, size: pdf.size, file: pdf, handle: entry.handle, link: entry.uri }]))[0], unread };
}
