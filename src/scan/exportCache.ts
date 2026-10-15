import { BASE } from '@/lib/base';

import { OCR_MODELS } from './engine/assets';
import type { OcrWord } from './engine/ocr/paddle';
import type { PdfImage } from './engine/pdf/writer';
import { renderKey } from './renderCache';
import { renderJob } from './services';
import { RESOLUTION_LONG_EDGE, type Page, type ScanSettings } from './types';
import { OcrClient, ProcessorClient } from './engine/worker/clients';

export interface EncodedPage {
  image: PdfImage;
  width: number;
  height: number;
  /**
   * The page's text, once OCR has run. The promise resolves to no words if
   * OCR fails: a PDF without a text layer is still a good PDF. Null when the
   * text was not asked for.
   */
  text: Promise<PageText> | null;
}

export interface PageText {
  /**
   * Recognised words, in the pixels of the encoded image turned by `turn`
   * (the same scale, so for `turn` 0 the encoded image's own pixels).
   */
  words: OcrWord[];
  /**
   * Clockwise quarter turns OCR found the page needs to be upright (0 for a
   * page whose orientation was already settled). The turned page, rendered,
   * is `uprightPage`'s, with these words.
   */
  turn: number;
  /** Recognition failed (no words because it couldn't run, not because the page has none). */
  failed?: boolean;
}

/** A page as it is once turned by `turn` quarter turns: its orientation is then settled. */
export function turnedPage(page: Page, turn: number): Page {
  return {
    ...page,
    spec: { ...page.spec, rotation: (page.spec.rotation + turn) % 4, oriented: true },
  };
}

type TurnListener = (page: Page, turned: Page) => void;
const turnListeners = new Set<TurnListener>();

/**
 * Be told when OCR finds that a page is sideways or upside down: `page` is
 * the page as it was read, `turned` the same page upright.
 */
export function onPageTurned(listener: TurnListener): () => void {
  turnListeners.add(listener);
  return () => turnListeners.delete(listener);
}

/** Long edge of the page image handed to OCR: text lines come out ~35 px tall. */
const OCR_EDGE = 2600;

/** The OCR worker holds its models in memory; it is closed after this long unused. */
const OCR_IDLE_MS = 60_000;



/*
 * Export-quality pages, prepared in the background while the user reviews the
 * document, so that "PDF" and "Upload" only have to assemble the file.
 *
 * A dedicated worker does this, so interactive previews are never queued
 * behind a multi-second export render, and it pauses while the camera is in
 * use so detection has the CPU to itself. OCR runs in a third worker right
 * after each page is rendered, in the background only once its models are
 * downloaded: the first download (~13 MB, maybe over cellular) waits until
 * the user saves a PDF, since an upload does not need it.
 */

let exporter: ProcessorClient | null = null;
let reader: OcrClient | null = null;
let reading = 0;
let readerIdle: ReturnType<typeof setTimeout> | undefined;
const ready = new Map<string, EncodedPage>();
const inFlight = new Map<string, Promise<EncodedPage>>();
/** Keys whose text has been read (successfully) and is attached to their `ready` entry. */
const read = new Set<string>();
let paused = false;
let generation = 0;
/** The last prefetch asked for, to go on with after a pause. */
let last: { pages: Page[]; settings: ScanSettings } | null = null;
/** Whether the background prefetch also reads the text (OCR on and its models downloaded). */
let readsText = false;

/*
 * Progress, for the document grid: listeners are told (at most once per
 * microtask) whenever a page's export render or text changes state.
 */
const statusListeners = new Set<() => void>();
let notifying = false;

function changed(): void {
  if (notifying) return;
  notifying = true;
  queueMicrotask(() => {
    notifying = false;
    for (const listener of statusListeners) listener();
  });
}

/** Be told when a page's export state may have changed; returns an unsubscribe function. */
export function onExportStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * Where a page's export stands:
 * - `queued`: nothing prepared yet;
 * - `rendering`: its export render is being made;
 * - `rendered`: rendered, without text (not wanted, not read yet, or OCR failed);
 * - `reading`: rendered, text being recognised;
 * - `read`: rendered with its text.
 */
export type ExportPhase = 'queued' | 'rendering' | 'rendered' | 'reading' | 'read';

export function exportPhase(page: Page, settings: ScanSettings): ExportPhase {
  const k = key(page, settings);
  const entry = ready.get(k);
  if (entry?.text) return read.has(k) ? 'read' : 'reading';
  if (inFlight.has(k)) return 'rendering';
  return entry ? 'rendered' : 'queued';
}

/** Whether the background prefetch reads pages' text, so "PDF" can become ready without waiting. */
export function prefetchReadsText(): boolean {
  return readsText;
}

/**
 * A page's recognised text, if it has already been read (never starts any
 * work): the words, and the size of the upright page they are placed on.
 */
export function readText(
  page: Page,
  settings: ScanSettings,
): Promise<{ words: OcrWord[]; width: number; height: number }> | null {
  const k = key(page, settings);
  const entry = ready.get(k);
  if (!entry?.text || !read.has(k)) return null;
  return entry.text.then(({ words, turn }) =>
    turn % 2
      ? { words, width: entry.height, height: entry.width }
      : { words, width: entry.width, height: entry.height },
  );
}

function worker(): ProcessorClient {
  if (!exporter || exporter.dead) exporter = new ProcessorClient();
  return exporter;
}

/** Run OCR, closing the worker once it has been idle for a while (it is recreated on demand). */
function recognise(
  image: {
    data: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
  },
  orient: boolean,
): Promise<{ words: OcrWord[]; turn: number }> {
  clearTimeout(readerIdle);
  if (!reader || reader.dead) reader = new OcrClient();
  reading++;
  return reader.recognise(image, { orient }).finally(() => {
    if (--reading > 0) return;
    readerIdle = setTimeout(() => {
      reader?.dispose();
      reader = null;
    }, OCR_IDLE_MS);
  });
}

function key(page: Page, settings: ScanSettings): string {
  return `${renderKey(page, RESOLUTION_LONG_EDGE[settings.resolution], false)}|${settings.jpegQuality}`;
}

/** The browser's data saver (Chrome/Android "Lite mode", Save-Data). */
function saveData(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

/** Whether the OCR models are already downloaded (the service worker keeps them), so OCR costs no data. */
export async function ocrModelsCached(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const hits = await Promise.all(OCR_MODELS.map((f) => caches.match(`${BASE}/models/${f}`)));
    return hits.every(Boolean);
  } catch {
    // No cache access (e.g. a private window): treat as not downloaded.
    return false;
  }
}

/**
 * The export render of a page, with its text (when OCR is on in the
 * settings) if `text` is set. A page rendered without text is rendered again
 * when the text is wanted: the OCR image is too large to keep just in case.
 */
async function encode(page: Page, settings: ScanSettings, text: boolean): Promise<EncodedPage> {
  const k = key(page, settings);
  const withText = text && settings.ocr;
  for (;;) {
    const done = ready.get(k);
    if (done && (done.text || !withText)) return done;
    const running = inFlight.get(k);
    if (!running) break;
    await running.catch(() => undefined);
  }
  const running = worker()
    .encode({
      ...renderJob(page, RESOLUTION_LONG_EDGE[settings.resolution]),
      jpegQuality: settings.jpegQuality,
      ocrEdge: withText ? OCR_EDGE : undefined,
    })
    .then((result) => {
      const entry: EncodedPage = {
        image: result.image,
        width: result.width,
        height: result.height,
        text: null,
      };
      if (result.ocr) {
        const toPage = result.width / result.ocr.width;
        // A page whose rotation the user or OCR has settled is read as it is.
        entry.text = recognise(result.ocr, !page.spec.oriented)
          .then(({ words, turn }): PageText => {
            const scaled = words.map((w) => ({
              ...w,
              x0: w.x0 * toPage,
              x1: w.x1 * toPage,
              y0: w.y0 * toPage,
              y1: w.y1 * toPage,
            }));
            if (turn) settleTurn(page, settings, turn, scaled);
            if (ready.get(k) === entry) read.add(k);
            changed();
            return { words: scaled, turn };
          })
          .catch((): PageText => {
            // This export goes out without text (and says so); the next one tries again.
            if (ready.get(k) === entry) ready.set(k, { ...entry, text: null });
            changed();
            return { words: [], turn: 0, failed: true };
          });
      }
      ready.set(k, entry);
      read.delete(k);
      return entry;
    })
    .finally(() => {
      inFlight.delete(k);
      changed();
    });
  inFlight.set(k, running);
  changed();
  return running;
}

/**
 * OCR found a page sideways or upside down: render it upright with the words
 * already read (so neither the export nor a later one reads it again), and
 * tell the listeners so the document shows it upright too.
 */
function settleTurn(page: Page, settings: ScanSettings, turn: number, words: OcrWord[]): void {
  const upright = turnedPage(page, turn);
  const text: PageText = { words, turn: 0 };
  void encode(upright, settings, false)
    .then((entry) => {
      const k = key(upright, settings);
      if (ready.get(k) === entry && !entry.text) {
        ready.set(k, { ...entry, text: Promise.resolve(text) });
        read.add(k);
        changed();
      }
    })
    .catch(() => undefined);
  for (const listener of turnListeners) listener(page, upright);
}

/**
 * The page as OCR found it upright (`text.turn` quarter turns from `page`),
 * rendered for export, with its words.
 */
export async function uprightPage(
  page: Page,
  settings: ScanSettings,
  text: PageText,
): Promise<{ image: PdfImage; width: number; height: number; words: OcrWord[] }> {
  const entry = await encode(turnedPage(page, text.turn), settings, false);
  return { image: entry.image, width: entry.width, height: entry.height, words: text.words };
}

/**
 * The export render for a page: from the background cache, or now. With
 * `text`, its OCR words are on their way too (when OCR is enabled).
 */
export function encodedPage(
  page: Page,
  settings: ScanSettings,
  { text = false }: { text?: boolean } = {},
): Promise<EncodedPage> {
  return encode(page, settings, text);
}

/**
 * Prepare every page's export (and its OCR, if the models are downloaded) in
 * the background, one at a time. Results for pages or settings that no
 * longer exist are dropped.
 */
export function prefetchExports(pages: Page[], settings: ScanSettings): void {
  last = { pages, settings };
  const wanted = new Set(pages.map((p) => key(p, settings)));
  for (const k of [...ready.keys()]) {
    if (wanted.has(k)) continue;
    ready.delete(k);
    read.delete(k);
  }
  changed();
  const run = ++generation;
  void (async () => {
    // Read the text in the background too, so saving does not render every
    // page again with OCR. That downloads the OCR models (~13 MB, once) on
    // the first document, unless the browser asks to save data; then they
    // are fetched by the first searchable save instead.
    const text = settings.ocr && (!saveData() || (await ocrModelsCached()));
    if (run === generation && readsText !== text) {
      readsText = text;
      changed();
    }
    for (const page of pages) {
      if (paused || run !== generation) return;
      try {
        const entry = await encode(page, settings, text);
        // Let OCR finish before starting the next render, so the two
        // background workers do not compete with each other for the CPU.
        const read = await entry.text;
        // A page found sideways: wait for its upright render too.
        if (read?.turn) await encode(turnedPage(page, read.turn), settings, false);
      } catch {
        // A failed prefetch is retried for real when the user exports.
      }
    }
  })();
}

/** Let the export worker drop what it keeps for a page that is gone. */
export function forgetExport(pageId: string): void {
  exporter?.forget(pageId);
}

/** Stop starting new background renders (the one in progress finishes): while the camera is in use. */
export function pausePrefetch(): void {
  paused = true;
  generation++;
}

/** Background renders again, from where the last request was. */
export function resumePrefetch(): void {
  paused = false;
  if (last) prefetchExports(last.pages, last.settings);
}

/** The document is gone (saved or discarded): nothing more is prepared or kept, and the workers close. */
export function resetExports(): void {
  generation++;
  last = null;
  ready.clear();
  read.clear();
  inFlight.clear();
  exporter?.dispose();
  exporter = null;
  clearTimeout(readerIdle);
  if (!reading) {
    reader?.dispose();
    reader = null;
  }
  changed();
}
