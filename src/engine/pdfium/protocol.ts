import type { DocMetadata, NormRect, OutlineItem, PageLayout, PageLink, SearchHit, Size, TextRun } from '../types';

export type Request =
  | { id: number; type: 'open'; bytes: ArrayBuffer; password?: string }
  | { id: number; type: 'render'; doc: number; page: number; width: number; clip?: NormRect }
  | { id: number; type: 'cover'; doc: number; width: number }
  | { id: number; type: 'outline'; doc: number }
  | { id: number; type: 'text'; doc: number; page: number }
  | { id: number; type: 'links'; doc: number; page: number }
  | { id: number; type: 'layout'; doc: number; pages: number[] }
  | { id: number; type: 'search'; doc: number; query: string }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'close'; doc: number };

export type OpenResult = { doc: number; pageCount: number; pageSizes: Size[]; metadata: DocMetadata };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: SearchHit[] };

export type ResultMap = {
  open: OpenResult;
  render: { bitmap: ImageBitmap; width: number; height: number };
  cover: Blob;
  outline: OutlineItem[];
  text: TextRun[];
  links: PageLink[];
  layout: PageLayout[];
  search: null;
  cancel: null;
  close: null;
};
