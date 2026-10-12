import { describe, expect, it } from 'vitest';
import { analysePaper, PICTURE, pushPull } from '../engine/imaging/background';
import { gaussian } from '../engine/imaging/box';
import { applyFilter, paperTint } from '../engine/imaging/filters';
import { createFloat, createRGBA, luma01, type RGBAImage } from '../engine/imaging/image';
import { px } from './helpers';

/*
 * Synthetic photographed pages for the filter defects the end-to-end harness
 * found: what is printed (reflectance per channel), then the lens (a small
 * blur), the light (multiplicative, with an optional cast and shadow) and
 * sensor noise.
 */

type RGB = [number, number, number];

const W = 1000;
const H = 1414;
const PAPER: RGB = [0.96, 0.95, 0.93];

interface Page {
  rect(x0: number, y0: number, x1: number, y1: number, rgb: RGB): void;
  /** Glyph-like marks: an outlined box per letter, `n` letters in a row. */
  word(x: number, y: number, n: number, rgb: RGB, size?: number): void;
  photo(x0: number, y0: number, x1: number, y1: number): void;
}

function photograph(
  draw: (page: Page) => void,
  options: { paper?: RGB; light?: (x: number, y: number) => RGB; blur?: number } = {},
): RGBAImage {
  const paper = options.paper ?? PAPER;
  const planes = [0, 1, 2].map((c) => {
    const p = createFloat(W, H);
    p.data.fill(paper[c]);
    return p;
  });
  const rect = (x0: number, y0: number, x1: number, y1: number, rgb: RGB) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        for (let c = 0; c < 3; c++) planes[c].data[y * W + x] = rgb[c];
      }
    }
  };
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const page: Page = {
    rect,
    word(x, y, n, rgb, size = 14) {
      const stroke = Math.max(2, Math.round(size / 6));
      for (let i = 0; i < n; i++) {
        const x0 = x + i * Math.round(size * 0.8);
        const x1 = x0 + Math.round(size * 0.6);
        rect(x0, y, x0 + stroke, y + size, rgb);
        rect(x1 - stroke, y, x1, y + size, rgb);
        if (i % 2) rect(x0, y + size - stroke, x1, y + size, rgb);
        else rect(x0, y + (size >> 1), x1, y + (size >> 1) + stroke, rgb);
      }
    },
    photo(x0, y0, x1, y1) {
      // Smooth random tones, like a photo: a sum of a few gentle waves.
      const waves = Array.from({ length: 6 }, () => [rand() * 0.05, rand() * 0.05, rand() * 6]);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          let v = 0;
          for (const [a, b, ph] of waves) v += Math.sin(a * x + b * y + ph);
          const t = 0.5 + v / 8;
          rect(x, y, x + 1, y + 1, [0.2 + 0.6 * t, 0.15 + 0.7 * (1 - t), 0.3 + 0.4 * t]);
        }
      }
    },
  };
  draw(page);
  const soft = planes.map((p) => gaussian(p, options.blur ?? 1));
  const light =
    options.light ??
    ((x: number) => [0.7 + 0.25 * (x / W), 0.69 + 0.24 * (x / W), 0.66 + 0.22 * (x / W)] as RGB);
  const img = createRGBA(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const l = light(x, y);
      for (let c = 0; c < 3; c++) {
        img.data[i * 4 + c] = 255 * soft[c].data[i] * l[c] + (rand() - 0.5) * 6;
      }
      img.data[i * 4 + 3] = 255;
    }
  }
  return img;
}

const luma = (img: RGBAImage, x: number, y: number) => {
  const [r, g, b] = px(img, x, y);
  return luma01(r, g, b) * 255;
};

/** Body text: `lines` lines of dark words. */
function bodyText(page: Page, top: number, lines: number, rgb: RGB = [0.08, 0.08, 0.09]) {
  for (let l = 0; l < lines; l++) {
    for (let w = 0; w < 6; w++) page.word(80 + w * 140, top + l * 30, 5, rgb);
  }
}

describe('faded print', () => {
  // Text at about three quarters of the paper's brightness, nothing darker.
  const faded: RGB = [0.72, 0.71, 0.7];
  const src = photograph((p) => bodyText(p, 200, 20, faded));

  it('is kept and darkened to legible ink in Document and B&W', () => {
    const doc = applyFilter(src, 'document');
    const bw = applyFilter(src, 'bw');
    // A stroke of the first letter of a word in the middle of the page.
    const x = 80 + 2 * 140 + 1;
    const y = 200 + 10 * 30 + 7;
    expect(luma(doc, x, y)).toBeLessThan(110);
    expect(px(bw, x, y)[0]).toBe(0);
    // The paper is still clean.
    expect(px(doc, 50, 1300)).toEqual([255, 255, 255]);
  });
});

describe('faint print away from dark text', () => {
  const grey: RGB = [0.5, 0.5, 0.5];
  const src = photograph((p) => {
    bodyText(p, 150, 4);
    // A grey footer line far from the body text, as a receipt or invoice has.
    for (let w = 0; w < 5; w++) p.word(120 + w * 150, 1250, 6, grey, 12);
    // One connected grey "word" (letters touching), long and thin overall.
    p.rect(120, 1300, 300, 1302, grey);
    for (let i = 0; i < 12; i++) p.rect(120 + i * 15, 1290, 122 + i * 15, 1302, grey);
  });
  const out = applyFilter(src, 'document');

  it('keeps grey glyphs and grey words', () => {
    for (let w = 0; w < 5; w++) expect(luma(out, 121 + w * 150, 1256)).toBeLessThan(200);
    expect(luma(out, 121 + 5 * 15, 1296)).toBeLessThan(200);
  });
});

describe('colour areas, photos and dark bands', () => {
  const orange: RGB = [1, 0.6, 0.02];
  const navy: RGB = [0.1, 0.16, 0.29];
  const src = photograph((p) => {
    // A full-width dark band with white lettering, running off the page.
    p.rect(0, 0, W, 160, navy);
    for (let i = 0; i < 6; i++) p.rect(100 + i * 40, 60, 120 + i * 40, 100, PAPER);
    bodyText(p, 250, 3);
    p.rect(100, 400, 700, 460, orange);
    p.photo(100, 520, 700, 900);
    bodyText(p, 950, 3);
  });

  it('finds the photo, the band and the colour bar as pictures', () => {
    const a = analysePaper(src);
    const { cols, block } = a.surface;
    const at = (x: number, y: number) =>
      a.regions[Math.floor(y / block) * cols + Math.floor(x / block)];
    expect(at(400, 700)).toBe(PICTURE);
    expect(at(800, 80)).toBe(PICTURE);
    expect(at(400, 430)).toBe(PICTURE);
    expect(at(500, 1200)).not.toBe(PICTURE);
  });

  it('Document keeps a saturated fill in its colour, not white', () => {
    const doc = applyFilter(src, 'document');
    const [r, g, b] = px(doc, 400, 430);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(90);
    expect(g).toBeLessThan(200);
    expect(b).toBeLessThan(80);
  });

  it('Colour keeps the hue of an orange fill', () => {
    const [r, g] = px(applyFilter(src, 'color'), 400, 430);
    expect(g / r).toBeGreaterThan(0.4);
    expect(g / r).toBeLessThan(0.8);
  });

  it('keeps a dark band dark, with its white lettering white and no black outline', () => {
    const doc = applyFilter(src, 'document');
    const band = luma(doc, 800, 80);
    expect(band).toBeLessThan(90);
    expect(px(doc, 800, 80)[2]).toBeGreaterThan(px(doc, 800, 80)[0]);
    expect(luma(doc, 110, 80)).toBeGreaterThan(200);
    // Just outside a letter: the band, not a black rim.
    for (const [x, y] of [
      [96, 80],
      [124, 80],
      [110, 56],
    ]) {
      expect(luma(doc, x, y)).toBeGreaterThan(band * 0.6);
    }
  });

  it('keeps photos photographic in Document, Colour and Grey', () => {
    for (const filter of ['document', 'color', 'gray'] as const) {
      const out = applyFilter(src, filter);
      let white = 0;
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let y = 530; y < 890; y += 7) {
        for (let x = 110; x < 690; x += 7) {
          const a = luma(src, x, y);
          const b = luma(out, x, y);
          if (b >= 254) white++;
          n++;
          sx += a;
          sy += b;
          sxx += a * a;
          syy += b * b;
          sxy += a * b;
        }
      }
      const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
      expect(white / n).toBeLessThan(0.05);
      expect(corr).toBeGreaterThan(0.9);
    }
  }, 30_000);

  it('B&W is strictly black and white, and does not hollow the dark band', () => {
    const bw = applyFilter(src, 'bw');
    let grey = 0;
    for (let p = 0; p < bw.data.length; p += 4) if (bw.data[p] !== 0 && bw.data[p] !== 255) grey++;
    expect(grey).toBe(0);
    let black = 0;
    for (let x = 300; x < 990; x += 10) if (px(bw, x, 120)[0] === 0) black++;
    expect(black).toBe(69);
  }, 30_000);
});

describe('a hard-edged hand shadow', () => {
  const inShadow = (x: number, y: number) => x > 500 && y > 600;
  const src = photograph((p) => bodyText(p, 300, 25), {
    light: (x, y) => {
      const l = inShadow(x, y) ? 0.35 : 0.85;
      return [l, l * 0.98, l * 0.94];
    },
  });
  const doc = applyFilter(src, 'document');

  it('turns the shadowed paper white', () => {
    expect(px(doc, 700, 1300)).toEqual([255, 255, 255]);
    expect(px(doc, 300, 1300)).toEqual([255, 255, 255]);
  });

  it('draws no line along the shadow edge', () => {
    // Along the vertical edge, between lines of text.
    let ink = 0;
    let n = 0;
    for (let y = 1100; y < 1400; y++) {
      for (let x = 492; x <= 508; x++, n++) if (luma(doc, x, y) < 200) ink++;
    }
    expect(ink / n).toBeLessThan(0.01);
  });

  it('keeps the text in the shadow', () => {
    expect(luma(doc, 80 + 4 * 140 + 1, 300 + 15 * 30 + 7)).toBeLessThan(80);
  });
});

describe('coloured paper', () => {
  const yellow: RGB = [1, 0.95, 0.65];
  const neutral = () => [0.85, 0.85, 0.85] as RGB;
  const src = photograph((p) => bodyText(p, 200, 10), { paper: yellow, light: neutral });

  it('is white in Document, B&W and Grey', () => {
    for (const filter of ['document', 'bw', 'gray'] as const) {
      expect(px(applyFilter(src, filter), 40, 1300)).toEqual([255, 255, 255]);
    }
  });

  it('keeps its colour in Colour, without shading', () => {
    const out = applyFilter(src, 'color');
    const [r, g, b] = px(out, 40, 1300);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(220);
    expect(b).toBeLessThan(200);
    const [r2, , b2] = px(out, 960, 100);
    expect(Math.abs(r2 - r)).toBeLessThan(8);
    expect(Math.abs(b2 - b)).toBeLessThan(12);
  });

  it('white paper under warm light comes out white in Colour', () => {
    const warm = photograph((p) => bodyText(p, 200, 10), {
      light: () => [0.9, 0.85, 0.74],
    });
    const [r, g, b] = px(applyFilter(warm, 'color'), 40, 1300);
    expect(Math.min(r, g, b)).toBeGreaterThan(248);
  });

  it('tells a light cast from a paper colour by strength and hue', () => {
    // White paper under a warm lamp, as photographed: neutralised.
    expect(paperTint([220, 214, 198])).toEqual([1, 1, 1]);
    // Yellow paper: kept.
    expect(paperTint([216, 201, 129])[2]).toBeLessThan(0.7);
    // Pale blue paper (no lamp is blue): kept, if mildly.
    const blue = paperTint([178, 191, 196]);
    expect(blue[0]).toBeLessThan(0.97);
    expect(blue[2]).toBe(1);
  });
});

describe('thin coloured print in Document', () => {
  const blue: RGB = [0.29, 0.56, 0.85];
  const link: RGB = [0.1, 0.05, 0.67];
  const src = photograph((p) => {
    bodyText(p, 200, 4);
    // A 2 px table rule and a link underline, plus link text.
    p.rect(80, 400, 900, 402, blue);
    for (let w = 0; w < 3; w++) p.word(80 + w * 140, 450, 5, link);
    p.rect(80, 466, 480, 468, link);
  });
  const doc = applyFilter(src, 'document');

  it('keeps a thin coloured rule in colour', () => {
    const [r, , b] = px(doc, 500, 401);
    expect(b - r).toBeGreaterThan(60);
  });

  it('keeps link text and its underline in colour', () => {
    const [r, , b] = px(doc, 81, 457);
    expect(b - r).toBeGreaterThan(60);
    const [r2, , b2] = px(doc, 300, 467);
    expect(b2 - r2).toBeGreaterThan(60);
  });

  it('keeps black text black', () => {
    const [r, g, b] = px(doc, 81, 207);
    expect(Math.max(r, g, b)).toBeLessThan(40);
  });
});

describe('ballpoint marks on a printed form in Document', () => {
  // Ballpoint as a scanner sees it: dark, and only faintly blue for its darkness.
  const pen: RGB = [0.27, 0.25, 0.4];
  const grey: RGB = [0.45, 0.45, 0.45];
  /** A cross: two 3 px diagonal strokes, `size` px across, centred on (cx, cy). */
  const cross = (p: Page, cx: number, cy: number, size: number, rgb: RGB) => {
    for (let t = -size / 2; t <= size / 2; t++) {
      p.rect(cx + t - 1, cy + t - 1, cx + t + 2, cy + t + 2, rgb);
      p.rect(cx + t - 1, cy - t - 1, cx + t + 2, cy - t + 2, rgb);
    }
  };
  /** A 2 px ring of grey print (an answer circle). */
  const ring = (p: Page, cx: number, cy: number, r: number) => {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.hypot(x, y);
        if (d <= r && d > r - 2) p.rect(cx + x, cy + y, cx + x + 1, cy + y + 1, grey);
      }
    }
  };
  const src = photograph((p) => {
    bodyText(p, 150, 6);
    for (let row = 0; row < 6; row++) {
      const y = 500 + row * 80;
      // Answer circles, the table rule under them, and a cross through one
      // circle that reaches down onto the rule: one blob with the print.
      for (let k = 0; k < 4; k++) ring(p, 600 + k * 60, y, 12);
      p.rect(80, y + 22, 900, y + 24, [0.1, 0.1, 0.1]);
      cross(p, 600 + (row % 4) * 60, y + 6, 34, pen);
    }
    // Brownish-black print (as warm light leaves the darkest ink) and grey
    // print with a faint cool tint: neither is coloured ink.
    bodyText(p, 1050, 3, [0.11, 0.08, 0.05]);
    for (let w = 0; w < 5; w++) p.word(120 + w * 150, 1250, 6, [0.55, 0.56, 0.62], 12);
  });
  const doc = applyFilter(src, 'document');

  it('keeps a dark blue cross blue, also where it joins a circle and a rule', () => {
    for (let row = 0; row < 6; row++) {
      const cx = 600 + (row % 4) * 60;
      const cy = 500 + row * 80 + 6;
      // Along both strokes, away from the centre.
      for (const [x, y] of [
        [cx - 12, cy - 12],
        [cx + 12, cy - 12],
        [cx - 9, cy + 9],
      ]) {
        const [r, g, b] = px(doc, x, y);
        expect(b - r).toBeGreaterThan(30);
        expect(b - g).toBeGreaterThan(30);
        expect(luma(doc, x, y)).toBeLessThan(110);
      }
    }
  });

  it('leaves the rule, the circles and the text it touches neutral', () => {
    const neutral = (x: number, y: number) => {
      const [r, g, b] = px(doc, x, y);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    for (let row = 0; row < 6; row++) {
      const y = 500 + row * 80;
      expect(neutral(300, y + 23)).toBeLessThan(4);
      expect(neutral(880, y + 23)).toBeLessThan(4);
      // The circle right of the crossed one.
      const k = (row % 4) + 1;
      if (k < 4) expect(neutral(600 + k * 60 + 11, y)).toBeLessThan(4);
    }
  });

  it('does not colour brownish-black print, faintly tinted grey print or fringes', () => {
    let coloured = 0;
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        if (y > 470 && y < 960 && x > 560 && x < 820) continue; // the crosses
        const [r, g, b] = px(doc, x, y);
        if (Math.max(r, g, b) - Math.min(r, g, b) > 12) coloured++;
      }
    }
    expect(coloured).toBe(0);
  });

  it('does not colour black print with colour fringes from the lens', () => {
    // Lateral chromatic aberration: red shifted half a pixel one way, blue the other.
    const img = photograph((p) => bodyText(p, 200, 12));
    const shifted = createRGBA(img.width, img.height);
    shifted.data.set(img.data);
    for (let y = 0; y < img.height; y++) {
      for (let x = 2; x < img.width - 2; x++) {
        const p = (y * img.width + x) * 4;
        shifted.data[p] = (img.data[p] + img.data[p - 4]) / 2;
        shifted.data[p + 2] = (img.data[p + 2] + img.data[p + 4 + 2]) / 2;
      }
    }
    const out = applyFilter(shifted, 'document');
    for (let p = 0; p < out.data.length; p += 4) {
      expect(out.data[p]).toBe(out.data[p + 1]);
      expect(out.data[p + 1]).toBe(out.data[p + 2]);
    }
  });
});

describe('pushPull', () => {
  it('keeps known values and fills holes smoothly between them', () => {
    const w = 64;
    const h = 1;
    const plane = new Float32Array(w);
    const weight = new Float32Array(w);
    plane[0] = 0;
    plane[w - 1] = 100;
    weight[0] = weight[w - 1] = 1;
    const [out] = pushPull([plane], weight, w, h);
    expect(out[0]).toBe(0);
    expect(out[w - 1]).toBe(100);
    for (let x = 1; x < w; x++) expect(out[x]).toBeGreaterThanOrEqual(out[x - 1] - 1e-3);
    expect(out[32]).toBeGreaterThan(20);
    expect(out[32]).toBeLessThan(80);
  });
});

describe('print mistaken for a picture', () => {
  it('keeps a barcode black and the page grey', () => {
    const bars: [number, number][] = [];
    const img = photograph((page) => {
      // Bars 3–9 px wide: a dense block at the analysis' coarse scale.
      let x = 200;
      for (let k = 0; x < 760; k++) {
        const bar = 3 + ((k * 4) % 7);
        page.rect(x, 1050, x + bar, 1350, [0.08, 0.08, 0.08]);
        bars.push([x, bar]);
        x += bar + 1 + ((k * 3) % 3);
      }
      for (let r = 0; r < 12; r++) page.word(120, 150 + r * 40, 30, [0.1, 0.1, 0.1]);
    });
    const out = applyFilter(img, 'document');
    let coloured = 0;
    for (let p = 0; p < out.data.length; p += 4) {
      if (out.data[p] !== out.data[p + 1] || out.data[p + 1] !== out.data[p + 2]) coloured++;
    }
    expect(coloured).toBe(0);
    // The middle of every wide bar is black.
    for (const [x, bar] of bars) {
      if (bar < 7) continue;
      expect(px(out, x + (bar >> 1), 1150)[0]).toBeLessThan(30);
    }
  });
});
