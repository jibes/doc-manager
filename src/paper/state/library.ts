import { create } from 'zustand';

import { errorText, t } from '@/core/i18n';
import { asPasswordError, engine } from '@/core/engine';
import { preopen } from '@/paper/reader/preopened';
import { askPassword, passwordFor, rememberPassword } from '@/paper/state/password';
import { usePrefs } from '@/paper/state/prefs';
import { isFileHandle, type FileHandle } from '@/core/lib/fsa';
import { ask } from '@/paper/state/ask';
import { forget, recall, remember, viewedKey } from '@/paper/state/viewed';
import { loadCache, remember as cache } from '@/paper/state/cache';
import type { FolderEntry } from '@/core/lib/folderTypes';
import { folders } from '@/core/lib/folders';
import { sameOrRenamed } from '@/core/lib/names';
import { startsWith } from '@/core/lib/bytes';
import { readStored, writeStored } from '@/core/lib/stored';
import { docKey } from '@/paper/archive/docKey';
import { inboxDir } from '@/paper/archive/dirs';
import type { DocSource } from '@/core/engine/types';
import { FILE_MOVED, repo, type DocRecord, type ReadingPosition } from '@/core/storage';

/**
 * `handle` (Chromium) or `link` (a document in a folder, through the Android app): the file in place;
 * the library then links to it instead of keeping a copy.
 */
export type ImportItem = { name: string; size: number; file?: Blob; uri?: string; handle?: FileHandle; link?: string; bundled?: boolean };

/**
 * A document kept from elsewhere (bytes only: a file from mail or another app) becomes a real file in the Tessel
 * folder, and the library links to it: in its Inbox when a Tessel folder is chosen (it syncs, and is filed from
 * there), else in Documents/Tessel (Android) or the browser's own Tessel folder. The bundled guide stays a copy.
 */
async function intoAppFolder(item: ImportItem): Promise<ImportItem> {
  if (item.handle || item.link || !item.file || item.bundled) return item;
  const tessel = usePrefs.getState().archive;
  if (tessel) {
    const made = await folders.create({ root: tessel, dir: await inboxDir(tessel) }, item.name, item.file);
    return { ...item, name: made.name, link: made.uri, handle: made.handle };
  }
  const app = await folders.appFolder().catch(() => null);
  if (!app) return item;
  const made = await folders.create({ root: app.id }, item.name, item.file);
  return { ...item, name: made.name, link: made.uri, handle: made.handle };
}

/** What the library stores for an imported item: the file in place where possible, else a copy. */
const fileData = (item: ImportItem) => item.handle ?? (item.link ? ({ kind: 'shell', uri: item.link } as const) : undefined) ?? item.file ?? item.uri!;
const isLinked = (item: ImportItem) => (item.handle || item.link ? true : undefined);

type LibraryState = {
  docs: DocRecord[];
  /** EPUB books from before Tessel was PDFs only: not listed, kept until removed (Settings offers to save them first). */
  books: DocRecord[];
  forgetBooks(): Promise<void>;
  covers: Record<string, string | null>;
  loaded: boolean;
  /** File names currently being imported. */
  importing: string[];
  error: string | null;
  load(): Promise<void>;
  importFiles(items: ImportItem[]): Promise<DocRecord[]>;
  /**
   * A file from elsewhere (another app, a share, Open file), to look at: opened without being kept, where it was
   * left the last time it was viewed (or the library's own document, if it has this one). Null when not opened.
   */
  view(item: ImportItem): Promise<DocRecord | null>;
  /** A viewed document becomes the library's (a file in place stays there; bytes go to the Tessel folder). */
  keep(id: string): Promise<boolean>;
  /** Before saving anything about a document: a viewed one is kept first, if the user agrees. */
  ensureKept(id: string): Promise<boolean>;
  /** A viewed document is closed: it leaves memory (its place stays in the viewed history). */
  closeViewed(id: string): void;
  remove(id: string): Promise<void>;
  /**
   * `atEnd`: the reader reached the end (page view: scrolled to the bottom); defaults to being on the last page.
   * Applied a couple of times a second (scrolling reports every frame); `flushPositions` applies it at once.
   */
  savePosition(id: string, position: ReadingPosition, atEnd?: boolean): void;
  /** `now`: written to storage at once too (the reader closes, the page goes away). */
  flushPositions(now?: boolean): void;
  setView(id: string, view: 'page' | 'text'): void;
  toggleInvert(id: string): void;
  /** The details written into the file changed: the library shows its new title and sender. */
  setDetails(id: string, details: { title: string; author?: string }): void;
  markOpened(id: string): void;
  /** The document is now this file (it was copied there): the library points at it, keeping everything else. */
  linkTo(id: string, item: ImportItem): Promise<void>;
  /** Changes from elsewhere (another device's reading, a computed share key), saved as they are. */
  patchDoc(id: string, changes: Partial<DocRecord>): void;
  /** Record facts that changed with the file itself (a linked file edited elsewhere). */
  updateFileInfo(id: string, info: { pageCount: number }): void;
  /** Point a linked document at a new location (after it was moved). */
  relink(id: string, handle: FileHandle): Promise<void>;
  clearError(): void;
  /** The file browser renamed or moved files: documents linked to them follow. */
  followFiles(moves: { from: string; to: string }[]): Promise<void>;
  /** A file is now another (filed from the inbox, a duplicate kept instead): documents linked to it follow. */
  followEntry(from: FolderEntry, to: FolderEntry): Promise<void>;
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

/** EPUB by name, or by its signature (a ZIP whose first entry is "mimetype" = application/epub+zip): books aren't Tessel's. */
function isEpub(name: string, source: DocSource): boolean {
  if (/\.epub$/i.test(name)) return true;
  if (source.kind !== 'bytes') return false;
  const head = new TextDecoder('latin1').decode(new Uint8Array(source.bytes, 0, Math.min(64, source.bytes.byteLength)));
  return head.startsWith('PK') && head.includes('mimetypeapplication/epub+zip');
}

/** The colour of a note on a page (the first highlight colour). */
const NOTE_COLOR = '#ffd54f';

/** When moving copies into the Tessel folder last failed; tried again after a day. */
const MOVE_FAILED = 'tessel.moveCopiesFailed';
const MOVE_RETRY_MS = 86_400_000;

const byRecent = (a: DocRecord, b: DocRecord) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt);

let persistTimer: ReturnType<typeof setTimeout> | undefined;
const dirty = new Set<string>();
// Positions reported while reading, not yet in the store.
const positions = new Map<string, { position: ReadingPosition; atEnd?: boolean; end?: boolean }>();
let positionTimer: ReturnType<typeof setTimeout> | undefined;
const POSITION_MS = 400;

/** The library's actions (stable): for components that mustn't re-render with the library. */
export const libraryActions = (): LibraryState => useLibrary.getState();

export const useLibrary = create<LibraryState>((set, get) => {
  // Debounced writes still waiting: written now.
  const persistNow = () => {
    clearTimeout(persistTimer);
    for (const d of get().docs) if (dirty.has(d.id)) repo.put(d);
    dirty.clear();
  };
  if (typeof window !== 'undefined' && typeof document !== 'undefined')
    // The tab closing or going to the background: where the reader is goes into storage before it does.
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && get().flushPositions(true));

  const patch = (id: string, fn: (d: DocRecord) => DocRecord, debounce = false) => {
    const docs = get().docs.map((d) => (d.id === id ? fn(d) : d));
    set({ docs });
    const rec = docs.find((d) => d.id === id);
    if (!rec) return;
    // Viewed: where it was left and how it looked go to the viewed history, nothing to the library.
    if (rec.viewed) return void remember(viewedKey(rec.shareKey!, rec.bytes), rec.fileName, { position: rec.position, view: rec.view, invert: rec.invert, openedAt: rec.openedAt });
    // What this device remembers about it goes to the cache, by its content (the library's record is going away).
    if (rec.shareKey) cache(rec.shareKey, { openedAt: rec.openedAt, position: rec.position, view: rec.view, invert: rec.invert ? true : undefined });
    if (!debounce) return void repo.put(rec);
    dirty.add(id);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      for (const d of get().docs) if (dirty.has(d.id)) repo.put(d);
      dirty.clear();
    }, 600);
  };

  /**
   * Once per document: copies kept by earlier versions move into the Tessel folder of the device (Documents/Tessel
   * in the Android app, the browser's own folder in a browser), and the library links to them there. When the folder
   * can't be written, not again for a day (each try reads every copy).
   */
  const moveCopies = async () => {
    const failedAt = Number(readStored(MOVE_FAILED) ?? 0);
    if (Date.now() - failedAt < MOVE_RETRY_MS) return;
    const app = await folders.appFolder().catch(() => null);
    if (!app) return;
    // One that can't be moved doesn't keep the others where they are.
    let failed = false;
    for (const d of get().docs) {
      if (d.linked || d.viewed || d.format === 'epub' || d.fileName === SAMPLE_FILE) continue;
      let src;
      try {
        src = await repo.source(d.id);
      } catch {
        continue;
      }
      if (src.kind !== 'bytes') continue;
      try {
        const made = await folders.create({ root: app.id }, d.fileName, new Blob([src.bytes], { type: 'application/pdf' }));
        if (made.uri) await repo.relink(d.id, made.uri);
        else if (made.handle) await repo.saveFile(d.id, made.handle);
        else continue;
        patch(d.id, (x) => ({ ...x, linked: true, fileName: made.name }));
      } catch {
        failed = true;
      }
    }
    if (failed) writeStored(MOVE_FAILED, String(Date.now()));
  };

  /**
   * Once, from before bookmarks were notes: each bookmarked page gets a note in its file ("Bookmark"), and the
   * document forgets its bookmarks. A file that can't be written keeps them, and says how many are left.
   */
  const bookmarksToNotes = async () => {
    let left = 0;
    for (const d of get().docs) {
      if (!d.bookmarks?.length || d.viewed) continue;
      let handle;
      try {
        const src = await repo.source(d.id);
        handle = await engine.open(src, passwordFor(d.id));
        for (const page of d.bookmarks) if (page < handle.pageCount) await handle.addNote(page, { x: 0.03, y: 0.02 }, NOTE_COLOR, t.pageNoteDefault);
        await repo.writeFile(d.id, await handle.save());
        patch(d.id, (x) => ({ ...x, bookmarks: [] }));
        void import('@/paper/archive/indexer').then((m) => m.invalidate(d.id));
      } catch {
        left += d.bookmarks.length;
      } finally {
        handle?.close();
      }
    }
    if (left) set({ error: t.bookmarksLeft(left) });
  };

  /** Documents from before content keys: each gets its key (once: it reads the file), so the cache can know it. */
  const withKeys = async () => {
    for (const d of get().docs) {
      if (d.shareKey || d.viewed) continue;
      const src = await repo.source(d.id).catch(() => null);
      if (src?.kind === 'bytes') {
        const key = await docKey(src.bytes);
        patch(d.id, (x) => ({ ...x, shareKey: key }));
      }
    }
  };

  let loading: Promise<void> | null = null;

  /**
   * The library's document of this item already: the same file, for a file in a folder; else (a picked or shared
   * file) a document with these bytes, perhaps with what Tessel saved into it since (`exact`: nothing). Its share
   * key finds the documents that may be it. Another revision (signed elsewhere, say) has the same key, but is not
   * it: opened as it, a save would write the one over the other.
   */
  const findExisting = async (item: ImportItem): Promise<{ doc: DocRecord; exact: boolean } | undefined> => {
    const docs = get().docs;
    const among = (ids: string[]) => {
      const doc = docs.find((d) => ids.includes(d.id));
      return doc && { doc, exact: true };
    };
    if (item.link || item.handle) {
      const linked = item.link ? among((await repo.linkedTo([item.link])).get(item.link) ?? []) : among(await repo.linkedToHandle(item.handle!).catch(() => []));
      return linked ?? (item.file ? await followed(item) : undefined);
    }
    const named = (d: DocRecord) => d.bytes === item.size && sameOrRenamed(d.fileName, item.name);
    if (!item.file) {
      const doc = docs.find(named);
      return doc && { doc, exact: true };
    }
    const bytes = await item.file.arrayBuffer();
    const key = await docKey(bytes);
    for (const d of docs) {
      if (d.shareKey ? d.shareKey !== key : !named(d)) continue;
      const src = await repo.source(d.id).catch(() => null);
      if (src?.kind !== 'bytes') continue;
      const k = d.shareKey ?? (await docKey(src.bytes));
      if (!d.shareKey) patch(d.id, (x) => ({ ...x, shareKey: k }));
      const doc = get().docs.find((x) => x.id === d.id);
      if (doc && k === key && startsWith(src.bytes, bytes)) return { doc, exact: src.bytes.byteLength === bytes.byteLength };
    }
    return undefined;
  };

  /**
   * A document of this library that was moved or filed elsewhere (on another device, say), whose own file is gone:
   * the same document (its share key) follows this file instead of a second one being made.
   */
  const followed = async (item: ImportItem): Promise<{ doc: DocRecord; exact: boolean } | undefined> => {
    const linked = get().docs.filter((d) => d.linked && d.shareKey);
    if (!linked.length) return undefined;
    // The share key needs only the file's start.
    const key = await docKey(await item.file!.slice(0, 65536).arrayBuffer());
    for (const d of linked) {
      if (d.shareKey !== key) continue;
      const gone = await repo.source(d.id).then(
        () => false,
        (e: unknown) => e instanceof Error && e.message === FILE_MOVED,
      );
      if (!gone) continue;
      await get().linkTo(d.id, item);
      const doc = get().docs.find((x) => x.id === d.id);
      if (doc) return { doc, exact: true };
    }
    return undefined;
  };

  /** A kept document's cover, made from its file once it is the library's. */
  const makeCover = async (id: string, file: Blob) => {
    try {
      const bytes = await file.arrayBuffer();
      const { cover, handle } = await engine.renderCover({ kind: 'bytes', bytes }, COVER_WIDTH, passwordFor(id));
      handle.close();
      await repo.saveCover(id, cover);
      const uri = await repo.coverUri(id);
      set((s) => ({ covers: { ...s.covers, [id]: uri } }));
    } catch {
      // No cover: the library shows the title instead.
    }
  };

  return {
    docs: [],
    books: [],
    covers: {},
    loaded: false,
    importing: [],
    error: null,

    load() {
      // Once, however many ask at the same time (a later answer would drop documents added meanwhile).
      loading ??= (async () => {
        const [stored, cached] = await Promise.all([repo.list(), loadCache()]);
        // The cache knows best where a document was left (it is what is kept from now on).
        const all = stored.map((d) => (d.shareKey && cached.has(d.shareKey) ? { ...d, ...cached.get(d.shareKey) } : d)).sort(byRecent);
        // Books from before Tessel was PDFs only: not listed; kept until saved or removed in Settings.
        const books = all.filter((d) => d.format === 'epub');
        const docs = all.filter((d) => d.format !== 'epub');
        set((s) => ({ docs: [...s.docs.filter((d) => !docs.some((x) => x.id === d.id)), ...docs], books, loaded: true }));
        const entries = await Promise.all(docs.map(async (d) => [d.id, await repo.coverUri(d.id)] as const));
        set((s) => ({ covers: { ...Object.fromEntries(entries), ...s.covers } }));
        void moveCopies().then(bookmarksToNotes).then(withKeys);
      })();
      return loading;
    },

    async importFiles(items) {
      const added: DocRecord[] = [];
      for (let item of items) {
        const existing = await findExisting(item).catch(() => undefined);
        if (existing) {
          added.push(existing.doc);
          continue;
        }
        const label = item.name;
        set((s) => ({ importing: [...s.importing, label] }));
        try {
          // Into the Tessel folder where it can go; else the library keeps its copy (as settle does).
          item = await intoAppFolder(item).catch(() => item);
          const source = item.file
            ? ({ kind: 'bytes', bytes: await item.file.arrayBuffer() } as const)
            : ({ kind: 'uri', uri: item.uri! } as const);
          if (isEpub(item.name, source)) {
            set({ error: t.booksNotHere(item.name) });
            continue;
          }
          // Before the engine takes the bytes (they move to its worker).
          const share = source.kind === 'bytes' ? await docKey(source.bytes) : undefined;
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
            ...(share ? { shareKey: share } : {}),
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

    async view(item) {
      const file = item.file ?? (item.handle ? await item.handle.getFile().catch(() => undefined) : undefined);
      // Nothing to hold (a file only the native app can reach): it is kept, as before.
      if (!file || item.bundled) return (await get().importFiles([item]))[0] ?? null;
      const bytes = await file.arrayBuffer();
      if (isEpub(item.name, { kind: 'bytes', bytes })) {
        set({ error: t.booksNotHere(item.name) });
        return null;
      }
      // Opened while the library loads (a file from another app is shown as soon as it can be).
      const opening = openWithPassword(item.name, (pw) => engine.open({ kind: 'bytes', bytes }, pw));
      await get().load();
      const existing = await findExisting(item).catch(() => undefined);
      let opened;
      try {
        opened = await opening;
      } catch (e) {
        set({ error: `${t.importFailed(item.name)} ${errorText(e)}` });
        return null;
      }
      if (!opened) return null;
      if (existing) {
        // The library's own: that one opens (from what was opened, unless the library's has more in it).
        if (existing.exact) preopen(existing.doc.id, opened.value);
        else opened.value.close();
        return existing.doc;
      }
      const share = await docKey(bytes);
      const key = viewedKey(share, file.size);
      const was = await recall(key).catch(() => undefined);
      const id = newId();
      const handle = opened.value;
      const first = handle.pageSizes[0] ?? { width: 1, height: 1.414 };
      const facts = { title: cleanTitle(handle.metadata.title, item.name), author: handle.metadata.author, pageCount: handle.pageCount, coverAspect: first.height / first.width };
      if (opened.password) rememberPassword(id, opened.password);
      preopen(id, handle);
      const now = Date.now();
      const rec: DocRecord = {
        id,
        ...facts,
        fileName: item.name,
        bytes: file.size,
        addedAt: now,
        openedAt: now,
        bookmarks: [],
        shareKey: share,
        linked: item.handle ? true : undefined,
        viewed: true,
        // Where it was left the last time it was viewed, and how it looked.
        ...(was?.position ? { position: was.position } : {}),
        ...(was?.view ? { view: was.view } : {}),
        ...(was?.invert ? { invert: true } : {}),
      };
      repo.hold(id, item.handle ?? file);
      set((s) => ({ docs: [rec, ...s.docs], covers: { ...s.covers, [id]: null } }));
      void remember(key, item.name, { openedAt: now });
      return rec;
    },

    async keep(id) {
      const rec = get().docs.find((d) => d.id === id);
      if (!rec?.viewed) return !!rec;
      const data = repo.held(id);
      if (!data) return false;
      const handle = isFileHandle(data) ? data : undefined;
      const file = handle ? await handle.getFile().catch(() => undefined) : (data as Blob);
      // A file in place stays where it is; bytes from elsewhere go to the Tessel folder (or stay a copy).
      let item: ImportItem = { name: rec.fileName, size: rec.bytes, file, handle };
      if (!handle) item = await intoAppFolder(item).catch(() => item);
      try {
        await repo.saveFile(id, fileData(item));
        const { viewed: _viewed, ...rest } = rec;
        const kept: DocRecord = { ...rest, fileName: item.name, linked: isLinked(item), addedAt: Date.now() };
        await repo.put(kept);
        repo.release(id);
        set((s) => ({ docs: s.docs.map((d) => (d.id === id ? kept : d)) }));
        void forget(viewedKey(rec.shareKey!, rec.bytes));
        if (file) void makeCover(id, file);
        return true;
      } catch (e) {
        set({ error: `${t.importFailed(rec.fileName)} ${errorText(e)}` });
        return false;
      }
    },

    async ensureKept(id) {
      const rec = get().docs.find((d) => d.id === id);
      if (!rec?.viewed) return true;
      const yes = await ask({ title: t.keepAsk, body: t.keepAskBody(rec.title, !!rec.linked), confirm: t.keepConfirm });
      return yes !== null && get().keep(id);
    },

    async forgetBooks() {
      for (const d of get().books) await repo.remove(d.id).catch(() => {});
      set({ books: [] });
    },

    closeViewed(id) {
      const rec = get().docs.find((d) => d.id === id);
      if (!rec?.viewed) return;
      repo.release(id);
      set((s) => {
        const { [id]: _gone, ...covers } = s.covers;
        return { docs: s.docs.filter((d) => d.id !== id), covers };
      });
    },

    async remove(id) {
      const gone = get().docs.find((d) => d.id === id);
      if (gone?.viewed) return get().closeViewed(id);
      set((s) => ({ docs: s.docs.filter((d) => d.id !== id) }));
      await repo.remove(id);
    },

    savePosition: (id, position, atEnd) => {
      // A finish seen while scrolling is kept even if the next report (still at the bottom) says otherwise.
      const was = positions.get(id);
      // `end`: where the reader is now (scrolling back up from the end is no longer 100 %).
      positions.set(id, { position, atEnd: atEnd || was?.atEnd ? true : atEnd, end: atEnd });
      positionTimer ??= setTimeout(() => get().flushPositions(), POSITION_MS);
    },

    flushPositions: (now = false) => {
      clearTimeout(positionTimer);
      positionTimer = undefined;
      const pending = [...positions];
      positions.clear();
      for (const [id, { position: at, end }] of pending)
        patch(
          id,
          (d) => {
            const position: ReadingPosition = end ? { page: at.page, offset: at.offset, end: true } : { page: at.page, offset: at.offset };
            return { ...d, position };
          },
          !now,
        );
      if (now) persistNow();
    },

    setView: (id, view) => patch(id, (d) => ({ ...d, view })),

    toggleInvert: (id) => patch(id, (d) => ({ ...d, invert: d.invert ? undefined : true })),
    setDetails: (id, { title, author }) => patch(id, (d) => ({ ...d, title: title.trim() || d.title, author: author || undefined })),

    async linkTo(id, item) {
      await repo.saveFile(id, fileData(item));
      patch(id, (d) => ({ ...d, fileName: item.name, bytes: item.size, linked: isLinked(item) }));
    },

    patchDoc: (id, changes) => patch(id, (d) => ({ ...d, ...changes })),

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
        // The file itself, or one inside a moved folder: same path below the new place ("Report" isn't "Report 2024.pdf").
        const m = moves.find((x) => uri === x.from || uri.startsWith(`${x.from}/`) || uri.startsWith(`${x.from}%2F`));
        if (!m) continue;
        const to = m.to + uri.slice(m.from.length);
        for (const id of ids) {
          await repo.relink(id, to);
          patch(id, (d) => ({ ...d, fileName: nameOfUri(to) }));
        }
      }
    },

    async followEntry(from, to) {
      if (from.uri && to.uri) return get().followFiles([{ from: from.uri, to: to.uri }]);
      if (!from.handle || !to.handle) return;
      for (const id of await repo.linkedToHandle(from.handle)) await get().relink(id, to.handle);
    },

    async forgetFiles(uris) {
      const linked = await repo.linkedTo(uris);
      for (const ids of linked.values()) for (const id of ids) await get().remove(id);
    },
  };
});
