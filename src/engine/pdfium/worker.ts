/// <reference lib="webworker" />
/**
 * PDFium worker. Owns all WASM state; the main thread only sees bitmaps and plain data.
 * Scheduling: control ops FIFO > renders LIFO (newest = most likely visible) > covers > search slices.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

import type { NormRect, OutlineItem, PageLink, SearchHit, Size, TextLine, TextRun } from '../types';
import type { OpenResult, Request, Response } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10; // emit RGBA instead of BGRA
const FPDFBitmap_BGRA = 4;
const PDFACTION_GOTO = 1;
const PDFACTION_URI = 3;
const FPDF_ERR_PASSWORD = 4;
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

function open(bytes: ArrayBuffer, password = ''): OpenResult {
  const len = bytes.byteLength;
  const buf = malloc(len);
  heap().set(new Uint8Array(bytes), buf);
  const ptr = M.FPDF_LoadMemDocument(buf, len, password);
  if (!ptr) {
    free(buf);
    const code = M.FPDF_GetLastError();
    // Message tokens are parsed by asPasswordError on the main thread.
    if (code === FPDF_ERR_PASSWORD) throw new Error(password ? 'password-wrong' : 'password-required');
    throw new Error(`Could not open PDF (error ${code}).`);
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

/**
 * Opens a page + text page and hands `fn` a converter from page space to normalized
 * top-left rects (rotation and crop box handled by PageToDevice).
 */
function withTextPage<T>(d: Doc, pageIndex: number, fallback: T, fn: (page: number, text: number, norm: (l: number, t: number, r: number, b: number) => NormRect) => T): T {
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) return fallback;
  const text = M.FPDFText_LoadPage(page);
  const { width, height } = d.pageSizes[pageIndex];
  const DW = 10000;
  const DH = Math.round((DW * height) / width);
  try {
    if (!text) return fallback;
    return withScratch(8, (s) => {
      const devCall = (x: number, y: number) => {
        M.FPDF_PageToDevice(page, 0, 0, DW, DH, 0, x, y, s, s + 4);
        return [M.pdfium.getValue(s, 'i32') / DW, M.pdfium.getValue(s + 4, 'i32') / DH];
      };
      // Page→device is affine: sample it at three points once, then transform in JS
      // (two WASM calls per character otherwise dominated text extraction).
      const K = 1000;
      const [ox, oy] = devCall(0, 0);
      const [ax, ay] = devCall(K, 0);
      const [bx, by] = devCall(0, K);
      const [a1, a2, b1, b2] = [(ax - ox) / K, (ay - oy) / K, (bx - ox) / K, (by - oy) / K];
      const dev = (x: number, y: number) => [ox + a1 * x + b1 * y, oy + a2 * x + b2 * y];
      const norm = (l: number, t: number, r: number, b: number): NormRect => {
        const [x0, y0] = dev(l, t);
        const [x1, y1] = dev(r, b);
        return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      };
      return fn(page, text, norm);
    });
  } finally {
    if (text) M.FPDFText_ClosePage(text);
    M.FPDF_ClosePage(page);
  }
}

/** Groups characters into same-line runs for the selectable text layer. */
function pageText(docId: number, pageIndex: number): TextRun[] {
  const d = getDoc(docId);
  return withTextPage(d, pageIndex, [], (_page, text, norm) => {
    const runs: TextRun[] = [];
    const n = M.FPDFText_CountChars(text);
    let cur: (TextRun & { right: number }) | null = null;
    const flush = (eol: boolean) => {
      if (cur && cur.text.trim()) runs.push({ text: cur.text.replace(/\s+$/, ''), rect: cur.rect, eol });
      cur = null;
    };
    withScratch(16, (box) => {
      for (let i = 0; i < n; i++) {
        const code = M.FPDFText_GetUnicode(text, i);
        const ch = String.fromCharCode(code);
        if (ch === '\r' || ch === '\n') {
          flush(true);
          continue;
        }
        // FS_RECTF {left, top, right, bottom}; the loose box spans the font's ascent..descent.
        const has = M.FPDFText_GetLooseCharBox(text, i, box);
        const [l, t, r, b] = [0, 4, 8, 12].map((o) => M.pdfium.getValue(box + o, 'float'));
        if (!has || r <= l || t <= b) {
          if (cur && ch === ' ') cur.text += ' ';
          continue;
        }
        const rc = norm(l, t, r, b);
        const c = cur as (TextRun & { right: number }) | null;
        const sameLine = c && Math.abs(rc.y + rc.h / 2 - (c.rect.y + c.rect.h / 2)) < Math.min(rc.h, c.rect.h) * 0.5;
        const gap = c ? rc.x - c.right : 0;
        if (c && sameLine && gap < c.rect.h * 1.5 && gap > -c.rect.h) {
          if (gap > c.rect.h * 0.2 && !c.text.endsWith(' ')) c.text += ' ';
          c.text += ch;
          const x1 = Math.max(c.right, rc.x + rc.w);
          const y0 = Math.min(c.rect.y, rc.y);
          const y1 = Math.max(c.rect.y + c.rect.h, rc.y + rc.h);
          c.rect = { x: c.rect.x, y: y0, w: x1 - c.rect.x, h: y1 - y0 };
          c.right = x1;
        } else {
          flush(!!c && !sameLine);
          cur = { text: ch, rect: rc, eol: false, right: rc.x + rc.w };
        }
      }
    });
    flush(true);
    return runs;
  });
}

type Role = { type: string; sid: number };
// Inline structure types take the role of their block parent.
const INLINE_ROLES = /^(Span|Link|Lbl|Quote|Note|Reference|BibEntry|Code|Em|Strong|Annot|Ruby|Warichu|Sub)$/;

/** Tagged PDFs: map marked-content ids on this page to their block-level structure element. */
function structRoles(page: number): Map<number, Role> | null {
  const tree = M.FPDF_StructTree_GetForPage(page);
  if (!tree) return null;
  const map = new Map<number, Role>();
  let sid = 0;
  let budget = 20000;
  const walk = (el: number, inherited: Role | undefined, depth: number) => {
    if (!el || budget-- <= 0 || depth > 40) return;
    const type = readUtf16((b, l) => M.FPDF_StructElement_GetType(el, b, l)) || 'Span';
    // Inline types, and the label/body/paragraph parts of a list item, belong to their parent block.
    const inList = inherited && /^(LI|LBody)$/.test(inherited.type) && /^(P|LBody|Lbl|Span)$/.test(type);
    const role = inherited && (INLINE_ROLES.test(type) || inList) ? inherited : { type, sid: ++sid };
    // Kids are either elements or marked-content refs; per-child MCIDs are scoped to this page
    // (an element's full MCID list spans pages, and MCIDs restart on every page).
    const c = M.FPDF_StructElement_CountChildren(el);
    for (let i = 0; i < c; i++) {
      const child = M.FPDF_StructElement_GetChildAtIndex(el, i);
      if (child) walk(child, role, depth + 1);
      else {
        const mcid = M.FPDF_StructElement_GetChildMarkedContentID(el, i);
        if (mcid >= 0) map.set(mcid, role);
      }
    }
  };
  const top = M.FPDF_StructTree_CountChildren(tree);
  for (let i = 0; i < top; i++) walk(M.FPDF_StructTree_GetChildAtIndex(tree, i), undefined, 0);
  M.FPDF_StructTree_Close(tree);
  return map.size ? map : null;
}

/** Lines with typography for reflow; in tagged PDFs, untagged characters (artifacts: headers, footers) are dropped. */
function pageLines(docId: number, pageIndex: number): TextLine[] {
  const d = getDoc(docId);
  return withTextPage(d, pageIndex, [], (page, text, norm) => {
    const roles = structRoles(page);
    const lines: TextLine[] = [];
    const n = M.FPDFText_CountChars(text);
    let cur: (TextLine & { right: number }) | null = null;
    const flush = () => {
      const c = cur;
      cur = null;
      if (!c) return;
      const trimmed = c.text.replace(/\s+$/, '');
      if (!trimmed) return;
      lines.push({ text: trimmed, rect: c.rect, size: c.size, bold: c.bold, italic: c.italic, hyphen: c.hyphen || /[-\u00ad]$/.test(trimmed), role: c.role, sid: c.sid });
    };
    withScratch(80, (s) => {
      const box = s;
      const flags = s + 16;
      const nameBuf = s + 20;
      for (let i = 0; i < n; i++) {
        const ch = String.fromCharCode(M.FPDFText_GetUnicode(text, i));
        if (ch === '\r' || ch === '\n') {
          if (cur && M.FPDFText_IsHyphen(text, i - 1)) cur.hyphen = true;
          flush();
          continue;
        }
        let role: Role | undefined;
        if (roles) {
          const obj = M.FPDFText_GetTextObject(text, i);
          role = obj ? roles.get(M.FPDFPageObj_GetMarkedContentID(obj)) : undefined;
          if (!role) continue; // artifact
        }
        const has = M.FPDFText_GetLooseCharBox(text, i, box);
        const [l, t, r, b] = [0, 4, 8, 12].map((o) => M.pdfium.getValue(box + o, 'float'));
        if (!has || r <= l || t <= b) {
          if (cur && ch === ' ') cur.text += ' ';
          continue;
        }
        const rc = norm(l, t, r, b);
        const c = cur as (TextLine & { right: number }) | null;
        const sameLine = c && Math.abs(rc.y + rc.h / 2 - (c.rect.y + c.rect.h / 2)) < Math.min(rc.h, c.rect.h) * 0.5;
        const gap = c ? rc.x - c.right : 0;
        if (c && sameLine && c.sid === role?.sid && gap < c.rect.h * 1.5 && gap > -c.rect.h) {
          if (gap > c.rect.h * 0.2 && !c.text.endsWith(' ')) c.text += ' ';
          c.text += ch;
          const x1 = Math.max(c.right, rc.x + rc.w);
          const y0 = Math.min(c.rect.y, rc.y);
          const y1 = Math.max(c.rect.y + c.rect.h, rc.y + rc.h);
          c.rect = { x: c.rect.x, y: y0, w: x1 - c.rect.x, h: y1 - y0 };
          c.right = x1;
        } else {
          flush();
          // Typography from the line's first glyph.
          const weight = M.FPDFText_GetFontWeight(text, i);
          M.FPDFText_GetFontInfo(text, i, nameBuf, 60, flags);
          const fontName = M.pdfium.UTF8ToString(nameBuf);
          const f = M.pdfium.getValue(flags, 'i32');
          cur = {
            text: ch,
            rect: rc,
            right: rc.x + rc.w,
            size: Math.round(M.FPDFText_GetFontSize(text, i) * 10) / 10,
            bold: weight >= 600 || (f & 0x40000) !== 0 || /bold|black|heavy|semibold/i.test(fontName),
            italic: (f & 0x40) !== 0 || /italic|oblique/i.test(fontName),
            hyphen: false,
            role: role?.type,
            sid: role?.sid,
          };
        }
      }
    });
    flush();
    return lines;
  });
}

const SAFE_URL = /^(https?:|mailto:)/i;

function pageLinks(docId: number, pageIndex: number): PageLink[] {
  const d = getDoc(docId);
  return withTextPage(d, pageIndex, [], (page, text, norm) => {
    const out: PageLink[] = [];
    withScratch(24, (s) => {
      const [pos, link, rect] = [s, s + 4, s + 8];
      M.pdfium.setValue(pos, 0, 'i32');
      // Annotation links: internal destinations and URI actions.
      while (M.FPDFLink_Enumerate(page, pos, link)) {
        const l = M.pdfium.getValue(link, 'i32');
        if (!M.FPDFLink_GetAnnotRect(l, rect)) continue;
        const [x0, y0, x1, y1] = [0, 4, 8, 12].map((o) => M.pdfium.getValue(rect + o, 'float'));
        const r = norm(Math.min(x0, x1), Math.max(y0, y1), Math.max(x0, x1), Math.min(y0, y1));
        let dest = M.FPDFLink_GetDest(d.ptr, l);
        const action = dest ? 0 : M.FPDFLink_GetAction(l);
        const type = action ? M.FPDFAction_GetType(action) : 0;
        if (!dest && type === PDFACTION_GOTO) dest = M.FPDFAction_GetDest(d.ptr, action);
        if (dest) {
          const target = M.FPDFDest_GetDestPageIndex(d.ptr, dest);
          if (target >= 0) out.push({ kind: 'page', page: target, rect: r });
        } else if (type === PDFACTION_URI) {
          const n = M.FPDFAction_GetURIPath(d.ptr, action, 0, 0);
          const url = n > 1 ? withScratch(n, (b) => (M.FPDFAction_GetURIPath(d.ptr, action, b, n), M.pdfium.UTF8ToString(b))) : '';
          if (SAFE_URL.test(url)) out.push({ kind: 'url', url, rect: r });
        }
      }
    });
    // Plain-text URLs, unless an annotation already covers them.
    const web = M.FPDFLink_LoadWebLinks(text);
    if (web) {
      withScratch(32, (s) => {
        for (let i = 0; i < M.FPDFLink_CountWebLinks(web); i++) {
          const n = M.FPDFLink_GetURL(web, i, 0, 0);
          if (n <= 1) continue;
          const url = withScratch(n * 2, (b) => (M.FPDFLink_GetURL(web, i, b, n), M.pdfium.UTF16ToString(b)));
          if (!SAFE_URL.test(url)) continue;
          for (let j = 0; j < M.FPDFLink_CountRects(web, i); j++) {
            M.FPDFLink_GetRect(web, i, j, s, s + 8, s + 16, s + 24);
            const [l, t, r2, b] = [0, 8, 16, 24].map((o) => M.pdfium.getValue(s + o, 'double'));
            const rc = norm(l, t, r2, b);
            const covered = out.some((o) => rc.x < o.rect.x + o.rect.w && rc.x + rc.w > o.rect.x && rc.y < o.rect.y + o.rect.h && rc.y + rc.h > o.rect.y);
            if (!covered) out.push({ kind: 'url', url, rect: rc });
          }
        }
      });
      M.FPDFLink_CloseWebLinks(web);
    }
    return out;
  });
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
      const r = open(job.bytes, job.password);
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
    case 'text':
      return post({ id: job.id, ok: true, result: pageText(job.doc, job.page) });
    case 'links':
      return post({ id: job.id, ok: true, result: pageLinks(job.doc, job.page) });
    case 'lines':
      return post({ id: job.id, ok: true, result: job.pages.map((pg) => pageLines(job.doc, pg)) });
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
