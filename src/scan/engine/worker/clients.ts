import { BASE } from '@/lib/base';

import { workerFile, type ScanWorker } from '../assets';
import type { Detection } from '../detect/heatmap';
import type { PdfImage } from '../pdf/writer';
import type { OcrWord } from '../ocr/paddle';
import type {
  DetectorRequest,
  DetectorResponse,
  OcrRequest,
  OcrResponse,
  ProcessorRequest,
  ProcessorResponse,
  RenderJob,
  StillResult,
} from './protocol';

const workerUrl = (name: ScanWorker) => `${BASE}/engine/${workerFile(name)}`;

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * Request/response bookkeeping shared by the worker clients.
 *
 * A worker that fails to load (a missing script or wasm, e.g. after an app
 * update) or crashes never answers again, so any failure is final: everything
 * pending is rejected, the worker is terminated, and later requests reject
 * straight away. `services.ts` and `exportCache.ts` then create a fresh client
 * on next use. A request that outlives its timeout counts as such a failure,
 * since the worker handles one job at a time and everything behind it would
 * wait just as long.
 */
class WorkerClient<Res extends { type: string }> {
  private nextId = 1;
  private pending = new Map<number, Pending<Res>>();
  private failure: Error | null = null;

  constructor(
    protected readonly worker: Worker,
    private readonly name: string,
  ) {
    worker.onmessage = (event: MessageEvent<Res>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || `The ${name} worker crashed`));
    };
    worker.onmessageerror = () =>
      this.fail(new Error(`The ${name} worker sent an unreadable reply`));
  }

  /** True once the worker has failed; the client is then useless. */
  get dead(): boolean {
    return this.failure !== null;
  }

  /** Handles messages that answer no request (e.g. "ready"); returns true if it did. */
  protected unsolicited(message: Res): boolean {
    return !('id' in message);
  }

  protected toError(message: string): Error {
    return new Error(message);
  }

  private receive(message: Res): void {
    if (this.unsolicited(message)) return;
    const { id } = message as Res & { id: number };
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.type === 'error') {
      pending.reject(this.toError((message as Res & { message: string }).message));
    } else {
      pending.resolve(message);
    }
  }

  protected fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  protected request(
    message: object,
    options: { transfer?: Transferable[]; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Res> {
    if (this.failure) return Promise.reject(this.failure);
    const { transfer = [], signal, timeoutMs } = options;
    if (signal?.aborted) return Promise.reject(new AbortedError());
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => this.fail(new Error(`The ${this.name} worker stopped responding`)),
              timeoutMs,
            );
      const onAbort = () => this.worker.postMessage({ type: 'cancel', id });
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.worker.postMessage({ ...message, id }, transfer);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  dispose(): void {
    this.fail(new Error(`The ${this.name} worker was closed`));
  }
}

export class AbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortedError';
  }
}

/* ------------------------------------------------------------ processor ---- */

/** A full-quality export render of one page; generous for slow phones. */
const ENCODE_TIMEOUT_MS = 180_000;

/**
 * Promise wrapper around the processing worker.
 *
 * Interactive renders go through named channels: each channel has at most one
 * job in the worker and one waiting. A newer request replaces the waiting one
 * (which resolves to null), so dragging a slider never builds a backlog and
 * the last position always gets rendered. Any request can be aborted; a job
 * the worker has not started yet is then skipped.
 */
export class ProcessorClient extends WorkerClient<ProcessorResponse> {
  private channels = new Map<
    string,
    { busy: boolean; waiting: { job: () => Promise<unknown>; cancel: () => void } | null }
  >();

  constructor() {
    super(
      new Worker(workerUrl('processor'), { type: 'module' }),
      'processing',
    );
  }

  protected override toError(message: string): Error {
    return message === 'cancelled' ? new AbortedError() : new Error(message);
  }

  private send(
    request: Distribute<Exclude<ProcessorRequest, { type: 'cancel' | 'forget' }>>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ProcessorResponse> {
    return this.request(request, options);
  }

  async render(job: RenderJob, signal?: AbortSignal): Promise<ImageBitmap> {
    const response = await this.send({ type: 'render', ...job }, { signal });
    if (response.type !== 'bitmap') throw new Error('Unexpected worker response');
    return response.bitmap;
  }

  async rectified(job: RenderJob, signal?: AbortSignal): Promise<ImageBitmap> {
    const response = await this.send({ type: 'rectified', ...job }, { signal });
    if (response.type !== 'bitmap') throw new Error('Unexpected worker response');
    return response.bitmap;
  }

  async encode(job: RenderJob & { jpegQuality: number; ocrEdge?: number }): Promise<{
    image: PdfImage;
    width: number;
    height: number;
    ocr?: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
  }> {
    const response = await this.send({ type: 'encode', ...job }, { timeoutMs: ENCODE_TIMEOUT_MS });
    if (response.type !== 'encoded') throw new Error('Unexpected worker response');
    return response;
  }

  /** Render on a coalescing channel. Resolves to null if a newer request replaced this one. */
  latest<T>(channel: string, job: () => Promise<T>): Promise<T | null> {
    let state = this.channels.get(channel);
    if (!state) {
      state = { busy: false, waiting: null };
      this.channels.set(channel, state);
    }
    const slot = state;
    return new Promise<T | null>((resolve, reject) => {
      const run = async () => {
        slot.busy = true;
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        } finally {
          slot.busy = false;
          const next = slot.waiting;
          slot.waiting = null;
          if (next) void next.job();
        }
      };
      if (!slot.busy) {
        void run();
        return;
      }
      slot.waiting?.cancel();
      slot.waiting = { job: run, cancel: () => resolve(null) };
    });
  }

  forget(pageId: string): void {
    if (!this.dead) this.worker.postMessage({ type: 'forget', pageId } satisfies ProcessorRequest);
  }
}

/* ------------------------------------------------------------- detector ---- */

/** Loading the model; it is precached, so this is mostly wasm compilation. */
const DETECTOR_READY_TIMEOUT_MS = 60_000;
/** Detection and corner refinement on a full-resolution photo. */
const STILL_TIMEOUT_MS = 30_000;
/** One live-preview frame; normally well under a second. */
const FRAME_TIMEOUT_MS = 10_000;

export class DetectorClient extends WorkerClient<DetectorResponse> {
  /** Settles once the model is loaded; rejects if it cannot be, or the worker fails. */
  readonly ready: Promise<void>;
  private settleReady!: { resolve: () => void; reject: (error: Error) => void };

  constructor() {
    super(
      new Worker(workerUrl('detector'), { type: 'module' }),
      'detector',
    );
    this.ready = new Promise((resolve, reject) => (this.settleReady = { resolve, reject }));
    // Callers that never await `ready` should not see an unhandled rejection.
    this.ready.catch(() => undefined);
    const timer = setTimeout(
      () => this.fail(new Error('The page detector took too long to load')),
      DETECTOR_READY_TIMEOUT_MS,
    );
    this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    this.worker.postMessage({ type: 'init' } satisfies DetectorRequest);
  }

  protected override unsolicited(message: DetectorResponse): boolean {
    if (message.type === 'ready') this.settleReady.resolve();
    else if (message.type === 'init-error') this.fail(new Error(message.message));
    else return false;
    return true;
  }

  protected override fail(error: Error): void {
    super.fail(error);
    this.settleReady.reject(error);
  }

  /** Detect on a frame already resized to the model input. Takes ownership of the bitmap. */
  async frame(frame: ImageBitmap): Promise<{ detection: Detection | null; ms: number }> {
    const response = await this.request(
      { type: 'frame', frame },
      { transfer: [frame], timeoutMs: FRAME_TIMEOUT_MS },
    );
    if (response.type !== 'frame') throw new Error('Unexpected detector response');
    return response;
  }

  async still(source: Blob): Promise<StillResult> {
    const response = await this.request({ type: 'still', source }, { timeoutMs: STILL_TIMEOUT_MS });
    if (response.type !== 'still') throw new Error('Unexpected detector response');
    return response;
  }
}

/* ------------------------------------------------------------------ ocr ---- */

/** One page, including the first-use download of ~13 MB of models. */
const OCR_TIMEOUT_MS = 300_000;

/** On-device OCR (PaddleOCR), loaded on first use. */
export class OcrClient extends WorkerClient<OcrResponse> {
  constructor() {
    super(new Worker(workerUrl('ocr'), { type: 'module' }), 'OCR');
  }

  /**
   * Words found in an image, in its pixel coordinates. With `orient`, the
   * page may be found to be sideways or upside down: the words are then in
   * the pixels of the image turned upright by `turn` clockwise quarter
   * turns. Takes ownership of `data`.
   */
  async recognise(
    image: {
      data: Uint8ClampedArray<ArrayBuffer>;
      width: number;
      height: number;
    },
    { orient = false }: { orient?: boolean } = {},
  ): Promise<{ words: OcrWord[]; turn: number }> {
    const response = await this.request(
      { type: 'ocr', ...image, orient } satisfies Distribute<OcrRequest>,
      { transfer: [image.data.buffer], timeoutMs: OCR_TIMEOUT_MS },
    );
    if (response.type !== 'words') throw new Error('Unexpected OCR response');
    return { words: response.words, turn: response.turn };
  }
}
