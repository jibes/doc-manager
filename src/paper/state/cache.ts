import { createStore, entries, set, type UseStore } from 'idb-keyval';
import { create } from 'zustand';

import type { ReadingPosition } from '@/core/storage';

/**
 * What this device remembers about documents, by their content key (archive/docKey.ts): when it last opened each,
 * where it was left and how it looked. Only when it was opened is shared with other devices (archive/opened.ts);
 * none of it is needed: lost, documents open at the start.
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

const openedListeners: ((key: string, at: number) => void)[] = [];
/** Told when a document is opened here (to share it with other devices). */
export const onOpened = (fn: (key: string, at: number) => void) => void openedListeners.push(fn);

/** Changes what is remembered about a document (only what changed is written); `share`: a newer open is told. */
export function remember(key: string, changes: Cached, share = true) {
  const was = useCache.getState().docs.get(key) ?? {};
  if (share && changes.openedAt && changes.openedAt > (was.openedAt ?? 0)) for (const fn of openedListeners) fn(key, changes.openedAt);
  const next: Cached = { ...was, ...changes };
  if (!changes.invert && 'invert' in changes) delete next.invert;
  if (JSON.stringify(next) === JSON.stringify(was)) return;
  const docs = new Map(useCache.getState().docs);
  docs.set(key, next);
  useCache.setState({ docs });
  const s = db();
  if (s) void set(key, next, s).catch(() => {});
}
