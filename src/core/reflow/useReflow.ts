import { useSyncExternalStore } from 'react';

import type { DocHandle, PageLayout, TextLine } from '@/core/engine/types';
import { createRecognizer, ocrAvailable, type Recognizer } from '@/core/ocr';
import { repo } from '@/core/storage';
import { buildReflow, ocrPages, type Reflow } from './build';

/** On-device recognition of a scanned PDF: `done` pages of `total` are in the reflow so far. */
export type OcrProgress = { done: number; total: number; running: boolean; failed: boolean };

export type ReflowState =
  | { status: 'loading'; progress: number }
  /** `ocr` is set when the text came (or is coming) from recognition; `canOcr` when it could. */
  | { status: 'ready'; reflow: Reflow; ocr?: OcrProgress; canOcr: boolean }
  | { status: 'unsupported' }
  | { status: 'error' };

type Job = {
  state: ReflowState;
  listeners: Set<() => void>;
  handle: DocHandle;
  docId: string;
  /** Recognition is running; `paused` when it stopped because no view was watching (watching again resumes it). */
  ocr: boolean;
  paused: boolean;
  /** The pages as extracted, the ones to recognise, and what recognition read so far (undefined: not yet). */
  layouts: PageLayout[];
  targets: Set<number>;
  recognised?: (TextLine[] | undefined)[];
};

/** One extraction per open document, shared by every view of it. */
const jobs = new WeakMap<DocHandle, Job>();
const CHUNK = 24;
/** Rebuild the growing OCR reflow at most this often (a rebuild is linear in the text so far). */
const OCR_PUBLISH_MS = 1500;

function set(job: Job, state: ReflowState) {
  job.state = state;
  job.listeners.forEach((l) => l());
}

function start(handle: DocHandle, docId: string): Job {
  const job: Job = { state: { status: 'loading', progress: 0 }, listeners: new Set(), handle, docId, ocr: false, paused: false, layouts: [], targets: new Set() };
  (async () => {
    const pages: PageLayout[] = [];
    for (let i = 0; i < handle.pageCount; i += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, handle.pageCount - i) }, (_, k) => i + k);
      const layout = await handle.layout(batch);
      if (!layout) return set(job, { status: 'unsupported' });
      pages.push(...layout);
      set(job, { status: 'loading', progress: Math.min(1, (i + CHUNK) / handle.pageCount) });
    }
    const reflow = buildReflow(pages, handle.pageSizes);
    job.layouts = pages;
    // Text that reads as nothing (stray OCR noise) is recognised again, every page of it.
    job.targets = new Set(reflow.status === 'no-text' ? pages.map((_, i) => i) : ocrPages(pages));
    if (job.targets.size && ocrAvailable) {
      // Recognition started in an earlier session picks up where it stopped.
      const saved = await repo.loadOcr(docId, handle.pageCount).catch(() => []);
      if ([...job.targets].some((i) => saved[i])) {
        job.recognised = saved;
        return void runOcr(job);
      }
    }
    set(job, { status: 'ready', reflow, canOcr: ocrAvailable && job.targets.size > 0 });
  })().catch(() => set(job, { status: 'error' }));
  return job;
}

/** The engine's answer once the document is closed: the reader went away, which is no failure. */
const CLOSED = /closed/i;

async function runOcr(job: Job) {
  if (job.ocr) return;
  job.ocr = true;
  job.paused = false;
  const { handle, docId, layouts, targets } = job;
  const total = handle.pageCount;
  job.recognised ??= await repo.loadOcr(docId, total).catch(() => new Array<TextLine[] | undefined>(total));
  // Text saved by an earlier version wasn't marked as recognised.
  const recognised = (job.recognised = job.recognised.map((lines) => lines?.map((l) => (l.ocr ? l : { ...l, ocr: true }))));
  const todo = (i: number) => targets.has(i) && !recognised[i];
  // A recognised page's picture isn't a figure: only its text counts.
  const page = (i: number): PageLayout => (targets.has(i) ? { lines: recognised[i] ?? [], graphics: [] } : (layouts[i] ?? { lines: [], graphics: [] }));
  let done = 0;
  while (done < total && !todo(done)) done++;
  let failed = false;
  const publish = (running: boolean) =>
    set(job, {
      status: 'ready',
      reflow: buildReflow(Array.from({ length: done }, (_, i) => page(i)), handle.pageSizes),
      ocr: { done, total, running, failed },
      canOcr: true,
    });
  publish(true);
  let rec: Recognizer | undefined;
  try {
    let last = Date.now();
    for (; done < total; ) {
      if (todo(done)) {
        // Nobody is reading any more (the text view or the document closed): stop before the next page.
        if (!job.listeners.size) return void (job.paused = true);
        rec ??= await createRecognizer();
        try {
          const lines = await rec.page(handle, done);
          recognised[done] = lines;
          repo.saveOcr(docId, done, lines).catch(() => {});
        } catch (e) {
          // Nothing is saved for a page that wasn't read: Continue (or the next session) tries it again.
          if (!job.listeners.size || CLOSED.test(String(e))) return void (job.paused = true);
          // One page that can't be read (damaged, too large) doesn't stop the others.
          failed = true;
        }
      }
      done++;
      // Early pages show at once so reading can start; after that, batch the rebuilds.
      if (done <= 2 || done === total || Date.now() - last > OCR_PUBLISH_MS) {
        publish(done < total);
        last = Date.now();
      }
    }
  } catch {
    failed = true;
    publish(false);
  } finally {
    rec?.close();
    job.ocr = false;
  }
}

function subscribe(job: Job, listener: () => void) {
  job.listeners.add(listener);
  // Recognition paused while no view was open resumes with the first one.
  if (job.paused) void runOcr(job);
  return () => void job.listeners.delete(listener);
}

function jobFor(handle: DocHandle, docId: string): Job {
  let job = jobs.get(handle);
  if (!job) {
    job = start(handle, docId);
    jobs.set(handle, job);
  }
  return job;
}

/** Recognize a scanned document's text on this device; progress arrives through useReflow. */
export function recognizeText(handle: DocHandle) {
  const job = jobs.get(handle);
  if (job && ocrAvailable) void runOcr(job);
}

/** Reflowed text for a document; extraction starts on first use and is cached for the handle's lifetime. */
export function useReflow(handle: DocHandle, docId: string): ReflowState {
  const job = jobFor(handle, docId);
  return useSyncExternalStore(
    (cb) => subscribe(job, cb),
    () => job.state,
    () => job.state,
  );
}

/** useReflow outside React (tests): the state now, and a subscription to its changes. */
export function watchReflow(handle: DocHandle, docId: string, listener: () => void): { state: () => ReflowState; stop: () => void } {
  const job = jobFor(handle, docId);
  return { state: () => job.state, stop: subscribe(job, listener) };
}
