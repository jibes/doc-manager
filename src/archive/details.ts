import type { DocHandle } from '@/engine/types';
import { repo } from '@/storage';
import { infoFor, parseTags, withInfo, type Details } from './pdfInfo';

/** The details a PDF carries (falling back to `title` when it has none). */
export function detailsOf(handle: DocHandle, title: string): Details {
  const m = handle.metadata;
  return { title: m.title ?? title, sender: m.author ?? '', type: m.subject ?? '', tags: parseTags(m.keywords), date: m.date ?? '' };
}

/**
 * Writes `details` into the document's file: its bytes as they are (unsaved edits included) with a new
 * information dictionary appended. The handle still has the old details afterwards: reopen it.
 */
export async function saveDetails(id: string, handle: DocHandle, details: Details): Promise<void> {
  const bytes = new Uint8Array(await handle.bytes());
  const out = withInfo(bytes, infoFor(details, handle.metadata.other));
  await repo.writeFile(id, out.buffer);
}
