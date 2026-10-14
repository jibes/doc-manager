/**
 * Platform-neutral document engine contract.
 * Web: PDFium (WASM, in a worker). iOS: PDFKit. Android: PdfRenderer.
 * UI code depends only on this file.
 */

export type Size = { width: number; height: number };

/** Rect in normalized page space: 0..1, origin top-left. */
export type NormRect = { x: number; y: number; w: number; h: number };

/**
 * Words recognised on a page, in reading order. Boxes are normalized to the page as shown turned by `turn`
 * clockwise quarter turns (so the text reads upright: a page scanned sideways has turn 1 or 3).
 */
export type PageWords = { page: number; turn?: number; words: { text: string; box: NormRect }[] };

export type DocMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  /** The document's own date (Tessel's DocumentDate entry), YYYY-MM-DD. */
  date?: string;
  /** The information dictionary's other entries, kept when the details are rewritten (creator, producer, dates). */
  other: Record<string, string>;
};

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

/** A drawing on a page: one image, or a cluster of vector paths (chart, diagram). */
export type Graphic = { rect: NormRect; image: boolean; /** Drawing objects merged into it. */ parts: number };

/** What reflow needs from one page. */
export type PageLayout = { lines: TextLine[]; graphics: Graphic[] };

/** A fillable form field (one widget of it); `index` is its annotation index on the page. */
export type FormField = {
  index: number;
  type: 'text' | 'checkbox' | 'radio' | 'combo' | 'list';
  name: string;
  rect: NormRect;
  value: string;
  readOnly: boolean;
  multiline: boolean;
  password: boolean;
  /** List boxes allowing several choices. */
  multiple: boolean;
  checked?: boolean;
  options?: { label: string; selected: boolean }[];
};
/** A markup annotation (from Tessel or any other app); `index` is its annotation index on the page. */
export type Annotation = {
  page: number;
  index: number;
  kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'note' | 'freetext' | 'ink' | 'shape' | 'stamp';
  rect: NormRect;
  /** #rrggbb, when the annotation has a colour. */
  color?: string;
  /** The reader's comment. */
  contents: string;
  author: string;
  /** Text under a highlight / underline / strikeout. */
  quote: string;
};

/** Text for text fields, checked state for check boxes and radios, chosen option indices for choices. */
export type FormValue = string | boolean | number[];

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
  /** Render only this region of the page; `width` then applies to the region. */
  clip?: NormRect;
  signal?: AbortSignal;
};

export interface DocHandle {
  readonly pageCount: number;
  /** Page sizes in PDF points, rotation applied. */
  readonly pageSizes: Size[];
  readonly metadata: DocMetadata;
  /** The PDF has an interactive form. */
  readonly hasForm: boolean;
  renderPage(page: number, opts: RenderOptions): Promise<Raster>;
  outline(): Promise<OutlineItem[]>;
  /** Streams hits per page via onHits; resolves when done or aborted. */
  search(query: string, onHits: (hits: SearchHit[]) => void, signal?: AbortSignal): Promise<void>;
  /** Selectable text, line by line. Engines without text extraction return []. */
  pageText(page: number): Promise<TextRun[]>;
  /** Link annotations plus URLs detected in the text. */
  links(page: number): Promise<PageLink[]>;
  /** Lines with typography plus drawings, for reflow, for a batch of pages. Engines without text extraction return null. */
  layout(pages: number[]): Promise<PageLayout[] | null>;
  /** Fillable fields on a page ([] when none, or the engine can't fill forms). */
  fields(page: number): Promise<FormField[]>;
  /** Sets a field; resolves with the page's fields afterwards (radio groups change together). */
  setField(page: number, index: number, value: FormValue): Promise<FormField[]>;
  /** Markup annotations on all pages, in page order. */
  annotations(): Promise<Annotation[]>;
  /** Highlights text covering `rects` (one per line) on a page, with an optional comment. */
  addHighlight(page: number, rects: NormRect[], color: string, contents?: string): Promise<void>;
  updateAnnotation(page: number, index: number, patch: { contents?: string; color?: string }): Promise<void>;
  removeAnnotation(page: number, index: number): Promise<void>;
  /** The document with all edits, as PDF bytes. */
  save(): Promise<ArrayBuffer>;
  /** The file as it is: the bytes it was opened from, or (with unsaved edits) as save() writes it. */
  bytes(): Promise<ArrayBuffer>;
  /** The file with invisible text over recognised words (an incremental update to bytes()); the handle is unchanged. */
  addTextLayer(pages: PageWords[]): Promise<ArrayBuffer>;
  close(): void;
}

export interface DocumentEngine {
  open(source: DocSource, password?: string): Promise<DocHandle>;
  /** Encoded cover image of page 1 for the library (Blob on web, file URI on native). */
  renderCover(source: DocSource, width: number, password?: string): Promise<{ cover: Blob | string; handle: DocHandle }>;
  /** Gets the engine going ahead of a document (it loads and compiles PDFium once). */
  warm?(): void;
}
