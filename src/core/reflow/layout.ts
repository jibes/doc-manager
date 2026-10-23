import { bounds, near } from '@/core/engine/geometry';
import type { Graphic, NormRect, TextLine } from '@/core/engine/types';

/**
 * Page geometry for reflow: which drawings are figures, which line clusters are tables,
 * and the reading order across columns. Pure; all rects normalized to the page.
 */

/** A region shown as a crop of the page: a figure, or a table (kept as drawn rather than flattened into text). */
export type Figure = { rect: NormRect; alt: string; table: boolean };
/** A page element in reading order; `col` numbers the region it sits in (a column, or a full-width band). */
export type Placed<L> = { line: L; col: number } | { fig: Figure; col: number };

const center = (r: NormRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (r: NormRect, box: NormRect, pad = 0.004) => {
  const c = center(r);
  return c.x >= box.x - pad && c.x <= box.x + box.w + pad && c.y >= box.y - pad && c.y <= box.y + box.h + pad;
};
const len = (l: TextLine) => l.text.trim().length;

/** "Figure 3:", "Fig. 2.", "Table 1 –", "Abbildung 4:" — a caption, not a sentence mentioning one. */
export const CAPTION = /^(fig(ure|\.)?|abb(ildung|\.)|table|tab(elle|\.)|chart|diagram|exhibit|plate|grafik|listing)\s*[\dIVX]+(\.\d+)*[a-z]?\s*[:.—–-]/i;
/** Axis labels, legends and tick values just outside a drawing's ink belong to it. */
const isLabel = (l: TextLine) => len(l) <= 20 && !l.bold && !CAPTION.test(l.text.trim());

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const pad = (r: NormRect, d: number): NormRect => ({
  x: Math.max(0, r.x - d),
  y: Math.max(0, r.y - d),
  w: Math.min(1, r.x + r.w + d) - Math.max(0, r.x - d),
  h: Math.min(1, r.y + r.h + d) - Math.max(0, r.y - d),
});

/**
 * Drawings that read as figures. Text inside one (chart labels) belongs to it and leaves the flow;
 * drawings holding much running text are backgrounds or boxed text, not figures.
 */
export function findFigures<L extends TextLine>(lines: L[], graphics: Graphic[]): { figures: Figure[]; lines: L[] } {
  const figures: Figure[] = [];
  let rest = lines;
  for (const g of graphics) {
    const r = g.rect;
    if (r.w < 0.06 || r.h < 0.04 || r.w * r.h < 0.006) continue; // icons, bullets, rules
    if (!g.image && g.parts < 3) continue; // a lone box or line: a frame, not a drawing
    const within = rest.filter((l) => inside(l.rect, r));
    const chars = within.reduce((n, l) => n + len(l), 0);
    if (chars > 400 || (chars > 120 && median(within.map(len)) > 40)) continue;
    let box = bounds([r, ...within.map((l) => l.rect)])!;
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of rest)
        if (!within.includes(l) && isLabel(l) && near(l.rect, box, 0.008)) {
          within.push(l);
          box = bounds([box, l.rect])!;
          grew = true;
        }
    }
    figures.push({ rect: pad(box, 0.004), alt: within.map((l) => l.text.trim()).join(' '), table: false });
    rest = rest.filter((l) => !within.includes(l));
  }
  return { figures, lines: rest };
}

type Row<L> = { cy: number; h: number; items: L[] };

/** Same-baseline lines, top to bottom. */
function rows<L extends TextLine>(lines: L[]): Row<L>[] {
  const out: Row<L>[] = [];
  for (const l of [...lines].sort((a, b) => center(a.rect).y - center(b.rect).y)) {
    const cy = center(l.rect).y;
    const last = out[out.length - 1];
    if (last && Math.abs(cy - last.cy) < Math.min(l.rect.h, last.h) * 0.5) last.items.push(l);
    else out.push({ cy, h: l.rect.h, items: [l] });
  }
  for (const r of out) r.items.sort((a, b) => a.rect.x - b.rect.x);
  return out;
}

const isMulti = <L extends TextLine>(r: Row<L>) =>
  r.items.length >= 2 && r.items.every((l, i) => i === 0 || l.rect.x >= r.items[i - 1].rect.x + r.items[i - 1].rect.w - 0.002);

/** Prose: a long line, or a sentence. Text like this is read, not looked up. */
const SENTENCE = /[.!?…]["”’»)]?$/;
const isProse = (l: TextLine) => len(l) >= 60 || (len(l) >= 30 && SENTENCE.test(l.text.trim()));
/** Figures in a row: "27.05.2024 312 7311 1 77.00 85.45", an amount, an account number. */
const isNumeric = (l: TextLine) => {
  const s = l.text.replace(/\s/g, '');
  return s.length >= 6 && (s.match(/\d/g)?.length ?? 0) >= s.length * 0.45;
};

/** Share of a page's text in tables and forms from which the page is shown as it is, whole. */
const MOSTLY = 0.55;
/** A scanned page with less running text than this (a form: labels, ticked boxes, short entries) is shown whole too. */
const SCAN_PROSE = 0.25;
const SCAN_LINES = 12;

/**
 * Tables and forms (untagged): runs of rows that are looked up rather than read: several short cells side by side,
 * or figures. The labels and lines between them belong to them (a form's "AHV-Nr.", a table's description line);
 * running text ends them. A run with at least three such rows is kept as drawn: on a scan the picture holds what
 * its text can't (ticked boxes, handwriting, stamps), and cells flattened into text read as nonsense. A page that
 * is mostly such runs (an invoice, a form) is kept whole, rather than as pieces with stray labels between them.
 */
export function findTables<L extends TextLine>(lines: L[], scanned = false): { tables: Figure[]; lines: L[] } {
  const runs: Row<L>[][] = [];
  let run: Row<L>[] = [];
  let between = 0;
  const looked = (r: Row<L>) => (isMulti(r) && median(r.items.map(len)) < 28 && !r.items.some(isProse)) || r.items.every(isNumeric);
  const flush = () => {
    while (run.length && !looked(run[run.length - 1])) run.pop();
    if (run.filter(looked).length >= 3) runs.push(run);
    run = [];
    between = 0;
  };
  for (const row of rows(lines)) {
    const last = run[run.length - 1];
    if (last && row.cy - last.cy > Math.max(row.h, last.h) * 3) flush();
    if (looked(row)) {
      between = 0;
      run.push(row);
    } else if (run.length && !row.items.some(isProse) && ++between <= 4) run.push(row);
    else flush();
  }
  flush();

  const chars = (ls: L[]) => ls.reduce((n, l) => n + len(l), 0);
  const alt = (rs: Row<L>[]) => rs.map((r) => r.items.map((l) => l.text.trim()).join(' · ')).join('\n');
  const taken = new Set(runs.flat().flatMap((r) => r.items));
  const form = scanned && lines.length >= SCAN_LINES && chars(lines.filter(isProse)) < chars(lines) * SCAN_PROSE;
  if ((taken.size && chars([...taken]) >= chars(lines) * MOSTLY) || form) {
    return { tables: [{ rect: pad(bounds(lines.map((l) => l.rect))!, 0.006), alt: alt(rows(lines)), table: true }], lines: [] };
  }
  const tables = runs.map((rs) => ({ rect: pad(bounds(rs.flatMap((r) => r.items.map((l) => l.rect)))!, 0.006), alt: alt(rs), table: true }));
  return { tables, lines: lines.filter((l) => !taken.has(l)) };
}

const TABLE_ROLE = /^(Table|TR|TH|TD|THead|TBody|TFoot)$/;

/** Tagged tables: consecutive lines inside table structure. */
export function taggedTables<L extends TextLine>(lines: L[]): { tables: Figure[]; lines: L[] } {
  const tables: Figure[] = [];
  const rest: L[] = [];
  let run: L[] = [];
  const flush = () => {
    // A lone tagged cell isn't worth a picture; it stays text.
    if (run.length >= 2)
      tables.push({ rect: pad(bounds(run.map((l) => l.rect))!, 0.006), alt: run.map((l) => l.text.trim()).join(' · '), table: true });
    else rest.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.role && TABLE_ROLE.test(l.role)) run.push(l);
    else {
      flush();
      rest.push(l);
    }
  }
  flush();
  return { tables, lines: rest };
}

/** Figures and tables that overlap (a shaded table, a chart with its own frame) become one. */
export function mergeFigures(figs: Figure[]): Figure[] {
  const out: Figure[] = [];
  for (const f of figs) {
    const hit = out.find((o) => near(o.rect, f.rect, 0));
    if (hit) {
      hit.rect = bounds([hit.rect, f.rect])!;
      hit.alt = [hit.alt, f.alt].filter(Boolean).join('\n');
      hit.table ||= f.table;
    } else out.push({ ...f });
  }
  return out.length < figs.length ? mergeFigures(out) : out;
}

type Item<L> = { rect: NormRect; order: number; line?: L; fig?: Figure };

/**
 * A vertical gutter separating two text columns: an x-range almost no narrow line crosses,
 * with column-like text (several longish lines) on both sides at the same height.
 */
function gutter<L extends TextLine>(items: Item<L>[]): { x0: number; x1: number } | null {
  const cands = items.filter((it) => it.line && it.rect.w < 0.55);
  if (cands.length < 8) return null;
  const B = 100;
  const cov = new Array<number>(B).fill(0);
  for (const c of cands) for (let b = Math.floor(c.rect.x * B); b <= Math.min(B - 1, Math.floor((c.rect.x + c.rect.w) * B)); b++) cov[b]++;
  const limit = Math.floor(cands.length * 0.04);
  const textLike = (side: Item<L>[]) => median(side.map((s) => len(s.line!))) >= 15 && median(side.map((s) => s.rect.w)) >= 0.15;
  const extent = (side: Item<L>[]) => [Math.min(...side.map((s) => s.rect.y)), Math.max(...side.map((s) => s.rect.y + s.rect.h))];
  let best: { x0: number; x1: number } | null = null;
  let bestScore = 0;
  for (let b = 15; b < 85; b++) {
    if (cov[b] > limit) continue;
    let e = b;
    while (e + 1 < 85 && cov[e + 1] <= limit) e++;
    const g = { x0: b / B, x1: (e + 1) / B };
    b = e;
    const left = cands.filter((c) => c.rect.x < g.x0 && c.rect.x + c.rect.w <= g.x1);
    const right = cands.filter((c) => c.rect.x >= g.x0 && c.rect.x + c.rect.w > g.x1);
    if (left.length < 4 || right.length < 4 || !textLike(left) || !textLike(right)) continue;
    const [l0, l1] = extent(left);
    const [r0, r1] = extent(right);
    if (Math.min(l1, r1) - Math.max(l0, r0) < 0.3 * Math.min(l1 - l0, r1 - r0)) continue;
    const score = Math.min(left.length, right.length);
    if (score > bestScore) [best, bestScore] = [g, score];
  }
  return best;
}

/** Splits a page into regions in reading order: full-width bands, and columns read top to bottom, left to right. */
function regions<L extends TextLine>(items: Item<L>[], depth: number): Item<L>[][] {
  const g = depth < 3 ? gutter(items) : null;
  if (!g) return [items];
  const out: Item<L>[][] = [];
  let left: Item<L>[] = [];
  let right: Item<L>[] = [];
  let band: Item<L>[] = [];
  const flushColumns = () => {
    if (left.length) out.push(...regions(left, depth + 1));
    if (right.length) out.push(...regions(right, depth + 1));
    left = [];
    right = [];
  };
  for (const it of [...items].sort((a, b) => a.rect.y - b.rect.y)) {
    if (it.rect.x < g.x0 && it.rect.x + it.rect.w > g.x1) {
      flushColumns();
      band.push(it);
    } else {
      if (band.length) out.push(band);
      band = [];
      (center(it.rect).x < (g.x0 + g.x1) / 2 ? left : right).push(it);
    }
  }
  flushColumns();
  if (band.length) out.push(band);
  return out;
}

/**
 * Reading order for one page. Within a region the PDF's own order is kept (it is right far more
 * often than geometry); figures slot in before the first line below them that they overlap horizontally.
 */
export function readingOrder<L extends TextLine>(lines: L[], figures: Figure[], columns: boolean): Placed<L>[] {
  const items: Item<L>[] = lines.map((l, i) => ({ rect: l.rect, order: i, line: l }));
  for (const fig of figures) {
    const next = lines.findIndex((l) => l.rect.y >= fig.rect.y && l.rect.x < fig.rect.x + fig.rect.w && fig.rect.x < l.rect.x + l.rect.w);
    items.push({ rect: fig.rect, order: next < 0 ? lines.length : next - 0.5, fig });
  }
  const parts = columns ? regions(items, 0) : [items];
  return parts.flatMap((part, col) =>
    [...part].sort((a, b) => a.order - b.order).map((it): Placed<L> => (it.line ? { line: it.line, col } : { fig: it.fig!, col })),
  );
}
