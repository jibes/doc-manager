import { describe, expect, it } from 'vitest';
import { estimatePaper, flattenPaper } from '../engine/imaging/background';
import { boxMean, darkClassLevel, gaussian, maxFilter, minFilter } from '../engine/imaging/box';
import { dilate, labelComponents, removeSmallComponents } from '../engine/imaging/components';
import { applyFilter, applyFilterForText } from '../engine/imaging/filters';
import { createFloat, rotateRGBA, toLuma, type Quad } from '../engine/imaging/image';
import { BLURRED_BELOW, isBlurred, sharpness } from '../engine/imaging/sharpness';
import { refineQuad } from '../engine/imaging/refine';
import { warpQuad } from '../engine/imaging/resample';
import { fill, photographedPage, px, setRect } from './helpers';

describe('warpQuad', () => {
  it('is the identity for the full-image quad at the same size', () => {
    const src = photographedPage(64, 48);
    const out = warpQuad(
      src,
      [
        [0, 0],
        [64, 0],
        [64, 48],
        [0, 48],
      ],
      64,
      48,
    );
    for (let i = 0; i < src.data.length; i++) {
      expect(Math.abs(out.data[i] - src.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it('maps quad corners to output corners (a mirrored quad flips the image)', () => {
    const src = fill(40, 40, [255, 255, 255]);
    setRect(src, 0, 0, 10, 10, [0, 0, 0]);
    const mirrored: Quad = [
      [40, 0],
      [0, 0],
      [0, 40],
      [40, 40],
    ];
    const out = warpQuad(src, mirrored, 40, 40);
    expect(px(out, 35, 5)[0]).toBeLessThan(10);
    expect(px(out, 5, 5)[0]).toBeGreaterThan(245);
  });

  it('averages instead of aliasing when shrinking a lot', () => {
    // One-pixel stripes shrunk 8x must come out mid-grey, not striped.
    const src = fill(800, 80, [255, 255, 255]);
    for (let x = 0; x < 800; x += 2) setRect(src, x, 0, x + 1, 80, [0, 0, 0]);
    const out = warpQuad(
      src,
      [
        [0, 0],
        [800, 0],
        [800, 80],
        [0, 80],
      ],
      100,
      10,
    );
    for (let x = 2; x < 98; x++) expect(Math.abs(px(out, x, 5)[0] - 127.5)).toBeLessThan(4);
  });

  it('antialiases a shrink along one axis only', () => {
    // Every third column black, shrunk 3x across but not down: point samples
    // would land on the same phase every time and come out all black.
    const src = fill(300, 40, [255, 255, 255]);
    for (let x = 1; x < 300; x += 3) setRect(src, x, 0, x + 1, 40, [0, 0, 0]);
    const out = warpQuad(
      src,
      [
        [0, 0],
        [300, 0],
        [300, 40],
        [0, 40],
      ],
      100,
      40,
    );
    for (let x = 2; x < 98; x++) expect(Math.abs(px(out, x, 20)[0] - 170)).toBeLessThan(4);
    // The same page on its side: the shrink is along the source's y axis.
    const turned = fill(40, 300, [255, 255, 255]);
    for (let y = 1; y < 300; y += 3) setRect(turned, 0, y, 40, y + 1, [0, 0, 0]);
    const side = warpQuad(
      turned,
      [
        [0, 300],
        [0, 0],
        [40, 0],
        [40, 300],
      ],
      100,
      40,
    );
    for (let x = 2; x < 98; x++) expect(Math.abs(px(side, x, 20)[0] - 170)).toBeLessThan(4);
  });
});

describe('rotateRGBA', () => {
  it('rotates clockwise in quarter turns', () => {
    const src = fill(3, 2, [255, 255, 255]);
    setRect(src, 0, 0, 1, 1, [0, 0, 0]); // top-left marker
    const r1 = rotateRGBA(src, 1);
    expect([r1.width, r1.height]).toEqual([2, 3]);
    expect(px(r1, 1, 0)[0]).toBe(0); // now top-right
    const r2 = rotateRGBA(src, 2);
    expect(px(r2, 2, 1)[0]).toBe(0); // now bottom-right
    expect(rotateRGBA(src, 4)).toBe(src);
  });
});

describe('box filters', () => {
  it('boxMean preserves a constant and a linear ramp', () => {
    const img = createFloat(50, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 50; x++) img.data[y * 50 + x] = x / 49;
    const out = boxMean(img, 4);
    // Mirrored borders keep a linear ramp centred, except right at the edge.
    for (let x = 5; x < 45; x++) expect(out.data[5 * 50 + x]).toBeCloseTo(x / 49, 5);
  });

  it('gaussian keeps the mean and spreads an impulse', () => {
    const img = createFloat(21, 21);
    img.data[10 * 21 + 10] = 1;
    const out = gaussian(img, 1);
    const sum = out.data.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 4);
    expect(out.data[10 * 21 + 10]).toBeCloseTo(1 / (2 * Math.PI), 2);
  });
});

describe('components', () => {
  it('labels 8-connected blobs and drops small ones', () => {
    const w = 10;
    const mask = new Uint8Array(w * w);
    // A diagonal (8-connected) line of 4 and an isolated pixel.
    for (let i = 0; i < 4; i++) mask[i * w + i] = 1;
    mask[9 * w + 9] = 1;
    const { labels, areas } = labelComponents(mask, w, w);
    expect(labels[0]).toBe(labels[3 * w + 3]);
    expect(areas[labels[0]]).toBe(4);
    removeSmallComponents(mask, w, w, 2);
    expect(mask[9 * w + 9]).toBe(0);
    expect(mask[0]).toBe(1);
  });

  it('merges a U shape that only connects at the bottom', () => {
    const w = 5;
    const mask = new Uint8Array([1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const { labels, areas } = labelComponents(mask, w, 3);
    expect(labels[0]).toBe(labels[4]);
    expect(areas[labels[0]]).toBe(9);
  });
});

describe('flattenPaper', () => {
  it('turns unevenly lit paper white and keeps ink dark, without halos', () => {
    const src = photographedPage();
    const grid = estimatePaper(src);
    expect(grid.cols * grid.rows).toBeGreaterThan(100);
    const flat = flattenPaper(src, grid);
    // Paper at the dark and the bright end of the gradient.
    expect(px(flat, 30, 400)[0]).toBeGreaterThan(240);
    expect(px(flat, 580, 400)[0]).toBeGreaterThan(240);
    // Paper directly between two text strokes is still paper.
    expect(px(flat, 100, 212)[1]).toBeGreaterThan(235);
    // Ink stays far below paper.
    expect(px(flat, 100, 201)[0]).toBeLessThan(80);
  });
});

describe('applyFilter', () => {
  const src = photographedPage();

  function stats(img: ReturnType<typeof applyFilter>) {
    let white = 0;
    for (let p = 0; p < img.data.length; p += 4) {
      if (img.data[p] === 255 && img.data[p + 1] === 255 && img.data[p + 2] === 255) white++;
    }
    return { white: white / (img.width * img.height) };
  }

  it('document: pure white paper, pure black text cores, colour kept', () => {
    const out = applyFilter(src, 'document');
    expect(stats(out).white).toBeGreaterThan(0.75);
    // Middle row of a 3 px stroke.
    expect(px(out, 120, 201)).toEqual([0, 0, 0]);
    // Logo stays blue.
    const [r, , b] = px(out, 100, 100);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(90);
    // Stamp outline stays red.
    const [sr, sg] = px(out, 382, 680);
    expect(sr).toBeGreaterThan(150);
    expect(sg).toBeLessThan(90);
  });

  it('does not blur: a stroke edge goes from black to white within 2 px', () => {
    const out = applyFilter(src, 'bw');
    // Column through a stroke at x=120: rows 200..202 are ink.
    const column = [196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206].map(
      (y) => px(out, 120, y)[0],
    );
    const intermediate = column.filter((v) => v > 10 && v < 245).length;
    expect(intermediate).toBeLessThanOrEqual(2);
    expect(Math.min(...column)).toBe(0);
    expect(column[0]).toBe(255);
    expect(column.at(-1)).toBe(255);
  });

  it('bw: solid dark shapes are filled, not hollow', () => {
    const out = applyFilter(src, 'bw');
    for (const [x, y] of [
      [100, 100],
      [100, 70],
      [125, 100],
    ]) {
      expect(px(out, x, y)[0]).toBeLessThan(30);
    }
  });

  it('removes a strip of table grazed by the crop at the border', () => {
    const page = photographedPage();
    setRect(page, 0, 0, 4, page.height, [60, 40, 25]);
    const out = applyFilter(page, 'bw');
    for (let y = 10; y < page.height; y += 50) expect(px(out, 1, y)[0]).toBe(255);
  });

  it('removes isolated specks but keeps text', () => {
    const page = photographedPage();
    // A lone dark pixel: at this page size a real full stop is 2-3 px across.
    setRect(page, 300, 150, 301, 151, [20, 20, 20]);
    const out = applyFilter(page, 'bw');
    expect(px(out, 300, 150)[0]).toBe(255);
    expect(px(out, 120, 201)[0]).toBe(0);
  });

  it('gray and bw are neutral, original keeps the photo', () => {
    for (const filter of ['gray', 'bw'] as const) {
      const out = applyFilter(src, filter);
      for (let p = 0; p < out.data.length; p += 4 * 97) {
        expect(out.data[p]).toBe(out.data[p + 1]);
        expect(out.data[p + 1]).toBe(out.data[p + 2]);
      }
    }
    const original = applyFilter(src, 'original', {
      ...{ brightness: 0, contrast: 0, threshold: 0 },
      sharpen: 0,
    });
    expect(original).toBe(src);
  });

  it('is deterministic', () => {
    const a = applyFilter(src, 'document');
    const b = applyFilter(src, 'document');
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('hands text recognition the flattened grey page for Document and B&W', () => {
    const gray = applyFilter(src, 'gray');
    for (const filter of ['document', 'bw'] as const) {
      const { image, reading } = applyFilterForText(src, filter);
      // The page itself is exactly what applyFilter gives.
      expect(Buffer.from(image.data).equals(Buffer.from(applyFilter(src, filter).data))).toBe(true);
      // The reading page is the Grey filter's: unthresholded, with mid-tones.
      expect(Buffer.from(reading.data).equals(Buffer.from(gray.data))).toBe(true);
    }
    // Other filters are read as they are.
    const color = applyFilterForText(src, 'color');
    expect(color.reading).toBe(color.image);
  });
});

describe('refineQuad', () => {
  it('snaps a rough quad onto the real page edges', () => {
    // Bright page on a dark table.
    const img = createFloat(400, 500);
    const truth: Quad = [
      [80.3, 60.7],
      [330.5, 75.2],
      [350.8, 440.4],
      [60.6, 420.9],
    ];
    // Rasterise with 4x4 supersampling so the edges are anti-aliased.
    const inside = (x: number, y: number) => {
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = truth[i];
        const [bx, by] = truth[(i + 1) % 4];
        if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
      }
      return true;
    };
    for (let y = 0; y < 500; y++) {
      for (let x = 0; x < 400; x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++)
            hits += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
        img.data[y * 400 + x] = 0.25 + 0.65 * (hits / 16);
      }
    }
    const rough = truth.map(([x, y], i) => [
      x + (i % 2 ? 6 : -5),
      y + (i < 2 ? -4 : 5),
    ]) as unknown as Quad;
    const refined = refineQuad(img, rough);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(refined[i][0] - truth[i][0], refined[i][1] - truth[i][1])).toBeLessThan(
        0.75,
      );
    }
  });

  it('snaps edges the detector placed one pixel off', () => {
    // A page from (100, 80) to (300, 400); the guess sits 1 px outside it.
    const img = createFloat(400, 500);
    for (let y = 0; y < 500; y++)
      for (let x = 0; x < 400; x++)
        img.data[y * 400 + x] = x >= 100 && x < 300 && y >= 80 && y < 400 ? 0.9 : 0.25;
    const truth: Quad = [
      [100, 80],
      [300, 80],
      [300, 400],
      [100, 400],
    ];
    const rough: Quad = [
      [99, 79],
      [301, 79],
      [301, 401],
      [99, 401],
    ];
    const refined = refineQuad(img, rough);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(refined[i][0] - truth[i][0], refined[i][1] - truth[i][1])).toBeLessThan(
        0.75,
      );
    }
  });

  it('puts the corners of a bowed sheet at its corners, not on the bulge', () => {
    // A sheet from (100, 80) to (300, 400) whose sides bulge out by 8 px
    // in the middle and whose top sags in by 6 px.
    const img = createFloat(400, 500);
    for (let y = 0; y < 500; y++) {
      for (let x = 0; x < 400; x++) {
        const bulge = 8 * Math.sin((Math.PI * Math.min(320, Math.max(0, y - 80))) / 320);
        const sag = 6 * Math.sin((Math.PI * Math.min(200, Math.max(0, x - 100))) / 200);
        const on = x >= 100 - bulge && x < 300 + bulge && y >= 80 + sag && y < 400;
        img.data[y * 400 + x] = on ? 0.9 : 0.25;
      }
    }
    const truth: Quad = [
      [100, 80],
      [300, 80],
      [300, 400],
      [100, 400],
    ];
    const rough: Quad = [
      [96, 84],
      [305, 83],
      [303, 404],
      [97, 397],
    ];
    const err = (q: Quad) =>
      Math.max(...q.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
    // A line through each whole side misses the corners...
    expect(err(refineQuad(img, rough, 12))).toBeGreaterThan(3);
    // ...lines through the halves next to them do not.
    expect(err(refineQuad(img, rough, 12, { local: true }))).toBeLessThan(2);
  });

  it('leaves the corners of a flat page alone in local mode', () => {
    const img = createFloat(400, 500);
    for (let y = 0; y < 500; y++)
      for (let x = 0; x < 400; x++)
        img.data[y * 400 + x] = x >= 100 && x < 300 && y >= 80 && y < 400 ? 0.9 : 0.25;
    const rough: Quad = [
      [98, 81],
      [302, 79],
      [301, 402],
      [99, 398],
    ];
    expect(refineQuad(img, rough, 8, { local: true })).toEqual(refineQuad(img, rough, 8));
  });

  it('keeps the input when there is no edge to find', () => {
    const flat = createFloat(200, 200);
    flat.data.fill(0.5);
    const quad: Quad = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
    ];
    expect(refineQuad(flat, quad)).toEqual(quad);
  });
});

/**
 * Paint a rectangle with camera-like soft edges: coverage ramps linearly over
 * `blur` pixels across each edge, centred on the true edge.
 */
function softRect(
  img: ReturnType<typeof fill>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
  blur = 3,
) {
  const pad = Math.ceil(blur);
  for (
    let y = Math.max(0, Math.floor(y0) - pad);
    y < Math.min(img.height, Math.ceil(y1) + pad);
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(x0) - pad);
      x < Math.min(img.width, Math.ceil(x1) + pad);
      x++
    ) {
      const cx = Math.min(1, Math.max(0, Math.min(x + 0.5 - x0, x1 - x - 0.5) / blur + 0.5));
      const cy = Math.min(1, Math.max(0, Math.min(y + 0.5 - y0, y1 - y - 0.5) / blur + 0.5));
      const coverage = cx * cy;
      const p = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[p + c] = Math.min(img.data[p + c], 235 - (235 - level) * coverage);
      }
    }
  }
}

describe('text fidelity on a camera-blurred page', () => {
  // A4-proportioned page, so the size-relative rules see a realistic page.
  const W = 1240;
  const H = 1754;

  function page() {
    const img = fill(W, H, [235, 235, 235]);
    // Body text stand-ins: 4 px strokes, dark, soft edges.
    for (let i = 0; i < 6; i++) softRect(img, 300 + i * 40, 400, 304 + i * 40, 440, 20);
    // An umlaut-sized dot: 5x5.
    softRect(img, 700, 400, 705, 405, 20, 1.5);
    // A thin grey table rule, crisp.
    softRect(img, 150, 700, 1100, 702, 120, 1.2);
    // A fold: a faint, soft horizontal shadow band across part of the page.
    softRect(img, 400, 1000, 900, 1004, 175, 6);
    return img;
  }

  const out = applyFilter(page(), 'document');

  it('keeps the true stroke width instead of fattening it', () => {
    // Count ink pixels across one 4 px stroke.
    let ink = 0;
    for (let x = 290; x < 316; x++) ink += 1 - px(out, x, 420)[0] / 255;
    expect(ink).toBeGreaterThan(3);
    expect(ink).toBeLessThan(5);
  });

  it('keeps small dots such as umlauts', () => {
    expect(px(out, 702, 402)[0]).toBeLessThan(60);
  });

  it('keeps a thin grey rule along its whole length, and grey', () => {
    for (let x = 170; x < 1080; x += 50) {
      const v = Math.min(px(out, x, 700)[0], px(out, x, 701)[0]);
      expect(v).toBeLessThan(200);
    }
    expect(px(out, 600, 700)[0]).toBeGreaterThan(20);
  });

  it('removes fold shading', () => {
    for (let x = 420; x < 880; x += 40) expect(px(out, x, 1002)[0]).toBe(255);
  });
});

describe('low-resolution previews keep every letter', () => {
  // A 1600 px page, as the page editor renders it.
  const W = 1131;
  const H = 1600;

  it('does not mistake left-margin words for punch holes', () => {
    const img = fill(W, H, [235, 235, 235]);
    // Two word-sized blobs at the left margin, 80 mm apart on A4 (as in
    // "Prod.-Nr." and a footer line), but of different widths, so their
    // centres differ the way text does and punched holes never do.
    softRect(img, 70, 500, 104, 512, 20, 1.5);
    softRect(img, 70, 930, 118, 942, 20, 1.5);
    const out = applyFilter(img, 'document');
    expect(px(out, 86, 506)[0]).toBeLessThan(60);
    expect(px(out, 94, 936)[0]).toBeLessThan(60);
  });

  it('keeps a 2 px dot', () => {
    const img = fill(W, H, [235, 235, 235]);
    softRect(img, 500, 500, 502, 502, 25, 1);
    const out = applyFilter(img, 'document');
    expect(px(out, 500, 500)[0]).toBeLessThan(120);
  });
});

describe('text near the page edge and the margins is never removed', () => {
  it('keeps a line of faint small letters below darker text', () => {
    // A footer partly in shadow: one line comes out dark, the next only
    // faintly, its letters each smaller than a speck threshold would allow.
    const W = 2480;
    const H = 3500;
    const img = fill(W, H, [235, 235, 235]);
    for (let i = 0; i < 8; i++) {
      softRect(img, 600 + i * 16, 3390, 606 + i * 16, 3402, 20, 1.5);
      softRect(img, 600 + i * 16, 3420, 606 + i * 16, 3432, 145, 1.5);
    }
    const out = applyFilter(img, 'bw');
    for (let i = 0; i < 8; i++) expect(px(out, 603 + i * 16, 3426)[0]).toBeLessThan(100);
  });

  it('keeps soft full stops next to text', () => {
    // On a soft photo a full stop never gets dark: faint, tiny, but on a line
    // of text, so it stays.
    const W = 2480;
    const H = 3500;
    const img = fill(W, H, [235, 235, 235]);
    for (let i = 0; i < 6; i++) softRect(img, 800 + i * 30, 1000, 812 + i * 30, 1030, 25, 1.5);
    softRect(img, 985, 1024, 990, 1029, 145, 1.5);
    const out = applyFilter(img, 'document');
    expect(px(out, 987, 1026)[0]).toBeLessThan(200);
  });

  it('keeps a line of small text set just inside the bottom edge', () => {
    // A tightly cropped page: the last line sits within the border band.
    const W = 2480;
    const H = 3500;
    const img = fill(W, H, [235, 235, 235]);
    for (let i = 0; i < 12; i++) softRect(img, 1800 + i * 28, 3462, 1810 + i * 28, 3484, 25, 1.5);
    // A full stop.
    softRect(img, 2150, 3478, 2156, 3484, 25, 1);
    const out = applyFilter(img, 'document');
    for (let i = 0; i < 12; i++) expect(px(out, 1805 + i * 28, 3473)[0]).toBeLessThan(60);
    expect(px(out, 2153, 3481)[0]).toBeLessThan(100);
  });

  it('keeps word-shaped blobs at the margin, even at punch-hole spacing', () => {
    // Words like "Bei" at a narrow left margin, 80 mm apart on A4: hole-ish
    // position and spacing, but only as tall as a line of text.
    const W = 2480;
    const H = 3508;
    const img = fill(W, H, [235, 235, 235]);
    softRect(img, 110, 1200, 170, 1230, 20, 2);
    softRect(img, 110, 2145, 175, 2175, 20, 2);
    const out = applyFilter(img, 'document');
    expect(px(out, 140, 1215)[0]).toBeLessThan(60);
    expect(px(out, 142, 2160)[0]).toBeLessThan(60);
  });
});

describe('morphology and level helpers', () => {
  function random(w: number, h: number, seed = 1) {
    const img = createFloat(w, h);
    let s = seed;
    for (let i = 0; i < img.data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      img.data[i] = s / 2 ** 32;
    }
    return img;
  }

  it('minFilter and maxFilter match a brute-force window', () => {
    const img = random(37, 23);
    const r = 3;
    const lo = minFilter(img, r);
    const hi = maxFilter(img, r);
    for (let y = 0; y < 23; y++) {
      for (let x = 0; x < 37; x++) {
        let mn = 1;
        let mx = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(22, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(36, x + r); xx++) {
            mn = Math.min(mn, img.data[yy * 37 + xx]);
            mx = Math.max(mx, img.data[yy * 37 + xx]);
          }
        }
        expect(lo.data[y * 37 + x]).toBe(mn);
        expect(hi.data[y * 37 + x]).toBe(mx);
      }
    }
  });

  it('dilate with radius 2 equals two 3x3 dilations', () => {
    const w = 30;
    const h = 20;
    const mask = new Uint8Array(w * h);
    for (const i of [0, 47, 312, 599, 250]) mask[i] = 1;
    expect(dilate(mask, w, h, 2)).toEqual(dilate(dilate(mask, w, h), w, h));
  });

  it('darkClassLevel tracks stroke darkness, not stray black specks', () => {
    // Grey strokes (0.5) on paper (1.0), with 1% of pixels pure black.
    const w = 120;
    const h = 60;
    const img = createFloat(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) img.data[y * w + x] = x % 12 < 4 ? 0.5 : 1;
    }
    for (let i = 0; i < img.data.length; i += 97) img.data[i] = 0;
    const level = darkClassLevel(img, 10);
    const centre = level.data[30 * w + 60];
    expect(centre).toBeGreaterThan(0.4);
    expect(centre).toBeLessThan(0.55);
    // The plain minimum would have said black.
    expect(minFilter(img, 10).data[30 * w + 60]).toBe(0);
  });
});

describe('sharpness', () => {
  function textPage() {
    const img = fill(800, 1000, [235, 235, 235]);
    // Strokes in both orientations, like letters.
    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < 20; col++) {
        const x = 60 + col * 34;
        const y = 80 + row * 70;
        if ((row + col) % 2) softRect(img, x, y, x + 5, y + 26, 30, 1);
        else softRect(img, x, y + 10, x + 22, y + 15, 30, 1);
      }
    }
    return toLuma(img);
  }

  function motionBlur(src: ReturnType<typeof toLuma>, n: number) {
    const out = createFloat(src.width, src.height);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let s = 0;
        let c = 0;
        for (let k = 0; k < n; k++) {
          const xx = Math.round(x + 0.8 * (k - n / 2));
          const yy = Math.round(y + 0.6 * (k - n / 2));
          if (xx >= 0 && yy >= 0 && xx < src.width && yy < src.height) {
            s += src.data[yy * src.width + xx];
            c++;
          }
        }
        out.data[y * src.width + x] = s / c;
      }
    }
    return out;
  }

  it('scores a sharp page above the threshold and a shaken one below', () => {
    const page = textPage();
    expect(sharpness(page)).toBeGreaterThan(BLURRED_BELOW);
    expect(sharpness(motionBlur(page, 14))).toBeLessThan(BLURRED_BELOW);
  });

  it('flags pages by their stored score', () => {
    expect(isBlurred({ sharpness: 1.2 })).toBe(true);
    expect(isBlurred({ sharpness: 2.4 })).toBe(false);
    expect(isBlurred({ sharpness: null })).toBe(false);
  });
});
