import { describe, expect, it } from 'vitest';
import {
  flipBox,
  isSideways,
  isUpsideDown,
  lineAxes,
  sampleLines,
  sidewaysChoice,
} from '../engine/ocr/orientation';
import type { TextBox } from '../engine/ocr/paddle';

/** A detector probability map with text-line blobs at the given rectangles. */
function probMap(width: number, height: number, rects: [number, number, number, number][]) {
  const prob = new Float32Array(width * height);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * width + x] = 0.9;
  }
  return prob;
}

/** Ten lines of text, 4 px tall and 60-90 px long, or the same turned sideways. */
function lines(sideways: boolean): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const len = 60 + 3 * i;
    out.push(
      sideways ? [10 + i * 9, 10, 14 + i * 9, 10 + len] : [10, 10 + i * 9, 10 + len, 14 + i * 9],
    );
  }
  return out;
}

describe('lineAxes / isSideways', () => {
  it('reads an upright page as upright', () => {
    const axes = lineAxes(probMap(120, 120, lines(false)), 120, 120);
    expect(axes.wideCount).toBe(10);
    expect(isSideways(axes)).toBe(false);
  });

  it('finds text running up and down the page', () => {
    const axes = lineAxes(probMap(120, 120, lines(true)), 120, 120);
    expect(axes.tallCount).toBe(10);
    expect(isSideways(axes)).toBe(true);
  });

  it('does not call a page of single characters or blobs sideways', () => {
    // A few tall marks (a table's rules, a signature) among upright text.
    const rects = [...lines(false), [100, 5, 103, 110] as [number, number, number, number]];
    expect(isSideways(lineAxes(probMap(120, 120, rects), 120, 120))).toBe(false);
    const squares: [number, number, number, number][] = [];
    for (let i = 0; i < 8; i++) squares.push([10 + i * 12, 50, 18 + i * 12, 58]);
    expect(isSideways(lineAxes(probMap(120, 120, squares), 120, 120))).toBe(false);
  });
});

describe('flipBox', () => {
  it('maps a tilted line onto the page turned by 180°', () => {
    const box: TextBox = { x0: 10, x1: 110, y0: 20, y1: 34, score: 1, yl: 25, yr: 29, height: 8 };
    const flipped = flipBox(box, 200, 100);
    expect(flipped).toMatchObject({ x0: 90, x1: 190, y0: 66, y1: 80, yl: 71, yr: 75, height: 8 });
    // Twice is the identity.
    expect(flipBox(flipped, 200, 100)).toMatchObject(box);
  });
});

describe('sampleLines', () => {
  it('picks the longest proper lines', () => {
    const box = (w: number, h = 10): TextBox => ({ x0: 0, x1: w, y0: 0, y1: h, score: 1 });
    const picked = sampleLines([box(30), box(200), box(35, 30), box(120), box(80)], 2);
    expect(picked.map((b) => b.x1)).toEqual([200, 120]);
  });
});

describe('isUpsideDown', () => {
  it('flips when every line reads much better turned', () => {
    expect(isUpsideDown([0.4, 0.5, 0.45, 0.3], [0.95, 0.9, 0.97, 0.92])).toBe(true);
  });

  it('keeps an upright page', () => {
    expect(isUpsideDown([0.95, 0.9, 0.97, 0.92], [0.4, 0.5, 0.45, 0.3])).toBe(false);
  });

  it('does not flip on weak or mixed evidence', () => {
    // Too few lines.
    expect(isUpsideDown([0.3, 0.3], [0.95, 0.95])).toBe(false);
    // Small gain.
    expect(isUpsideDown([0.8, 0.82, 0.85, 0.8], [0.88, 0.9, 0.9, 0.86])).toBe(false);
    // Half the lines disagree (e.g. a page with mixed orientations).
    expect(isUpsideDown([0.3, 0.95, 0.3, 0.95], [0.95, 0.4, 0.95, 0.5])).toBe(false);
    // Neither way is readable text.
    expect(isUpsideDown([0.2, 0.25, 0.2, 0.3], [0.45, 0.5, 0.4, 0.5])).toBe(false);
  });
});

describe('sidewaysChoice', () => {
  it('picks the readable one of the two quarter turns', () => {
    expect(sidewaysChoice([0.9, 0.95, 0.9], [0.4, 0.3, 0.5])).toBe('as-is');
    expect(sidewaysChoice([0.4, 0.3, 0.5], [0.9, 0.95, 0.9])).toBe('turned');
  });

  it('gives up when neither reads as text', () => {
    expect(sidewaysChoice([0.3, 0.4, 0.35], [0.4, 0.3, 0.45])).toBe('neither');
    expect(sidewaysChoice([0.9], [0.3])).toBe('neither');
  });
});
