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

/** A run of text on one line, for the selectable text layer. */
export type TextRun = { text: string; rect: NormRect; /** Last run on its line: copy inserts a line break after it. */ eol: boolean };

/** A line fragment with typography, for the reflowed text view. Order is the PDF's reading order. */
export type TextLine = {
  text: string;
  rect: NormRect;
  /** Font size in points. */
  size: number;
  bold: boolean;
  italic: boolean;
  /** Ends in a hyphen that splits a word across lines. */
  hyphen: boolean;
  /** Tagged PDFs: structure type (P, H1, LI, …) and element id grouping lines into blocks. */
  role?: string;
  sid?: number;
};

export type PageLink = { rect: NormRect } & ({ kind: 'page'; page: number } | { kind: 'url'; url: string });

/** Thrown by open() for encrypted PDFs; `wrong` when a password was given but rejected. */
export class PasswordError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'password-wrong' : 'password-required');
    this.name = 'PasswordError';
  }
}

/** Engines report password failures as messages across threads/bridges; normalise them here. */
export function asPasswordError(e: unknown): PasswordError | null {
  if (e instanceof PasswordError) return e;
  const m = e instanceof Error ? e.message : String(e);
  return /password-wrong/.test(m) ? new PasswordError(true) : /password-required/.test(m) ? new PasswordError(false) : null;
}

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
  /** Selectable text, line by line. Engines without text extraction return []. */
  pageText(page: number): Promise<TextRun[]>;
  /** Link annotations plus URLs detected in the text. */
  links(page: number): Promise<PageLink[]>;
  /** Lines with typography for reflow, for a batch of pages. Engines without text extraction return null. */
  textLines(pages: number[]): Promise<TextLine[][] | null>;
  close(): void;
}

export interface DocumentEngine {
  open(source: DocSource, password?: string): Promise<DocHandle>;
  /** Encoded cover image of page 1 for the library (Blob on web, file URI on native). */
  renderCover(source: DocSource, width: number, password?: string): Promise<{ cover: Blob | string; handle: DocHandle }>;
}
