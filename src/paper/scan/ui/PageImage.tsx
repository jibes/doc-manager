import type { Page } from '../types';

export type PageImageProps = { page: Page; longEdge: number; channel: string; unfiltered?: boolean; onRendering?: (rendering: boolean) => void };

/** Scanning is web only (and the Android app, which runs the web app). */
export function PageImage(_: PageImageProps) {
  return null;
}
