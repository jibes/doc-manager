import { applyHomography, homography, isConvex, plausibleQuad, quadArea } from '../imaging/quad';
import { intersectLines, robustFit, type Line } from '../imaging/refine';
import type { Point, Quad, RGBAImage } from '../imaging/image';

/**
 * Classical page finder that checks and, where needed, replaces the neural
 * detector's quad.
 *
 * DocAligner is trained on pages that are mostly white with dark text. It
 * misses pages that fill most of the frame, and on pages with large coloured
 * areas it latches onto internal content: the white part under a photo, a
 * coloured band, a diagonal through a gradient. Page edges, though, are long
 * straight steps in colour that run the whole length of each side, which a
 * line search over the photo finds reliably.
 *
 * 1. Colour gradients (Sobel, strongest of R, G, B) vote in a Hough transform;
 *    each vote is capped so a long faint edge outweighs a short high-contrast
 *    one (a text line is mostly gaps).
 * 2. Every line found gets a support profile: at each pixel along it, is
 *    there a colour step across it? Prefix sums make any segment's support an
 *    O(1) lookup.
 * 3. Quads from two roughly opposite pairs of lines are scored. A side
 *    counts only if it is supported along nearly its whole length (within the
 *    frame) and right up to both corners, so a line that merely continues
 *    past the page's corner into the table does not qualify.
 * 4. Of the fully supported quads, the largest wins: the page boundary is the
 *    outermost one, while a photo's or a coloured band's edge inside the page
 *    only bounds a smaller quad. When the model's quad is itself fully
 *    supported, a replacement must contain it.
 * 5. Real sheets are not always straight: pinned to a board they bow and
 *    sag, pins cover their corners, and a sheet lying on another white one
 *    has only a faint edge there. When no quad passes, `relaxedSearch` snaps
 *    the quads that came close onto the edges near each corner and judges
 *    them with some tolerance across each side, allowing one weak side, but
 *    only steps with the paper on their inside count.
 */

/** Colour planes (0..1) at the search resolution. */
export interface Planes {
  width: number;
  height: number;
  c: [Float32Array, Float32Array, Float32Array];
}

/** Box-downsample an RGBA image by an integer factor into three float planes. */
export function colourPlanes(img: RGBAImage, factor: number): Planes {
  const f = Math.max(1, Math.floor(factor));
  const width = Math.max(1, Math.floor(img.width / f));
  const height = Math.max(1, Math.floor(img.height / f));
  const c: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(width * height),
    new Float32Array(width * height),
    new Float32Array(width * height),
  ];
  const norm = 1 / (255 * f * f);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        let p = ((y * f + yy) * img.width + x * f) * 4;
        for (let xx = 0; xx < f; xx++, p += 4) {
          r += d[p];
          g += d[p + 1];
          b += d[p + 2];
        }
      }
      const i = y * width + x;
      c[0][i] = r * norm;
      c[1][i] = g * norm;
      c[2][i] = b * norm;
    }
  }
  return { width, height, c };
}

/** A line x·cos θ + y·sin θ = ρ, in pixel-edge coordinates of the planes. */
export interface HoughLine {
  theta: number;
  rho: number;
  votes: number;
}

/** Below this colour step (Sobel, normalised to a unit step) a pixel does not vote. */
const VOTE_MIN = 0.03;
/** Votes are capped at this step, so that coverage, not contrast, ranks lines. */
const VOTE_CAP = 0.08;
const THETA_BINS = 180;
/** Votes go to angles up to this many degrees either side of the gradient's. */
const VOTE_SPREAD = 4;

interface Gradient {
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

function gradient(p: Planes): Gradient {
  const { width: w, height: h } = p;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = 0;
      let bx = 0;
      let by = 0;
      for (const ch of p.c) {
        const sx =
          ch[i - w + 1] +
          2 * ch[i + 1] +
          ch[i + w + 1] -
          ch[i - w - 1] -
          2 * ch[i - 1] -
          ch[i + w - 1];
        const sy =
          ch[i + w - 1] +
          2 * ch[i + w] +
          ch[i + w + 1] -
          ch[i - w - 1] -
          2 * ch[i - w] -
          ch[i - w + 1];
        const m = sx * sx + sy * sy;
        if (m > best) {
          best = m;
          bx = sx;
          by = sy;
        }
      }
      gx[i] = bx / 4;
      gy[i] = by / 4;
      mag[i] = Math.sqrt(best) / 4;
    }
  }
  return { gx, gy, mag };
}

/**
 * The strongest straight edges, at most `max`, with near-duplicates
 * suppressed. Positions are refined by a least-squares fit to the edge
 * pixels along each line.
 */
export function houghLines(p: Planes, max = 28, grad = gradient(p)): HoughLine[] {
  const { width: w, height: h } = p;
  const { gx, gy, mag } = grad;
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoBins = 2 * diag + 1;
  const acc = new Float32Array(THETA_BINS * rhoBins);
  const cos = new Float64Array(THETA_BINS);
  const sin = new Float64Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++) {
    cos[t] = Math.cos((t * Math.PI) / THETA_BINS);
    sin[t] = Math.sin((t * Math.PI) / THETA_BINS);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < VOTE_MIN) continue;
      const weight = Math.min(m, VOTE_CAP) / VOTE_CAP;
      let theta = Math.atan2(gy[i], gx[i]);
      if (theta < 0) theta += Math.PI;
      const tb = Math.round((theta / Math.PI) * THETA_BINS);
      const px = x + 0.5;
      const py = y + 0.5;
      // Gradient directions are noisy on faint or jagged edges: vote for
      // nearby angles too, less strongly.
      for (let dt = -VOTE_SPREAD; dt <= VOTE_SPREAD; dt++) {
        const t = (tb + dt + THETA_BINS) % THETA_BINS;
        const rho = px * cos[t] + py * sin[t];
        const r = Math.round(rho) + diag;
        acc[t * rhoBins + r] += weight * (1 - Math.abs(dt) / (VOTE_SPREAD + 1));
      }
    }
  }

  // Peaks, strongest first, with near-duplicates suppressed.
  const minVotes = 0.08 * Math.min(w, h);
  const peaks: number[] = [];
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      const v = acc[t * rhoBins + r];
      if (v < minVotes) continue;
      if (v < acc[t * rhoBins + r - 1] || v < acc[t * rhoBins + r + 1]) continue;
      peaks.push(t * rhoBins + r);
    }
  }
  peaks.sort((a, b) => acc[b] - acc[a]);
  const lines: HoughLine[] = [];
  for (const k of peaks) {
    if (lines.length >= max * 3) break;
    const theta = (Math.floor(k / rhoBins) * Math.PI) / THETA_BINS;
    const rho = (k % rhoBins) - diag;
    if (lines.some((l) => sameLine(l, theta, rho))) continue;
    lines.push({ theta, rho, votes: acc[k] });
  }
  const refined = lines.map((l) => refineLine(l, grad, w, h));
  // Refinement can merge two peaks onto one edge.
  const out: HoughLine[] = [];
  for (const l of refined) {
    if (out.length >= max) break;
    if (out.some((o) => sameLine(o, l.theta, l.rho))) continue;
    out.push(l);
  }
  return out;
}

function sameLine(l: HoughLine, theta: number, rho: number): boolean {
  let dt = Math.abs(l.theta - theta);
  let dr = Math.abs(l.rho - rho);
  if (dt > Math.PI / 2) {
    dt = Math.PI - dt;
    dr = Math.abs(l.rho + rho);
  }
  return dt < (4 * Math.PI) / 180 && dr < 8;
}

/** Least-squares fit to the edge pixels within a few pixels of a Hough line. */
function refineLine(l: HoughLine, grad: Gradient, w: number, h: number): HoughLine {
  const { gx, gy, mag } = grad;
  const nx = Math.cos(l.theta);
  const ny = Math.sin(l.theta);
  const ux = -ny;
  const uy = nx;
  const diag = Math.hypot(w, h);
  let sw = 0;
  let mx = 0;
  let my = 0;
  const pts: number[] = [];
  for (let t = -diag; t <= diag; t += 1) {
    const cx = l.rho * nx + t * ux;
    const cy = l.rho * ny + t * uy;
    if (cx < 2 || cy < 2 || cx > w - 2 || cy > h - 2) continue;
    // Best edge pixel across the line within ±3 px, with a matching orientation.
    let best = -1;
    let bestM = VOTE_MIN;
    for (let s = -3; s <= 3; s++) {
      const x = Math.floor(cx + s * nx);
      const y = Math.floor(cy + s * ny);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      const m = mag[i];
      if (m <= bestM) continue;
      const along = Math.abs(gx[i] * nx + gy[i] * ny) / m;
      if (along < 0.94) continue;
      bestM = m;
      best = i;
    }
    if (best < 0) continue;
    const wgt = Math.min(bestM, VOTE_CAP);
    const x = (best % w) + 0.5;
    const y = Math.floor(best / w) + 0.5;
    pts.push(x, y, wgt);
    sw += wgt;
    mx += x * wgt;
    my += y * wgt;
  }
  if (pts.length < 30 || sw <= 0) return l;
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < pts.length; k += 3) {
    const dx = pts[k] - mx;
    const dy = pts[k + 1] - my;
    sxx += pts[k + 2] * dx * dx;
    syy += pts[k + 2] * dy * dy;
    sxy += pts[k + 2] * dx * dy;
  }
  // Direction of the line = major axis; normal is perpendicular.
  const dir = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let theta = dir + Math.PI / 2;
  // Keep the normal close to the original one.
  if (Math.cos(theta - l.theta) < 0) theta += Math.PI;
  theta = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let rho = mx * Math.cos(theta) + my * Math.sin(theta);
  if (theta >= Math.PI) {
    theta -= Math.PI;
    rho = -rho;
  }
  // A refit that wandered off to another edge is not a refinement.
  if (Math.abs(theta - l.theta) > 0.06 && Math.PI - Math.abs(theta - l.theta) > 0.06) return l;
  return { theta, rho, votes: l.votes };
}

/* ------------------------------------------------------------- support ---- */

/** Colour step (Euclidean, RGB 0..1) across a side that counts as an edge. */
const STEP_MIN = 0.05;
/** Half the distance across which the step is measured, in search pixels. */
const STEP_SPAN = 2;

/** All three planes at (x, y), bilinearly, into `out` from `at`. */
function sample3(p: Planes, x: number, y: number, out: Float64Array, at: number): void {
  const { width: w, height: h } = p;
  const fx = Math.min(w - 1.001, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let c = 0; c < 3; c++) {
    const ch = p.c[c];
    out[at + c] = ch[i] * w00 + ch[i + 1] * w10 + ch[i + w] * w01 + ch[i + w + 1] * w11;
  }
}

/** Scratch output of `stepAt`: the colour step vector (outside minus inside along n). */
const delta = new Float64Array(3);
/** Scratch: colours across a side, three per offset. */
let across = new Float64Array(3 * 64);

/**
 * Whether there is a colour step across direction (nx, ny) at (x, y): the
 * largest step over offsets up to `slack` across, so a slightly bent or
 * misplaced edge still counts. Returns -1 outside the frame (unknown), else
 * 0 or 1; the step itself is left in `delta`.
 */
function stepAt(p: Planes, x: number, y: number, nx: number, ny: number, slack = 2): number {
  const { width: w, height: h } = p;
  const reach = STEP_SPAN + slack;
  delta[0] = delta[1] = delta[2] = 0;
  if (x - reach < 0 || y - reach < 0 || x + reach > w || y + reach > h) return -1;
  const k = 2 * reach + 1;
  if (across.length < 3 * k) across = new Float64Array(3 * k);
  for (let o = 0; o < k; o++) {
    const s = o - reach;
    sample3(p, x + nx * s, y + ny * s, across, 3 * o);
  }
  let best = 0;
  // Step centred on offset o: from o - STEP_SPAN to o + STEP_SPAN.
  for (let o = 0; o <= 2 * slack; o++) {
    const hi = 3 * (o + 2 * STEP_SPAN);
    const lo = 3 * o;
    const d0 = across[hi] - across[lo];
    const d1 = across[hi + 1] - across[lo + 1];
    const d2 = across[hi + 2] - across[lo + 2];
    const s = d0 * d0 + d1 * d1 + d2 * d2;
    if (s > best) {
      best = s;
      delta[0] = d0;
      delta[1] = d1;
      delta[2] = d2;
    }
  }
  return best >= STEP_MIN * STEP_MIN ? 1 : 0;
}

/**
 * A page edge is a step: paper on one side, something else on the other,
 * and it stays different further out. A printed rule (a form's table lines,
 * an underline) is a thin dark ridge with paper on both sides; across
 * 2 * STEP_SPAN it is a step too, and the paper either side of it may even
 * be shaded differently (a fold, the shadow of the phone). A ridge sample:
 * the darkest point across the path is darker than the paper a few pixels
 * out on BOTH sides by at least RIDGE_DEPTH, and those two sides are much
 * closer to each other than to it. A page's own edge with a shadow line
 * beside it does not qualify: past the thin shadow lies the table, which
 * differs from the paper as much as from the shadow, or the shadow is wide.
 */
const RIDGE_DEPTH = 0.06;
/** The sides of a ridge differ by at most this share of its shallower depth. */
const RIDGE_SIDES = 0.5;
/** Where the sides are sampled, search pixels from the darkest point. */
const RIDGE_NEAR = 2;
const RIDGE_FAR = 4;
/** A side counts as a printed line when at least this share of its steps are ridges. */
const RIDGE_SHARE = 0.3;

/** Scratch: colours across a path, three per offset. */
let ridgeCols = new Float64Array(3 * 32);
const ridgeMid = new Float64Array(6);

/**
 * Whether the path at (x, y) runs along a thin dark line printed on paper
 * (see RIDGE_DEPTH): 1 if so, 0 if not, -1 where it cannot be told (too
 * close to the frame's border).
 */
function ridgeAt(p: Planes, x: number, y: number, nx: number, ny: number, slack: number): number {
  const { width: w, height: h } = p;
  const core = slack + 1;
  const reach = core + RIDGE_FAR;
  if (x - reach * Math.abs(nx) < 0 || y - reach * Math.abs(ny) < 0) return -1;
  if (x + reach * Math.abs(nx) > w || y + reach * Math.abs(ny) > h) return -1;
  const k = 2 * reach + 1;
  if (ridgeCols.length < 3 * k) ridgeCols = new Float64Array(3 * k);
  for (let o = 0; o < k; o++)
    sample3(p, x + nx * (o - reach), y + ny * (o - reach), ridgeCols, 3 * o);
  const lum = (o: number) => ridgeCols[3 * o] + ridgeCols[3 * o + 1] + ridgeCols[3 * o + 2];
  // The darkest point near the path.
  let m = reach;
  for (let o = reach - core; o <= reach + core; o++) if (lum(o) < lum(m)) m = o;
  const n = RIDGE_FAR - RIDGE_NEAR + 1;
  const v = new Float64Array(n);
  for (let side = 0; side < 2; side++) {
    const sign = side ? 1 : -1;
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j < n; j++) v[j] = ridgeCols[3 * (m + sign * (RIDGE_NEAR + j)) + c];
      v.sort();
      ridgeMid[3 * side + c] = v[n >> 1];
    }
  }
  const c0 = ridgeCols[3 * m];
  const c1 = ridgeCols[3 * m + 1];
  const c2 = ridgeCols[3 * m + 2];
  const depthA = Math.hypot(ridgeMid[0] - c0, ridgeMid[1] - c1, ridgeMid[2] - c2);
  const depthB = Math.hypot(ridgeMid[3] - c0, ridgeMid[4] - c1, ridgeMid[5] - c2);
  // Darker, not just different: the sides are brighter than the line.
  const brighterA = ridgeMid[0] + ridgeMid[1] + ridgeMid[2] > c0 + c1 + c2;
  const brighterB = ridgeMid[3] + ridgeMid[4] + ridgeMid[5] > c0 + c1 + c2;
  const depth = Math.min(depthA, depthB);
  if (!brighterA || !brighterB || depth < RIDGE_DEPTH) return 0;
  const sides = Math.hypot(
    ridgeMid[0] - ridgeMid[3],
    ridgeMid[1] - ridgeMid[4],
    ridgeMid[2] - ridgeMid[5],
  );
  return sides <= RIDGE_SIDES * depth ? 1 : 0;
}

/**
 * Edge evidence along a straight path in 1 px steps, as prefix sums so that
 * any stretch of it is an O(1) lookup: samples in the frame, samples with a
 * step, and the summed step vectors (with their summed lengths) of those;
 * of the samples with a step, those that could be told apart from a printed
 * line (`ridgeIn`), and of those, the ones that are one (`ridgeOn`).
 */
interface Track {
  /** Path parameter of sample 0. */
  t0: number;
  inFrame: Int32Array;
  on: Int32Array;
  d: [Float64Array, Float64Array, Float64Array];
  abs: Float64Array;
  ridgeIn: Int32Array;
  ridgeOn: Int32Array;
}

function track(
  p: Planes,
  x0: number,
  y0: number,
  ux: number,
  uy: number,
  t0: number,
  n: number,
  nx: number,
  ny: number,
  slack = 2,
): Track {
  const inFrame = new Int32Array(n + 1);
  const on = new Int32Array(n + 1);
  const d: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(n + 1),
    new Float64Array(n + 1),
    new Float64Array(n + 1),
  ];
  const abs = new Float64Array(n + 1);
  const ridgeIn = new Int32Array(n + 1);
  const ridgeOn = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const t = t0 + k + 0.5;
    const x = x0 + ux * t;
    const y = y0 + uy * t;
    const s = stepAt(p, x, y, nx, ny, slack);
    inFrame[k + 1] = inFrame[k] + (s >= 0 ? 1 : 0);
    on[k + 1] = on[k] + (s > 0 ? 1 : 0);
    const keep = s > 0 ? 1 : 0;
    for (let c = 0; c < 3; c++) d[c][k + 1] = d[c][k] + keep * delta[c];
    abs[k + 1] = abs[k] + keep * Math.hypot(delta[0], delta[1], delta[2]);
    const r = keep ? ridgeAt(p, x, y, nx, ny, slack) : -1;
    ridgeIn[k + 1] = ridgeIn[k] + (r >= 0 ? 1 : 0);
    ridgeOn[k + 1] = ridgeOn[k] + (r > 0 ? 1 : 0);
  }
  return { t0, inFrame, on, d, abs, ridgeIn, ridgeOn };
}

interface Stretch {
  inFrame: number;
  on: number;
  d: [number, number, number];
  abs: number;
  ridgeIn: number;
  ridgeOn: number;
}

function stretch(tr: Track, ta: number, tb: number): Stretch {
  const n = tr.inFrame.length - 1;
  const a = Math.max(0, Math.min(n, Math.round(Math.min(ta, tb) - tr.t0)));
  const b = Math.max(0, Math.min(n, Math.round(Math.max(ta, tb) - tr.t0)));
  return {
    inFrame: tr.inFrame[b] - tr.inFrame[a],
    on: tr.on[b] - tr.on[a],
    d: [tr.d[0][b] - tr.d[0][a], tr.d[1][b] - tr.d[1][a], tr.d[2][b] - tr.d[2][a]],
    abs: tr.abs[b] - tr.abs[a],
    ridgeIn: tr.ridgeIn[b] - tr.ridgeIn[a],
    ridgeOn: tr.ridgeOn[b] - tr.ridgeOn[a],
  };
}

/** A Hough line's whole track across the frame. */
interface Profile {
  line: HoughLine;
  track: Track;
}

function profile(p: Planes, line: HoughLine): Profile {
  const diag = Math.ceil(Math.hypot(p.width, p.height));
  const nx = Math.cos(line.theta);
  const ny = Math.sin(line.theta);
  // Point at parameter t: rho * n + t * (-ny, nx).
  return {
    line,
    track: track(p, line.rho * nx, line.rho * ny, -ny, nx, -diag, 2 * diag + 1, nx, ny),
  };
}

/** Position of point (x, y) along a line. */
function along(line: HoughLine, x: number, y: number): number {
  return -x * Math.sin(line.theta) + y * Math.cos(line.theta);
}

/** Required share of a side's in-frame length with a colour step across it. */
const SIDE_SUPPORT = 0.8;
/** Required share near each corner (the last `CORNER_SPAN` of the side). */
const CORNER_SUPPORT = 0.6;
const CORNER_SPAN = 0.12;
/**
 * The steps along a side must mostly be the same step (paper to table, or
 * photo to table): their summed vector at least this share of their summed
 * lengths. Texture (wood grain, noise) steps every which way.
 */
const COHERENCE = 0.5;
/** ... and near each corner on its own. */
const CORNER_COHERENCE = 0.5;
/** At least this share of a side must be in the frame to be judged at all. */
const MIN_IN_FRAME = 0.12;
/** ... and at least this many search pixels of it. */
const MIN_VISIBLE_PX = 40;

export interface SideScore {
  /** Share of the side's in-frame samples with a step across. */
  support: number;
  /** Share of the side inside the frame. */
  visible: number;
  /** Lowest support over the two corner ends (1 where out of frame). */
  corners: number;
  /** How consistent the steps are along the side, 0..1. */
  coherence: number;
  /** Lowest consistency of the steps near either corner, 0..1 (1 where out of frame). */
  cornerCoherence: number;
  /** In-frame length, search pixels. */
  length: number;
  /** Mean colour step of the supported samples. */
  strength: number;
  /**
   * Share of the supported samples that are a thin dark line with paper on
   * both sides (see RIDGE_DEPTH): high for a rule printed on the paper. 0
   * when it cannot be judged (the side hugs the frame's border).
   */
  ridge: number;
}

/** Fewest supported samples on which a side's `ridge` share is judged. */
const RIDGE_JUDGED = 12;

function judge(tr: Track, ta: number, tb: number): SideScore {
  const len = Math.abs(tb - ta);
  const whole = stretch(tr, ta, tb);
  const end = len * CORNER_SPAN;
  const dir = tb >= ta ? 1 : -1;
  const mean = Math.hypot(whole.d[0], whole.d[1], whole.d[2]);
  const judged = (c: Stretch) => c.inFrame >= Math.max(4, end * 0.3);
  const ratio = (c: Stretch) => (judged(c) ? c.on / c.inFrame : 1);
  // Self-consistency of each end on its own: a dark band or a photo may meet
  // the page edge at a corner, stepping the other way from the rest of it.
  const agree = (c: Stretch) =>
    judged(c) ? Math.hypot(c.d[0], c.d[1], c.d[2]) / Math.max(1e-9, c.abs) : 1;
  const a = stretch(tr, ta, ta + dir * end);
  const b = stretch(tr, tb - dir * end, tb);
  return {
    support: whole.inFrame > 0 ? whole.on / whole.inFrame : 0,
    visible: len > 0 ? whole.inFrame / len : 0,
    corners: Math.min(ratio(a), ratio(b)),
    coherence: whole.abs > 0 ? mean / whole.abs : 0,
    cornerCoherence: Math.min(agree(a), agree(b)),
    length: whole.inFrame,
    strength: whole.on > 0 ? whole.abs / whole.on : 0,
    ridge: whole.ridgeIn >= RIDGE_JUDGED ? whole.ridgeOn / whole.ridgeIn : 0,
  };
}

/** A side that is a line printed on the paper rather than the paper's edge. */
export function printedLine(s: SideScore): boolean {
  return s.ridge >= RIDGE_SHARE;
}

function sideOk(s: SideScore): boolean {
  return (
    s.visible >= MIN_IN_FRAME &&
    s.length >= MIN_VISIBLE_PX &&
    s.support >= SIDE_SUPPORT &&
    s.corners >= CORNER_SUPPORT &&
    s.coherence >= COHERENCE &&
    s.cornerCoherence >= CORNER_COHERENCE &&
    !printedLine(s)
  );
}

/** Scores of a quad's four sides (TL-TR, TR-BR, BR-BL, BL-TL), sampled directly. */
export function quadSupport(p: Planes, q: Quad, slack = 2, stride = 1): SideScore[] {
  const out: SideScore[] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / Math.max(1e-9, len);
    const uy = (b[1] - a[1]) / Math.max(1e-9, len);
    const n = Math.max(1, Math.round(len / stride));
    // Any fixed normal will do: only the consistency of the steps matters.
    const tr = track(p, a[0], a[1], ux * stride, uy * stride, 0, n, -uy, ux, slack);
    const s = judge(tr, 0, n);
    out.push({ ...s, length: s.length * stride });
  }
  return out;
}

/** Whether every side of a quad is an edge along its whole (visible) length. */
export function quadSupported(p: Planes, q: Quad): boolean {
  const sides = quadSupport(p, q);
  return sides.every(sideOk) && sides.filter((s) => s.visible > 0.9).length >= 2;
}

/* -------------------------------------------------------------- search ---- */

function intersect(a: HoughLine, b: HoughLine): Point | null {
  const c1 = Math.cos(a.theta);
  const s1 = Math.sin(a.theta);
  const c2 = Math.cos(b.theta);
  const s2 = Math.sin(b.theta);
  const den = c1 * s2 - s1 * c2;
  if (Math.abs(den) < 1e-6) return null;
  return [(a.rho * s2 - b.rho * s1) / den, (b.rho * c1 - a.rho * c2) / den];
}

/** Angle between two lines' directions, 0..π/2. */
function angleBetween(a: HoughLine, b: HoughLine): number {
  const d = Math.abs(a.theta - b.theta) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/** Smallest interior angle of a convex quad, radians. */
function minAngle(q: Quad): number {
  let min = Math.PI;
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const b = Math.atan2(n[1] - c[1], n[0] - c[0]);
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    min = Math.min(min, d, Math.PI - d);
  }
  return min;
}

/** Order four corners TL, TR, BR, BL, keeping their cyclic order. */
function orderCyclic(pts: Point[]): Quad {
  // Make the winding clockwise in image coordinates (y down).
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  const cw = s > 0 ? pts : [pts[0], pts[3], pts[2], pts[1]];
  let start = 0;
  for (let i = 1; i < 4; i++) if (cw[i][0] + cw[i][1] < cw[start][0] + cw[start][1]) start = i;
  return [cw[start], cw[(start + 1) % 4], cw[(start + 2) % 4], cw[(start + 3) % 4]];
}

function inside(q: Quad, x: number, y: number, margin: number): boolean {
  // Clockwise quad: the point is inside if it is right of every edge.
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cross = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / len;
    if (cross < -margin) return false;
  }
  return true;
}

export interface SearchResult {
  quad: Quad;
  /** Whether the page runs off the frame (a corner outside it, or a side on its border). */
  offFrame: boolean;
  /** Supported quads considered, for diagnostics. */
  candidates: number;
  /**
   * `strict`: every side an edge along its whole length. `relaxed`: the
   * sides are edges allowing for bowed paper, and one may be weak. `frame`:
   * the page fills the frame, each side either the paper's edge near the
   * frame's border or the border itself with paper all along it.
   */
  tier: 'strict' | 'relaxed' | 'frame';
}

/** Quads whose areas differ by less than this are the same page, edge-wise. */
const SAME_SIZE = 0.03;

/** Opposite sides may converge by this much (steep perspective). */
const MAX_OPPOSITE_ANGLE = (40 * Math.PI) / 180;
/** Adjacent sides must differ by at least this much. */
const MIN_ADJACENT_ANGLE = (45 * Math.PI) / 180;
/** No corner of a page quad is sharper than this. */
const MIN_CORNER_ANGLE = (35 * Math.PI) / 180;

export interface SearchOptions {
  /** Only quads containing this one qualify (the model's, when it is itself well supported). */
  contain?: Quad;
  /** Hough lines to build quads from. */
  lines?: number;
  /**
   * When no quad passes the strict check, try the relaxed one (see
   * `relaxedSearch`); its own `contain` applies there.
   */
  relaxed?: { contain?: Quad };
}

/** A quad from four lines that is not strictly supported but might be the page. */
interface Rough {
  quad: Quad;
  area: number;
  border: number;
}

/**
 * The largest quad whose four sides are colour edges along their whole
 * length, in the planes' pixel-edge coordinates. Corners may lie outside the
 * frame when a page runs off it. With `contain`, only quads containing that
 * quad qualify. With `relaxed`, falls back to `relaxedSearch` when no quad
 * passes.
 */
export function searchQuad(
  p: Planes,
  { contain, lines: maxLines = 28, relaxed }: SearchOptions = {},
): SearchResult | null {
  const { width: w, height: h } = p;
  const detected = houghLines(p, maxLines);
  // The frame's own borders stand in for a side that is entirely out of view.
  const frame: HoughLine[] = [
    { theta: Math.PI / 2, rho: 0, votes: 0 },
    { theta: 0, rho: w, votes: 0 },
    { theta: Math.PI / 2, rho: h, votes: 0 },
    { theta: 0, rho: 0, votes: 0 },
  ];
  const lines = [...detected, ...frame];
  const isFrame = (i: number) => i >= detected.length;
  const profiles = lines.map((l, i) => (isFrame(i) ? null : profile(p, l)));
  const minArea = 0.1 * w * h;
  const minSep = 0.15 * Math.min(w, h);

  const pairs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleBetween(lines[i], lines[j]) > MAX_OPPOSITE_ANGLE) continue;
      // Far enough apart where they cross the middle of the frame.
      const mi = intersectMid(lines[i], w, h);
      const mj = intersectMid(lines[j], w, h);
      if (Math.abs(mi - mj) < minSep) continue;
      pairs.push([i, j]);
    }
  }

  const found: Found[] = [];
  const rough: Rough[] = [];
  for (let a = 0; a < pairs.length; a++) {
    const [i, j] = pairs[a];
    for (let b = a + 1; b < pairs.length; b++) {
      const [k, l] = pairs[b];
      if (k === i || k === j || l === i || l === j) continue;
      if (
        angleBetween(lines[i], lines[k]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[i], lines[l]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[j], lines[k]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[j], lines[l]) < MIN_ADJACENT_ANGLE
      ) {
        continue;
      }
      // Cyclic: i∩k, k∩j, j∩l, l∩i.
      const c0 = intersect(lines[i], lines[k]);
      const c1 = intersect(lines[k], lines[j]);
      const c2 = intersect(lines[j], lines[l]);
      const c3 = intersect(lines[l], lines[i]);
      if (!c0 || !c1 || !c2 || !c3) continue;
      const corners = [c0, c1, c2, c3];
      if (corners.some(([x, y]) => x < -0.3 * w || y < -0.3 * h || x > 1.3 * w || y > 1.3 * h)) {
        continue;
      }
      const raw: Quad = [c0, c1, c2, c3];
      if (!isConvex(raw)) continue;
      const area = quadArea(raw);
      if (area < minArea) continue;
      if (minAngle(raw) < MIN_CORNER_ANGLE) continue;
      // Sides: on line k from c0 to c1, j from c1 to c2, l from c2 to c3, i from c3 to c0.
      const sides: [number, Point, Point][] = [
        [k, c0, c1],
        [j, c1, c2],
        [l, c2, c3],
        [i, c3, c0],
      ];
      let ok = true;
      // Whether it is worth a closer look by the relaxed search.
      let promising = relaxed !== undefined;
      let fullyVisible = 0;
      let onBorder = 0;
      let strong = 0;
      let strength = 0;
      for (const [li, pa, pb] of sides) {
        const pr = profiles[li];
        if (!pr) {
          onBorder++;
          continue;
        }
        const ta = along(pr.line, pa[0], pa[1]);
        const tb = along(pr.line, pb[0], pb[1]);
        const s = judge(pr.track, ta, tb);
        if (s.support < ROUGH_SUPPORT || s.visible < MIN_IN_FRAME) promising = false;
        if (!sideOk(s)) {
          ok = false;
          if (!promising) break;
        } else strong++;
        if (s.visible > 0.9) fullyVisible++;
        strength += s.strength;
      }
      if (onBorder > 2) continue;
      const quad = orderCyclic(corners);
      if (!ok || fullyVisible < 2) {
        // At least two sides straight edges already, the others at least
        // partly on edges (bowed, or partly hidden).
        if (promising && onBorder <= 1 && strong + onBorder >= 2) {
          rough.push({ quad, area, border: onBorder });
        }
        continue;
      }
      if (contain && !containsQuad(quad, contain, w, h)) continue;
      found.push({
        quad,
        area,
        border: onBorder,
        weak: 0,
        strength: strength / (4 - onBorder),
        off: onBorder > 0 || corners.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1),
      });
    }
  }
  if (found.length) return { ...pick(found), candidates: found.length, tier: 'strict' };
  if (!relaxed) return null;

  return relaxedSearch(p, rough, relaxed.contain);
}

interface Found {
  quad: Quad;
  area: number;
  /** Sides on the frame's border. */
  border: number;
  /** Sides that are only weakly supported (relaxed search). */
  weak: number;
  strength: number;
  off: boolean;
}

/**
 * A quad with a side on the frame's border, or a weak side, only wins when
 * no quad has all four sides on real edges. Then the largest; but among
 * quads of nearly the same size (the page edge, or the soft edge of its
 * shadow just outside), the one with the strongest edges.
 */
function pick(found: Found[]): { quad: Quad; offFrame: boolean } {
  const flaws = (f: Found) => f.border + f.weak;
  const fewest = Math.min(...found.map(flaws));
  const fair = found.filter((f) => flaws(f) === fewest);
  const largest = Math.max(...fair.map((f) => f.area));
  const best = fair
    .filter((f) => f.area >= largest * (1 - SAME_SIZE))
    .reduce((a, b) => (b.strength > a.strength ? b : a));
  return { quad: best.quad, offFrame: best.off };
}

function containsQuad(outer: Quad, inner: Quad, w: number, h: number): boolean {
  return inner.every(([x, y]) => inside(outer, x, y, 0.01 * Math.max(w, h)));
}

/* ------------------------------------------------------------- relaxed ---- */

/** Each real side of a rough quad must have at least this share of its length on an edge. */
const ROUGH_SUPPORT = 0.4;
/** Rough quads looked at closely, largest first. */
const RELAXED_TRIES = 64;
/** A weak side: partly hidden (a hand, a pin, a white-on-white overlap) but there. */
const WEAK_SUPPORT = 0.5;
/** What there is of it must reach both corners... */
const WEAK_CORNERS = 0.5;
/**
 * ... and, like every side in the relaxed search, be one consistent step,
 * more so than the strict search asks: a line that runs along card edges,
 * cork and paper by turns has support but not one step.
 */
const RELAXED_COHERENCE = 0.75;
/** Share of a full side with a step that has the paper on its inside. */
const PAPER_SUPPORT = 0.7;

/**
 * How far off a straight line a real page's edge may run, in search pixels:
 * sheets pinned to a wall or lifted off a table bow and sag by about 1 % of
 * their size.
 */
function bowSlack(p: Planes): number {
  return Math.max(3, Math.min(8, Math.round(0.008 * Math.max(p.width, p.height))));
}

function sideWeakOk(s: SideScore): boolean {
  return (
    s.visible >= MIN_IN_FRAME &&
    s.length >= MIN_VISIBLE_PX &&
    s.support >= WEAK_SUPPORT &&
    s.corners >= WEAK_CORNERS &&
    s.coherence >= RELAXED_COHERENCE &&
    !printedLine(s)
  );
}

/**
 * Second chance for photos in which no quad's sides are straight edges along
 * their whole length: real paper bows, pins and fingers cover corners, and a
 * sheet overlapping a neighbouring white one has only a faint shadow for an
 * edge. Quads whose sides are each at least partly on an edge (`rough`) are
 * snapped onto the edges near their corners (`snapCorners`), then judged
 * again with `bowSlack` tolerance across each side: every side must pass
 * the full check, except that one may be weak (`sideWeakOk`) or on the
 * frame's border. The selection is that of the strict search.
 */
function relaxedSearch(p: Planes, rough: Rough[], contain?: Quad): SearchResult | null {
  const { width: w, height: h } = p;
  const slack = bowSlack(p);
  const reach = Math.max(4, Math.round(0.015 * Math.max(w, h)));
  const minArea = 0.1 * w * h;
  rough.sort((a, b) => a.border - b.border || b.area - a.area);
  const found: Found[] = [];
  const seen: Quad[] = [];
  // The largest quad found so far: the page is the outermost one, so quads
  // well inside it (a table, a photo on it) are not looked at.
  let outermost = 0;
  const tried: Quad[] = [];
  // Quads this close snap to the same edges.
  const near = reach / 2;
  for (const r of rough) {
    if (tried.length >= RELAXED_TRIES || r.area < outermost * (1 - 4 * SAME_SIZE)) break;
    if (
      tried.some((t) =>
        t.every((c, i) => Math.hypot(c[0] - r.quad[i][0], c[1] - r.quad[i][1]) < near),
      )
    ) {
      continue;
    }
    tried.push(r.quad);
    const snapped = snapCorners(p, r.quad, reach);
    if (!plausibleQuad(snapped, w, h, 0.1)) continue;
    // A quick look at every fourth pixel before the closer one.
    const glance = quadSupport(p, snapped, slack, 4);
    if (
      glance.some(
        (s, e) =>
          s.support < WEAK_SUPPORT && !onFrameBorder(snapped[e], snapped[(e + 1) % 4], w, h),
      )
    ) {
      continue;
    }
    const q = snapCorners(p, snapped, Math.max(2, Math.round(reach / 3)));
    if (!isConvex(q) || minAngle(q) < MIN_CORNER_ANGLE || quadArea(q) < minArea) continue;
    if (!plausibleQuad(q, w, h)) continue;
    if (seen.some((s) => s.every((c, i) => Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) < 1.5))) {
      continue;
    }
    seen.push(q);
    if (contain && !containsQuad(q, contain, w, h)) continue;
    const scores = quadSupport(p, q, slack, 2);
    const depth = paperDepth(q);
    let border = 0;
    let weak = 0;
    let bad = false;
    let fullyVisible = 0;
    let strength = 0;
    for (let e = 0; e < 4; e++) {
      if (onFrameBorder(q[e], q[(e + 1) % 4], w, h)) {
        border++;
        continue;
      }
      const s = scores[e];
      if (s.visible > 0.9) fullyVisible++;
      strength += s.strength;
      // The steps must be the paper's: paper on the inside of them.
      const scan = scanSide(p, q[e], q[(e + 1) % 4], slack, inwardOf(q, e), depth);
      const paper = scan && scan.samples ? scan.hits.length / scan.samples : 0;
      if (sideOk(s) && s.coherence >= RELAXED_COHERENCE && paper >= PAPER_SUPPORT) continue;
      if (sideWeakOk(s) && paper >= WEAK_SUPPORT) weak++;
      else bad = true;
    }
    if (bad || border + weak > 1 || fullyVisible < 2) continue;
    outermost = Math.max(outermost, quadArea(q));
    found.push({
      quad: q,
      area: quadArea(q),
      border,
      weak,
      strength: strength / (4 - border),
      off: border > 0 || q.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1),
    });
  }
  if (!found.length) return null;
  return { ...pick(found), candidates: found.length, tier: 'relaxed' };
}

/** Which way side `e` of a convex quad has the quad's inside, along its normal (-uy, ux): ±1. */
function inwardOf(q: Quad, e: number): number {
  const a = q[e];
  const b = q[(e + 1) % 4];
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]) > 0 ? 1 : -1;
}

/** Whether a side lies along one of the frame's borders. */
function onFrameBorder(a: Point, b: Point, w: number, h: number): boolean {
  const near = (u: number, v: number) => Math.abs(u - v) <= 1;
  return (
    (near(a[0], 0) && near(b[0], 0)) ||
    (near(a[0], w) && near(b[0], w)) ||
    (near(a[1], 0) && near(b[1], 0)) ||
    (near(a[1], h) && near(b[1], h))
  );
}

/** A side's edge positions: points where the colour steps across it, with their place along it (0..1). */
type Hits = { x: number; y: number; w: number; t: number }[];

/** How far the inside of a step may differ from the paper beside it (Euclidean RGB, 0..1). */
const PAPER_MATCH = 0.15;
/** Where the paper is sampled, beyond the search band inward, search pixels. */
const PAPER_DEPTH = 6;
/** ... or this share of the quad's shorter dimension, whichever is deeper. */
const PAPER_DEPTH_SHARE = 0.1;

/** How deep inside a quad to look for its paper's colour. */
function paperDepth(q: Quad): number {
  const side = (i: number) => Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]);
  return PAPER_DEPTH_SHARE * Math.min(side(0), side(1), side(2), side(3));
}

/**
 * Where the edge runs near a side from `a` to `b`: at points along it, the
 * position within `reach` across it of the strongest colour step in the
 * side's prevailing direction (paper to background), so that texture, a
 * pin's or a card's edge stepping the other way does not count.
 *
 * `inward` (+1 or -1, along the normal (-uy, ux)) says which way the quad's
 * inside is. Then only steps whose inner side has the colour of the paper
 * further in count: on a pin board the bottom edge of a card just above the
 * page is as strong a step as the page's own top edge.
 */
export function edgeHits(
  p: Planes,
  a: Point,
  b: Point,
  reach: number,
  inward: number = 0,
  depth = 0,
): Hits | null {
  const scan = scanSide(p, a, b, reach, inward, depth);
  return scan && scan.hits.length >= scan.samples / 4 ? scan.hits : null;
}

/** `edgeHits`, with the number of samples taken (those in the frame). */
function scanSide(
  p: Planes,
  a: Point,
  b: Point,
  reach: number,
  inward: number,
  depth = 0,
): { hits: Hits; samples: number } | null {
  const { width: w, height: h } = p;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 8) return null;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const nx = -uy;
  const ny = ux;
  const span = STEP_SPAN;
  const R = Math.ceil(reach);
  const K = 2 * (R + span) + 1;
  /** Offsets the step can be centred on: -R..R. */
  const O = 2 * R + 1;
  const m = Math.max(24, Math.min(96, Math.round(len / 5)));
  const deep = R + span + Math.max(PAPER_DEPTH, depth);
  const far = R + span + 1;
  const ts: number[] = [];
  // Per sample, the colours across the side and the paper's colour further in.
  const cols = new Float64Array(m * 3 * K);
  const refs = new Float64Array(m * 3);
  const hasRef = new Uint8Array(m);
  for (let k = 0; k < m; k++) {
    const t = 0.02 + (0.96 * k) / (m - 1);
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    if (
      x - Math.abs(nx) * far < 0 ||
      y - Math.abs(ny) * far < 0 ||
      x + Math.abs(nx) * far > w ||
      y + Math.abs(ny) * far > h
    ) {
      continue;
    }
    const at = ts.length;
    for (let o = 0; o < K; o++) {
      const s = o - R - span;
      sample3(p, x + nx * s, y + ny * s, cols, 3 * (at * K + o));
    }
    const rx = x + nx * inward * deep;
    const ry = y + ny * inward * deep;
    if (inward && rx >= 0 && ry >= 0 && rx <= w && ry <= h) {
      sample3(p, rx, ry, refs, 3 * at);
      hasRef[at] = 1;
    }
    ts.push(t);
  }
  // The paper's colour along the side: each sample's own (paper shades
  // across a page), unless that is far from the side's median (ink).
  const median = [0, 0, 0];
  const withRef: number[] = [];
  for (let k = 0; k < ts.length; k++) if (hasRef[k]) withRef.push(k);
  for (let c = 0; c < 3; c++) {
    const v = withRef.map((k) => refs[3 * k + c]).sort((x, y) => x - y);
    median[c] = v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  const steps = new Float64Array(ts.length * O * 3);
  const paper = new Uint8Array(ts.length * O);
  for (let k = 0; k < ts.length; k++) {
    let r0 = median[0];
    let r1 = median[1];
    let r2 = median[2];
    if (
      hasRef[k] &&
      Math.hypot(refs[3 * k] - r0, refs[3 * k + 1] - r1, refs[3 * k + 2] - r2) <= PAPER_MATCH
    ) {
      r0 = refs[3 * k];
      r1 = refs[3 * k + 1];
      r2 = refs[3 * k + 2];
    }
    const col = 3 * k * K;
    for (let o = 0; o < O; o++) {
      const i = 3 * (k * O + o);
      for (let c = 0; c < 3; c++) {
        steps[i + c] = cols[col + 3 * (o + 2 * span) + c] - cols[col + 3 * o + c];
      }
      if (!inward || !withRef.length) {
        paper[k * O + o] = 1;
        continue;
      }
      // The step's inner end: offset o + inward * span.
      const j = col + 3 * (o + span + inward * span);
      const d = Math.hypot(cols[j] - r0, cols[j + 1] - r1, cols[j + 2] - r2);
      paper[k * O + o] = d <= PAPER_MATCH ? 1 : 0;
    }
  }
  const n = ts.length;
  if (n < m / 4) return null;
  // The prevailing step: sum of each sample's strongest.
  let d0 = 0;
  let d1 = 0;
  let d2 = 0;
  for (let k = 0; k < n; k++) {
    let best = STEP_MIN * STEP_MIN;
    let bi = -1;
    for (let o = 0, i = k * O * 3; o < O; o++, i += 3) {
      if (!paper[k * O + o]) continue;
      const v = steps[i] * steps[i] + steps[i + 1] * steps[i + 1] + steps[i + 2] * steps[i + 2];
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    if (bi < 0) continue;
    d0 += steps[bi];
    d1 += steps[bi + 1];
    d2 += steps[bi + 2];
  }
  const norm = Math.hypot(d0, d1, d2);
  if (norm <= 1e-9) return null;
  d0 /= norm;
  d1 /= norm;
  d2 /= norm;
  const proj = (k: number, o: number) => {
    const i = (k * O + o) * 3;
    return steps[i] * d0 + steps[i + 1] * d1 + steps[i + 2] * d2;
  };
  const hits: Hits = [];
  for (let k = 0; k < n; k++) {
    let best = -Infinity;
    let bo = -1;
    for (let o = 0; o < O; o++) {
      if (!paper[k * O + o]) continue;
      const v = proj(k, o);
      if (v > best) {
        best = v;
        bo = o;
      }
    }
    if (bo < 0 || best < STEP_MIN) continue;
    let off = 0;
    if (bo > 0 && bo < O - 1) {
      const l = proj(k, bo - 1);
      const r = proj(k, bo + 1);
      const den = l - 2 * best + r;
      if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
    }
    const s = bo - R + off;
    const t = ts[k];
    hits.push({
      x: a[0] + (b[0] - a[0]) * t + nx * s,
      y: a[1] + (b[1] - a[1]) * t + ny * s,
      // Capped, so that a few strong steps (text, a pin) cannot outweigh
      // the faint edge of white paper on white.
      w: Math.min(best, 2 * STEP_MIN),
      t,
    });
  }
  return { hits, samples: n };
}

/** Fewest edge points for a line fit to half a side. */
const MIN_HALF_HITS = 8;

/**
 * Move a quad's corners onto the edges near them: each corner where lines
 * fitted to the halves of its two sides nearest to it cross (the whole side
 * where a half has too little edge), so a bowed or sagging side still ends
 * at the page's real corners. Sides on the frame's border stay.
 */
export function snapCorners(p: Planes, q: Quad, reach: number): Quad {
  const { width: w, height: h } = p;
  const through = (a: Point, b: Point): Line => {
    const len = Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1]));
    return {
      px: a[0],
      py: a[1],
      dx: (b[0] - a[0]) / len,
      dy: (b[1] - a[1]) / len,
    };
  };
  const whole: Line[] = [];
  const ends: [Line | null, Line | null][] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const hits = onFrameBorder(a, b, w, h)
      ? null
      : edgeHits(p, a, b, reach, inwardOf(q, e), paperDepth(q));
    if (!hits) {
      whole.push(through(a, b));
      ends.push([null, null]);
      continue;
    }
    whole.push(robustFit(hits, 2 * MIN_HALF_HITS) ?? through(a, b));
    ends.push([
      robustFit(
        hits.filter((x) => x.t < 0.5),
        MIN_HALF_HITS,
      ),
      robustFit(
        hits.filter((x) => x.t >= 0.5),
        MIN_HALF_HITS,
      ),
    ]);
  }
  const out: Point[] = [];
  for (let c = 0; c < 4; c++) {
    const before = ends[(c + 3) % 4][1] ?? whole[(c + 3) % 4];
    const after = ends[c][0] ?? whole[c];
    const x = intersectLines(before, after);
    const o = q[c];
    out.push(x && Math.hypot(x[0] - o[0], x[1] - o[1]) <= 2.5 * reach ? x : o);
  }
  const result: Quad = [out[0], out[1], out[2], out[3]];
  return isConvex(result) ? result : q;
}

/** Where a line crosses the frame's centre row or column (whichever it is closer to parallel to). */
function intersectMid(l: HoughLine, w: number, h: number): number {
  const c = Math.cos(l.theta);
  const s = Math.sin(l.theta);
  // Mostly vertical line (normal near x): x at the centre row.
  if (Math.abs(c) >= Math.abs(s)) return (l.rho - (h / 2) * s) / c;
  return (l.rho - (w / 2) * c) / s;
}

/* --------------------------------------------------------------- frame ---- */

/**
 * A page side near a frame border is looked for this far in from it (share
 * of the frame's size across).
 */
const FRAME_REACH = 0.2;
/** Hough lines looked at for them. */
const FRAME_LINES = 96;
/** ... and at most this far off the border's direction. */
const FRAME_TILT = (12 * Math.PI) / 180;
/**
 * Paper along a frame border taken as a side: this share of each, on
 * average, must look like the page's paper...
 */
const FRAME_PAPER = 0.8;
/** ... and at least this share of every one. */
const FRAME_PAPER_MIN = 0.65;
/**
 * Paper reaching a border: as bright as the page's paper (this share of
 * it), within PAPER_TINT_LOOSE of its hue (a scan's margin)...
 */
const BORDER_BRIGHT = 0.9;
/**
 * ... or in shade (down to PAPER_SHADE_LOOSE, and warmer: up to
 * BORDER_TINT), but then the same as further in, with no colour step this
 * large between them (a light grey map beside a shaded sheet is not more of
 * it).
 */
const BORDER_STEP = 0.1;
const BORDER_TINT = 0.25;
/** A side found near the border: share of it with a step... */
const FRAME_SIDE_SUPPORT = 0.6;
/** ... and share of that with the paper inside and something else outside. */
const FRAME_SIDE_PAPER = 0.6;
/** Within this share of the frame's size from its border, a side needs only... */
const FRAME_HUG = 0.03;
/** ... this share with the paper inside and something else outside. */
const FRAME_HUG_PAPER = 0.25;
/** The frame tier's page covers at least this share of the frame. */
const FRAME_MIN_AREA = 0.5;
/**
 * What lies beyond a page side is the paper (another sheet) if it is at
 * least this bright relative to the page's paper...
 */
const PAPER_SHADE = 0.5;
/**
 * ... and no more than this different in hue (Euclidean, colours normalised
 * to their mean; a light map or a grey table is not the paper).
 */
const PAPER_TINT = 0.1;
/** The page's paper reaching the frame's border: hue as in BORDER_BRIGHT. */
const PAPER_TINT_LOOSE = 0.15;
/** ... and how deep its shade may be (the far end of a sheet photographed at an angle). */
const PAPER_SHADE_LOOSE = 0.4;

/**
 * The page's paper colour: the median of the brighter half of the middle
 * of the frame (the darker half is print).
 */
export function paperColour(p: Planes): [number, number, number] {
  const { width: w, height: h } = p;
  const px: [number, number, number, number][] = [];
  const step = Math.max(1, Math.round(Math.min(w, h) / 120));
  for (let y = Math.round(h * 0.2); y < h * 0.8; y += step) {
    for (let x = Math.round(w * 0.2); x < w * 0.8; x += step) {
      const i = y * w + x;
      const r = p.c[0][i];
      const g = p.c[1][i];
      const b = p.c[2][i];
      px.push([r + g + b, r, g, b]);
    }
  }
  px.sort((a, b) => a[0] - b[0]);
  const bright = px.slice(Math.floor(px.length / 2));
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const v = bright.map((q) => q[c + 1]).sort((a, b) => a - b);
    out[c] = v.length ? v[v.length >> 1] : 0;
  }
  return out;
}

/** Paper is at least this bright (mean of R, G, B, 0..1)... */
const PAPER_MIN_LIGHT = 0.45;
/** ... and at most this far from grey (as PAPER_TINT): white or pastel, not a table. */
const PAPER_MAX_TINT = 0.35;

/** Whether a colour could be a sheet of paper at all. */
function plausiblePaper([r, g, b]: readonly [number, number, number]): boolean {
  const l = (r + g + b) / 3;
  return l >= PAPER_MIN_LIGHT && Math.hypot(r / l - 1, g / l - 1, b / l - 1) <= PAPER_MAX_TINT;
}

/** Whether colour (r, g, b) could be the page's paper, `paper`, in shade. */
export function paperLike(
  r: number,
  g: number,
  b: number,
  paper: readonly [number, number, number],
  tint = PAPER_TINT,
  shade = PAPER_SHADE,
): boolean {
  const l = (r + g + b) / 3;
  const lp = (paper[0] + paper[1] + paper[2]) / 3;
  if (lp <= 0.05 || l < shade * lp) return false;
  return Math.hypot(r / l - paper[0] / lp, g / l - paper[1] / lp, b / l - paper[2] / lp) <= tint;
}

/**
 * Per-channel median, into `out`, of the colours `a` to `b` search pixels
 * along (nx, ny) from (x, y), as far as the frame goes; false if that is
 * less than two pixels.
 */
function bandColour(
  p: Planes,
  x: number,
  y: number,
  nx: number,
  ny: number,
  a: number,
  b: number,
  out: Float64Array,
): boolean {
  const { width: w, height: h } = p;
  const cols = new Float64Array(3 * (b - a + 1));
  let n = 0;
  for (let o = a; o <= b; o++, n++) {
    const px = x + nx * o;
    const py = y + ny * o;
    if (px < 0 || py < 0 || px > w || py > h) break;
    sample3(p, px, py, cols, 3 * n);
  }
  if (n < 2) return false;
  const v = new Float64Array(n);
  for (let c = 0; c < 3; c++) {
    for (let o = 0; o < n; o++) v[o] = cols[3 * o + c];
    v.sort();
    out[c] = v[n >> 1];
  }
  return true;
}

/**
 * A page that fills (nearly) the whole frame, which the strict and relaxed
 * searches, wanting at least two real sides, cannot find: a flat scan, or a
 * sheet photographed so close that it runs off two or more sides. Each side
 * is the outermost line near its frame border that is the paper's edge (a
 * step with the page's paper inside and something else outside, not a rule
 * printed on the paper), or else the border itself, provided the paper
 * reaches it all along. Null when a border is not the page's paper (a page
 * on a table that nothing found).
 */
export function frameSearch(p: Planes): SearchResult | null {
  const { width: w, height: h } = p;
  // More lines than the quad search looks at: a form's many rules would
  // crowd out a faint edge near the border.
  const profiles = houghLines(p, FRAME_LINES)
    .filter((l) => {
      const mid = intersectMid(l, w, h);
      const horizontal = Math.abs(Math.sin(l.theta)) > Math.abs(Math.cos(l.theta));
      const across = horizontal ? h : w;
      return Math.min(Math.abs(mid), Math.abs(across - Math.abs(mid))) <= FRAME_REACH * across;
    })
    .map((l) => profile(p, l));
  const paper = paperColour(p);
  if (!plausiblePaper(paper)) return null;
  const frame: HoughLine[] = [
    { theta: Math.PI / 2, rho: 0, votes: 0 },
    { theta: 0, rho: w, votes: 0 },
    { theta: Math.PI / 2, rho: h, votes: 0 },
    { theta: 0, rho: 0, votes: 0 },
  ];
  /** Per border (top, right, bottom, left): the inward normal, and where it lies across. */
  const inward: Point[] = [
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 0],
  ];
  const at = [0, w, h, 0];
  const chosen: (HoughLine | null)[] = [];
  const paperShare: number[] = [];
  const inCol = new Float64Array(3);
  const outCol = new Float64Array(3);
  const depth = Math.max(4, Math.round(0.008 * Math.max(w, h)));
  for (let e = 0; e < 4; e++) {
    const across = e % 2 ? w : h;
    const [ix, iy] = inward[e];
    const gap = (pr: Profile) => Math.abs(intersectMid(pr.line, w, h) - at[e]);
    // Lines near this border, outermost first.
    const near = profiles
      .filter(
        (pr) => angleBetween(pr.line, frame[e]) <= FRAME_TILT && gap(pr) <= FRAME_REACH * across,
      )
      .sort((a, b) => gap(a) - gap(b));
    let side: HoughLine | null = null;
    for (const pr of near) {
      // Its extent: between the two neighbouring borders.
      const a = intersect(pr.line, frame[(e + 3) % 4]);
      const b = intersect(pr.line, frame[(e + 1) % 4]);
      if (!a || !b) continue;
      const s = judge(pr.track, along(pr.line, a[0], a[1]), along(pr.line, b[0], b[1]));
      if (s.support < FRAME_SIDE_SUPPORT || printedLine(s)) continue;
      // Paper inside, something else outside.
      const m = 64;
      let n = 0;
      let good = 0;
      for (let k = 0; k < m; k++) {
        const x = a[0] + ((b[0] - a[0]) * (k + 0.5)) / m;
        const y = a[1] + ((b[1] - a[1]) * (k + 0.5)) / m;
        if (!bandColour(p, x, y, ix, iy, 3, 3 + depth, inCol)) continue;
        if (!bandColour(p, x, y, -ix, -iy, 2, 2 + depth, outCol)) continue;
        n++;
        const apart = Math.hypot(outCol[0] - inCol[0], outCol[1] - inCol[1], outCol[2] - inCol[2]);
        if (
          paperLike(inCol[0], inCol[1], inCol[2], paper) &&
          !paperLike(outCol[0], outCol[1], outCol[2], paper) &&
          apart > PAPER_MATCH
        ) {
          good++;
        }
      }
      // Right at the border, a faint stretch of edge will do: little of
      // the photo lies beyond it either way.
      const share = gap(pr) <= FRAME_HUG * across ? FRAME_HUG_PAPER : FRAME_SIDE_PAPER;
      if (n >= m / 4 && good >= share * n) {
        side = pr.line;
        break;
      }
    }
    if (!side) {
      // The border itself: the paper must reach it all along.
      const m = 96;
      const len = e % 2 ? h : w;
      let n = 0;
      let good = 0;
      for (let k = 0; k < m; k++) {
        const t = ((k + 0.5) / m) * len;
        const x = e % 2 ? at[e] : t;
        const y = e % 2 ? t : at[e];
        if (!bandColour(p, x, y, ix, iy, 1, 1 + depth, outCol)) continue;
        if (!bandColour(p, x, y, ix, iy, 2 + depth, 2 + 3 * depth, inCol)) continue;
        n++;
        // See BORDER_BRIGHT.
        if (!paperLike(outCol[0], outCol[1], outCol[2], paper, BORDER_TINT, PAPER_SHADE_LOOSE)) {
          continue;
        }
        const bright = paperLike(
          outCol[0],
          outCol[1],
          outCol[2],
          paper,
          PAPER_TINT_LOOSE,
          BORDER_BRIGHT,
        );
        const apart = Math.hypot(outCol[0] - inCol[0], outCol[1] - inCol[1], outCol[2] - inCol[2]);
        if (bright || apart <= BORDER_STEP) good++;
      }
      if (!n || good < FRAME_PAPER_MIN * n) return null;
      paperShare.push(good / n);
    }
    chosen.push(side);
  }
  // Paper along the borders taken as sides, on the whole; one may have a
  // little of the table or a neighbouring sheet in a corner.
  if (
    paperShare.length &&
    paperShare.reduce((a, b) => a + b, 0) < FRAME_PAPER * paperShare.length
  ) {
    return null;
  }
  const lines = chosen.map((l, e) => l ?? frame[e]);
  const corners: Point[] = [];
  for (let c = 0; c < 4; c++) {
    const x = intersect(lines[(c + 3) % 4], lines[c]);
    if (!x) return null;
    corners.push(x);
  }
  const quad: Quad = [corners[0], corners[1], corners[2], corners[3]];
  if (!isConvex(quad) || quadArea(quad) < FRAME_MIN_AREA * w * h) return null;
  const border = chosen.filter((l) => !l).length;
  return {
    quad,
    // A sheet cut off by the photo's border, rather than a scan filling it.
    offFrame:
      (border > 0 && border < 4) ||
      corners.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1),
    candidates: 1,
    tier: 'frame',
  };
}

/* ------------------------------------------------------------ clipping ---- */

/**
 * Fit a page quad whose corners may lie outside a `width` × `height` frame
 * into it: the largest rectangle of the page (in the page's own coordinates,
 * so the crop stays undistorted) whose photo lies inside the frame.
 * Returns the quad unchanged when it is already inside.
 */
export function clipToFrame(q: Quad, width: number, height: number): Quad {
  const tol = 0.5;
  const inFrame = ([x, y]: Point) =>
    x >= -tol && y >= -tol && x <= width + tol && y <= height + tol;
  if (q.every(inFrame)) return q;
  const unit: Quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const H = homography(unit, q);
  const map = (u: number, v: number): Point => applyHomography(H, u, v);
  const ok = (u: number, v: number) => {
    const [x, y] = map(u, v);
    return x >= 0 && y >= 0 && x <= width && y <= height;
  };

  let best: [number, number, number, number] | null = null;
  let bestArea = 0;
  // Each corner outside the frame is fixed by cutting one of its two sides;
  // try every combination of choices and keep the largest result.
  for (let choice = 0; choice < 16; choice++) {
    let u0 = 0;
    let u1 = 1;
    let v0 = 0;
    let v1 = 1;
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      const corners: [number, number, number][] = [
        [0, u0, v0],
        [1, u1, v0],
        [2, u1, v1],
        [3, u0, v1],
      ];
      for (const [c, u, v] of corners) {
        if (ok(u, v)) continue;
        changed = true;
        const cutU = (choice >> c) & 1;
        if (cutU) {
          // Move this corner's vertical side inward until the corner is in.
          const target = c === 0 || c === 3 ? u1 : u0;
          const nu = bisect(u, target, (x) => ok(x, v));
          if (c === 0 || c === 3) u0 = nu;
          else u1 = nu;
        } else {
          const target = c === 0 || c === 1 ? v1 : v0;
          const nv = bisect(v, target, (y) => ok(u, y));
          if (c === 0 || c === 1) v0 = nv;
          else v1 = nv;
        }
      }
      if (!changed) break;
    }
    if (!(ok(u0, v0) && ok(u1, v0) && ok(u1, v1) && ok(u0, v1))) continue;
    // Page area (in the page's own units) kept.
    const area = (u1 - u0) * (v1 - v0);
    if (area > bestArea) {
      bestArea = area;
      best = [u0, u1, v0, v1];
    }
  }
  if (!best || bestArea < 0.2) {
    // Nothing sensible: clamp the corners instead.
    return q.map(([x, y]) => [
      Math.min(width, Math.max(0, x)),
      Math.min(height, Math.max(0, y)),
    ]) as unknown as Quad;
  }
  const [u0, u1, v0, v1] = best;
  const clamp = ([x, y]: Point): Point => [
    Math.min(width, Math.max(0, x)),
    Math.min(height, Math.max(0, y)),
  ];
  return [clamp(map(u0, v0)), clamp(map(u1, v0)), clamp(map(u1, v1)), clamp(map(u0, v1))];
}

/** First point from `from` towards `to` where `inside` holds (assumes it holds at `to`). */
function bisect(from: number, to: number, inside: (x: number) => boolean): number {
  if (!inside(to)) return to;
  let a = from;
  let b = to;
  for (let i = 0; i < 30; i++) {
    const m = (a + b) / 2;
    if (inside(m)) b = m;
    else a = m;
  }
  return b;
}
