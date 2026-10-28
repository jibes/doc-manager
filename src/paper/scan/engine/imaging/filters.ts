import { analysePaper, flattenPaper, PAPER, PICTURE, type PaperAnalysis } from './background';
import { boxMean, darkClassLevel, gaussian, halve, minFilter, sampleHalf } from './box';
import { keepBlobs, measureBlobs } from './cleanup';
import { dilate, labelComponents, removeSmallComponents } from './components';
import { createFloat, createRGBA, luma01, toLuma, type FloatImage, type RGBAImage } from './image';

/**
 * - `document`: black text on pure white, colour content (logos, stamps,
 *   signatures, highlights, coloured print, photos, colour areas) kept in
 *   colour. The default.
 * - `bw`: strictly black and white; photos and colour areas two-tone.
 * - `gray`: flattened greyscale with clean white paper.
 * - `color`: flattened colour; the paper keeps its own colour (white paper
 *   is white), shadows and colour casts removed.
 * - `original`: perspective correction only.
 */
export type FilterId = 'document' | 'bw' | 'gray' | 'color' | 'original';

export interface Adjustments {
  /** -1..1. Raises or lowers the white point, i.e. how aggressively near-white becomes paper. */
  brightness: number;
  /** -1..1. Moves the black point. */
  contrast: number;
  /** -1..1. For document/bw: text weight. Positive is bolder, negative thinner; 0 keeps the true stroke width. */
  threshold: number;
  /**
   * 0..1. Unsharp-mask amount for colour and grey content. For black text it
   * instead reduces the contour smoothing applied before thresholding.
   */
  sharpen: number;
}

export interface FilterContext {
  /**
   * Output pixels per source-photo pixel. Noise and blur live at the source
   * scale, so smoothing and sharpening radii follow it; everything that is
   * about page content (windows, blob sizes) follows the page size instead.
   */
  sourceScale: number;
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  threshold: 0,
  sharpen: 0.35,
};

/**
 * Lengths below are fractions of the page's long edge, so a 1400 px preview
 * and a 3500 px export apply the same filter to the same part of the page.
 */
/** Window for the local ink level: about one glyph. */
const INK_WINDOW = 0.004;
/** Window for "darker than its surroundings": a few lines of text. */
const CONTEXT_WINDOW = 0.012;
/** Stroke width beyond which a faint blob is shading, not print. */
const FAINT_THICKNESS = 0.005;
/** Faint thin streaks shorter than this are fold or crease shadows. */
const DASH_LENGTH = 0.15;
/** Longest stroke of a single letter (an l, a 1). */
const GLYPH_LENGTH = 0.025;
/** Below this ink-to-paper contrast nothing is print. */
const MIN_INK_CONTRAST = 0.2;
/** Faint blobs with an area below this length squared are noise. */
const FAINT_EDGE = 0.0025;
const SPECK_EDGE = 0.0006;
const COLOR_BLOB_EDGE = 0.004;
/** Width of the border band in which edge slivers are removed. */
const BORDER_BAND = 0.012;
/**
 * A blob whose core has at least this chroma (0..255) and purity (chroma
 * over distance from white, which mixing with paper does not change) is
 * coloured print.
 */
const INK_CHROMA = 25;
const INK_PURITY = 0.35;
/**
 * Faded pages: where the print (the ink level reached over an area of
 * FADED_EXTENT of the long edge squared: a few lines of text, so body text
 * rather than one bold heading, and never a crease) lies between FADED_MIN
 * and FADED_MAX, contrast is stretched so that it lands on FADED_TARGET, by
 * at most FADED_GAIN.
 */
const FADED_EXTENT = 0.08;
/** Dark print over this area (fraction of the long edge, squared: a few words) rules out a faded page. */
const FADED_WORDS = 0.01;
const FADED_MIN = 0.45;
const FADED_MAX = 0.85;
const FADED_TARGET = 0.3;
const FADED_GAIN = 4;
/** B&W: smoothing of a picture's smooth tones (fraction of the long edge) before its threshold. */
const PICTURE_SMOOTH = 0.003;
/** Pixels of a flat colour area within this (0..255, any channel) of its colour become exactly that colour. */
const FILL_SNAP = 24;
/** Paper saturation up to which a warm tint is taken for the light, and any other tint. */
const WARM_CAST_MAX = 0.22;
const OTHER_CAST_MAX = 0.05;

function longEdge(image: { width: number; height: number }): number {
  return Math.max(image.width, image.height);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Unsharp mask driven by luma, applied equally to all channels so it adds no
 * colour fringes. The blur here only builds the detail signal; the output is
 * sharper than the input, never softer.
 */
function sharpenRGBA(src: RGBAImage, amount: number, ctx: FilterContext): RGBAImage {
  if (amount <= 0) return src;
  const luma = toLuma(src);
  const sigma = 0.9 * Math.max(1, ctx.sourceScale);
  const blurred = gaussian(luma, sigma);
  const out = createRGBA(src.width, src.height);
  const gain = amount * 1.6;
  for (let i = 0, p = 0; i < luma.data.length; i++, p += 4) {
    const detail = (luma.data[i] - blurred.data[i]) * 255 * gain;
    out.data[p] = src.data[p] + detail;
    out.data[p + 1] = src.data[p + 1] + detail;
    out.data[p + 2] = src.data[p + 2] + detail;
    out.data[p + 3] = 255;
  }
  return out;
}

/** White and black points for a flattened page, in 0..1 luma. */
function tonePoints(luma: FloatImage, adj: Adjustments): { white: number; black: number } {
  // The darkest few percent of ink defines black, but never more than a
  // sliver of the page: on a dark flyer or a photo most of the page is
  // darker than 0.6, and its typical tone must not become black. Sample
  // sparsely: this only needs a histogram, not every pixel.
  const hist = new Uint32Array(256);
  let inkCount = 0;
  let samples = 0;
  const step = Math.max(1, Math.floor(luma.data.length / 400_000));
  for (let i = 0; i < luma.data.length; i += step, samples++) {
    const v = luma.data[i];
    if (v < 0.6) {
      hist[Math.max(0, Math.min(255, Math.round(v * 255)))]++;
      inkCount++;
    }
  }
  let black = 0.12;
  if (inkCount > 50) {
    const target = Math.min(inkCount * 0.05, samples * 0.005);
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) {
        // Never map anything lighter than mid-dark grey to pure black.
        black = Math.min(0.35, i / 255 + 0.04);
        break;
      }
    }
  }
  black = Math.max(0, Math.min(0.5, black + adj.contrast * 0.12));
  const white = Math.max(black + 0.2, Math.min(1, 0.9 - adj.brightness * 0.07));
  return { white, black };
}

/**
 * Colour and greyscale enhancement on a flattened page: a levels curve that
 * sends paper to exactly 255 and the darkest ink to 0, plus a mild saturation
 * lift so colour content does not look washed out next to the white paper.
 */
function enhanceColor(
  flat: RGBAImage,
  adj: Adjustments,
  gray: boolean,
  picture: FloatImage | null,
): RGBAImage {
  const luma = toLuma(flat);
  const { white, black } = tonePoints(luma, adj);
  const out = createRGBA(flat.width, flat.height);
  const sat = 1.15;
  const curve = (blackPoint: number, whitePoint: number) => {
    const lut = new Float32Array(256);
    const scale = 1 / (whitePoint - blackPoint);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v / 255 - blackPoint) * scale));
      // A gentle S-curve on top of the levels keeps mid-tones from going muddy.
      const s = t * t * (3 - 2 * t);
      lut[v] = 255 * (0.7 * t + 0.3 * s);
    }
    return lut;
  };
  // Paper is pushed to white well before its nominal 1.0, so its noise and
  // leftover shading vanish. Photos and colour areas are not paper: there
  // the same push would bleach light colours (a peach panel turning pale
  // yellow as its green channel clips), and the black point set by the ink
  // would crush dark ones (a navy band turning black), so they get nearly
  // the full range.
  const lut = curve(black, white);
  const pictureLut = curve(black / 2, Math.max(white, Math.min(1, 1 - adj.brightness * 0.07)));
  const pw = picture?.data;
  for (let i = 0, p = 0; i < luma.data.length; i++, p += 4) {
    const w = pw ? pw[i] : 0;
    if (gray) {
      const k = Math.round(luma.data[i] * 255);
      out.data[p] = out.data[p + 1] = out.data[p + 2] = lut[k] + (pictureLut[k] - lut[k]) * w;
    } else {
      const l = luma.data[i] * 255;
      for (let c = 0; c < 3; c++) {
        const v = l + (flat.data[p + c] - l) * sat;
        const k = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        out.data[p + c] = lut[k] + (pictureLut[k] - lut[k]) * w;
      }
    }
    out.data[p + 3] = 255;
  }
  return out;
}

/**
 * Black text on white paper, as a coverage map (0 = ink, 1 = paper).
 *
 * Stroke width is preserved by putting each pixel's threshold halfway between
 * the local ink level and the paper. A camera blurs every edge into a ramp
 * from ink to paper; cutting that ramp at its midpoint lands exactly on the
 * true edge, whereas Sauvola-style thresholds sit near the paper end and make
 * every stroke as much bolder as the lens was soft. Paper is 1.0 here (the
 * page is flattened), and the local ink level is the darkest value within a
 * glyph-sized window.
 *
 * Instead of snapping to 0/1 and blurring the result back into anti-aliasing
 * (what makes cheap scanners look soft), each pixel goes through a narrow
 * linear ramp centred on its threshold: clearly-ink is pure black,
 * clearly-paper pure white, and only pixels straddling an edge keep a grey.
 */
/**
 * Faded print (an old photocopy, a washed-out page): when even the darkest
 * print on the page is light grey, every rule that tells print from shading
 * by its darkness would drop all of it. Stretch the contrast instead, so the
 * page's darkest print becomes dark grey. Judged on the local ink level (the
 * typical stroke darkness), which covers whole lines of text: a page needs
 * text, not a crease or a speck, to count as faded. Paper stays at 1. All
 * three fields are mapped the same way (they are averages and order
 * statistics of the same values, so the map commutes with them). Mutates.
 */
function stretchFadedPrint(luma: FloatImage, half: FloatImage, inkLevel: FloatImage): void {
  const hist = new Uint32Array(256);
  const d = inkLevel.data;
  for (let i = 0; i < d.length; i++) hist[Math.max(0, Math.min(255, Math.round(d[i] * 255)))]++;
  const long = Math.max(inkLevel.width, inkLevel.height);
  // The ink level reached over an area of `extent` of the long edge squared.
  const levelOver = (extent: number) => {
    const target = Math.max(16, (extent * long) ** 2);
    for (let i = 0, acc = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i / 255;
    }
    return 1;
  };
  // Any dark print at all (a few dark words) and the page is not faded.
  if (levelOver(FADED_WORDS) <= FADED_MIN) return;
  const level = levelOver(FADED_EXTENT);
  if (level <= FADED_MIN || level >= FADED_MAX) return;
  const gain = Math.min(FADED_GAIN, (1 - FADED_TARGET) / (1 - level));
  for (const field of [luma.data, half.data, d]) {
    for (let i = 0; i < field.length; i++) field[i] = Math.max(0, 1 - (1 - field[i]) * gain);
  }
}

interface InkLayer {
  /** Coverage, 0 = ink, 1 = paper. */
  ink: FloatImage;
  /** Kept blob of every pixel (0 = none). */
  labels: Int32Array;
  /** Per blob: how far grey print is lifted towards white in the Document filter. */
  tone: Float32Array;
  /** Per blob: its darkest (smoothed) luma. */
  darkest: Float32Array;
}

/** Width of the anti-aliased edge of print, in output pixels. */
const EDGE_PX = 1;
/** Widest ramp (in luma) an edge gets: a soft blur is not turned into a grey halo. */
const MAX_RAMP = 0.35;

function inkCoverage(flat: RGBAImage, adj: Adjustments, ctx: FilterContext): InkLayer {
  // A whisker of smoothing at the scale of the camera's noise straightens the
  // wobble that JPEG blocks and sensor noise put into glyph outlines; the
  // ramp below re-sharpens every edge, so nothing ends up soft.
  // (No name for the unblurred luma, so it can be freed straight away.)
  const luma = gaussian(toLuma(flat), 0.45 * Math.max(1, ctx.sourceScale) * (1.2 - adj.sharpen));
  const { width, height } = luma;
  const L = longEdge(luma);
  const inkRadius = Math.max(2, Math.round(L * INK_WINDOW));
  // Smooth fields (ink level, presence, context) are computed at half
  // resolution: they vary over tens of pixels, and this is 4x cheaper.
  const half = halve(luma);
  const halfRadius = Math.max(2, inkRadius >> 1);
  // Typical stroke darkness nearby; see darkClassLevel for why not the minimum.
  const inkLevel = darkClassLevel(half, Math.round(halfRadius * 1.5));
  stretchFadedPrint(luma, half, inkLevel);
  // Whether there is print here at all: the darkest value nearby, so a
  // one-pixel rule still counts.
  // Halved by taking the darkest of each 2x2, so a one-pixel rule is not
  // diluted with paper first.
  const presence = boxMean(minFilter(halve(luma, true), halfRadius), halfRadius);
  const mean = boxMean(half, Math.max(2, Math.round((L * CONTEXT_WINDOW) / 2)));

  // Where on the ink-to-paper ramp to cut: 0.5 is the true edge. "Text weight"
  // moves it towards paper (bolder) or towards ink (thinner).
  const cut = 0.5 + adj.threshold * 0.12;
  const paperCut = Math.min(0.97, 0.9 - adj.brightness * 0.05);
  // Anything this dark is ink whatever its surroundings, so solid shapes are
  // filled rather than outlined.
  const darkCut = 0.45 + adj.contrast * 0.08;

  const out = createFloat(width, height);
  for (let i = 0; i < out.data.length; i++) {
    const v = luma.data[i];
    if (v >= paperCut) {
      out.data[i] = 1;
      continue;
    }
    const x = i % width;
    const y = (i - x) / width;
    const ink = sampleHalf(inkLevel, x, y);
    const contrast = 1 - ink;
    const present = 1 - sampleHalf(presence, x, y) >= MIN_INK_CONTRAST;
    // Too little contrast to be print (fold shadows, tints, paper texture):
    // only genuinely dark pixels count.
    let t = present ? ink + contrast * cut : darkCut;
    // Ink is darker than its surroundings. A light tint fills its own
    // neighbourhood, so it fails this and stays white instead of turning
    // into a black block.
    t = Math.min(t, sampleHalf(mean, x, y) - 0.015);
    t = Math.min(paperCut, Math.max(darkCut, t));
    // The ramp spans one output pixel across the edge: (v - t) / |gradient| is
    // the pixel's distance from the stroke's outline, so each edge pixel gets
    // the share of it the stroke covers. A fixed ramp in luma is a fraction of
    // a pixel on a sharp edge, and its staircase is what makes letters look
    // coarse. Never narrower than that ramp (flat areas stay clean).
    const gx = luma.data[x < width - 1 ? i + 1 : i] - luma.data[x > 0 ? i - 1 : i];
    const gy = luma.data[y < height - 1 ? i + width : i] - luma.data[y > 0 ? i - width : i];
    const grad = Math.hypot(gx, gy) / 2;
    const half = Math.min(0.05, Math.max(0.015, contrast * 0.06));
    let c = (v - t) / Math.min(MAX_RAMP, Math.max(2 * half, grad * EDGE_PX)) + 0.5;
    // Solid dark areas go fully black over a short ramp of their own.
    if (v < darkCut) c = Math.min(c, (v - (darkCut - 0.06)) / 0.06);
    out.data[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }

  // Component cleanup: every non-white blob (a glyph plus its anti-aliased
  // fringe) is kept or dropped as a whole, so kept glyphs keep every edge
  // pixel and dropped noise leaves nothing behind. See cleanup.ts.
  const touched = new Uint8Array(out.data.length);
  for (let i = 0; i < touched.length; i++) touched[i] = out.data[i] < 0.97 ? 1 : 0;
  const band = Math.max(3, Math.round(L * BORDER_BAND));
  const { labels, blobs } = measureBlobs(touched, luma, band);
  const keep = keepBlobs(blobs, width, height, {
    speck: Math.max(2, Math.round((L * SPECK_EDGE) ** 2)),
    faintMinArea: Math.max(12, Math.round((L * FAINT_EDGE) ** 2)),
    dashMaxLength: L * DASH_LENGTH,
    glyphMaxLength: L * GLYPH_LENGTH,
    faintMaxThickness: Math.max(4, L * FAINT_THICKNESS),
    band,
    // Enlarging the photo softens every edge by the same factor.
    faintMinGradient: 0.15 / Math.max(1, ctx.sourceScale),
  });
  // Grey print (light rules, grey small print) can stay grey rather than be
  // forced to black; anything printed dark is pure black.
  const tone = new Float32Array(blobs.length);
  const darkest = new Float32Array(blobs.length);
  for (let l = 1; l < blobs.length; l++) {
    const b = blobs[l];
    if (!b || !keep[l]) continue;
    tone[l] = Math.min(0.6, Math.max(0, (b.minLuma - 0.3) / 0.6));
    darkest[l] = b.minLuma;
  }
  for (let i = 0; i < out.data.length; i++) {
    const l = labels[i];
    if (!l) continue;
    if (!keep[l]) {
      out.data[i] = 1;
      labels[i] = 0;
    }
  }

  return { ink: out, labels, tone, darkest };
}

/**
 * Coloured print drawn as ink: per kept blob, the mean colour of its core in
 * the flattened page. Blobs whose core is clearly coloured (links, coloured
 * headings and rules, ballpoint signatures) get that colour; everything else
 * gets none (-1). Returns RGB per label.
 *
 * The core of a thin line is still part paper: the lens mixes the ink with
 * white. Mixing with white scales the colour's chroma and its distance from
 * white alike, so their ratio (the colour's purity) tells coloured from
 * grey or black print however thin the line; and the colour is extended
 * from white until it is as dark as the blob's darkest point.
 */
function blobColours(ink: InkLayer, color: RGBAImage): Float32Array {
  const { labels } = ink;
  const n = ink.tone.length;
  const sums = new Float64Array(n * 4);
  const cov = ink.ink.data;
  for (let i = 0, p = 0; i < labels.length; i++, p += 4) {
    const l = labels[i];
    if (!l || cov[i] > 0.5) continue;
    sums[l * 4] += color.data[p];
    sums[l * 4 + 1] += color.data[p + 1];
    sums[l * 4 + 2] += color.data[p + 2];
    sums[l * 4 + 3]++;
  }
  const rgb = new Float32Array(n * 3).fill(-1);
  for (let l = 1; l < n; l++) {
    const count = sums[l * 4 + 3];
    if (count < 2) continue;
    const r = sums[l * 4] / count;
    const g = sums[l * 4 + 1] / count;
    const b = sums[l * 4 + 2] / count;
    const min = Math.min(r, g, b);
    const chroma = Math.max(r, g, b) - min;
    if (chroma < INK_CHROMA || chroma < INK_PURITY * (255 - min)) continue;
    const depth = 1 - luma01(r, g, b);
    const s = Math.min(3, Math.max(1, (1 - ink.darkest[l]) / Math.max(0.05, depth)));
    rgb[l * 3] = Math.max(0, 255 - (255 - r) * s);
    rgb[l * 3 + 1] = Math.max(0, 255 - (255 - g) * s);
    rgb[l * 3 + 2] = Math.max(0, 255 - (255 - b) * s);
  }
  return rgb;
}

/**
 * Coloured marks inside blobs that are not coloured as a whole: a ballpoint
 * cross over a printed answer circle or a table rule joins them into one
 * blob, whose mean colour is then mostly the print's grey. And ballpoint ink
 * is dark and desaturated (navy, violet), so even alone its colour is weak
 * next to its darkness by the measure `blobColours` uses for thin print.
 *
 * So colour is judged per pixel first, against the pixel's own darkness:
 * candidate pixels are ink whose chroma is a fair share of their distance
 * from white. Connected candidates form a mark, which keeps its colour when
 * it is wide enough to have an inside (a pen stroke, not the one- or
 * two-pixel colour fringe a lens or JPEG puts along black print), its
 * pixels agree on the hue (fringes swing between opposite hues around a
 * glyph; ink has one), and its mean colour is clearly coloured for its
 * darkness (a cast on black print is a few units of chroma on two hundred
 * of depth).
 *
 * Returns the mark of every pixel (0 = none: the pixel's blob decides) and
 * the RGB of every mark. Mark pixels and the anti-aliased edge pixels right
 * next to them take the mark's colour; print it touches stays as it is.
 */
function markColours(
  ink: InkLayer,
  color: RGBAImage,
  picture: FloatImage | null,
): { marks: Int32Array; rgb: Float32Array } | null {
  const { labels } = ink;
  const { width, height, data } = color;
  const cov = ink.ink.data;
  const n = width * height;
  // Stroke cores of print on paper: photos and colour areas keep their own
  // colours anyway, and their "ink" would tell nothing about the print's.
  const core = (i: number) =>
    labels[i] !== 0 && cov[i] <= MARK_COVERAGE && !(picture && picture.data[i] > 0);
  // The cast the page's print has kept from the light and the camera, even
  // once the paper is white: the mean chroma of the less colourful half of
  // the ink, which is the black and grey print wherever there is any. Marks
  // are judged by how far their colour is from that. Only a faint one is a
  // cast: when even that half of the ink is clearly coloured, the page is
  // printed or written in colour.
  const hist = new Uint32Array(256);
  let inkPixels = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!core(i)) continue;
    const mean = (data[p] + data[p + 1] + data[p + 2]) / 3;
    const c = Math.hypot(data[p] - mean, data[p + 1] - mean, data[p + 2] - mean);
    hist[Math.min(255, Math.round(c))]++;
    inkPixels++;
  }
  if (!inkPixels) return null;
  let median = 0;
  for (let acc = 0; median < 255; median++) {
    acc += hist[median];
    if (acc * 2 >= inkPixels) break;
  }
  const cast = [0, 0, 0];
  let castN = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!core(i)) continue;
    const mean = (data[p] + data[p + 1] + data[p + 2]) / 3;
    if (Math.hypot(data[p] - mean, data[p + 1] - mean, data[p + 2] - mean) > median + 0.5) continue;
    for (let c = 0; c < 3; c++) cast[c] += data[p + c] - mean;
    castN++;
  }
  for (let c = 0; c < 3; c++) cast[c] /= Math.max(1, castN);
  if (Math.hypot(cast[0], cast[1], cast[2]) > MARK_MAX_CAST) cast.fill(0);
  // Colour with the cast taken out.
  const at = (p: number, c: number) => data[p + c] - cast[c];

  const candidate = new Uint8Array(n);
  let any = false;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (!core(i)) continue;
    const r = at(p, 0);
    const g = at(p, 1);
    const b = at(p, 2);
    const min = Math.min(r, g, b);
    const chroma = Math.max(r, g, b) - min;
    if (chroma >= MARK_PIXEL_CHROMA && chroma >= MARK_PIXEL_PURITY * (255 - min)) {
      candidate[i] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const { labels: marks, areas } = labelComponents(candidate, width, height);
  const count = areas.length;
  // Per mark: colour sums, summed chroma vector and its summed length, inside pixels, darkest.
  const sums = new Float64Array(count * 8);
  const darkest = new Float32Array(count).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const m = marks[i];
      if (!m) continue;
      const p = i * 4;
      const r = at(p, 0);
      const g = at(p, 1);
      const b = at(p, 2);
      const mean = (r + g + b) / 3;
      const o = m * 8;
      sums[o] += r;
      sums[o + 1] += g;
      sums[o + 2] += b;
      sums[o + 3] += r - mean;
      sums[o + 4] += g - mean;
      sums[o + 5] += b - mean;
      sums[o + 6] += Math.hypot(r - mean, g - mean, b - mean);
      if (
        x > 0 &&
        y > 0 &&
        x < width - 1 &&
        y < height - 1 &&
        marks[i - 1] === m &&
        marks[i + 1] === m &&
        marks[i - width] === m &&
        marks[i + width] === m
      ) {
        sums[o + 7]++;
      }
      const l = luma01(r, g, b);
      if (l < darkest[m]) darkest[m] = l;
    }
  }
  const minInside = Math.max(4, Math.round((longEdge(color) * MARK_INSIDE_EDGE) ** 2));
  const rgb = new Float32Array(count * 3).fill(-1);
  let kept = 0;
  for (let m = 1; m < count; m++) {
    const area = areas[m];
    const o = m * 8;
    if (!area || sums[o + 7] < minInside) continue;
    const r = sums[o] / area;
    const g = sums[o + 1] / area;
    const b = sums[o + 2] / area;
    const min = Math.min(r, g, b);
    const chroma = Math.max(r, g, b) - min;
    const agreement =
      Math.hypot(sums[o + 3], sums[o + 4], sums[o + 5]) / Math.max(1e-6, sums[o + 6]);
    // Light from a lamp or the sun leaves the darkest print a little warm,
    // in patches, so a warm hue has to be clearly coloured to be ink.
    const purity = isWarm(r, g, b) ? MARK_WARM_PURITY : MARK_PURITY;
    if (chroma < MARK_CHROMA || chroma < purity * (255 - min) || agreement < MARK_AGREEMENT)
      continue;
    // As dark as the mark gets, in the same hue (see blobColours).
    const depth = 1 - luma01(r, g, b);
    const s = Math.min(2, Math.max(1, (1 - darkest[m]) / Math.max(0.05, depth)));
    rgb[m * 3] = Math.max(0, 255 - (255 - r) * s);
    rgb[m * 3 + 1] = Math.max(0, 255 - (255 - g) * s);
    rgb[m * 3 + 2] = Math.max(0, 255 - (255 - b) * s);
    kept++;
  }
  if (!kept) return null;
  // Keep only accepted marks, then grow them over their blob's edge pixels
  // (and the odd weakly coloured pixel inside the stroke), but not over the
  // neutral core of print they touch.
  for (let i = 0; i < n; i++) if (marks[i] && rgb[marks[i] * 3] < 0) marks[i] = 0;
  let front: number[] = [];
  for (let i = 0; i < n; i++) if (marks[i]) front.push(i);
  for (let step = 0; step < MARK_GROW; step++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % width;
      const m = marks[i];
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= n || marks[j] || !labels[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === width - 1)) continue;
        if (cov[j] <= MARK_COVERAGE) {
          // A core pixel joins only if it is coloured itself, if weakly.
          const p = j * 4;
          const c = Math.max(at(p, 0), at(p, 1), at(p, 2)) - Math.min(at(p, 0), at(p, 1), at(p, 2));
          if (c < MARK_PIXEL_CHROMA / 2) continue;
        }
        marks[j] = m;
        next.push(j);
      }
    }
    front = next;
  }
  return { marks, rgb };
}

/** Ink pixels with at most this coverage (0 = ink, 1 = paper) are a stroke's core. */
const MARK_COVERAGE = 0.5;
/** A pixel is coloured ink with this chroma (max − min, 0..255) and purity (see blobColours). */
const MARK_PIXEL_CHROMA = 16;
const MARK_PIXEL_PURITY = 0.1;
/** Largest print cast (length of the chroma vector, 0..255) taken out of marks. */
const MARK_MAX_CAST = 8;
/** A mark's mean colour needs this chroma and purity to keep its colour. */
const MARK_CHROMA = 20;
const MARK_PURITY = 0.13;
const MARK_WARM_PURITY = 0.3;
/** Agreement of its pixels' hues: length of the mean chroma vector over the mean length. */
const MARK_AGREEMENT = 0.7;
/** A mark needs an inside (pixels whose four neighbours are in it) of this length squared. */
const MARK_INSIDE_EDGE = 0.002;
/** Pixels by which marks grow over their edges. */
const MARK_GROW = 3;

/**
 * Remove components that lie (almost) entirely in a thin band along the image
 * border: the strip of table or page edge a crop grazes, never content. Judged
 * by the share of pixels in the band rather than by bounding box, so slivers
 * along two edges that meet in a corner still count. Mutates `mask`.
 */
function clearBorderSlivers(mask: Uint8Array, width: number, height: number): void {
  const band = Math.max(3, Math.round(Math.max(width, height) * BORDER_BAND));
  const { labels, areas } = labelComponents(mask, width, height);
  const inBand = new Int32Array(areas.length);
  const touches = new Uint8Array(areas.length);
  for (let y = 0; y < height; y++) {
    const yBand = y < band || y >= height - band;
    const yEdge = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!l) continue;
      if (yBand || x < band || x >= width - band) inBand[l]++;
      if (yEdge || x === 0 || x === width - 1) touches[l] = 1;
    }
  }
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i];
    if (l && touches[l] && inBand[l] >= areas[l] * 0.9) mask[i] = 0;
  }
}

/**
 * Per-pixel weight of colour content in [0, 1]: saturated, not paper, and part
 * of a blob large enough to be a logo, stamp, highlight or signature rather
 * than a chromatic-aberration fringe on black text.
 */
function colorWeight(flat: RGBAImage): FloatImage {
  const { width, height, data } = flat;
  const n = width * height;
  const weight = createFloat(width, height);
  const mask = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const saturation = max > 0 ? chroma / max : 0;
    const w = smoothstep(28, 60, chroma) * smoothstep(0.22, 0.38, saturation) * (max < 250 ? 1 : 0);
    weight.data[i] = w;
    mask[i] = w > 0.5 ? 1 : 0;
  }
  const minBlob = Math.max(4, Math.round((longEdge(flat) * COLOR_BLOB_EDGE) ** 2));
  removeSmallComponents(mask, width, height, minBlob);
  clearBorderSlivers(mask, width, height);
  const grown = dilate(mask, width, height, 2);
  for (let i = 0; i < n; i++) if (!grown[i]) weight.data[i] = 0;
  return weight;
}

/** Whether a colour's hue is on the warm (orange-yellow) axis of lamp and sun light. */
function isWarm(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d <= 0) return false;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / d + 6) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  return hue >= 15 && hue <= 70;
}

/**
 * The paper's own colour, as a per-channel factor (1 = white), or white when
 * the tint is more likely the light than the paper.
 *
 * Only the page is seen, so a cast from the light and a coloured sheet look
 * alike. Phones white-balance, and what is left of a lamp's or the sun's
 * colour lies on the warm (orange-yellow) axis and stays moderate; so a warm
 * tint counts as paper colour only when it is strong (yellow paper), while
 * a tint of any other hue (blue, green, pink paper) counts already when
 * mild, since light rarely tints a page that way.
 */
export function paperTint(paper: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = paper;
  const max = Math.max(r, g, b, 1);
  const sat = (max - Math.min(r, g, b)) / max;
  const k = isWarm(r, g, b)
    ? smoothstep(WARM_CAST_MAX, WARM_CAST_MAX + 0.08, sat)
    : smoothstep(OTHER_CAST_MAX, OTHER_CAST_MAX + 0.04, sat);
  return [1 - k * (1 - r / max), 1 - k * (1 - g / max), 1 - k * (1 - b / max)];
}

/** Multiply by the paper colour, as if printed on it. Mutates and returns `image`. */
function onPaper(image: RGBAImage, tint: readonly [number, number, number]): RGBAImage {
  if (tint[0] === 1 && tint[1] === 1 && tint[2] === 1) return image;
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    d[p] *= tint[0];
    d[p + 1] *= tint[1];
    d[p + 2] *= tint[2];
  }
  return image;
}

/** Colour layer pixels this close to grey (max − min, 0..255) are left grey. */
const NEUTRAL_CHROMA = 10;

/** A grey "picture" with fewer mid-tones than this (share of its pixels) is print. */
const PRINT_MIDTONES = 0.3;
/** ...and with a mean chroma (max − min, 0..255) below this. */
const PRINT_CHROMA = 12;

/** A picture whose mean chroma (max − min, 0..255) is below this is grey. */
const GREY_PICTURE_CHROMA = 8;

/**
 * Check the areas the paper analysis took for pictures at full resolution.
 *
 * Some are plain black-on-white print, too large or dense to be lettering at
 * the analysis' coarse scale: a barcode, a QR code, a block of bold type.
 * Almost all their pixels are near black or near white, where a photo has
 * mid-tones. They are handed back to the ink pipeline (as paper), so they
 * come out crisp black rather than as a dark grey picture. Mutates `analysis`.
 *
 * Returns, per content area id, 1 for a picture that is grey but for a faint
 * cast (a grey photo, soft thermal print): it is composited as grey, so a
 * grey page stays one channel in the PDF instead of three.
 */
function checkPictures(analysis: PaperAnalysis, flat: RGBAImage): Uint8Array {
  const { regions, regionIds } = analysis;
  const { cols, rows, block } = analysis.surface;
  let ids = 0;
  for (let i = 0; i < regions.length; i++) {
    if (regions[i] === PICTURE) ids = Math.max(ids, regionIds[i] + 1);
  }
  const grey = new Uint8Array(ids);
  if (ids === 0) return grey;
  const count = new Float64Array(ids);
  const mid = new Float64Array(ids);
  const chroma = new Float64Array(ids);
  const { width, height, data } = flat;
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor(y / block)) * cols;
    for (let x = 0; x < width; x++) {
      const cell = row + Math.min(cols - 1, Math.floor(x / block));
      if (regions[cell] !== PICTURE) continue;
      const id = regionIds[cell];
      const p = (y * width + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const l = luma01(r, g, b);
      count[id]++;
      if (l > 0.35 && l < 0.8) mid[id]++;
      chroma[id] += Math.max(r, g, b) - Math.min(r, g, b);
    }
  }
  for (let id = 0; id < ids; id++)
    grey[id] = chroma[id] / Math.max(1, count[id]) < GREY_PICTURE_CHROMA ? 1 : 0;
  for (let i = 0; i < regions.length; i++) {
    if (regions[i] !== PICTURE) continue;
    const id = regionIds[i];
    const n = Math.max(1, count[id]);
    if (mid[id] / n < PRINT_MIDTONES && chroma[id] / n < PRINT_CHROMA) regions[i] = PAPER;
  }
  return grey;
}
/**
 * Per output pixel, 1 inside photos, colour areas and dark areas (which the
 * Document filter shows as they are), 0 on paper and pale neutral tints.
 * Null when there are none.
 */
function pictureWeight(analysis: PaperAnalysis, width: number, height: number): FloatImage | null {
  const { cols, rows, block } = analysis.surface;
  const coarse = createFloat(cols, rows);
  let any = false;
  for (let i = 0; i < coarse.data.length; i++) {
    if (analysis.regions[i] === PICTURE) {
      coarse.data[i] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const soft = boxMean(coarse, 1).data;
  const out = createFloat(width, height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = gx - x0;
      out.data[y * width + x] =
        (soft[y0 * cols + x0] * (1 - tx) + soft[y0 * cols + x1] * tx) * (1 - ty) +
        (soft[y1 * cols + x0] * (1 - tx) + soft[y1 * cols + x1] * tx) * ty;
    }
  }
  return out;
}

export function applyFilter(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments = DEFAULT_ADJUSTMENTS,
  ctx: FilterContext = { sourceScale: 1 },
): RGBAImage {
  return filterPage(src, filter, adj, ctx, false).image;
}

/**
 * The filtered page, plus the page as text recognition should read it.
 *
 * Document and B&W decide every pixel to be ink or paper, and on faint or
 * low-resolution print that decision loses what tells letters apart (the
 * dots of an umlaut, the bowl of an h against an n): the recogniser reads
 * markedly better from the flattened greyscale page, which keeps every
 * stroke's shading. That page is a by-product of these filters, so it costs
 * little to hand over too. Other filters' output is read as it is.
 */
export function applyFilterForText(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments = DEFAULT_ADJUSTMENTS,
  ctx: FilterContext = { sourceScale: 1 },
): { image: RGBAImage; reading: RGBAImage } {
  const { image, reading } = filterPage(src, filter, adj, ctx, true);
  return { image, reading: reading ?? image };
}

function filterPage(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments,
  ctx: FilterContext,
  wantReading: boolean,
): { image: RGBAImage; reading: RGBAImage | null } {
  // Perspective correction only: no sharpening, no tone change.
  if (filter === 'original') return { image: src, reading: null };

  const analysis = analysePaper(src);
  const flat = flattenPaper(src, analysis.surface);
  const greyPictures = checkPictures(analysis, flat);
  const picture = pictureWeight(analysis, src.width, src.height);
  if (filter === 'color') {
    return {
      image: onPaper(
        enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false, picture),
        paperTint(analysis.paper),
      ),
      reading: null,
    };
  }
  const grey = () => enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, true, picture);
  if (filter === 'gray') return { image: grey(), reading: null };
  const reading = wantReading ? grey() : null;
  return {
    image: inkFilter(src, filter, adj, ctx, analysis, flat, greyPictures, picture),
    reading,
  };
}

function inkFilter(
  src: RGBAImage,
  filter: 'document' | 'bw',
  adj: Adjustments,
  ctx: FilterContext,
  analysis: PaperAnalysis,
  flat: RGBAImage,
  greyPictures: Uint8Array,
  picture: FloatImage | null,
): RGBAImage {
  const layer = inkCoverage(flat, adj, ctx);
  const ink = layer.ink.data;
  const out = createRGBA(src.width, src.height);
  const od = out.data;
  if (filter === 'bw') {
    // Strictly two levels: the coverage ramp is centred on each stroke's true
    // edge, so cutting it at one half keeps the printed stroke width. Photos
    // and colour areas get one fixed threshold on their tone instead (a
    // two-tone picture, with dark lettering on light grounds and light
    // lettering on dark ones).
    const dark = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) dark[i] = ink[i] < 0.5 ? 1 : 0;
    if (picture) {
      // Only the part of the page the pictures cover is worked on.
      const { width } = src;
      let x0 = width;
      let y0 = src.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < width; x++) {
          if (picture.data[y * width + x] <= 0.5) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      const cw = x1 - x0 + 1;
      const ch = y1 - y0 + 1;
      if (cw > 0 && ch > 0) {
        // Smooth tones are judged on a well smoothed copy (noise would put
        // specks all along a tone that sits at the threshold), detail such as
        // lettering on the barely smoothed one.
        const crop = createFloat(cw, ch);
        for (let y = 0; y < ch; y++) {
          for (let x = 0, p = ((y + y0) * width + x0) * 4; x < cw; x++, p += 4) {
            crop.data[y * cw + x] = luma01(flat.data[p], flat.data[p + 1], flat.data[p + 2]);
          }
        }
        const sharp = boxMean(crop, 1).data;
        const smooth = boxMean(crop, Math.max(2, Math.round(longEdge(src) * PICTURE_SMOOTH))).data;
        const votes = createFloat(cw, ch);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const k = y * cw + x;
            const i = (y + y0) * width + x + x0;
            if (picture.data[i] > 0.5) {
              const v = Math.abs(sharp[k] - smooth[k]) > 0.12 ? sharp[k] : smooth[k];
              dark[i] = v < 0.5 ? 1 : 0;
            }
            votes.data[k] = dark[i];
          }
        }
        // A majority vote over 3x3 clears the remaining isolated specks.
        const share = boxMean(votes, 1).data;
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const i = (y + y0) * width + x + x0;
            if (picture.data[i] > 0.5) dark[i] = share[y * cw + x] > 0.5 ? 1 : 0;
          }
        }
      }
    }
    for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
      od[p] = od[p + 1] = od[p + 2] = dark[i] ? 0 : 255;
      od[p + 3] = 255;
    }
    return out;
  }

  // document: black (or grey) text; coloured print in its own colour; logos,
  // stamps, highlights, photos and colour areas composited from the enhanced
  // colour page. Most pages have little or no colour, so that page is only
  // computed when needed.
  const { labels, tone } = layer;
  const colours = blobColours(layer, flat);
  const marked = markColours(layer, flat, picture);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const l = labels[i];
    const c = ink[i];
    const m = marked ? marked.marks[i] : 0;
    if (l && colours[l * 3] >= 0) {
      od[p] = colours[l * 3] + (255 - colours[l * 3]) * c;
      od[p + 1] = colours[l * 3 + 1] + (255 - colours[l * 3 + 1]) * c;
      od[p + 2] = colours[l * 3 + 2] + (255 - colours[l * 3 + 2]) * c;
    } else if (m && marked) {
      const rgb = marked.rgb;
      od[p] = rgb[m * 3] + (255 - rgb[m * 3]) * c;
      od[p + 1] = rgb[m * 3 + 1] + (255 - rgb[m * 3 + 1]) * c;
      od[p + 2] = rgb[m * 3 + 2] + (255 - rgb[m * 3 + 2]) * c;
    } else {
      od[p] = od[p + 1] = od[p + 2] = (c + (1 - c) * tone[l]) * 255;
    }
    od[p + 3] = 255;
  }
  const weight = colorWeight(flat);
  let hasColor = picture !== null;
  for (let i = 0; i < weight.data.length && !hasColor; i++) hasColor = weight.data[i] > 0;
  if (!hasColor) return out;
  const color = enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false, picture);
  const fills = picture ? flatFills(analysis, color, picture) : null;
  const { cols, rows, block } = analysis.surface;
  const cd = color.data;
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    let cell = -1;
    if (picture) {
      const x = i % src.width;
      const y = (i - x) / src.width;
      cell =
        Math.min(rows - 1, Math.floor(y / block)) * cols +
        Math.min(cols - 1, Math.floor(x / block));
    }
    const inPicture = picture !== null && picture.data[i] > 0;
    const w = inPicture ? Math.max(weight.data[i], picture.data[i]) : weight.data[i];
    if (w <= 0) continue;
    let r = cd[p];
    let g = cd[p + 1];
    let b = cd[p + 2];
    const greyPicture =
      cell >= 0 && analysis.regions[cell] === PICTURE && greyPictures[analysis.regionIds[cell]];
    if (cell < 0 || analysis.regions[cell] !== PICTURE) {
      // Outside photos (and on their soft rim), a colour that is grey but for
      // a faint cast adds no colour, only noise: blending it in would make an
      // otherwise grey page need three channels in the PDF. Judged before
      // enhancement, which strengthens a cast.
      const fd = flat.data;
      if (
        Math.max(fd[p], fd[p + 1], fd[p + 2]) - Math.min(fd[p], fd[p + 1], fd[p + 2]) <=
        NEUTRAL_CHROMA
      )
        continue;
    }
    if (fills) {
      const x = i % src.width;
      const y = (i - x) / src.width;
      const id =
        analysis.regionIds[
          Math.min(rows - 1, Math.floor(y / block)) * cols +
            Math.min(cols - 1, Math.floor(x / block))
        ];
      if (id && fills[id * 3] >= 0) {
        const fr = fills[id * 3];
        const fg = fills[id * 3 + 1];
        const fb = fills[id * 3 + 2];
        if (Math.max(Math.abs(r - fr), Math.abs(g - fg), Math.abs(b - fb)) <= FILL_SNAP) {
          r = fr;
          g = fg;
          b = fb;
        }
      }
    }
    // A grey photo or soft grey print is composited as grey.
    if (greyPicture) r = g = b = luma01(r, g, b) * 255;
    od[p] += (r - od[p]) * w;
    od[p + 1] += (g - od[p + 1]) * w;
    od[p + 2] += (b - od[p + 2]) * w;
  }
  greyIfColourless(out);
  return out;
}

/** Pixels at least this colourful (max − min, 0..255) count as colour. */
const VISIBLE_CHROMA = 24;
/** A page with fewer colour pixels than this has no colour worth keeping. */
const MIN_COLOUR_PIXELS = 64;

/**
 * Make a page grey when what colour it has is only a faint cast or colour
 * fringes along edges: a few dozen colour pixels on a 300 dpi page are
 * invisible, and keeping them would store the page in three channels, three
 * times the size of one. Mutates `image`.
 */
function greyIfColourless(image: RGBAImage): void {
  const d = image.data;
  let coloured = 0;
  let tinted = false;
  for (let p = 0; p < d.length; p += 4) {
    const c = Math.max(d[p], d[p + 1], d[p + 2]) - Math.min(d[p], d[p + 1], d[p + 2]);
    if (c >= VISIBLE_CHROMA && ++coloured >= MIN_COLOUR_PIXELS) return;
    if (c > 0) tinted = true;
  }
  if (!tinted) return;
  for (let p = 0; p < d.length; p += 4) {
    d[p] = d[p + 1] = d[p + 2] = Math.round(luma01(d[p], d[p + 1], d[p + 2]) * 255);
  }
}

/**
 * The colour of every flat content area (a colour panel, a band, a tint),
 * RGB per area id, -1 where there is none. A robust mean: the lettering on
 * the area is left out by narrowing the tolerance around the mean in two
 * steps. Snapping the area's noisy pixels to it makes the fill one clean
 * colour, which also keeps the losslessly stored Document page small.
 */
function flatFills(
  analysis: PaperAnalysis,
  color: RGBAImage,
  picture: FloatImage,
): Float32Array | null {
  const { regionIds, flat } = analysis;
  if (!flat.some((f) => f === 1)) return null;
  const { cols, rows, block } = analysis.surface;
  const { width, height, data } = color;
  const fill = new Float32Array(flat.length * 3).fill(-1);
  for (const tolerance of [Infinity, 4 * FILL_SNAP, 2 * FILL_SNAP]) {
    const sums = new Float64Array(flat.length * 4);
    for (let y = 0; y < height; y += 2) {
      const row = Math.min(rows - 1, Math.floor(y / block)) * cols;
      for (let x = 0; x < width; x += 2) {
        const i = y * width + x;
        if (picture.data[i] < 0.99) continue;
        const id = regionIds[row + Math.min(cols - 1, Math.floor(x / block))];
        if (!id || !flat[id]) continue;
        const p = i * 4;
        if (
          tolerance < Infinity &&
          Math.max(
            Math.abs(data[p] - fill[id * 3]),
            Math.abs(data[p + 1] - fill[id * 3 + 1]),
            Math.abs(data[p + 2] - fill[id * 3 + 2]),
          ) > tolerance
        ) {
          continue;
        }
        sums[id * 4] += data[p];
        sums[id * 4 + 1] += data[p + 1];
        sums[id * 4 + 2] += data[p + 2];
        sums[id * 4 + 3]++;
      }
    }
    for (let id = 1; id < flat.length; id++) {
      const count = sums[id * 4 + 3];
      if (!count) continue;
      for (let c = 0; c < 3; c++) fill[id * 3 + c] = Math.round(sums[id * 4 + c] / count);
    }
  }
  return fill;
}

/** Whether a filter's output is greyscale, so the PDF can store one channel. */
export function isGrayFilter(filter: FilterId): boolean {
  return filter === 'bw' || filter === 'gray';
}
