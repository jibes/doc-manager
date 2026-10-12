import * as ort from 'onnxruntime-web/wasm';
import { DETECT_MODEL, workerModels, threadCount, workerWasm } from '../assets';
import { heatmapsToQuad, type Detection } from '../detect/heatmap';
import {
  clipToFrame,
  colourPlanes,
  frameSearch,
  printedLine,
  quadSupport,
  quadSupported,
  searchQuad,
} from '../detect/quadSearch';
import { toLuma, type FloatImage, type Quad, type RGBAImage } from '../imaging/image';
import { clampQuad, plausibleQuad, quadArea, scaleQuad } from '../imaging/quad';
import { refineQuad } from '../imaging/refine';
import { sharpness } from '../imaging/sharpness';
import { MODEL_INPUT } from '../detect/model';
import type { DetectorRequest, DetectorResponse, StillResult, StillSource } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<DetectorRequest>) => void) | null;
  postMessage: (message: DetectorResponse, transfer?: Transferable[]) => void;
  crossOriginIsolated?: boolean;
  name?: string;
};

const MODEL_URL = workerModels() + DETECT_MODEL;
/** Long edge of the image the corners are refined on. */
const REFINE_EDGE = 1600;

ort.env.wasm.wasmPaths = { wasm: workerWasm() };
// Threads need cross-origin isolation, which static hosts like GitHub Pages
// cannot provide. Single-threaded SIMD is fast enough for a 1.6 GFLOP model.
ort.env.wasm.numThreads = threadCount();

let session: ort.InferenceSession | null = null;

async function init(): Promise<void> {
  try {
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    self.postMessage({ type: 'ready', backend: 'wasm' });
  } catch (error) {
    self.postMessage({
      type: 'init-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The model was trained on images loaded with OpenCV, i.e. BGR channel order,
 * scaled to 0..1, NCHW.
 */
function toTensor(rgba: Uint8ClampedArray): ort.Tensor {
  const plane = MODEL_INPUT * MODEL_INPUT;
  const input = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    input[i] = rgba[p + 2] / 255;
    input[plane + i] = rgba[p + 1] / 255;
    input[2 * plane + i] = rgba[p] / 255;
  }
  return new ort.Tensor('float32', input, [1, 3, MODEL_INPUT, MODEL_INPUT]);
}

async function infer(bitmap: ImageBitmap): Promise<Detection | null> {
  if (!session) throw new Error('The detector is not loaded');
  const canvas = new OffscreenCanvas(MODEL_INPUT, MODEL_INPUT);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, MODEL_INPUT, MODEL_INPUT);
  const pixels = ctx.getImageData(0, 0, MODEL_INPUT, MODEL_INPUT).data;
  const output = await session.run({ [session.inputNames[0]]: toTensor(pixels) });
  const heat = output[session.outputNames[0]];
  const size = heat.dims[3];
  return heatmapsToQuad(heat.data as Float32Array, size);
}

/** Search resolution for the edge-based page finder, relative to REFINE_EDGE. */
const SEARCH_FACTOR = 2;
/** The edge search's quad is within a couple of pixels; refine it only that far. */
const EDGE_REFINE_REACH = 4 * SEARCH_FACTOR;
/** The edge search replaces a well-supported model quad only if it is clearly larger. */
const MIN_GROWTH = 1.03;
/**
 * The model's quad is taken without the photo's edges confirming it only
 * from this confidence up. Below it, DocAligner is often confidently wrong on
 * busy scenes: a page among other papers on a pin board, its top edge put on
 * a table rule a third of the way down.
 */
const MODEL_TRUST = 0.75;
/** Confidence reported for a page found by the relaxed edge search alone. */
const RELAXED_CONFIDENCE = 0.4;
/** ... and for one taken to fill the frame (a scan, a sheet photographed close up). */
const FRAME_CONFIDENCE = 0.3;

/**
 * The page in a still, from the model's quad checked against the photo's
 * edges (detect/quadSearch.ts), in this order:
 *
 * 1. The model's quad when all four sides are real edges, unless a larger
 *    fully supported quad contains it.
 * 2. Otherwise the edge search's fully supported quad.
 * 3. Otherwise the relaxed edge search's (bowed paper, a weak side): checked
 *    against the photo, unlike the model's.
 * 4. Otherwise the model's quad if the model is sure of it, it has the
 *    shape of a photographed rectangle and none of its sides is a line
 *    printed on the paper (a form's table rule).
 * 5. Otherwise a page filling the frame (`frameSearch`): a flat scan, or a
 *    sheet photographed so close that it runs off the photo, its sides the
 *    paper's edges near the borders or the borders themselves.
 * 6. Otherwise nothing: the user places the corners (a guessed quad shown as
 *    found would be worse).
 *
 * Coordinates are those of `rgba` / `luma`.
 */
function findPage(
  rgba: RGBAImage,
  luma: FloatImage,
  detection: Detection | null,
): {
  quad: Quad;
  confidence: number;
  source: StillSource;
  offFrame: boolean;
} | null {
  const { width: w, height: h } = luma;
  // Corners fitted locally: a pinned-up sheet bows (refine.ts).
  const model = detection
    ? refineQuad(luma, scaleQuad(detection.quad, w, h), undefined, { local: true })
    : null;
  const planes = colourPlanes(rgba, SEARCH_FACTOR);
  const toPlanes = planes.width / w;
  const modelSmall = model ? scaleQuad(model, toPlanes) : null;
  const modelOk = modelSmall !== null && quadSupported(planes, modelSmall);
  const modelSure =
    model !== null &&
    detection !== null &&
    detection.confidence >= MODEL_TRUST &&
    plausibleQuad(model, w, h) &&
    !quadSupport(planes, modelSmall!).some(printedLine);
  const search = searchQuad(planes, {
    contain: modelOk ? modelSmall! : undefined,
    relaxed: modelOk ? undefined : {},
  });
  const fromModel = () => ({
    ...fitFrame(model!, w, h),
    confidence: detection!.confidence,
    source: 'model' as const,
  });
  if (modelOk && (!search || quadArea(search.quad) < quadArea(modelSmall!) * MIN_GROWTH)) {
    return fromModel();
  }
  if (!search && modelSure) return fromModel();
  if (!search) {
    const frame = frameSearch(planes);
    if (!frame) return null;
    // Its sides are the frame's borders or edges right by them: nothing to
    // refine, and refining a border side would pull it onto the print.
    const fitted = fitFrame(scaleQuad(frame.quad, 1 / toPlanes), w, h);
    return {
      quad: clampQuad(fitted.quad, w, h),
      confidence: FRAME_CONFIDENCE,
      source: 'frame',
      offFrame: fitted.offFrame || frame.offFrame,
    };
  }
  const strict = search.tier === 'strict';
  const found = scaleQuad(search.quad, 1 / toPlanes);
  const fitted = fitFrame(
    keepBorders(found, refineQuad(luma, found, EDGE_REFINE_REACH, { local: true }), w, h),
    w,
    h,
  );
  return {
    quad: fitted.quad,
    // The edge search has no calibrated confidence; report the model's
    // when it agreed on the page at all.
    confidence: detection && modelOk ? detection.confidence : strict ? 0.5 : RELAXED_CONFIDENCE,
    source: 'edges',
    // A side on the frame's border (the page runs off there) or a clipped corner.
    offFrame: fitted.offFrame || (search.offFrame && onBorder(fitted.quad, w, h)),
  };
}

/**
 * A side the edge search put on the frame's border (the page runs off
 * there) stays on it: refinement would pull it onto whatever edge lies
 * nearby, a rule printed near the page's cut-off end.
 */
function keepBorders(found: Quad, refined: Quad, w: number, h: number): Quad {
  // Frame lines give border coordinates exact to the search grid.
  const tol = 3;
  const snap = (v: number, before: number, edge: number) =>
    Math.abs(before) <= tol ? 0 : Math.abs(before - edge) <= tol ? edge : v;
  return refined.map(([x, y], i) => [
    snap(x, found[i][0], w),
    snap(y, found[i][1], h),
  ]) as unknown as Quad;
}

/** Corners this far past the photo's edge (fraction of its long edge) are left as they are. */
const FRAME_SLACK = 0.02;

/**
 * A page quad with corners well outside the photo is cut to the part in
 * view (detect/quadSearch.ts clipToFrame). One just past the edge is kept:
 * the warp repeats the edge pixels for that sliver, which costs less than
 * cutting the page's corner off.
 */
function fitFrame(q: Quad, w: number, h: number): { quad: Quad; offFrame: boolean } {
  const slack = FRAME_SLACK * Math.max(w, h);
  if (q.every(([x, y]) => x >= -slack && y >= -slack && x <= w + slack && y <= h + slack)) {
    return { quad: q, offFrame: false };
  }
  return { quad: clipToFrame(q, w, h), offFrame: true };
}

function onBorder(q: Quad, w: number, h: number): boolean {
  return q.some(([x, y]) => x <= 0.5 || y <= 0.5 || x >= w - 0.5 || y >= h - 0.5);
}

async function detectStill(source: Blob): Promise<StillResult> {
  // Decode once; the model, the refinement and the blur check all draw from
  // this bitmap.
  const full = await createImageBitmap(source, { imageOrientation: 'from-image' });
  const { width, height } = full;
  try {
    const detection = await infer(full);

    const scale = Math.min(1, REFINE_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a 2D canvas context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, w, h);
    const rgba = { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
    const luma = toLuma(rgba);

    const found = findPage(rgba, luma, detection);
    if (!found) {
      return {
        quad: null,
        width,
        height,
        confidence: 0,
        sharpness: sharpness(luma),
        source: 'none',
        offFrame: false,
      };
    }
    const refined = found.quad;
    // Judge sharpness on the page itself, a little inside its edges.
    const xs = refined.map((p) => p[0]);
    const ys = refined.map((p) => p[1]);
    const insetX = (Math.max(...xs) - Math.min(...xs)) * 0.08;
    const insetY = (Math.max(...ys) - Math.min(...ys)) * 0.08;
    return {
      quad: scaleQuad(refined, width / w, height / h),
      width,
      height,
      confidence: found.confidence,
      source: found.source,
      offFrame: found.offFrame,
      sharpness: sharpness(luma, {
        x0: Math.min(...xs) + insetX,
        y0: Math.min(...ys) + insetY,
        x1: Math.max(...xs) - insetX,
        y1: Math.max(...ys) - insetY,
      }),
    };
  } finally {
    full.close();
  }
}

async function handle(request: DetectorRequest): Promise<void> {
  if (request.type === 'init') return init();
  const { id } = request;
  try {
    if (request.type === 'frame') {
      const start = performance.now();
      let detection: Detection | null;
      try {
        detection = await infer(request.frame);
      } finally {
        request.frame.close();
      }
      self.postMessage({ type: 'frame', id, detection, ms: performance.now() - start });
      return;
    }
    const result = await detectStill(request.source);
    self.postMessage({ type: 'still', id, ...result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

let queue: Promise<void> = Promise.resolve();
/**
 * ONNX Runtime runs its threads (when the page is cross-origin isolated) as copies of this script named
 * "em-pthread": those answer the runtime, not the app.
 */
const pthread = self.name?.startsWith('em-pthread');

if (!pthread) self.onmessage = (event) => {
  queue = queue.then(() => handle(event.data));
};
