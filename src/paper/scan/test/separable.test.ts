import { describe, expect, it } from 'vitest';
import { boxMean, gaussian, maxFilter, minFilter } from '../engine/imaging/box';
import { dilate } from '../engine/imaging/components';
import { createFloat, type FloatImage } from '../engine/imaging/image';

/*
 * The separable filters walk their vertical passes row by row for speed. These
 * straightforward column-by-column versions are what they must equal, bit for
 * bit: same sums in the same order.
 */

function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

function slidingMean(read: (i: number) => number, n: number, r: number): number[] {
  const size = 2 * r + 1;
  const line = Array.from({ length: n + 2 * r }, (_, i) => Math.fround(read(reflect(i - r, n))));
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < size; i++) sum += line[i];
  for (let i = 0; i < n; i++) {
    out.push(sum / size);
    if (i + size < line.length) sum += line[i + size] - line[i];
  }
  return out;
}

function referenceBoxMean(src: FloatImage, radius: number): Float32Array {
  const { width: w, height: h } = src;
  const r = Math.floor(radius);
  if (r === 0) return src.data.slice();
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    slidingMean((x) => src.data[y * w + x], w, r).forEach((v, x) => (tmp[y * w + x] = v));
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    slidingMean((y) => tmp[y * w + x], h, r).forEach((v, y) => (out[y * w + x] = v));
  }
  return out;
}

function referenceGaussian(src: FloatImage, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const { width: w, height: h } = src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src.data[y * w + reflect(x + k, w)] * kernel[k + r];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[reflect(y + k, h) * w + x] * kernel[k + r];
      out[y * w + x] = acc;
    }
  }
  return out;
}

function referenceExtreme(src: FloatImage, radius: number, max: boolean): Float32Array {
  const { width: w, height: h } = src;
  const r = Math.floor(radius);
  const pick = (a: number, b: number) => (max ? Math.max(a, b) : Math.min(a, b));
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = src.data[y * w + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        m = pick(m, src.data[y * w + k]);
      }
      tmp[y * w + x] = m;
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++)
        m = pick(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

function referenceDilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let dy = -r; dy <= r && !out[y * w + x]; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) {
            out[y * w + x] = 1;
            break;
          }
        }
      }
    }
  }
  return out;
}

function random(w: number, h: number, seed: number): FloatImage {
  const img = createFloat(w, h);
  let s = seed;
  for (let i = 0; i < img.data.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    img.data[i] = s / 2 ** 32;
  }
  return img;
}

/** Odd shapes on purpose: single rows and columns, and radii past the size. */
const SHAPES: [number, number, number][] = [
  [1, 1, 3],
  [1, 37, 2],
  [41, 1, 5],
  [2, 9, 7],
  [33, 70, 40],
  [97, 45, 4],
  [64, 64, 1],
];

describe('separable filters equal their column-by-column definitions', () => {
  it('boxMean', () => {
    SHAPES.forEach(([w, h, r], seed) => {
      const src = random(w, h, seed + 1);
      expect(boxMean(src, r).data).toEqual(referenceBoxMean(src, r));
    });
  });

  it('gaussian', () => {
    SHAPES.forEach(([w, h, r], seed) => {
      const src = random(w, h, seed + 11);
      for (const sigma of [0.4, r / 2.5, r]) {
        expect(gaussian(src, sigma).data).toEqual(referenceGaussian(src, sigma));
      }
    });
  });

  it('minFilter and maxFilter', () => {
    SHAPES.forEach(([w, h, r], seed) => {
      const src = random(w, h, seed + 21);
      expect(minFilter(src, r).data).toEqual(referenceExtreme(src, r, false));
      expect(maxFilter(src, r).data).toEqual(referenceExtreme(src, r, true));
    });
  });

  it('dilate', () => {
    SHAPES.forEach(([w, h, r], seed) => {
      const src = random(w, h, seed + 31);
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = src.data[i] > 0.97 ? 1 : 0;
      mask[0] = 1;
      expect(dilate(mask, w, h, r)).toEqual(referenceDilate(mask, w, h, r));
    });
  });
});
