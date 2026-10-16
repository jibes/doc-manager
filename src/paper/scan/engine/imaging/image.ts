/**
 * Raster types shared by every stage. Everything here is plain typed arrays so
 * the same code runs in a Worker, in Node tests, and on the main thread.
 */

/** 8-bit RGBA, row-major. The buffer is an ArrayBuffer so it can be transferred. */
export interface RGBAImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Single-channel float image, nominally 0..1 (values may overshoot during processing). */
export interface FloatImage {
  data: Float32Array<ArrayBuffer>;
  width: number;
  height: number;
}

export type Point = readonly [number, number];

/** Corners ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

export function createRGBA(width: number, height: number): RGBAImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function createFloat(width: number, height: number): FloatImage {
  return { data: new Float32Array(width * height), width, height };
}

/** Rec. 709 luma as 0..1 from 8-bit RGB. */
export function luma01(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function toLuma(image: RGBAImage): FloatImage {
  const out = createFloat(image.width, image.height);
  const d = image.data;
  for (let i = 0, p = 0; i < out.data.length; i++, p += 4) {
    out.data[i] = luma01(d[p], d[p + 1], d[p + 2]);
  }
  return out;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Rotate by a multiple of 90 degrees clockwise. */
export function rotateRGBA(image: RGBAImage, quarterTurns: number): RGBAImage {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (turns === 0) return image;
  const { width: w, height: h, data } = image;
  const outW = turns === 2 ? w : h;
  const outH = turns === 2 ? h : w;
  const out = createRGBA(outW, outH);
  const o32 = new Uint32Array(out.data.buffer);
  const s32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      o32[ny * outW + nx] = s32[y * w + x];
    }
  }
  return out;
}

/**
 * Average `factor x factorY` blocks (square unless `factorY` is given).
 * Partial edge blocks average what exists.
 */
export function downsampleBox(image: RGBAImage, factor: number, factorY = factor): RGBAImage {
  const f = Math.max(1, Math.floor(factor));
  const fy = Math.max(1, Math.floor(factorY));
  if (f === 1 && fy === 1) return image;
  const width = Math.max(1, Math.ceil(image.width / f));
  const height = Math.max(1, Math.ceil(image.height / fy));
  const out = createRGBA(width, height);
  const sd = image.data;
  const sw = image.width;
  for (let y = 0; y < height; y++) {
    const y0 = y * fy;
    const y1 = Math.min(image.height, y0 + fy);
    for (let x = 0; x < width; x++) {
      const x0 = x * f;
      const x1 = Math.min(sw, x0 + f);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0, p = (yy * sw + x0) * 4; xx < x1; xx++, p += 4) {
          r += sd[p];
          g += sd[p + 1];
          b += sd[p + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}
