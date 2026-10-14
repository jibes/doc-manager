/**
 * A PDF's document information (title, author, subject, keywords, …) changed by an incremental update: a new
 * information dictionary and a cross-reference section are appended, and nothing before them changes. Readers
 * take the newest section; a file synced by Syncthing only sends the appended blocks; any PDF reader still opens
 * it. Works with both kinds of cross-reference (table and stream); encrypted files are left alone.
 */

/** Keys written by Tessel besides the standard ones: the document's own date, as YYYY-MM-DD. */
export const DATE_KEY = 'DocumentDate';

export type Info = Record<string, string | undefined>;

const latin1 = (bytes: Uint8Array, from = 0, to = bytes.length) => {
  let s = '';
  for (let i = from; i < to; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, Math.min(to, i + 0x8000)));
  return s;
};

/** A PDF text string: plain ASCII as a literal string, anything else as UTF-16BE hex with a byte-order mark. */
export function pdfText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else hex += code.toString(16).padStart(4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

/** A PDF name with characters outside the regular set written as #xx. */
const pdfName = (key: string) => `/${key.replace(/[^A-Za-z0-9._-]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;

/** The value of `/Key` in a dictionary's source (a reference, number, array or simple string; no nesting needed). */
function entry(dict: string, key: string): string | undefined {
  const m = new RegExp(`/${key}(?![A-Za-z0-9])\\s*(\\d+\\s+\\d+\\s+R|-?\\d+|\\[[^\\]]*\\]|<[0-9A-Fa-f\\s]*>|/[^\\s/<>\\[\\]()]+)`).exec(dict);
  return m?.[1];
}

/** The dictionary that starts at `at` (`<<` … matching `>>`), as text. */
function dictAt(text: string, at: number): string {
  let depth = 0;
  for (let i = at; i < text.length - 1; i++) {
    if (text[i] === '(') {
      // Skip a literal string (it may hold << or >>).
      let nest = 0;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') nest++;
        else if (text[i] === ')' && --nest === 0) break;
      }
    } else if (text[i] === '<' && text[i + 1] === '<') {
      depth++;
      i++;
    } else if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  throw new Error('Unreadable PDF trailer');
}

export type Trailer = { kind: 'table' | 'stream'; xref: number; size: number; root: string; id?: string; encrypted: boolean };

/** The newest cross-reference section: where it is, its kind, and what a following section must repeat. */
export function readTrailer(bytes: Uint8Array): Trailer {
  const tail = latin1(bytes, Math.max(0, bytes.length - 2048));
  const sx = tail.lastIndexOf('startxref');
  if (sx < 0) throw new Error('Not a PDF (no startxref)');
  const xref = Number(/startxref\s+(\d+)/.exec(tail.slice(sx))?.[1]);
  if (!Number.isFinite(xref) || xref >= bytes.length) throw new Error('Broken startxref');
  // Enough of the file after the section's start to hold its trailer or stream dictionary.
  const head = latin1(bytes, xref, Math.min(bytes.length, xref + (1 << 20)));
  let dict: string;
  let kind: Trailer['kind'];
  if (head.startsWith('xref')) {
    kind = 'table';
    const t = head.indexOf('trailer');
    if (t < 0) throw new Error('No trailer');
    dict = dictAt(head, head.indexOf('<<', t));
  } else if (/^\d+\s+\d+\s+obj/.test(head)) {
    kind = 'stream';
    dict = dictAt(head, head.indexOf('<<'));
    if (!/\/Type\s*\/XRef/.test(dict)) throw new Error('No cross-reference stream');
  } else throw new Error('Unreadable cross-reference');
  const size = Number(entry(dict, 'Size'));
  const root = entry(dict, 'Root');
  if (!Number.isFinite(size) || !root) throw new Error('Incomplete trailer');
  return { kind, xref, size, root, id: entry(dict, 'ID'), encrypted: entry(dict, 'Encrypt') !== undefined || /\/Encrypt\s/.test(dict) };
}

/** PDF date for now: D:YYYYMMDDHHmmSSZ. */
const pdfDate = (d: Date) => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;

/**
 * `bytes` with a new document information dictionary holding `info` (empty values are left out). Pass every key
 * to keep: the new dictionary replaces the old one. ModDate is set to now.
 */
export function withInfo(bytes: Uint8Array, info: Info, now = new Date()): Uint8Array<ArrayBuffer> {
  const t = readTrailer(bytes);
  if (t.encrypted) throw new Error('The PDF is encrypted');
  const enc = new TextEncoder();
  const parts: string[] = [];
  let at = bytes.length;
  const push = (s: string) => {
    parts.push(s);
    at += enc.encode(s).length;
  };
  // Start on a fresh line: the file may end without one.
  push('\n');
  const infoNum = t.size;
  const infoAt = at;
  const fields = Object.entries({ ...info, ModDate: pdfDate(now) })
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${pdfName(k)} ${pdfText(v!)}`)
    .join(' ');
  push(`${infoNum} 0 obj\n<< ${fields} >>\nendobj\n`);
  const id = t.id ? ` /ID ${t.id}` : '';
  const offset = (n: number) => String(n).padStart(10, '0');
  if (t.kind === 'table') {
    const xrefAt = at;
    push(`xref\n${infoNum} 1\n${offset(infoAt)} 00000 n \ntrailer\n<< /Size ${infoNum + 1} /Root ${t.root} /Info ${infoNum} 0 R /Prev ${t.xref}${id} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return concat(bytes, enc.encode(parts.join('')));
  }
  // A cross-reference stream (uncompressed): entries for the info dictionary and for the stream itself.
  const xrefNum = infoNum + 1;
  const xrefAt = at;
  const row = (offsetValue: number) => [1, (offsetValue >>> 24) & 255, (offsetValue >>> 16) & 255, (offsetValue >>> 8) & 255, offsetValue & 255, 0, 0];
  const data = new Uint8Array([...row(infoAt), ...row(xrefAt)]);
  const head = enc.encode(
    `${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /Root ${t.root} /Info ${infoNum} 0 R /Prev ${t.xref}${id} /Index [${infoNum} 2] /W [1 4 2] /Length ${data.length} >>\nstream\n`,
  );
  const tail = enc.encode(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  return concat(bytes, enc.encode(parts.join('')), head, data, tail);
}

function concat(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ------------------------------------------------------------ details ---- */

/** What Tessel knows about a document, kept in its information dictionary. */
/** A detail as written, unless it is a tool's placeholder ("untitled", "anonymous", "(unspecified)"). */
export const real = (value: string | undefined) => {
  const v = (value ?? '').trim();
  return /^\(?(untitled|anonymous|unknown|unspecified|none|null|n\/a|-+)\)?$/i.test(v) ? '' : v;
};

/**
 * A title worth showing: not a placeholder, not what an office program puts there ("Microsoft Word - x.docx",
 * "Slide 1", "Document"), not a file name. Empty when it isn't (the file name is shown instead).
 */
export const realTitle = (value: string | undefined) => {
  const v = real(value)
    .replace(/^Microsoft (Word|PowerPoint|Excel) - /i, '')
    .replace(/\.(docx?|pptx?|xlsx?|odt|rtf|pages)$/i, '')
    .trim();
  if (/^(document|title|slide ?\d*|untitled document|microsoft word)$/i.test(v)) return '';
  if (/\.(pdf|tiff?|jpe?g|png)$/i.test(v) || /^[\w-]+\.[a-z0-9]{2,4}$/i.test(v)) return '';
  return v.length < 200 ? v : '';
};

export type Details = { title: string; sender: string; type: string; tags: string[]; date: string };

/** Tags as written in Keywords: comma-separated (semicolons from other tools are read too). */
export const parseTags = (keywords: string | undefined) =>
  [...new Set((keywords ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];

/** The information dictionary for `details`, keeping the other entries of `old` (creator, producer, dates). */
export function infoFor(details: Details, old: Info): Info {
  return {
    ...old,
    Title: details.title.trim() || undefined,
    Author: details.sender.trim() || undefined,
    Subject: details.type.trim() || undefined,
    Keywords: details.tags.length ? details.tags.join(', ') : undefined,
    [DATE_KEY]: /^\d{4}-\d{2}-\d{2}$/.test(details.date) ? details.date : undefined,
  };
}
