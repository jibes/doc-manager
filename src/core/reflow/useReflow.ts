import { useSyncExternalStore } from 'react';

import type { DocHandle, PageLayout, TextLine } from '@/core/engine/types';
import { createRecognizer, ocrAvailable, type Recognizer } from '@/core/ocr';
import { repo } from '@/core/storage';
import { buildReflow, type Reflow } from './build';

/** On-device recognition of a scanned PDF: `done` pages of `total` are in the reflow so far. */
export type OcrProgress = { done: number; total: number; running: boolean; failed: boolean };

export type ReflowState =
  | { status: 'loading'; progress: number }
  /** `ocr` is set when the text came (or is coming) from recognition; `canOcr` when it could. */
  | { status: 'ready'; reflow: Reflow; ocr?: OcrProgress; canOcr: boolean }
  | { status: 'unsupported' }
  | { status: 'error' };

type Job = { state: ReflowState; listeners: Set<() => void>; handle: DocHandle; docId: string; ocr: boolean };

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
  const job: Job = { state: { status: 'loading', progress: 0 }, listeners: new Set(), handle, docId, ocr: false };
  (async () => {
    const pages: PageLayout[] = [];
    for (let i = 0; i < handle.pageCount; i += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, handle.pageCount - i) }, (_, k) => i + k);
      const layout = await handle.layout(batch);
      if (!layout) return set(job, { status: 'unsupported' });
      pages.push(...layout);
      set(job, { status: 'loading', progress: Math.min(1, (i + CHUNK) / handle.pageCount) });
    }
    const reflow = buildReflow(pages);
    if (reflow.status === 'no-text' && ocrAvailable) {
      // Recognition started in an earlier session picks up where it stopped.
      const saved = await repo.loadOcr(docId, handle.pageCount).catch(() => []);
      if (saved.some(Boolean)) return void runOcr(job, saved);
    }
    set(job, { status: 'ready', reflow, canOcr: ocrAvailable && reflow.status === 'no-text' });
  })().catch(() => set(job, { status: 'error' }));
  return job;
}

async function runOcr(job: Job, saved?: (TextLine[] | undefined)[]) {
  if (job.ocr) return;
  job.ocr = true;
  const { handle, docId } = job;
  const total = handle.pageCount;
  const pages = saved ?? (await repo.loadOcr(docId, total).catch(() => new Array<TextLine[] | undefined>(total)));
  let done = 0;
  while (done < total && pages[done]) done++;
  const publish = (running: boolean, failed = false) =>
    set(job, {
      status: 'ready',
      reflow: buildReflow(pages.slice(0, done).map((lines) => ({ lines: lines ?? [], graphics: [] }))),
      ocr: { done, total, running, failed },
      canOcr: true,
    });
  publish(true);
  let rec: Recognizer | undefined;
  try {
    let last = Date.now();
    for (; done < total; ) {
      if (!pages[done]) {
        rec ??= await createRecognizer();
        const lines = await rec.page(handle, done);
        pages[done] = lines;
        repo.saveOcr(docId, done, lines).catch(() => {});
      }
      done++;
      // Early pages show at once so reading can start; after that, batch the rebuilds.
      if (done <= 2 || done === total || Date.now() - last > OCR_PUBLISH_MS) {
        publish(done < total);
        last = Date.now();
      }
    }
  } catch {
    publish(false, true);
  } finally {
    rec?.close();
    job.ocr = false;
  }
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
    (cb) => {
      job.listeners.add(cb);
      return () => job.listeners.delete(cb);
    },
    () => job.state,
    () => job.state,
  );
}
