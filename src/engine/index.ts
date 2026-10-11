import PdfEngine from '../../modules/pdf-engine';
import type { DocHandle, DocumentEngine } from './types';

export * from './types';

const aborted = () => new DOMException('Aborted', 'AbortError');

export const engine: DocumentEngine = {
  async open(source) {
    if (source.kind !== 'uri') throw new Error('Native engine opens files by URI');
    const r = await PdfEngine.open(source.uri);
    const handle: DocHandle = {
      pageCount: r.pageCount,
      pageSizes: r.pageSizes,
      metadata: { title: r.title, author: r.author },
      async renderPage(page, { width, signal }) {
        if (signal?.aborted) throw aborted();
        const out = await PdfEngine.render(r.handle, page, width);
        if (signal?.aborted) throw aborted();
        return { kind: 'uri', ...out };
      },
      outline: () => PdfEngine.outline(r.handle),
      async search(query, onHits, signal) {
        const hits = await PdfEngine.search(r.handle, query);
        if (!signal?.aborted && hits.length) onHits(hits);
      },
      close: () => PdfEngine.close(r.handle),
    };
    return handle;
  },
  async renderCover(source, width) {
    const handle = await engine.open(source);
    const raster = await handle.renderPage(0, { width });
    return { cover: raster.kind === 'uri' ? raster.uri : '', handle };
  },
};
