import { createStore, del, get, set, type UseStore } from 'idb-keyval';

import type { ReadingPosition } from '@/storage';

/**
 * Documents viewed without being kept: where each was left and how it looked, on this device only, for the last
 * few. Nothing of the file is kept, and none of it is listed or synced; opening the same file again picks up there.
 */
export type ViewedEntry = {
  /** The document (its share key and size): the same file again, from wherever it comes. */
  key: string;
  name: string;
  openedAt: number;
  position?: ReadingPosition;
  view?: 'page' | 'text';
  invert?: boolean;
};

/** How many are remembered: the oldest goes. */
export const VIEWED_MAX = 20;
const KEY = 'list';

let store: UseStore | null | undefined;
const db = () => {
  if (store === undefined) store = typeof indexedDB === 'undefined' ? null : createStore('tessel-viewed', 'history');
  return store;
};

async function list(): Promise<ViewedEntry[]> {
  const s = db();
  return (s && (await get<ViewedEntry[]>(KEY, s).catch(() => undefined))) ?? [];
}

/** The key of a viewed document: what the library's share key is, and the file's size. */
export const viewedKey = (share: string, size: number) => `${share}|${size}`;

export async function recall(key: string): Promise<ViewedEntry | undefined> {
  return (await list()).find((e) => e.key === key);
}

// One change after the other (positions come in quick succession): none is lost to another's read.
let queue: Promise<void> = Promise.resolve();
const inTurn = (fn: () => Promise<void>) => (queue = queue.then(fn, fn));

/** Changes to one entry (made if new), newest first; past the last few, the oldest goes. */
export function remember(key: string, name: string, changes: Partial<Omit<ViewedEntry, 'key' | 'name'>>): Promise<void> {
  return inTurn(async () => {
    const s = db();
    if (!s) return;
    const all = await list();
    const was = all.find((e) => e.key === key);
    const entry: ViewedEntry = { ...was, ...changes, key, name, openedAt: changes.openedAt ?? was?.openedAt ?? Date.now() };
    await set(KEY, [entry, ...all.filter((e) => e.key !== key)].slice(0, VIEWED_MAX), s).catch(() => {});
  });
}

/** The document is kept now (its place is in the library), or the history is cleared. */
export function forget(key?: string): Promise<void> {
  return inTurn(async () => {
    const s = db();
    if (!s) return;
    if (key === undefined) return void (await del(KEY, s).catch(() => {}));
    await set(KEY, (await list()).filter((e) => e.key !== key), s).catch(() => {});
  });
}

export const viewedCount = async () => (await list()).length;
