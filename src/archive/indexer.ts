import { createStore, set, values, type UseStore } from 'idb-keyval';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { engine } from '@/engine';
import { BASE } from '@/lib/base';
import { folders, type FolderRoot } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import { usePrefs } from '@/state/prefs';
import { repo } from '@/storage';
import { parseTags, real, realTitle } from './pdfInfo';
import { docKey } from './shared';
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
/** Folder depth walked (a symlink loop or a huge tree stops here). */
const MAX_DEPTH = 12;
/** A full walk again after this long, when the app comes back. */
const REWALK_MS = 5 * 60_000;

/** Details per document (small: read at start). Their text is kept, indexed and searched by the search worker. */
let metaDb: UseStore | null = null;
const metaStore = () => (metaDb ??= createStore('tessel-docs', 'meta'));

/** A Syncthing conflict copy found in a folder: kept out of the index, listed to be resolved. */
export type Conflict = { root: string; rootName: string; dir?: string; entry: FolderEntry; name: ConflictName };

export const useIndex = create<{ running: boolean; done: number; total: number; count: number; conflicts: Conflict[]; duplicates: number }>(() => ({
  running: false,
  done: 0,
  total: 0,
  count: 0,
  conflicts: [],
  /** Groups of documents in the archive with the same content. */
  duplicates: 0,
}));

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
    useIndex.setState({ count: countDocs(), duplicates: archiveDuplicates() });
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
  useIndex.setState({ count: countDocs() });
}

function drop(keys: string[]) {
  if (!keys.length) return;
  for (const key of keys) docs.delete(key);
  void ask({ type: 'drop', keys }).catch(() => {});
  useIndex.setState({ count: countDocs() });
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

/** Best matches for `query` in every indexed document. */
export async function searchAll(query: string): Promise<Hit[]> {
  if (Platform.OS !== 'web' || query.trim().length < 2) return [];
  await load();
  const matches = await ask<Match[]>({ type: 'search', query });
  return matches.flatMap(({ key, ...m }) => {
    const doc = docs.get(key);
    return doc ? [{ doc, ...m }] : [];
  });
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
 * The places to index: the archive first, the picked folders and Tessel's own; then, with all files access,
 * every other document on the device (those already found in a folder above are left out of it).
 */
async function rootsToWalk(): Promise<FolderRoot[]> {
  if (!folders.supported) return [];
  const roots = (await folders.roots(true).catch(() => [] as FolderRoot[])).filter((r) => !r.locked && r.kind !== 'device');
  const archive = usePrefs.getState().archive;
  const rank = (r: FolderRoot) => (r.id === archive ? 0 : r.kind === 'all' ? 2 : 1);
  return roots.sort((a, b) => rank(a) - rank(b));
}

async function walk(root: FolderRoot, dir: string | undefined, depth: number, out: Candidate[], conflicts: Conflict[]): Promise<void> {
  await whileOpen();
  const listed = await folders.list(root.id, dir);
  // "All documents" is every file on the device: those in a folder walked already are in the index as that.
  const known = root.kind === 'all' ? new Set(out.map((c) => `${c.name}|${c.size}`)) : null;
  for (const e of listed) {
    if (known?.has(`${e.name}|${e.size}`)) continue;
    // Hidden folders (Syncthing's versions, Tessel's own .tessel and trash) and files Syncthing is still writing.
    if (syncTemporary(e.name)) continue;
    if (e.kind === 'dir') {
      if (depth < MAX_DEPTH) await walk(root, e.id, depth + 1, out, conflicts).catch(() => {});
    } else if (e.kind === 'pdf') {
      const conflict = parseConflict(e.name);
      // Conflict copies are resolved in the folders Tessel works in ("All documents" has no folders to work in).
      if (conflict) {
        if (root.kind !== 'all') conflicts.push({ root: root.id, rootName: root.name, dir, entry: e, name: conflict });
      } else out.push({ key: `${root.id}:${e.id}`, place: { kind: 'folder', root: root.id, rootName: root.name, dir, entry: e }, name: e.name, size: e.size, modified: e.modified });
    }
  }
}

/** Everything to index now, and the roots whose listing failed (their records are kept, not dropped). */
async function candidates(): Promise<{ list: Candidate[]; unlisted: Set<string>; conflicts: Conflict[] }> {
  const list: Candidate[] = [];
  const unlisted = new Set<string>();
  const conflicts: Conflict[] = [];
  for (const root of await rootsToWalk()) {
    await walk(root, undefined, 0, list, conflicts).catch(() => unlisted.add(root.id));
  }
  // Library documents that aren't files in those folders already (a document opened from a folder is linked to it).
  const uris = list.map((c) => (c.place.kind === 'folder' ? c.place.entry.uri : undefined)).filter((u): u is string => !!u);
  const linked = new Set([...(await repo.linkedTo(uris).catch(() => new Map<string, string[]>())).values()].flat());
  // In a browser, folder files have no URI: a linked document is matched to its file by name and size.
  const inFolders = new Set(list.map((c) => `${c.name}|${c.size}`));
  for (const d of await repo.list().catch(() => [])) {
    if (d.format === 'epub' || linked.has(d.id) || (d.linked && inFolders.has(`${d.fileName}|${d.bytes}`))) continue;
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
  const { list: listed, unlisted, conflicts } = await candidates();
  // What was resolved while the folders were being listed is gone already.
  const list = listed.filter((c) => !settledSince(c.key, started));
  useIndex.setState({ conflicts: conflicts.filter((c) => !settledSince(conflictKey(c), started)) });
  const seen = new Set(list.map((c) => c.key));
  drop(
    [...docs.keys()].filter((key) => {
      const root = key.startsWith('lib:') ? null : key.slice(0, key.indexOf(':'));
      return !seen.has(key) && !(root && unlisted.has(root));
    }),
  );
  const todo = list.filter((c) => {
    const known = docs.get(c.key);
    // Records from before content hashes are read again once.
    return !known || known.size !== c.size || known.modified !== c.modified || !known.hash || !known.share;
  });
  useIndex.setState({ running: todo.length > 0, done: 0, total: todo.length });
  for (const [i, c] of todo.entries()) {
    await whileOpen();
    const doc = await read(c);
    if (doc) put(doc);
    useIndex.setState({ done: i + 1 });
    // Let the app breathe between documents.
    await new Promise((r) => setTimeout(r, 30));
  }
  useIndex.setState({ running: false, duplicates: archiveDuplicates() });
}

/** Starts indexing a little after launch, and again when the app comes back after a while. */
export function startIndexing() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  schedule(4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastWalk > REWALK_MS) schedule(2000);
  });
}
