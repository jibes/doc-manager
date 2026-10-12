import { describe, expect, it } from 'vitest';
import { DragFilter } from '../dragFilter';
import type { Point } from '../engine/imaging/image';

/** Drag in a straight line from `a` to `b` over `ms`, one event per 16 ms. */
function drag(f: DragFilter, a: Point, b: Point, t0: number, ms: number): number {
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    f.move([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], t0 + (ms * i) / steps);
  }
  return t0 + ms;
}

describe('DragFilter', () => {
  it('follows the finger one to one while dragging', () => {
    const f = new DragFilter();
    f.start([10, 10], 0);
    drag(f, [10, 10], [110, 60], 0, 300);
    expect(f.move([111, 60], 316)).toEqual([111, 60]);
  });

  it('undoes a small, fast shift as the finger lifts after resting', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    let t = drag(f, [0, 0], [100, 100], 0, 400);
    // Rests (tiny tremor only), then rolls off the glass by 5 px in 50 ms.
    f.move([100.5, 100], t + 100);
    t += 300;
    f.move([102, 103], t + 20);
    f.move([103, 104], t + 40);
    expect(f.end([104, 103], t + 50)).toEqual([100.5, 100]);
  });

  it('undoes lift jitter after a rest longer than the history it keeps', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    const t = drag(f, [0, 0], [50, 50], 0, 200);
    // Two seconds without a move event, then a 5 px roll-off.
    f.move([53, 53], t + 2000);
    expect(f.end([54, 53], t + 2030)).toEqual([50, 50]);
  });

  it('keeps the final point when the finger was still moving', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    // A slow, steady drag: 4 px per event.
    const t = drag(f, [0, 0], [100, 0], 0, 400);
    expect(f.end([104, 0], t + 16)).toEqual([104, 0]);
  });

  it('keeps a slow creep that ends in a small move', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    // 1 px per event: under the jitter limit within the release window.
    const t = drag(f, [0, 0], [30, 0], 0, 480);
    expect(f.end([31, 0], t + 16)).toEqual([31, 0]);
  });

  it('keeps a deliberate large move right before lifting', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    f.move([50, 50], 100);
    f.move([50, 50.5], 400);
    f.move([60, 50], 430);
    expect(f.end([70, 50], 450)).toEqual([70, 50]);
  });

  it('keeps the shift when the release window was long ago', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    f.move([50, 50], 100);
    f.move([54, 50], 300);
    // Lifted 200 ms after the last move: that move was deliberate.
    expect(f.end([54, 50], 500)).toEqual([54, 50]);
  });

  it('moves at half speed after resting, and returns to full speed on a fast move', () => {
    const f = new DragFilter();
    f.start([0, 0], 0);
    f.move([20, 0], 50);
    // Rest 400 ms, then creep 10 px.
    expect(f.move([25, 0], 450)).toEqual([22.5, 0]);
    expect(f.fine).toBe(true);
    expect(f.move([30, 0], 500)).toEqual([25, 0]);
    // A quick swipe: 40 px in 16 ms.
    expect(f.move([70, 0], 516)).toEqual([65, 0]);
    expect(f.fine).toBe(false);
  });

  it('is relative: the result starts where the finger touched down', () => {
    const f = new DragFilter();
    expect(f.start([5, 7], 0)).toEqual([5, 7]);
    expect(f.move([6, 9], 16)).toEqual([6, 9]);
  });
});
