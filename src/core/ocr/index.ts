import type { DocHandle, TextLine } from '@/core/engine/types';

/** On-device text recognition for scanned PDFs. Native: not yet (Vision / ML Kit are the candidates). */
export const ocrAvailable = false;

export type Recognizer = { page(handle: DocHandle, page: number): Promise<TextLine[]>; close(): void };

export async function createRecognizer(): Promise<Recognizer> {
  throw new Error('OCR is not available on this platform');
}
