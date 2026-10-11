/**
 * Platform-neutral document engine contract.
 * Web: PDFium (WASM, in a worker). iOS: PDFKit. Android: PdfRenderer.
 * UI code depends only on this file.
 */

export type Size = { width: number; height: number };

/** Rect in normalized page space: 0..1, origin top-left. */
export type NormRect = { x: number; y: number; w: number; h: number };

export type DocMetadata = { title?: string; author?: string };

export type OutlineItem = {
  title: string;
  /** 0-based page index, -1 if unresolved. */
  page: number;
  children: OutlineItem[];
};

export type SearchHit = {
  page: number;
  rects: NormRect[];
  /** Surrounding text; match is at [matchStart, matchStart + matchLength). */
  snippet: string;
  matchStart: number;
  matchLength: number;
};

export type DocSource =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'uri'; uri: string };

/** Rendered page raster. Web hands back an ImageBitmap; native a file URI. */
export type Raster =
  | { kind: 'bitmap'; bitmap: ImageBitmap; width: number; height: number }
  | { kind: 'uri'; uri: string; width: number; height: number };

export type RenderOptions = {
  /** Target width in device pixels. */
  width: number;
  signal?: AbortSignal;
};

export interface DocHandle {
  readonly pageCount: number;
  /** Page sizes in PDF points, rotation applied. */
  readonly pageSizes: Size[];
  readonly metadata: DocMetadata;
  renderPage(page: number, opts: RenderOptions): Promise<Raster>;
  outline(): Promise<OutlineItem[]>;
  /** Streams hits per page via onHits; resolves when done or aborted. */
  search(query: string, onHits: (hits: SearchHit[]) => void, signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface DocumentEngine {
  open(source: DocSource): Promise<DocHandle>;
  /** Encoded cover image of page 1 for the library (Blob on web, file URI on native). */
  renderCover(source: DocSource, width: number): Promise<{ cover: Blob | string; handle: DocHandle }>;
}
