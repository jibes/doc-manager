import { create } from 'zustand';

import { errorText, t } from '@/i18n';
import { engine } from '@/engine';
import { repo, type DocRecord, type ReadingPosition } from '@/storage';

export type ImportItem = { name: string; size: number; file?: Blob; uri?: string };

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
  savePosition(id: string, position: ReadingPosition): void;
  toggleBookmark(id: string, page: number): void;
  toggleReading(id: string): void;
  markOpened(id: string): void;
  clearError(): void;
};

const COVER_WIDTH = 360;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Prefer embedded title unless it's producer junk; fall back to a cleaned file name. */
export function cleanTitle(metaTitle: string | undefined, fileName: string): string {
  const junk = /^(untitled|document|microsoft word|slide ?\d*|title|\s*)$/i;
  const meta = metaTitle?.replace(/^Microsoft (Word|PowerPoint) - /i, '').replace(/\.(docx?|pptx?)$/i, '').trim();
  if (meta && !junk.test(meta) && meta.length < 160) return meta;
  return fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || t.untitled;
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
    },

    async importFiles(items) {
      const added: DocRecord[] = [];
      for (const item of items) {
        const existing = get().docs.find((d) => d.fileName === item.name && d.bytes === item.size);
        if (existing) {
          added.push(existing);
          continue;
        }
        set((s) => ({ importing: [...s.importing, item.name] }));
        try {
          const source = item.file
            ? ({ kind: 'bytes', bytes: await item.file.arrayBuffer() } as const)
            : ({ kind: 'uri', uri: item.uri! } as const);
          const { cover, handle } = await engine.renderCover(source, COVER_WIDTH);
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
          };
          handle.close();
          await repo.saveFile(id, item.file ?? item.uri!);
          await repo.saveCover(id, cover);
          await repo.put(rec);
          const coverUri = await repo.coverUri(id);
          set((s) => ({ docs: [rec, ...s.docs], covers: { ...s.covers, [id]: coverUri } }));
          added.push(rec);
        } catch (e) {
          set({ error: `${t.importFailed(item.name)} ${errorText(e)}` });
        } finally {
          set((s) => ({ importing: s.importing.filter((n) => n !== item.name) }));
        }
      }
      return added;
    },

    async remove(id) {
      set((s) => ({ docs: s.docs.filter((d) => d.id !== id) }));
      await repo.remove(id);
    },

    savePosition: (id, position) =>
      patch(
        id,
        (d) => {
          // Reaching the last page finishes a reading-list document; it moves to "Finished".
          const done = d.reading && !d.reading.finishedAt && position.page >= d.pageCount - 1;
          return { ...d, position, reading: done ? { ...d.reading!, finishedAt: Date.now() } : d.reading };
        },
        true,
      ),

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

    clearError: () => set({ error: null }),
  };
});
