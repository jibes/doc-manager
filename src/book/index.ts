import { strFromU8 } from 'fflate';

import type { Block } from '@/reflow/build';
import { readPackage, resolvePath } from './epub';
import { chapterDrafts, type Draft } from './html';
import { imageSize } from './image';
import { find, parseMarkup } from './xml';

export { EpubError } from './epub';

/**
 * A reflowable book as Tessel reads it: the same blocks as the PDF text view, paginated into
 * virtual pages so progress, bookmarks, the scrubber and "finished" work exactly as for PDFs.
 */
export type Book = {
  title?: string;
  author?: string;
  language?: string;
  blocks: Block[];
  pageCount: number;
  toc: { title: string; page: number; block: number; depth: number }[];
  /** `path#id` or `path` → block index, for links and footnotes. */
  anchors: Record<string, number>;
  /** Images (and the cover) by path inside the book. */
  images: Record<string, { bytes: Uint8Array; type: string }>;
  cover?: string;
};

/** About a printed paperback page. Each chapter starts on a new page. */
export const CHARS_PER_PAGE = 1800;

const weight = (d: Draft, text: string) =>
  d.kind === 'figure' ? CHARS_PER_PAGE * 0.4 : d.kind === 'rule' ? 120 : d.kind.startsWith('h') ? text.length * 2 + 160 : text.length + 40;

export function openBook(bytes: Uint8Array): Book {
  const pkg = readPackage(bytes);
  const blocks: Block[] = [];
  const anchors: Record<string, number> = {};
  const images: Book['images'] = {};
  const sizeOf = (path: string) => {
    const f = pkg.files[path];
    if (!f) return null;
    images[path] ??= { bytes: f, type: pkg.types[path] ?? 'image/*' };
    return imageSize(f);
  };

  let page = 0;
  let used = 0;
  for (const path of pkg.spine) {
    const doc = parseMarkup(strFromU8(pkg.files[path]), false);
    const body = find(doc, (n) => n.name === 'body') ?? doc;
    const drafts = chapterDrafts(body, (href) => resolvePath(path, href));
    if (!drafts.length) continue;
    if (used > 0) {
      page++;
      used = 0;
    }
    anchors[path] = blocks.length;
    for (const d of drafts) {
      if (d.kind === 'figure' && (!d.src || !pkg.files[d.src])) continue;
      const text = d.kind === 'figure' ? (d.alt ?? '') : d.runs.map((r) => r.text).join('');
      for (const id of d.ids) anchors[`${path}#${id}`] = blocks.length;
      const size = d.src ? sizeOf(d.src) : null;
      const plain = d.runs.every((r) => !r.em && !r.strong && !r.code && !r.sup && !r.href);
      blocks.push({
        kind: d.kind,
        text,
        marker: d.marker,
        runs: d.runs.length && !plain ? d.runs : undefined,
        src: d.src,
        imgW: size?.w,
        imgH: size?.h,
        page,
        y: used / CHARS_PER_PAGE,
      });
      used += weight(d, text);
      while (used >= CHARS_PER_PAGE) {
        page++;
        used -= CHARS_PER_PAGE;
      }
    }
  }
  const pageCount = used > 0 || !blocks.length ? page + 1 : page;

  const toc = pkg.toc.flatMap((e) => {
    const i = anchors[e.href] ?? anchors[e.href.split('#')[0]];
    return i === undefined || !e.title ? [] : [{ title: e.title, page: blocks[i].page, block: i, depth: e.depth }];
  });
  if (pkg.cover) sizeOf(pkg.cover);

  return { title: pkg.title, author: pkg.author, language: pkg.language, blocks, pageCount, toc, anchors, images, cover: pkg.cover };
}

/** Looks a link up: internal targets resolve to a block index; external links return null. */
export function linkTarget(book: Book, href: string): number | null {
  if (/^(https?:|mailto:)/i.test(href)) return null;
  return book.anchors[href] ?? book.anchors[href.split('#')[0]] ?? null;
}
