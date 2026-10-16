import { createStore, del, delMany, entries, get, getMany, keys, set, values } from 'idb-keyval';

import type { TextLine } from '@/core/engine/types';
import { ensurePermission, isFileHandle, isGranted, writeFile, type FileHandle } from '@/core/lib/fsa';
import { shellDocUrl, writeToShell } from '@/core/lib/shell';
import { FILE_ACCESS, FILE_MOVED, isShellLink, NOT_KEPT, type DocRecord, type LibraryRepo } from './types';

export * from './types';

// Store names predate the rename to Tessel; changing them would orphan existing libraries.
const meta = createStore('quire-meta', 'docs');
const files = createStore('quire-files', 'files');
const covers = createStore('quire-covers', 'covers');
const ocr = createStore('tessel-ocr', 'pages');
const coverUrls = new Map<string, string>();
// Viewed documents (not kept): their files and recognised text, in memory only.
const viewed = new Map<string, Blob | FileHandle>();
const viewedOcr = new Map<string, TextLine[]>();
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
    const stored = viewed.get(id) ?? (await get<unknown>(id, files));
    if (isShellLink(stored)) {
      const res = await fetch(shellDocUrl(stored.uri)).catch(() => null);
      if (!res?.ok) throw new Error(FILE_MOVED);
      return { kind: 'bytes', bytes: await res.arrayBuffer() };
    }
    if (isFileHandle(stored)) {
      if (!(await isGranted(stored))) throw new Error(FILE_ACCESS);
      const file = await stored.getFile().catch(() => {
        throw new Error(FILE_MOVED);
      });
      return { kind: 'bytes', bytes: await file.arrayBuffer() };
    }
    if (!(stored instanceof Blob)) throw new Error('This document’s file is missing from storage.');
    return { kind: 'bytes', bytes: await stored.arrayBuffer() };
  },
  async requestAccess(id, write = false) {
    const stored = viewed.get(id) ?? (await get<unknown>(id, files));
    return isFileHandle(stored) ? ensurePermission(stored, write) : true;
  },
  async writeFile(id, bytes) {
    if (viewed.has(id)) throw new Error(NOT_KEPT);
    const stored = await get<unknown>(id, files);
    if (isShellLink(stored)) return writeToShell(bytes, stored.uri);
    if (!isFileHandle(stored)) return set(id, new Blob([bytes], { type: 'application/pdf' }), files);
    if (!(await ensurePermission(stored, true))) throw new Error(FILE_ACCESS);
    await writeFile(stored, bytes);
  },
  async linkedTo(uris) {
    const out = new Map<string, string[]>();
    const inside = (uri: string, base: string) => uri === base || uri.startsWith(`${base}/`) || uri.startsWith(`${base}%2F`);
    for (const [id, data] of await entries<string, unknown>(files)) {
      if (isShellLink(data) && uris.some((u) => inside(data.uri, u))) out.set(data.uri, [...(out.get(data.uri) ?? []), id]);
    }
    return out;
  },
  async linkedToHandle(handle) {
    const ids: string[] = [];
    for (const [id, data] of await entries<string, unknown>(files)) {
      if (isFileHandle(data) && data.name === handle.name && (await data.isSameEntry(handle).catch(() => false))) ids.push(id);
    }
    return ids;
  },
  async relink(id, uri) {
    await set(id, { kind: 'shell', uri }, files);
  },
  async linkOf(id) {
    const stored = await get<unknown>(id, files);
    return isShellLink(stored) ? stored.uri : undefined;
  },
  async handleOf(id) {
    const stored = viewed.get(id) ?? (await get<unknown>(id, files));
    return isFileHandle(stored) ? stored : undefined;
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
  async loadOcr(id, pageCount) {
    if (viewed.has(id)) return Array.from({ length: pageCount }, (_, i) => viewedOcr.get(ocrKey(id, i)));
    return getMany<TextLine[] | undefined>(Array.from({ length: pageCount }, (_, i) => ocrKey(id, i)), ocr);
  },
  async saveOcr(id, page, lines) {
    if (viewed.has(id)) return void viewedOcr.set(ocrKey(id, page), lines);
    await set(ocrKey(id, page), lines, ocr);
  },
  hold: (id, data) => void viewed.set(id, data),
  held: (id) => viewed.get(id),
  release(id) {
    viewed.delete(id);
    for (const k of [...viewedOcr.keys()]) if (k.startsWith(`${id}#`)) viewedOcr.delete(k);
  },
};
