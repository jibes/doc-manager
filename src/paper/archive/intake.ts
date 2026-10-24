import { changedElsewhere } from './versions';
import { log } from '@/core/lib/log';
import { create } from 'zustand';

import { engine } from '@/core/engine';
import type { DocHandle } from '@/core/engine/types';
import { aiMessage, t } from '@/core/i18n';
import { aiReady, aiTitle, type AiDescription } from '@/paper/scan/ai';
import { pdfFilename } from '@/paper/scan/export';
import { passwordFor } from '@/paper/state/password';
import { usePrefs } from '@/paper/state/prefs';
import { useLibrary } from '@/paper/state/library';
import { readStored, writeStored } from '@/core/lib/stored';
import { repo, type DocRecord } from '@/core/storage';
import { detailsOf } from './details';
import { childDir, INBOX } from './dirs';
import { improveWithAi } from './improve';
import { infoFor, withInfo } from './pdfInfo';
import { makeSearchable, pagesWithoutText } from './searchable';

/**
 * Reading text, in the background, one document after another: whatever is added (files, a document kept from
 * a source or from the viewer) gets the text of its pages without any; a scan read by the model gets its text
 * corrected and its details; Make searchable and Improve text with AI in the reader ask for one document. On the
 * device, or by the model when that is asked for. The reader shows it while its document waits or is read, and
 * opens it again once its text is in the file.
 */
export type Reading = { id: string; name: string; done: number; total: number; ai: boolean };
/** A document done: what to tell (null: nothing worth it) and whether its file changed. */
export type Finished = { id: string; said: string | null; changed: boolean };
export const useIntake = create<{
  reading: Reading | null;
  /** What the documents read since the last summary came to (Documents shows it). */
  said: string | null;
  /** Waiting or being read. */
  waiting: string[];
  /** Open with unsaved changes: not written to until they are saved (or dropped). */
  editing: string[];
  finished: Finished | null;
}>(() => ({ reading: null, said: null, waiting: [], editing: [], finished: null }));

/**
 * `ai`: by the model (else on the device). `asked`: from the reader, for this document: every page the model can
 * read again is, and what it came to is told. `describe`: a scan read by the model: its details are filled in
 * from the reading (`name`: its title and file name too, as none was given).
 */
type Job = { rec: DocRecord; ai: boolean; asked?: boolean; describe?: { name: boolean } };

const queue: Job[] = [];
let running = false;
let current: string | null = null;
/** What is still to read is kept on this device: the app closed meanwhile, it goes on when it is opened again. */
const KEPT = 'tessel-reading-queue';
type Kept = { id: string; ai: boolean; asked?: boolean; describe?: { name: boolean } };
const waiting = () => {
  const jobs = current ? [...queue, ...(kept.current ? [kept.current] : [])] : queue;
  writeStored(KEPT, JSON.stringify(jobs.map(({ rec, ...rest }): Kept => ({ id: rec.id, ...rest }))));
  useIntake.setState({ waiting: queue.map((q) => q.rec.id).concat(current ? [current] : []) });
};
const kept: { current: Job | null } = { current: null };

/** Once the library is loaded: what was left to read when the app last closed is read now. */
export function resumeReading() {
  let jobs: Kept[] = [];
  try {
    jobs = JSON.parse(readStored(KEPT) ?? '[]') as Kept[];
  } catch {
    // Nothing kept.
  }
  const { docs } = useLibrary.getState();
  for (const { id, ...rest } of jobs) {
    const rec = docs.find((d) => d.id === id);
    if (rec) enqueue({ rec, ...rest });
  }
}

/** Whether the model reads added documents: the switch on this add, else the default in Settings. */
export const improveOnAdd = (asked?: boolean) => {
  const { ai, improveAdded } = usePrefs.getState();
  return aiReady(ai) && (asked ?? improveAdded);
};

const enqueue = (job: Job) => {
  if (job.rec.viewed || queue.some((q) => q.rec.id === job.rec.id) || current === job.rec.id) return;
  queue.push(job);
  waiting();
  if (!running) void work();
};

/** Reads the added documents' pages without text. */
export function readAdded(recs: DocRecord[], ai = improveOnAdd(), describe?: { name: boolean }) {
  for (const rec of recs) enqueue({ rec, ai, describe });
}

/** The reader's Make searchable (`ai` false) or Improve text with AI, for one document. */
export const readText = (rec: DocRecord, ai: boolean) => enqueue({ rec, ai, asked: true });

/** Marks a document as open with unsaved changes (or not any more). */
export function editing(id: string, dirty: boolean) {
  useIntake.setState((s) => ({ editing: dirty ? [...new Set([...s.editing, id])] : s.editing.filter((x) => x !== id) }));
}

async function work() {
  running = true;
  let read = 0;
  let failed = 0;
  let aiFailed = 0;
  // The first reason the model failed: the same for all of them, as a rule (a key, an address, a model).
  let aiWhy = '';
  while (queue.length) {
    const job = queue.shift()!;
    current = job.rec.id;
    kept.current = job;
    waiting();
    log.info('intake', `${job.ai ? 'improve' : 'read'} ${job.rec.id}`, { asked: job.asked, describe: !!job.describe });
    const r = await readOne(job).catch((e: unknown): Outcome => {
      log.warn('intake', `${job.rec.id} failed`, e);
      return { result: 'failed', said: job.asked ? whyNot(e, job.ai) : null, changed: false };
    });
    log.info('intake', `${job.rec.id}: ${r.result}`, { changed: r.changed, aiFailed: r.aiFailed });
    // The reader tells what it asked for itself; the summary is about what was added.
    if (!job.asked) {
      if (r.result === 'read') read++;
      else if (r.result === 'failed') failed++;
      if (r.aiFailed) {
        aiFailed++;
        aiWhy ||= typeof r.aiFailed === 'string' ? r.aiFailed : '';
      }
    }
    current = null;
    kept.current = null;
    useIntake.setState({ reading: null, finished: { id: job.rec.id, said: r.said, changed: r.changed } });
  }
  waiting();
  const summary = failed ? t.intakeFailed(failed) : aiFailed ? (aiWhy ? t.intakeAiFailedWhy(aiFailed, aiWhy) : t.intakeAiFailed(aiFailed)) : read ? t.intakeRead(read) : null;
  useIntake.setState({ said: summary });
  running = false;
}

/** Why the text couldn't be added or improved, in words for the reader. */
function whyNot(e: unknown, ai: boolean): string {
  const m = e instanceof Error ? e.message : String(e);
  const why = m === 'denied' ? t.writeDenied : /Could not write the text/.test(m) ? t.searchableNoWrite : /can.t be read here/.test(m) ? t.searchableNoPages : ai ? aiMessage(e) : m;
  return ai ? t.improveFailed(why) : t.searchableFailed(why);
}

/** Until the document's unsaved changes are saved or dropped (they would be written over the text, or it over them). */
const untilSaved = (id: string) =>
  new Promise<void>((resolve) => {
    if (!useIntake.getState().editing.includes(id)) return resolve();
    const stop = useIntake.subscribe((s) => {
      if (s.editing.includes(id)) return;
      stop();
      resolve();
    });
  });

/** `aiFailed`: the model couldn't read it (why, in words). */
type Outcome = { result: 'read' | 'nothing' | 'failed'; said: string | null; changed: boolean; aiFailed?: boolean | string };

async function readOne(job: Job, again = false): Promise<Outcome> {
  const { rec, ai: byModel, asked, describe } = job;
  const handle = await engine.open(await repo.source(rec.id), passwordFor(rec.id));
  try {
    // An added document with text on every page is left as it is (a scan's text, or one asked for, is read again).
    if (!asked && !describe && !(await pagesWithoutText(handle)).length) return { result: 'nothing', said: null, changed: false };
    // A signed one only when asked for: its signature would show the pages as changed.
    if (!asked && handle.signed) return { result: 'nothing', said: null, changed: false };
    const name = rec.title || rec.fileName;
    const progress = (done: number, total: number) => useIntake.setState({ reading: { id: rec.id, name, done, total, ai: byModel } });
    progress(0, 0);
    const settings = usePrefs.getState().ai;
    let bytes: ArrayBuffer | string;
    let said: string | null = asked ? t.searchableDone : null;
    let found: AiDescription | undefined;
    let aiFailed: boolean | string = false;
    if (byModel && aiReady(settings)) {
      const improved = await improveWithAi(handle, settings, progress).catch((e: unknown) => {
        // Asked for: said so. Else the device reads what has no text yet.
        if (asked) throw e;
        aiFailed = aiMessage(e);
        return undefined;
      });
      if (improved === null && asked) return { result: 'nothing', said: t.improveNothing, changed: false };
      bytes = improved?.bytes ?? (await makeSearchable(handle, progress));
      if (improved) {
        said = asked ? t.improveDone(improved.pages, improved.skipped) : null;
        found = improved.found;
      }
    } else bytes = await makeSearchable(handle, progress);
    if (typeof bytes === 'string') {
      const nothing = bytes === 'has-text' ? t.searchableNothing : t.searchableNone;
      return { result: bytes === 'has-text' ? 'nothing' : 'failed', said: asked ? nothing : null, changed: false, aiFailed };
    }
    if (describe && found) bytes = described(handle, bytes, found, describe.name);
    if (!(await repo.requestAccess(rec.id, true).catch(() => false))) return { result: 'failed', said: asked ? t.searchableFailed(t.writeDenied) : null, changed: false };
    await untilSaved(rec.id);
    // Saved meanwhile (notes added in the reader) or synced from another device: read again from that file, once.
    if (await changedElsewhere(rec.id, handle)) {
      if (again) return { result: 'failed', said: asked ? t.changedWhileReading : null, changed: false };
      handle.close();
      return await readOne(job, true);
    }
    await repo.writeFile(rec.id, bytes);
    void import('./indexer').then((m) => m.invalidate(rec.id));
    if (describe?.name && found) await nameFile(rec.id, found).catch(() => {});
    return { result: 'read', said: said ?? (describe ? null : t.searchableDone), changed: true, aiFailed };
  } finally {
    handle.close();
  }
}

/** The file with the model's details where the document has none (and its title, when `name`). */
function described(handle: DocHandle, bytes: ArrayBuffer, found: AiDescription, name: boolean): ArrayBuffer {
  const now = detailsOf(handle, '');
  const details = {
    title: name ? aiTitle({ ...found, pages: [] }) || now.title : now.title,
    sender: now.sender || found.sender,
    type: now.type || found.type,
    tags: now.tags.length ? now.tags : found.keywords,
    date: now.date || found.date,
  };
  return withInfo(new Uint8Array(bytes), infoFor(details, handle.metadata.other)).buffer;
}

/** A scan given no name: named as the model read it (the library's record and the file in the Tessel folder). */
async function nameFile(id: string, found: AiDescription) {
  const title = aiTitle({ ...found, pages: [] });
  const rec = useLibrary.getState().docs.find((d) => d.id === id);
  if (!title || !rec) return;
  useLibrary.getState().patchDoc(id, { title });
  const { folders } = await import('@/core/lib/folders');
  const { tesselRoot } = await import('./tessel');
  const root = tesselRoot();
  const inbox = await childDir(root, undefined, INBOX).catch(() => null);
  for (const dir of inbox ? [inbox, undefined] : [undefined]) {
    const entry = (await folders.list(root, dir).catch(() => [])).find((e) => e.kind !== 'dir' && e.name === rec.fileName);
    if (!entry) continue;
    const ids = entry.handle ? await repo.linkedToHandle(entry.handle).catch(() => []) : entry.uri ? ((await repo.linkedTo([entry.uri]).catch(() => new Map<string, string[]>())).get(entry.uri) ?? []) : [];
    if (!ids.includes(id)) continue;
    const next = pdfFilename(title);
    // A name already taken: left as it is.
    const to = await folders.rename(root, dir, entry, next).catch(() => null);
    if (to === null) return;
    const now = (await folders.list(root, dir).catch(() => [])).find((e) => (to ? e.uri === to : e.name === next));
    if (to && entry.uri) await useLibrary.getState().followFiles([{ from: entry.uri, to }]);
    else if (now) await useLibrary.getState().followEntry(entry, now);
    void import('./indexer').then((m) => m.schedule(1000));
    return;
  }
}
