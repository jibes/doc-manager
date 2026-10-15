/// <reference lib="webworker" />
/**
 * PDFium worker. Owns all WASM state; the main thread only sees bitmaps and plain data.
 * Scheduling: control ops FIFO > renders LIFO (newest = most likely visible) > covers > search slices.
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium';

import { mergeGraphics } from '../geometry';
import type { Annotation, FormField, FormValue, Graphic, NormRect, OutlineItem, PageLayout, PageLink, SearchHit, Size, TextLine, TextRun } from '../types';
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
const FPDF_PAGEOBJ_PATH = 2;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_SHADING = 4;
const FPDF_PAGEOBJ_FORM = 5;
/** Beyond this many drawing objects a page is one big drawing (map, plot with thousands of points). */
const MAX_GRAPHIC_OBJECTS = 1500;
const FORMTYPE_NONE = 0;
/** Soft blue behind fillable fields, as COLORREF (0x00BBGGRR). */
const FIELD_HIGHLIGHT = 0xf5e2c8;
const FPDF_ANNOT_WIDGET = 20;
const FIELD_TYPES: Record<number, FormField['type']> = { 2: 'checkbox', 3: 'radio', 4: 'combo', 5: 'list', 6: 'text' };
const FF_READONLY = 1 << 0;
const FF_MULTILINE = 1 << 12;
const FF_PASSWORD = 1 << 13;
const FF_MULTISELECT = 1 << 21;
const FPDF_ANNOT_HIGHLIGHT = 9;
const ANNOT_KINDS: Record<number, Annotation['kind']> = {
  1: 'note',
  3: 'freetext',
  4: 'shape',
  5: 'shape',
  6: 'shape',
  7: 'shape',
  8: 'shape',
  9: 'highlight',
  10: 'underline',
  11: 'squiggly',
  12: 'strikeout',
  13: 'stamp',
  15: 'ink',
};

/**
 * `form`: PDFium's form-fill environment (null when the PDF has no form). `edited`: changed since it was opened
 * (a save, print or share doesn't undo that: the bytes it was opened from no longer are the document).
 */
type Doc = { ptr: number; buf: number; len: number; pageSizes: Size[]; formInfo: number; form: number; edited: boolean };
type SearchJob = Extract<Request, { type: 'search' }> & { cursor: number; textPtr: number };
type Job = Exclude<Request, { type: 'cancel' }> | SearchJob;

const wasmUrl = new URL('./pdfium.wasm', self.location.href).href;

const ready: Promise<WrappedPdfiumModule> = init({
  instantiateWasm(imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
    WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)
      .catch(() =>
        fetch(wasmUrl)
          .then((r) => r.arrayBuffer())
          .then((b) => WebAssembly.instantiate(b, imports)),
      )
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
  // Forms: PDFium keeps field values and regenerates their appearance as they change.
  const hasForm = M.FPDF_GetFormType(ptr) !== FORMTYPE_NONE;
  const formInfo = hasForm ? M.PDFiumExt_OpenFormFillInfo() : 0;
  const form = hasForm ? M.PDFiumExt_InitFormFillEnvironment(ptr, formInfo) : 0;
  if (form) {
    M.FPDF_SetFormFieldHighlightColor(form, 0, FIELD_HIGHLIGHT);
    M.FPDF_SetFormFieldHighlightAlpha(form, 60);
  }
  docs.set(doc, { ptr, buf, len, pageSizes, formInfo, form, edited: false });
  // Entries kept as they are when Tessel rewrites the details.
  const other: Record<string, string> = {};
  for (const key of ['Creator', 'Producer', 'CreationDate', 'Trapped']) {
    const v = meta(key);
    if (v) other[key] = v;
  }
  const date = meta('DocumentDate');
  return {
    doc,
    pageCount,
    pageSizes,
    metadata: { title: meta('Title'), author: meta('Author'), subject: meta('Subject'), keywords: meta('Keywords'), date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined, other },
    hasForm: !!form,
  };
}

/** Renders a page (or the `clip` region of it) so the output is `width` pixels wide. */
function rasterize(docId: number, pageIndex: number, width: number, clip?: NormRect): ImageData {
  const d = getDoc(docId);
  const size = d.pageSizes[pageIndex];
  const region = clip ?? { x: 0, y: 0, w: 1, h: 1 };
  let w = Math.min(Math.round(width), MAX_DIM);
  let h = Math.round((w * size.height * region.h) / (size.width * region.w));
  if (w * h > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.floor(w * k);
    h = Math.floor(h * k);
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  // Full-page size at this scale; the bitmap is a window onto it.
  const fullW = Math.round(w / region.w);
  const fullH = Math.round(h / region.h);
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) throw new Error(`Could not load page ${pageIndex + 1}`);
  const bmp = M.FPDFBitmap_CreateEx(w, h, FPDFBitmap_BGRA, 0, 0);
  if (d.form) M.FORM_OnAfterLoadPage(page, d.form);
  try {
    M.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
    const [x0, y0] = [-Math.round(region.x * fullW), -Math.round(region.y * fullH)];
    M.FPDF_RenderPageBitmap(bmp, page, x0, y0, fullW, fullH, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
    // Form fields (values, check marks, highlight) are drawn by the form layer on top.
    if (d.form) M.FPDF_FFLDraw(d.form, bmp, page, x0, y0, fullW, fullH, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
    const p = M.FPDFBitmap_GetBuffer(bmp);
    const stride = M.FPDFBitmap_GetStride(bmp);
    const src = heap();
    const out = new Uint8ClampedArray(w * h * 4);
    if (stride === w * 4) out.set(src.subarray(p, p + out.length));
    else for (let y = 0; y < h; y++) out.set(src.subarray(p + y * stride, p + y * stride + w * 4), y * w * 4);
    return new ImageData(out, w, h);
  } finally {
    M.FPDFBitmap_Destroy(bmp);
    if (d.form) M.FORM_OnBeforeClosePage(page, d.form);
    M.FPDF_ClosePage(page);
  }
}

async function render(docId: number, page: number, width: number, clip?: NormRect) {
  const img = rasterize(docId, page, width, clip);
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
        if (hits.length >= 200) {
          hits[hits.length - 1].more = true;
          break;
        }
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
type Norm = (l: number, t: number, r: number, b: number) => NormRect;

/**
 * Page space ↔ normalized top-left space for a loaded page (rotation and crop box via PageToDevice).
 * The mapping is affine: sampled at three points once, then applied in JS
 * (two WASM calls per character otherwise dominated text extraction).
 */
function pageTransform(d: Doc, pageIndex: number, page: number) {
  const { width, height } = d.pageSizes[pageIndex];
  const DW = 10000;
  const DH = Math.round((DW * height) / width);
  const [o, a, b] = withScratch(8, (s) =>
    [
      [0, 0],
      [1000, 0],
      [0, 1000],
    ].map(([x, y]) => {
      M.FPDF_PageToDevice(page, 0, 0, DW, DH, 0, x, y, s, s + 4);
      return [M.pdfium.getValue(s, 'i32') / DW, M.pdfium.getValue(s + 4, 'i32') / DH];
    }),
  );
  const [a1, a2, b1, b2] = [(a[0] - o[0]) / 1000, (a[1] - o[1]) / 1000, (b[0] - o[0]) / 1000, (b[1] - o[1]) / 1000];
  const dev = (x: number, y: number) => [o[0] + a1 * x + b1 * y, o[1] + a2 * x + b2 * y];
  const det = a1 * b2 - a2 * b1;
  const norm: Norm = (l, t, r, bt) => {
    const [x0, y0] = dev(l, t);
    const [x1, y1] = dev(r, bt);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  };
  /** Normalized point → page space. */
  const toPage = (nx: number, ny: number): [number, number] => {
    const [dx, dy] = [nx - o[0], ny - o[1]];
    return [(dx * b2 - dy * b1) / det, (a1 * dy - a2 * dx) / det];
  };
  return { norm, toPage };
}

function withTextPage<T>(d: Doc, pageIndex: number, fallback: T, fn: (page: number, text: number, norm: Norm) => T): T {
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) return fallback;
  const text = M.FPDFText_LoadPage(page);
  try {
    if (!text) return fallback;
    return fn(page, text, pageTransform(d, pageIndex, page).norm);
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
function pageLines(page: number, text: number, norm: Norm): TextLine[] {
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
    lines.push({
      text: trimmed,
      rect: c.rect,
      size: c.size,
      bold: c.bold,
      italic: c.italic,
      hyphen: c.hyphen || /[-\u00ad]$/.test(trimmed),
      role: c.role,
      sid: c.sid,
    });
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
}

/** Images and vector drawings, merged into regions; form XObjects are walked with their matrices applied. */
function pageGraphics(page: number, norm: Norm): Graphic[] {
  const items: Graphic[] = [];
  let budget = MAX_GRAPHIC_OBJECTS;
  let overflow = false;
  withScratch(48, (s) => {
    const f = (o: number) => M.pdfium.getValue(s + o, 'float');
    const visit = (obj: number, m: number[] | null, depth: number) => {
      const type = M.FPDFPageObj_GetType(obj);
      if (type === FPDF_PAGEOBJ_FORM) {
        if (depth > 3) return;
        const fm = M.FPDFPageObj_GetMatrix(obj, s) ? [0, 4, 8, 12, 16, 20].map(f) : [1, 0, 0, 1, 0, 0];
        const total = m ? compose(fm, m) : fm;
        const n = M.FPDFFormObj_CountObjects(obj);
        for (let i = 0; i < n; i++) visit(M.FPDFFormObj_GetObject(obj, i), total, depth + 1);
        return;
      }
      if (type !== FPDF_PAGEOBJ_IMAGE && type !== FPDF_PAGEOBJ_PATH && type !== FPDF_PAGEOBJ_SHADING) return;
      if (budget-- <= 0) return void (overflow = true);
      if (!M.FPDFPageObj_GetBounds(obj, s, s + 4, s + 8, s + 12)) return;
      let [l, b, r, t] = [f(0), f(4), f(8), f(12)];
      if (m) [l, b, r, t] = transformBox(m, l, b, r, t);
      const rect = norm(l, t, r, b);
      const area = rect.w * rect.h;
      if (type === FPDF_PAGEOBJ_IMAGE) return void (area > 1e-5 && items.push({ rect, image: true, parts: 1 }));
      // Page backgrounds and page-wide rules carry no figure. Short hairlines (axes, ticks, table borders)
      // join drawings together but don't count as drawing on their own.
      const thin = rect.w < 0.004 || rect.h < 0.004;
      if (area > 0.5 || (thin && Math.max(rect.w, rect.h) > 0.5)) return;
      items.push({ rect, image: false, parts: thin ? 0 : 1 });
    };
    const n = M.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) visit(M.FPDFPage_GetObject(page, i), null, 0);
  });
  if (overflow) {
    // Too many objects to cluster pairwise: treat them all as one drawing.
    const all = mergeGraphics(items, 1);
    return all.map((g) => ({ ...g, parts: MAX_GRAPHIC_OBJECTS }));
  }
  return mergeGraphics(items);
}

/** PDF matrices [a b c d e f]: apply `inner`, then `outer`. */
function compose(inner: number[], outer: number[]): number[] {
  const [a, b, c, d, e, f] = inner;
  const [A, B, C, D, E, F] = outer;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

function transformBox(m: number[], l: number, b: number, r: number, t: number): [number, number, number, number] {
  const pts = [
    [l, b],
    [r, b],
    [l, t],
    [r, t],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pageLayout(docId: number, pageIndex: number): PageLayout {
  return withTextPage(getDoc(docId), pageIndex, { lines: [], graphics: [] }, (page, text, norm) => ({
    lines: pageLines(page, text, norm),
    graphics: pageGraphics(page, norm),
  }));
}

// ---------- forms ----------

/** Loads a page into the form environment (needed for any form interaction), runs fn, unloads it. */
function withFormPage<T>(d: Doc, pageIndex: number, fn: (page: number) => T): T {
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) throw new Error(`Could not load page ${pageIndex + 1}`);
  M.FORM_OnAfterLoadPage(page, d.form);
  try {
    return fn(page);
  } finally {
    M.FORM_OnBeforeClosePage(page, d.form);
    M.FPDF_ClosePage(page);
  }
}

function annotRect(annot: number): [number, number, number, number] {
  return withScratch(16, (s) => {
    M.FPDFAnnot_GetRect(annot, s);
    return [0, 4, 8, 12].map((o) => M.pdfium.getValue(s + o, 'float')) as [number, number, number, number];
  });
}

/** Fillable fields on a page (push buttons and signatures aside: no scripts run here). */
function formFields(docId: number, pageIndex: number): FormField[] {
  const d = getDoc(docId);
  if (!d.form) return [];
  return withFormPage(d, pageIndex, (page) => {
    const { norm } = pageTransform(d, pageIndex, page);
    const out: FormField[] = [];
    const n = M.FPDFPage_GetAnnotCount(page);
    for (let i = 0; i < n; i++) {
      const annot = M.FPDFPage_GetAnnot(page, i);
      if (!annot) continue;
      try {
        if (M.FPDFAnnot_GetSubtype(annot) !== FPDF_ANNOT_WIDGET) continue;
        const type = FIELD_TYPES[M.FPDFAnnot_GetFormFieldType(d.form, annot)];
        if (!type) continue;
        const flags = M.FPDFAnnot_GetFormFieldFlags(d.form, annot);
        const [l, t, r, b] = annotRect(annot);
        const field: FormField = {
          index: i,
          type,
          name: readUtf16((buf, len) => M.FPDFAnnot_GetFormFieldName(d.form, annot, buf, len)),
          rect: norm(l, t, r, b),
          value: readUtf16((buf, len) => M.FPDFAnnot_GetFormFieldValue(d.form, annot, buf, len)),
          readOnly: (flags & FF_READONLY) !== 0,
          multiline: type === 'text' && (flags & FF_MULTILINE) !== 0,
          password: type === 'text' && (flags & FF_PASSWORD) !== 0,
          multiple: type === 'list' && (flags & FF_MULTISELECT) !== 0,
        };
        if (type === 'checkbox' || type === 'radio') field.checked = M.FPDFAnnot_IsChecked(d.form, annot);
        if (type === 'combo' || type === 'list') {
          const count = M.FPDFAnnot_GetOptionCount(d.form, annot);
          field.options = Array.from({ length: Math.max(0, count) }, (_, k) => ({
            label: readUtf16((buf, len) => M.FPDFAnnot_GetOptionLabel(d.form, annot, k, buf, len)),
            selected: M.FPDFAnnot_IsOptionSelected(d.form, annot, k),
          }));
        }
        out.push(field);
      } finally {
        M.FPDFPage_CloseAnnot(annot);
      }
    }
    return out;
  });
}

/**
 * Sets a field through PDFium's own form handling (focus, edit, click), so appearances, radio groups
 * and calculated state update exactly as in other viewers. Returns the page's fields afterwards.
 */
function setFormField(docId: number, pageIndex: number, index: number, value: FormValue): FormField[] {
  const d = getDoc(docId);
  if (!d.form) return [];
  withFormPage(d, pageIndex, (page) => {
    const annot = M.FPDFPage_GetAnnot(page, index);
    if (!annot) return;
    try {
      const type = FIELD_TYPES[M.FPDFAnnot_GetFormFieldType(d.form, annot)];
      if (type === 'text' && typeof value === 'string') {
        M.FORM_SetFocusedAnnot(d.form, annot);
        M.FORM_SelectAllText(d.form, page);
        const n = (value.length + 1) * 2;
        withScratch(n, (p) => {
          M.pdfium.stringToUTF16(value, p, n);
          M.FORM_ReplaceSelection(d.form, page, p);
        });
      } else if ((type === 'checkbox' || type === 'radio') && typeof value === 'boolean') {
        if (M.FPDFAnnot_IsChecked(d.form, annot) !== value) {
          const [l, t, r, b] = annotRect(annot);
          const [x, y] = [(l + r) / 2, (t + b) / 2];
          M.FORM_OnLButtonDown(d.form, page, 0, x, y);
          M.FORM_OnLButtonUp(d.form, page, 0, x, y);
        }
      } else if ((type === 'combo' || type === 'list') && Array.isArray(value)) {
        M.FORM_SetFocusedAnnot(d.form, annot);
        const count = M.FPDFAnnot_GetOptionCount(d.form, annot);
        // Deselect first (list boxes), then select: PDFium applies each index as it comes.
        for (let k = 0; k < count; k++) if (!value.includes(k)) M.FORM_SetIndexSelected(d.form, page, k, false);
        for (const k of value) M.FORM_SetIndexSelected(d.form, page, k, true);
      }
      M.FORM_ForceToKillFocus(d.form);
      d.edited = true;
    } finally {
      M.FPDFPage_CloseAnnot(annot);
    }
  });
  return formFields(docId, pageIndex);
}

/** The document as it is now (edits included), as PDF bytes. */
function save(docId: number): ArrayBuffer {
  const d = getDoc(docId);
  if (d.form) M.FORM_ForceToKillFocus(d.form);
  const w = M.PDFiumExt_OpenFileWriter();
  try {
    if (!M.PDFiumExt_SaveAsCopy(d.ptr, w)) throw new Error('Could not save the PDF');
    const n = M.PDFiumExt_GetFileWriterSize(w);
    return withScratch(n, (p) => {
      M.PDFiumExt_GetFileWriterData(w, p, n);
      return heap().slice(p, p + n).buffer;
    });
  } finally {
    M.PDFiumExt_CloseFileWriter(w);
  }
}

// ---------- recognised text ----------

const FPDF_TEXTRENDERMODE_INVISIBLE = 3;
/** FPDF_SaveAsCopy flag: append the changes, keeping the file's bytes as they were. */
const FPDF_INCREMENTAL = 1;

/** The next word continues this one's line: overlaps it vertically by half and starts to its right. */
function sameLine(a: NormRect, b: NormRect): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > 0.5 * Math.min(a.h, b.h) && b.x >= a.x + a.w / 2;
}

/**
 * Invisible text over each word recognised on a page (as a scanner's text layer), so the page can be searched,
 * selected and copied. Boxes are normalized to the page as shown (rotation applied); each word is stretched to
 * its box along the line's direction, whatever the page's rotation. Returns the file with the text appended as
 * an incremental update.
 */
function addTextLayer(docId: number, pages: { page: number; turn?: number; words: { text: string; box: NormRect }[] }[]): ArrayBuffer {
  const d = getDoc(docId);
  for (const { page: pageIndex, words, turn = 0 } of pages) {
    if (!words.length) continue;
    const page = M.FPDF_LoadPage(d.ptr, pageIndex);
    if (!page) continue;
    try {
      const { toPage: shownToPage } = pageTransform(d, pageIndex, page);
      // A point of the upright text → the page as shown → page space.
      const toPage = (u: number, v: number) => {
        const [x, y] = [
          [u, v],
          [v, 1 - u],
          [1 - u, 1 - v],
          [1 - v, u],
        ][((turn % 4) + 4) % 4];
        return shownToPage(x, y);
      };
      const { width, height } = d.pageSizes[pageIndex];
      const ptH = turn % 2 ? width : height;
      words.forEach((w, i) => {
        const next = words[i + 1];
        const text = next && sameLine(w.box, next.box) ? `${w.text} ` : w.text;
        const { x, y, w: bw, h: bh } = w.box;
        // Baseline near the bottom of the box; letters fill most of a detected line's height.
        const base = y + bh * 0.8;
        const [x0, y0] = toPage(x, base);
        const [x1, y1] = toPage(x + bw, base);
        const size = bh * ptH * 0.75;
        const length = Math.hypot(x1 - x0, y1 - y0);
        if (!(size > 0.5) || !(length > 0) || ![x0, y0, x1, y1].every(Number.isFinite)) return;
        const obj = M.FPDFPageObj_NewTextObj(d.ptr, 'Helvetica', size);
        if (!obj) return;
        const n = (text.length + 1) * 2;
        const set = withScratch(n, (p) => {
          M.pdfium.stringToUTF16(text, p, n);
          return M.FPDFText_SetText(obj, p);
        });
        M.FPDFTextObj_SetTextRenderMode(obj, FPDF_TEXTRENDERMODE_INVISIBLE);
        // Its natural width at this size (the trailing space excluded), to stretch it onto the box.
        const natural = withScratch(16, (b) => {
          if (!M.FPDFPageObj_GetBounds(obj, b, b + 4, b + 8, b + 12)) return 0;
          return M.pdfium.getValue(b + 8, 'float') - M.pdfium.getValue(b, 'float');
        });
        if (!set || !(natural > 0)) {
          M.FPDFPageObj_Destroy(obj);
          return;
        }
        const ux = (x1 - x0) / length;
        const uy = (y1 - y0) / length;
        const scale = length / natural;
        M.FPDFPageObj_Transform(obj, ux * scale, uy * scale, -uy, ux, x0, y0);
        M.FPDFPage_InsertObject(page, obj);
      });
      if (!M.FPDFPage_GenerateContent(page)) throw new Error('Could not write the text into the page');
    } finally {
      M.FPDF_ClosePage(page);
    }
  }
  const w = M.PDFiumExt_OpenFileWriter();
  try {
    if (!M.FPDF_SaveAsCopy(d.ptr, w, FPDF_INCREMENTAL)) throw new Error('Could not save the PDF');
    const n = M.PDFiumExt_GetFileWriterSize(w);
    return withScratch(n, (p) => {
      M.PDFiumExt_GetFileWriterData(w, p, n);
      return heap().slice(p, p + n).buffer;
    });
  } finally {
    M.PDFiumExt_CloseFileWriter(w);
  }
}

// ---------- annotations ----------

const hex = (n: number) => n.toString(16).padStart(2, '0');

function setWide(annot: number, key: string, value: string) {
  const n = (value.length + 1) * 2;
  withScratch(n, (p) => {
    M.pdfium.stringToUTF16(value, p, n);
    M.FPDFAnnot_SetStringValue(annot, key, p);
  });
}

function setColor(annot: number, color: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  M.FPDFAnnot_SetColor(annot, 0, r, g, b, 255);
}

/** PDF date for the annotation's modified date (`M`). */
function pdfDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Text inside a page-space box (the words under a highlight). */
function boundedText(text: number, l: number, t: number, r: number, b: number): string {
  const n = M.FPDFText_GetBoundedText(text, l, t, r, b, 0, 0);
  if (n <= 0) return '';
  return withScratch((n + 1) * 2, (p) => {
    M.FPDFText_GetBoundedText(text, l, t, r, b, p, n + 1);
    return M.pdfium.UTF16ToString(p);
  });
}

/**
 * Colour from /C; PDFium won't report it once an appearance stream exists, so then it is read from
 * the appearance itself (fill of a highlight, stroke of a line markup or ink).
 */
function annotColor(annot: number, s: number, u: (o: number) => number): string | undefined {
  const rgb = () => `#${hex(u(0))}${hex(u(4))}${hex(u(8))}`;
  if (M.FPDFAnnot_GetColor(annot, 0, s, s + 4, s + 8, s + 12)) return rgb();
  const n = M.FPDFAnnot_GetObjectCount(annot);
  for (let i = 0; i < n; i++) {
    const obj = M.FPDFAnnot_GetObject(annot, i);
    if (!obj || M.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_PATH) continue;
    if (M.FPDFPageObj_GetFillColor(obj, s, s + 4, s + 8, s + 12) && u(12) > 0) return rgb();
    if (M.FPDFPageObj_GetStrokeColor(obj, s, s + 4, s + 8, s + 12)) return rgb();
  }
  return undefined;
}

function pageAnnotations(d: Doc, pageIndex: number): Annotation[] {
  // Most pages have none: their text page (slow to build) isn't needed.
  const bare = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!bare) return [];
  const count = M.FPDFPage_GetAnnotCount(bare);
  M.FPDF_ClosePage(bare);
  if (!count) return [];
  return withTextPage(d, pageIndex, [], (page, text, norm) => {
    const out: Annotation[] = [];
    const n = M.FPDFPage_GetAnnotCount(page);
    withScratch(32, (s) => {
      const u = (o: number) => M.pdfium.getValue(s + o, 'i32') >>> 0;
      const f = (o: number) => M.pdfium.getValue(s + o, 'float');
      for (let i = 0; i < n; i++) {
        const annot = M.FPDFPage_GetAnnot(page, i);
        if (!annot) continue;
        try {
          const kind = ANNOT_KINDS[M.FPDFAnnot_GetSubtype(annot)];
          if (!kind) continue;
          const [l, t, r, b] = annotRect(annot);
          const str = (key: string) => readUtf16((buf, len) => M.FPDFAnnot_GetStringValue(annot, key, buf, len));
          const color = annotColor(annot, s, u);
          // Text under each quad (one per line), in order.
          const quotes: string[] = [];
          const quads = M.FPDFAnnot_CountAttachmentPoints(annot);
          for (let q = 0; q < quads; q++) {
            if (!M.FPDFAnnot_GetAttachmentPoints(annot, q, s)) continue;
            const xs = [0, 8, 16, 24].map(f);
            const ys = [4, 12, 20, 28].map(f);
            quotes.push(boundedText(text, Math.min(...xs), Math.max(...ys), Math.max(...xs), Math.min(...ys)).trim());
          }
          out.push({
            page: pageIndex,
            index: i,
            kind,
            rect: norm(l, t, r, b),
            color,
            contents: str('Contents'),
            author: str('T'),
            quote: quotes.filter(Boolean).join(' ').replace(/\s+/g, ' '),
          });
        } finally {
          M.FPDFPage_CloseAnnot(annot);
        }
      }
    });
    return out;
  });
}

function annotations(docId: number): Annotation[] {
  const d = getDoc(docId);
  return d.pageSizes.flatMap((_, i) => pageAnnotations(d, i));
}

function withPage<T>(d: Doc, pageIndex: number, fn: (page: number) => T): T {
  const page = M.FPDF_LoadPage(d.ptr, pageIndex);
  if (!page) throw new Error(`Could not load page ${pageIndex + 1}`);
  try {
    return fn(page);
  } finally {
    M.FPDF_ClosePage(page);
  }
}

/** A highlight with one quad per selected line; PDFium generates its appearance (multiply-blended colour). */
function addHighlight(docId: number, pageIndex: number, rects: NormRect[], color: string, contents?: string) {
  const d = getDoc(docId);
  withPage(d, pageIndex, (page) => {
    const { toPage } = pageTransform(d, pageIndex, page);
    const annot = M.FPDFPage_CreateAnnot(page, FPDF_ANNOT_HIGHLIGHT);
    if (!annot) throw new Error('Could not create the highlight');
    try {
      setColor(annot, color);
      const xs: number[] = [];
      const ys: number[] = [];
      withScratch(32, (s) => {
        for (const r of rects) {
          // Quad order as Acrobat writes it: top-left, top-right, bottom-left, bottom-right.
          const pts = [toPage(r.x, r.y), toPage(r.x + r.w, r.y), toPage(r.x, r.y + r.h), toPage(r.x + r.w, r.y + r.h)];
          pts.forEach(([x, y], k) => {
            M.pdfium.setValue(s + k * 8, x, 'float');
            M.pdfium.setValue(s + k * 8 + 4, y, 'float');
            xs.push(x);
            ys.push(y);
          });
          M.FPDFAnnot_AppendAttachmentPoints(annot, s);
        }
        [Math.min(...xs), Math.max(...ys), Math.max(...xs), Math.min(...ys)].forEach((v, k) => M.pdfium.setValue(s + k * 4, v, 'float'));
        M.FPDFAnnot_SetRect(annot, s);
      });
      if (contents) setWide(annot, 'Contents', contents);
      setWide(annot, 'M', pdfDate());
      setWide(annot, 'NM', `tessel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    } finally {
      M.FPDFPage_CloseAnnot(annot);
    }
  });
  d.edited = true;
}

function updateAnnot(docId: number, pageIndex: number, index: number, contents?: string, color?: string) {
  const d = getDoc(docId);
  withPage(d, pageIndex, (page) => {
    const annot = M.FPDFPage_GetAnnot(page, index);
    if (!annot) return;
    try {
      if (contents !== undefined) setWide(annot, 'Contents', contents);
      if (color) {
        // A new colour needs a new appearance: drop the old one and PDFium regenerates it.
        M.FPDFAnnot_SetAP(annot, 0, 0);
        setColor(annot, color);
      }
      setWide(annot, 'M', pdfDate());
    } finally {
      M.FPDFPage_CloseAnnot(annot);
    }
  });
  d.edited = true;
}

function removeAnnot(docId: number, pageIndex: number, index: number) {
  const d = getDoc(docId);
  withPage(d, pageIndex, (page) => M.FPDFPage_RemoveAnnot(page, index));
  d.edited = true;
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
            const covered = out.some(
              (o) => rc.x < o.rect.x + o.rect.w && rc.x + rc.w > o.rect.x && rc.y < o.rect.y + o.rect.h && rc.y + rc.h > o.rect.y,
            );
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
  if (d.form) M.PDFiumExt_ExitFormFillEnvironment(d.form);
  if (d.formInfo) M.PDFiumExt_CloseFormFillInfo(d.formInfo);
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
      const r = await render(job.doc, job.page, job.width, job.clip);
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
    case 'layout':
      return post({ id: job.id, ok: true, result: job.pages.map((pg) => pageLayout(job.doc, pg)) });
    case 'fields':
      return post({ id: job.id, ok: true, result: formFields(job.doc, job.page) });
    case 'setField':
      return post({ id: job.id, ok: true, result: setFormField(job.doc, job.page, job.index, job.value) });
    case 'annots':
      return post({ id: job.id, ok: true, result: annotations(job.doc) });
    case 'addHighlight':
      addHighlight(job.doc, job.page, job.rects, job.color, job.contents);
      return post({ id: job.id, ok: true, result: null });
    case 'updateAnnot':
      updateAnnot(job.doc, job.page, job.index, job.contents, job.color);
      return post({ id: job.id, ok: true, result: null });
    case 'removeAnnot':
      removeAnnot(job.doc, job.page, job.index);
      return post({ id: job.id, ok: true, result: null });
    case 'bytes': {
      const d = getDoc(job.doc);
      // Unedited: the bytes it was opened from, so an update appended to them changes nothing else.
      const bytes = d.edited ? save(job.doc) : heap().slice(d.buf, d.buf + d.len).buffer;
      return post({ id: job.id, ok: true, result: bytes }, [bytes]);
    }
    case 'addText': {
      const bytes = addTextLayer(job.doc, job.pages);
      return post({ id: job.id, ok: true, result: bytes }, [bytes]);
    }
    case 'save': {
      const bytes = save(job.doc);
      return post({ id: job.id, ok: true, result: bytes }, [bytes]);
    }
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
