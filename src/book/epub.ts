import { strFromU8, unzipSync } from 'fflate';

import { attr, find, findAll, kids, local, parseMarkup, textOf, type XNode } from './xml';

/** The EPUB container: metadata, reading order (spine), table of contents and the files themselves. */
export type EpubPackage = {
  title?: string;
  author?: string;
  language?: string;
  /** When it was published, as YYYY-MM-DD (only a full date). */
  date?: string;
  /** Its subjects (dc:subject), as keywords. */
  subjects: string[];
  /** Content documents in reading order (linear items only). */
  spine: string[];
  toc: { title: string; href: string; depth: number }[];
  cover?: string;
  /** Media type by path. */
  types: Record<string, string>;
  files: Record<string, Uint8Array>;
};

/** Not a readable EPUB; the message starts with "epub:" so the UI can explain it as a book problem. */
export class EpubError extends Error {
  constructor(detail: string) {
    super(`epub: ${detail}`);
  }
}

/** Joins a relative href onto the directory of `base`, resolving `.`/`..` and %-escapes; keeps any #fragment. */
export function resolvePath(base: string, href: string): string {
  const [path, frag] = href.split('#');
  if (!path) return frag !== undefined ? `${base}#${frag}` : base;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the raw path.
  }
  const parts = decoded.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of decoded.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const joined = parts.join('/');
  return frag !== undefined ? `${joined || base}#${frag}` : joined;
}

const text = (files: Record<string, Uint8Array>, path: string) => {
  const f = files[path];
  if (!f) throw new EpubError(`Missing ${path}`);
  return strFromU8(f);
};

export function readPackage(bytes: Uint8Array): EpubPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubError('Not a ZIP archive');
  }
  const container = parseMarkup(text(files, 'META-INF/container.xml'), true);
  const opfPath = attr(find(container, (n) => local(n.name) === 'rootfile') ?? { name: '', attrs: {}, children: [] }, 'full-path');
  if (!opfPath) throw new EpubError('No package document');
  const opf = parseMarkup(text(files, opfPath), true);
  const meta = (name: string) => {
    const n = find(opf, (x) => local(x.name) === name && x.name.includes(':'));
    return n ? textOf(n).replace(/\s+/g, ' ').trim() || undefined : undefined;
  };

  const items = new Map<string, { href: string; type: string; props: string }>();
  for (const it of findAll(opf, (x) => local(x.name) === 'item')) {
    const id = attr(it, 'id');
    const href = attr(it, 'href');
    if (id && href) items.set(id, { href: resolvePath(opfPath, href), type: attr(it, 'media-type') ?? '', props: attr(it, 'properties') ?? '' });
  }
  const types = Object.fromEntries([...items.values()].map((i) => [i.href, i.type]));

  const spineNode = find(opf, (x) => local(x.name) === 'spine');
  const spine = spineNode
    ? kids(spineNode)
        .filter((r) => local(r.name) === 'itemref' && attr(r, 'linear') !== 'no')
        .map((r) => items.get(attr(r, 'idref') ?? '')?.href)
        .filter((h): h is string => !!h && !!files[h])
    : [];
  if (!spine.length) throw new EpubError('Empty spine');

  // Cover: EPUB 3 "cover-image" property, else the EPUB 2 <meta name="cover"> pointer, else an image named like a cover.
  const coverMeta = find(opf, (x) => local(x.name) === 'meta' && attr(x, 'name') === 'cover');
  const all = [...items.values()];
  const cover =
    all.find((i) => /\bcover-image\b/.test(i.props))?.href ??
    items.get(coverMeta ? (attr(coverMeta, 'content') ?? '') : '')?.href ??
    all.find((i) => i.type.startsWith('image/') && /cover/i.test(i.href))?.href;

  // Table of contents: EPUB 3 nav document, else EPUB 2 NCX.
  let toc: EpubPackage['toc'] = [];
  const nav = all.find((i) => /\bnav\b/.test(i.props));
  if (nav && files[nav.href]) toc = navToc(parseMarkup(text(files, nav.href), false), nav.href);
  if (!toc.length) {
    const ncxId = spineNode ? attr(spineNode, 'toc') : undefined;
    const ncx = (ncxId && items.get(ncxId)) || all.find((i) => i.type === 'application/x-dtbncx+xml');
    if (ncx && files[ncx.href]) toc = ncxToc(parseMarkup(text(files, ncx.href), true), ncx.href);
  }

  const date = /^(\d{4}-\d{2}-\d{2})/.exec(meta('date') ?? '')?.[1];
  const subjects = [...new Set(findAll(opf, (x) => local(x.name) === 'subject' && x.name.includes(':')).map((n) => textOf(n).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  return { title: meta('title'), author: meta('creator'), language: meta('language'), date, subjects, spine, toc, cover: cover && files[cover] ? cover : undefined, types, files };
}

function navToc(doc: XNode, base: string): EpubPackage['toc'] {
  const nav =
    find(doc, (x) => x.name === 'nav' && /\btoc\b/.test(attr(x, 'type') ?? '')) ?? find(doc, (x) => x.name === 'nav');
  if (!nav) return [];
  const out: EpubPackage['toc'] = [];
  const list = (ol: XNode, depth: number) => {
    for (const li of kids(ol).filter((x) => x.name === 'li')) {
      const a = kids(li).find((x) => x.name === 'a' || x.name === 'span');
      const href = a && attr(a, 'href');
      if (a && href) out.push({ title: textOf(a).replace(/\s+/g, ' ').trim(), href: resolvePath(base, href), depth });
      const sub = kids(li).find((x) => x.name === 'ol' || x.name === 'ul');
      if (sub) list(sub, depth + 1);
    }
  };
  const top = find(nav, (x) => x.name === 'ol' || x.name === 'ul');
  if (top) list(top, 0);
  return out;
}

function ncxToc(doc: XNode, base: string): EpubPackage['toc'] {
  const out: EpubPackage['toc'] = [];
  const points = (n: XNode, depth: number) => {
    for (const p of kids(n).filter((x) => local(x.name) === 'navpoint')) {
      const label = find(p, (x) => local(x.name) === 'text');
      const content = kids(p).find((x) => local(x.name) === 'content');
      const src = content && attr(content, 'src');
      if (label && src) out.push({ title: textOf(label).replace(/\s+/g, ' ').trim(), href: resolvePath(base, src), depth });
      points(p, depth + 1);
    }
  };
  const map = find(doc, (x) => local(x.name) === 'navmap');
  if (map) points(map, 0);
  return out;
}
