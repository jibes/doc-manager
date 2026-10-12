/**
 * Where the scanner's workers, wasm and models are served. Built by scripts/build-engine.mjs into
 * public/engine (workers, ONNX Runtime) and public/models (committed, Apache-2.0; see NOTICE.md there).
 */
export const OCR_MODELS = ['ppocrv5-det.onnx', 'ppocrv5-latin-rec.onnx', 'ppocrv5-latin-dict.txt'] as const;
export const DETECT_MODEL = 'docaligner-lc100.onnx';
export const ORT_WASM = 'ort-wasm-simd-threaded.wasm';
export type ScanWorker = 'processor' | 'detector' | 'ocr';
export const workerFile = (name: ScanWorker) => `scan-${name}.js`;

/** Inside a worker (served from <root>/engine/): the models folder. */
export const workerModels = () => new URL('../models/', self.location.href).href;
/** Inside a worker: ONNX Runtime's wasm, next to the worker. */
export const workerWasm = () => new URL(ORT_WASM, self.location.href).href;

/**
 * Threads for ONNX Runtime: several when memory can be shared with other workers. Browsers allow that only
 * on cross-origin isolated pages; Android's WebView may allow it without (its pages have no isolation
 * headers to give). Tried for real: a shared buffer that can't be posted means one thread.
 */
export function threadCount(): number {
  if (typeof SharedArrayBuffer === 'undefined') return 1;
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const channel = new MessageChannel();
    channel.port1.postMessage(memory.buffer);
    channel.port1.close();
    channel.port2.close();
  } catch {
    return 1;
  }
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}
