import PdfEngine from '../../modules/pdf-engine';
import type { DocHandle, DocumentEngine } from './types';

export * from './types';

const aborted = () => new DOMException('Aborted', 'AbortError');

export const engine: DocumentEngine = {
  async open(source, password) {
    if (source.kind !== 'uri') throw new Error('Native engine opens files by URI');
    const r = await PdfEngine.open(source.uri, password ?? null);
    const handle: DocHandle = {
      pageCount: r.pageCount,
      pageSizes: r.pageSizes,
      metadata: { title: r.title, author: r.author, other: {} },
      // Forms and saving need PDFium on native (deferred); PDFKit/PdfRenderer here are view-only.
      hasForm: false,
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
      // Text layer and links aren't bridged from PDFKit/PdfRenderer yet (phase 3 moves native to PDFium).
      pageText: async () => [],
      links: async () => [],
      layout: async () => null,
      fields: async () => [],
      annotations: async () => [],
      addHighlight: async () => {},
      updateAnnotation: async () => {},
      removeAnnotation: async () => {},
      setField: async () => [],
      save: async () => {
        throw new Error('Saving is not available in the app yet');
      },
      bytes: async () => {
        throw new Error('Saving is not available in the app yet');
      },
      close: () => PdfEngine.close(r.handle),
    };
    return handle;
  },
  async renderCover(source, width, password) {
    const handle = await engine.open(source, password);
    const raster = await handle.renderPage(0, { width });
    return { cover: raster.kind === 'uri' ? raster.uri : '', handle };
  },
};
