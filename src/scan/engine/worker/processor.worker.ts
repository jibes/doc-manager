import { applyFilter, applyFilterForText, isGrayFilter, type FilterId } from '../imaging/filters';
import type { RGBAImage } from '../imaging/image';
import { quadPageSize, scaleQuad } from '../imaging/quad';
import { resize } from '../imaging/resample';
import { pngPredict } from '../pdf/predict';
import type { PdfImage } from '../pdf/writer';
import { filterContext, rectifyPage, type PageSpec } from '../pipeline';
import { rgbaToImageData } from './decode';
import type { ProcessorRequest, ProcessorResponse, RenderJob } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<ProcessorRequest>) => void) | null;
  postMessage: (message: ProcessorResponse, transfer?: Transferable[]) => void;
};

/*
 * Small caches so that moving a slider only re-runs the filter, not the decode
 * and the warp. Sizes are deliberately tiny: a decoded 12 MP photo is ~48 MB.
 */
interface Decoded {
  blob: Blob;
  image: RGBAImage;
  /** Decoded pixels per source pixel. */
  scale: number;
}
/**
 * A rectified page and what the filter needs to know about its decode. Not
 * the decode itself: that would keep up to MAX_RECTIFIED full decodes alive
 * past the MAX_SOURCES limit.
 */
interface Rectified {
  page: RGBAImage;
  blob: Blob;
  /** Decoded pixels per source pixel. */
  scale: number;
  /** Size of the decoded image. */
  decodedSize: { width: number; height: number };
}
const sources = new Map<string, Decoded>();
const rectified = new Map<string, Rectified>();
const MAX_SOURCES = 3;
const MAX_RECTIFIED = 4;

function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

/**
 * The photo decoded at the smallest of 1, 1/2 or 1/4 of its size that still
 * gives the requested page size without enlarging. A 520 px thumbnail of a
 * 12 MP photo then decodes 3 MP-or-less instead of 12, natively and fast.
 */
async function getSource(job: RenderJob, cache = true): Promise<Decoded> {
  const page = quadPageSize(job.spec.quad, { width: job.sourceWidth, height: job.sourceHeight });
  const needed = job.longEdge / Math.max(page.width, page.height);
  const bucket = needed <= 0.25 ? 0.25 : needed <= 0.5 ? 0.5 : 1;
  const key = `${job.pageId}|${bucket}`;
  const hit = sources.get(key);
  if (hit && hit.blob === job.source) {
    touch(sources, key, hit, MAX_SOURCES);
    return hit;
  }
  const options: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (bucket < 1) {
    options.resizeWidth = Math.max(1, Math.round(job.sourceWidth * bucket));
    options.resizeHeight = Math.max(1, Math.round(job.sourceHeight * bucket));
    options.resizeQuality = 'high';
  }
  const bitmap = await createImageBitmap(job.source, options);
  const { width, height } = bitmap;
  // The bitmap and the canvas each hold another full copy of the pixels: let
  // each go as soon as it has been read, not when the GC gets round to it.
  const canvas = new OffscreenCanvas(width, height);
  let data: Uint8ClampedArray<ArrayBuffer>;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a 2D canvas context');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    data = ctx.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
  // Browsers without resize support decode at full size; measure, don't assume.
  const decoded: Decoded = {
    blob: job.source,
    image: { data, width, height },
    scale: width / job.sourceWidth,
  };
  if (cache) touch(sources, key, decoded, MAX_SOURCES);
  return decoded;
}

/** The page spec in the decoded image's pixel coordinates. */
function scaledSpec(spec: PageSpec, scale: number): PageSpec {
  return scale === 1 ? spec : { ...spec, quad: scaleQuad(spec.quad, scale) };
}

async function getRectified(job: RenderJob, cache: boolean): Promise<Rectified> {
  const { spec } = job;
  const key = `${job.pageId}|${spec.quad
    .flat()
    .map((v) => v.toFixed(2))
    .join(',')}|${spec.rotation}|${job.longEdge}`;
  const hit = rectified.get(key);
  if (hit && hit.blob === job.source) {
    touch(rectified, key, hit, MAX_RECTIFIED);
    return hit;
  }
  // A full-size decode for a one-off export render is not worth keeping.
  const decoded = await getSource(job, cache);
  const page = rectifyPage(decoded.image, scaledSpec(spec, decoded.scale), job.longEdge);
  const { width, height } = decoded.image;
  const entry = { page, blob: job.source, scale: decoded.scale, decodedSize: { width, height } };
  if (cache) touch(rectified, key, entry, MAX_RECTIFIED);
  return entry;
}

async function toBitmap(image: RGBAImage): Promise<ImageBitmap> {
  return createImageBitmap(rgbaToImageData(image));
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  // 'deflate' is the zlib format, which is exactly what PDF's FlateDecode expects.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when every pixel is neutral grey, so one channel holds all of it. */
function isNeutral(image: RGBAImage): boolean {
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p] !== d[p + 1] || d[p + 1] !== d[p + 2]) return false;
  }
  return true;
}

async function encodeJpeg(image: RGBAImage, quality: number): Promise<PdfImage> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.putImageData(rgbaToImageData(image), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  canvas.width = canvas.height = 0;
  return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), components: 3 };
}

/** Losslessly stored Document pages larger than this are tried as JPEG too. */
const PHOTO_PAGE_BYTES = 800 * 1024;

/**
 * Lossless (Flate, PNG-predicted where that helps) for the clean filters:
 * their output is flat white with crisp ink, which JPEG would both bloat and
 * ring around. JPEG for the photographic ones, and for Document pages that
 * are mostly photograph.
 */
async function encodeForPdf(
  image: RGBAImage,
  filter: FilterId,
  quality: number,
): Promise<PdfImage> {
  if (filter === 'color' || filter === 'original') return encodeJpeg(image, quality);

  const gray = isGrayFilter(filter) || isNeutral(image);
  const channels = gray ? 1 : 3;
  const samples = new Uint8Array(image.width * image.height * channels);
  for (let i = 0, p = 0; p < image.data.length; p += 4) {
    samples[i++] = image.data[p];
    if (!gray) {
      samples[i++] = image.data[p + 1];
      samples[i++] = image.data[p + 2];
    }
  }
  // Document and B&W output is flat runs of white and black, which plain
  // deflate already handles best. PNG prediction only pays off on smooth
  // tones, so it is only tried, and kept if smaller, for the grey filter.
  const plain = await deflate(samples);
  if (filter !== 'gray') {
    // A Document page with photos on it is mostly photograph, which deflate
    // barely shrinks: there JPEG is far smaller, at a quality that leaves
    // the text crisp.
    if (filter === 'document' && plain.length > PHOTO_PAGE_BYTES) {
      const jpeg = await encodeJpeg(image, quality);
      if (jpeg.bytes.length < plain.length * 0.6) return jpeg;
    }
    return { kind: 'flate', bytes: plain, components: channels, predictor: false };
  }
  const predicted = await deflate(pngPredict(samples, image.width, image.height, channels));
  return predicted.length < plain.length
    ? { kind: 'flate', bytes: predicted, components: channels, predictor: true }
    : { kind: 'flate', bytes: plain, components: channels, predictor: false };
}

/** Jobs waiting in the queue, and those of them cancelled before starting. */
const queued = new Set<number>();
const cancelled = new Set<number>();

async function handle(request: ProcessorRequest): Promise<void> {
  if (request.type === 'cancel') return;
  if (request.type === 'forget') {
    for (const key of [...sources.keys()]) {
      if (key.startsWith(`${request.pageId}|`)) sources.delete(key);
    }
    for (const key of [...rectified.keys()]) {
      if (key.startsWith(`${request.pageId}|`)) rectified.delete(key);
    }
    return;
  }

  const { id } = request;
  queued.delete(id);
  if (cancelled.delete(id)) {
    self.postMessage({ type: 'error', id, message: 'cancelled' });
    return;
  }
  try {
    // Export renders are one-off and large; caching them would only pin memory.
    let entry: Rectified | null = await getRectified(request, request.type !== 'encode');
    if (request.type === 'rectified') {
      const bitmap = await toBitmap(entry.page);
      self.postMessage({ type: 'bitmap', id, bitmap }, [bitmap]);
      return;
    }
    const spec = scaledSpec(request.spec, entry.scale);
    const context = filterContext(spec.quad, request.longEdge, entry.decodedSize);
    // With text asked for, the filter also hands over the page as the
    // recogniser should read it (see applyFilterForText).
    const ocrEdge = request.type === 'encode' ? request.ocrEdge : undefined;
    let result: RGBAImage;
    let ocr: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } | undefined;
    if (ocrEdge) {
      const { image, reading } = applyFilterForText(
        entry.page,
        spec.filter,
        spec.adjustments,
        context,
      );
      result = image;
      // Shrunk right away, so the full-size reading page is not held
      // through encoding.
      const scale = Math.min(1, ocrEdge / Math.max(reading.width, reading.height));
      ocr = resize(
        reading,
        Math.max(1, Math.round(reading.width * scale)),
        Math.max(1, Math.round(reading.height * scale)),
      );
    } else {
      result = applyFilter(entry.page, spec.filter, spec.adjustments, context);
    }
    // An uncached export page is garbage from here on; don't hold it through
    // encoding.
    entry = null;
    if (request.type === 'render') {
      const bitmap = await toBitmap(result);
      self.postMessage({ type: 'bitmap', id, bitmap }, [bitmap]);
      return;
    }
    const image = await encodeForPdf(result, spec.filter, request.jpegQuality);
    const transfer: Transferable[] = [image.bytes.buffer];
    if (ocr) transfer.push(ocr.data.buffer);
    self.postMessage(
      { type: 'encoded', id, image, width: result.width, height: result.height, ocr },
      transfer,
    );
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Serialise: one job at a time, in order. Cancellations skip the queue so a
// job that is no longer wanted never starts.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    // A job already running or done cannot be skipped any more, and noting
    // its id would only grow the set forever.
    if (queued.has(request.id)) cancelled.add(request.id);
    return;
  }
  if (request.type !== 'forget') queued.add(request.id);
  queue = queue.then(() => handle(request));
};
