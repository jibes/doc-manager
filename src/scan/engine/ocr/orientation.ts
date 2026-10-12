/**
 * Page orientation from text, for the OCR worker. Pure functions, so they are
 * unit-tested in Node.
 *
 * Two questions, answered with different evidence:
 * - Sideways (90°/270°) or not: printed lines are much longer than they are
 *   tall, so the detector's text regions on a sideways page are tall and
 *   narrow. That is a geometric fact about the page and needs no reading.
 * - Upside down or not: the recogniser reads a handful of the longest lines
 *   both ways up; upright text is read with clearly higher confidence.
 *
 * A page is only turned on strong evidence of both kinds: a wrongly turned
 * page is worse than one left as photographed.
 */
import { labelComponents } from '../imaging/components';
import type { TextBox } from './paddle';

/** Text-region area (detector pixels) on regions clearly wider than tall, and clearly taller than wide. */
export interface LineAxes {
  wide: number;
  tall: number;
  /** Number of clearly tall regions. */
  tallCount: number;
  wideCount: number;
}

/** A region counts as a line along an axis when it is this many times longer than thick. */
const LINE_ELONGATION = 2.5;

/** Measure the shape of the text regions in the detector's probability map. */
export function lineAxes(
  prob: Float32Array,
  width: number,
  height: number,
  threshold = 0.3,
): LineAxes {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > threshold ? 1 : 0;
  const { labels, areas } = labelComponents(mask, width, height);
  const n = areas.length;
  const minX = new Int32Array(n).fill(width);
  const minY = new Int32Array(n).fill(height);
  const maxX = new Int32Array(n).fill(-1);
  const maxY = new Int32Array(n).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!l) continue;
      if (x < minX[l]) minX[l] = x;
      if (x > maxX[l]) maxX[l] = x;
      if (y < minY[l]) minY[l] = y;
      if (y > maxY[l]) maxY[l] = y;
    }
  }
  const out: LineAxes = { wide: 0, tall: 0, tallCount: 0, wideCount: 0 };
  for (let l = 1; l < n; l++) {
    if (!areas[l]) continue;
    const w = maxX[l] - minX[l] + 1;
    const h = maxY[l] - minY[l] + 1;
    if (w >= LINE_ELONGATION * h) {
      out.wide += areas[l];
      out.wideCount++;
    } else if (h >= LINE_ELONGATION * w) {
      out.tall += areas[l];
      out.tallCount++;
    }
  }
  return out;
}

/** Whether the text runs up and down the page: many tall lines, few wide ones. */
export function isSideways(axes: LineAxes): boolean {
  return axes.tallCount >= 4 && axes.tall > 4 * axes.wide;
}

/** A text box in an image rotated by 180° (`width` × `height` is the image size). */
export function flipBox(box: TextBox, width: number, height: number): TextBox {
  const mid = (box.y0 + box.y1) / 2;
  const yl = box.yl ?? mid;
  const yr = box.yr ?? mid;
  return {
    x0: width - box.x1,
    x1: width - box.x0,
    y0: height - box.y1,
    y1: height - box.y0,
    score: box.score,
    // The line's left end is the old right end.
    yl: height - yr,
    yr: height - yl,
    height: box.height ?? box.y1 - box.y0,
  };
}

/** The lines worth reading both ways up: the longest, at most `count`. */
export function sampleLines(boxes: TextBox[], count = 8): TextBox[] {
  return [...boxes]
    .filter((b) => b.x1 - b.x0 >= 4 * (b.y1 - b.y0))
    .sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))
    .slice(0, count);
}

/** Lines read in both orientations needed before a page may be flipped. */
const MIN_SAMPLES = 3;
/** Mean confidence gain needed to flip. */
const MIN_GAIN = 0.15;
/** Share of the sampled lines that must read better flipped. */
const MIN_AGREEMENT = 0.75;
/** Below this mean confidence either way, the lines are not readable text. */
const MIN_READABLE = 0.6;

/**
 * Whether the text is upside down, from the recogniser's confidence on the
 * same lines read as they are (`asIs`) and turned by 180° (`turned`).
 */
export function isUpsideDown(asIs: number[], turned: number[]): boolean {
  const n = Math.min(asIs.length, turned.length);
  if (n < MIN_SAMPLES) return false;
  let gain = 0;
  let wins = 0;
  for (let i = 0; i < n; i++) {
    gain += turned[i] - asIs[i];
    if (turned[i] > asIs[i]) wins++;
  }
  const mean = turned.slice(0, n).reduce((s, c) => s + c, 0) / n;
  return gain / n >= MIN_GAIN && wins >= MIN_AGREEMENT * n && mean >= MIN_READABLE;
}

/**
 * For a page already known to be sideways and turned a quarter clockwise:
 * whether the other way round (three quarters) reads better. Either way is
 * better than not turning, so this needs only a majority, but the better
 * reading must be readable text at all.
 */
export function sidewaysChoice(asIs: number[], turned: number[]): 'as-is' | 'turned' | 'neither' {
  const n = Math.min(asIs.length, turned.length);
  if (n < MIN_SAMPLES) return 'neither';
  const mean = (c: number[]) => c.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const a = mean(asIs);
  const t = mean(turned);
  if (Math.max(a, t) < MIN_READABLE || Math.abs(a - t) < MIN_GAIN / 2) return 'neither';
  return t > a ? 'turned' : 'as-is';
}
