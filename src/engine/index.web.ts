import { BASE } from '@/lib/base';

import type { OpenResult, Request, Response, ResultMap } from './pdfium/protocol';
import type { DocHandle, DocSource, DocumentEngine, OutlineItem, Raster, SearchHit } from './types';

export * from './types';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (h: SearchHit[]) => void };
type Body<T extends Request['type']> = Omit<Extract<Request, { type: T }>, 'id' | 'type'>;

class WorkerClient {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(`${BASE}/engine/pdfium-worker.js`, { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<Response>) => {
        const msg = e.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if ('progress' in msg) return p.onProgress?.(msg.progress);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      };
    }
    return this.worker;
  }

  call<T extends Request['type']>(
    type: T,
    body: Body<T>,
    opts: { signal?: AbortSignal; transfer?: Transferable[]; onProgress?: Pending['onProgress'] } = {},
  ): Promise<ResultMap[T]> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      this.pending.set(id, { resolve: resolve as Pending['resolve'], reject, onProgress: opts.onProgress });
      // Abort asks the worker to drop the job but settles only when the worker answers,
      // so callers' concurrency accounting matches what the worker is really doing.
      opts.signal?.addEventListener(
        'abort',
        () => {
          const p = this.pending.get(id);
          if (!p) return;
          p.onProgress = undefined;
          this.w.postMessage({ id: this.seq++, type: 'cancel', target: id } satisfies Request);
        },
        { once: true },
      );
      this.w.postMessage({ id, type, ...body } as unknown as Request, opts.transfer ?? []);
    });
  }
}

const client = new WorkerClient();

async function toBytes(source: DocSource): Promise<ArrayBuffer> {
  if (source.kind === 'bytes') return source.bytes;
  return (await fetch(source.uri)).arrayBuffer();
}

/** Maps public handles back to worker doc ids. */
const docIds = new WeakMap<DocHandle, number>();

function handleFrom(r: OpenResult): DocHandle {
  let outlineCache: Promise<OutlineItem[]> | null = null;
  const handle: DocHandle = {
    pageCount: r.pageCount,
    pageSizes: r.pageSizes,
    metadata: r.metadata,
    async renderPage(page, { width, signal }): Promise<Raster> {
      const out = await client.call('render', { doc: r.doc, page, width }, { signal });
      return { kind: 'bitmap', ...out };
    },
    outline: () => (outlineCache ??= client.call('outline', { doc: r.doc })),
    async search(query, onHits, signal) {
      await client.call('search', { doc: r.doc, query }, { signal, onProgress: onHits });
    },
    close: () => void client.call('close', { doc: r.doc }).catch(() => {}),
  };
  docIds.set(handle, r.doc);
  return handle;
}

export const engine: DocumentEngine = {
  async open(source) {
    // Copy, then transfer: the worker owns its bytes; callers keep theirs.
    const bytes = (await toBytes(source)).slice(0);
    return handleFrom(await client.call('open', { bytes }, { transfer: [bytes] }));
  },
  async renderCover(source, width) {
    const handle = await engine.open(source);
    const cover = await client.call('cover', { doc: docIds.get(handle)!, width });
    return { cover, handle };
  },
};
