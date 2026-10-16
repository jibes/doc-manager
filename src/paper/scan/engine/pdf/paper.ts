const MM = 72 / 25.4;

/** Short x long edge in PDF points (1/72 in). */
const FORMATS = [
  { name: 'A4', short: 595.28, long: 841.89, tolerance: 0.035 },
  { name: 'Letter', short: 612, long: 792, tolerance: 0.035 },
  { name: 'Legal', short: 612, long: 1008, tolerance: 0.035 },
  // ISO/IEC 7810 ID-1: identity cards, bank and membership cards. Close to
  // Legal's shape, so it only claims a tighter window.
  { name: 'ID-1', short: 53.98 * MM, long: 85.6 * MM, tolerance: 0.02 },
] as const;

/** Formats that are named in the result (the others are sized but unnamed). */
const PAPER = new Set(['A4', 'Letter', 'Legal']);

/** Long/short ratio from which a page is taken for a till receipt. */
const RECEIPT_ASPECT = 1.9;
/**
 * Width of a till receipt. Thermal rolls are 80 mm (most shops) or 57/58 mm
 * (card terminals, small tills); the shape alone cannot tell them apart, so
 * the common one is assumed and a 57 mm slip comes out 1.4x too large.
 */
const RECEIPT_WIDTH = 80 * MM;

/** Unknown shapes are fitted into this box (A4), which prints and views sensibly. */
const FIT_SHORT = 595.28;
const FIT_LONG = 841.89;

export interface PageSize {
  width: number;
  height: number;
  /** Paper format matched (A4, Letter, Legal), or null. */
  format: string | null;
  /** How the size was arrived at. */
  basis: 'paper' | 'card' | 'receipt' | 'fit';
}

/**
 * Physical page size for a rectified page, in points.
 *
 * A photo carries no scale: the pixel count depends on how close the camera
 * was, so the size has to be inferred from the shape alone. A page whose
 * aspect ratio matches A4 (the whole A series shares it), Letter or Legal
 * gets that format; one shaped like an ID-1 card gets the card's size; a
 * long narrow strip is taken for an 80 mm till receipt. Anything else is
 * scaled to fit an A4 page, which is a guess and says so (`basis: 'fit'`).
 *
 * With `known: false` (the crop is a guess, or the page runs off the photo)
 * the shape is not the page's, so no format or card is matched.
 */
export function pageSizePoints(
  widthPx: number,
  heightPx: number,
  { known = true }: { known?: boolean } = {},
): PageSize {
  const portrait = heightPx >= widthPx;
  const long = Math.max(widthPx, heightPx);
  const short = Math.max(1, Math.min(widthPx, heightPx));
  const aspect = long / short;
  const orient = (s: number, l: number) =>
    portrait ? { width: s, height: l } : { width: l, height: s };

  if (known) {
    let best: (typeof FORMATS)[number] | null = null;
    let bestError = Infinity;
    for (const f of FORMATS) {
      const error = Math.abs(aspect - f.long / f.short) / (f.long / f.short);
      if (error <= f.tolerance && error < bestError) {
        bestError = error;
        best = f;
      }
    }
    if (best) {
      return {
        ...orient(best.short, best.long),
        format: PAPER.has(best.name) ? best.name : null,
        basis: PAPER.has(best.name) ? 'paper' : 'card',
      };
    }
  }
  // Also for a receipt that runs off the photo: its width is still in view.
  if (aspect >= RECEIPT_ASPECT) {
    return { ...orient(RECEIPT_WIDTH, RECEIPT_WIDTH * aspect), format: null, basis: 'receipt' };
  }
  const scale = Math.min(FIT_SHORT / short, FIT_LONG / long);
  return { ...orient(short * scale, long * scale), format: null, basis: 'fit' };
}
