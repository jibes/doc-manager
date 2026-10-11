import { createStore, del, delMany, get, getMany, keys, set, values } from 'idb-keyval';

import type { TextLine } from '@/engine/types';
import type { DocRecord, LibraryRepo } from './types';

export * from './types';

// Store names predate the rename to Tessel; changing them would orphan existing libraries.
const meta = createStore('quire-meta', 'docs');
const files = createStore('quire-files', 'files');
const covers = createStore('quire-covers', 'covers');
const ocr = createStore('tessel-ocr', 'pages');
const coverUrls = new Map<string, string>();
const ocrKey = (id: string, page: number) => `${id}#${page}`;

// Ask the browser not to evict the library under storage pressure.
navigator.storage?.persist?.().catch(() => {});

export const repo: LibraryRepo = {
  list: () => values<DocRecord>(meta),
  put: (rec) => set(rec.id, rec, meta),
  async remove(id) {
    const pages = (await keys<string>(ocr)).filter((k) => k.startsWith(`${id}#`));
    await Promise.all([del(id, meta), del(id, files), del(id, covers), delMany(pages, ocr)]);
    const url = coverUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    coverUrls.delete(id);
  },
  async saveFile(id, data) {
    await set(id, data, files);
  },
  async source(id) {
    const blob = await get<Blob>(id, files);
    if (!blob) throw new Error('This document’s file is missing from storage.');
    return { kind: 'bytes', bytes: await blob.arrayBuffer() };
  },
  async saveCover(id, cover) {
    await set(id, cover, covers);
  },
  async coverUri(id) {
    const cached = coverUrls.get(id);
    if (cached) return cached;
    const blob = await get<Blob>(id, covers);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    coverUrls.set(id, url);
    return url;
  },
  loadOcr: (id, pageCount) => getMany<TextLine[] | undefined>(Array.from({ length: pageCount }, (_, i) => ocrKey(id, i)), ocr),
  async saveOcr(id, page, lines) {
    await set(ocrKey(id, page), lines, ocr);
  },
};
