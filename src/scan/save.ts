import { folders, type FolderRoot } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import type { DocRecord } from '@/storage';
import { exportPdf, pdfFilename } from './export';
import type { Page, ScanSettings } from './types';

export type SaveProgress = { phase: 'render' | 'read'; done: number; total: number };

/**
 * Builds the PDF (with its text layer when recognition is on), writes it into the folder (or keeps it in the
 * library only), and adds it to the library, linked to the file where it has one.
 */
export async function saveScan(
  pages: Page[],
  settings: ScanSettings,
  title: string,
  to: FolderRoot | null,
  onProgress: (p: SaveProgress) => void,
  signal?: AbortSignal,
): Promise<DocRecord | undefined> {
  const pdf = await exportPdf(pages, settings, title, (done, total) => onProgress({ phase: 'render', done, total }), {
    searchable: settings.ocr,
    onReading: (page, total) => onProgress({ phase: 'read', done: page, total }),
    signal,
  });
  const name = pdfFilename(title);
  const { importFiles } = useLibrary.getState();
  if (!to) return (await importFiles([{ name, size: pdf.size, file: pdf }]))[0];
  const entry = await folders.create({ root: to.id }, name, pdf);
  return (await importFiles([{ name: entry.name, size: pdf.size, file: pdf, handle: entry.handle, link: entry.uri }]))[0];
}
