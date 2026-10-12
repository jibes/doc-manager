import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSpec } from '../engine/pipeline';
import { DEFAULT_SCAN_SETTINGS } from '../types';
import type { Page } from '../types';

/** A worker that answers at once: export renders, and OCR finding no words. */
class FakeWorker {
  static all: FakeWorker[] = [];
  /** Whether OCR workers answer; off to let a test crash one first. */
  static ocrAnswers = true;
  /** Quarter turns OCR reports the page needs (when asked to orient it). */
  static turn = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  posted: Record<string, unknown>[] = [];
  terminated = false;
  readonly ocr: boolean;

  constructor(url: URL) {
    this.ocr = String(url).includes('scan-ocr');
    FakeWorker.all.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    const { id } = message;
    const answer =
      message.type === 'encode'
        ? {
            type: 'encoded',
            id,
            image: {},
            width: 20,
            height: 10,
            ocr: message.ocrEdge
              ? { data: new Uint8ClampedArray(4), width: 2, height: 1 }
              : undefined,
          }
        : message.type === 'ocr' && FakeWorker.ocrAnswers
          ? {
              type: 'words',
              id,
              words: [{ text: 'Hello', x0: 0, y0: 0, x1: 1, y1: 1, confidence: 0.9 }],
              turn: message.orient ? FakeWorker.turn : 0,
            }
          : null;
    if (answer) queueMicrotask(() => this.onmessage?.({ data: answer }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const page: Page = {
  id: 'p',
  source: new Blob(['photo']),
  width: 10,
  height: 10,
  spec: { quad: null } as unknown as PageSpec,
  detected: null,
  sharpness: null,
};

function ocrWorkers() {
  return FakeWorker.all.filter((w) => w.ocr);
}

function encodes() {
  return FakeWorker.all.flatMap((w) => w.posted).filter((m) => m.type === 'encode');
}

/** The browser asks to save data (Chrome's Save-Data / Lite mode). */
function dataSaver() {
  vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
}

/** The service worker's cache, holding the first `files` OCR model files. */
function cachedModels(files: number) {
  const held = ['ppocrv5-det.onnx', 'ppocrv5-latin-rec.onnx', 'ppocrv5-latin-dict.txt'].slice(0, files);
  vi.stubGlobal('caches', {
    match: (url: string) => Promise.resolve(held.some((f) => url.endsWith(`/models/${f}`)) ? {} : undefined),
  });
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.ocrAnswers = true;
  FakeWorker.turn = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('export cache', () => {
  it('reads text in the background, downloading the models, unless saving data', async () => {
    cachedModels(0);
    const cache = await import('../exportCache');
    cache.prefetchExports([page], DEFAULT_SCAN_SETTINGS);
    await vi.waitFor(() => expect(ocrWorkers()).toHaveLength(1));
    expect(encodes()[0].ocrEdge).toBeDefined();
    expect(cache.prefetchReadsText()).toBe(true);
  });

  it('does not download OCR models in the background with data saver on', async () => {
    dataSaver();
    cachedModels(1);
    const cache = await import('../exportCache');
    cache.prefetchExports([page], DEFAULT_SCAN_SETTINGS);
    await vi.waitFor(() => expect(encodes()).toHaveLength(1));
    expect(encodes()[0].ocrEdge).toBeUndefined();
    expect(ocrWorkers()).toHaveLength(0);

    // Saving a searchable PDF is what fetches them.
    const encoded = await cache.encodedPage(page, DEFAULT_SCAN_SETTINGS, { text: true });
    expect((await encoded.text)?.words).toHaveLength(1);
    expect(encodes()).toHaveLength(2);
    expect(ocrWorkers()).toHaveLength(1);
  });

  it('reads pages in the background once the models are downloaded', async () => {
    cachedModels(3);
    const cache = await import('../exportCache');
    cache.prefetchExports([page], DEFAULT_SCAN_SETTINGS);
    await vi.waitFor(() => expect(ocrWorkers()).toHaveLength(1));
    const encoded = await cache.encodedPage(page, DEFAULT_SCAN_SETTINGS, { text: true });
    expect((await encoded.text)?.words).toHaveLength(1);
    expect(encodes()).toHaveLength(1);
  });

  it('reads the page again after OCR failed, instead of keeping "no text"', async () => {
    const cache = await import('../exportCache');
    FakeWorker.ocrAnswers = false;
    const first = await cache.encodedPage(page, DEFAULT_SCAN_SETTINGS, { text: true });
    await vi.waitFor(() => expect(ocrWorkers()).toHaveLength(1));
    const [reader] = ocrWorkers();
    // The OCR worker crashes before answering.
    (reader as unknown as { onerror: (e: object) => void }).onerror({
      message: 'crashed',
      preventDefault: () => undefined,
    });
    expect((await first.text)?.words).toEqual([]);
    FakeWorker.ocrAnswers = true;
    const second = await cache.encodedPage(page, DEFAULT_SCAN_SETTINGS, { text: true });
    expect(second.text).not.toBeNull();
    expect((await second.text)?.words).toHaveLength(1);
    expect(encodes()).toHaveLength(2);
  });

  it('closes the OCR worker after a minute unused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cache = await import('../exportCache');
    await (
      await cache.encodedPage(page, DEFAULT_SCAN_SETTINGS, { text: true })
    ).text;
    const [reader] = ocrWorkers();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reader.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reader.terminated).toBe(true);

    // And starts a new one when needed again.
    const again = { ...page, spec: { quad: null, rotation: 1 } as unknown as PageSpec };
    await (
      await cache.encodedPage(again, DEFAULT_SCAN_SETTINGS, { text: true })
    ).text;
    expect(ocrWorkers()).toHaveLength(2);
  });

  it('renders a page OCR found upside down upright, with the words already read', async () => {
    const cache = await import('../exportCache');
    FakeWorker.turn = 2;
    const turned: [Page, Page][] = [];
    cache.onPageTurned((read, upright) => turned.push([read, upright]));
    const upsideDown = { ...page, spec: { quad: null, rotation: 0 } as unknown as PageSpec };
    const encoded = await cache.encodedPage(upsideDown, DEFAULT_SCAN_SETTINGS, { text: true });
    const text = await encoded.text;
    expect(text?.turn).toBe(2);
    expect(turned).toHaveLength(1);
    expect(turned[0][1].spec).toMatchObject({ rotation: 2, oriented: true });
    const upright = await cache.uprightPage(upsideDown, DEFAULT_SCAN_SETTINGS, text!);
    expect(upright.words).toHaveLength(1);
    expect(encodes().map((m) => (m.spec as PageSpec).rotation)).toEqual([0, 2]);
    // The upright page is not read again, and its orientation is settled.
    const again = await cache.encodedPage(turned[0][1], DEFAULT_SCAN_SETTINGS, { text: true });
    expect((await again.text)?.turn).toBe(0);
    const reads = FakeWorker.all.flatMap((w) => w.posted).filter((m) => m.type === 'ocr');
    expect(reads).toHaveLength(1);
    expect(reads[0].orient).toBe(true);
  });

  it('does not orient a page whose rotation is settled', async () => {
    const cache = await import('../exportCache');
    FakeWorker.turn = 1;
    const settled = {
      ...page,
      spec: { quad: null, rotation: 3, oriented: true } as unknown as PageSpec,
    };
    const encoded = await cache.encodedPage(settled, DEFAULT_SCAN_SETTINGS, { text: true });
    expect((await encoded.text)?.turn).toBe(0);
    const reads = FakeWorker.all.flatMap((w) => w.posted).filter((m) => m.type === 'ocr');
    expect(reads[0].orient).toBe(false);
  });

  it('reports how far each page has got, and its text once read', async () => {
    cachedModels(3);
    const cache = await import('../exportCache');
    const seen = new Set<string>();
    cache.onExportStatus(() => seen.add(cache.exportPhase(page, DEFAULT_SCAN_SETTINGS)));
    expect(cache.exportPhase(page, DEFAULT_SCAN_SETTINGS)).toBe('queued');
    expect(cache.readText(page, DEFAULT_SCAN_SETTINGS)).toBeNull();
    cache.prefetchExports([page], DEFAULT_SCAN_SETTINGS);
    await vi.waitFor(() => expect(cache.exportPhase(page, DEFAULT_SCAN_SETTINGS)).toBe('read'));
    expect(cache.prefetchReadsText()).toBe(true);
    expect(seen).toContain('rendering');
    const text = await cache.readText(page, DEFAULT_SCAN_SETTINGS);
    expect(text).toMatchObject({ width: 20, height: 10 });
    expect(text?.words.map((w) => w.text)).toEqual(['Hello']);
    // An edited page starts over.
    const edited = { ...page, spec: { quad: null, rotation: 1 } as unknown as PageSpec };
    expect(cache.exportPhase(edited, DEFAULT_SCAN_SETTINGS)).toBe('queued');
  });

  it('counts a page as rendered, not read, when its text is not read in the background', async () => {
    dataSaver();
    cachedModels(0);
    const cache = await import('../exportCache');
    cache.prefetchExports([page], DEFAULT_SCAN_SETTINGS);
    await vi.waitFor(() => expect(cache.exportPhase(page, DEFAULT_SCAN_SETTINGS)).toBe('rendered'));
    expect(cache.prefetchReadsText()).toBe(false);
    expect(cache.readText(page, DEFAULT_SCAN_SETTINGS)).toBeNull();
  });
});
