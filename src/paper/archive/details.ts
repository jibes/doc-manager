import type { DocHandle } from '@/core/engine/types';
import { repo } from '@/core/storage';
import { infoFor, parseTags, real, realTitle, withInfo, type Details } from './pdfInfo';

/**
 * The details a PDF carries (falling back to `title` when it has none). Placeholders other programs leave
 * ("(unspecified)", "Microsoft Word - x.docx") count as none, as everywhere else, so saving drops them.
 */
export function detailsOf(handle: DocHandle, title: string): Details {
  const m = handle.metadata;
  return { title: realTitle(m.title) || title, sender: real(m.author), type: real(m.subject), tags: parseTags(m.keywords), date: real(m.date) };
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
