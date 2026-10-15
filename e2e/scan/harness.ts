/**
 * In-browser half of the scan quality harness (bundled and driven by e2e/scan/run.mjs).
 *
 * For one case it synthesises the phone photo, then runs the app's own code:
 * the detector worker's still() (model + corner refinement + blur score), the
 * processor worker's export encode for every filter (exactly the pixels that
 * go into the PDF), and export.ts exportPdf() with OCR, which goes through
 * exportCache, the OCR worker and the PDF writer as the Save button does.
 */
import { DOCUMENTS, renderDoc, truthText, type DocSpec } from './corpus';
import {
  binaryShare,
  blobBase64,
  canvasToRGBA,
  cer,
  cornerError,
  decodePdfImage,
  diffImage,
  encodeImage,
  pageMetrics,
  rgbaToCanvas,
  specialChars,
  wordRecall,
  type PageMetrics,
  type Truth,
  type ColourMetrics,
  colourMetrics,
  bagRecall,
} from './metrics';
import { CASES, photograph } from './scene';
import type { FilterId } from '../../src/scan/engine/imaging/filters';
import type { Quad, RGBAImage } from '../../src/scan/engine/imaging/image';
import { applyHomography, fallbackQuad, homography } from '../../src/scan/engine/imaging/quad';
import { isBlurred } from '../../src/scan/engine/imaging/sharpness';
import { exportPdf, pagePaperSize } from '../../src/scan/export';
import { defaultSpec } from '../../src/scan/engine/pipeline';
import { detector, processor } from '../../src/scan/services';
import { DEFAULT_SCAN_SETTINGS, RESOLUTION_LONG_EDGE, type Page } from '../../src/scan/types';
import { OcrClient } from '../../src/scan/engine/worker/clients';

const FILTERS: FilterId[] = ['document', 'bw', 'gray', 'color', 'original'];
const LONG_EDGE = RESOLUTION_LONG_EDGE[DEFAULT_SCAN_SETTINGS.resolution];

export interface CaseOptions {
  ocr: boolean;
  /** Also OCR the clean, printed page, to separate OCR limits from scan losses. */
  cleanOcr: boolean;
  filters: FilterId[];
}

export interface CaseResult {
  id: string;
  doc: string;
  title: string;
  truth: {
    quad: Quad;
    widthMm: number;
    heightMm: number;
    format: string | null;
    text: string;
    /** Text printed over colour. */
    zoneText: string;
    special?: string;
  };
  photo: { width: number; height: number; bytes: number };
  detection: {
    found: boolean;
    quad: Quad;
    confidence: number;
    sharpness: number;
    blurred: boolean;
    expectBlurred: boolean;
    /** Where the quad came from (model / edges / none) and whether it was clipped to the frame. */
    source?: string;
    offFrame?: boolean;
    cornerErr: number[];
    shift: number;
  };
  output: {
    width: number;
    height: number;
    aspect: number;
    truthAspect: number;
    aspectErr: number;
    /** PDF page size the export picks, mm. */
    pageMm: [number, number];
    format: string | null;
    /** Clockwise quarter turns auto-orientation applied in the PDF. */
    turn?: number;
  };
  filters: Record<
    string,
    {
      bytes: number;
      ms: number;
      binary?: number;
      metrics?: PageMetrics;
      colour?: ColourMetrics;
      ocrText?: string;
    }
  >;
  /** Colour cases: every filter on the true corners. */
  trueCropFilters?: CaseResult['filters'];
  /** Document filter rendered with the true corners: filter quality alone. */
  truthCrop: PageMetrics;
  ocrClean?: { cer: number; ms: number; text: string };
  pdf?: { bytes: number; ms: number };
  timings: Record<string, number>;
  /** base64 artifacts: name -> data. */
  files: Record<string, string>;
}

async function timed<T>(
  timings: Record<string, number>,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

/** The page with OCR word boxes drawn on it (red) and their text above (blue). */
function boxOverlay(
  img: RGBAImage,
  words: { text: string; x0: number; y0: number; x1: number; y1: number }[],
) {
  const c = rgbaToCanvas(img);
  const g = c.getContext('2d')!;
  g.lineWidth = 1.5;
  g.font = '11px sans-serif';
  for (const w of words) {
    g.strokeStyle = 'rgba(230,0,0,0.8)';
    g.strokeRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
    g.fillStyle = 'rgba(0,0,200,0.9)';
    g.fillText(w.text, w.x0, w.y0 - 1);
  }
  return c;
}

/**
 * The printed page as it should appear in an output rectified from `quad`:
 * each output pixel is mapped back through the app's rectification into the
 * photo and from there, through the true corners, onto the page. Detection
 * error therefore shows up as geometry (corner error), not as lost ink.
 */
/** OCR as export does it: the page scaled to a 2600 px long edge. */
async function ocrText(pixels: RGBAImage): Promise<string> {
  const reader = new OcrClient();
  try {
    const scale = Math.min(1, 2600 / Math.max(pixels.width, pixels.height));
    const small = canvasToRGBA(
      rgbaToCanvas(pixels),
      Math.round(pixels.width * scale),
      Math.round(pixels.height * scale),
    );
    const { words } = await reader.recognise(small);
    return words.map((w) => w.text).join(' ');
  } catch (error) {
    return `OCR failed: ${error}`;
  } finally {
    reader.dispose();
  }
}

/** Labelled panels side by side, 1000 px tall. */
async function sideBySide(
  panels: (OffscreenCanvas | ImageBitmap)[],
  labels: string[],
): Promise<string> {
  const H = 1000;
  const widths = panels.map((p) => Math.round((p.width * H) / p.height));
  const c = new OffscreenCanvas(
    widths.reduce((a, b) => a + b + 8, 0),
    H + 30,
  );
  const g = c.getContext('2d')!;
  g.fillStyle = '#777';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '22px sans-serif';
  let x = 0;
  panels.forEach((p, i) => {
    g.drawImage(p, x, 30, widths[i], H);
    g.fillStyle = '#fff';
    g.fillText(labels[i] ?? '', x + 6, 22);
    x += widths[i] + 8;
  });
  return encodeImage(c, 'image/jpeg', undefined, 0.85);
}

function truthFor(doc: DocSpec, quad: Quad, trueQuad: Quad, width: number, height: number): Truth {
  const pxPerMm = Math.max(width / doc.widthMm, height / doc.heightMm) * 1.25;
  const full = canvasToRGBA(renderDoc(doc, pxPerMm, 'full'));
  const mask = canvasToRGBA(renderDoc(doc, pxPerMm, 'mask'));
  const reversed = canvasToRGBA(renderDoc(doc, pxPerMm, 'reversed'));
  const sw = full.width;
  const sh = full.height;
  const toPhoto = homography(
    [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ],
    quad,
  );
  const toPage = homography(trueQuad, [
    [0, 0],
    [sw, 0],
    [sw, sh],
    [0, sh],
  ]);
  const n = width * height;
  const out: Truth = {
    full: { data: new Uint8ClampedArray(n * 4), width, height },
    mask: { data: new Uint8ClampedArray(n * 4), width, height },
    reversed: { data: new Uint8ClampedArray(n * 4), width, height },
    mm: new Float32Array(n * 2),
  };
  const paper = parseInt(doc.paper.slice(1), 16);
  const paperRgb = [(paper >> 16) & 255, (paper >> 8) & 255, paper & 255];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const [px, py] = applyHomography(toPhoto, x + 0.5, y + 0.5);
      const [u, v] = applyHomography(toPage, px, py);
      out.mm[i * 2] = (u / sw) * doc.widthMm;
      out.mm[i * 2 + 1] = (v / sh) * doc.heightMm;
      const o = i * 4;
      if (u < 0.5 || v < 0.5 || u >= sw - 1.5 || v >= sh - 1.5) {
        // Off the page: the output should show nothing here either.
        out.full.data.set([...paperRgb, 255], o);
        out.mask.data.set([255, 255, 255, 255], o);
        out.reversed.data.set([255, 255, 255, 255], o);
        continue;
      }
      const iu = Math.floor(u - 0.5);
      const iv = Math.floor(v - 0.5);
      const fu = u - 0.5 - iu;
      const fv = v - 0.5 - iv;
      const p = (iv * sw + iu) * 4;
      const q = p + sw * 4;
      for (let k = 0; k < 4; k++) {
        const bil = (d: Uint8ClampedArray) =>
          (d[p + k] * (1 - fu) + d[p + 4 + k] * fu) * (1 - fv) +
          (d[q + k] * (1 - fu) + d[q + 4 + k] * fu) * fv;
        out.full.data[o + k] = bil(full.data);
        out.mask.data[o + k] = bil(mask.data);
        out.reversed.data[o + k] = bil(reversed.data);
      }
    }
  }
  return out;
}

export function listCases(): { id: string; doc: string; title: string }[] {
  return CASES.map(({ id, doc, title }) => ({ id, doc, title }));
}

export async function runCase(id: string, options: CaseOptions): Promise<CaseResult> {
  const kase = CASES.find((c) => c.id === id);
  if (!kase) throw new Error(`Unknown case ${id}`);
  const doc = DOCUMENTS[kase.doc]();
  const timings: Record<string, number> = {};
  const files: Record<string, string> = {};

  const photo = await timed(timings, 'synth', () => photograph(doc, kase.scene));
  files['photo.jpg'] = await blobBase64(photo.blob);

  // --- Detect, as CameraScreen.addPhoto does.
  const det = detector();
  await timed(timings, 'detectorLoad', () => det.ready);
  const still = await timed(timings, 'detect', () => det.still(photo.blob));
  const quad = still.quad ?? fallbackQuad(still.width, still.height, kase.imported);
  const { errors, shift } = cornerError(quad, photo.quad);

  const page: Page = {
    id: `e2e-${id}`,
    source: photo.blob,
    width: still.width,
    height: still.height,
    spec: defaultSpec(quad, 'document'),
    detected: still.quad,
    sharpness: still.sharpness,
  };

  // --- Every filter, exactly as encoded for the PDF.
  const proc = processor();
  const filters: CaseResult['filters'] = {};
  const truthAspect = doc.widthMm / doc.heightMm;
  let outW = 0;
  let outH = 0;
  let truth: Truth | null = null;
  const outputs: Record<string, RGBAImage> = {};
  for (const filter of options.filters) {
    const start = performance.now();
    const enc = await proc.encode({
      pageId: page.id,
      source: photo.blob,
      sourceKey: page.id,
      sourceWidth: still.width,
      sourceHeight: still.height,
      spec: defaultSpec(quad, filter),
      longEdge: LONG_EDGE,
      jpegQuality: DEFAULT_SCAN_SETTINGS.jpegQuality,
    });
    const ms = Math.round(performance.now() - start);
    outW = enc.width;
    outH = enc.height;
    const pixels = await decodePdfImage(enc.image, enc.width, enc.height);
    truth ??= truthFor(doc, quad, photo.quad, pixels.width, pixels.height);
    const entry: CaseResult['filters'][string] = { bytes: enc.image.bytes.length, ms };
    if (kase.allFilters || filter === 'document' || filter === 'bw' || filter === 'gray') {
      entry.metrics = pageMetrics(pixels, truth, doc);
    }
    if (kase.allFilters) entry.colour = colourMetrics(pixels, truth, doc);
    if (kase.allFilters && options.ocr) entry.ocrText = await ocrText(pixels);
    if (filter === 'bw') entry.binary = binaryShare(pixels);
    filters[filter] = entry;
    outputs[filter] = pixels;
    const canvas = rgbaToCanvas(pixels);
    if (filter === 'document') files['out_document.png'] = await encodeImage(canvas, 'image/png');
    else files[`out_${filter}.jpg`] = await encodeImage(canvas, 'image/jpeg', 1600, 0.9);
  }

  // --- Colour cases: every filter again on the true crop, so filter behaviour on
  // colour is measured even where detection cropped the page wrongly.
  const trueQuad = photo.quad;
  let trueCropFilters: CaseResult['trueCropFilters'];
  if (kase.allFilters) {
    trueCropFilters = {};
    const panels: OffscreenCanvas[] = [];
    let t: Truth | null = null;
    for (const filter of options.filters) {
      const e = await proc.encode({
        pageId: `${page.id}-true`,
        source: photo.blob,
        sourceKey: page.id,
        sourceWidth: still.width,
        sourceHeight: still.height,
        spec: defaultSpec(trueQuad, filter),
        longEdge: LONG_EDGE,
        jpegQuality: DEFAULT_SCAN_SETTINGS.jpegQuality,
      });
      const px = await decodePdfImage(e.image, e.width, e.height);
      t ??= truthFor(doc, trueQuad, trueQuad, px.width, px.height);
      trueCropFilters[filter] = {
        bytes: e.image.bytes.length,
        ms: 0,
        metrics: pageMetrics(px, t, doc),
        colour: colourMetrics(px, t, doc),
        ocrText: options.ocr ? await ocrText(px) : undefined,
      };
      panels.push(rgbaToCanvas(px));
    }
    if (t) panels.push(rgbaToCanvas(t.full));
    files['filters_truecrop_side_by_side.jpg'] = await sideBySide(panels, [
      ...options.filters,
      'printed',
    ]);
  }

  // --- The Document filter on the true crop: filter quality without detection error.
  const enc = await timed(timings, 'encodeTruthCrop', () =>
    proc.encode({
      pageId: `${page.id}-truth`,
      source: photo.blob,
      sourceKey: page.id,
      sourceWidth: still.width,
      sourceHeight: still.height,
      spec: defaultSpec(trueQuad, 'document'),
      longEdge: LONG_EDGE,
      jpegQuality: DEFAULT_SCAN_SETTINGS.jpegQuality,
    }),
  );
  const truePixels = await decodePdfImage(enc.image, enc.width, enc.height);
  const t2 = truthFor(doc, trueQuad, trueQuad, truePixels.width, truePixels.height);
  const truthCrop = pageMetrics(truePixels, t2, doc);
  const diff = diffImage(truePixels, t2.mask);
  files['diff_truthcrop.png'] = await encodeImage(rgbaToCanvas(diff), 'image/png', 2000);
  // A full-resolution detail crop of the diff, around the first text.
  {
    const c = rgbaToCanvas(diff);
    const cw = Math.min(900, c.width);
    const ch = Math.min(600, c.height);
    const firstText = doc.ops.find((o) => o.kind === 'text');
    const fx = firstText && firstText.kind === 'text' ? firstText.x : 10;
    const fy = firstText && firstText.kind === 'text' ? firstText.y : 10;
    const x = Math.max(0, Math.min(c.width - cw, Math.round(((fx - 3) * c.width) / doc.widthMm)));
    const y = Math.max(
      0,
      Math.min(c.height - ch, Math.round(((fy - 10) * c.height) / doc.heightMm)),
    );
    const crop = new OffscreenCanvas(cw, ch);
    crop.getContext('2d')!.drawImage(c, x, y, cw, ch, 0, 0, cw, ch);
    files['diff_detail.png'] = await encodeImage(crop, 'image/png');
    const t = rgbaToCanvas(truePixels);
    const crop2 = new OffscreenCanvas(cw, ch);
    crop2.getContext('2d')!.drawImage(t, x, y, cw, ch, 0, 0, cw, ch);
    files['out_detail.png'] = await encodeImage(crop2, 'image/png');
  }

  // --- Side by side: photo | original | document | truth.
  {
    const H = 1100;
    const photoBitmap = await createImageBitmap(photo.blob);
    const panels: (OffscreenCanvas | ImageBitmap)[] = [photoBitmap];
    if (outputs.original) panels.push(rgbaToCanvas(outputs.original));
    if (outputs.document) panels.push(rgbaToCanvas(outputs.document));
    if (truth) panels.push(rgbaToCanvas(truth.full));
    const widths = panels.map((p) => Math.round((p.width * H) / p.height));
    const c = new OffscreenCanvas(
      widths.reduce((a, b) => a + b + 10, 0),
      H,
    );
    const g = c.getContext('2d')!;
    g.fillStyle = '#888';
    g.fillRect(0, 0, c.width, H);
    g.imageSmoothingQuality = 'high';
    let x = 0;
    panels.forEach((p, i) => {
      g.drawImage(p, x, 0, widths[i], H);
      if (i === 0) {
        // Truth quad (green) and detected quad (red) on the photo.
        const s = H / p.height;
        const poly = (q: Quad, color: string) => {
          g.strokeStyle = color;
          g.lineWidth = 3;
          g.beginPath();
          q.forEach(([px, py], k) => (k ? g.lineTo(px * s, py * s) : g.moveTo(px * s, py * s)));
          g.closePath();
          g.stroke();
        };
        poly(photo.quad, '#0c0');
        poly(quad, '#f00');
      }
      x += widths[i] + 10;
    });
    photoBitmap.close();
    files['side_by_side.jpg'] = await encodeImage(c, 'image/jpeg', undefined, 0.85);
  }

  if (kase.allFilters) {
    const H = 1000;
    const photoBitmap = await createImageBitmap(photo.blob);
    const panels: (OffscreenCanvas | ImageBitmap)[] = [
      photoBitmap,
      ...options.filters.filter((f) => outputs[f]).map((f) => rgbaToCanvas(outputs[f])),
    ];
    if (truth) panels.push(rgbaToCanvas(truth.full));
    const widths = panels.map((p) => Math.round((p.width * H) / p.height));
    const c = new OffscreenCanvas(
      widths.reduce((a, b) => a + b + 8, 0),
      H + 30,
    );
    const g = c.getContext('2d')!;
    g.fillStyle = '#777';
    g.fillRect(0, 0, c.width, c.height);
    g.font = '22px sans-serif';
    const labels = ['photo', ...options.filters.filter((f) => outputs[f]), 'printed'];
    let x = 0;
    panels.forEach((p, i) => {
      g.drawImage(p, x, 30, widths[i], H);
      g.fillStyle = '#fff';
      g.fillText(labels[i], x + 6, 22);
      x += widths[i] + 8;
    });
    photoBitmap.close();
    files['filters_side_by_side.jpg'] = await encodeImage(c, 'image/jpeg', undefined, 0.85);
  }

  const text = truthText(doc);

  // --- OCR on the clean page (upper bound for the OCR model).
  let ocrClean: CaseResult['ocrClean'];
  if (options.ocr && options.cleanOcr) {
    const clean = canvasToRGBA(renderDoc(doc, 2600 / Math.max(doc.widthMm, doc.heightMm)));
    const reader = new OcrClient();
    const start = performance.now();
    try {
      const { words } = await reader.recognise({
        ...clean,
        data: new Uint8ClampedArray(clean.data),
      });
      const got = words.map((w) => w.text).join(' ');
      files['ocr_clean_boxes.png'] = await encodeImage(boxOverlay(clean, words), 'image/png');
      ocrClean = { cer: cer(text, got), ms: Math.round(performance.now() - start), text: got };
    } finally {
      reader.dispose();
    }
  }

  // --- The PDF, as the Save button builds it.
  let pdf: CaseResult['pdf'];
  // Quarter turns OCR applied to the page in the PDF (auto-orientation).
  let turn = 0;
  {
    const start = performance.now();
    const blob = await exportPdf(
      [page],
      { ...DEFAULT_SCAN_SETTINGS, ocr: options.ocr },
      `E2E ${id}`,
      () => undefined,
      {
        searchable: options.ocr,
        onTurn: (_, t) => (turn = t),
      },
    );
    pdf = { bytes: blob.size, ms: Math.round(performance.now() - start) };
    files['scan.pdf'] = await blobBase64(blob);
  }

  const size = pagePaperSize(page, outW, outH);
  const aspect = outW / outH;
  // Compare in the photo's orientation: odd shifts swap the page's sides.
  const expected = shift % 2 ? 1 / truthAspect : truthAspect;
  return {
    id,
    doc: kase.doc,
    title: kase.title,
    truth: {
      quad: photo.quad,
      widthMm: doc.widthMm,
      heightMm: doc.heightMm,
      format: doc.format,
      text,
      special: doc.special,
      zoneText: doc.ops
        .filter((o) => o.kind === 'text' && o.zone === 'colour' && o.ocr !== false)
        .map((o) => (o.kind === 'text' ? o.text : ''))
        .join('\n'),
    },
    photo: { width: photo.width, height: photo.height, bytes: photo.blob.size },
    detection: {
      found: still.quad !== null,
      quad,
      confidence: still.confidence,
      sharpness: still.sharpness,
      blurred: isBlurred({ sharpness: still.sharpness }),
      source: still.source,
      offFrame: still.offFrame,
      expectBlurred: !!kase.expectBlurred,
      cornerErr: errors.map((e) => Math.round(e * 10) / 10),
      shift,
    },
    output: {
      width: outW,
      height: outH,
      aspect,
      truthAspect: expected,
      aspectErr: aspect / expected - 1,
      pageMm: [(size.width / 72) * 25.4, (size.height / 72) * 25.4],
      turn,
      format: size.format,
    },
    filters,
    truthCrop,
    ocrClean,
    trueCropFilters,
    pdf,
    timings,
    files,
  };
}

/** Text accuracy of `got` (e.g. pdftotext output) against the case's ground truth. */
export function textMetrics(truth: string, got: string, special?: string, zone?: string) {
  return {
    zoneRecall: zone ? bagRecall(zone, got) : undefined,
    cer: cer(truth, got),
    words: wordRecall(truth, got),
    special: special ? specialChars(special, truth, got) : undefined,
  };
}

declare global {
  interface Window {
    e2e: {
      runCase: typeof runCase;
      listCases: typeof listCases;
      textMetrics: typeof textMetrics;
      FILTERS: FilterId[];
    };
  }
}
window.e2e = { runCase, listCases, textMetrics, FILTERS };
