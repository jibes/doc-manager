import type { TextLine } from '@/engine/types';

/** The parts of Tesseract's block output that reflow uses. */
export type OcrBlock = {
  paragraphs: {
    lines: {
      text: string;
      confidence: number;
      bbox: { x0: number; y0: number; x1: number; y1: number };
      rowAttributes?: { rowHeight: number };
    }[];
  }[];
};

/** Below this, a "line" is mostly noise from a photo or stain. */
const MIN_CONFIDENCE = 35;

/**
 * Tesseract lines → TextLine. Sizes come from the paragraph's median row height, in whole points,
 * so per-line jitter doesn't fake new sizes; only clearly larger lines keep their own.
 */
export function ocrLines(blocks: OcrBlock[], imgW: number, imgH: number, pageWidthPt: number): TextLine[] {
  const pt = pageWidthPt / imgW;
  const out: TextLine[] = [];
  for (const block of blocks)
    for (const para of block.paragraphs) {
      const lines = para.lines.filter((l) => l.confidence >= MIN_CONFIDENCE && /[\p{L}\p{N}]/u.test(l.text));
      if (!lines.length) continue;
      const height = (l: (typeof lines)[number]) => l.rowAttributes?.rowHeight || l.bbox.y1 - l.bbox.y0;
      const heights = lines.map(height).sort((a, b) => a - b);
      const typical = heights[Math.floor(heights.length / 2)];
      for (const l of lines) {
        // A line far taller than its paragraph (a heading Tesseract grouped with the text) keeps its own size.
        const size = Math.max(1, Math.round((height(l) > typical * 1.3 ? height(l) : typical) * pt));
        const text = l.text.replace(/\s+/g, ' ').trim();
        const { x0, y0, x1, y1 } = l.bbox;
        out.push({
          text,
          rect: { x: x0 / imgW, y: y0 / imgH, w: (x1 - x0) / imgW, h: (y1 - y0) / imgH },
          size,
          bold: false,
          italic: false,
          hyphen: /[-­‐]$/.test(text),
        });
      }
    }
  return out;
}
