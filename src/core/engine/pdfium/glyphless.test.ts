import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { init } from '@embedpdf/pdfium';

import { GLYPHLESS_WIDTH, layerFont, layerWord } from './glyphless';

const sum = (data: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < data.length; i += 4) s = (s + (((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | (data[i + 3] ?? 0)) >>> 0)) >>> 0;
  return s;
};

describe('text layer font', () => {
  it('is a well-formed TrueType font: tables in order, checksums right', () => {
    const { data } = layerFont(['Grüße 中文 😀 ']);
    const view = new DataView(data.buffer);
    const n = view.getUint16(4);
    const tags: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = 12 + i * 16;
      const tag = String.fromCharCode(...data.subarray(at, at + 4));
      tags.push(tag);
      const [offset, length] = [view.getUint32(at + 8), view.getUint32(at + 12)];
      const table = data.slice(offset, offset + ((length + 3) & ~3));
      // head's sum is taken with its checkSumAdjustment as 0.
      if (tag === 'head') table.fill(0, 8, 12);
      expect(sum(table), tag).toBe(view.getUint32(at + 4));
    }
    expect(tags).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    expect(sum(data)).toBe(0xb1b0afba);
  });

  it('gives each character its own glyph, in order', () => {
    const { charcodes } = layerFont(['ba ', '😀']);
    // Sorted: space, a, b, 😀.
    expect(charcodes('ab 😀')).toEqual([2, 3, 1, 4]);
    expect(charcodes('z')).toEqual([0]);
  });

  it('writes words composed, right-to-left ones in the order they are seen', () => {
    expect(layerWord('éte')).toBe('éte');
    expect(layerWord('שלום')).toBe('םולש');
    // A mark goes before its letter, marks in their own order.
    expect(layerWord('שָׁל')).toBe('לָׁש');
    // Mixed with digits or Latin: left as it is.
    expect(layerWord('שנה2024')).toBe('שנה2024');
    expect(layerWord('\ud800x')).toBe('�x');
  });
});

describe('text layer font in PDFium', () => {
  const words = ['Grüße', 'éte', '中文测试', '日本語', 'שלום', 'עולם', 'مرحبا', '①✓■₂', 'ภาษาไทย', 'x🎉y'];

  it('round-trips every script, one font per file, words as wide as their characters', async () => {
    const wasm = readFileSync(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'));
    const M = await init({ wasmBinary: wasm } as never);
    M.PDFiumExt_Init();
    const heap = () => (M.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
    const { malloc, free } = M.pdfium.wasmExports;
    const doc = M.FPDF_CreateNewDocument();
    const page = M.FPDFPage_New(doc, 0, 595, 842);
    const written = words.map(layerWord);
    const font = layerFont(written.map((w) => `${w} `));
    const buf = malloc(font.data.length);
    heap().set(font.data, buf);
    const f = M.FPDFText_LoadFont(doc, buf, font.data.length, 2, true);
    expect(f).not.toBe(0);
    // Right-to-left words from the right, as they are on a page.
    let [left, right] = [20, 575];
    written.forEach((w, i) => {
      const text = i < written.length - 1 ? `${w} ` : w;
      const obj = M.FPDFPageObj_CreateTextObj(doc, f, 10);
      const codes = font.charcodes(text);
      const p = malloc(codes.length * 4);
      new Uint32Array(heap().buffer, p, codes.length).set(codes);
      expect(M.FPDFText_SetCharcodes(obj, p, codes.length)).toBeTruthy();
      free(p);
      M.FPDFTextObj_SetTextRenderMode(obj, 3);
      const b = malloc(16);
      M.FPDFPageObj_GetBounds(obj, b, b + 4, b + 8, b + 12);
      const width = M.pdfium.getValue(b + 8, 'float') - M.pdfium.getValue(b, 'float');
      free(b);
      // The trailing space adds nothing: it is empty.
      expect(width).toBeCloseTo([...w].length * 10 * GLYPHLESS_WIDTH, 2);
      const rtl = /[֐-ࣿ]/.test(w);
      const x = rtl ? right - width : left;
      if (rtl) right -= width + 5;
      else left += width + 5;
      M.FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, rtl ? 700 : 750);
      M.FPDFPage_InsertObject(page, obj);
    });
    expect(M.FPDFPage_GenerateContent(page)).toBeTruthy();
    M.FPDFFont_Close(f);
    free(buf);
    const w = M.PDFiumExt_OpenFileWriter();
    M.PDFiumExt_SaveAsCopy(doc, w);
    const size = M.PDFiumExt_GetFileWriterSize(w);
    const out = malloc(size);
    M.PDFiumExt_GetFileWriterData(w, out, size);
    const file = heap().slice(out, out + size);
    M.PDFiumExt_CloseFileWriter(w);
    expect(new TextDecoder('latin1').decode(file).match(/FontFile2/g)).toHaveLength(1);

    const again = M.FPDF_LoadMemDocument(out, size, '');
    const text = M.FPDFText_LoadPage(M.FPDF_LoadPage(again, 0));
    const n = M.FPDFText_CountChars(text);
    const t = malloc((n + 1) * 2);
    M.FPDFText_GetText(text, 0, n, t);
    const got = M.pdfium.UTF16ToString(t).split(/\s+/);
    expect(new Set(got)).toEqual(new Set(words.map((x) => x.normalize('NFC'))));
    // Found again (PDFium can't find a character beyond the BMP: its page holds the two halves).
    for (const q of words.filter((x) => !/[\u{10000}-\u{10ffff}]/u.test(x))) {
      const qn = (q.length + 1) * 2;
      const qp = malloc(qn);
      M.pdfium.stringToUTF16(q.normalize('NFC'), qp, qn);
      const find = M.FPDFText_FindStart(text, qp, 0, 0);
      expect(M.FPDFText_FindNext(find), q).toBeTruthy();
      M.FPDFText_FindClose(find);
    }
  });
});
