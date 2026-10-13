export type PdfImage =
  | { kind: 'jpeg'; bytes: Uint8Array<ArrayBuffer>; components: 1 | 3 }
  | {
      kind: 'flate';
      bytes: Uint8Array<ArrayBuffer>;
      components: 1 | 3;
      /** Rows carry PNG filter bytes (see predict.ts). */
      predictor: boolean;
    };

export interface PdfPage {
  /** Pixel size of the image. */
  pixelWidth: number;
  pixelHeight: number;
  /** Physical page size in points. */
  width: number;
  height: number;
  image: PdfImage;
  /** Recognised words in image pixels, for an invisible, searchable text layer. */
  words?: PdfWord[];
}

export interface PdfWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfInfo {
  title?: string;
  /** Who issued the document (read by AI), its kind, and words to find it by. */
  author?: string;
  subject?: string;
  keywords?: string[];
  /** Defaults to now. */
  created?: Date;
}

const encoder = new TextEncoder();

function pdfString(text: string): string {
  // UTF-16BE with BOM, hex-encoded: safe for any title.
  let hex = 'FEFF';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}')`
  );
}

/**
 * Helvetica advance widths (1/1000 em) for WinAnsi bytes 32..126 and
 * 128..255 (unassigned bytes are never written). Only a rough natural width
 * is needed, each word is stretched to its measured width anyway, but it has
 * to be the width of the glyph actually drawn.
 */
const HELVETICA =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'
    .split(',')
    .map(Number);
const HELVETICA_HIGH = (
  '556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,' +
  '0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,' +
  '278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,' +
  '400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,' +
  '667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,' +
  '722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,' +
  '556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,' +
  '556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500'
)
  .split(',')
  .map(Number);

/** WinAnsi bytes 0x80..0x9F, which differ from Latin-1 (0 = unassigned). */
const WIN_ANSI_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0, 0x017d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161,
  0x203a, 0x0153, 0, 0x017e, 0x0178,
];
const WIN_ANSI = new Map(
  WIN_ANSI_HIGH.map((code, i) => [code, 0x80 + i] as const).filter(([code]) => code),
);

/**
 * The WinAnsiEncoding byte for a character, which covers English and Western
 * European text (umlauts, accents, typographic quotes and dashes, euro
 * sign). Other characters become '?': the text layer is for search and copy,
 * and the image shows the real thing.
 */
function winAnsiByte(ch: string): number {
  const code = ch.codePointAt(0)!;
  if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) return code;
  return WIN_ANSI.get(code) ?? 63;
}

function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const byte = winAnsiByte(ch);
    w += byte < 127 ? HELVETICA[byte - 32] : HELVETICA_HIGH[byte - 128];
  }
  return w / 1000;
}

/** A PDF string of `text` in WinAnsiEncoding. */
function winAnsi(text: string): string {
  let out = '(';
  for (const ch of text) {
    const byte = winAnsiByte(ch);
    if (byte === 40 || byte === 41 || byte === 92) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 127) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

/** Content-stream operators drawing the words invisibly (render mode 3). */
function textLayer(page: PdfPage): string {
  if (!page.words?.length) return '';
  const sx = page.width / page.pixelWidth;
  const sy = page.height / page.pixelHeight;
  let ops = ' BT 3 Tr';
  const words = page.words;
  words.forEach((word, i) => {
    const next = words[i + 1];
    const natural = textWidth(word.text);
    const height = (word.y1 - word.y0) * sy;
    const width = (word.x1 - word.x0) * sx;
    if (!(natural > 0) || !(height > 0) || !(width > 0)) return;
    // Cap height is ~0.72 em; letters fill most of a detected line box.
    const size = height * 0.75;
    const scale = (100 * width) / (natural * size);
    const x = word.x0 * sx;
    // PDF y runs upwards; put the baseline near the bottom of the box.
    const y = page.height - (word.y1 * sy - height * 0.2);
    // A NaN or Infinity would print as a name, and break the whole page.
    if (![size, scale, x, y].every(Number.isFinite)) return;
    // A real space after a word that the next one follows on the same line: readers that copy or search the
    // text otherwise guess word breaks from positions, and run close words together ("Zahlbarbis"). The
    // scale is the word's own, so the space only reaches past the box.
    const text = next && sameLine(word, next) ? `${word.text} ` : word.text;
    ops += ` /F0 ${num(size)} Tf ${num(scale)} Tz 1 0 0 1 ${num(x)} ${num(y)} Tm ${winAnsi(text)} Tj`;
  });
  return `${ops} ET`;
}

/** The next word continues this one's line: it overlaps it vertically by half and starts to its right. */
function sameLine(a: PdfWord, b: PdfWord): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return overlap > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && b.x0 >= a.x0 + (a.x1 - a.x0) / 2;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Write a PDF with one full-page image per page.
 *
 * Images are embedded as-is: JPEG as DCTDecode, zlib data as FlateDecode, so
 * nothing is re-encoded and the PDF is barely larger than its images.
 * Paperless/OCRmyPDF adds the text layer on ingest.
 */
export function buildPdf(pages: PdfPage[], info: PdfInfo = {}): Blob {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');

  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  let position = 0;
  const push = (chunk: string | Uint8Array<ArrayBuffer>) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    position += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array<ArrayBuffer>) => {
    offsets[id] = position;
    push(`${id} 0 obj\n${body}`);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };

  // Object ids: 1 catalog, 2 pages, 3 info, 4 font, then 3 per page (page,
  // content, image).
  const pageId = (i: number) => 5 + i * 3;
  // The second line is a comment of high bytes, telling transfer tools the file is binary.
  push(new Uint8Array([...encoder.encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(' ');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const infoParts = [
    `/Producer ${pdfString('Tessel')}`,
    `/CreationDate ${pdfDate(info.created ?? new Date())}`,
  ];
  if (info.title) infoParts.push(`/Title ${pdfString(info.title)}`);
  if (info.author) infoParts.push(`/Author ${pdfString(info.author)}`);
  if (info.subject) infoParts.push(`/Subject ${pdfString(info.subject)}`);
  if (info.keywords?.length) infoParts.push(`/Keywords ${pdfString(info.keywords.join(', '))}`);
  object(3, `<< ${infoParts.join(' ')} >>`);
  object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((page, i) => {
    const id = pageId(i);
    const content = encoder.encode(
      `q ${num(page.width)} 0 0 ${num(page.height)} 0 0 cm /Im0 Do Q${textLayer(page)}`,
    );
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /XObject << /Im0 ${id + 2} 0 R >> /Font << /F0 4 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    object(id + 1, `<< /Length ${content.length} >>`, content);
    const { image } = page;
    const colorSpace = image.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    let filter = '/DCTDecode';
    if (image.kind === 'flate') {
      filter = image.predictor
        ? `/FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.components} /BitsPerComponent 8 /Columns ${page.pixelWidth} >>`
        : '/FlateDecode';
    }
    object(
      id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter ${filter} /Length ${image.bytes.length} >>`,
      image.bytes,
    );
  });

  const count = pageId(pages.length);
  const xref = position;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
