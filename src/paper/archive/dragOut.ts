import { folders } from '@/core/lib/folders';
import { repo } from '@/core/storage';
import type { IndexedDoc } from './search';

/**
 * Dragging a document out of the list (to the Finder, an email): the browser takes a file from a URL it is given
 * as the drag starts, so the file is read ahead, when the pointer comes over its row. The last few are kept.
 */
const KEPT = 12;
const ready = new Map<string, { name: string; url: string }>();
const reading = new Set<string>();

async function blobOf(doc: IndexedDoc): Promise<Blob> {
  const { place } = doc;
  if (place.kind === 'folder') return folders.read(place.root, place.entry);
  const src = await repo.source(place.id);
  return src.kind === 'bytes' ? new Blob([src.bytes], { type: 'application/pdf' }) : (await fetch(src.uri)).blob();
}

export function prepareDrag(doc: IndexedDoc) {
  if (ready.has(doc.key) || reading.has(doc.key)) return;
  reading.add(doc.key);
  blobOf(doc)
    .then((blob) => {
      ready.set(doc.key, { name: doc.name, url: URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })) });
      for (const [key, f] of ready) {
        if (ready.size <= KEPT) break;
        URL.revokeObjectURL(f.url);
        ready.delete(key);
      }
    })
    .catch(() => {})
    .finally(() => reading.delete(doc.key));
}

/** The file to hand to the drag (undefined: not read yet; the drag then carries only the documents, within Tessel). */
export const dragFile = (key: string) => ready.get(key);

/** Documents dragged within Tessel (onto a tag): their keys. */
export const DOCS_TYPE = 'application/x-tessel-docs';
