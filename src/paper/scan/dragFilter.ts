import type { Point } from './engine/imaging/image';

/**
 * Smooths a finger dragging a crop handle, in stage (CSS pixel) coordinates.
 *
 * - **Relative:** callers move the handle by the returned point's change since
 *   `start`, so a handle never jumps to the finger when it is touched.
 * - **Fine:** once the finger has rested for a moment, further movement counts
 *   half, for placing a corner on the exact pixel; a quick move ends it.
 * - **Lift:** a finger leaving the glass rolls its contact patch, and the last
 *   few move events shift the point by a few pixels. On release, a small, fast
 *   shift in the final moments after the finger had settled is undone.
 */

export interface DragFilterOptions {
  /** Release window: movement within this long before lifting may be lift jitter. */
  liftMs: number;
  /** Movement in the release window at most this far (CSS px) is treated as jitter. */
  liftPx: number;
  /** Before the release window the finger must have been within `stillPx` for this long. */
  settleMs: number;
  /** A finger within this distance (CSS px) counts as resting. */
  stillPx: number;
  /** Resting this long switches to fine movement. */
  fineAfterMs: number;
  /** Gain while fine: handle movement per finger movement. */
  fineGain: number;
  /** A finger faster than this (px/ms) leaves fine movement. */
  fastSpeed: number;
}

export const DRAG_DEFAULTS: DragFilterOptions = {
  liftMs: 90,
  liftPx: 8,
  settleMs: 120,
  stillPx: 2.5,
  fineAfterMs: 350,
  fineGain: 0.5,
  fastSpeed: 0.6,
};

interface Sample {
  t: number;
  /** Where the finger is. */
  raw: Point;
  /** Where the filtered pointer is. */
  out: Point;
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Keep this much history; enough for the release decision. */
const HISTORY_MS = 600;

export class DragFilter {
  readonly options: DragFilterOptions;
  private history: Sample[] = [];
  private out: Point = [0, 0];
  private rest: { point: Point; t: number } = { point: [0, 0], t: 0 };
  /** Fine (reduced gain) movement is active. */
  fine = false;

  constructor(options: Partial<DragFilterOptions> = {}) {
    this.options = { ...DRAG_DEFAULTS, ...options };
  }

  /** The finger touched down at `p`; returns the filtered pointer (= `p`). */
  start(p: Point, t: number): Point {
    this.out = p;
    this.fine = false;
    this.rest = { point: p, t };
    this.history = [{ t, raw: p, out: p }];
    return p;
  }

  /** The finger moved to `p`; returns the filtered pointer. */
  move(p: Point, t: number): Point {
    const o = this.options;
    const last = this.history.at(-1);
    if (!last) return this.start(p, t);
    if (dist(p, this.rest.point) > o.stillPx) {
      // Leaving a rest: one long enough starts fine movement.
      if (t - this.rest.t >= o.fineAfterMs) this.fine = true;
      this.rest = { point: p, t };
    }
    const dt = Math.max(1, t - last.t);
    if (this.fine && dist(p, last.raw) / dt > o.fastSpeed) this.fine = false;
    const gain = this.fine ? o.fineGain : 1;
    this.out = [
      this.out[0] + (p[0] - last.raw[0]) * gain,
      this.out[1] + (p[1] - last.raw[1]) * gain,
    ];
    this.history.push({ t, raw: p, out: this.out });
    // Old samples go, but not the one still in effect at the cutoff: after a
    // long rest it is where the finger is resting.
    while (this.history.length > 2 && this.history[1].t <= t - HISTORY_MS) this.history.shift();
    return this.out;
  }

  /** The finger lifted at `p`; returns where the handle should stay. */
  end(p: Point, t: number): Point {
    const final = this.move(p, t);
    const settled = settledSample(this.history, t, this.options);
    return settled ? settled.out : final;
  }
}

/**
 * The sample to keep when the finger lifts at `upTime`, or null to keep the
 * final one. That is the last sample before the release window, provided the
 * finger had come to rest there and moved only a little, quickly, afterwards.
 */
function settledSample(history: Sample[], upTime: number, o: DragFilterOptions): Sample | null {
  const final = history.at(-1);
  if (!final || history.length < 2) return null;
  let anchorIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].t <= upTime - o.liftMs) {
      anchorIndex = i;
      break;
    }
  }
  // A drag shorter than the release window: the touch-down point is the rest.
  const anchor = history[Math.max(0, anchorIndex)];
  if (anchor === final) return null;
  if (dist(anchor.raw, final.raw) > o.liftPx) return null;
  // The finger must have come to rest at the anchor, not be dragging slowly
  // through it, in the moments before the release window. Move events stop
  // while it rests, so the anchor holds until the next sample.
  const settleStart = upTime - o.liftMs - o.settleMs;
  for (let i = anchorIndex - 1; i >= 0 && history[i + 1].t > settleStart; i--) {
    if (dist(history[i].raw, anchor.raw) > o.stillPx) return null;
  }
  return anchor;
}
