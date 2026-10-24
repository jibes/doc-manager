import { createStore, set, values, type UseStore } from 'idb-keyval';
import { log } from '@/core/lib/log';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { engine } from '@/core/engine';
import { BASE } from '@/core/lib/base';
import { folders, type FolderRoot } from '@/core/lib/folders';
import type { FolderEntry } from '@/core/lib/folderTypes';
import { usePrefs } from '@/paper/state/prefs';
import { APP_ROOT_ID } from '@/core/lib/nesting';
import { repo } from '@/core/storage';
import { parseTags, real, realTitle } from './pdfInfo';
import { docKey } from './docKey';
import type { Hit, Indexable, IndexedDoc, Place } from './search';
import type { Match, SearchRequest, SearchResponse } from './searchProtocol';
import { duplicates, parseConflict, syncTemporary, type ConflictName } from './sync';

/**
 * Keeps the search index up to date: walks the user's folders and the library, reads documents that are new or
 * changed (size or date) with PDFium, and stores their details and text on this device. Runs in the background,
 * one document at a time, and waits while a document is open (they share the PDF engine).
 */

/** Pages read per document, and characters kept per page. */
const MAX_PAGES = 200;
const MAX_PAGE_CHARS = 20_000;
/**
 * Bigger files are indexed by name and details only: reading one holds it in memory a few times over, which can
 * take the Android WebView down (every launch, as the failure was never recorded).
 */
const MAX_BYTES = 150 * 1024 * 1024;
const tooBig = (x: { size: number }) => x.size > MAX_BYTES;
/** Folder depth walked (a symlink loop or a huge tree stops here). */
const MAX_DEPTH = 12;
/** A full walk again after this long, when the app comes back. */
const REWALK_MS = 5 * 60_000;

/** Details per document (small: read at start). Their text is kept, indexed and searched by the search worker. */
let metaDb: UseStore | null = null;
const metaStore = () => (metaDb ??= createStore('tessel-docs', 'meta'));

/** A Syncthing conflict copy found in a folder: kept out of the index, listed to be resolved. */
export type Conflict = { root: string; rootName: string; dir?: string; entry: FolderEntry; name: ConflictName };

export const useIndex = create<{ running: boolean; done: number; total: number; count: number; conflicts: Conflict[]; duplicates: number; changed: number }>(() => ({
  running: false,
  done: 0,
  total: 0,
  count: 0,
  conflicts: [],
  /** Groups of documents in the archive with the same content. */
  duplicates: 0,
  /** Counts every change to what is indexed (added, gone, moved): what shows it reads it again. */
  changed: 0,
}));
const changedNow = (more: Partial<ReturnType<typeof useIndex.getState>> = {}) => useIndex.setState((s) => ({ ...more, changed: s.changed + 1 }));

/* ------------------------------------------------------- search worker ---- */

let worker: Worker | null = null;
let seq = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function ask<T>(req: DistributiveOmit<SearchRequest, 'id'>): Promise<T> {
  if (!worker) {
    worker = new Worker(`${BASE}/engine/search-worker.js`, { type: 'module' });
    worker.onmessage = (e: MessageEvent<SearchResponse>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.ok) w?.resolve(e.data.result);
      else w?.reject(new Error(e.data.error));
    };
    // Not loaded (or its answers unreadable): every call waiting is told, and the next one starts it again.
    const started = worker;
    const fail = (why: string) => () => {
      started.terminate();
      if (worker !== started) return;
      worker = null;
      const all = [...waiting.values()];
      waiting.clear();
      for (const w of all) w.reject(new Error(why));
    };
    worker.onerror = fail('Search worker failed');
    worker.onmessageerror = fail('Search worker answer unreadable');
  }
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ ...req, id });
  });
}
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/* ----------------------------------------------------------- the details ---- */

const docs = new Map<string, IndexedDoc>();
let loading: Promise<void> | null = null;

/** Records from before details and text were kept apart: split once (by the worker), then the old store goes. */
async function migrate(): Promise<void> {
  const DONE = 'tessel-index-split';
  try {
    if (localStorage.getItem(DONE)) return;
  } catch {
    return;
  }
  await ask({ type: 'migrate' });
  try {
    localStorage.setItem(DONE, '1');
  } catch {}
}

const countDocs = () => [...docs.values()].filter((d) => !d.failed).length;
const archiveDuplicates = () => duplicates([...docs.values()], usePrefs.getState().archive).length;

function load(): Promise<void> {
  loading ??= (async () => {
    await migrate().catch(() => {});
    for (const d of await values<IndexedDoc>(metaStore()).catch(() => [])) docs.set(d.key, d);
    changedNow({ count: countDocs(), duplicates: archiveDuplicates() });
  })();
  return loading;
}

/** Builds the search index ahead of a search (in the worker: the app stays responsive). The Documents screen asks. */
export function warmSearch() {
  if (Platform.OS !== 'web') return;
  void load().then(() => ask({ type: 'warm' })).catch(() => {});
}

function put(doc: Indexable) {
  const { pages: _, ...meta } = doc;
  docs.set(doc.key, meta);
  // The worker stores both, and indexes it.
  void ask({ type: 'put', doc }).catch(() => {});
  changedNow({ count: countDocs() });
}

/** Where a document is changed (now known to be in the inbox, say): stored as such, its text not read again. */
function moved(doc: IndexedDoc) {
  docs.set(doc.key, doc);
  void ask({ type: 'meta', doc }).catch(() => {});
  changedNow();
}

/** A file moved or renamed: its record (and, in the worker, its text) under its new key. */
function rekey(from: IndexedDoc, to: Candidate) {
  const doc: IndexedDoc = { ...from, key: to.key, place: to.place, name: to.name };
  docs.delete(from.key);
  docs.set(doc.key, doc);
  // Its text wasn't there after all: it is read like a new one on the next pass.
  const unread = () => {
    if (docs.get(doc.key) !== doc) return;
    docs.delete(doc.key);
    schedule(1000);
  };
  void ask<boolean>({ type: 'rekey', from: from.key, doc }).then((moved) => moved || unread(), unread);
  changedNow();
}

/** A document's title as indexed (what is shown of it in the trash, once its file is there). */
export const indexedTitle = (key: string): string | undefined => docs.get(key)?.title || undefined;

/** Renamed by Tessel itself: its record (and text) under the file's new name now, as the next pass would find it. */
export function renamed(from: IndexedDoc, entry: FolderEntry) {
  if (Platform.OS !== 'web' || from.place.kind !== 'folder' || !docs.has(from.key)) return;
  const key = `${from.place.root}:${entry.id}`;
  // A pass listing the folder meanwhile saw the old name: neither is its to change.
  const now = Date.now();
  settled.set(from.key, now);
  settled.set(key, now);
  rekey(from, { key, place: { ...from.place, entry }, name: entry.name, size: entry.size, modified: entry.modified });
}

function drop(keys: string[]) {
  if (!keys.length) return;
  for (const key of keys) docs.delete(key);
  void ask({ type: 'drop', keys }).catch(() => {});
  changedNow({ count: countDocs() });
}

/**
 * Files resolved on the Sync screen (trashed, renamed), by key, with when: they leave the index and the
 * conflict list at once, and a pass that listed the folders before that doesn't bring them back.
 */
const settled = new Map<string, number>();
const conflictKey = (c: Conflict) => `${c.root}:${c.entry.id}`;

export function forget(keys: string[], conflicts: Conflict[] = []) {
  if (Platform.OS !== 'web') return;
  const now = Date.now();
  for (const key of [...keys, ...conflicts.map(conflictKey)]) settled.set(key, now);
  drop(keys.filter((k) => docs.has(k)));
  const gone = new Set(conflicts.map(conflictKey));
  useIndex.setState((s) => ({ conflicts: s.conflicts.filter((c) => !gone.has(conflictKey(c))), duplicates: archiveDuplicates() }));
  schedule(1000);
}
const settledSince = (key: string, since: number) => (settled.get(key) ?? 0) >= since;

/** Every match for `query` in the indexed documents, best first (the words around a match only for the first few). */
export async function searchAll(query: string): Promise<Hit[]> {
  if (Platform.OS !== 'web' || query.trim().length < 2) return [];
  await load();
  const matches = await ask<Match[]>({ type: 'search', query });
  return matches.flatMap(({ key, ...m }) => {
    const doc = docs.get(key);
    return doc ? [{ doc, ...m }] : [];
  });
}

/** The page and the words around the match for these documents (by key), for rows about to be shown. */
export async function snippetsFor(query: string, keys: string[]): Promise<Map<string, Pick<Hit, 'page' | 'snippet'>>> {
  if (Platform.OS !== 'web' || !keys.length) return new Map();
  const matches = await ask<Match[]>({ type: 'snippets', query, keys });
  return new Map(matches.map(({ key, page, snippet }) => [key, { page, snippet: snippet ?? null }]));
}

/** Every indexed document's details (for the Documents screen's filters); their text isn't read. */
export async function allDocs(): Promise<IndexedDoc[]> {
  if (Platform.OS !== 'web') return [];
  await load();
  return [...docs.values()];
}

/** Tessel wrote to a library document (details, saved forms): read it again on the next pass. */
export function invalidate(docId: string) {
  if (Platform.OS !== 'web') return;
  void load().then(() => {
    const key = `lib:${docId}`;
    const known = docs.get(key);
    if (!known) return;
    // Stored too: the mark must outlive a reload before the next pass.
    const stale = { ...known, modified: -1 };
    docs.set(key, stale);
    void set(key, stale, metaStore()).catch(() => {});
  });
  schedule(1000);
}

/* --------------------------------------------------------------- walking ---- */

type Candidate = { key: string; place: Place; name: string; size: number; modified: number };

/**
 * The place to index: the Tessel folder. Locked (the browser or Android wants the user's OK again), it can't be
 * read now: its records stay. Null: the places are unknown. (`skip` is from when several places were read.)
 */
async function rootsToWalk(): Promise<{ roots: FolderRoot[]; locked: string[]; skip: Map<string, Set<string>> } | null> {
  if (!folders.supported) return { roots: [], locked: [], skip: new Map() };
  const all = await folders.roots(false).catch(() => null);
  if (!all) return null;
  // Only the Tessel folder: the one chosen, else this device's own.
  const tessel = usePrefs.getState().archive ?? APP_ROOT_ID;
  const here = all.filter((r) => r.id === tessel);
  // Not among them for now (its folder briefly missing, say): unknown, so its documents aren't dropped and read again.
  if (!here.length && usePrefs.getState().archive) return null;
  return { roots: here.filter((r) => !r.locked), locked: here.filter((r) => r.locked).map((r) => r.id), skip: new Map() };
}

/** A folder whose listing failed: what is known in it (and below it) is kept until it can be listed again. */
type Unlisted = { root: string; dir?: string };

/** `skip`: folders inside this one that are read on their own (added folders, the archive). */
async function walk(root: FolderRoot, dir: string | undefined, depth: number, inbox: boolean, out: Candidate[], conflicts: Conflict[], failed: Unlisted[], skip?: Set<string>): Promise<void> {
  await whileOpen();
  const listed = await folders.list(root.id, dir);
  // "All documents" is every file on the device: those in a folder walked already are in the index as that.
  const known = root.kind === 'all' ? new Set(out.map((c) => `${c.name}|${c.size}`)) : null;
  // The archive's Inbox (its documents aren't filed yet).
  const archive = usePrefs.getState().archive;
  for (const e of listed) {
    if (known?.has(`${e.name}|${e.size}`)) continue;
    // Hidden folders (Syncthing's versions, Tessel's own .tessel and trash) and files Syncthing is still writing.
    if (syncTemporary(e.name)) continue;
    if (e.kind === 'dir') {
      if (skip?.has(e.id)) continue;
      const intoInbox = inbox || (depth === 0 && root.id === archive && e.name.toLocaleLowerCase() === 'inbox');
      if (depth < MAX_DEPTH) await walk(root, e.id, depth + 1, intoInbox, out, conflicts, failed, skip).catch(() => failed.push({ root: root.id, dir: e.id }));
    } else {
      const conflict = parseConflict(e.name);
      // Conflict copies are resolved in the folders Tessel works in ("All documents" has no folders to work in).
      if (conflict) {
        if (root.kind !== 'all') conflicts.push({ root: root.id, rootName: root.name, dir, entry: e, name: conflict });
      } else
        out.push({
          key: `${root.id}:${e.id}`,
          place: { kind: 'folder', root: root.id, rootName: root.name, dir, entry: e, ...(inbox ? { inbox } : {}) },
          name: e.name,
          size: e.size,
          modified: e.modified,
        });
    }
  }
}

/** Whether a record is in a folder that couldn't be listed this time (kept, not dropped). */
const inUnlisted = (d: IndexedDoc, failed: Unlisted[]) =>
  d.place.kind === 'folder' &&
  failed.some((f) => {
    if (d.place.kind !== 'folder' || f.root !== d.place.root) return false;
    if (!f.dir) return true;
    const at = d.place.dir ?? '';
    return at === f.dir || at.startsWith(`${f.dir}/`) || d.place.entry.id.startsWith(`${f.dir}/`);
  });

/** Everything to index now, and the folders whose listing failed (their records are kept, not dropped). */
async function candidates(): Promise<{ list: Candidate[]; unlisted: Unlisted[]; conflicts: Conflict[] } | null> {
  const list: Candidate[] = [];
  const conflicts: Conflict[] = [];
  const places = await rootsToWalk();
  if (!places) return null;
  const unlisted: Unlisted[] = places.locked.map((root) => ({ root }));
  for (const root of places.roots) {
    await walk(root, undefined, 0, false, list, conflicts, unlisted, places.skip.get(root.id)).catch(() => unlisted.push({ root: root.id }));
  }
  // Library documents that aren't files in those folders already (a document opened from a folder is linked to it).
  const uris = list.map((c) => (c.place.kind === 'folder' ? c.place.entry.uri : undefined)).filter((u): u is string => !!u);
  const linked = new Set([...(await repo.linkedTo(uris).catch(() => new Map<string, string[]>())).values()].flat());
  // In a browser, folder files have no URI: a linked document is matched to its file by its handle (the same entry),
  // else by name and size.
  const inFolders = new Set(list.map((c) => `${c.name}|${c.size}`));
  const handles = list.flatMap((c) => (c.place.kind === 'folder' && c.place.entry.handle ? [c.place.entry.handle] : []));
  const sameFile = async (id: string) => {
    const h = await repo.handleOf(id).catch(() => undefined);
    if (!h) return false;
    for (const other of handles) if (other.name === h.name && (await h.isSameEntry(other).catch(() => false))) return true;
    return false;
  };
  // Unreadable for now: unknown, rather than every library document taken for gone.
  const library = await repo.list().catch(() => null);
  if (!library) return null;
  for (const d of library) {
    if (linked.has(d.id) || (d.linked && (inFolders.has(`${d.fileName}|${d.bytes}`) || (await sameFile(d.id))))) continue;
    list.push({ key: `lib:${d.id}`, place: { kind: 'library', id: d.id }, name: d.fileName, size: d.bytes, modified: d.addedAt });
  }
  return { list, unlisted, conflicts };
}

/* --------------------------------------------------------------- reading ---- */

/** SHA-256 of a file's bytes, as hex. */
export async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function bytesOf(place: Place): Promise<ArrayBuffer> {
  if (place.kind === 'folder') return (await folders.read(place.root, place.entry as FolderEntry)).arrayBuffer();
  const src = await repo.source(place.id);
  if (src.kind !== 'bytes') throw new Error('Not readable here');
  return src.bytes;
}

/** The document's record, or null when it can't be read just now (no access at the moment, gone): tried next pass. */
async function read(c: Candidate): Promise<Indexable | null> {
  const base = { key: c.key, place: c.place, name: c.name, size: c.size, modified: c.modified };
  const empty = { title: '', sender: '', type: '', tags: [] as string[], date: '', pages: [] as string[] };
  // Recorded without its text (and without a hash: it isn't read), so it isn't tried again until it changes.
  if (tooBig(c)) return { ...base, ...empty };
  const bytes = await bytesOf(c.place).catch(() => null);
  if (!bytes) return null;
  const hash = await contentHash(bytes);
  const share = await docKey(bytes);
  let handle;
  try {
    handle = await engine.open({ kind: 'bytes', bytes });
  } catch {
    // Damaged, protected, or gone: remembered as such until the file changes.
    return { ...base, ...empty, hash, share, failed: true };
  }
  try {
    const m = handle.metadata;
    const pages: string[] = [];
    for (let p = 0; p < Math.min(handle.pageCount, MAX_PAGES); p++) {
      await whileOpen();
      const runs = await handle.pageText(p).catch(() => []);
      pages.push(runs.map((r) => r.text + (r.eol ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').slice(0, MAX_PAGE_CHARS));
    }
    return { ...base, hash, share, title: realTitle(m.title), sender: real(m.author), type: real(m.subject), tags: parseTags(m.keywords), date: m.date ?? '', pages };
  } finally {
    handle.close();
  }
}

/* ------------------------------------------------------------ scheduling ---- */

let paused = 0;
let waking: (() => void)[] = [];
/** A document is open: indexing waits (they share the PDF engine). Returns the function that lets it go on. */
export function pauseIndexing(): () => void {
  paused++;
  return () => {
    paused = Math.max(0, paused - 1);
    if (paused) return;
    const wake = waking;
    waking = [];
    for (const go of wake) go();
  };
}
const whileOpen = () => (paused ? new Promise<void>((r) => waking.push(r)) : Promise.resolve());

let timer: ReturnType<typeof setTimeout> | null = null;
let due = 0;
let pass: Promise<void> | null = null;
let again = false;
let lastWalk = 0;

/** Runs a pass in `ms` (one at a time; a request during a pass runs another after it). */
export function schedule(ms = 3000) {
  if (Platform.OS !== 'web') return;
  if (pass) {
    again = true;
    return;
  }
  // A pass already due sooner stays as it is: asking again never postpones it.
  if (timer && due <= Date.now() + ms) return;
  if (timer) clearTimeout(timer);
  due = Date.now() + ms;
  timer = setTimeout(() => {
    timer = null;
    pass = run().finally(() => {
      pass = null;
      if (again) {
        again = false;
        schedule(1000);
      }
    });
  }, ms);
}

async function run(): Promise<void> {
  // Nothing while a document is open: opening and reading it come first.
  await whileOpen();
  await load();
  const started = (lastWalk = Date.now());
  const found = await candidates();
  // The places themselves couldn't be listed: nothing is known to be gone.
  if (!found) return void log.warn('index', 'places not listed: pass skipped');
  const { list: listed, unlisted, conflicts } = found;
  // What was resolved while the folders were being listed is gone already.
  const list = listed.filter((c) => !settledSince(c.key, started));
  useIndex.setState({ conflicts: conflicts.filter((c) => !settledSince(conflictKey(c), started)) });
  const seen = new Set(list.map((c) => c.key));
  const gone = [...docs.values()].filter((d) => !seen.has(d.key) && !inUnlisted(d, unlisted) && !settledSince(d.key, started));
  // Moved or renamed (a new key, the same size and time as a file gone): its text goes along, not read again.
  const stamp = (x: { size: number; modified: number }) => `${x.size}:${x.modified}`;
  const movable = new Map(gone.filter((d) => d.place.kind === 'folder' && d.modified > 0 && !d.failed && d.hash).map((d) => [stamp(d), d]));
  for (const c of list) {
    const was = docs.has(c.key) ? undefined : movable.get(stamp(c));
    if (!was) continue;
    movable.delete(stamp(c));
    rekey(was, c);
  }
  drop(gone.filter((d) => docs.has(d.key)).map((d) => d.key));
  const todo = list.filter((c) => {
    const known = docs.get(c.key);
    // Records from before content hashes are read again once.
    const read = !known || known.size !== c.size || known.modified !== c.modified || ((!known.hash || !known.share) && !tooBig(c));
    // Only where it is changed (found to be in the inbox, the folder renamed): no need to read it again.
    if (!read && known && JSON.stringify(known.place) !== JSON.stringify(c.place)) moved({ ...known, place: c.place, name: c.name });
    return read;
  });
  useIndex.setState({ running: todo.length > 0, done: 0, total: todo.length });
  log.info('index', `pass: ${list.length} files, ${gone.length} gone, ${todo.length} to read, ${unlisted.length} folders not listed, ${conflicts.length} conflicts`);
  for (const [i, c] of todo.entries()) {
    await whileOpen();
    const doc = await read(c);
    if (doc) put(doc);
    log.debug('index', `read ${c.key} ${c.size} B`, doc ? { failed: !!doc.failed } : 'not read');
    useIndex.setState({ done: i + 1 });
    // Let the app breathe between documents.
    await new Promise((r) => setTimeout(r, 30));
  }
  useIndex.setState({ running: false, duplicates: archiveDuplicates() });
  log.info('index', `pass done in ${Math.round((Date.now() - started) / 1000)} s`);
}

/**
 * Starts indexing a little after launch; again when the app comes back after a while, and every so often while it
 * stays open (what Syncthing brings meanwhile: new scans, deletions, renames, conflict copies).
 */
export function startIndexing() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  schedule(4000);
  const stale = () => document.visibilityState === 'visible' && Date.now() - lastWalk > REWALK_MS;
  document.addEventListener('visibilitychange', () => stale() && schedule(2000));
  setInterval(() => stale() && schedule(1000), REWALK_MS / 5);
}

/** A screen that shows what the index knows came up: looked at again soon if the last look is a while ago. */
export function refreshSoon() {
  if (Platform.OS === 'web' && Date.now() - lastWalk > REWALK_MS / 5) schedule(1500);
}
