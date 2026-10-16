import { createFloat, type FloatImage } from './image';

function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

/**
 * Mean over a (2r+1)^2 window, separable sliding sum, mirrored borders.
 * O(width * height) regardless of radius.
 */
export function boxMean(src: FloatImage, radius: number): FloatImage {
  const r = Math.max(0, Math.floor(radius));
  const { width: w, height: h } = src;
  const out = createFloat(w, h);
  if (r === 0) {
    out.data.set(src.data);
    return out;
  }
  const size = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const line = new Float32Array(w + 2 * r);

  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let i = -r; i < w + r; i++) line[i + r] = src.data[off + reflect(i, w)];
    let sum = 0;
    for (let i = 0; i < size; i++) sum += line[i];
    for (let x = 0; x < w; x++) {
      tmp[off + x] = sum / size;
      sum += line[x + size] - line[x];
    }
  }

  // Vertically, one running sum per column, advanced a whole row at a time:
  // walking down each column in turn reads memory a row apart per step. The
  // sums take the same steps in the same order as a per-column walk would.
  const rows = new Int32Array(h + 2 * r);
  for (let i = -r; i < h + r; i++) rows[i + r] = reflect(i, h) * w;
  const sums = new Float64Array(w);
  for (let i = 0; i < size; i++) {
    const off = rows[i];
    for (let x = 0; x < w; x++) sums[x] += tmp[off + x];
  }
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) o[off + x] = sums[x] / size;
    if (y === h - 1) break;
    const enter = rows[y + size];
    const leave = rows[y];
    for (let x = 0; x < w; x++) sums[x] += tmp[enter + x] - tmp[leave + x];
  }
  return out;
}

/** Local mean and standard deviation over a (2r+1)^2 window. */
export function localStats(src: FloatImage, radius: number): { mean: FloatImage; std: FloatImage } {
  const sq = createFloat(src.width, src.height);
  for (let i = 0; i < sq.data.length; i++) sq.data[i] = src.data[i] * src.data[i];
  const mean = boxMean(src, radius);
  const std = boxMean(sq, radius);
  for (let i = 0; i < std.data.length; i++) {
    const m = mean.data[i];
    const v = std.data[i] - m * m;
    std.data[i] = v > 0 ? Math.sqrt(v) : 0;
  }
  return { mean, std };
}

/**
 * Separable Gaussian with a kernel truncated at 2.5 sigma, mirrored borders.
 * Meant for small sigmas (sub-pixel to a few pixels), where box approximations
 * cannot go: three 3-wide boxes already have sigma ~1.4.
 */
export function gaussian(src: FloatImage, sigma: number): FloatImage {
  if (sigma <= 0.05) return src;
  // Beyond 2.5 sigma the weights are below 0.5%: not worth the taps.
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width: w, height: h } = src;
  const out = createFloat(w, h);
  const s = src.data;
  // Horizontally blurred rows are only needed within r of the output row, so
  // they live in a ring of 2r + 1 rows (row y in slot y mod 2r + 1) rather
  // than a second full-size image.
  const slots = 2 * r + 1;
  const ring = new Float32Array(slots * w);
  let ready = 0;
  const blurRow = (y: number) => {
    const off = y * w;
    const dst = (y % slots) * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      if (x >= r && x < w - r) {
        for (let k = -r; k <= r; k++) acc += s[off + x + k] * kernel[k + r];
      } else {
        for (let k = -r; k <= r; k++) acc += s[off + reflect(x + k, w)] * kernel[k + r];
      }
      ring[dst + x] = acc;
    }
  };
  const o = out.data;
  const taps = new Int32Array(slots);
  for (let y = 0; y < h; y++) {
    // Every row read below lies in max(0, y - r)..min(h - 1, y + r).
    for (const last = Math.min(h - 1, y + r); ready <= last; ready++) blurRow(ready);
    for (let k = -r; k <= r; k++) taps[k + r] = (reflect(y + k, h) % slots) * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = 0; k < slots; k++) acc += ring[taps[k] + x] * kernel[k];
      o[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Running minimum or maximum over a sliding window of 2r+1 samples along one
 * line, monotonic-queue algorithm: O(n) whatever the radius. `src` and `dst`
 * are read/written at `offset + i * stride`. Maxima are computed as minima of
 * negated values, so the hot loop has a single comparison.
 */
function slidingExtreme(
  src: Float32Array,
  dst: Float32Array,
  offset: number,
  stride: number,
  n: number,
  r: number,
  max: boolean,
  queue: Int32Array,
  values: Float32Array,
): void {
  for (let i = 0; i < n; i++) {
    const v = src[offset + i * stride];
    values[i] = max ? -v : v;
  }
  let head = 0;
  let tail = 0;
  const prime = Math.min(r, n);
  for (let i = 0; i < prime; i++) {
    const v = values[i];
    while (tail > head && values[queue[tail - 1]] >= v) tail--;
    queue[tail++] = i;
  }
  for (let i = 0; i < n; i++) {
    const enter = i + r;
    if (enter < n) {
      const v = values[enter];
      while (tail > head && values[queue[tail - 1]] >= v) tail--;
      queue[tail++] = enter;
    }
    while (queue[head] < i - r) head++;
    const m = values[queue[head]];
    dst[offset + i * stride] = max ? -m : m;
  }
}

/** Columns per block in `extremeFilter`'s vertical pass. */
const EXTREME_BLOCK = 32;

function extremeFilter(src: FloatImage, radius: number, max: boolean): FloatImage {
  const r = Math.max(0, Math.floor(radius));
  const { width: w, height: h } = src;
  if (r === 0) return src;
  const tmp = new Float32Array(w * h);
  const out = createFloat(w, h);
  const queue = new Int32Array(Math.max(w, h));
  const values = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) slidingExtreme(src.data, tmp, y * w, 1, w, r, max, queue, values);
  // Columns go through in blocks copied out row by row, so each column is
  // filtered contiguously instead of reading memory a row apart per step.
  const block = Math.min(w, EXTREME_BLOCK);
  const cols = new Float32Array(block * h);
  const o = out.data;
  for (let x0 = 0; x0 < w; x0 += block) {
    const n = Math.min(block, w - x0);
    for (let y = 0; y < h; y++) {
      const off = y * w + x0;
      for (let c = 0; c < n; c++) cols[c * h + y] = tmp[off + c];
    }
    for (let c = 0; c < n; c++) slidingExtreme(cols, cols, c * h, 1, h, r, max, queue, values);
    for (let y = 0; y < h; y++) {
      const off = y * w + x0;
      for (let c = 0; c < n; c++) o[off + c] = cols[c * h + y];
    }
  }
  return out;
}

/** Minimum over a (2r+1)^2 window (grey-level erosion). */
export function minFilter(src: FloatImage, radius: number): FloatImage {
  return extremeFilter(src, radius, false);
}

/** Maximum over a (2r+1)^2 window (grey-level dilation). */
export function maxFilter(src: FloatImage, radius: number): FloatImage {
  return extremeFilter(src, radius, true);
}

/** 2x2 average (or minimum). Odd edges use what exists. */
export function halve(src: FloatImage, darkest = false): FloatImage {
  const w = Math.max(1, Math.ceil(src.width / 2));
  const h = Math.max(1, Math.ceil(src.height / 2));
  const out = createFloat(w, h);
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < h; y++) {
    const y0 = 2 * y;
    const y1 = Math.min(sh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = 2 * x;
      const x1 = Math.min(sw - 1, x0 + 1);
      const a = src.data[y0 * sw + x0];
      const b = src.data[y0 * sw + x1];
      const c = src.data[y1 * sw + x0];
      const d = src.data[y1 * sw + x1];
      out.data[y * w + x] = darkest ? Math.min(a, b, c, d) : (a + b + c + d) / 4;
    }
  }
  return out;
}

/**
 * Bilinear sample of a field computed by `halve`d resolution, at full-size
 * pixel (x, y).
 */
export function sampleHalf(field: FloatImage, x: number, y: number): number {
  const fx = Math.min(field.width - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
  const fy = Math.min(field.height - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(field.width - 1, x0 + 1);
  const y1 = Math.min(field.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const d = field.data;
  const w = field.width;
  return (
    (d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) +
    (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty
  );
}

/**
 * Local "ink level": the mean of the dark class of the dark class.
 *
 * Pixels darker than their local mean are the ink and its edges; the pixels
 * darker than *their* mean are the stroke cores. Averaging those gives the
 * darkness of a typical stroke nearby, which, unlike the local minimum, is
 * not dragged to black by the few sharpening halos and compression specks a
 * phone camera sprinkles over soft grey text. Where there is no ink at all
 * the result is the local mean (i.e. paper).
 */
export function darkClassLevel(src: FloatImage, radius: number): FloatImage {
  const n = src.data.length;
  const level = boxMean(src, radius);
  let previousCount: FloatImage | null = null;
  for (let pass = 0; pass < 2; pass++) {
    const masked = createFloat(src.width, src.height);
    const count = createFloat(src.width, src.height);
    for (let i = 0; i < n; i++) {
      if (src.data[i] < level.data[i]) {
        masked.data[i] = src.data[i];
        count.data[i] = 1;
      }
    }
    const sum = boxMean(masked, radius);
    const cnt = boxMean(count, radius);
    for (let i = 0; i < n; i++) {
      if (cnt.data[i] <= 1e-4) continue;
      // If the second pass keeps only a sliver of the first pass's pixels, it
      // is looking at outliers (specks in otherwise even strokes): stop there.
      if (previousCount && cnt.data[i] < 0.2 * previousCount.data[i]) continue;
      level.data[i] = sum.data[i] / cnt.data[i];
    }
    previousCount = cnt;
  }
  return level;
}
