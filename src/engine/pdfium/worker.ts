/// <reference lib="webworker" />
/**
 * PDFium worker. Owns all WASM state; the main thread only sees bitmaps and plain data.
 * Scheduling: control ops FIFO > renders LIFO (newest = most likely visible) > covers > search slices.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

import type { OutlineItem, SearchHit, Size } from '../types';
import type { OpenResult, Request, Response } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10; // emit RGBA instead of BGRA
const FPDFBitmap_BGRA = 4;
const PDFACTION_GOTO = 1;
const MAX_DIM = 8192;
const MAX_PIXELS = 32e6;
const SEARCH_PAGES_PER_SLICE = 8;

type Doc = { ptr: number; buf: number; pageSizes: Size[] };
type SearchJob = Extract<Request, { type: 'search' }> & { cursor: number; textPtr: number };
type Job = Exclude<Request, { type: 'cancel' }> | SearchJob;

const wasmUrl = new URL('./pdfium.wasm', self.location.href).href;

const ready: Promise<WrappedPdfiumModule> = init({
  instantiateWasm(imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
    WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
      .catch(() => fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b, imports)))
      .then((r) => receive(r.instance, r.module));
    return {};
  },
} as never).then((m) => {
  m.PDFiumExt_Init();
  return m;
});

let M: WrappedPdfiumModule;
const docs = new Map<number, Doc>();
let nextDoc = 1;

// ---------- memory helpers ----------

const heap = () => (M.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
const malloc = (n: number) => M.pdfium.wasmExports.malloc(n);
const free = (p: number) => M.pdfium.wasmExports.free(p);

function withScratch<T>(bytes: number, fn: (p: number) => T): T {
  const p = malloc(bytes);
  try {
    return fn(p);
  } finally {
    free(p);
  }
}

/** Reads a UTF-16LE string from a PDFium "(buf, buflen) -> bytes" style getter. */
function readUtf16(get: (buf: number, len: number) => number): string {
  const n = get(0, 0);
  if (n <= 2) return '';
  return withScratch(n, (p) => {
    get(p, n);
    return M.pdfium.UTF16ToString(p);
  });
}

function getDoc(id: number): Doc {
  const d = docs.get(id);
  if (!d) throw new Error('Document closed');
  return d;
}

// ---------- operations ----------

function open(bytes: ArrayBuffer): OpenResult {
  const len = bytes.byteLength;
  const buf = malloc(len);
  heap().set(new Uint8Array(bytes), buf);
  const ptr = M.FPDF_LoadMemDocument(buf, len, '');
  if (!ptr) {
    free(buf);
    const code = M.FPDF_GetLastError();
    throw new Error(code === 4 ? 'This PDF is password protected.' : `Could not open PDF (error ${code}).`);
  }
  const pageCount = M.FPDF_GetPageCount(ptr);
  const pageSizes: Size[] = withScratch(8, (s) => {
    const out: Size[] = [];
    for (let i = 0; i < pageCount; i++) {
      M.FPDF_GetPageSizeByIndexF(ptr, i, s);
      out.push({ width: M.pdfium.getValue(s, 'float'), height: M.pdfium.getValue(s + 4, 'float') });
    }
    return out;
  });
  const meta = (tag: string) => readUtf16((b, l) => M.FPDF_GetMetaText(ptr, tag, b, l)).trim() || undefined;
  const doc = nextDoc++;
  docs.set(doc, { ptr, buf, pageSizes });
  return { doc, pageCount, pageSizes, metadata: { title: meta('Title'), author: meta('Author') } };
}

function rasterize(docId: number, pageIndex: number, width: number): ImageData {
  const d = getDoc(docId);
  const size = d.pageSizes[pageIndex];
  let w = Math.min(Math.round(width), MAX_DIM);
  let h = Math.round((w * size.height) / size.width);
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) throw new Error(`Could not load page ${pageIndex + 1}`);
  const bmp = M.FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, 0, 0);
  try {
    M.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    M.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
    const p = M.FPDFBitmap_GetBuffer(bmp);
    const stride = M.FPDFBitmap_GetStride(bmp);
    const src = heap();
    const out = new Uint8ClampedArray(w * h * 4);
    if (stride === w * 4) out.set(src.subarray(p, p + out.length));
    else for (let y = 0; y < h; y++) out.set(src.subarray(p + y * stride, p + y * stride + w * 4), y * w * 4);
    return new ImageData(out, w, h);
  } finally {
    M.FPDFBitmap_Destroy(bmp);
    M.FPDF_ClosePage(page);
  }
}

async function render(docId: number, page: number, width: number) {
  const img = rasterize(docId, page, width);
  const bitmap = await createImageBitmap(img);
  return { bitmap, width: img.width, height: img.height };
}

async function cover(docId: number, width: number): Promise<Blob> {
  const img = rasterize(docId, 0, width);
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
}

function outline(docId: number): OutlineItem[] {
  const { ptr } = getDoc(docId);
  let budget = 5000; // guards against cyclic outlines
  const walk = (parent: number, depth: number): OutlineItem[] => {
    const items: OutlineItem[] = [];
    let bm = M.FPDFBookmark_GetFirstChild(ptr, parent);
    while (bm && budget-- > 0) {
      let dest = M.FPDFBookmark_GetDest(ptr, bm);
      if (!dest) {
        const action = M.FPDFBookmark_GetAction(bm);
        if (action && M.FPDFAction_GetType(action) === PDFACTION_GOTO) dest = M.FPDFAction_GetDest(ptr, action);
      }
      items.push({
        title: readUtf16((b, l) => M.FPDFBookmark_GetTitle(bm, b, l)).trim(),
        page: dest ? M.FPDFDest_GetDestPageIndex(ptr, dest) : -1,
        children: depth < 8 ? walk(bm, depth + 1) : [],
      });
      bm = M.FPDFBookmark_GetNextSibling(ptr, bm);
    }
    return items;
  };
  return walk(0, 0);
}

function searchPage(d: Doc, pageIndex: number, textPtr: number): SearchHit[] {
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) return [];
  const text = M.FPDFText_LoadPage(page);
  const hits: SearchHit[] = [];
  try {
    if (!text) return hits;
    const total = M.FPDFText_CountChars(text);
    const { width, height } = d.pageSizes[pageIndex];
    // PageToDevice yields ints; use a large virtual device for sub-point precision.
    const DW = 10000;
    const DH = Math.round((DW * height) / width);
    const find = M.FPDFText_FindStart(text, textPtr, 0, 0);
    withScratch(48, (s) => {
      const [l, t, r, b, dx, dy] = [s, s + 8, s + 16, s + 24, s + 32, s + 40];
      const toDevice = (x: number, y: number) => {
        M.FPDF_PageToDevice(page, 0, 0, DW, DH, 0, x, y, dx, dy);
        return [M.pdfium.getValue(dx, 'i32') / DW, M.pdfium.getValue(dy, 'i32') / DH];
      };
      while (M.FPDFText_FindNext(find)) {
        const idx = M.FPDFText_GetSchResultIndex(find);
        const cnt = M.FPDFText_GetSchCount(find);
        const rects = [];
        const n = M.FPDFText_CountRects(text, idx, cnt);
        for (let i = 0; i < n; i++) {
          M.FPDFText_GetRect(text, i, l, t, r, b);
          const [x0, y0] = toDevice(M.pdfium.getValue(l, 'double'), M.pdfium.getValue(t, 'double'));
          const [x1, y1] = toDevice(M.pdfium.getValue(r, 'double'), M.pdfium.getValue(b, 'double'));
          rects.push({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
        }
        const from = Math.max(0, idx - 40);
        const count = Math.min(total, idx + cnt + 60) - from;
        const snippet = withScratch((count + 1) * 2, (p) => {
          M.FPDFText_GetText(text, from, count, p);
          return M.pdfium.UTF16ToString(p).replace(/[\r\n\t\u0002￾]/g, ' ');
        });
        hits.push({ page: pageIndex, rects, snippet, matchStart: idx - from, matchLength: cnt });
        if (hits.length >= 200) break;
      }
    });
    M.FPDFText_FindClose(find);
  } finally {
    if (text) M.FPDFText_ClosePage(text);
    M.FPDF_ClosePage(page);
  }
  return hits;
}

/** Runs one slice; returns true when the search is finished. */
function searchSlice(job: SearchJob): boolean {
  const d = getDoc(job.doc);
  const end = Math.min(d.pageSizes.length, job.cursor + SEARCH_PAGES_PER_SLICE);
  const batch: SearchHit[] = [];
  for (; job.cursor < end; job.cursor++) batch.push(...searchPage(d, job.cursor, job.textPtr));
  if (batch.length) post({ id: job.id, progress: batch });
  return job.cursor >= d.pageSizes.length;
}

function close(docId: number) {
  const d = docs.get(docId);
  if (!d) return;
  M.FPDF_CloseDocument(d.ptr);
  free(d.buf);
  docs.delete(docId);
}

// ---------- scheduler ----------

const queue: Job[] = [];
let busy = false;

function post(msg: Response, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function takeNext(): Job {
  const pick = (pred: (j: Job) => boolean, newest = false) => {
    const idx = newest ? queue.findLastIndex(pred) : queue.findIndex(pred);
    return idx >= 0 ? queue.splice(idx, 1)[0] : undefined;
  };
  return (
    pick((j) => j.type === 'open' || j.type === 'close' || j.type === 'outline') ??
    pick((j) => j.type === 'render', true) ??
    pick((j) => j.type === 'cover') ??
    queue.shift()!
  );
}

function releaseSearch(job: Job) {
  if ('textPtr' in job && job.textPtr) free(job.textPtr);
}

async function run(job: Job) {
  switch (job.type) {
    case 'open': {
      const r = open(job.bytes);
      return post({ id: job.id, ok: true, result: r });
    }
    case 'render': {
      const r = await render(job.doc, job.page, job.width);
      return post({ id: job.id, ok: true, result: r }, [r.bitmap]);
    }
    case 'cover':
      return post({ id: job.id, ok: true, result: await cover(job.doc, job.width) });
    case 'outline':
      return post({ id: job.id, ok: true, result: outline(job.doc) });
    case 'close':
      close(job.doc);
      return post({ id: job.id, ok: true, result: null });
    case 'search': {
      const s = job as SearchJob;
      if (!s.textPtr) {
        const n = (s.query.length + 1) * 2;
        s.textPtr = malloc(n);
        M.pdfium.stringToUTF16(s.query, s.textPtr, n);
        s.cursor = 0;
      }
      if (searchSlice(s)) {
        releaseSearch(s);
        post({ id: s.id, ok: true, result: null });
      } else {
        queue.push(s); // yield so renders can interleave
      }
    }
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  M ??= await ready;
  try {
    while (queue.length) {
      const job = takeNext();
      try {
        await run(job);
      } catch (e) {
        releaseSearch(job);
        post({ id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  if (req.type === 'cancel') {
    const idx = queue.findIndex((j) => j.id === req.target);
    if (idx >= 0) {
      const [job] = queue.splice(idx, 1);
      releaseSearch(job);
      post({ id: job.id, ok: false, error: 'aborted' });
    }
    return;
  }
  queue.push(req as Job);
  pump();
};
