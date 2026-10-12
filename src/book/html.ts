import type { BlockKind, Run } from '@/reflow/build';
import { attr, type XNode } from './xml';

/** A block of a chapter before pagination. `ids`: anchors (element ids) that point at it. */
export type Draft = { kind: BlockKind; runs: Run[]; marker?: string; src?: string; alt?: string; ids: string[] };

type Style = Omit<Run, 'text'>;
type Ctx = {
  out: Draft[];
  /** Inline content gathered for the block being built. */
  runs: Run[];
  ids: string[];
  /** Resolves an href or src against the chapter's path. */
  resolve: (href: string) => string;
};

const SKIP = new Set(['head', 'script', 'style', 'title', 'template', 'noscript']);
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'body', 'html', 'nav', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'dl', 'dt', 'dd', 'hr', 'center', 'address', 'caption',
]);
const EXTERNAL = /^(https?:|mailto:)/i;
/** Collapsible whitespace (no-break spaces stay) and soft hyphens (dropped). */
const SPACE_OR_SHY = /[ \t\n\r\f\u00ad]+/g;
/** Stands in for <br> until whitespace is collapsed (a real newline would collapse with it). */
const BR = '\u0001';

/** Normalizes a block's runs: collapse whitespace, drop soft hyphens, trim the ends, merge neighbours with the same style. */
function tidy(runs: Run[], pre: boolean): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const text = pre ? r.text : r.text.replace(SPACE_OR_SHY, (m) => (/[ \t\n\r\f]/.test(m) ? ' ' : ''));
    if (!text) continue;
    const last = out[out.length - 1];
    const same = last && last.em === r.em && last.strong === r.strong && last.code === r.code && last.sup === r.sup && last.href === r.href;
    if (same) last.text += text;
    else out.push({ ...r, text });
  }
  if (!pre) {
    // Collapse spaces across run boundaries, then trim the block's ends.
    for (let i = 1; i < out.length; i++) if (out[i - 1].text.endsWith(' ') && out[i].text.startsWith(' ')) out[i].text = out[i].text.slice(1);
    if (out.length) out[0].text = out[0].text.replace(/^[ \t\n\r\f]+/, '');
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/[ \t\n\r\f]+$/, '');
  }
  for (const r of out) r.text = r.text.replace(/ ?\u0001 ?/g, '\n');
  return out.filter((r) => r.text);
}

function flush(ctx: Ctx, kind: BlockKind, extra: Partial<Draft> = {}) {
  const runs = tidy(ctx.runs, kind === 'code');
  ctx.runs = [];
  if (!runs.length) return;
  ctx.out.push({ kind, runs, ids: ctx.ids.splice(0), ...extra });
}

function inline(n: XNode, ctx: Ctx, style: Style) {
  for (const c of n.children) {
    if (typeof c === 'string') {
      ctx.runs.push({ text: c, ...style });
      continue;
    }
    if (SKIP.has(c.name)) continue;
    if (c.attrs.id) ctx.ids.push(c.attrs.id);
    const s: Style = { ...style };
    switch (c.name) {
      case 'em':
      case 'i':
      case 'cite':
      case 'dfn':
      case 'var':
        s.em = true;
        break;
      case 'strong':
      case 'b':
        s.strong = true;
        break;
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        s.code = true;
        break;
      case 'sup':
        s.sup = true;
        break;
      case 'br':
        ctx.runs.push({ text: BR, ...style });
        continue;
      case 'img':
        // Inline images inside running text (icons, drop caps) are dropped; their alt text keeps the sense.
        if (c.attrs.alt) ctx.runs.push({ text: c.attrs.alt, ...style });
        continue;
      case 'a': {
        const href = c.attrs.href;
        if (href) s.href = EXTERNAL.test(href) ? href : ctx.resolve(href);
        if (/noteref/.test(attr(c, 'type') ?? '')) s.sup = true;
        break;
      }
    }
    inline(c, ctx, s);
  }
}

const hasBlockChild = (n: XNode) => n.children.some((c) => typeof c !== 'string' && (BLOCK.has(c.name) || c.name === 'img' || c.name === 'svg'));

/**
 * One chapter (XHTML) → drafts. Block elements become blocks, inline markup becomes runs,
 * images become figures, tables become one line per row, ids become anchors.
 */
export function chapterDrafts(body: XNode, resolve: (href: string) => string): Draft[] {
  const ctx: Ctx = { out: [], runs: [], ids: [], resolve };
  const counters: number[] = [];

  const block = (n: XNode, kind: BlockKind, quote: boolean) => {
    for (const c of n.children) {
      if (typeof c === 'string') {
        ctx.runs.push({ text: c });
        continue;
      }
      if (SKIP.has(c.name)) continue;
      const k: BlockKind = quote && kind === 'p' ? 'quote' : kind;
      if (!BLOCK.has(c.name) && c.name !== 'img' && c.name !== 'svg') {
        // Inline element directly in a block container: part of the running text.
        inline({ name: '#wrap', attrs: {}, children: [c] }, ctx, {});
        continue;
      }
      // A block element ends the inline content gathered so far.
      flush(ctx, k);
      if (c.attrs.id) ctx.ids.push(c.attrs.id);
      const heading = /^h([1-6])$/.exec(c.name);
      if (heading) {
        inline(c, ctx, {});
        flush(ctx, (['h1', 'h1', 'h2', 'h3', 'h3', 'h3', 'h3'] as const)[Number(heading[1])]);
      } else if (c.name === 'img' || c.name === 'svg') {
        const src = c.name === 'img' ? c.attrs.src : svgImage(c);
        if (src) ctx.out.push({ kind: 'figure', runs: [], src: resolve(src), alt: c.attrs.alt ?? '', ids: ctx.ids.splice(0) });
      } else if (c.name === 'hr') {
        ctx.out.push({ kind: 'rule', runs: [], ids: ctx.ids.splice(0) });
      } else if (c.name === 'pre') {
        inline(c, ctx, {});
        flush(ctx, 'code');
      } else if (c.name === 'figcaption' || c.name === 'caption') {
        inline(c, ctx, {});
        flush(ctx, 'caption');
      } else if (c.name === 'tr') {
        // Tables read row by row, cells separated by a middle dot.
        kidsOf(c).forEach((cell, i) => {
          if (i) ctx.runs.push({ text: ' · ' });
          inline(cell, ctx, cell.name === 'th' ? { strong: true } : {});
        });
        flush(ctx, 'p');
      } else if (c.name === 'ol' || c.name === 'ul') {
        counters.push(c.name === 'ol' ? Number(c.attrs.start ?? 1) : 0);
        block(c, kind, quote);
        counters.pop();
      } else if (c.name === 'li') {
        const n = counters[counters.length - 1] ?? 0;
        const marker = n ? `${n}.` : '•';
        if (n) counters[counters.length - 1] = n + 1;
        // The item's own text (or its first paragraph) is the list item; anything after it reads as normal blocks.
        const first = hasBlockChild(c) ? kidsOf(c)[0] : undefined;
        if (first && (first.name === 'p' || first.name === 'div') && !hasBlockChild(first)) {
          inline(first, ctx, {});
          flush(ctx, 'li', { marker });
          block({ ...c, children: c.children.filter((x) => x !== first) }, 'p', quote);
        } else if (hasBlockChild(c)) {
          block(c, 'p', quote);
        } else {
          inline(c, ctx, {});
          flush(ctx, 'li', { marker });
        }
      } else if (hasBlockChild(c)) {
        block(c, c.name === 'blockquote' ? 'p' : kind, quote || c.name === 'blockquote');
      } else {
        inline(c, ctx, {});
        flush(ctx, c.name === 'blockquote' || quote ? 'quote' : 'p');
      }
    }
    flush(ctx, quote && kind === 'p' ? 'quote' : kind);
  };

  block(body, 'p', false);
  // Ids after the last block (an empty anchor at the end) point at the last block.
  if (ctx.ids.length && ctx.out.length) ctx.out[ctx.out.length - 1].ids.push(...ctx.ids);
  return ctx.out;
}

const kidsOf = (n: XNode) => n.children.filter((c): c is XNode => typeof c !== 'string' && !SKIP.has(c.name));

function svgImage(svg: XNode): string | undefined {
  for (const c of kidsOf(svg)) {
    if (c.name === 'image') return attr(c, 'href');
    const deep = svgImage(c);
    if (deep) return deep;
  }
  return undefined;
}
