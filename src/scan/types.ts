import type { FilterId } from './engine/imaging/filters';
import type { Quad } from './engine/imaging/image';
import type { PageSpec } from './engine/pipeline';

/** A scanned page: the photo as taken, and how to turn it into a finished page. */
export interface Page {
  id: string;
  source: Blob;
  /** Source photo size in pixels. */
  width: number;
  height: number;
  spec: PageSpec;
  detected: Quad | null;
  /** Capture sharpness (engine/imaging/sharpness.ts), or null when not measured. */
  sharpness: number | null;
}

export type Resolution = 'standard' | 'high' | 'max';

export interface ScanSettings {
  defaultFilter: FilterId;
  autoCapture: boolean;
  resolution: Resolution;
  /** JPEG quality for colour pages in the PDF, 0..1. */
  jpegQuality: number;
  /** A lens picked by hand, or null for automatic selection. */
  cameraDeviceId: string | null;
  /** Add an invisible OCR text layer to saved PDFs. */
  ocr: boolean;
}

/** Long edge of an exported page. ~300 dpi on A4 for 'high'. */
export const RESOLUTION_LONG_EDGE: Record<Resolution, number> = {
  standard: 2400,
  high: 3500,
  max: 4400,
};

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  defaultFilter: 'document',
  autoCapture: true,
  resolution: 'high',
  jpegQuality: 0.88,
  cameraDeviceId: null,
  ocr: true,
};
