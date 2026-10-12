import { boxMean, maxFilter, minFilter } from './box';
import { dilate, labelComponents } from './components';
import { createFloat, createRGBA, downsampleBox, type RGBAImage } from './image';

/**
 * Paper-colour estimate on a coarse grid, one RGB sample per block (0..255).
 */
export interface PaperGrid {
  cols: number;
  rows: number;
  /** Block size in source pixels. */
  block: number;
  /** cols * rows * 3 */
  rgb: Float32Array;
}

const BLOCKS_ON_LONG_EDGE = 40;
const SAMPLES_PER_BLOCK_EDGE = 24;
const PAPER_QUANTILE = 0.9;
/** Gain cap, so a deep shadow is lifted without turning sensor noise into speckle. */
const MAX_GAIN = 5;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Estimate the paper colour across the page.
 *
 * Each block reports the mean colour of its brightest 10% of pixels, sampled
 * at full resolution so the gaps between lines of text are seen as paper.
 * Blocks that are not paper (photos, logos, a strip of table at the edge)
 * stand out as darker or differently coloured than their neighbourhood and are
 * dropped, then the holes are filled by diffusion from the surrounding paper.
 *
 * Unlike divide-by-blur, ink never enters the estimate, so text does not get a
 * grey halo and dense paragraphs do not darken the paper around them.
 */
export function estimatePaper(src: RGBAImage): PaperGrid {
  const { width, height, data } = src;
  const block = Math.max(8, Math.ceil(Math.max(width, height) / BLOCKS_ON_LONG_EDGE));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const n = cols * rows;
  const rgb = new Float32Array(n * 3);
  const luma = new Float32Array(n);
  const step = Math.max(1, Math.floor(block / SAMPLES_PER_BLOCK_EDGE));

  // Per block: a luma histogram of strided samples gives the brightest-10%
  // cut-off without sorting; then average the colour of the samples above it.
  const hist = new Uint32Array(256);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      hist.fill(0);
      let samples = 0;
      const x1 = Math.min(width, (bx + 1) * block);
      const y1 = Math.min(height, (by + 1) * block);
      for (let y = by * block; y < y1; y += step) {
        for (let x = bx * block; x < x1; x += step) {
          const p = (y * width + x) * 4;
          hist[(54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2]) >> 8]++;
          samples++;
        }
      }
      let threshold = 255;
      for (let acc = 0, target = samples * (1 - PAPER_QUANTILE); threshold > 0; threshold--) {
        acc += hist[threshold];
        if (acc >= target) break;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = by * block; y < y1; y += step) {
        for (let x = bx * block; x < x1; x += step) {
          const p = (y * width + x) * 4;
          if ((54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2]) >> 8 < threshold) continue;
          r += data[p];
          g += data[p + 1];
          b += data[p + 2];
          count++;
        }
      }
      const k = by * cols + bx;
      rgb[k * 3] = r / count;
      rgb[k * 3 + 1] = g / count;
      rgb[k * 3 + 2] = b / count;
      luma[k] = threshold;
    }
  }

  // Reject blocks that are much darker than, or a different colour from, their
  // neighbourhood. Two passes: the second uses only blocks the first accepted.
  const valid = new Uint8Array(n).fill(1);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(n);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const near: number[] = [];
        const nr: number[] = [];
        const ng: number[] = [];
        const nb: number[] = [];
        for (let y = Math.max(0, by - R); y <= Math.min(rows - 1, by + R); y++) {
          for (let x = Math.max(0, bx - R); x <= Math.min(cols - 1, bx + R); x++) {
            const k = y * cols + x;
            if (!valid[k]) continue;
            near.push(luma[k]);
            nr.push(rgb[k * 3]);
            ng.push(rgb[k * 3 + 1]);
            nb.push(rgb[k * 3 + 2]);
          }
        }
        const k = by * cols + bx;
        if (near.length < 3) {
          next[k] = valid[k];
          continue;
        }
        const ml = median(near);
        const dr = rgb[k * 3] / Math.max(1, median(nr));
        const dg = rgb[k * 3 + 1] / Math.max(1, median(ng));
        const db = rgb[k * 3 + 2] / Math.max(1, median(nb));
        const tint = Math.max(dr, dg, db) - Math.min(dr, dg, db);
        next[k] = luma[k] >= 0.85 * ml && tint < 0.12 ? 1 : 0;
      }
    }
    valid.set(next);
  }

  // Fall back to the brightest blocks if the filter rejected nearly everything.
  let validCount = 0;
  for (let k = 0; k < n; k++) validCount += valid[k];
  if (validCount < Math.max(1, n * 0.05)) {
    const cutoff = [...luma].sort((a, b) => b - a)[Math.max(0, Math.floor(n * 0.2) - 1)];
    for (let k = 0; k < n; k++) valid[k] = luma[k] >= cutoff ? 1 : 0;
  }

  // Fill rejected blocks by diffusion (Jacobi iterations of the Laplace equation).
  let mean = [0, 0, 0];
  let m = 0;
  for (let k = 0; k < n; k++) {
    if (!valid[k]) continue;
    mean = [mean[0] + rgb[k * 3], mean[1] + rgb[k * 3 + 1], mean[2] + rgb[k * 3 + 2]];
    m++;
  }
  for (let k = 0; k < n; k++) {
    if (valid[k]) continue;
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = mean[c] / m;
  }
  const iterations = 2 * Math.max(cols, rows);
  const buf = new Float32Array(rgb);
  for (let it = 0; it < iterations; it++) {
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const k = by * cols + bx;
        if (valid[k]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let cnt = 0;
          if (bx > 0) {
            s += rgb[(k - 1) * 3 + c];
            cnt++;
          }
          if (bx < cols - 1) {
            s += rgb[(k + 1) * 3 + c];
            cnt++;
          }
          if (by > 0) {
            s += rgb[(k - cols) * 3 + c];
            cnt++;
          }
          if (by < rows - 1) {
            s += rgb[(k + cols) * 3 + c];
            cnt++;
          }
          buf[k * 3 + c] = s / cnt;
        }
      }
    }
    rgb.set(buf);
  }

  // One light smoothing pass so block boundaries never show up as steps.
  const smooth = new Float32Array(rgb.length);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let cnt = 0;
        for (let y = Math.max(0, by - 1); y <= Math.min(rows - 1, by + 1); y++) {
          for (let x = Math.max(0, bx - 1); x <= Math.min(cols - 1, bx + 1); x++) {
            s += rgb[(y * cols + x) * 3 + c];
            cnt++;
          }
        }
        smooth[(by * cols + bx) * 3 + c] = s / cnt;
      }
    }
  }

  return { cols, rows, block, rgb: smooth };
}

/** Long edge of the working copy the paper analysis runs on. */
const SURFACE_EDGE = 1000;
/** Closing radius on the working copy, as a fraction of its long edge. */
const SURFACE_RADIUS = 0.004;
/** Relative step (per channel) across 2 px of the closed page that can be a printed boundary. */
const EDGE_STEP = 0.05;
/**
 * Share of the step over 6 px that must already happen within the middle
 * 2 px. A printed edge is as sharp as the lens; a shadow edge or a lighting
 * gradient is spread over many pixels.
 */
const EDGE_CRISP = 0.6;
/** Share of the page a region needs to be a candidate for the paper. */
const PAPER_MIN_SHARE = 0.02;
/** Largest colour difference (relative) between a shadowed area and the paper. */
const SHADOW_TINT = 0.08;
/** Largest relative spread of brightness within a shadowed area. */
const SHADOW_SPREAD = 0.5;
/** Smoothing window for the paper model regions are compared against (fraction of the long edge). */
const MODEL_WINDOW = 0.05;
/** Width of the border strip in which a region is taken for a grazed table edge. */
const BORDER_BAND = 0.012;
/**
 * A content area is one flat colour when FLAT_SHARE of it lies within
 * FLAT_SPREAD (relative) of its most common brightness, in a histogram of
 * FLAT_BINS steps from black to paper white.
 */
const FLAT_BINS = 128;
const FLAT_SPREAD = 0.03;
const FLAT_SHARE = 0.7;
/** Non-paper regions smaller than this (fraction of the long edge, squared) are ink, not areas. */
const REGION_EDGE = 0.012;

/** Region classes of `PaperAnalysis.regions`. */
export const PAPER = 0;
/** A light, neutral, flat fill (grey form field, pale tint). */
export const TINT = 1;
/** A photo, a colour area or a dark area: content in its own right. */
export const PICTURE = 2;

export interface PaperAnalysis {
  /** Paper colour across the page (on the working copy; `block` is its scale). */
  surface: PaperGrid;
  /** Per working-copy pixel (`surface.cols` x `surface.rows`): PAPER, TINT or PICTURE. */
  regions: Uint8Array;
  /** Per working-copy pixel: which content area it belongs to (0 = none). */
  regionIds: Int32Array;
  /** Per content area: 1 if it is one flat colour (a panel, band or tint), not a photo. */
  flat: Uint8Array;
  /** Mean photographed colour of the paper, 0..255. */
  paper: [number, number, number];
}

/**
 * Fill the pixels with weight 0 smoothly from those with weight 1 (push-pull:
 * a weighted image pyramid, then each level fills its holes from the
 * bilinearly upsampled level above). O(n). Mutates and returns `planes`.
 */
export function pushPull(
  planes: Float32Array<ArrayBuffer>[],
  weight: Float32Array,
  width: number,
  height: number,
): Float32Array<ArrayBuffer>[] {
  if (width <= 1 && height <= 1) return planes;
  const w2 = Math.ceil(width / 2);
  const h2 = Math.ceil(height / 2);
  const cw = new Float32Array(w2 * h2);
  const cp = planes.map(() => new Float32Array(w2 * h2));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const wt = weight[i];
      if (wt <= 0) continue;
      const k = (y >> 1) * w2 + (x >> 1);
      cw[k] += wt;
      for (let c = 0; c < planes.length; c++) cp[c][k] += planes[c][i] * wt;
    }
  }
  for (let k = 0; k < cw.length; k++) {
    if (cw[k] > 0) for (let c = 0; c < planes.length; c++) cp[c][k] /= cw[k];
    cw[k] = Math.min(1, cw[k]);
  }
  pushPull(cp, cw, w2, h2);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(h2 - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const wt = Math.min(1, weight[i]);
      if (wt >= 1) continue;
      const gx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(w2 - 1, x0 + 1);
      const tx = gx - x0;
      for (let c = 0; c < planes.length; c++) {
        const p = cp[c];
        const up =
          (p[y0 * w2 + x0] * (1 - tx) + p[y0 * w2 + x1] * tx) * (1 - ty) +
          (p[y1 * w2 + x0] * (1 - tx) + p[y1 * w2 + x1] * tx) * ty;
        planes[c][i] = wt * planes[c][i] + (1 - wt) * up;
      }
    }
  }
  return planes;
}

/**
 * Mean of `planes` over a window, counting only pixels with `mask` set; holes
 * filled by push-pull. The result is smooth on the scale of `radius`, so it is
 * computed on a grid a quarter of the radius apart and interpolated back.
 */
function maskedSmooth(
  planes: Float32Array<ArrayBuffer>[],
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Float32Array<ArrayBuffer>[] {
  const step = Math.max(1, Math.round(radius / 4));
  const cw = Math.ceil(width / step);
  const ch = Math.ceil(height / step);
  const count = createFloat(cw, ch);
  const sums = planes.map(() => createFloat(cw, ch));
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / step) * cw;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const k = row + Math.floor(x / step);
      count.data[k]++;
      for (let c = 0; c < planes.length; c++) sums[c].data[k] += planes[c][i];
    }
  }
  const r = Math.max(1, Math.round(radius / step));
  const weight = boxMean(count, r).data;
  const coarse = sums.map((plane) => {
    const sum = boxMean(plane, r).data;
    for (let k = 0; k < sum.length; k++) sum[k] = weight[k] > 1e-3 ? sum[k] / weight[k] : 0;
    return sum;
  });
  const known = new Float32Array(weight.length);
  for (let k = 0; k < known.length; k++) known[k] = weight[k] > 1e-3 ? 1 : 0;
  pushPull(coarse, known, cw, ch);
  return coarse.map((plane) => {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const gy = Math.min(ch - 1, Math.max(0, (y + 0.5) / step - 0.5));
      const y0 = Math.floor(gy);
      const y1 = Math.min(ch - 1, y0 + 1);
      const ty = gy - y0;
      for (let x = 0; x < width; x++) {
        const gx = Math.min(cw - 1, Math.max(0, (x + 0.5) / step - 0.5));
        const x0 = Math.floor(gx);
        const x1 = Math.min(cw - 1, x0 + 1);
        const tx = gx - x0;
        out[y * width + x] =
          (plane[y0 * cw + x0] * (1 - tx) + plane[y0 * cw + x1] * tx) * (1 - ty) +
          (plane[y1 * cw + x0] * (1 - tx) + plane[y1 * cw + x1] * tx) * ty;
      }
    }
    return out;
  });
}

/**
 * Whether the values at `a1`/`b1` (two pixels apart) differ by a large step
 * that is complete there, rather than part of a gradual change seen between
 * `a3` and `b3` (six pixels apart).
 */
function crispStep(v: Float32Array, a1: number, b1: number, a3: number, b3: number): boolean {
  const lo = v[a1];
  const hi = v[b1];
  const near = Math.abs(hi - lo);
  if (near < EDGE_STEP * Math.max(lo, hi, 16)) return false;
  return near >= EDGE_CRISP * Math.abs(v[b3] - v[a3]);
}

/**
 * Find the paper and its shading, and the areas of the page that are not
 * paper (photos, colour panels, bands, tints).
 *
 * On a ~1200 px working copy, each channel gets a morphological closing (a
 * maximum filter, then a minimum filter): the maximum wipes out ink thinner
 * than the window, the minimum gives back the paper's own shading. What is
 * left is the paper, with its wrinkles and shadows, plus anything printed
 * larger than the window.
 *
 * Shading and printed areas differ in their edges: a shadow, a crease's
 * slope or a lighting gradient changes gradually, while a printed area ends
 * as sharply as the lens draws it. Crisp edges cut the closed page into
 * regions. The paper is the bright, nearly neutral region covering a good
 * share of the page (on a flyer, its light panel rather than its coloured
 * ground). Other regions with the paper's colour where they are (paper on
 * the far side of a band, white lettering) are paper too; everything else is
 * content, and the paper surface under it is filled in smoothly from the
 * paper around it. Dividing by that surface removes shadows and colour casts
 * from the paper without flattening photos and colour areas into it.
 */
export function analysePaper(src: RGBAImage): PaperAnalysis {
  const factor = Math.max(1, Math.round(Math.max(src.width, src.height) / SURFACE_EDGE));
  const small = downsampleBox(src, factor);
  const { width: w, height: h } = small;
  const n = w * h;
  const long = Math.max(w, h);
  const radius = Math.max(2, Math.round(long * SURFACE_RADIUS));
  const closed = [0, 1, 2].map((c) => {
    const plane = createFloat(w, h);
    for (let i = 0, p = c; i < n; i++, p += 4) plane.data[i] = small.data[p];
    return minFilter(maxFilter(plane, radius), radius).data;
  });

  // Crisp steps in any channel, right up to the border (a band that runs off
  // the page must still be cut off from the paper there).
  const edge = new Uint8Array(n);
  const [c0, c1, c2] = closed;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up1 = Math.max(0, y - 1) * w;
    const dn1 = Math.min(h - 1, y + 1) * w;
    const up3 = Math.max(0, y - 3) * w;
    const dn3 = Math.min(h - 1, y + 3) * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l1 = row + Math.max(0, x - 1);
      const r1 = row + Math.min(w - 1, x + 1);
      const l3 = row + Math.max(0, x - 3);
      const r3 = row + Math.min(w - 1, x + 3);
      if (
        crispStep(c0, l1, r1, l3, r3) ||
        crispStep(c1, l1, r1, l3, r3) ||
        crispStep(c2, l1, r1, l3, r3) ||
        crispStep(c0, up1 + x, dn1 + x, up3 + x, dn3 + x) ||
        crispStep(c1, up1 + x, dn1 + x, up3 + x, dn3 + x) ||
        crispStep(c2, up1 + x, dn1 + x, up3 + x, dn3 + x)
      ) {
        edge[i] = 1;
      }
    }
  }
  const open = dilate(edge, w, h, 1);
  for (let i = 0; i < n; i++) open[i] ^= 1;
  const { labels, areas } = labelComponents(open, w, h);

  // Per region: mean colour and fine texture (how much neighbouring pixels
  // differ, in absolute terms: sensor noise does not shrink in a shadow, so
  // relative to the darker paper there it would look rougher than it is).
  const m0 = areas.length;
  const sums = new Float64Array(m0 * 3);
  const rough = new Float64Array(m0);
  const L = (i: number) => 0.2126 * closed[0][i] + 0.7152 * closed[1][i] + 0.0722 * closed[2][i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (!l) continue;
      sums[l * 3] += closed[0][i];
      sums[l * 3 + 1] += closed[1][i];
      sums[l * 3 + 2] += closed[2][i];
      if (x + 1 < w && y + 1 < h && labels[i + 1] === l && labels[i + w] === l) {
        const v = L(i);
        rough[l] += Math.abs(L(i + 1) - v) + Math.abs(L(i + w) - v);
      }
    }
  }
  const mean = (l: number, c: number) => sums[l * 3 + c] / areas[l];

  // The paper: bright and nearly neutral (pastel at most), and of the regions
  // that qualify, the largest: a pale panel must not beat the page around it.
  let paperLabel = 0;
  for (const share of [PAPER_MIN_SHARE, PAPER_MIN_SHARE / 10]) {
    const score = new Float64Array(m0).fill(-Infinity);
    let best = -Infinity;
    for (let l = 1; l < m0; l++) {
      if (areas[l] < n * share) continue;
      const r = mean(l, 0);
      const g = mean(l, 1);
      const b = mean(l, 2);
      const max = Math.max(r, g, b, 1);
      score[l] =
        (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 - (0.5 * (max - Math.min(r, g, b))) / max;
      best = Math.max(best, score[l]);
    }
    for (let l = 1; l < m0; l++) {
      if (score[l] >= best - 0.1 && (!paperLabel || areas[l] > areas[paperLabel])) paperLabel = l;
    }
    if (paperLabel) break;
  }

  const isPaper = new Uint8Array(n);
  const paperRegion = new Uint8Array(m0);
  if (paperLabel) {
    paperRegion[paperLabel] = 1;
    // A shadow with a hard edge (direct light) is cut off by crisp edges too.
    // It darkens the paper evenly: every pixel keeps the paper's colour, and
    // its brightness is uniform and smooth. A printed area differs in colour
    // somewhere, or in texture. (A flat neutral grey print is
    // indistinguishable from a shadow and is treated as one, which only
    // means it goes white with the paper.)
    const pr = Math.max(1, mean(paperLabel, 0));
    const pg = Math.max(1, mean(paperLabel, 1));
    const pb = Math.max(1, mean(paperLabel, 2));
    const tintSum = new Float64Array(m0);
    const lumaSum = new Float64Array(m0);
    const luma2Sum = new Float64Array(m0);
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (!l) continue;
      const q0 = closed[0][i] / pr;
      const q1 = closed[1][i] / pg;
      const q2 = closed[2][i] / pb;
      const q = 0.2126 * q0 + 0.7152 * q1 + 0.0722 * q2;
      tintSum[l] += (Math.max(q0, q1, q2) - Math.min(q0, q1, q2)) / Math.max(0.05, q);
      lumaSum[l] += q;
      luma2Sum[l] += q * q;
    }
    const paperRough = rough[paperLabel] / areas[paperLabel];
    for (let l = 1; l < m0; l++) {
      if (l === paperLabel || areas[l] < n * PAPER_MIN_SHARE * 0.25) continue;
      const q = lumaSum[l] / areas[l];
      const spread = Math.sqrt(Math.max(0, luma2Sum[l] / areas[l] - q * q)) / Math.max(0.05, q);
      const smooth = rough[l] / areas[l] < Math.max(2, 2.5 * paperRough);
      if (
        q > 0.2 &&
        q < 0.92 &&
        tintSum[l] / areas[l] < SHADOW_TINT &&
        spread < SHADOW_SPREAD &&
        smooth
      ) {
        paperRegion[l] = 1;
      }
    }
    for (let i = 0; i < n; i++) isPaper[i] = paperRegion[labels[i]];
  } else {
    // No paper in sight (a full-bleed photo): only its brightest part.
    const luma = new Float32Array(n);
    for (let i = 0; i < n; i++) luma[i] = L(i);
    const cut = [...luma].sort((a, b) => b - a)[Math.floor(n * 0.01)];
    for (let i = 0; i < n; i++) isPaper[i] = luma[i] >= cut ? 1 : 0;
  }

  // A smooth model of the paper's colour everywhere, to recognise more paper
  // (paper on the far side of a band, white lettering on a dark ground) and
  // to catch coloured content that leaked into the paper through a gap.
  const model = maskedSmooth(closed, isPaper, w, h, Math.max(4, Math.round(long * MODEL_WINDOW)));
  const lumaSum = new Float64Array(m0);
  const tintSum = new Float64Array(m0);
  const pixelRatio = new Float32Array(n);
  const pixelTint = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q0 = closed[0][i] / Math.max(1, model[0][i]);
    const q1 = closed[1][i] / Math.max(1, model[1][i]);
    const q2 = closed[2][i] / Math.max(1, model[2][i]);
    const q = 0.2126 * q0 + 0.7152 * q1 + 0.0722 * q2;
    const tint = (Math.max(q0, q1, q2) - Math.min(q0, q1, q2)) / Math.max(0.05, q);
    pixelRatio[i] = q;
    pixelTint[i] = tint;
    lumaSum[labels[i]] += q;
    tintSum[labels[i]] += tint;
  }
  for (let l = 1; l < m0; l++) {
    const q = lumaSum[l] / areas[l];
    if (q > 0.9 && q < 1.12 && tintSum[l] / areas[l] < 0.06) paperRegion[l] = 1;
  }
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l) {
      isPaper[i] = paperRegion[l] && pixelTint[i] < 0.12 ? 1 : 0;
    } else {
      // Edge pixels: the side of the edge that matches the paper is paper.
      isPaper[i] = pixelRatio[i] > 0.94 && pixelTint[i] < 0.05 ? 1 : 0;
    }
  }

  // The surface: the closed page on paper, filled in under everything else.
  const weight = new Float32Array(n);
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    weight[i] = isPaper[i];
    if (!isPaper[i]) continue;
    pr += closed[0][i];
    pg += closed[1][i];
    pb += closed[2][i];
    count++;
  }
  const filled = pushPull(
    closed.map((p) => new Float32Array(p)),
    weight,
    w,
    h,
  );
  // Smoothed, but first eroded a little more than the smoothing reaches: at
  // a hard shadow edge the surface then steps on the lit side, where too dark
  // a surface only clips paper to white, instead of on the shadowed side,
  // where too bright a surface would draw a dark line along the edge.
  const planes = filled.map((p) => boxMean(minFilter({ data: p, width: w, height: h }, 2), 1).data);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = planes[0][i];
    rgb[i * 3 + 1] = planes[1][i];
    rgb[i * 3 + 2] = planes[2][i];
  }

  // Classify the content areas by how they look once flattened.
  // An opening first: thin slivers along an edge (a shadow's rim) are not areas.
  const opening = Math.max(1, radius);
  const eroded = dilate(isPaper, w, h, opening);
  for (let i = 0; i < n; i++) eroded[i] ^= 1;
  const content = dilate(eroded, w, h, opening);
  for (let i = 0; i < n; i++) if (isPaper[i]) content[i] = 0;
  const areaLabels = labelComponents(content, w, h);
  const minArea = Math.max(16, Math.round((long * REGION_EDGE) ** 2));
  const m = areaLabels.areas.length;
  const sumL = new Float64Array(m);
  const sumL2 = new Float64Array(m);
  const sumS = new Float64Array(m);
  // Flatness on the closed page, where dark lettering is wiped out: a
  // histogram of brightness relative to the paper per area. A colour panel
  // or band is one flat colour with some lettering on it, so most of it sits
  // in one narrow peak; a photo or a gradient spreads out.
  const slot = new Int32Array(m).fill(-1);
  let slots = 0;
  for (let l = 1; l < m; l++) if (areaLabels.areas[l] >= minArea) slot[l] = slots++;
  const hist = new Uint32Array(slots * FLAT_BINS);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const l = areaLabels.labels[i];
    if (!l || areaLabels.areas[l] < minArea) continue;
    const c =
      L(i) / Math.max(1, 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]);
    hist[slot[l] * FLAT_BINS + Math.min(FLAT_BINS - 1, Math.floor(c * (FLAT_BINS - 1)))]++;
    const r = Math.min(1, small.data[p] / Math.max(1, rgb[i * 3]));
    const g = Math.min(1, small.data[p + 1] / Math.max(1, rgb[i * 3 + 1]));
    const b = Math.min(1, small.data[p + 2] / Math.max(1, rgb[i * 3 + 2]));
    const max = Math.max(r, g, b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumL[l] += y;
    sumL2[l] += y * y;
    sumS[l] += max > 0.02 ? (max - Math.min(r, g, b)) / max : 0;
  }
  // A strip along the border is table or background the crop grazed.
  const band = Math.max(2, Math.round(long * BORDER_BAND));
  const inBand = new Float64Array(m);
  const touches = new Uint8Array(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = areaLabels.labels[y * w + x];
      if (!l) continue;
      if (y < band || y >= h - band || x < band || x >= w - band) inBand[l]++;
      if (y === 0 || x === 0 || y === h - 1 || x === w - 1) touches[l] = 1;
    }
  }
  const kind = new Uint8Array(m);
  const flat = new Uint8Array(m);
  for (let l = 1; l < m; l++) {
    const a = areaLabels.areas[l];
    if (a < minArea || (touches[l] && inBand[l] >= 0.9 * a)) continue;
    const mean = sumL[l] / a;
    const std = Math.sqrt(Math.max(0, sumL2[l] / a - mean * mean));
    const sat = sumS[l] / a;
    kind[l] = sat > 0.06 || mean < 0.75 || std > 0.1 ? PICTURE : TINT;
    const base = slot[l] * FLAT_BINS;
    let peak = 0;
    for (let k = 1; k < FLAT_BINS; k++) if (hist[base + k] > hist[base + peak]) peak = k;
    const width = Math.max(2, Math.round(peak * FLAT_SPREAD));
    let near = 0;
    for (let k = Math.max(0, peak - width); k <= Math.min(FLAT_BINS - 1, peak + width); k++) {
      near += hist[base + k];
    }
    flat[l] = near >= FLAT_SHARE * a ? 1 : 0;
  }
  const regions = new Uint8Array(n);
  const regionIds = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const l = areaLabels.labels[i];
    regions[i] = kind[l];
    if (kind[l]) regionIds[i] = l;
  }

  return {
    surface: { cols: w, rows: h, block: factor, rgb },
    regions,
    regionIds,
    flat,
    paper: count ? [pr / count, pg / count, pb / count] : [255, 255, 255],
  };
}

/** The paper-colour surface alone; see `analysePaper`. */
export function estimatePaperSurface(src: RGBAImage): PaperGrid {
  return analysePaper(src).surface;
}

/**
 * Divide every pixel by the interpolated paper colour, so paper lands on 255
 * and everything else keeps its contrast relative to the paper. Per channel,
 * which also removes a colour cast from warm light or yellowed paper.
 */
export function flattenPaper(
  src: RGBAImage,
  grid: PaperGrid = estimatePaperSurface(src),
): RGBAImage {
  const { width, height, data } = src;
  const { cols, rows, block, rgb } = grid;
  const out = createRGBA(width, height);
  const od = out.data;
  const row = new Float32Array(cols * 3);

  for (let y = 0; y < height; y++) {
    // Block centres sit at (k + 0.5) * block; interpolate between them.
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = gy - y0;
    for (let i = 0; i < cols * 3; i++) {
      row[i] = rgb[y0 * cols * 3 + i] * (1 - ty) + rgb[y1 * cols * 3 + i] * ty;
    }
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = gx - x0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const bg = row[x0 * 3 + c] * (1 - tx) + row[x1 * 3 + c] * tx;
        const gain = Math.min(MAX_GAIN, 255 / Math.max(1, bg));
        od[p + c] = data[p + c] * gain;
      }
      od[p + 3] = 255;
    }
  }
  return out;
}
