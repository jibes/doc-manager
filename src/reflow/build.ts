import type { TextLine } from '@/engine/types';

/**
 * Turns positioned PDF lines into reflowable blocks (headings, paragraphs, list items).
 * Pure and platform-neutral: any engine that can produce TextLine[] per page gets a text view.
 */

/** 'label': small standalone text such as a chapter kicker ("CHAPTER 2"). */
export type BlockKind = 'h1' | 'h2' | 'h3' | 'label' | 'p' | 'li' | 'quote';
export type Block = {
  kind: BlockKind;
  text: string;
  /** List marker ("•", "1.", "a)") when kind is 'li'. */
  marker?: string;
  /** Source page (0-based) and top of the first line (0..1) — for position sync with page view. */
  page: number;
  y: number;
};
export type Reflow = { blocks: Block[]; tagged: boolean; status: 'ok' | 'no-text' };

type Line = TextLine & { page: number };

/** Top/bottom band where running headers and footers live. */
const BAND = 0.085;
const SENTENCE_END = /[.!?:;…"”’»)\]]$/;
const BULLET = /^((?:[•▪◦‣●○■□–—*-])|(?:\d{1,3}[.)])|(?:[a-z][.)])|(?:\(\w{1,3}\)))\s+/;
const PAGE_NUMBER = /^(?:(?:page|seite|p\.)\s*)?[-–—(]?\s*#\s*[-–—)]?(?:\s*(?:of|von|\/)\s*#)?$/i;
const MIN_CHARS_PER_PAGE = 40;
const HYPHEN_END = /[-\u00ad]$/;
/** Upper bound on lines per block, so pathological text (no punctuation for pages) stays renderable. */
const MAX_BLOCK_LINES = 60;

const signature = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const inBand = (l: Line) => l.rect.y < BAND || l.rect.y + l.rect.h > 1 - BAND;
const roundSize = (s: number) => Math.round(s * 2) / 2;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

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
  return 'p';
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
    else parts.push(text);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildReflow(input: TextLine[][]): Reflow {
  const raw = input.map((page, i) => page.map((l) => ({ ...l, page: i })));
  const chars = raw.reduce((n, p) => n + p.reduce((m, l) => m + l.text.length, 0), 0);
  // Scanned PDFs have no text layer (or only stray OCR noise): nothing to reflow.
  if (chars / Math.max(1, input.length) < MIN_CHARS_PER_PAGE) return { blocks: [], tagged: false, status: 'no-text' };

  const tagged = raw.some((p) => p.some((l) => l.role));
  const pages = tagged ? raw : dropFurniture(raw);
  const all = pages.flat();
  const body = bodySize(all);

  // Heading sizes: distinct sizes clearly above body, largest first → h1, h2, h3.
  const headingSizes = [...new Set(all.map((l) => roundSize(l.size)).filter((s) => s >= body * 1.15))].sort((a, b) => b - a);
  const sizeKind = (l: Line): BlockKind => {
    const i = headingSizes.indexOf(roundSize(l.size));
    if (i >= 0) return (['h1', 'h2', 'h3'] as const)[Math.min(2, i)];
    // A short bold line at body size standing on its own reads as a minor heading.
    if (l.bold && Math.abs(l.size - body) <= 1 && l.text.length < 80 && !SENTENCE_END.test(l.text.trim())) return 'h3';
    if (l.size < body * 0.9 && l.text.trim().length < 40 && !SENTENCE_END.test(l.text.trim())) return 'label';
    return BULLET.test(l.text.trim()) ? 'li' : 'p';
  };
  const kindOf = (l: Line): BlockKind => (tagged ? tagKind(l.role) : sizeKind(l));

  // Typical top-to-top distance between consecutive body lines; larger steps start a paragraph.
  const steps: number[] = [];
  for (const page of pages)
    for (let i = 1; i < page.length; i++) {
      const [a, b] = [page[i - 1], page[i]];
      const step = b.rect.y - a.rect.y;
      if (step > 0 && roundSize(a.size) === body && roundSize(b.size) === body) steps.push(step);
    }
  const typicalStep = median(steps) || 0.02;
  const rightEdge = pages.map((p) => Math.max(0, ...p.filter((l) => roundSize(l.size) === body).map((l) => l.rect.x + l.rect.w)));
  const leftEdge = pages.map((p) => Math.min(1, ...p.filter((l) => roundSize(l.size) === body).map((l) => l.rect.x)));

  type Draft = { kind: BlockKind; lines: Line[]; marker?: string };
  const drafts: Draft[] = [];
  let cur: Draft | null = null;

  for (const l of all) {
    const kind = kindOf(l);
    const prev = cur?.lines[cur.lines.length - 1];
    let fresh = !cur || !prev || kind !== cur.kind;
    if (!fresh && cur && prev) {
      const prevText = prev.text.trim();
      if (l.page !== prev.page) {
        // Paragraphs carry across a page break unless the previous one ended a sentence.
        fresh = !(cur.kind === 'p' || cur.kind === 'li') || SENTENCE_END.test(prevText);
      } else if (tagged) {
        fresh = l.sid !== prev.sid;
      } else if (l.bold !== prev.bold && (kind.startsWith('h') || cur.kind.startsWith('h'))) {
        // Same size but a switch between bold and regular: e.g. an intro paragraph followed by a bold heading.
        fresh = true;
      } else {
        const step = l.rect.y - prev.rect.y;
        const startsList = kind === 'li' && BULLET.test(l.text.trim());
        const shortPrev = prev.rect.x + prev.rect.w < rightEdge[l.page] * 0.85 && SENTENCE_END.test(prevText);
        const indented = l.rect.x > leftEdge[l.page] + 0.015 && SENTENCE_END.test(prevText);
        fresh = step > typicalStep * 1.45 || step < 0 || startsList || (cur.kind === 'p' && (shortPrev || indented));
        if (cur.kind.startsWith('h')) fresh = step > typicalStep * 2.2 || step < 0;
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
    .map((d) => {
      const text = joinLines(d.lines);
      // Large type alone doesn't make a heading: long or sentence-like blocks are intro/lead paragraphs.
      const lead = !tagged && d.kind.startsWith('h') && (text.split(/\s+/).length > 14 || (text.length > 60 && SENTENCE_END.test(text)));
      return { kind: lead ? ('p' as const) : d.kind, marker: d.marker, text, page: d.lines[0].page, y: d.lines[0].rect.y };
    })
    .filter((b) => /[\p{L}\p{N}]/u.test(b.text));
  return { blocks, tagged, status: blocks.length ? 'ok' : 'no-text' };
}

/** Index of the block at a page position (last block starting at or above it). */
export function blockAt(blocks: Block[], page: number, y: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (b.page < page || (b.page === page && b.y <= y)) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
