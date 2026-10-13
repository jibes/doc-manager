import { create } from 'zustand';

import { errorText, t } from '@/i18n';
import { openBook } from '@/book';
import { coverData, readBytes } from '@/book/platform';
import { asPasswordError, engine } from '@/engine';
import { askPassword, rememberPassword } from '@/state/password';
import type { FileHandle } from '@/lib/fsa';
import { folders } from '@/lib/folders';
import { imageSize } from '@/book/image';
import type { DocSource } from '@/engine/types';
import { repo, type DocRecord, type ReadingPosition } from '@/storage';

/**
 * `handle` (Chromium) or `link` (a document in a folder, through the Android app): the file in place;
 * the library then links to it instead of keeping a copy.
 */
export type ImportItem = { name: string; size: number; file?: Blob; uri?: string; handle?: FileHandle; link?: string; bundled?: boolean };

/**
 * Android app: a document that would only be a hidden copy inside the app (a scan, a file opened from mail
 * or another app) becomes a real file in Documents/Tessel, and the library links to it. Elsewhere, and for
 * the bundled sample, the library keeps its copy.
 */
async function intoAppFolder(item: ImportItem): Promise<ImportItem> {
  if (item.handle || item.link || !item.file || item.bundled) return item;
  const app = await folders.appFolder().catch(() => null);
  if (!app) return item;
  const made = await folders.create({ root: app.id }, item.name, item.file);
  return { ...item, name: made.name, link: made.uri };
}

/** What the library stores for an imported item: the file in place where possible, else a copy. */
const fileData = (item: ImportItem) => item.handle ?? (item.link ? ({ kind: 'shell', uri: item.link } as const) : undefined) ?? item.file ?? item.uri!;
const isLinked = (item: ImportItem) => (item.handle || item.link ? true : undefined);

type LibraryState = {
  docs: DocRecord[];
  covers: Record<string, string | null>;
  loaded: boolean;
  /** File names currently being imported. */
  importing: string[];
  error: string | null;
  load(): Promise<void>;
  importFiles(items: ImportItem[]): Promise<DocRecord[]>;
  remove(id: string): Promise<void>;
  /** `atEnd`: the reader reached the end (page view: scrolled to the bottom); defaults to being on the last page. */
  savePosition(id: string, position: ReadingPosition, atEnd?: boolean): void;
  toggleBookmark(id: string, page: number): void;
  toggleReading(id: string): void;
  setView(id: string, view: 'page' | 'text'): void;
  toggleInvert(id: string): void;
  markOpened(id: string): void;
  /** Record facts that changed with the file itself (a linked file edited elsewhere). */
  updateFileInfo(id: string, info: { pageCount: number }): void;
  /** Point a linked document at a new location (after it was moved). */
  relink(id: string, handle: FileHandle): Promise<void>;
  clearError(): void;
  /** The file browser renamed or moved files: documents linked to them follow. */
  followFiles(moves: { from: string; to: string }[]): Promise<void>;
  /** The file browser deleted files: documents linked to them leave the library. */
  forgetFiles(uris: string[]): Promise<void>;
};

/** The file name at the end of a file:// or document URI. */
const nameOfUri = (uri: string) => decodeURIComponent(uri).split(/[/:]/).pop() ?? uri;

const COVER_WIDTH = 360;
/** The bundled guide: it stays a copy (it is part of the app, not the user's document). */
export const SAMPLE_FILE = 'welcome-to-tessel.pdf';

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Prefer embedded title unless it's producer junk; fall back to a cleaned file name. */
export function cleanTitle(metaTitle: string | undefined, fileName: string): string {
  const junk = /^(untitled|document|microsoft word|slide ?\d*|title|\s*)$/i;
  const meta = metaTitle?.replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\.(docx?|pptx?)$/i, '').trim();
  if (meta && !junk.test(meta) && meta.length < 160) return meta;
  return fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || t.untitled;
}

/**
 * Runs `attempt`, asking for a password while the document is encrypted.
 * Resolves null if the user dismisses the prompt.
 */
export async function openWithPassword<T>(
  name: string,
  attempt: (password?: string) => Promise<T>,
  password?: string,
): Promise<{ value: T; password?: string } | null> {
  for (;;) {
    try {
      return { value: await attempt(password), password };
    } catch (e) {
      const pe = asPasswordError(e);
      if (!pe) throw e;
      const next = await askPassword(name, pe.wrong);
      if (next == null) return null;
      password = next;
    }
  }
}

/** EPUB by name, or by its signature: a ZIP whose first entry is "mimetype" = application/epub+zip. */
function isEpub(name: string, source: DocSource): boolean {
  if (/\.epub$/i.test(name)) return true;
  if (source.kind !== 'bytes') return false;
  const head = new TextDecoder('latin1').decode(new Uint8Array(source.bytes, 0, Math.min(64, source.bytes.byteLength)));
  return head.startsWith('PK') && head.includes('mimetypeapplication/epub+zip');
}

/** Books are for reading: they go straight onto the reading list. */
async function importBook(item: ImportItem, source: DocSource, set: (fn: (s: LibraryState) => Partial<LibraryState>) => void): Promise<DocRecord> {
  const book = openBook(await readBytes(source));
  const id = newId();
  const cover = book.cover ? book.images[book.cover] : undefined;
  const size = cover ? imageSize(cover.bytes) : null;
  const rec: DocRecord = {
    id,
    title: book.title?.trim() || cleanTitle(undefined, item.name.replace(/\.epub$/i, '')),
    author: book.author,
    fileName: item.name,
    bytes: item.size,
    pageCount: book.pageCount,
    coverAspect: size ? size.h / size.w : 1.5,
    addedAt: Date.now(),
    bookmarks: [],
    reading: { since: Date.now() },
    format: 'epub',
    linked: isLinked(item),
  };
  await repo.saveFile(id, fileData(item));
  if (cover) await repo.saveCover(id, coverData(cover.bytes, cover.type));
  await repo.put(rec);
  const coverUri = await repo.coverUri(id);
  set((s) => ({ docs: [rec, ...s.docs], covers: { ...s.covers, [id]: coverUri } }));
  return rec;
}

const byRecent = (a: DocRecord, b: DocRecord) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt);

let persistTimer: ReturnType<typeof setTimeout> | undefined;
const dirty = new Set<string>();

export const useLibrary = create<LibraryState>((set, get) => {
  const patch = (id: string, fn: (d: DocRecord) => DocRecord, debounce = false) => {
    const docs = get().docs.map((d) => (d.id === id ? fn(d) : d));
    set({ docs });
    const rec = docs.find((d) => d.id === id);
    if (!rec) return;
    if (!debounce) return void repo.put(rec);
    dirty.add(id);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      for (const d of get().docs) if (dirty.has(d.id)) repo.put(d);
      dirty.clear();
    }, 600);
  };

  /** Android app, once per document: copies kept inside the app by earlier versions move to Documents/Tessel. */
  const moveCopies = async () => {
    const app = await folders.appFolder().catch(() => null);
    if (!app) return;
    for (const d of get().docs) {
      if (d.linked || d.fileName === SAMPLE_FILE) continue;
      try {
        const src = await repo.source(d.id);
        if (src.kind !== 'bytes') continue;
        const type = /\.epub$/i.test(d.fileName) ? 'application/epub+zip' : 'application/pdf';
        const made = await folders.create({ root: app.id }, d.fileName, new Blob([src.bytes], { type }));
        if (!made.uri) continue;
        await repo.relink(d.id, made.uri);
        patch(d.id, (x) => ({ ...x, linked: true, fileName: made.name }));
      } catch {
        // Tried again on the next start.
      }
    }
  };

  return {
    docs: [],
    covers: {},
    loaded: false,
    importing: [],
    error: null,

    async load() {
      if (get().loaded) return;
      const docs = (await repo.list()).sort(byRecent);
      set({ docs, loaded: true });
      const entries = await Promise.all(docs.map(async (d) => [d.id, await repo.coverUri(d.id)] as const));
      set({ covers: Object.fromEntries(entries) });
      void moveCopies();
    },

    async importFiles(items) {
      const added: DocRecord[] = [];
      for (let item of items) {
        const existing = get().docs.find((d) => d.fileName === item.name && d.bytes === item.size);
        if (existing) {
          added.push(existing);
          continue;
        }
        const label = item.name;
        set((s) => ({ importing: [...s.importing, label] }));
        try {
          item = await intoAppFolder(item);
          const source = item.file
            ? ({ kind: 'bytes', bytes: await item.file.arrayBuffer() } as const)
            : ({ kind: 'uri', uri: item.uri! } as const);
          if (isEpub(item.name, source)) {
            added.push(await importBook(item, source, set));
            continue;
          }
          const opened = await openWithPassword(item.name, (pw) => engine.renderCover(source, COVER_WIDTH, pw));
          if (!opened) continue; // password prompt dismissed
          const { cover, handle } = opened.value;
          const first = handle.pageSizes[0] ?? { width: 1, height: 1.414 };
          const id = newId();
          const rec: DocRecord = {
            id,
            title: cleanTitle(handle.metadata.title, item.name),
            author: handle.metadata.author,
            fileName: item.name,
            bytes: item.size,
            pageCount: handle.pageCount,
            coverAspect: first.height / first.width,
            addedAt: Date.now(),
            bookmarks: [],
            linked: isLinked(item),
          };
          handle.close();
          if (opened.password) rememberPassword(id, opened.password);
          await repo.saveFile(id, fileData(item));
          await repo.saveCover(id, cover);
          await repo.put(rec);
          const coverUri = await repo.coverUri(id);
          set((s) => ({ docs: [rec, ...s.docs], covers: { ...s.covers, [id]: coverUri } }));
          added.push(rec);
        } catch (e) {
          set({ error: `${t.importFailed(item.name)} ${errorText(e)}` });
        } finally {
          set((s) => ({ importing: s.importing.filter((n) => n !== label) }));
        }
      }
      return added;
    },

    async remove(id) {
      set((s) => ({ docs: s.docs.filter((d) => d.id !== id) }));
      await repo.remove(id);
    },

    savePosition: (id, position, atEnd) =>
      patch(
        id,
        (d) => {
          // Reaching the end finishes a reading-list document; it moves to "Finished".
          const done = d.reading && !d.reading.finishedAt && (atEnd ?? position.page >= d.pageCount - 1);
          return { ...d, position, reading: done ? { ...d.reading!, finishedAt: Date.now() } : d.reading };
        },
        true,
      ),

    setView: (id, view) => patch(id, (d) => ({ ...d, view })),

    toggleInvert: (id) => patch(id, (d) => ({ ...d, invert: d.invert ? undefined : true })),

    toggleReading: (id) => patch(id, (d) => ({ ...d, reading: d.reading ? undefined : { since: Date.now() } })),

    toggleBookmark: (id, page) =>
      patch(id, (d) => ({
        ...d,
        bookmarks: d.bookmarks.includes(page)
          ? d.bookmarks.filter((p) => p !== page)
          : [...d.bookmarks, page].sort((a, b) => a - b),
      })),

    markOpened: (id) => {
      patch(id, (d) => ({ ...d, openedAt: Date.now() }));
      set((s) => ({ docs: [...s.docs].sort(byRecent) }));
    },

    updateFileInfo: (id, info) => {
      const d = get().docs.find((x) => x.id === id);
      if (d && d.pageCount !== info.pageCount) patch(id, (x) => ({ ...x, pageCount: info.pageCount }));
    },

    async relink(id, handle) {
      const file = await handle.getFile();
      await repo.saveFile(id, handle);
      patch(id, (d) => ({ ...d, fileName: file.name, bytes: file.size, linked: true }));
    },

    clearError: () => set({ error: null }),

    async followFiles(moves) {
      const linked = await repo.linkedTo(moves.map((m) => m.from));
      for (const [uri, ids] of linked) {
        // The file itself, or one inside a moved folder: same path below the new place.
        const m = moves.find((x) => uri === x.from || uri.startsWith(x.from));
        if (!m) continue;
        const to = m.to + uri.slice(m.from.length);
        for (const id of ids) {
          await repo.relink(id, to);
          patch(id, (d) => ({ ...d, fileName: nameOfUri(to) }));
        }
      }
    },

    async forgetFiles(uris) {
      const linked = await repo.linkedTo(uris);
      for (const ids of linked.values()) for (const id of ids) await get().remove(id);
    },
  };
});
