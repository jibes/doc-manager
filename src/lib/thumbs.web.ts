import { createStore, delMany, get, keys, set } from 'idb-keyval';

import { engine } from '@/engine';
import type { FolderEntry } from './folderTypes';

/** The first page of a PDF in a folder, small and cached until the file changes. */
export type Thumb = { uri: string; aspect: number } | null;

const WIDTH = 240;
/** Bigger files get a plain tile: reading them whole just for a thumbnail costs too much. */
const MAX_BYTES = 120 * 1024 * 1024;

const store = createStore('tessel-thumbs', 'thumbs');
type Cached = { blob: Blob; aspect: number } | { none: true };
const urls = new Map<string, Thumb>();
/** Thumbnails kept as object URLs at once (the least recently used are let go, and read again when needed). */
const KEEP_URLS = 600;

const keyOf = (root: string, e: FolderEntry) => `${e.uri ?? `${root}/${e.id}`}|${e.size}|${e.modified}`;

/** Thumbs cached in memory or IndexedDB, without generating any. */
export async function cachedThumb(root: string, e: FolderEntry): Promise<Thumb | undefined> {
  const key = keyOf(root, e);
  if (urls.has(key)) return used(key);
  const hit = await get<Cached>(key, store).catch(() => undefined);
  if (!hit) return undefined;
  return remember(key, hit);
}

/** Most recently used last (a Map keeps the order things went in). */
function used(key: string): Thumb {
  const thumb = urls.get(key)!;
  urls.delete(key);
  urls.set(key, thumb);
  return thumb;
}

function remember(key: string, c: Cached): Thumb {
  const thumb = 'none' in c ? null : { uri: URL.createObjectURL(c.blob), aspect: c.aspect };
  urls.set(key, thumb);
  for (const [old, t] of urls) {
    if (urls.size <= KEEP_URLS) break;
    urls.delete(old);
    if (t) URL.revokeObjectURL(t.uri);
  }
  return thumb;
}

/** A file's thumbnails from before it changed (its key names its size and date): no longer wanted. */
async function dropOlder(key: string) {
  const file = key.slice(0, key.lastIndexOf('|', key.lastIndexOf('|') - 1) + 1);
  const stale = (await keys(store)).filter((k) => typeof k === 'string' && k !== key && k.startsWith(file));
  if (stale.length) await delMany(stale, store);
}

async function render(e: FolderEntry, file: Blob): Promise<Cached> {
  if (file.size > MAX_BYTES) return { none: true };
  const bytes = await file.arrayBuffer();
  const { cover, handle } = await engine.renderCover({ kind: 'bytes', bytes }, WIDTH);
  const first = handle.pageSizes[0];
  handle.close();
  return { blob: cover as Blob, aspect: first ? first.height / first.width : 1.414 };
}

// One at a time, most recent request first: tiles that just came into view go before the rest.
type Job = { key: string; run: () => Promise<void>; cancel: () => void };
let queue: Job[] = [];
let busy = false;
const inflight = new Map<string, Promise<Thumb>>();

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await queue.pop()!.run();
  busy = false;
}

/** Makes (or loads) a thumbnail. Password-protected and unreadable files get none. */
export function thumb(root: string, e: FolderEntry, read: () => Promise<Blob>): Promise<Thumb> {
  const key = keyOf(root, e);
  if (urls.has(key)) return Promise.resolve(used(key));
  const running = inflight.get(key);
  if (running) return running;
  const p = new Promise<Thumb>((resolve) => {
    queue.push({
      key,
      run: async () => {
        const hit = await get<Cached>(key, store).catch(() => undefined);
        const c = hit ?? (await read().then((file) => render(e, file)).catch((): Cached => ({ none: true })));
        if (!hit) await set(key, c, store).then(() => dropOlder(key)).catch(() => {});
        inflight.delete(key);
        resolve(remember(key, c));
      },
      cancel: () => resolve(null),
    });
  });
  inflight.set(key, p);
  void pump();
  return p;
}

/** Drops waiting work (the user left the folder); thumbnails already made stay cached. */
export function cancelThumbs() {
  for (const job of queue) {
    inflight.delete(job.key);
    job.cancel();
  }
  queue = [];
}
