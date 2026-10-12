import { createRGBA, type RGBAImage } from '../engine/imaging/image';

export function fill(width: number, height: number, rgb: [number, number, number]): RGBAImage {
  const img = createRGBA(width, height);
  for (let p = 0; p < img.data.length; p += 4) {
    img.data[p] = rgb[0];
    img.data[p + 1] = rgb[1];
    img.data[p + 2] = rgb[2];
    img.data[p + 3] = 255;
  }
  return img;
}

export function setRect(
  img: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      img.data[p] = rgb[0];
      img.data[p + 1] = rgb[1];
      img.data[p + 2] = rgb[2];
    }
  }
}

export function px(img: RGBAImage, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

/**
 * A photographed page: off-white paper under a strong lighting gradient,
 * horizontal "text" strokes (3 px dark bars), a solid blue logo and a red
 * stamp outline, plus deterministic sensor noise.
 */
export function photographedPage(width = 600, height = 800): RGBAImage {
  const img = createRGBA(width, height);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 8;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = 0.55 + 0.4 * (x / width) * (1 - 0.3 * (y / height));
      let rgb: [number, number, number] = [245, 238, 220];
      // Text lines: rows of 3 px strokes with gaps, from y=200.
      const row = y - 200;
      if (row >= 0 && row < 400 && row % 24 < 3 && x > 60 && x < width - 60 && x % 40 < 30) {
        rgb = [30, 30, 35];
      }
      // Solid blue logo.
      if (Math.hypot(x - 100, y - 100) < 40) rgb = [25, 90, 200];
      // Red stamp outline, 5 px thick.
      const inOuter = x > 380 && x < 540 && y > 640 && y < 720;
      const inInner = x > 385 && x < 535 && y > 645 && y < 715;
      if (inOuter && !inInner) rgb = [200, 30, 40];
      const p = (y * width + x) * 4;
      img.data[p] = rgb[0] * light + noise();
      img.data[p + 1] = rgb[1] * light + noise();
      img.data[p + 2] = rgb[2] * light + noise();
      img.data[p + 3] = 255;
    }
  }
  return img;
}
