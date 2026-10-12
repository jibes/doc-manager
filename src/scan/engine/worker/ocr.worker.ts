import * as ort from 'onnxruntime-web/wasm';
import { OCR_MODELS, workerModels, workerWasm } from '../assets';
import { rotateRGBA, type RGBAImage } from '../imaging/image';
import { resize } from '../imaging/resample';
import {
  ctcDecode,
  detectionBoxes,
  detectionSize,
  detectionTensor,
  lineWords,
  readingOrder,
  recognitionInput,
  scaleBox,
  REC_HEIGHT,
  type OcrWord,
  type TextBox,
} from '../ocr/paddle';
import {
  flipBox,
  isSideways,
  isUpsideDown,
  lineAxes,
  sampleLines,
  sidewaysChoice,
  type LineAxes,
} from '../ocr/orientation';
import type { OcrRequest, OcrResponse } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<OcrRequest>) => void) | null;
  postMessage: (message: OcrResponse, transfer?: Transferable[]) => void;
  crossOriginIsolated?: boolean;
  name?: string;
};

const BASE = workerModels();
/** Long side of the image the detector sees; text lines are ~15 px tall there. */
const DETECT_SIDE = 1280;
/** Lines with less confidence than this are noise, not text. */
const MIN_CONFIDENCE = 0.5;

ort.env.wasm.wasmPaths = { wasm: workerWasm() };
ort.env.wasm.numThreads = self.crossOriginIsolated ? 4 : 1;

let models: Promise<{
  det: ort.InferenceSession;
  rec: ort.InferenceSession;
  dict: string[];
}> | null = null;

function load() {
  models ??= (async () => {
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };
    const [det, rec, dictText] = await Promise.all([
      ort.InferenceSession.create(BASE + OCR_MODELS[0], options),
      ort.InferenceSession.create(BASE + OCR_MODELS[1], options),
      fetch(BASE + OCR_MODELS[2]).then((r) => r.text()),
    ]);
    const dict = dictText.replace(/\r/g, '').split('\n');
    if (dict.at(-1) === '') dict.pop();
    return { det, rec, dict };
  })();
  models.catch(() => (models = null));
  return models;
}

type Models = Awaited<ReturnType<typeof load>>;

/** Text boxes, and the shape of the text regions, in image pixels. */
async function detect(
  { det }: Models,
  image: RGBAImage,
): Promise<{ boxes: TextBox[]; axes: LineAxes }> {
  const size = detectionSize(image.width, image.height, DETECT_SIDE);
  const small = resize(image, size.width, size.height);
  const detOut = await det.run({
    [det.inputNames[0]]: new ort.Tensor('float32', detectionTensor(small), [
      1,
      3,
      size.height,
      size.width,
    ]),
  });
  const prob = detOut[det.outputNames[0]].data as Float32Array;
  const sx = image.width / size.width;
  const sy = image.height / size.height;
  return {
    boxes: detectionBoxes(prob, size.width, size.height).map((b) => scaleBox(b, sx, sy)),
    axes: lineAxes(prob, size.width, size.height),
  };
}

async function read({ rec, dict }: Models, image: RGBAImage, box: TextBox) {
  const input = recognitionInput(image, box);
  const out = await rec.run({
    [rec.inputNames[0]]: new ort.Tensor('float32', input.tensor, [1, 3, REC_HEIGHT, input.width]),
  });
  const logits = out[rec.outputNames[0]];
  const [, steps, classes] = logits.dims as number[];
  return {
    line: ctcDecode(logits.data as Float32Array, steps, classes, dict),
    steps,
    filled: input.textWidth / input.width,
  };
}

/**
 * Words on the page, in the pixels of the page turned upright, and how many
 * quarter turns clockwise that took (see ocr/orientation.ts). With
 * `orient` false the page is read as it is.
 */
async function recognise(
  image: RGBAImage,
  orient: boolean,
): Promise<{ words: OcrWord[]; turn: number }> {
  const models = await load();
  let page = image;
  let turn = 0;
  const first = await detect(models, page);
  let { boxes } = first;
  const { axes } = first;

  if (orient && isSideways(axes)) {
    const turned = rotateRGBA(page, 1);
    const found = await detect(models, turned);
    // Only if the text runs across once turned.
    if (!isSideways(found.axes) && found.axes.wideCount > found.axes.tallCount) {
      page = turned;
      turn = 1;
      ({ boxes } = found);
    }
  }

  // Lines already read, by box, so the orientation sample is not read twice.
  const known = new Map<TextBox, Awaited<ReturnType<typeof read>>>();
  if (orient) {
    const sample = sampleLines(boxes);
    const flipped = rotateRGBA(page, 2);
    const asIs: number[] = [];
    const upside: number[] = [];
    const flippedReads: Awaited<ReturnType<typeof read>>[] = [];
    for (const box of sample) {
      const a = await read(models, page, box);
      const b = await read(models, flipped, flipBox(box, page.width, page.height));
      known.set(box, a);
      flippedReads.push(b);
      asIs.push(a.line.confidence);
      upside.push(b.line.confidence);
    }
    const choice = turn === 1 ? sidewaysChoice(asIs, upside) : null;
    if (choice === 'neither') {
      // Sideways lines that read as nothing either way: leave the page alone.
      page = image;
      turn = 0;
      ({ boxes } = first);
      known.clear();
    } else if (choice === 'turned' || (choice === null && isUpsideDown(asIs, upside))) {
      const { width: w, height: h } = page;
      page = flipped;
      turn = (turn + 2) % 4;
      known.clear();
      boxes = readingOrder(
        boxes.map((box) => {
          const moved = flipBox(box, w, h);
          const i = sample.indexOf(box);
          if (i >= 0) known.set(moved, flippedReads[i]);
          return moved;
        }),
      );
    }
  }

  const words: OcrWord[] = [];
  for (const box of boxes) {
    const { line, steps, filled } = known.get(box) ?? (await read(models, page, box));
    if (!line.text.trim() || line.confidence < MIN_CONFIDENCE) continue;
    words.push(...lineWords(line, box, steps, filled));
  }
  return { words, turn };
}

async function handle(request: OcrRequest): Promise<void> {
  const { id } = request;
  try {
    const { words, turn } = await recognise(
      { data: request.data, width: request.width, height: request.height },
      request.orient ?? false,
    );
    self.postMessage({ type: 'words', id, words, turn });
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
