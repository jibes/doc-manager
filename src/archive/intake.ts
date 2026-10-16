import { create } from 'zustand';

import { engine } from '@/engine';
import { t } from '@/i18n';
import { aiReady } from '@/scan/ai';
import { passwordFor } from '@/state/password';
import { usePrefs } from '@/state/prefs';
import { repo, type DocRecord } from '@/storage';
import { improveWithAi } from './improve';
import { makeSearchable, pagesWithoutText } from './searchable';

/**
 * One way in: whatever is added (files, a document kept from a source or from the viewer) gets the text of its
 * pages without any, read on the device, or by the model when that is asked for. Pages with text stay as they are.
 */
export const useIntake = create<{ reading: { name: string; done: number; total: number } | null; said: string | null }>(() => ({ reading: null, said: null }));

const queue: { rec: DocRecord; ai: boolean }[] = [];
let running = false;

/** Whether the model reads added documents: the switch on this add, else the default in Settings. */
export const improveOnAdd = (asked?: boolean) => {
  const { ai, improveAdded } = usePrefs.getState();
  return aiReady(ai) && (asked ?? improveAdded);
};

/** Reads the added documents' pages without text, one after another, in the background. */
export function readAdded(recs: DocRecord[], ai = improveOnAdd()) {
  for (const rec of recs) if (!rec.viewed && !queue.some((q) => q.rec.id === rec.id)) queue.push({ rec, ai });
  if (!running) void work();
}

async function work() {
  running = true;
  let read = 0;
  let failed = 0;
  while (queue.length) {
    const { rec, ai } = queue.shift()!;
    const r = await readOne(rec, ai).catch(() => 'failed' as const);
    if (r === 'read') read++;
    else if (r === 'failed') failed++;
  }
  useIntake.setState({ reading: null, said: read || failed ? (failed ? t.intakeFailed(failed) : t.intakeRead(read)) : null });
  running = false;
}

async function readOne(rec: DocRecord, ai: boolean): Promise<'read' | 'nothing' | 'failed'> {
  const handle = await engine.open(await repo.source(rec.id), passwordFor(rec.id));
  try {
    if (!(await pagesWithoutText(handle)).length) return 'nothing';
    const name = rec.title || rec.fileName;
    const progress = (done: number, total: number) => useIntake.setState({ reading: { name, done, total } });
    progress(0, 0);
    const settings = usePrefs.getState().ai;
    const bytes = ai && aiReady(settings) ? (await improveWithAi(handle, settings, progress).catch(() => null))?.bytes ?? (await makeSearchable(handle, progress)) : await makeSearchable(handle, progress);
    if (typeof bytes === 'string') return bytes === 'has-text' ? 'nothing' : 'failed';
    if (!(await repo.requestAccess(rec.id, true).catch(() => false))) return 'failed';
    await repo.writeFile(rec.id, bytes);
    void import('./indexer').then((m) => m.invalidate(rec.id));
    return 'read';
  } finally {
    handle.close();
  }
}
