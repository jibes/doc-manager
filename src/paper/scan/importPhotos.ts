import type { StillHint } from './engine/worker/protocol';
import type { FilterId } from './engine/imaging/filters';
import type { Quad } from './engine/imaging/image';
import { fallbackQuad } from './engine/imaging/quad';
import { isBlurred } from './engine/imaging/sharpness';
import { defaultSpec } from './engine/pipeline';
import type { DetectorClient } from './engine/worker/clients';
import { useScan } from './session';

export interface AddedPhoto {
  id: string;
  /** Page edges were found. */
  found: boolean;
  blurred: boolean;
  /** The page runs off the photo. */
  offFrame: boolean;
}

/**
 * Find the page in a photo and add it to the document, or, with `retakeId`, put it in place of that page's
 * photo. Without a working detector the page keeps the whole photo (imported) or a slight inset (camera)
 * for cropping by hand.
 */
export async function addPhoto(
  detector: DetectorClient,
  source: Blob,
  options: { filter: FilterId; imported?: boolean; retakeId?: string | null; hint?: StillHint },
): Promise<AddedPhoto> {
  const { filter, imported = false, retakeId = null, hint } = options;
  let result: { quad: Quad | null; width: number; height: number; sharpness: number | null; offFrame: boolean };
  try {
    result = await detector.still(source, hint);
  } catch {
    const bitmap = await createImageBitmap(source);
    result = { quad: null, width: bitmap.width, height: bitmap.height, sharpness: null, offFrame: false };
    bitmap.close();
  }
  const quad = result.quad ?? fallbackQuad(result.width, result.height, imported);
  const photo = { source, width: result.width, height: result.height, detected: result.quad, sharpness: result.sharpness };
  const found = result.quad !== null;
  const blurred = isBlurred(result);
  const scan = useScan.getState();
  if (retakeId && scan.pages.some((p) => p.id === retakeId)) {
    scan.replaceSource(retakeId, { ...photo, quad });
    return { id: retakeId, found, blurred, offFrame: result.offFrame };
  }
  const page = scan.add({ ...photo, spec: defaultSpec(quad, filter) });
  return { id: page.id, found, blurred, offFrame: result.offFrame };
}

export interface ImportSummary {
  added: number;
  /** Pages without detectable edges. */
  missing: number;
  /** Pages running off the photo. */
  cut: number;
  failed: number;
}

/** Add photos chosen in the file picker, in order. With `retakeId` only the first replaces that page. */
export async function importPhotos(
  detector: DetectorClient,
  files: Blob[],
  options: { filter: FilterId; retakeId?: string | null; onProgress?: (done: number, total: number) => void },
): Promise<ImportSummary> {
  const summary: ImportSummary = { added: 0, missing: 0, cut: 0, failed: 0 };
  for (const [index, file] of files.entries()) {
    options.onProgress?.(index, files.length);
    try {
      const { found, offFrame } = await addPhoto(detector, file, { filter: options.filter, retakeId: options.retakeId, imported: true });
      summary.added++;
      if (!found) summary.missing++;
      if (offFrame) summary.cut++;
    } catch {
      // Not an image the browser can decode: skip it, keep the others.
      summary.failed++;
    }
    if (options.retakeId) break;
  }
  return summary;
}
