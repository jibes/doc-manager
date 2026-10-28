import type { DocHandle } from '@/core/engine/types';
import { t } from '@/core/i18n';
import { repo, type DocRecord } from '@/core/storage';
import { detailsOf } from '@/paper/archive/details';
import { invalidate } from '@/paper/archive/indexer';
import { useIntake } from '@/paper/archive/intake';
import { infoFor, withInfo } from '@/paper/archive/pdfInfo';
import { libraryActions } from '@/paper/state/library';
import type { FilterId } from './engine/imaging/filters';
import { fallbackQuad } from './engine/imaging/quad';
import { defaultSpec } from './engine/pipeline';
import { exportPdf } from './export';
import type { SaveProgress } from './save';
import { useScan, type Replaces } from './session';
import type { Page, ScanSettings } from './types';

/** Pages drawn this many pixels along their longer side: about 290 dpi for A4, what a scan app saves at most. */
const LONG_SIDE = 2400;
const JPEG_QUALITY = 0.92;

/**
 * A document scanned elsewhere (no filter, crooked, grey) into the scanner: each page as a photo of the whole
 * page, with `filter`, to crop, turn and filter as any scan. Saving puts the pages back into the same file
 * (saveAgain). The scan must be empty.
 */
export async function scanAgain(doc: DocRecord, handle: DocHandle, filter: FilterId, onProgress?: (done: number, total: number) => void): Promise<void> {
  const run = addPages(doc, handle, filter, onProgress);
  preparing = run;
  try {
    await run;
  } finally {
    if (preparing === run) preparing = null;
  }
}

/** Pages being put into the scanner for scanAgain: a new scan waits for them (else they would end up in it). */
let preparing: Promise<void> | null = null;
export const preparingAgain = () => preparing;

async function addPages(doc: DocRecord, handle: DocHandle, filter: FilterId, onProgress?: (done: number, total: number) => void): Promise<void> {
  const scan = useScan.getState();
  await scan.restore();
  for (let p = 0; p < handle.pageCount; p++) {
    onProgress?.(p, handle.pageCount);
    const { width: w, height: h } = handle.pageSizes[p];
    const raster = await handle.renderPage(p, { width: Math.round(w >= h ? LONG_SIDE : (LONG_SIDE * w) / h) });
    if (raster.kind !== 'bitmap') throw new Error(t.scanNotKept);
    const canvas = new OffscreenCanvas(raster.width, raster.height);
    canvas.getContext('2d')!.drawImage(raster.bitmap, 0, 0);
    raster.bitmap.close();
    const source = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const quad = fallbackQuad(raster.width, raster.height, true);
    scan.add({ source, width: raster.width, height: raster.height, detected: null, sharpness: null, spec: defaultSpec(quad, filter) });
  }
  // Only with all its pages in: stopped part way (the app closed), the draft is a scan of its own, not one that
  // would replace the document with some of its pages.
  scan.setReplaces({ id: doc.id, title: doc.title, details: detailsOf(handle, doc.title), other: handle.metadata.other });
  scan.setTitle(doc.title);
}

/**
 * The pages scanned again written into the document they came from, its details kept (notes on the old pages
 * go with them), the title as typed. Write access is asked for before (while the tap counts). An open reader of it opens it again.
 */
export async function saveAgain(replaces: Replaces, title: string, pages: Page[], settings: ScanSettings, onProgress: (p: SaveProgress) => void, signal?: AbortSignal): Promise<{ doc?: DocRecord; unread: number }> {
  let unread = 0;
  // The title as typed in the scanner (it starts as the document's).
  const details = { ...replaces.details, title: title.trim() || replaces.details.title || replaces.title };
  const pdf = await exportPdf(pages, settings, details.title, (done, total) => onProgress({ phase: 'render', done, total }), {
    searchable: settings.ocr,
    onReading: (page, total) => onProgress({ phase: 'read', done: page, total }),
    signal,
    onUnread: () => unread++,
  });
  const bytes = withInfo(new Uint8Array(await pdf.arrayBuffer()), infoFor(details, replaces.other));
  await repo.writeFile(replaces.id, bytes.buffer);
  await libraryActions().rewritten(replaces.id, bytes.buffer);
  // The text read from the old pages is theirs, not these.
  await repo.clearOcr(replaces.id).catch(() => {});
  libraryActions().patchDoc(replaces.id, { bytes: bytes.byteLength });
  void libraryActions().refreshCover(replaces.id, new Blob([bytes]));
  invalidate(replaces.id);
  useIntake.setState({ finished: { id: replaces.id, said: t.againSaved, changed: true } });
  return { doc: libraryActions().docs.find((d) => d.id === replaces.id), unread };
}
