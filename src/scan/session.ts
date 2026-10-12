import { createStore, delMany, get, set, type UseStore } from 'idb-keyval';
import { create } from 'zustand';

import type { FilterId } from './engine/imaging/filters';
import type { Quad } from './engine/imaging/image';
import type { PageSpec } from './engine/pipeline';
import { forgetExport, onPageTurned } from './exportCache';
import { dropRenders } from './renderCache';
import { forgetPage } from './services';
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
  restore(): Promise<void>;
  add(page: Omit<Page, 'id'>): Page;
  update(id: string, spec: Partial<PageSpec>): void;
  replaceSource(id: string, photo: Omit<Page, 'id' | 'spec'> & { quad: Quad }): void;
  /** Removes a page; returns a function that puts it back where it was. */
  remove(id: string): () => void;
  move(id: string, delta: number): void;
  /** Gives every page this filter; returns a function that puts each page's previous filter back. */
  applyToAll(filter: FilterId): () => void;
  setTitle(title: string): void;
  clear(): void;
};

let pending = false;
/** Bumped when the document is discarded, so an Undo offered for the old one does nothing in the new one. */
let generation = 0;

export const useScan = create<ScanState>((setState, getState) => {
  // Changes made together (one tap) are written together.
  const save = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(flush);
  };
  const flush = () => {
    pending = false;
    const { pages, title, loaded } = getState();
    if (!loaded) return;
    const draft: Draft = { pages: pages.map(({ source: _, ...rest }) => rest), title };
    set('draft', draft, store()).catch(() => {});
  };
  const savePhoto = (page: Page) => {
    set(photoKey(page.id), page.source, store()).catch(() => {});
    save();
  };
  const setPages = (pages: Page[]) => {
    setState({ pages });
    save();
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

    async restore() {
      if (getState().loaded) return;
      try {
        const draft = await get<Draft>('draft', store());
        const pages: Page[] = [];
        for (const rec of draft?.pages ?? []) {
          const source = await get<Blob>(photoKey(rec.id), store());
          if (source) pages.push({ ...rec, source });
        }
        // Pages taken while the draft was loading go after the saved ones.
        setState((s) => ({ pages: [...pages, ...s.pages], title: s.title || draft?.title || '', loaded: true }));
      } catch (e) {
        console.warn('Scan draft could not be restored', e);
        setState({ loaded: true });
      }
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

    clear() {
      generation++;
      const { pages } = getState();
      for (const page of pages) forget(page);
      setState({ pages: [], title: '' });
      Promise.all([set('draft', { pages: [], title: '' } satisfies Draft, store()), delMany(pages.map((p) => photoKey(p.id)), store())]).catch(() => {});
    },
  };
});
