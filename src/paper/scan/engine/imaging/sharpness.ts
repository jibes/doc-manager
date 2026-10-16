import { gaussian } from './box';
import type { FloatImage } from './image';

/** Below this score a capture is treated as blurred (see `sharpness`). */
export const BLURRED_BELOW = 1.55;

/** 99.5th percentile of the absolute luma step along (dx, dy), within a region. */
function strongestStep(
  img: FloatImage,
  dx: number,
  dy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const { width: w, data } = img;
  const hist = new Uint32Array(1024);
  let n = 0;
  const offset = dy * w + dx;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const g = Math.abs(data[i + offset] - data[i - offset]);
      hist[Math.min(1023, Math.round(g * 1023))]++;
      n++;
    }
  }
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += hist[i];
    if (acc >= 0.995 * n) return i / 1023;
  }
  return 1;
}

/** Edge steps below this (luma 0..1, across two pixels) are noise, not edges. */
const EDGE_MIN = 0.04;
/** Furthest an edge's full contrast is looked for, in steps. */
const EDGE_REACH = 7;
const BINS = 256;
/** Width bins: 0..MAX_WIDTH times the sharpest possible width. */
const MAX_WIDTH = 4;

/**
 * Median width of the strongest edges along (dx, dy), relative to the
 * narrowest width that can be measured in that direction (1 = as sharp as
 * the sampling allows).
 *
 * At each edge centre (a local maximum of the step across two samples), the
 * edge's full contrast is the largest step over up to EDGE_REACH samples
 * either side; contrast over the central step is the width of the ramp. Thin
 * strokes are fine: the largest step is reached before the far side of the
 * stroke. Only edges with at least 60% of a high contrast (90th percentile)
 * count, so faint texture and noise do not, and the measure does not depend
 * on how dark the print is.
 */
function edgeWidth(
  img: FloatImage,
  dx: number,
  dy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const { width: w, data } = img;
  const step = dy * w + dx;
  const contrastHist = new Uint32Array(BINS);
  const widthHist = new Uint32Array(BINS);
  // Two passes: the contrast cut-off first, then the widths of edges above it.
  for (let pass = 0; pass < 2; pass++) {
    let cut = 0;
    if (pass === 1) {
      let total = 0;
      for (let i = 0; i < BINS; i++) total += contrastHist[i];
      if (total < 50) return 1;
      let acc = 0;
      for (let i = BINS - 1; i >= 0; i--) {
        acc += contrastHist[i];
        if (acc >= total * 0.1) {
          cut = (i / (BINS - 1)) * 0.6;
          break;
        }
      }
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const g = data[i + step] - data[i - step];
        const ag = Math.abs(g);
        if (ag < EDGE_MIN) continue;
        if (
          ag < Math.abs(data[i + 2 * step] - data[i]) ||
          ag < Math.abs(data[i] - data[i - 2 * step])
        )
          continue;
        const sign = g > 0 ? 1 : -1;
        let c = ag;
        for (let k = 2; k <= EDGE_REACH; k++) {
          const s = (data[i + k * step] - data[i - k * step]) * sign;
          if (s > c) c = s;
        }
        if (pass === 0) {
          contrastHist[Math.min(BINS - 1, Math.round(c * (BINS - 1)))]++;
        } else if (c >= cut) {
          // A perfect step spans the central difference: c / ag = 1.
          const width = c / ag;
          widthHist[Math.min(BINS - 1, Math.round((width / MAX_WIDTH) * (BINS - 1)))]++;
        }
      }
    }
  }
  let total = 0;
  for (let i = 0; i < BINS; i++) total += widthHist[i];
  let acc = 0;
  for (let i = 0; i < BINS; i++) {
    acc += widthHist[i];
    if (acc >= total / 2) return (i / (BINS - 1)) * MAX_WIDTH;
  }
  return MAX_WIDTH;
}

/**
 * Edge width (see `edgeWidth`) at which a page counts as blurred along that
 * direction; mapped onto the score so that it lands on BLURRED_BELOW. Sharp
 * pages measure 1.0-1.1 in every direction; a shake that smears text
 * enough to defeat OCR measures 1.6 or more along the shake.
 */
const SMEAR_LIMIT = 1.35;

/**
 * How sharp a photo of a page is: about 2-3 for a sharp phone photo, falling
 * towards 1 as it blurs.
 *
 * The score compares the strongest edges with those of a copy blurred a
 * little further: blurring a sharp photo weakens its edges a lot, blurring an
 * already blurred one hardly changes them. That makes it independent of
 * contrast and paper.
 *
 * Motion blur smears edges along the direction of the shake only, and a
 * smeared edge hardly changes under a little more blur, so the first measure
 * can stay high. Each direction's edge width is measured as well (see
 * `edgeWidth`), and the score is capped by the widest.
 *
 * `region` (pixel bounds) restricts it to the page, ignoring the table around.
 */
export function sharpness(
  luma: FloatImage,
  region: { x0: number; y0: number; x1: number; y1: number } = {
    x0: 0,
    y0: 0,
    x1: luma.width,
    y1: luma.height,
  },
): number {
  const x0 = Math.max(2, Math.floor(region.x0));
  const y0 = Math.max(2, Math.floor(region.y0));
  const x1 = Math.min(luma.width - 2, Math.ceil(region.x1));
  const y1 = Math.min(luma.height - 2, Math.ceil(region.y1));
  if (x1 - x0 < 16 || y1 - y0 < 16) return Infinity;
  const blurred = gaussian(luma, 1.5);
  let worst = Infinity;
  let widest = 0;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    const sharp = strongestStep(luma, dx, dy, x0, y0, x1, y1);
    const soft = strongestStep(blurred, dx, dy, x0, y0, x1, y1);
    worst = Math.min(worst, sharp / Math.max(1e-3, soft));
    // Edge widths need room for EDGE_REACH steps either side.
    const m = EDGE_REACH * Math.max(Math.abs(dx), Math.abs(dy));
    widest = Math.max(
      widest,
      edgeWidth(
        luma,
        dx,
        dy,
        Math.max(x0, m),
        Math.max(y0, m),
        Math.min(x1, luma.width - m),
        Math.min(y1, luma.height - m),
      ),
    );
  }
  return Math.min(worst, (BLURRED_BELOW * SMEAR_LIMIT) / Math.max(1, widest));
}

/** Whether a page's photo was measured as blurred at capture. */
export function isBlurred(page: { sharpness: number | null }): boolean {
  return page.sharpness !== null && page.sharpness < BLURRED_BELOW;
}
