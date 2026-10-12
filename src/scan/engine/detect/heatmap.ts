import { labelComponents } from '../imaging/components';
import { isConvex, quadArea } from '../imaging/quad';
import type { Point, Quad } from '../imaging/image';

export interface Detection {
  /** Corners normalised to 0..1 of the model input, TL, TR, BR, BL. */
  quad: Quad;
  /** Weakest of the four heatmap peaks, 0..1. */
  confidence: number;
}

/** Same cut-off as DocAligner's reference post-processing. */
const HEAT_THRESHOLD = 0.3;
/** Reject detections covering less than this fraction of the frame. */
const MIN_AREA = 0.04;

/**
 * Turn DocAligner's four corner heatmaps (`[4, size, size]`, values 0..1, in
 * TL, TR, BR, BL order) into a quad.
 *
 * Per channel: threshold, keep the largest connected blob, and take its
 * heat-weighted centroid. The weighting gives sub-cell precision, which
 * matters because one heatmap cell is several pixels of the photo.
 */
export function heatmapsToQuad(heat: Float32Array, size: number): Detection | null {
  const plane = size * size;
  const points: Point[] = [];
  let confidence = 1;

  for (let c = 0; c < 4; c++) {
    const offset = c * plane;
    const mask = new Uint8Array(plane);
    let peak = 0;
    for (let i = 0; i < plane; i++) {
      const v = heat[offset + i];
      if (v > peak) peak = v;
      if (v >= HEAT_THRESHOLD) mask[i] = 1;
    }
    if (peak < HEAT_THRESHOLD) return null;

    const { labels, areas } = labelComponents(mask, size, size);
    let best = 0;
    for (let l = 1; l < areas.length; l++) if (areas[l] > areas[best]) best = l;

    let sx = 0;
    let sy = 0;
    let sw = 0;
    // The peak of the blob used, not of the channel: a strong stray blob
    // elsewhere says nothing about how sure the chosen corner is.
    let blobPeak = 0;
    for (let i = 0; i < plane; i++) {
      if (labels[i] !== best) continue;
      const w = heat[offset + i];
      sx += ((i % size) + 0.5) * w;
      sy += (Math.floor(i / size) + 0.5) * w;
      sw += w;
      if (w > blobPeak) blobPeak = w;
    }
    confidence = Math.min(confidence, blobPeak);
    points.push([sx / sw / size, sy / sw / size]);
  }

  const quad: Quad = [points[0], points[1], points[2], points[3]];
  if (!isConvex(quad) || quadArea(quad) < MIN_AREA) return null;
  return { quad, confidence };
}
