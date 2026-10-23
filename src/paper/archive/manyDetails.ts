import { engine } from '@/core/engine';
import { repo } from '@/core/storage';
import { libraryActions } from '@/paper/state/library';
import { passwordFor } from '@/paper/state/password';
import { detailsOf, saveDetails } from './details';
import { invalidate } from './indexer';
import { useIntake } from './intake';
import { realTitle } from './pdfInfo';
import { importFromFolder } from './Results';
import type { IndexedDoc } from './search';

/** What several documents have in common: a value where they agree, null where they differ; the tags all have. */
export type Shared = { sender: string | null; type: string | null; date: string | null; tags: string[] };

export function sharedDetails(docs: IndexedDoc[]): Shared {
  const one = (pick: (d: IndexedDoc) => string) => (docs.every((d) => pick(d) === pick(docs[0])) ? pick(docs[0]) : null);
  return {
    sender: one((d) => d.sender),
    type: one((d) => d.type),
    date: one((d) => d.date),
    tags: docs.length ? docs[0].tags.filter((tag) => docs.every((d) => d.tags.includes(tag))) : [],
  };
}

/** Changes to several documents' details: fields given are set on each; tags added and removed, the others kept. */
export type DetailsChange = { sender?: string; type?: string; date?: string; add?: string[]; remove?: string[] };

/**
 * Writes the change into each document's file, one after another (opened, its details read, written as an
 * incremental update). Folder files come into the library linked in place, as when opened. A reader showing one
 * of them opens it again. Returns how many couldn't be written (protected, no write access).
 */
export async function writeDetailsMany(docs: IndexedDoc[], change: DetailsChange, onProgress?: (done: number, total: number) => void): Promise<{ failed: number; changed: number }> {
  let failed = 0;
  let changed = 0;
  for (const [i, doc] of docs.entries()) {
    onProgress?.(i, docs.length);
    try {
      const id = doc.place.kind === 'library' ? doc.place.id : (await importFromFolder(doc.place))?.id;
      if (!id || !(await repo.requestAccess(id, true))) throw new Error('no access');
      const handle = await engine.open(await repo.source(id), passwordFor(id));
      try {
        const now = detailsOf(handle, realTitle(doc.title) || doc.name.replace(/\.pdf$/i, ''));
        const drop = new Set((change.remove ?? []).map((x) => x.toLocaleLowerCase()));
        // A tag once, whatever its case ("Tax" not added to "tax").
        const kept = now.tags.filter((x) => !drop.has(x.toLocaleLowerCase()));
        const tags = [...kept, ...(change.add ?? []).filter((x, i, all) => ![...kept, ...all.slice(0, i)].some((y) => y.toLocaleLowerCase() === x.toLocaleLowerCase()))];
        const next = { ...now, sender: change.sender ?? now.sender, type: change.type ?? now.type, date: change.date ?? now.date, tags };
        if (JSON.stringify(next) === JSON.stringify(now)) continue;
        await saveDetails(id, handle, next);
        changed++;
        libraryActions().setDetails(id, { title: next.title, author: next.sender });
      } finally {
        handle.close();
      }
      invalidate(id);
      useIntake.setState({ finished: { id, said: null, changed: true } });
    } catch {
      failed++;
    }
  }
  return { failed, changed };
}
