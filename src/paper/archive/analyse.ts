import { engine } from '@/core/engine';
import { repo } from '@/core/storage';
import { aiReady } from '@/paper/scan/ai';
import { libraryActions } from '@/paper/state/library';
import { passwordFor } from '@/paper/state/password';
import { usePrefs } from '@/paper/state/prefs';
import { detailsOf, saveDetails, suggestDetails } from './details';
import { invalidate } from './indexer';
import { readAdded, useIntake } from './intake';
import { realTitle } from './pdfInfo';
import { importFromFolder } from './Results';
import type { IndexedDoc } from './search';
import { pagesWithoutText } from './searchable';

/**
 * Analysing chosen documents: one with pages without text gets them read (on the device, or by the AI model where
 * one is set up, which then also fills in its empty details), in the background as anything added is; one with
 * text on every page gets its empty details filled in by the model (set up), at once. What a document already
 * has stays. Returns how many went to be read, how many got details, and how many couldn't be opened or written.
 */
export async function analyseMany(docs: IndexedDoc[], onProgress?: (done: number, total: number) => void): Promise<{ reading: number; described: number; failed: number }> {
  const ai = usePrefs.getState().ai;
  const withAi = aiReady(ai);
  let reading = 0;
  let described = 0;
  let failed = 0;
  for (const [i, doc] of docs.entries()) {
    onProgress?.(i, docs.length);
    try {
      const id = doc.place.kind === 'library' ? doc.place.id : (await importFromFolder(doc.place))?.id;
      if (!id) throw new Error('not added');
      const handle = await engine.open(await repo.source(id), passwordFor(id));
      try {
        if ((await pagesWithoutText(handle, 1)).length) {
          const rec = libraryActions().docs.find((d) => d.id === id);
          if (!rec) throw new Error('not in the library');
          readAdded([rec], withAi, withAi ? { name: false } : undefined);
          reading++;
          continue;
        }
        if (!withAi) continue;
        if (!(await repo.requestAccess(id, true))) throw new Error('denied');
        const now = detailsOf(handle, realTitle(doc.title) || doc.name.replace(/\.pdf$/i, ''));
        const next = await suggestDetails(handle, doc.name, now, ai);
        if (JSON.stringify(next) === JSON.stringify(now)) continue;
        await saveDetails(id, handle, next);
        libraryActions().setDetails(id, { title: next.title, author: next.sender });
        described++;
      } finally {
        handle.close();
      }
      invalidate(id);
      useIntake.setState({ finished: { id, said: null, changed: true } });
    } catch {
      failed++;
    }
  }
  return { reading, described, failed };
}
