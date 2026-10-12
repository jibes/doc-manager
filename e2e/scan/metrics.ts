/**
 * Image and text metrics for the end-to-end harness. Pure functions over
 * typed arrays, except the canvas helpers at the bottom.
 */
import type { Point, Quad, RGBAImage } from '../../src/scan/engine/imaging/image';
import type { PdfImage } from '../../src/scan/engine/pdf/writer';
import type { DocSpec, Rect } from './corpus';

/* ------------------------------------------------------------- geometry ---- */

/**
 * Corner error of a detected quad against the truth, allowing the page to be
 * rotated in the frame: the truth corners are matched to the detected ones at
 * the cyclic shift with the least error. `shift` = k means detected corner i
 * is page corner (i + k) % 4, i.e. the output comes out rotated by k quarter
 * turns clockwise... (counter-clockwise for k = 1 viewed on the page).
 */
export function cornerError(detected: Quad, truth: Quad): { errors: number[]; shift: number } {
  let best = { errors: [Infinity], shift: 0 };
  for (let k = 0; k < 4; k++) {
    const errors = detected.map((p, i) => dist(p, truth[(i + k) % 4]));
    if (Math.max(...errors) < Math.max(...best.errors)) best = { errors, shift: k };
  }
  return best;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/* --------------------------------------------------------------- decode ---- */

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unpredict(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[row - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[row - stride + x - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = (raw + pred) & 255;
    }
  }
  return out;
}

/** The pixels exactly as embedded in the PDF. */
export async function decodePdfImage(
  image: PdfImage,
  width: number,
  height: number,
): Promise<RGBAImage> {
  const out: RGBAImage = { data: new Uint8ClampedArray(width * height * 4), width, height };
  if (image.kind === 'jpeg') {
    const bitmap = await createImageBitmap(new Blob([image.bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(width, height);
    const g = c.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    out.data.set(g.getImageData(0, 0, width, height).data);
    return out;
  }
  let samples = await inflate(image.bytes);
  if (image.predictor) samples = unpredict(samples, width, height, image.components);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (image.components === 1) {
      out.data[o] = out.data[o + 1] = out.data[o + 2] = samples[i];
    } else {
      out.data[o] = samples[i * 3];
      out.data[o + 1] = samples[i * 3 + 1];
      out.data[o + 2] = samples[i * 3 + 2];
    }
    out.data[o + 3] = 255;
  }
  return out;
}

/* --------------------------------------------------------------- pixels ---- */

export function rotate(img: RGBAImage, quarterTurnsCW: number): RGBAImage {
  const t = ((quarterTurnsCW % 4) + 4) % 4;
  if (t === 0) return img;
  const { width: w, height: h } = img;
  const ow = t === 2 ? w : h;
  const oh = t === 2 ? h : w;
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const data = new Uint8ClampedArray(ow * oh * 4);
  const dst = new Uint32Array(data.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number;
      let oy: number;
      if (t === 1) {
        ox = h - 1 - y;
        oy = x;
      } else if (t === 2) {
        ox = w - 1 - x;
        oy = h - 1 - y;
      } else {
        ox = y;
        oy = w - 1 - x;
      }
      dst[oy * ow + ox] = src[y * w + x];
    }
  }
  return { data, width: ow, height: oh };
}

function luma(d: Uint8ClampedArray, o: number): number {
  return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
}

function hsv(d: Uint8ClampedArray, o: number): [h: number, s: number, v: number] {
  const r = d[o];
  const g = d[o + 1];
  const b = d[o + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  let h = 0;
  if (c > 0) {
    if (max === r) h = ((g - b) / c + 6) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
  }
  return [h * 60, max === 0 ? 0 : c / max, max];
}

/** Square dilation of a 0/1 mask by `r` pixels (separable max). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    // Forward pass remembers the last set pixel, backward pass the next one.
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) tmp[y * w + x] = 1;
    }
    let next = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) next = x;
      if (next - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    let next = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) next = y;
      if (next - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

export interface PageMetrics {
  /** Share of true text pixels that came out as ink (within 1 px). */
  inkRecall: number;
  /** Share of output ink pixels with no printed content within 3 px. */
  spurious: number;
  /** Output ink area / true text area, near text: >1 fatter, <1 thinner. */
  weight: number;
  /** Share of blank-paper pixels that are exactly #FFFFFF. */
  white: number;
  /** Mean luma of blank-paper pixels. */
  paperLuma: number;
  /** Per colour region: share of its chromatic pixels still chromatic with the same hue. */
  colours: Record<string, number>;
  /** Per tint region: mean output luma of the tint (non-text) pixels. */
  tints: Record<string, number>;
  /** Share of black-text pixels that came out coloured (colour fringing). */
  textTinted: number;
}

/**
 * Compare an output page with the ground truth rendered at the same size.
 * `full` is the page as printed, `mask` its black-text mask.
 */
export interface Truth {
  /** The printed page and its black-text mask, aligned with the output. */
  full: RGBAImage;
  mask: RGBAImage;
  /** Mask of reversed (light on dark) text. */
  reversed: RGBAImage;
  /** Page position (mm) of every output pixel, x then y. */
  mm: Float32Array;
}

export function pageMetrics(out: RGBAImage, truth: Truth, doc: DocSpec): PageMetrics {
  const { full, mask } = truth;
  const { width: w, height: h } = out;
  const n = w * h;
  const O = out.data;
  const F = full.data;
  const M = mask.data;
  const text = new Uint8Array(n);
  const printed = new Uint8Array(n);
  const outInk = new Uint8Array(n);
  // Paper luma of the truth, for "printed anything" detection.
  const paper = luma(new Uint8ClampedArray(hexRgb(doc.paper)), 0);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    text[i] = M[o] < 128 ? 1 : 0;
    const [, s] = hsv(F, o);
    printed[i] = luma(F, o) < paper - 12 || s > 0.12 ? 1 : 0;
    const [, so] = hsv(O, o);
    const lo = luma(O, o);
    outInk[i] = lo < 128 || (so > 0.3 && lo < 200) ? 1 : 0;
  }
  const outNear = dilate(outInk, w, h, 1);
  const printedNear = dilate(printed, w, h, 3);
  const printedFar = dilate(printed, w, h, 6);
  const textNear = dilate(text, w, h, 3);
  let textN = 0;
  let found = 0;
  let inkN = 0;
  let spur = 0;
  let paperN = 0;
  let paperWhite = 0;
  let paperSum = 0;
  let outNearText = 0;
  let tinted = 0;
  for (let i = 0; i < n; i++) {
    if (text[i]) {
      textN++;
      if (outNear[i]) found++;
      const o = i * 4;
      if (outInk[i] && hsv(O, o)[1] > 0.25 && F[o] === F[o + 1]) tinted++;
    }
    if (outInk[i]) {
      inkN++;
      if (!printedNear[i]) spur++;
      // Only count weight where nothing but text was printed.
      if (textNear[i] && !(printed[i] && !text[i])) outNearText++;
    }
    if (!printedFar[i]) {
      const o = i * 4;
      paperN++;
      paperSum += luma(O, o);
      if (O[o] === 255 && O[o + 1] === 255 && O[o + 2] === 255) paperWhite++;
    }
  }
  const regionPixels = (r: Rect, fn: (i: number) => void) => {
    const mm = truth.mm;
    for (let i = 0; i < n; i++) {
      const x = mm[i * 2];
      const y = mm[i * 2 + 1];
      if (x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]) fn(i);
    }
  };
  const colours: Record<string, number> = {};
  for (const c of doc.colours) {
    let total = 0;
    let kept = 0;
    regionPixels(c.rect, (i) => {
      const [hf, sf, vf] = hsv(F, i * 4);
      if (sf < 0.3 || vf < 60) return;
      total++;
      const [ho, so] = hsv(O, i * 4);
      const dh = Math.min(Math.abs(ho - hf), 360 - Math.abs(ho - hf));
      if (so > 0.15 && dh < 25) kept++;
    });
    colours[c.name] = total ? kept / total : NaN;
  }
  const tints: Record<string, number> = {};
  for (const t of doc.tints) {
    let total = 0;
    let sum = 0;
    regionPixels(t.rect, (i) => {
      if (textNear[i]) return;
      total++;
      sum += luma(O, i * 4);
    });
    tints[t.name] = total ? sum / total : NaN;
  }
  return {
    inkRecall: textN ? found / textN : NaN,
    spurious: inkN ? spur / inkN : 0,
    weight: textN ? outNearText / textN : NaN,
    white: paperN ? paperWhite / paperN : NaN,
    paperLuma: paperN ? paperSum / paperN : NaN,
    colours,
    tints,
    textTinted: textN ? tinted / textN : 0,
  };
}

export interface ColourMetrics {
  /** Mean luma around dark text minus mean luma of the text itself (readability; >60 is clear). */
  textContrast: number;
  /** Mean luma of reversed (light) text minus its dark surroundings. */
  reversedContrast: number;
  /** Per coloured ground: truth and output mean colour (text excluded), share exactly white, luma spread. */
  grounds: Record<string, { truth: number[]; out: number[]; white: number; std: number }>;
  /** Per photo: luma correlation with the print, share of pure black/white (posterised), share hollowed to white. */
  photos: Record<string, { corr: number; extremes: number; hollow: number }>;
}

/** Readability of text over colour, coloured grounds and photos, for any filter. */
export function colourMetrics(out: RGBAImage, truth: Truth, doc: DocSpec): ColourMetrics {
  const { width: w, height: h } = out;
  const n = w * h;
  const O = out.data;
  const F = truth.full.data;
  const core = new Uint8Array(n);
  const rcore = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    core[i] = truth.mask.data[i * 4] < 64 ? 1 : 0;
    rcore[i] = truth.reversed.data[i * 4] < 64 ? 1 : 0;
  }
  const near = dilate(core, w, h, 2);
  const ring = dilate(core, w, h, 6);
  const rnear = dilate(rcore, w, h, 2);
  const rring = dilate(rcore, w, h, 6);
  let tIn = 0,
    tInN = 0,
    tOut = 0,
    tOutN = 0,
    rIn = 0,
    rInN = 0,
    rOut = 0,
    rOutN = 0;
  for (let i = 0; i < n; i++) {
    const l = luma(O, i * 4);
    if (core[i]) {
      tIn += l;
      tInN++;
    } else if (ring[i] && !near[i] && !rnear[i]) {
      tOut += l;
      tOutN++;
    }
    if (rcore[i]) {
      rIn += l;
      rInN++;
    } else if (rring[i] && !rnear[i] && !near[i]) {
      rOut += l;
      rOutN++;
    }
  }
  const inRect = (i: number, r: Rect) => {
    const x = truth.mm[i * 2];
    const y = truth.mm[i * 2 + 1];
    return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  };
  const grounds: ColourMetrics['grounds'] = {};
  for (const g of doc.grounds ?? []) {
    const t = [0, 0, 0];
    const o = [0, 0, 0];
    let cnt = 0,
      white = 0,
      s1 = 0,
      s2 = 0;
    for (let i = 0; i < n; i++) {
      if (ring[i] || rring[i] || !inRect(i, g.rect)) continue;
      const p = i * 4;
      for (let c = 0; c < 3; c++) {
        t[c] += F[p + c];
        o[c] += O[p + c];
      }
      if (O[p] === 255 && O[p + 1] === 255 && O[p + 2] === 255) white++;
      const l = luma(O, p);
      s1 += l;
      s2 += l * l;
      cnt++;
    }
    if (!cnt) continue;
    const m = s1 / cnt;
    grounds[g.name] = {
      truth: t.map((v) => Math.round(v / cnt)),
      out: o.map((v) => Math.round(v / cnt)),
      white: white / cnt,
      std: Math.sqrt(Math.max(0, s2 / cnt - m * m)),
    };
  }
  const photos: ColourMetrics['photos'] = {};
  for (const ph of doc.photos ?? []) {
    let cnt = 0,
      sx = 0,
      sy = 0,
      sxx = 0,
      syy = 0,
      sxy = 0,
      ext = 0,
      hollow = 0,
      dark = 0;
    for (let i = 0; i < n; i++) {
      if (!inRect(i, ph.rect)) continue;
      const a = luma(F, i * 4);
      const b = luma(O, i * 4);
      cnt++;
      sx += a;
      sy += b;
      sxx += a * a;
      syy += b * b;
      sxy += a * b;
      if ((b < 1 || b > 254) && a > 20 && a < 235) ext++;
      if (a < 200) {
        dark++;
        if (b > 245) hollow++;
      }
    }
    if (!cnt) continue;
    const cov = sxy / cnt - (sx / cnt) * (sy / cnt);
    const vx = sxx / cnt - (sx / cnt) ** 2;
    const vy = syy / cnt - (sy / cnt) ** 2;
    photos[ph.name] = {
      corr: cov / Math.sqrt(Math.max(1e-9, vx * vy)),
      extremes: ext / cnt,
      hollow: dark ? hollow / dark : 0,
    };
  }
  return {
    textContrast: tInN && tOutN ? tOut / tOutN - tIn / tInN : NaN,
    reversedContrast: rInN && rOutN ? rIn / rInN - rOut / rOutN : NaN,
    grounds,
    photos,
  };
}

/** Whether every pixel is pure black or white. */
export function binaryShare(img: RGBAImage): number {
  let bin = 0;
  const d = img.data;
  for (let o = 0; o < d.length; o += 4)
    if ((d[o] === 0 || d[o] === 255) && d[o] === d[o + 1] && d[o] === d[o + 2]) bin++;
  return bin / (d.length / 4);
}

/** A diff view: black = matched ink, red = missed text, blue = spurious ink. */
export function diffImage(out: RGBAImage, mask: RGBAImage): RGBAImage {
  const { width: w, height: h } = out;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const t = mask.data[o] < 128;
    const lo = luma(out.data, o);
    const ink = lo < 128;
    let c: [number, number, number] = [255, 255, 255];
    if (t && ink) c = [0, 0, 0];
    else if (t) c = [230, 30, 30];
    else if (ink) c = [30, 80, 230];
    else if (lo < 250) c = [200, 200, 200];
    data.set([...c, 255], o);
  }
  return { data, width: w, height: h };
}

function hexRgb(hex: string): number[] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/* ----------------------------------------------------------------- text ---- */

export function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

export function levenshtein(a: string | string[], b: string | string[]): number {
  const n = a.length;
  const m = b.length;
  let prev = new Uint32Array(m + 1).map((_, j) => j);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}

/** Character error rate (whitespace-normalised). */
export function cer(truth: string, got: string): number {
  const t = normalizeText(truth);
  const g = normalizeText(got);
  return t.length ? levenshtein([...t], [...g]) / [...t].length : 0;
}

function words(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

/** Share of truth words found anywhere (order-free) and in order (LCS). */
export function bagRecall(truth: string, got: string): number {
  return wordRecall(truth, got).bag;
}

export function wordRecall(truth: string, got: string): { bag: number; ordered: number } {
  const t = words(truth);
  const g = words(got);
  if (!t.length) return { bag: 1, ordered: 1 };
  const counts = new Map<string, number>();
  for (const w of g) counts.set(w, (counts.get(w) ?? 0) + 1);
  let bag = 0;
  for (const w of t) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      bag++;
      counts.set(w, c - 1);
    }
  }
  // LCS by DP over words.
  let prev = new Uint32Array(g.length + 1);
  let cur = new Uint32Array(g.length + 1);
  for (let i = 1; i <= t.length; i++) {
    for (let j = 1; j <= g.length; j++) {
      cur[j] = t[i - 1] === g[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return { bag: bag / t.length, ordered: prev[g.length] / t.length };
}

/** For each special character: occurrences in the truth and in the output. */
export function specialChars(
  chars: string,
  truth: string,
  got: string,
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const ch of chars) {
    const count = (s: string) => [...s].filter((c) => c === ch).length;
    out[ch] = [count(truth), count(got)];
  }
  return out;
}

/* --------------------------------------------------------------- canvas ---- */

export function canvasToRGBA(
  c: HTMLCanvasElement | OffscreenCanvas,
  w = c.width,
  h = c.height,
): RGBAImage {
  let src: HTMLCanvasElement | OffscreenCanvas = c;
  if (w !== c.width || h !== c.height) {
    const s = new OffscreenCanvas(w, h);
    const g = s.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, w, h);
    src = s;
  }
  const g = src.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  const d = g.getImageData(0, 0, w, h).data;
  return { data: new Uint8ClampedArray(d), width: w, height: h };
}

export function rgbaToCanvas(img: RGBAImage): OffscreenCanvas {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
    0,
    0,
  );
  return c;
}

/** Encode (optionally scaled to `longEdge`) as a data URL-free base64 string. */
export async function encodeImage(
  src: OffscreenCanvas | HTMLCanvasElement | ImageBitmap,
  type: 'image/png' | 'image/jpeg',
  longEdge?: number,
  quality = 0.85,
): Promise<string> {
  const scale = longEdge ? Math.min(1, longEdge / Math.max(src.width, src.height)) : 1;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  const blob = await c.convertToBlob({ type, quality });
  return blobBase64(blob);
}

export async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
