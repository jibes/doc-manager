import { PixelRatio, Platform } from 'react-native';

import type { DocHandle, Raster } from '@/core/engine/types';

/** Device-pixel budget for decoded bitmaps on web (~4 bytes/px). Native rasters are files. */
const PIXEL_BUDGET = Platform.OS === 'web' ? 28e6 : Infinity;
/** Snap widths so small layout changes reuse rasters. */
const QUANTUM = 48;
const MAX_DPR = 3;
/** Engine renders are serial; two in flight keeps the pipe full without letting stale work pile up. */
const MAX_INFLIGHT = 2;

export const deviceWidth = (cssWidth: number) =>
  Math.ceil((cssWidth * Math.min(PixelRatio.get(), MAX_DPR)) / QUANTUM) * QUANTUM;

type Entry = { raster: Raster; px: number };
type Job = {
  key: string;
  page: number;
  width: number;
  urgent: boolean;
  refs: number;
  started: boolean;
  ctrl: AbortController;
  promise: Promise<Raster>;
  resolve: (r: Raster) => void;
  reject: (e: unknown) => void;
};

/**
 * Per-document raster cache and render scheduler.
 * - LRU by pixel budget, de-duplicated requests, refcounted cancellation.
 * - Scheduling is distance-from-focus: the page being read renders first, neighbours after,
 *   so jumps and flings never wait behind pages that just scrolled past.
 */
export class RasterCache {
  private entries = new Map<string, Entry>();
  private jobs = new Map<string, Job>();
  private inflight = 0;
  private px = 0;
  private focus = 0;
  /** Bumped when a page's content changes (form edit, annotation); views re-render it. */
  private versions = new Map<number, number>();
  private listeners = new Set<() => void>();

  constructor(readonly handle: DocHandle) {}

  version = (page: number) => this.versions.get(page) ?? 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  /** Drops a page's rasters after its content changed; mounted views fetch it again. */
  invalidate(page: number) {
    for (const [k, e] of this.entries)
      if (k.startsWith(`${page}@`)) {
        this.entries.delete(k);
        this.px -= e.px;
        if (e.raster.kind === 'bitmap') e.raster.bitmap.close();
      }
    for (const [k, j] of this.jobs)
      if (j.page === page) {
        this.jobs.delete(k);
        j.ctrl.abort();
        j.reject(new DOMException('Aborted', 'AbortError'));
      }
    this.versions.set(page, this.version(page) + 1);
    this.listeners.forEach((l) => l());
  }

  private key = (page: number, width: number) => `${page}@${width}`;

  setFocus(page: number) {
    this.focus = page;
  }

  peek(page: number, width: number): Raster | undefined {
    const k = this.key(page, width);
    const e = this.entries.get(k);
    if (!e) return undefined;
    this.entries.delete(k);
    this.entries.set(k, e); // bump recency
    return e.raster;
  }

  /** Best available raster for a page at any width — used as an instant placeholder. */
  best(page: number): Raster | undefined {
    let best: Raster | undefined;
    for (const [k, e] of this.entries) {
      if (k.startsWith(`${page}@`) && (!best || e.raster.width > best.width)) best = e.raster;
    }
    return best;
  }

  /** `urgent`: small previews (scrubber, thumbnails) jump the queue. */
  get(page: number, width: number, signal: AbortSignal, urgent = false): Promise<Raster> {
    const hit = this.peek(page, width);
    if (hit) return Promise.resolve(hit);
    const k = this.key(page, width);
    let job = this.jobs.get(k);
    if (!job) {
      let resolve!: Job['resolve'];
      let reject!: Job['reject'];
      const promise = new Promise<Raster>((res, rej) => ((resolve = res), (reject = rej)));
      promise.catch(() => {});
      job = { key: k, page, width, urgent, refs: 0, started: false, ctrl: new AbortController(), promise, resolve, reject };
      this.jobs.set(k, job);
    }
    const j = job;
    j.urgent ||= urgent;
    j.refs++;
    signal.addEventListener(
      'abort',
      () => {
        if (--j.refs > 0 || this.jobs.get(k) !== j) return;
        this.jobs.delete(k);
        j.ctrl.abort();
        j.reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
    queueMicrotask(() => this.pump());
    return j.promise;
  }

  private next(): Job | undefined {
    let pick: Job | undefined;
    let score = Infinity;
    for (const j of this.jobs.values()) {
      if (j.started) continue;
      const s = j.urgent ? -1 : Math.abs(j.page - this.focus);
      if (s < score) [pick, score] = [j, s];
    }
    return pick;
  }

  private pump() {
    while (this.inflight < MAX_INFLIGHT) {
      const job = this.next();
      if (!job) return;
      job.started = true;
      this.inflight++;
      this.handle
        .renderPage(job.page, { width: job.width, signal: job.ctrl.signal })
        .then(
          (raster) => {
            if (this.jobs.get(job.key) === job) {
              this.jobs.delete(job.key);
              this.store(job.key, raster);
              job.resolve(raster);
            } else if (raster.kind === 'bitmap') {
              raster.bitmap.close(); // nobody wants it anymore
            }
          },
          (e) => {
            if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
            job.reject(e);
          },
        )
        .finally(() => {
          this.inflight--;
          this.pump();
        });
    }
  }

  private store(k: string, raster: Raster) {
    const px = raster.width * raster.height;
    this.entries.set(k, { raster, px });
    this.px += px;
    for (const [ek, e] of this.entries) {
      if (this.px <= PIXEL_BUDGET || ek === k) break;
      this.entries.delete(ek);
      this.px -= e.px;
      if (e.raster.kind === 'bitmap') e.raster.bitmap.close();
    }
  }

  dispose() {
    for (const j of this.jobs.values()) j.ctrl.abort();
    for (const e of this.entries.values()) if (e.raster.kind === 'bitmap') e.raster.bitmap.close();
    this.entries.clear();
    this.jobs.clear();
  }
}
