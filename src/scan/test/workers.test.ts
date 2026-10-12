import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detector, processor } from '../services';
import { DetectorClient, OcrClient, ProcessorClient } from '../engine/worker/clients';
import type { RenderJob } from '../engine/worker/protocol';

/** Stands in for a Worker: records what was posted and lets tests answer or crash. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: Record<string, unknown>[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }

  crash(message = 'Failed to load worker script'): void {
    this.onerror?.({ message, preventDefault: () => undefined });
  }

  lastId(): number {
    return this.posted.at(-1)!.id as number;
  }
}

const job: RenderJob = {
  pageId: 'p',
  source: new Blob(),
  sourceWidth: 10,
  sourceHeight: 10,
  spec: {} as RenderJob['spec'],
  longEdge: 10,
};

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worker clients', () => {
  it('answers requests by id', async () => {
    const client = new ProcessorClient();
    const worker = FakeWorker.all[0];
    const pending = client.encode({ ...job, jpegQuality: 80 });
    worker.reply({ type: 'encoded', id: worker.lastId(), image: {}, width: 1, height: 2 });
    await expect(pending).resolves.toMatchObject({ width: 1, height: 2 });
    expect(client.dead).toBe(false);
  });

  it('fails everything, now and later, once the worker crashes', async () => {
    const client = new ProcessorClient();
    const worker = FakeWorker.all[0];
    const first = client.render(job);
    worker.crash();
    await expect(first).rejects.toThrow('Failed to load worker script');
    expect(client.dead).toBe(true);
    expect(worker.terminated).toBe(true);
    // A dead worker would never answer: later requests must not hang.
    await expect(client.render(job)).rejects.toThrow('Failed to load worker script');
    expect(worker.posted).toHaveLength(1);
  });

  it('frees a coalescing channel when its job fails', async () => {
    const client = new ProcessorClient();
    const first = client.latest('tile', () => client.render(job));
    const second = client.latest('tile', () => client.render(job));
    FakeWorker.all[0].crash();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await expect(client.latest('tile', () => Promise.resolve(7))).resolves.toBe(7);
  });

  it('gives up on a worker that stops responding', async () => {
    vi.useFakeTimers();
    const client = new OcrClient();
    const pending = client.recognise({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
    const outcome = expect(pending).rejects.toThrow('stopped responding');
    await vi.advanceTimersByTimeAsync(300_000);
    await outcome;
    expect(client.dead).toBe(true);
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it('rejects the detector’s readiness when its worker fails to load', async () => {
    const client = new DetectorClient();
    FakeWorker.all[0].crash();
    await expect(client.ready).rejects.toThrow('Failed to load worker script');
    await expect(client.still(new Blob())).rejects.toThrow();
  });

  it('rejects the detector’s readiness when the model fails to load', async () => {
    const client = new DetectorClient();
    FakeWorker.all[0].reply({ type: 'init-error', message: 'no model' });
    await expect(client.ready).rejects.toThrow('no model');
    expect(client.dead).toBe(true);
  });

  it('times out a detector that never finishes loading', async () => {
    vi.useFakeTimers();
    const client = new DetectorClient();
    const outcome = expect(client.ready).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
  });

  it('keeps a loaded detector ready after its first answer', async () => {
    const client = new DetectorClient();
    const worker = FakeWorker.all[0];
    worker.reply({ type: 'ready', backend: 'wasm' });
    await client.ready;
    const pending = client.still(new Blob());
    worker.reply({
      type: 'still',
      id: worker.lastId(),
      quad: null,
      width: 4,
      height: 3,
      confidence: 0,
      sharpness: 1,
    });
    await expect(pending).resolves.toMatchObject({ width: 4, height: 3 });
  });
});

describe('services', () => {
  it('replaces a dead client on next use', () => {
    const first = processor();
    expect(processor()).toBe(first);
    FakeWorker.all.at(-1)!.crash();
    const second = processor();
    expect(second).not.toBe(first);
    expect(second.dead).toBe(false);

    const found = detector();
    FakeWorker.all.at(-1)!.reply({ type: 'init-error', message: 'no model' });
    expect(detector()).not.toBe(found);
  });
});
