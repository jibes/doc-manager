import { describe, expect, it } from 'vitest';
import {
  clipToFrame,
  colourPlanes,
  edgeHits,
  frameSearch,
  printedLine,
  quadSupport,
  quadSupported,
  searchQuad,
  snapCorners,
} from '../engine/detect/quadSearch';
import { createRGBA, type Point, type Quad, type RGBAImage } from '../engine/imaging/image';
import { applyHomography, homography, isConvex } from '../engine/imaging/quad';

type RGB = [number, number, number];

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A wood-like table: brown with faint grain streaks and sensor noise. */
function table(width: number, height: number, seed = 1): RGBAImage {
  const img = createRGBA(width, height);
  const r = rng(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grain = 12 * Math.sin(x * 0.05 + Math.sin(y * 0.02) * 3);
      const n = (r() - 0.5) * 8;
      const p = (y * width + x) * 4;
      img.data[p] = 120 + grain + n;
      img.data[p + 1] = 80 + grain * 0.7 + n;
      img.data[p + 2] = 50 + grain * 0.4 + n;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

/**
 * Paint a page (a rectangle of `pw` × `ph` page units) into the photo at
 * `quad`, coloured per page position by `paint`.
 */
function paintPage(
  img: RGBAImage,
  quad: Quad,
  pw: number,
  ph: number,
  paint: (u: number, v: number) => RGB | null,
): void {
  const toPage = homography(quad, [
    [0, 0],
    [pw, 0],
    [pw, ph],
    [0, ph],
  ]);
  // 4x4 supersampling: edges are anti-aliased, as in a photo.
  const n = 4;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [u, v] = applyHomography(toPage, x + (sx + 0.5) / n, y + (sy + 0.5) / n);
          const c = u < 0 || v < 0 || u >= pw || v >= ph ? null : paint(u, v);
          if (!c) continue;
          hits++;
          for (let k = 0; k < 3; k++) sum[k] += c[k];
        }
      }
      if (!hits) continue;
      const a = hits / (n * n);
      for (let k = 0; k < 3; k++) img.data[p + k] = (sum[k] / hits) * a + img.data[p + k] * (1 - a);
    }
  }
}

/** A text page: off-white with rows of dark "words". */
function text(u: number, v: number): RGB {
  const row = Math.floor(v / 10);
  if (v > 30 && v < 270 && v % 10 < 3 && u > 20 && u < 190 && (Math.floor(u / 17) + row) % 5) {
    return [40, 40, 40];
  }
  return [235, 233, 226];
}

function maxError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

const PAGE: Quad = [
  [70, 60],
  [330, 75],
  [345, 450],
  [55, 440],
];

describe('searchQuad', () => {
  it('finds a page whose edges are the only long straight lines', () => {
    const img = table(400, 520);
    paintPage(img, PAGE, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
    expect(result!.offFrame).toBe(false);
  });

  it('extends a quad bounded by a photo edge out to the real page edge', () => {
    const img = table(400, 520);
    // A full-bleed photo across the top third of the page, darker than the
    // table, as on a brochure: the detector stops at its lower edge.
    paintPage(img, PAGE, 210, 297, (u, v) => (v < 100 ? [40, 90, 160] : text(u, v)));
    const planes = colourPlanes(img, 1);
    const toPhoto = homography(
      [
        [0, 0],
        [210, 0],
        [210, 297],
        [0, 297],
      ],
      PAGE,
    );
    const at = (u: number, v: number): Point => applyHomography(toPhoto, u, v);
    const lowerPart: Quad = [at(0, 100), at(210, 100), at(210, 297), at(0, 297)];
    // The detector's quad is a fine quad on its own...
    expect(quadSupported(planes, lowerPart)).toBe(true);
    // ...but the page goes on beyond it.
    const result = searchQuad(planes, { contain: lowerPart });
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
  });

  it('does not run a side on past the corner along a table edge', () => {
    const img = table(400, 520);
    // A long dark straight edge (the table's) just below the page, in line
    // with nothing on it: a quad down to it has unsupported side ends.
    for (let y = 470; y < 520; y++) {
      for (let x = 0; x < 400; x++) {
        const p = (y * 400 + x) * 4;
        img.data[p] = 30;
        img.data[p + 1] = 30;
        img.data[p + 2] = 35;
      }
    }
    paintPage(img, PAGE, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
  });

  it('finds a page that fills nearly the whole frame', () => {
    const img = table(400, 520);
    const big: Quad = [
      [12, 8],
      [392, 14],
      [388, 512],
      [6, 506],
    ];
    paintPage(img, big, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, big)).toBeLessThan(2.5);
  });

  it('flags a page running off the frame', () => {
    const img = table(400, 520);
    const off: Quad = [
      [90, 40],
      [450, 70],
      [420, 480],
      [70, 470],
    ];
    paintPage(img, off, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(result!.offFrame).toBe(true);
    // Its right side is out of view: the frame's border stands in for it.
    const visible: Quad = [
      [90, 40],
      [400, 65.8],
      [400, 479.4],
      [70, 470],
    ];
    expect(maxError(result!.quad, visible)).toBeLessThan(3);
  });

  it('finds nothing on an empty table', () => {
    expect(searchQuad(colourPlanes(table(400, 520), 1))).toBeNull();
  });
});

/** Cork: brown with dark and light blotches. */
function cork(width: number, height: number, seed = 7): RGBAImage {
  const img = createRGBA(width, height);
  const r = rng(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const blotch = 30 * Math.sin(x * 0.7 + Math.sin(y * 0.5) * 4) * Math.sin(y * 0.9 + x * 0.3);
      const n = (r() - 0.5) * 30;
      const p = (y * width + x) * 4;
      img.data[p] = 140 + blotch + n;
      img.data[p + 1] = 105 + blotch * 0.8 + n;
      img.data[p + 2] = 70 + blotch * 0.5 + n;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

/**
 * Like `paintPage`, but the sheet bows: its sides bulge out by `bulge` page
 * units in the middle and its top edge sags in by `sag`, with the corners
 * where the quad puts them (a sheet pinned at its corners).
 */
function paintBowed(
  img: RGBAImage,
  quad: Quad,
  pw: number,
  ph: number,
  bulge: number,
  sag: number,
  paint: (u: number, v: number) => RGB | null,
): void {
  const toPage = homography(quad, [
    [0, 0],
    [pw, 0],
    [pw, ph],
    [0, ph],
  ]);
  const n = 4;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [u, v] = applyHomography(toPage, x + (sx + 0.5) / n, y + (sy + 0.5) / n);
          const wide = bulge * Math.sin((Math.PI * Math.min(ph, Math.max(0, v))) / ph);
          const top = sag * Math.sin((Math.PI * Math.min(pw, Math.max(0, u))) / pw);
          if (u < -wide || u >= pw + wide || v < top || v >= ph) continue;
          const c = paint(Math.min(pw - 0.01, Math.max(0, u)), Math.max(0, v));
          if (!c) continue;
          hits++;
          for (let k = 0; k < 3; k++) sum[k] += c[k];
        }
      }
      if (!hits) continue;
      const a = hits / (n * n);
      for (let k = 0; k < 3; k++) img.data[p + k] = (sum[k] / hits) * a + img.data[p + k] * (1 - a);
    }
  }
}

function disc(img: RGBAImage, cx: number, cy: number, r: number, c: RGB): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      const p = (y * img.width + x) * 4;
      for (let k = 0; k < 3; k++) img.data[p + k] = c[k];
    }
  }
}

/** A notice with a header, text and two ruled price tables. */
function notice(u: number, v: number): RGB {
  const inTable = (v0: number) => v >= v0 && v <= v0 + 36 && u >= 25 && u <= 190;
  for (const v0 of [140, 195]) {
    if (inTable(v0) && ((v - v0) % 9 < 0.8 || Math.abs(u - 25) < 0.8 || Math.abs(u - 190) < 0.8)) {
      return [30, 30, 30];
    }
  }
  if (v > 60 && v < 75 && u > 60 && u < 150) return [40, 110, 190];
  return text(u, v);
}

/**
 * A notice pinned to a cork board: business cards above it, a second white
 * sheet overlapping it on the right (only a faint step between the two),
 * pushpins on three corners, and the sheet bowing between the pins.
 */
function pinBoard(): { img: RGBAImage; page: Quad } {
  const img = cork(400, 520);
  // Business cards along the top, their lower edges just above the page.
  paintPage(
    img,
    [
      [30, 2],
      [190, 4],
      [189, 47],
      [29, 45],
    ],
    1,
    1,
    () => [242, 240, 236],
  );
  paintPage(
    img,
    [
      [215, -6],
      [380, -3],
      [379, 50],
      [214, 47],
    ],
    1,
    1,
    () => [236, 232, 220],
  );
  // The neighbouring sheet, running off the frame on the right, a little
  // darker in the shade of the notice lying on it.
  paintPage(
    img,
    [
      [300, 62],
      [470, 66],
      [468, 490],
      [298, 486],
    ],
    210,
    297,
    (u, v) => {
      const c = text(u - 25, v);
      return c[0] < 100 ? c : [218, 217, 211];
    },
  );
  const page: Quad = [
    [56, 52],
    [326, 60],
    [318, 470],
    [50, 462],
  ];
  paintBowed(img, page, 210, 297, 4, 4, notice);
  disc(img, 60, 56, 8, [235, 235, 232]);
  disc(img, 322, 64, 8, [225, 200, 40]);
  disc(img, 54, 458, 8, [215, 205, 40]);
  return { img, page };
}

describe('relaxed search', () => {
  it('finds a bowed notice on a pin board, next to a second sheet', () => {
    const { img, page } = pinBoard();
    const planes = colourPlanes(img, 1);
    // No straight quad has all four sides on edges along their whole length.
    expect(searchQuad(planes)).toBeNull();
    const result = searchQuad(planes, { relaxed: {} });
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('relaxed');
    expect(maxError(result!.quad, page)).toBeLessThan(4);
    expect(result!.offFrame).toBe(false);
  });

  it('honours the quad it must contain', () => {
    const { img } = pinBoard();
    const tiny: Quad = [
      [10, 10],
      [390, 10],
      [390, 510],
      [10, 510],
    ];
    expect(searchQuad(colourPlanes(img, 1), { relaxed: { contain: tiny } })).toBeNull();
  });

  it('finds nothing on a bare cork board or table', () => {
    expect(searchQuad(colourPlanes(cork(400, 520), 1), { relaxed: {} })).toBeNull();
    expect(searchQuad(colourPlanes(table(400, 520), 1), { relaxed: {} })).toBeNull();
  });

  it('snaps corners onto a bowed sheet from a rough quad', () => {
    const { img, page } = pinBoard();
    const planes = colourPlanes(img, 1);
    const rough = page.map(([x, y], i) => [
      x + (i % 2 ? 5 : -4),
      y + (i < 2 ? -5 : 4),
    ]) as unknown as Quad;
    expect(maxError(rough, page)).toBeGreaterThan(5);
    const snapped = snapCorners(planes, snapCorners(planes, rough, 8), 3);
    // The pins cover the corners themselves.
    expect(maxError(snapped, page)).toBeLessThan(4);
  });

  it('takes the step with the paper on its inside, not a card edge beside it', () => {
    const { img } = pinBoard();
    const planes = colourPlanes(img, 1);
    // Across the page's top, between the pins, a little high: the cards'
    // lower edges (y 45 to 50) are as close as the page's (52 to 60).
    const a: Point = [80, 48];
    const b: Point = [300, 54];
    const page = (x: number) => 52.7 + (8 * (x - 56)) / 270;
    const below = (hits: { x: number; y: number }[]) =>
      hits.filter((h) => Math.abs(h.y - page(h.x)) < 6).length / hits.length;
    const inside = edgeHits(planes, a, b, 8, 1);
    expect(inside).not.toBeNull();
    expect(below(inside!)).toBeGreaterThan(0.9);
    // Without knowing which way the paper is, the cards' edges win.
    const any = edgeHits(planes, a, b, 8);
    expect(any === null || below(any) < 0.5).toBe(true);
  });
});

describe('clipToFrame', () => {
  it('leaves a quad inside the frame alone', () => {
    expect(clipToFrame(PAGE, 400, 520)).toEqual(PAGE);
  });

  it('keeps the visible part of the page, undistorted', () => {
    const off: Quad = [
      [90, 40],
      [450, 70],
      [420, 480],
      [70, 470],
    ];
    const clipped = clipToFrame(off, 400, 520);
    expect(isConvex(clipped)).toBe(true);
    for (const [x, y] of clipped) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(520);
    }
    // Corners stay on the page's own lines: the left side is untouched, and
    // the cut runs parallel to it in page coordinates.
    expect(
      maxError([clipped[0], clipped[3], off[0], off[3]], [off[0], off[3], off[0], off[3]]),
    ).toBeLessThan(1e-6);
    const toPage = homography(off, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    const [u1] = applyHomography(toPage, ...clipped[1]);
    const [u2] = applyHomography(toPage, ...clipped[2]);
    expect(u1).toBeCloseTo(u2, 3);
    expect(u1).toBeGreaterThan(0.8);
  });
});

/**
 * A ruled questionnaire: thin black rules nearly the whole width of the
 * sheet every 12 units, a row of "words" and four answer marks between them,
 * a title near the top edge and a closing line near the bottom one.
 */
function ruled(u: number, v: number): RGB {
  const paper: RGB = [236, 234, 228];
  const ink: RGB = [35, 35, 35];
  if (v > 30 && v < 280 && u > 4 && u < 206 && (v - 30) % 12 < 0.7) return ink;
  const inRow = v > 30 && v < 280 && (v - 30) % 12 > 4 && (v - 30) % 12 < 7;
  if (inRow && u > 14 && u < 150 && Math.floor(u / 9) % 4 !== 3) return ink;
  if (inRow && u > 160 && u < 200 && u % 10 < 3) return ink;
  if (v > 8 && v < 13 && u > 60 && u < 150 && Math.floor(u / 7) % 5 !== 4) return ink;
  if (v > 287 && v < 291 && u > 50 && u < 160 && Math.floor(u / 8) % 6 !== 5) return ink;
  return paper;
}

/** Corners of page position (u, v) on a page painted at `quad`. */
function onPage(quad: Quad, pw: number, ph: number): (u: number, v: number) => Point {
  const toPhoto = homography(
    [
      [0, 0],
      [pw, 0],
      [pw, ph],
      [0, ph],
    ],
    quad,
  );
  return (u, v) => applyHomography(toPhoto, u, v);
}

describe('printed lines and pages filling the frame', () => {
  // A ruled sheet photographed close: it runs off the top and bottom of the
  // photo, with the table showing left and right of it.
  const CLOSE: Quad = [
    [38, -16],
    [362, -10],
    [366, 534],
    [34, 530],
  ];

  it('tells a printed rule from a page edge', () => {
    const img = table(400, 520);
    paintPage(img, CLOSE, 210, 297, ruled);
    const planes = colourPlanes(img, 1);
    const at = onPage(CLOSE, 210, 297);
    // Rows 3 to 18: two rules for top and bottom, the page's edges for sides.
    const rows: Quad = [at(0, 66), at(210, 66), at(210, 246), at(0, 246)];
    const sides = quadSupport(planes, rows);
    expect(printedLine(sides[0])).toBe(true);
    expect(printedLine(sides[2])).toBe(true);
    expect(printedLine(sides[1])).toBe(false);
    expect(printedLine(sides[3])).toBe(false);
    expect(quadSupported(planes, rows)).toBe(false);
  });

  it('does not crop a ruled sheet to a strip of its rows', () => {
    const img = table(400, 520);
    paintPage(img, CLOSE, 210, 297, ruled);
    const planes = colourPlanes(img, 1);
    const result = searchQuad(planes, { relaxed: {} }) ?? frameSearch(planes);
    expect(result).not.toBeNull();
    const ys = result!.quad.map((p) => p[1]);
    // The whole visible sheet: from the top of the photo to its bottom...
    expect(Math.min(...ys)).toBeLessThan(2);
    expect(Math.max(...ys)).toBeGreaterThan(518);
    // ...between the sheet's own left and right edges.
    const xs = result!.quad.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThan(30);
    expect(Math.max(...xs)).toBeLessThan(370);
    expect(result!.offFrame).toBe(true);
  });

  it('takes a flat scan whose page fills the image as the whole image', () => {
    const img = createRGBA(300, 424);
    const full: Quad = [
      [0, 0],
      [300, 0],
      [300, 424],
      [0, 424],
    ];
    paintPage(img, full, 210, 297, ruled);
    const planes = colourPlanes(img, 1);
    expect(searchQuad(planes, { relaxed: {} })).toBeNull();
    const result = frameSearch(planes);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('frame');
    expect(maxError(result!.quad, full)).toBeLessThan(1);
    expect(result!.offFrame).toBe(false);
  });

  it('takes the page edge of a scan that shows the scanner lid beyond it', () => {
    const img = createRGBA(300, 424);
    img.data.fill(70);
    const page: Quad = [
      [0, 0],
      [300, 0],
      [300, 400],
      [0, 400],
    ];
    paintPage(img, page, 210, 297, ruled);
    const result = frameSearch(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, page)).toBeLessThan(2);
  });

  it('does not take a page on a table for one filling the frame', () => {
    const img = table(400, 520);
    paintPage(img, PAGE, 210, 297, ruled);
    expect(frameSearch(colourPlanes(img, 1))).toBeNull();
    expect(frameSearch(colourPlanes(table(400, 520), 1))).toBeNull();
  });
});
