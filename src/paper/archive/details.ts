import type { DocHandle } from '@/core/engine/types';
import { describeWithAi, type AiSettings } from '@/paper/scan/ai';
import { infoFor, parseTags, real, realTitle, withInfo, type Details } from './pdfInfo';
import { findDate } from './rules';
import { pagesWithoutText, readPages, textOf } from './searchable';
import { writeFrom } from './versions';

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
  await writeFrom(id, handle, out.buffer);
}

/** Pages whose text goes to the model to describe a document: its first pages say what it is. */
const DESCRIBE_PAGES = 3;

/**
 * Details the AI model proposes for a document already in Tessel, from the text of its first pages (read on the
 * device first where a page has none): only what `now` doesn't have is filled in; nothing is written yet.
 */
export async function suggestDetails(handle: DocHandle, fileName: string, now: Details, ai: AiSettings, signal?: AbortSignal): Promise<Details> {
  const pages: string[] = [];
  for (let p = 0; p < Math.min(handle.pageCount, DESCRIBE_PAGES); p++) {
    const runs = await handle.pageText(p).catch(() => []);
    pages.push(runs.map((r) => r.text + (r.eol ? '\n' : ' ')).join(''));
  }
  let text = pages.join('\n').trim();
  if (!text && (await pagesWithoutText(handle, 1)).length) text = textOf(await readPages(handle, [0], undefined, signal).catch(() => []));
  const d = await describeWithAi(ai, `${fileName}\n\n${text}`, signal);
  // The model found none: the first date in the text, as the inbox takes it.
  if (!d.date) d.date = findDate(text);
  const stem = fileName.replace(/\.pdf$/i, '');
  const titled = now.title.trim() && now.title !== stem;
  return {
    title: titled ? now.title : d.title || now.title,
    sender: now.sender || d.sender,
    type: now.type || d.type,
    date: now.date || d.date,
    tags: now.tags.length ? now.tags : d.keywords,
  };
}

/** The first date in a document's first pages (its text layer only; nothing is read from the pictures). */
export async function dateIn(handle: DocHandle): Promise<string> {
  const pages: string[] = [];
  for (let p = 0; p < Math.min(handle.pageCount, DESCRIBE_PAGES); p++) {
    const runs = await handle.pageText(p).catch(() => []);
    pages.push(runs.map((r) => r.text + (r.eol ? '\n' : ' ')).join(''));
  }
  return findDate(pages.join('\n'));
}
