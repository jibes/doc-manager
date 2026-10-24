/**
 * The invisible text layer's font, made for the text it is to hold: a TrueType font with a glyph for each
 * character used (any script, emoji too), every one the same box of one width. Never painted (the text is
 * invisible), the boxes give each character, and so each word, its bounds; spaces stay empty, so a word's bounds
 * end at its last letter. One glyph per character (not one for all): PDFium's ToUnicode maps glyphs back to text.
 */

const UPM = 1000;
const ADVANCE = 500;
const ASCENT = 800;
const DESCENT = -200;
const CREATED = Date.UTC(2026, 0, 1) / 1000 + 2_082_844_800;
/** A character's advance, in ems. */
export const GLYPHLESS_WIDTH = ADVANCE / UPM;

const SPACES = new Set([0x20, 0xa0, 0x1680, ...Array.from({ length: 12 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000]);

/** The code points in `texts`, sorted; lone surrogates and controls left out (written as they come). */
function codePointsOf(texts: Iterable<string>): number[] {
  const seen = new Set<number>();
  for (const t of texts) for (const c of t) seen.add(c.codePointAt(0)!);
  return [...seen].filter((c) => c >= 0x20 && !(c >= 0xd800 && c <= 0xdfff) && c !== 0xfffe && c !== 0xffff).sort((a, b) => a - b);
}

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const RTL_ALL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/gu;

/**
 * A word as it goes into the layer: composed (fewer, more common characters), never a lone surrogate. A
 * right-to-left word (Hebrew, Arabic) in the order it is seen, as PDFs hold it: readers turn it back (a mark
 * stays before its letter, which keeps their order). One with letters or digits of either direction is left as
 * it is (no order is right for every reader then).
 */
export function layerWord(text: string): string {
  const word = text.normalize('NFC').replace(/\p{Cs}/gu, '\ufffd').replace(/\p{Cc}/gu, '');
  if (!RTL.test(word) || /[\p{L}\p{N}]/u.test(word.replace(RTL_ALL, ''))) return word;
  return (word.match(/\P{M}\p{M}*|\p{M}+/gu) ?? [])
    .reverse()
    .map((c) => {
      const [base, ...marks] = [...c];
      return /\p{M}/u.test(base) ? c : marks.join('') + base;
    })
    .join('');
}

/** The font for a text layer, and each text's character codes in it (a glyph per character: 0 for one it lacks). */
export function layerFont(texts: Iterable<string>, max = 6000): { data: Uint8Array; charcodes: (text: string) => number[] } {
  const all = [...texts];
  let codes = codePointsOf(all);
  // More than a font holds: the most used ones.
  if (codes.length > max) {
    const uses = new Map<number, number>();
    for (const t of all) for (const c of t) uses.set(c.codePointAt(0)!, (uses.get(c.codePointAt(0)!) ?? 0) + 1);
    const kept = new Set([...codes].sort((a, b) => (uses.get(b) ?? 0) - (uses.get(a) ?? 0)).slice(0, max));
    codes = codes.filter((c) => kept.has(c));
  }
  const glyph = new Map(codes.map((c, i) => [c, i + 1]));
  return { data: fontFor(codes), charcodes: (text) => Array.from(text, (c) => glyph.get(c.codePointAt(0)!) ?? 0) };
}

class Writer {
  private bytes: number[] = [];
  u8(...v: number[]) {
    for (const x of v) this.bytes.push(x & 0xff);
    return this;
  }
  u16(...v: number[]) {
    for (const x of v) this.bytes.push((x >> 8) & 0xff, x & 0xff);
    return this;
  }
  u32(...v: number[]) {
    for (const x of v) this.bytes.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

/** searchRange, entrySelector, rangeShift of a binary-searchable table of `n` entries of `size` bytes. */
function binarySearch(n: number, size: number): [number, number, number] {
  let p = 1;
  let log = 0;
  while (p * 2 <= n) {
    p *= 2;
    log++;
  }
  return [p * size, log, n * size - p * size];
}

/** Runs of consecutive code points (whose glyphs follow each other too): [first, last, first glyph]. */
function runs(codes: number[], firstGlyph: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  codes.forEach((c, i) => {
    const last = out[out.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else out.push([c, c, firstGlyph + i]);
  });
  return out;
}

function cmap(codes: number[]): Uint8Array {
  const bmp = codes.filter((c) => c <= 0xffff);
  const astral = codes.length > bmp.length;
  // Format 4 (BMP): a segment per run, glyph = code + delta, and the closing 0xFFFF one.
  const segs = runs(bmp, 1).map(([a, b, g]) => [a, b, (g - a) & 0xffff]);
  segs.push([0xffff, 0xffff, 1]);
  const f4 = new Writer();
  const [sr, es, rs] = binarySearch(segs.length, 2);
  f4.u16(4, 16 + segs.length * 8, 0, segs.length * 2, sr, es, rs);
  f4.u16(...segs.map((s) => s[1]), 0, ...segs.map((s) => s[0]), ...segs.map((s) => s[2]), ...segs.map(() => 0));
  // Format 12 (all of Unicode), only where a character is beyond the BMP: groups of runs.
  const groups = runs(codes, 1);
  const f12 = new Writer().u16(12, 0).u32(16 + groups.length * 12, 0, groups.length);
  for (const [a, b, g] of groups) f12.u32(a, b, g);
  const tables = astral ? [f4.done(), f12.done()] : [f4.done()];
  const head = new Writer().u16(0, tables.length);
  let offset = 4 + tables.length * 8;
  head.u16(3, 1).u32(offset);
  offset += tables[0].length;
  if (astral) head.u16(3, 10).u32(offset);
  return concat([head.done(), ...tables]);
}

function utf16be(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 0xff);
  return out;
}

function name(): Uint8Array {
  const strings: [number, string][] = [
    [1, 'TesselText'],
    [2, 'Regular'],
    [4, 'TesselText'],
    [6, 'TesselText'],
  ];
  const w = new Writer().u16(0, strings.length, 6 + strings.length * 12);
  let offset = 0;
  for (const [id, s] of strings) {
    w.u16(3, 1, 0x409, id, s.length * 2, offset);
    offset += s.length * 2;
  }
  for (const [, s] of strings) w.u8(...utf16be(s));
  return w.done();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum = (sum + (((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3]) >>> 0)) >>> 0;
  return sum;
}

/**
 * The font for these code points (sorted): glyph 0 the box (.notdef), then one per code point in order. Each
 * box is a reference to glyph 0 (16 bytes), each space an empty glyph (none).
 */
function fontFor(codes: number[]): Uint8Array {
  const numGlyphs = codes.length + 1;
  // Glyph 0: one contour, the character's cell: (0, descent) up, across, down.
  const box = new Writer()
    .u16(1, 0, DESCENT & 0xffff, ADVANCE, ASCENT)
    .u16(3, 0)
    .u8(0x01 | 0x10 | 0x04, 0x01 | 0x10, 0x01 | 0x20, 0x01 | 0x10)
    .u16(ADVANCE)
    .u8(-DESCENT)
    .u16(ASCENT - DESCENT, (DESCENT - ASCENT) & 0xffff)
    .u8(0)
    .done();
  // A composite: glyph 0, unmoved (ARGS_ARE_XY_VALUES, byte offsets 0, 0).
  const ref = new Writer().u16(0xffff, 0, DESCENT & 0xffff, ADVANCE, ASCENT).u16(0x0002, 0).u8(0, 0).done();
  const loca: number[] = [0];
  const parts: Uint8Array[] = [box];
  let size = box.length;
  loca.push(size);
  for (const c of codes) {
    if (!SPACES.has(c)) {
      parts.push(ref);
      size += ref.length;
    }
    loca.push(size);
  }
  const glyfData = concat(parts);
  const short = size < 0x20000;
  const locaData = short ? new Writer().u16(...loca.map((o) => o / 2)).done() : new Writer().u32(...loca).done();

  const first = codes.length ? Math.min(codes[0], 0xffff) : 0x20;
  const last = codes.length ? Math.min(codes[codes.length - 1], 0xffff) : 0x20;
  const tables: [string, Uint8Array][] = [
    [
      'OS/2',
      new Writer()
        .u16(4, ADVANCE, 400, 5, 0)
        .u16(650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0)
        .u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        .u32(0, 0, 0, 0)
        .u8(0x20, 0x20, 0x20, 0x20)
        .u16(0x40, first, last, ASCENT, DESCENT & 0xffff, 0, ASCENT, -DESCENT)
        .u32(1, 0)
        .u16(500, 700, 0, 0x20, 1)
        .done(),
    ],
    ['cmap', cmap(codes)],
    ['glyf', glyfData],
    [
      'head',
      new Writer()
        .u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5)
        .u16(0x000b, UPM)
        // Created and modified: 2026-01-01, in seconds since 1904.
        .u32(0, CREATED, 0, CREATED)
        .u16(0, DESCENT & 0xffff, ADVANCE, ASCENT, 0, 8, 2, short ? 0 : 1, 0)
        .done(),
    ],
    ['hhea', new Writer().u32(0x00010000).u16(ASCENT, DESCENT & 0xffff, 0, ADVANCE, 0, 0, ADVANCE, 1, 0, 0, 0, 0, 0, 0, 0, 1).done()],
    // One advance for all (numberOfHMetrics 1), then each glyph's left side bearing: 0.
    ['hmtx', new Writer().u16(ADVANCE, 0, ...codes.map(() => 0)).done()],
    ['loca', locaData],
    ['maxp', new Writer().u32(0x00010000).u16(numGlyphs, 4, 1, 4, 1, 2, 0, 0, 0, 0, 0, 0, 1, 1).done()],
    ['name', name()],
    ['post', new Writer().u32(0x00030000, 0).u16((-100) & 0xffff, 50).u32(1, 0, 0, 0, 0).done()],
  ];

  const [sr, es, rs] = binarySearch(tables.length, 16);
  const dir = new Writer().u32(0x00010000).u16(tables.length, sr, es, rs);
  let offset = 12 + tables.length * 16;
  const padded = tables.map(([, data]) => {
    const p = new Uint8Array((data.length + 3) & ~3);
    p.set(data);
    return p;
  });
  tables.forEach(([tag, data], i) => {
    dir.u8(...[...tag].map((c) => c.charCodeAt(0))).u32(checksum(padded[i]), offset, data.length);
    offset += padded[i].length;
  });
  const font = concat([dir.done(), ...padded]);
  // head's checkSumAdjustment: the whole font's sum comes to 0xB1B0AFBA.
  const headAt = new DataView(font.buffer).getUint32(12 + tables.findIndex(([t]) => t === 'head') * 16 + 8);
  new DataView(font.buffer).setUint32(headAt + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}
