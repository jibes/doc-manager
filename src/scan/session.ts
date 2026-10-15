import { createStore, delMany, get, set, type UseStore } from 'idb-keyval';
import { create } from 'zustand';

import type { FilterId } from './engine/imaging/filters';
import type { Quad } from './engine/imaging/image';
import type { PageSpec } from './engine/pipeline';
import { forgetExport, onPageTurned, resetExports } from './exportCache';
import { dropRenders } from './renderCache';
import { forgetPage } from './services';
import type { SaveProgress } from './save';
import type { Page } from './types';

/**
 * The document being scanned. Pages are replaced, never mutated. Kept in IndexedDB as it changes, so a
 * reload or the app being killed in the background loses nothing: the photos once each, the rest (order,
 * crop, filter, title) together, once per change (a few hundred bytes).
 */
type PageRecord = Omit<Page, 'source'>;
type Draft = { pages: PageRecord[]; title: string };

let db: UseStore | null = null;
/** Opened on first use: the store is web only. */
const store = () => (db ??= createStore('tessel-scan', 'draft'));
const photoKey = (id: string) => `photo:${id}`;

type ScanState = {
  pages: Page[];
  title: string;
  loaded: boolean;
  /** Read with the AI model when saved: switched on for this scan only. */
  aiRead: boolean;
  /** A photo or the draft couldn't be kept on the device (storage full): the scan would be lost with the app. */
  unsaved: boolean;
  restore(): Promise<void>;
  add(page: Omit<Page, 'id'>): Page;
  update(id: string, spec: Partial<PageSpec>): void;
  replaceSource(id: string, photo: Omit<Page, 'id' | 'spec'> & { quad: Quad }): void;
  /** Removes a page; returns a function that puts it back where it was. */
  remove(id: string): () => void;
  move(id: string, delta: number): void;
  /** Puts a page at this position (dragged in the grid). */
  moveTo(id: string, index: number): void;
  /** Bulk edits on selected pages; each returns a function that undoes it (later edits to other pages stay). */
  moveMany(ids: string[], where: 'start' | 'end'): () => void;
  removeMany(ids: string[]): () => void;
  updateMany(ids: string[], spec: (current: PageSpec) => Partial<PageSpec>): () => void;
  /** Gives every page this filter; returns a function that puts each page's previous filter back. */
  applyToAll(filter: FilterId): () => void;
  setTitle(title: string): void;
  setAiRead(on: boolean): void;
  /** Undos offered so far do nothing (the document is being saved as it is now). */
  seal(): void;
  /** Ends the document (`ids`: only those pages, the ones just saved; others taken meanwhile stay). */
  clear(ids?: string[]): void;
};

/** The save under way, from whichever review started it: every review shows it, and waits. */
export const useScanSaving = create<{ progress: SaveProgress | null; controller: AbortController | null }>(() => ({ progress: null, controller: null }));

/**
 * What the scanner has to say (a photo that couldn't be read, a page deleted with its Undo), shown by whichever
 * scanner screen is in front: the camera may close right after saying it.
 */
export const useScanMessage = create<{ text: string | null; undo?: () => void }>(() => ({ text: null }));
export const sayScan = (text: string | null, undo?: () => void) => useScanMessage.setState({ text, undo });

let pending = false;
/** Bumped when the document is discarded, so an Undo offered for the old one does nothing in the new one. */
let generation = 0;
/** Read once, however many screens ask at the same time (two reads would add every page twice). */
let restoring: Promise<void> | null = null;
/** Pages of the draft whose photos couldn't be read now: kept in the draft, for the next start to try again. */
let unread: PageRecord[] = [];
/** The draft couldn't be read at all: it isn't written over either. */
let unreadable = false;

export const useScan = create<ScanState>((setState, getState) => {
  // Changes made together (one tap) are written together.
  const save = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(flush);
  };
  const failed = () => setState({ unsaved: true });
  const flush = () => {
    pending = false;
    const { pages, title, loaded } = getState();
    if (!loaded || unreadable) return;
    const draft: Draft = { pages: [...pages.map(({ source: _, ...rest }) => rest), ...unread], title };
    set('draft', draft, store()).catch(failed);
  };
  const savePhoto = (page: Page) => {
    set(photoKey(page.id), page.source, store()).catch(failed);
    save();
  };
  const setPages = (pages: Page[]) => {
    setState({ pages });
    save();
  };
  /**
   * Undo for a bulk edit: the order before it, pages it removed put back, and (for `specs`) those pages'
   * settings as they were. Pages added since stay, at the end.
   */
  const undoTo = (before: Page[], specs?: Set<string>) => {
    const gen = generation;
    return () => {
      if (gen !== generation) return;
      const now = new Map(getState().pages.map((p) => [p.id, p]));
      const pages = before.map((old) => {
        const cur = now.get(old.id);
        if (!cur) {
          savePhoto(old);
          return old;
        }
        return specs?.has(old.id) ? { ...cur, spec: old.spec } : cur;
      });
      const kept = new Set(before.map((p) => p.id));
      setPages([...pages, ...getState().pages.filter((p) => !kept.has(p.id))]);
    };
  };
  const forget = (page: Page) => {
    forgetPage(page.id);
    forgetExport(page.id);
    dropRenders(page.source);
  };

  // OCR found a page sideways or upside down: turn it, if it is still the page that was read and nobody turned it since.
  onPageTurned((read, upright) => {
    const page = getState().pages.find((p) => p.id === read.id);
    if (
      !page ||
      page.source !== read.source ||
      page.spec.oriented ||
      page.spec.rotation !== read.spec.rotation ||
      JSON.stringify(page.spec.quad) !== JSON.stringify(read.spec.quad)
    ) {
      return;
    }
    setPages(getState().pages.map((p) => (p.id === page.id ? { ...p, spec: { ...p.spec, rotation: upright.spec.rotation, oriented: true } } : p)));
  });

  return {
    pages: [],
    title: '',
    loaded: false,
    aiRead: false,
    unsaved: false,

    restore() {
      if (getState().loaded) return Promise.resolve();
      restoring ??= (async () => {
        let draft: Draft | undefined;
        try {
          draft = await get<Draft>('draft', store());
        } catch (e) {
          // Not written over: the pages taken now are kept in this session only.
          console.warn('Scan draft could not be restored', e);
          unreadable = true;
          setState({ loaded: true, unsaved: true });
          return;
        }
        const pages: Page[] = [];
        for (const rec of draft?.pages ?? []) {
          try {
            const source = await get<Blob>(photoKey(rec.id), store());
            if (source) pages.push({ ...rec, source });
          } catch {
            unread.push(rec);
          }
        }
        // Pages taken while the draft was loading go after the saved ones (and into the draft with them).
        setState((s) => ({ pages: [...pages, ...s.pages], title: s.title || draft?.title || '', loaded: true }));
        save();
      })();
      return restoring;
    },

    add(page) {
      const created: Page = { ...page, id: crypto.randomUUID() };
      setState((s) => ({ pages: [...s.pages, created] }));
      savePhoto(created);
      return created;
    },

    update(id, spec) {
      // A page the user has turned is never turned again by auto-orientation.
      const settled = 'rotation' in spec ? { oriented: true } : {};
      setPages(getState().pages.map((p) => (p.id === id ? { ...p, spec: { ...p.spec, ...spec, ...settled } } : p)));
    },

    replaceSource(id, { quad, ...photo }) {
      const old = getState().pages.find((p) => p.id === id);
      if (!old) return;
      forget(old);
      const page: Page = { ...old, ...photo, spec: { ...old.spec, quad, oriented: false } };
      setState((s) => ({ pages: s.pages.map((p) => (p.id === id ? page : p)) }));
      savePhoto(page);
    },

    remove(id) {
      const pages = getState().pages;
      const index = pages.findIndex((p) => p.id === id);
      if (index < 0) return () => {};
      const page = pages[index];
      const gen = generation;
      setPages(pages.filter((p) => p.id !== id));
      delMany([photoKey(id)], store()).catch(() => {});
      return () => {
        if (gen !== generation || getState().pages.some((p) => p.id === id)) return;
        const next = [...getState().pages];
        next.splice(Math.min(index, next.length), 0, page);
        setState({ pages: next });
        savePhoto(page);
      };
    },

    move(id, delta) {
      const next = [...getState().pages];
      const from = next.findIndex((p) => p.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= next.length) return;
      next.splice(to, 0, ...next.splice(from, 1));
      setPages(next);
    },

    moveTo(id, index) {
      const next = [...getState().pages];
      const from = next.findIndex((p) => p.id === id);
      if (from < 0 || from === index) return;
      next.splice(Math.max(0, Math.min(index, next.length - 1)), 0, ...next.splice(from, 1));
      setPages(next);
    },

    moveMany(ids, where) {
      const before = getState().pages;
      const picked = new Set(ids);
      const moved = before.filter((p) => picked.has(p.id));
      const rest = before.filter((p) => !picked.has(p.id));
      setPages(where === 'start' ? [...moved, ...rest] : [...rest, ...moved]);
      return undoTo(before);
    },

    removeMany(ids) {
      const before = getState().pages;
      const picked = new Set(ids);
      setPages(before.filter((p) => !picked.has(p.id)));
      delMany(ids.map(photoKey), store()).catch(() => {});
      return undoTo(before);
    },

    updateMany(ids, spec) {
      const before = getState().pages;
      const picked = new Set(ids);
      setPages(
        before.map((p) => {
          if (!picked.has(p.id)) return p;
          const change = spec(p.spec);
          return { ...p, spec: { ...p.spec, ...change, ...('rotation' in change ? { oriented: true } : {}) } };
        }),
      );
      return undoTo(before, picked);
    },

    applyToAll(filter) {
      const before = new Map(getState().pages.map((p) => [p.id, p.spec.filter]));
      const gen = generation;
      setPages(getState().pages.map((p) => ({ ...p, spec: { ...p.spec, filter } })));
      return () => {
        if (gen !== generation) return;
        // Only pages still showing the filter applied here: later edits stay.
        setPages(getState().pages.map((p) => (p.spec.filter === filter && before.has(p.id) ? { ...p, spec: { ...p.spec, filter: before.get(p.id)! } } : p)));
      };
    },

    setTitle(title) {
      setState({ title });
      save();
    },

    setAiRead: (aiRead) => setState({ aiRead }),

    seal() {
      generation++;
    },

    clear(ids) {
      generation++;
      // What the scanner said was about this document (an Undo with it).
      sayScan(null);
      const { pages } = getState();
      const gone = ids ? pages.filter((p) => ids.includes(p.id)) : pages;
      const kept = ids ? pages.filter((p) => !ids.includes(p.id)) : [];
      for (const page of gone) forget(page);
      // Pages taken while it was saved are a new document: its own title, and no AI reading unless switched on for it.
      setState({ pages: kept, title: '', aiRead: false, ...(kept.length ? {} : { unsaved: false }) });
      // Nothing left to prepare: the export cache empties and its workers close.
      if (!kept.length) resetExports();
      const lost = ids ? [] : unread;
      if (!ids) unread = [];
      if (unreadable) return;
      const draft: Draft = { pages: [...kept.map(({ source: _, ...rest }) => rest), ...unread], title: '' };
      Promise.all([set('draft', draft, store()), delMany([...gone, ...lost].map((p) => photoKey(p.id)), store())]).catch(() => {});
    },
  };
});
