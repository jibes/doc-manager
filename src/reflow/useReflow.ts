import { useSyncExternalStore } from 'react';

import type { DocHandle, TextLine } from '@/engine/types';
import { buildReflow, type Reflow } from './build';

export type ReflowState =
  | { status: 'loading'; progress: number }
  | { status: 'ready'; reflow: Reflow }
  | { status: 'unsupported' }
  | { status: 'error' };

type Job = { state: ReflowState; listeners: Set<() => void> };

/** One extraction per open document, shared by every view of it. */
const jobs = new WeakMap<DocHandle, Job>();
const CHUNK = 24;

function start(handle: DocHandle): Job {
  const job: Job = { state: { status: 'loading', progress: 0 }, listeners: new Set() };
  const set = (state: ReflowState) => {
    job.state = state;
    job.listeners.forEach((l) => l());
  };
  (async () => {
    const pages: TextLine[][] = [];
    for (let i = 0; i < handle.pageCount; i += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, handle.pageCount - i) }, (_, k) => i + k);
      const lines = await handle.textLines(batch);
      if (!lines) return set({ status: 'unsupported' });
      pages.push(...lines);
      set({ status: 'loading', progress: Math.min(1, (i + CHUNK) / handle.pageCount) });
    }
    set({ status: 'ready', reflow: buildReflow(pages) });
  })().catch(() => set({ status: 'error' }));
  return job;
}

function jobFor(handle: DocHandle): Job {
  let job = jobs.get(handle);
  if (!job) {
    job = start(handle);
    jobs.set(handle, job);
  }
  return job;
}

/** Reflowed text for a document; extraction starts on first use and is cached for the handle's lifetime. */
export function useReflow(handle: DocHandle): ReflowState {
  const job = jobFor(handle);
  return useSyncExternalStore(
    (cb) => {
      job.listeners.add(cb);
      return () => job.listeners.delete(cb);
    },
    () => job.state,
    () => job.state,
  );
}
