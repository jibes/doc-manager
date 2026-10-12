import type { Quad } from '../engine/imaging/image';
import type { Page } from '../types';

export type CropEditorProps = { page: Page; quad: Quad; onChange: (quad: Quad) => void };

/** Scanning is web only (and the Android app, which runs the web app). */
export function CropEditor(_: CropEditorProps) {
  return null;
}
