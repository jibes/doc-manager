import { createStore, get, set } from 'idb-keyval';

import { readPackage } from '@/book/epub';
import { imageSize } from '@/book/image';
import { engine } from '@/engine';
import type { FolderEntry } from './folderTypes';

/** First page (PDF) or cover (EPUB) of a file in a folder, small and cached until the file changes. */
export type Thumb = { uri: string; aspect: number } | null;

const WIDTH = 240;
/** Bigger files get a plain tile: reading them whole just for a thumbnail costs too much. */
const MAX_BYTES = 120 * 1024 * 1024;

const store = createStore('tessel-thumbs', 'thumbs');
type Cached = { blob: Blob; aspect: number } | { none: true };
const urls = new Map<string, Thumb>();

const keyOf = (root: string, e: FolderEntry) => `${e.uri ?? `${root}/${e.id}`}|${e.size}|${e.modified}`;

/** Thumbs cached in memory or IndexedDB, without generating any. */
export async function cachedThumb(root: string, e: FolderEntry): Promise<Thumb | undefined> {
  const key = keyOf(root, e);
  if (urls.has(key)) return urls.get(key);
  const hit = await get<Cached>(key, store).catch(() => undefined);
  if (!hit) return undefined;
  return remember(key, hit);
}

function remember(key: string, c: Cached): Thumb {
  const thumb = 'none' in c ? null : { uri: URL.createObjectURL(c.blob), aspect: c.aspect };
  urls.set(key, thumb);
  return thumb;
}

/** Scales an image down to the thumbnail width (EPUB covers can be large). */
async function shrink(blob: Blob): Promise<{ blob: Blob; aspect: number }> {
  const bmp = await createImageBitmap(blob);
  const aspect = bmp.height / bmp.width;
  if (bmp.width <= WIDTH || typeof OffscreenCanvas === 'undefined') return { blob, aspect };
  const canvas = new OffscreenCanvas(WIDTH, Math.round(WIDTH * aspect));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return { blob: await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 }), aspect };
}

async function render(e: FolderEntry, file: Blob): Promise<Cached> {
  if (file.size > MAX_BYTES) return { none: true };
  const bytes = await file.arrayBuffer();
  if (e.kind === 'epub') {
    const pkg = readPackage(new Uint8Array(bytes));
    const img = pkg.cover ? pkg.files[pkg.cover] : undefined;
    if (!img) return { none: true };
    const size = imageSize(img);
    const blob = new Blob([img as BlobPart], { type: pkg.types[pkg.cover!] ?? 'image/jpeg' });
    return size && size.w <= WIDTH ? { blob, aspect: size.h / size.w } : shrink(blob);
  }
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
  if (urls.has(key)) return Promise.resolve(urls.get(key)!);
  const running = inflight.get(key);
  if (running) return running;
  const p = new Promise<Thumb>((resolve) => {
    queue.push({
      key,
      run: async () => {
        const hit = await get<Cached>(key, store).catch(() => undefined);
        const c = hit ?? (await read().then((file) => render(e, file)).catch((): Cached => ({ none: true })));
        if (!hit) await set(key, c, store).catch(() => {});
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
