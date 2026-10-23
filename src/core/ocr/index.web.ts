import type { DocHandle } from '@/core/engine/types';
import { lang } from '@/core/i18n';
import { BASE } from '@/core/lib/base';
import { ocrLines, type OcrBlock } from './lines';
import type { Recognizer } from './index';

export type { Recognizer } from './index';

/** Web: Tesseract (WASM) in its own worker, self-hosted under /ocr and fetched only on first use. */
export const ocrAvailable = true;

type TesseractWorker = {
  recognize(image: HTMLCanvasElement, options: object, output: object): Promise<{ data: { blocks: OcrBlock[] | null } }>;
  terminate(): Promise<unknown>;
};
type Tesseract = { createWorker(langs: string[], oem: number, options: object): Promise<TesseractWorker> };

let lib: Promise<Tesseract> | null = null;
function load(): Promise<Tesseract> {
  lib ??= new Promise<Tesseract>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${BASE}/ocr/tesseract.min.js`;
    s.onload = () => resolve((window as unknown as { Tesseract: Tesseract }).Tesseract);
    s.onerror = () => reject(new Error('OCR could not be loaded'));
    document.head.appendChild(s);
  }).catch((e) => {
    lib = null;
    throw e;
  });
  return lib;
}

/** ~300 dpi: Tesseract's sweet spot. */
const DPI = 300;
const MAX_WIDTH = 3000;
/** Long side cap: a tall page (a receipt, a poster strip) at full DPI exceeds browsers' canvas limits. */
const MAX_SIDE = 4200;
const LSTM_ONLY = 1;

export async function createRecognizer(): Promise<Recognizer> {
  const T = await load();
  const root = `${location.origin}${BASE}/ocr`;
  const worker = await T.createWorker(lang === 'de' ? ['deu', 'eng'] : ['eng'], LSTM_ONLY, {
    workerPath: `${root}/worker.min.js`,
    corePath: root,
    langPath: `${root}/lang`,
    workerBlobURL: false,
    // The service worker already caches the models; don't keep a second copy in IndexedDB.
    cacheMethod: 'none',
    gzip: true,
  });
  return {
    async page(handle: DocHandle, page: number) {
      const size = handle.pageSizes[page];
      const width = Math.min(MAX_WIDTH, (size.width / 72) * DPI, (MAX_SIDE * size.width) / size.height);
      const raster = await handle.renderPage(page, { width: Math.round(width) });
      if (raster.kind !== 'bitmap') return [];
      const canvas = document.createElement('canvas');
      canvas.width = raster.width;
      canvas.height = raster.height;
      canvas.getContext('2d')!.drawImage(raster.bitmap, 0, 0);
      raster.bitmap.close();
      try {
        const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
        return ocrLines(data.blocks ?? [], raster.width, raster.height, size.width);
      } finally {
        canvas.width = 0;
      }
    },
    close: () => void worker.terminate().catch(() => {}),
  };
}
