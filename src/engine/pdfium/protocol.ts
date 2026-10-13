import type { Annotation, DocMetadata, FormField, FormValue, NormRect, OutlineItem, PageLayout, PageLink, SearchHit, Size, TextRun } from '../types';

export type Request =
  | { id: number; type: 'open'; bytes: ArrayBuffer; password?: string }
  | { id: number; type: 'render'; doc: number; page: number; width: number; clip?: NormRect }
  | { id: number; type: 'cover'; doc: number; width: number }
  | { id: number; type: 'outline'; doc: number }
  | { id: number; type: 'text'; doc: number; page: number }
  | { id: number; type: 'links'; doc: number; page: number }
  | { id: number; type: 'layout'; doc: number; pages: number[] }
  | { id: number; type: 'fields'; doc: number; page: number }
  | { id: number; type: 'setField'; doc: number; page: number; index: number; value: FormValue }
  | { id: number; type: 'save'; doc: number }
  | { id: number; type: 'bytes'; doc: number }
  | { id: number; type: 'annots'; doc: number }
  | { id: number; type: 'addHighlight'; doc: number; page: number; rects: NormRect[]; color: string; contents?: string }
  | { id: number; type: 'updateAnnot'; doc: number; page: number; index: number; contents?: string; color?: string }
  | { id: number; type: 'removeAnnot'; doc: number; page: number; index: number }
  | { id: number; type: 'search'; doc: number; query: string }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'close'; doc: number };

export type OpenResult = { doc: number; pageCount: number; pageSizes: Size[]; metadata: DocMetadata; hasForm: boolean };

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
  fields: FormField[];
  setField: FormField[];
  save: ArrayBuffer;
  bytes: ArrayBuffer;
  annots: Annotation[];
  addHighlight: null;
  updateAnnot: null;
  removeAnnot: null;
  search: null;
  cancel: null;
  close: null;
};
