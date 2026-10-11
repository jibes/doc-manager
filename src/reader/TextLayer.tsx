import type { TextRun } from '@/engine/types';

/** Native: no text layer yet (text extraction isn't bridged from PDFKit/PdfRenderer). */
export function TextLayer(_: { runs: TextRun[]; width: number; height: number }) {
  return null;
}
