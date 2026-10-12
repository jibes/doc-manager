import {
  applyFilter,
  DEFAULT_ADJUSTMENTS,
  type Adjustments,
  type FilterContext,
  type FilterId,
} from './imaging/filters';
import { rotateRGBA, type Quad, type RGBAImage } from './imaging/image';
import { fitLongEdge, quadPageSize } from './imaging/quad';
import { warpQuad } from './imaging/resample';

/** Everything needed to turn a source photo into a finished page. */
export interface PageSpec {
  /** Page corners in source pixel-edge coordinates, TL, TR, BR, BL. */
  quad: Quad;
  /** Clockwise quarter turns applied after rectification. */
  rotation: number;
  /**
   * The rotation is settled: the user turned the page, or OCR found it
   * upright. Otherwise OCR may find it sideways or upside down and turn it.
   */
  oriented?: boolean;
  filter: FilterId;
  adjustments: Adjustments;
}

export function defaultSpec(quad: Quad, filter: FilterId = 'document'): PageSpec {
  return { quad, rotation: 0, filter, adjustments: { ...DEFAULT_ADJUSTMENTS } };
}

/** Upscaling past this adds no detail, only cost. */
const MAX_UPSCALE = 2;

type Size = { width: number; height: number };

/**
 * Pixel size of the rectified page for a requested long edge, before rotation.
 * `image` is the source photo's size, which lets the aspect ratio be corrected
 * for perspective.
 *
 * Export asks for a fixed long edge so every page lands near the same DPI;
 * moderate upscaling is deliberate, because thresholding a bicubically
 * enlarged page gives smoother glyph edges than thresholding the original.
 */
export function outputSize(quad: Quad, longEdge: number, image?: Size): Size {
  const page = quadPageSize(quad, image);
  const pageLong = Math.max(page.width, page.height);
  return fitLongEdge(page, Math.min(longEdge, pageLong * MAX_UPSCALE));
}

/** Output pixels per source pixel for this crop at this long edge. */
export function filterContext(quad: Quad, longEdge: number, image?: Size): FilterContext {
  const page = quadPageSize(quad, image);
  const size = outputSize(quad, longEdge, image);
  return {
    sourceScale: Math.max(size.width, size.height) / Math.max(page.width, page.height),
  };
}

/** Rectify and rotate only; the expensive, filter-independent half. */
export function rectifyPage(
  source: RGBAImage,
  spec: Pick<PageSpec, 'quad' | 'rotation'>,
  longEdge: number,
): RGBAImage {
  const size = outputSize(spec.quad, longEdge, source);
  return rotateRGBA(warpQuad(source, spec.quad, size.width, size.height), spec.rotation);
}

export function renderPage(source: RGBAImage, spec: PageSpec, longEdge: number): RGBAImage {
  return applyFilter(
    rectifyPage(source, spec, longEdge),
    spec.filter,
    spec.adjustments,
    filterContext(spec.quad, longEdge, source),
  );
}
