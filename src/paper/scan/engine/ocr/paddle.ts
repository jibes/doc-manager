/**
 * Pre- and post-processing for PaddleOCR (PP-OCRv5 mobile) text detection and
 * recognition. Pure functions over typed arrays, so they are unit-tested in
 * Node and run unchanged in the OCR worker.
 */
import { labelComponents } from '../imaging/components';
import type { RGBAImage } from '../imaging/image';

/**
 * A text line in image pixels. `x0..x1, y0..y1` encloses it; when `yl`, `yr`
 * and `height` are given, the line runs (slightly tilted) from centre height
 * `yl` at `x0` to `yr` at `x1` and is `height` tall.
 */
export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  yl?: number;
  yr?: number;
  height?: number;
}

/** The line's centre at `x0` and `x1`, and its height. */
function lineOf(box: TextBox): { yl: number; yr: number; height: number } {
  const mid = (box.y0 + box.y1) / 2;
  return { yl: box.yl ?? mid, yr: box.yr ?? mid, height: box.height ?? box.y1 - box.y0 };
}

/** Scale a box from detector to image pixels. */
export function scaleBox(box: TextBox, sx: number, sy: number): TextBox {
  const line = lineOf(box);
  return {
    x0: box.x0 * sx,
    x1: box.x1 * sx,
    y0: box.y0 * sy,
    y1: box.y1 * sy,
    score: box.score,
    yl: line.yl * sy,
    yr: line.yr * sy,
    height: line.height * sy,
  };
}

/** A recognised word with its box in image pixels. */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

/* ------------------------------------------------------------ detection ---- */

/** Detector input size: long side at most `maxSide`, both sides multiples of 32. */
export function detectionSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(32, Math.round((width * scale) / 32) * 32);
  const h = Math.max(32, Math.round((height * scale) / 32) * 32);
  return { width: w, height: h };
}

/**
 * NCHW float input for the detector: BGR channel order (the models were
 * trained on OpenCV images), ImageNet mean/std normalisation.
 */
export function detectionTensor(image: RGBAImage): Float32Array {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = (data[p + 2] / 255 - mean[0]) / std[0];
    out[plane + i] = (data[p + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + i] = (data[p] / 255 - mean[2]) / std[2];
  }
  return out;
}

export interface DetectionOptions {
  /** Probability above which a pixel is text. */
  threshold: number;
  /** Minimum mean probability over a region to keep it. */
  boxThreshold: number;
  /** How far to grow each region back out (DB "unclip" ratio). */
  unclip: number;
  /** Regions smaller than this (shortest side, pixels) are dropped. */
  minSize: number;
}

export const DETECTION_DEFAULTS: DetectionOptions = {
  threshold: 0.3,
  boxThreshold: 0.6,
  unclip: 1.6,
  minSize: 3,
};

/**
 * Text boxes from the detector's probability map (DB post-processing).
 *
 * DB predicts shrunken text kernels; each connected region above the
 * threshold is one text segment, grown back out by area * ratio / perimeter.
 * Pages here are already rectified, so axis-aligned boxes are enough.
 */
export function detectionBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  options: DetectionOptions = DETECTION_DEFAULTS,
): TextBox[] {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > options.threshold ? 1 : 0;
  const { labels, areas } = labelComponents(mask, width, height);
  const n = areas.length;
  const minX = new Int32Array(n).fill(width);
  const minY = new Int32Array(n).fill(height);
  const maxX = new Int32Array(n).fill(-1);
  const maxY = new Int32Array(n).fill(-1);
  const sum = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (!l) continue;
      if (x < minX[l]) minX[l] = x;
      if (x > maxX[l]) maxX[l] = x;
      if (y < minY[l]) minY[l] = y;
      if (y > maxY[l]) maxY[l] = y;
      sum[l] += prob[i];
    }
  }

  // Each region's vertical extent per column, to follow tilted lines.
  const colStart = new Int32Array(n);
  let columns = 0;
  for (let l = 1; l < n; l++) {
    colStart[l] = columns;
    if (maxX[l] >= 0) columns += maxX[l] - minX[l] + 1;
  }
  const colTop = new Int32Array(columns).fill(height);
  const colBottom = new Int32Array(columns).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!l) continue;
      const c = colStart[l] + x - minX[l];
      if (y < colTop[c]) colTop[c] = y;
      if (y > colBottom[c]) colBottom[c] = y;
    }
  }

  const boxes: TextBox[] = [];
  for (let l = 1; l < n; l++) {
    if (!areas[l]) continue;
    const w = maxX[l] - minX[l] + 1;
    const h = maxY[l] - minY[l] + 1;
    if (Math.min(w, h) < options.minSize) continue;
    const score = sum[l] / areas[l];
    if (score < options.boxThreshold) continue;
    const line = fitLine(colTop, colBottom, colStart[l], w);
    let x0 = minX[l] + line.from;
    let x1 = minX[l] + line.to + 1;
    const lw = x1 - x0;
    const grow = (lw * line.height * options.unclip) / (2 * (lw + line.height));
    const half = line.height / 2 + grow;
    x0 = Math.max(0, x0 - grow);
    x1 = Math.min(width, x1 + grow);
    // Centre heights at the grown ends. The fit is over pixel rows and
    // columns (centres at whole numbers); boxes are in edge coordinates,
    // where pixel i spans i..i+1, like `x0` and `x1` above.
    const yl = line.centre(x0 - minX[l] - 0.5) + 0.5;
    const yr = line.centre(x1 - minX[l] - 0.5) + 0.5;
    boxes.push({
      x0,
      y0: Math.max(0, Math.min(yl, yr) - half),
      x1,
      y1: Math.min(height, Math.max(yl, yr) + half),
      score,
      yl,
      yr,
      height: half * 2,
    });
  }
  return readingOrder(boxes);
}

/**
 * Reading order: the page is cut into blocks (columns, and bands between
 * wide gaps), and each block is read line by line.
 */
export function readingOrder(boxes: TextBox[]): TextBox[] {
  return blocks(boxes).flatMap(lineOrder);
}

/** A gutter between columns, and a gap between bands, in typical line heights. */
const GUTTER = 1.2;
const BAND_GAP = 0.75;
/** Lines on the two sides of a gutter pairing into rows this well: a table or form, read across. */
const ALIGNED = 0.6;
/** A median line this many line heights long is running text, not a cell. */
const COLUMN_LINE = 10;

/**
 * Recursive XY cut. A vertical gutter splits the boxes into columns read one
 * after the other, unless the two sides are short cells that run level (a form's labels and
 * values, a table's cells): those are rows, read across. Otherwise the widest
 * horizontal gap splits them into bands, top to bottom.
 */
export function blocks(boxes: TextBox[]): TextBox[][] {
  if (boxes.length < 4) return [boxes];
  const heights = boxes.map((b) => lineOf(b).height).sort((a, b) => a - b);
  const h = heights[heights.length >> 1];
  const cut = widestGap(boxes, 'x');
  const band = widestGap(boxes, 'y');
  const bands = () => [...blocks(boxes.filter((b) => b.y1 <= band!.at)), ...blocks(boxes.filter((b) => b.y0 >= band!.at))];
  // The wider gap first: a section break across the page outranks a narrow gutter inside one section.
  if (band && band.size >= BAND_GAP * h && band.size >= (cut?.size ?? 0)) return bands();
  if (cut && cut.size >= GUTTER * h) {
    const left = boxes.filter((b) => b.x1 <= cut.at);
    const right = boxes.filter((b) => b.x0 >= cut.at);
    // Level rows read across unless both sides are running text: typeset columns share baselines too, and are
    // read down, but an invoice's long descriptions beside their amounts are still rows.
    const cells = !(isColumn(left, h) && isColumn(right, h));
    if (left.length >= 2 && right.length >= 2 && (!cells || levelShare(left, right) < ALIGNED)) return [...blocks(left), ...blocks(right)];
  }
  if (band && band.size >= BAND_GAP * h) return bands();
  return [boxes];
}

/** Running text: lines many line heights long that (mostly) fill their side's width, unlike a form's or table's cells. */
function isColumn(side: TextBox[], h: number): boolean {
  const widths = side.map((b) => b.x1 - b.x0).sort((a, b) => a - b);
  const w = widths[widths.length >> 1];
  const extent = Math.max(...side.map((b) => b.x1)) - Math.min(...side.map((b) => b.x0));
  return w >= COLUMN_LINE * h && w >= 0.7 * extent;
}

/** The widest stretch along an axis that no box covers, between the first box and the last. */
export function widestGap(boxes: TextBox[], axis: 'x' | 'y'): { at: number; size: number } | null {
  const spans = boxes.map((b) => (axis === 'x' ? [b.x0, b.x1] : [b.y0, b.y1])).sort((a, b) => a[0] - b[0]);
  let end = spans[0][1];
  let best: { at: number; size: number } | null = null;
  for (const [s, e] of spans.slice(1)) {
    if (s > end && (!best || s - end > best.size)) best = { at: (s + end) / 2, size: s - end };
    end = Math.max(end, e);
  }
  return best;
}

/**
 * How well two sides pair up into rows: lines matched one to one with a line
 * level with them on the other side (centred within half a line, about
 * the same size), as a share of the longer side. A form's labels and values,
 * or a table's cells, pair up almost fully; two columns of text match only
 * where their lines happen to line up, and one usually has more lines.
 */
export function levelShare(a: TextBox[], b: TextBox[]): number {
  // A table row on one side can be several cells: compare lines, not boxes.
  const span = (line: TextBox[]): TextBox => ({ ...line[0], y0: Math.min(...line.map((x) => x.y0)), y1: Math.max(...line.map((x) => x.y1)) });
  const left = lineGroups(a).map(span);
  const right = lineGroups(b).map(span);
  const centre = (x: TextBox) => (x.y0 + x.y1) / 2;
  const size = (x: TextBox) => x.y1 - x.y0;
  const free = [...right];
  let matched = 0;
  for (const x of left) {
    const i = free.findIndex(
      (y) => Math.abs(centre(x) - centre(y)) < Math.min(size(x), size(y)) / 2 && Math.max(size(x), size(y)) < 1.3 * Math.min(size(x), size(y)),
    );
    if (i >= 0) {
      matched++;
      free.splice(i, 1);
    }
  }
  return matched / Math.max(left.length, right.length);
}

/**
 * Top to bottom, then left to right within a line. Boxes are grouped into
 * lines first and each line sorted on its own: a pairwise "same line?"
 * comparator is not transitive, and sort() gives arbitrary orders for those.
 */
function lineOrder(boxes: TextBox[]): TextBox[] {
  return lineGroups(boxes).flatMap((line) => line.sort((a, b) => a.x0 - b.x0));
}

/** Boxes grouped into lines, top to bottom (each line in no particular order). */
function lineGroups(boxes: TextBox[]): TextBox[][] {
  const centre = (b: TextBox) => (b.y0 + b.y1) / 2;
  // Ties broken on position, so the input order never matters.
  const byCentre = [...boxes].sort((a, b) => centre(a) - centre(b) || a.x0 - b.x0 || a.y0 - b.y0);
  const lines: TextBox[][] = [];
  for (const box of byCentre) {
    const line = lines.at(-1);
    const first = line?.[0];
    // On the line if its centre is within half the smaller box's height of
    // the line's first box.
    const near =
      first && centre(box) - centre(first) < Math.min(first.y1 - first.y0, box.y1 - box.y0) / 2;
    if (line && near) line.push(box);
    else lines.push([box]);
  }
  return lines;
}

/**
 * A straight centre line through a region's columns. The height is the
 * upper-quartile column height, and columns much taller than that, or far off the
 * line, are left out of the fit and trimmed from the ends: a smudge or a
 * punch-hole shadow touching a line would otherwise make its box twice as
 * tall and the text in it too small to read.
 */
function fitLine(top: Int32Array, bottom: Int32Array, start: number, w: number) {
  const heights: number[] = [];
  for (let i = 0; i < w; i++) {
    if (bottom[start + i] >= 0) heights.push(bottom[start + i] - top[start + i] + 1);
  }
  heights.sort((a, b) => a - b);
  // Upper quartile: x-height letters make many columns short, while a blob
  // at one end of the line is only a minority of them.
  const height = heights[Math.floor(heights.length * 0.75)] ?? 1;
  const usable = (i: number) => {
    const b = bottom[start + i];
    return b >= 0 && b - top[start + i] + 1 <= height * 1.4;
  };
  const fit = (exclude: (i: number) => boolean) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < w; i++) {
      if (!usable(i) || exclude(i)) continue;
      const c = (top[start + i] + bottom[start + i]) / 2;
      n++;
      sx += i;
      sy += c;
      sxx += i * i;
      sxy += i * c;
    }
    if (n === 0) return null;
    const det = n * sxx - sx * sx;
    // Text lines are close to level; anything steeper is a bad fit.
    const slope = n > 1 && det > 0 ? Math.max(-0.2, Math.min(0.2, (n * sxy - sx * sy) / det)) : 0;
    return { slope, intercept: (sy - slope * sx) / n };
  };
  let line = fit(() => false) ?? { slope: 0, intercept: (top[start] + bottom[start]) / 2 };
  const off = (i: number) =>
    Math.abs((top[start + i] + bottom[start + i]) / 2 - (line.intercept + line.slope * i));
  // One refit without columns off the line (descenders, specks).
  line = fit((i) => off(i) > height * 0.35) ?? line;
  const good = (i: number) => usable(i) && off(i) <= height * 0.5;
  let from = 0;
  let to = w - 1;
  while (from < to && !good(from)) from++;
  while (to > from && !good(to)) to--;
  const { slope, intercept } = line;
  return { height, from, to, centre: (i: number) => intercept + slope * i };
}

/* ---------------------------------------------------------- recognition ---- */

export const REC_HEIGHT = 48;
/** Very long lines are split by the detector anyway; cap the input width. */
const REC_MAX_WIDTH = 2400;

/**
 * Recogniser input widths are rounded up to one of a few sizes. ONNX Runtime
 * prepares its kernels per input shape, and preparing them costs far more
 * than running them: with free widths every text line is a cold start.
 */
export function recognitionWidth(width: number): number {
  const w = Math.min(REC_MAX_WIDTH, width);
  let bucket = 160;
  while (bucket < w) bucket = Math.round((bucket * 1.4) / 32) * 32;
  return Math.min(REC_MAX_WIDTH, bucket);
}

/**
 * A text box cropped and scaled to the recogniser's height, padded on the
 * right to a bucketed width (see `recognitionWidth`).
 * `width` is the padded input width; `textWidth` the part holding the line.
 */
export function recognitionInput(
  image: RGBAImage,
  box: TextBox,
): { tensor: Float32Array; width: number; textWidth: number; crop: RGBAImage } {
  const cw = Math.max(1, box.x1 - box.x0);
  const { yl, yr, height: ch } = lineOf(box);
  const textWidth = Math.max(
    REC_HEIGHT / 2,
    Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * cw) / Math.max(1, ch))),
  );
  const width = recognitionWidth(textWidth);
  const crop = sampleLine(image, box.x0, cw, yl, yr, ch, textWidth, REC_HEIGHT);
  const plane = width * REC_HEIGHT;
  // Padding is 0 after scaling (mid-grey), as in PaddleOCR's own
  // preprocessing: white padding makes the model misread or drop text.
  const tensor = new Float32Array(3 * plane);
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < textWidth; x++) {
      const i = y * width + x;
      const p = (y * textWidth + x) * 4;
      // BGR, scaled to [-1, 1].
      tensor[i] = crop.data[p + 2] / 127.5 - 1;
      tensor[plane + i] = crop.data[p + 1] / 127.5 - 1;
      tensor[2 * plane + i] = crop.data[p] / 127.5 - 1;
    }
  }
  return { tensor, width, textWidth, crop };
}

/**
 * Sample a (possibly tilted) line into an `outW` × `outH` image: columns
 * follow the line, rows are straight up and down (a shear, which is the same
 * as a rotation at these small angles). Each output pixel averages a small
 * grid of bilinear samples, so shrinking does not alias. Outside the image
 * is white paper.
 */
function sampleLine(
  image: RGBAImage,
  x0: number,
  w: number,
  yl: number,
  yr: number,
  h: number,
  outW: number,
  outH: number,
): RGBAImage {
  const { width: iw, height: ih, data: src } = image;
  const data = new Uint8ClampedArray(outW * outH * 4);
  const fx = w / outW;
  const fy = h / outH;
  const k = Math.max(1, Math.min(4, Math.ceil(Math.max(fx, fy))));
  const rgb = [0, 0, 0];
  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > iw - 1 || y > ih - 1) {
      rgb[0] += 255;
      rgb[1] += 255;
      rgb[2] += 255;
      return;
    }
    const xi = Math.min(iw - 2, Math.floor(x));
    const yi = Math.min(ih - 2, Math.floor(y));
    const ax = x - xi;
    const ay = y - yi;
    const p = (yi * iw + xi) * 4;
    const q = p + iw * 4;
    for (let c = 0; c < 3; c++) {
      const top = src[p + c] + (src[p + 4 + c] - src[p + c]) * ax;
      const bottom = src[q + c] + (src[q + 4 + c] - src[q + c]) * ax;
      rgb[c] += top + (bottom - top) * ay;
    }
  };
  const slope = (yr - yl) / w;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      rgb[0] = rgb[1] = rgb[2] = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const dx = (u + (i + 0.5) / k) * fx;
          const y = yl + slope * dx + ((v + (j + 0.5) / k) / outH - 0.5) * h - 0.5;
          sample(x0 + dx - 0.5, y);
        }
      }
      const o = (v * outW + u) * 4;
      const n = k * k;
      data[o] = rgb[0] / n;
      data[o + 1] = rgb[1] / n;
      data[o + 2] = rgb[2] / n;
      data[o + 3] = 255;
    }
  }
  return { data, width: outW, height: outH };
}

export interface DecodedLine {
  text: string;
  confidence: number;
  /** Timestep at which each character of `text` was emitted. */
  steps: number[];
}

/**
 * Greedy CTC decoding. Class 0 is the CTC blank, classes 1..dict.length are
 * the dictionary, and the class after that is a space.
 */
export function ctcDecode(
  probs: Float32Array,
  steps: number,
  classes: number,
  dict: string[],
): DecodedLine {
  let text = '';
  const at: number[] = [];
  let sum = 0;
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -Infinity;
    for (let c = 0; c < classes; c++) {
      const p = probs[t * classes + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      text += best <= dict.length ? dict[best - 1] : ' ';
      at.push(t);
      sum += bestP;
    }
    previous = best;
  }
  return { text, confidence: at.length ? sum / at.length : 0, steps: at };
}

/**
 * Split a recognised line into words with boxes in image pixels, placing each
 * character at the horizontal position of the timestep that emitted it.
 */
export function lineWords(
  line: DecodedLine,
  box: TextBox,
  steps: number,
  /** Fraction of the input width that holds the line (the rest is padding). */
  filled = 1,
): OcrWord[] {
  const words: OcrWord[] = [];
  const width = box.x1 - box.x0;
  const { yl, yr, height } = lineOf(box);
  const centreAt = (x: number) => yl + ((yr - yl) * (x - box.x0)) / Math.max(1, width);
  const xAt = (t: number) => box.x0 + ((t + 0.5) / (steps * filled)) * width;
  // One step per character, and characters outside the BMP (the dictionary
  // has a few maths letters) are two UTF-16 units: index by code point.
  const chars = Array.from(line.text);
  const half = Math.max(1, width / Math.max(1, chars.length) / 2);
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const text = chars.slice(start, end).join('').trim();
    if (text) {
      const x0 = Math.max(box.x0, xAt(line.steps[start]) - half);
      const x1 = Math.min(box.x1, xAt(line.steps[end - 1]) + half);
      const centre = centreAt((x0 + x1) / 2);
      words.push({
        text,
        x0,
        y0: centre - height / 2,
        x1,
        y1: centre + height / 2,
        confidence: line.confidence,
      });
    }
    start = -1;
  };
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === ' ') flush(i);
    else if (start < 0) start = i;
  }
  flush(chars.length);
  return words;
}
