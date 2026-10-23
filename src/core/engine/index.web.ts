import { BASE } from '@/core/lib/base';
import { takeEarlyWorker } from '@/core/lib/shell';

import { fingerprint } from '@/core/lib/bytes';
import type { OpenResult, Request, Response, ResultMap } from './pdfium/protocol';
import type { Annotation, DocHandle, DocSource, DocumentEngine, OutlineItem, PageLink, Raster, SearchHit, TextRun } from './types';

/** Pages whose annotations are read in one request. */
const ANNOT_PAGES = 25;

export * from './types';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (h: SearchHit[]) => void };
type Body<T extends Request['type']> = Omit<Extract<Request, { type: T }>, 'id' | 'type'>;

class WorkerClient {
  private worker: Worker | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();

  /** The worker starts loading PDFium as soon as it exists. */
  start() {
    void this.w;
  }

  private get w(): Worker {
    if (!this.worker) {
      this.worker = takeEarlyWorker() ?? new Worker(`${BASE}/engine/pdfium-worker.js`, { type: 'module' });
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
  const textCache = new Map<number, Promise<TextRun[]>>();
  const linkCache = new Map<number, Promise<PageLink[]>>();
  const memo = <T,>(m: Map<number, Promise<T>>, page: number, load: () => Promise<T>) => {
    let v = m.get(page);
    if (!v) {
      v = load();
      v.catch(() => m.delete(page));
      m.set(page, v);
    }
    return v;
  };
  const handle: DocHandle = {
    pageCount: r.pageCount,
    pageSizes: r.pageSizes,
    metadata: r.metadata,
    hasForm: r.hasForm,
    signed: r.signed,
    async renderPage(page, { width, clip, signal }): Promise<Raster> {
      const out = await client.call('render', { doc: r.doc, page, width, clip }, { signal });
      return { kind: 'bitmap', ...out };
    },
    outline: () => (outlineCache ??= client.call('outline', { doc: r.doc })),
    async search(query, onHits, signal) {
      await client.call('search', { doc: r.doc, query }, { signal, onProgress: onHits });
    },
    pageText: (page) => memo(textCache, page, () => client.call('text', { doc: r.doc, page })),
    links: (page) => memo(linkCache, page, () => client.call('links', { doc: r.doc, page })),
    layout: (pages) => client.call('layout', { doc: r.doc, pages }),
    fields: (page) => (r.hasForm ? client.call('fields', { doc: r.doc, page }) : Promise.resolve([])),
    setField: (page, index, value) => client.call('setField', { doc: r.doc, page, index, value }),
    step: () => client.call('step', { doc: r.doc }),
    undo: () => (textCache.clear(), linkCache.clear(), client.call('undo', { doc: r.doc })),
    redo: () => (textCache.clear(), linkCache.clear(), client.call('redo', { doc: r.doc })),
    save: () => client.call('save', { doc: r.doc }),
    bytes: () => client.call('bytes', { doc: r.doc }),
    addTextLayer: (pages) => (textCache.clear(), linkCache.clear(), client.call('addText', { doc: r.doc, pages })),
    ocrLayer: (page) => client.call('ocrLayer', { doc: r.doc, page }),
    // A slice of pages per request: a long document's notes don't hold up the pages being drawn meanwhile.
    annotations: async () => {
      const out: Annotation[] = [];
      for (let from = 0; from < r.pageCount; from += ANNOT_PAGES) out.push(...(await client.call('annots', { doc: r.doc, from, to: from + ANNOT_PAGES })));
      return out;
    },
    addHighlight: (page, rects, color, contents) => client.call('addHighlight', { doc: r.doc, page, rects, color, contents }).then(() => {}),
    addNote: (page, at, color, contents) => client.call('addNote', { doc: r.doc, page, at, color, contents }).then(() => {}),
    updateAnnotation: (page, index, patch) => client.call('updateAnnot', { doc: r.doc, page, index, ...patch }).then(() => {}),
    removeAnnotation: (page, index) => client.call('removeAnnot', { doc: r.doc, page, index }).then(() => {}),
    close: () => void client.call('close', { doc: r.doc }).catch(() => {}),
  };
  docIds.set(handle, r.doc);
  return handle;
}

export const engine: DocumentEngine = {
  async open(source, password) {
    // Copy, then transfer: the worker owns its bytes; callers keep theirs (and can retry with a password).
    const bytes = (await toBytes(source)).slice(0);
    const origin = fingerprint(bytes);
    const handle = handleFrom(await client.call('open', { bytes, password }, { transfer: [bytes] }));
    handle.origin = origin;
    return handle;
  },
  async renderCover(source, width, password) {
    const handle = await engine.open(source, password);
    try {
      const cover = await client.call('cover', { doc: docIds.get(handle)!, width });
      return { cover, handle };
    } catch (e) {
      // No cover (no pages, a page that won't load): the document is let go here, not kept in the worker.
      handle.close();
      throw e;
    }
  },
  warm: () => client.start(),
};
