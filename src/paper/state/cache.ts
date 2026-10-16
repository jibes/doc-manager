import { createStore, entries, set, type UseStore } from 'idb-keyval';
import { create } from 'zustand';

import type { ReadingPosition } from '@/core/storage';

/**
 * What this device remembers about documents, by their content key (archive/docKey.ts): when it last opened each,
 * where it was left and how it looked. Nothing of it is synced or needed: lost, documents open at the start.
 */
export type Cached = { openedAt?: number; position?: ReadingPosition; view?: 'page' | 'text'; invert?: true };

let store: UseStore | null | undefined;
const db = () => {
  if (store === undefined) store = typeof indexedDB === 'undefined' ? null : createStore('tessel-cache', 'docs');
  return store;
};

/** Everything remembered, read once at start; the screens follow it (Documents sorts by when it was opened). */
export const useCache = create<{ docs: Map<string, Cached>; loaded: boolean }>(() => ({ docs: new Map(), loaded: false }));

let loading: Promise<Map<string, Cached>> | null = null;
export function loadCache(): Promise<Map<string, Cached>> {
  loading ??= (async () => {
    const s = db();
    const docs = new Map(s ? await entries<string, Cached>(s).catch(() => []) : []);
    useCache.setState({ docs: new Map([...docs, ...useCache.getState().docs]), loaded: true });
    return useCache.getState().docs;
  })();
  return loading;
}

/** Changes what is remembered about a document (only what changed is written). */
export function remember(key: string, changes: Cached) {
  const was = useCache.getState().docs.get(key) ?? {};
  const next: Cached = { ...was, ...changes };
  if (!changes.invert && 'invert' in changes) delete next.invert;
  if (JSON.stringify(next) === JSON.stringify(was)) return;
  const docs = new Map(useCache.getState().docs);
  docs.set(key, next);
  useCache.setState({ docs });
  const s = db();
  if (s) void set(key, next, s).catch(() => {});
}
