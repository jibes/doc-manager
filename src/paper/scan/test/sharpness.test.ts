import { describe, expect, it } from 'vitest';
import { createFloat, type FloatImage } from '../engine/imaging/image';
import { BLURRED_BELOW, sharpness } from '../engine/imaging/sharpness';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A page of "text": rows of letter-sized marks (vertical, horizontal and
 * diagonal strokes, 2 px thick) in `ink` on `paper`, rendered with 4x4
 * supersampling so edges are anti-aliased like a camera's.
 */
function textPage(size: number, ink: number, paper: number): FloatImage {
  const img = createFloat(size, size);
  const r = rng(7);
  const strokes: ((x: number, y: number) => boolean)[] = [];
  for (let row = 20; row < size - 30; row += 22) {
    for (let x = 20; x < size - 30; x += 11) {
      if (r() < 0.15) continue;
      const kind = Math.floor(r() * 4);
      const x0 = x;
      const y0 = row;
      if (kind === 0) strokes.push((px, py) => px >= x0 && px < x0 + 2 && py >= y0 && py < y0 + 12);
      else if (kind === 1)
        strokes.push((px, py) => px >= x0 && px < x0 + 8 && py >= y0 + 5 && py < y0 + 7);
      else if (kind === 2)
        strokes.push(
          (px, py) => py >= y0 && py < y0 + 12 && Math.abs(px - x0 - (py - y0) * 0.6) < 1.1,
        );
      else
        strokes.push(
          (px, py) =>
            px >= x0 &&
            px < x0 + 8 &&
            py >= y0 &&
            py < y0 + 12 &&
            Math.abs(px - x0 - 4) + Math.abs(py - y0 - 6) < 4.5 &&
            Math.abs(px - x0 - 4) + Math.abs(py - y0 - 6) > 2.5,
        );
    }
  }
  // Anything above or left of the first row or column is paper.
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n;
          const py = y + (sy + 0.5) / n;
          const row = Math.floor((py - 20) / 22);
          const col = Math.floor((px - 20) / 11);
          if (row < 0 || col < 0) continue;
          if (strokes.some((s) => s(px, py))) hits++;
        }
      }
      img.data[y * size + x] = paper + ((ink - paper) * hits) / (n * n);
    }
  }
  return img;
}

/** Box blur along x over `length` pixels: a horizontal shake. */
function motionBlur(img: FloatImage, length: number): FloatImage {
  const out = createFloat(img.width, img.height);
  const half = (length - 1) / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let s = 0;
      let c = 0;
      for (let k = -Math.floor(half); k <= Math.ceil(half); k++) {
        const xx = Math.min(img.width - 1, Math.max(0, x + k));
        s += img.data[y * img.width + xx];
        c++;
      }
      out.data[y * img.width + x] = s / c;
    }
  }
  return out;
}

describe('sharpness', { timeout: 30_000 }, () => {
  const sharp = textPage(320, 0.1, 0.9);

  it('passes a sharp page', () => {
    expect(sharpness(sharp)).toBeGreaterThan(BLURRED_BELOW);
  });

  it('passes a sharp page printed in faint grey', () => {
    expect(sharpness(textPage(320, 0.72, 0.9))).toBeGreaterThan(BLURRED_BELOW);
  });

  it('flags a page smeared by a shake in one direction', () => {
    expect(sharpness(motionBlur(sharp, 7))).toBeLessThan(BLURRED_BELOW);
  });
});
