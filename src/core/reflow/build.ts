import type { Graphic, NormRect, PageLayout, Size, TextLine } from '@/core/engine/types';
import { CAPTION, findFigures, findTables, median, mergeFigures, readingOrder, taggedTables, type Figure } from './layout';

/**
 * Turns positioned PDF lines into reflowable blocks (headings, paragraphs, list items).
 * Pure and platform-neutral: any engine that can produce TextLine[] per page gets a text view.
 */

/**
 * 'label': small standalone text such as a chapter kicker ("CHAPTER 2").
 * 'figure': a region shown as a crop of the page (drawing, photo or table), or a book's image; its text is the alt text.
 * 'code': preformatted text (whitespace kept); 'rule': a scene break.
 */
export type BlockKind = 'h1' | 'h2' | 'h3' | 'label' | 'p' | 'li' | 'quote' | 'caption' | 'figure' | 'code' | 'rule';
/** Inline formatting (books): pieces of a block's text with emphasis or a link. `Block.text` stays the plain text. */
export type Run = { text: string; em?: boolean; strong?: boolean; code?: boolean; sup?: boolean; href?: string };
export type Block = {
  kind: BlockKind;
  text: string;
  /** List marker ("•", "1.", "a)") when kind is 'li'. */
  marker?: string;
  /** Figures: the page region to show, and whether it is a table. */
  rect?: NormRect;
  table?: boolean;
  /** Books: inline formatting; figures from an image file (`src`, with its pixel size). */
  runs?: Run[];
  src?: string;
  imgW?: number;
  imgH?: number;
  /** Source page (0-based) and top of the first line (0..1) — for position sync with page view. */
  page: number;
  y: number;
};
export type Reflow = { blocks: Block[]; tagged: boolean; status: 'ok' | 'no-text' };

/** `col`: region on the page in reading order (column or full-width band). */
type Line = TextLine & { page: number; col: number };

/** Top/bottom band where running headers and footers live. */
const BAND = 0.085;
const SENTENCE_END = /[.!?:;…"”’»)\]。！？]$/;
/** Chinese and Japanese script, written without spaces between words (or wrapped lines). */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}。！？、，]/u;
const BULLET = /^((?:[•▪◦‣●○■□–—*-])|(?:\d{1,3}[.)])|(?:[a-z][.)])|(?:\(\w{1,3}\)))\s+/;
/** "9. Dezember 2024", "3. Mai": a date, not a numbered item. */
const DATE_START =
  /^\d{1,2}\.\s*(jan(uar|uary)?|feb(ruar|ruary)?|mär(z)?|mar(ch)?|apr(il)?|mai|may|jun[ie]?|jul[iy]?|aug(ust)?|sep(t|tember)?|okt(ober)?|oct(ober)?|nov(ember)?|dez(ember)?|dec(ember)?)\.?(?!\p{L})/iu;
/** "z. B.", "d. h.", "u. a.": an abbreviation, not a lettered item. */
const ABBREV = /^\p{L}\.\s?\p{L}\./u;
const PAGE_NUMBER = /^(?:(?:page|seite|p\.)\s*)?[-–—(]?\s*#\s*[-–—)]?(?:\s*(?:of|von|\/)\s*#)?$/i;
const MIN_CHARS_PER_PAGE = 40;
const HYPHEN_END = /[-\u00ad]$/;
/** Upper bound on lines per block, so pathological text (no punctuation for pages) stays renderable. */
const MAX_BLOCK_LINES = 60;
/** Rows with a gap at the same place: a gutter between columns, not a wide space in a line. */
const GUTTER_ROWS = 3;
/** Width over height when a page's size isn't known (A4 portrait). */
const ASPECT = 1 / Math.SQRT2;

const signature = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const inBand = (l: { rect: NormRect }) => l.rect.y < BAND || l.rect.y + l.rect.h > 1 - BAND;
const roundSize = (s: number) => Math.round(s * 2) / 2;

/** Lines repeated in the top/bottom band across pages (running heads, footers) and bare page numbers. */
function dropFurniture(pages: Line[][]): Line[][] {
  const withText = pages.filter((p) => p.length).length;
  const seen = new Map<string, Set<number>>();
  for (const page of pages)
    for (const l of page) {
      if (!inBand(l)) continue;
      const sig = signature(l.text);
      if (!seen.has(sig)) seen.set(sig, new Set());
      seen.get(sig)!.add(l.page);
    }
  const threshold = Math.max(2, Math.ceil(withText * 0.3));
  const repeated = new Set([...seen].filter(([, ps]) => withText >= 3 && ps.size >= threshold).map(([sig]) => sig));
  return pages.map((page) =>
    page.filter((l) => {
      if (!inBand(l)) return true;
      const sig = signature(l.text);
      return !repeated.has(sig) && !PAGE_NUMBER.test(sig);
    }),
  );
}

/** Logos and rules in the header/footer band, and drawings repeated at the same spot on many pages (letterheads). */
function dropFurnitureGraphics(pages: Graphic[][]): Graphic[][] {
  const sig = (g: Graphic) => [g.rect.x, g.rect.y, g.rect.w, g.rect.h].map((v) => Math.round(v * 100)).join(',');
  const count = new Map<string, number>();
  for (const page of pages) for (const k of new Set(page.map(sig))) count.set(k, (count.get(k) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  return pages.map((page) => page.filter((g) => !(g.rect.y > 1 - BAND || g.rect.y + g.rect.h < BAND) && (count.get(sig(g)) ?? 0) < threshold));
}

/** Most common size, weighted by amount of text. */
function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(roundSize(l.size), (weight.get(roundSize(l.size)) ?? 0) + l.text.length);
  let best = 0;
  let bestW = -1;
  for (const [s, w] of weight) if (w > bestW) [best, bestW] = [s, w];
  return best;
}

function tagKind(role: string | undefined): BlockKind {
  if (!role) return 'p';
  const h = /^H(\d)?$/.exec(role);
  if (h) return (['h1', 'h1', 'h2', 'h3'] as const)[Math.min(3, Number(h[1] ?? 1))];
  if (role === 'Title') return 'h1';
  if (/^(L|LI|LBody|Lbl)$/.test(role)) return 'li';
  if (role === 'BlockQuote') return 'quote';
  if (role === 'Caption') return 'caption';
  return 'p';
}

/**
 * Pieces of one line of text that came apart (a recogniser cuts a line at a wide space): next to each other on the
 * same baseline, closer than a few characters. Table cells, further apart, stay apart, and so do two columns whose
 * lines happen to be level: a gap at the same place on several rows is a gutter. `aspect` is the page's width over
 * its height, so a gap across (in page widths) compares with line heights (in page heights).
 */
function rejoinRows(lines: Line[], aspect: number): Line[] {
  const pieces = (prev: Line, l: Line) => {
    const h = Math.min(l.rect.h, prev.rect.h);
    const gap = (l.rect.x - (prev.rect.x + prev.rect.w)) * aspect;
    return !l.role && Math.abs(l.rect.y + l.rect.h / 2 - (prev.rect.y + prev.rect.h / 2)) < h * 0.5 && gap >= -h * 0.5 && gap < h * 2.5;
  };
  const gaps = lines.flatMap((l, i) => (i > 0 && pieces(lines[i - 1], l) ? [[lines[i - 1].rect.x + lines[i - 1].rect.w, l.rect.x]] : []));
  const gutter = (x0: number, x1: number) => gaps.filter(([a, b]) => a < x1 && b > x0).length >= GUTTER_ROWS;
  const out: Line[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const end = prev ? prev.rect.x + prev.rect.w : 0;
    if (prev && pieces(prev, l) && !(l.rect.x > end && gutter(end, l.rect.x))) {
      const x1 = Math.max(prev.rect.x + prev.rect.w, l.rect.x + l.rect.w);
      const y0 = Math.min(prev.rect.y, l.rect.y);
      const y1 = Math.max(prev.rect.y + prev.rect.h, l.rect.y + l.rect.h);
      // Its type is the longer piece's (not a dash's or a bullet's before it).
      const main = l.text.trim().length > prev.text.trim().length ? l : prev;
      out[out.length - 1] = { ...prev, size: main.size, bold: main.bold, text: `${prev.text} ${l.text}`, rect: { x: prev.rect.x, y: y0, w: x1 - prev.rect.x, h: y1 - y0 }, hyphen: l.hyphen };
    } else out.push(l);
  }
  return out;
}

/** Joins wrapped lines, rejoining words split by a line-end hyphen. */
function joinLines(lines: Line[]): string {
  // Linear: inspect only line ends (a regex on the growing string would rescan it every line).
  const parts: string[] = [];
  lines.forEach((l, i) => {
    const text = l.text.trim();
    const last = parts[parts.length - 1];
    const prev = lines[i - 1];
    const split = i > 0 && last && HYPHEN_END.test(last.slice(-1)) && (prev.hyphen || HYPHEN_END.test(prev.text.trim())) && /^\p{Ll}/u.test(text);
    if (split) parts[parts.length - 1] = last.slice(0, -1) + text;
    else if (last && CJK.test(last.slice(-1)) && CJK.test(text.charAt(0))) parts[parts.length - 1] = last + text;
    else parts.push(text);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

type Draft = { kind: BlockKind; lines: Line[]; marker?: string; fig?: Figure & { page: number } };

/** Line heights this close to a scanned page's usual one are its body text: what the recogniser measured is noise. */
const SCAN_SAME = [0.75, 1.55];

/**
 * A scanned page's text (recognised, invisible over the picture of the page) says nothing reliable about its size
 * or weight: sizes come from the height of its line boxes instead, relative to the page's usual line, in the
 * document's body size (`body`); near the usual one counts as body text.
 */
const chars = (ls: TextLine[]) => ls.reduce((n, l) => n + l.text.length, 0);
/** A page whose text is (nearly) all recognised from its picture. */
const isScanned = (lines: TextLine[]) => lines.length > 0 && chars(lines.filter((l) => l.ocr)) >= chars(lines) * 0.8;

function scannedTypography(lines: TextLine[], body: number): TextLine[] {
  if (!isScanned(lines)) return lines;
  const usual = median(lines.map((l) => l.rect.h)) || 1;
  return lines.map((l) => {
    const r = l.rect.h / usual;
    return { ...l, size: r >= SCAN_SAME[0] && r < SCAN_SAME[1] ? body : roundSize(body * r), bold: false, italic: false };
  });
}

/** `sizes`: the pages' sizes, when known (for gaps across a line in its height). */
export function buildReflow(input: PageLayout[], sizes?: Size[]): Reflow {
  // Typed pages set the body size scanned ones are measured in (10pt when all are scans).
  const typed = input.flatMap((p) => p.lines.filter((l) => !l.ocr)) as Line[];
  const typedBody = typed.length ? bodySize(typed) : 10;
  const aspect = (i: number) => (sizes?.[i] ? sizes[i].width / sizes[i].height : ASPECT);
  const raw = input.map((page, i) => rejoinRows(scannedTypography(page.lines, typedBody).map((l): Line => ({ ...l, page: i, col: 0 })), aspect(i)));
  const scanned = input.map((p) => isScanned(p.lines));
  // Scanned PDFs have no text layer (or only stray OCR noise): nothing to reflow. Counted per page, so a long
  // document with a few pages of text (the rest pictures) still reads as text.
  if (!raw.some((p) => p.reduce((n, l) => n + l.text.length, 0) >= MIN_CHARS_PER_PAGE)) return { blocks: [], tagged: false, status: 'no-text' };

  const tagged = raw.some((p) => p.some((l) => l.role));
  const textPages = tagged ? raw : dropFurniture(raw);
  const graphics = dropFurnitureGraphics(input.map((p) => p.graphics));

  // Per page: pull out figures and tables, then put the rest in reading order (columns for untagged PDFs;
  // tagged ones already carry their logical order).
  const seq = textPages.flatMap((lines, page) => {
    const f = findFigures(lines, graphics[page]);
    const t = tagged ? taggedTables(f.lines) : findTables(f.lines, scanned[page]);
    return readingOrder(t.lines, mergeFigures([...f.figures, ...t.tables]), !tagged).map((it) =>
      'line' in it ? { line: Object.assign(it.line, { col: it.col }) } : { fig: { ...it.fig, page } },
    );
  });
  const all = seq.flatMap((it) => ('line' in it && it.line ? [it.line] : []));
  const body = bodySize(all);

  // Heading sizes: distinct sizes clearly above body, largest first → h1, h2, h3.
  const headingSizes = [...new Set(all.map((l) => roundSize(l.size)).filter((s) => s >= body * 1.15))].sort((a, b) => b - a);
  const sizeKind = (l: Line): BlockKind => {
    const text = l.text.trim();
    if (CAPTION.test(text)) return 'caption';
    const i = headingSizes.indexOf(roundSize(l.size));
    if (i >= 0) return (['h1', 'h2', 'h3'] as const)[Math.min(2, i)];
    // A short bold line at body size standing on its own reads as a minor heading.
    if (l.bold && Math.abs(l.size - body) <= 1 && text.length < 80 && !SENTENCE_END.test(text)) return 'h3';
    if (l.size < body * 0.9 && text.length < 40 && !SENTENCE_END.test(text)) return 'label';
    return BULLET.test(text) && !DATE_START.test(text) && !ABBREV.test(text) ? 'li' : 'p';
  };
  const kindOf = (l: Line): BlockKind => (tagged ? tagKind(l.role) : sizeKind(l));

  // Typical top-to-top distance between consecutive body lines in one region; larger steps start a paragraph.
  const steps: number[] = [];
  for (let i = 1; i < all.length; i++) {
    const [a, b] = [all[i - 1], all[i]];
    const step = b.rect.y - a.rect.y;
    if (a.page === b.page && a.col === b.col && step > 0 && roundSize(a.size) === body && roundSize(b.size) === body) steps.push(step);
  }
  const typicalStep = median(steps) || 0.02;
  // Text edges per region, for spotting short last lines and first-line indents.
  const edges = new Map<string, { left: number; right: number }>();
  for (const l of all) {
    if (roundSize(l.size) !== body) continue;
    const k = `${l.page}:${l.col}`;
    const e = edges.get(k) ?? { left: 1, right: 0 };
    edges.set(k, { left: Math.min(e.left, l.rect.x), right: Math.max(e.right, l.rect.x + l.rect.w) });
  }
  const edgeOf = (l: Line) => edges.get(`${l.page}:${l.col}`) ?? { left: 0, right: 1 };

  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  // A paragraph cut off by a figure (and its caption) resumes after them.
  let held = null as Draft | null;
  const isText = (d: Draft | null) => !!d && (d.kind === 'p' || d.kind === 'li');
  const ended = (d: Draft) => SENTENCE_END.test(d.lines[d.lines.length - 1].text.trim());

  for (const it of seq) {
    if ('fig' in it && it.fig) {
      if (isText(cur) && !ended(cur!)) held = cur;
      drafts.push({ kind: 'figure', lines: [], fig: it.fig });
      cur = null;
      continue;
    }
    const l = it.line!;
    let kind = kindOf(l);
    const last = cur?.lines[cur.lines.length - 1];
    // A wrapped line can start like an item ("19. Jahrhundert", "– und zwar"): a list starts after a sentence or
    // another item, or indented.
    if (kind === 'li' && !tagged && cur?.kind === 'p' && last && !SENTENCE_END.test(last.text.trim()) && l.rect.x <= edgeOf(l).left + 0.015) kind = 'p';
    if (held && kind !== 'caption') {
      const resume = (!cur || cur.kind === 'caption') && kind === 'p' && /^\p{Ll}/u.test(l.text.trim());
      if (resume) {
        // The interrupted paragraph keeps its place before the figure.
        held.lines.push(l);
        cur = held;
        held = null;
        continue;
      }
      held = null;
    }
    const prev = cur?.lines[cur.lines.length - 1];
    let fresh = !cur || !prev || kind !== cur.kind;
    if (cur?.kind === 'caption' && prev && !kind.startsWith('h') && l.page === prev.page && l.col === prev.col) {
      // Caption lines run on in the caption's own (smaller) type.
      const step = l.rect.y - prev.rect.y;
      fresh = step < 0 || step > prev.rect.h * 1.9 || Math.abs(l.size - prev.size) > 1;
    } else if (!fresh && cur && prev) {
      const prevText = prev.text.trim();
      if (l.page !== prev.page || l.col !== prev.col) {
        // Paragraphs carry across a page or column break unless the previous one ended a sentence.
        fresh = !isText(cur) || SENTENCE_END.test(prevText);
      } else if (tagged) {
        fresh = l.sid !== prev.sid;
      } else if (l.bold !== prev.bold && (kind.startsWith('h') || cur.kind.startsWith('h'))) {
        // Same size but a switch between bold and regular: e.g. an intro paragraph followed by a bold heading.
        fresh = true;
      } else {
        const step = l.rect.y - prev.rect.y;
        const edge = edgeOf(l);
        const startsList = kind === 'li' && BULLET.test(l.text.trim());
        const shortPrev = prev.rect.x + prev.rect.w < edge.left + (edge.right - edge.left) * 0.85 && SENTENCE_END.test(prevText);
        const indented = l.rect.x > edge.left + 0.015 && SENTENCE_END.test(prevText);
        fresh = step > typicalStep * 1.45 || step < 0 || startsList || (cur.kind === 'p' && (shortPrev || indented));
        // A heading's lines are as far apart as its own (large) type, not the body's.
        if (cur.kind.startsWith('h')) fresh = step > Math.max(typicalStep * 2.2, prev.rect.h * 1.8) || step < 0;
      }
    }
    if (!fresh && cur && cur.lines.length >= MAX_BLOCK_LINES) fresh = true;
    if (fresh) {
      let marker: string | undefined;
      if (kind === 'li') {
        const m = BULLET.exec(l.text.trim());
        if (m) {
          marker = /\w/.test(m[1]) ? m[1] : '•';
          l.text = l.text.trim().slice(m[0].length);
        }
      }
      cur = { kind, lines: [l], marker };
      drafts.push(cur);
    } else cur!.lines.push(l);
  }

  const blocks: Block[] = drafts
    .map((d): Block => {
      if (d.fig) return { kind: 'figure', text: d.fig.alt, page: d.fig.page, y: d.fig.rect.y, rect: d.fig.rect, table: d.fig.table };
      // Lines that are all short and stand alone (an address, a signature, a list of enclosures) keep their breaks.
      const alone = !tagged && d.kind === 'p' && d.lines.length > 1 && d.lines.every((l) => l.rect.w < (edgeOf(l).right - edgeOf(l).left) * 0.6 && !/[,;]$/.test(l.text.trim()));
      const text = alone ? d.lines.map((l) => l.text.trim()).join('\n') : joinLines(d.lines);
      // Large type alone doesn't make a heading: long or sentence-like blocks are intro/lead paragraphs.
      const lead = !tagged && d.kind.startsWith('h') && (text.split(/\s+/).length > 14 || (text.length > 60 && SENTENCE_END.test(text)));
      return { kind: lead ? 'p' : d.kind, marker: d.marker, text, page: d.lines[0].page, y: d.lines[0].rect.y };
    })
    .filter((b) => b.kind === 'figure' || /[\p{L}\p{N}]/u.test(b.text));
  return { blocks, tagged, status: blocks.length ? 'ok' : 'no-text' };
}

/**
 * Index of the block at a page position: on that page, the last block (in reading order) before the
 * first one starting below `y`. Blocks are ordered by page but, across columns, not by y within a page.
 */
export function blockAt(blocks: Block[], page: number, y: number): number {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].page < page) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  while (i < blocks.length && blocks[i].page === page && blocks[i].y <= y) i++;
  return Math.max(0, i - 1);
}
