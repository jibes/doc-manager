import { createStore, del, set, values, type UseStore } from 'idb-keyval';
import type MiniSearch from 'minisearch';
import { Platform } from 'react-native';
import { create } from 'zustand';

import { engine } from '@/engine';
import { folders, type FolderRoot } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import { repo } from '@/storage';
import { parseTags, real } from './pdfInfo';
import { docKey } from './shared';
import { createIndex, searchIndex, type Hit, type IndexedDoc, type Place } from './search';
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

let db: UseStore | null = null;
const store = () => (db ??= createStore('tessel-index', 'docs'));

/** A Syncthing conflict copy found in a folder: kept out of the index, listed to be resolved. */
export type Conflict = { root: string; rootName: string; dir?: string; entry: FolderEntry; name: ConflictName };

export const useIndex = create<{ running: boolean; done: number; total: number; count: number; conflicts: Conflict[]; duplicates: number }>(() => ({
  running: false,
  done: 0,
  total: 0,
  count: 0,
  conflicts: [],
  /** Groups of documents with the same content. */
  duplicates: 0,
}));

const docs = new Map<string, IndexedDoc>();
let index: MiniSearch<IndexedDoc> | null = null;
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  loading ??= (async () => {
    const stored = await values<IndexedDoc>(store()).catch(() => []);
    for (const d of stored) docs.set(d.key, d);
    index = createIndex();
    index.addAll(stored.filter((d) => !d.failed));
    useIndex.setState({ count: index.documentCount, duplicates: duplicates(stored).length });
  })();
  return loading;
}

function put(doc: IndexedDoc) {
  if (index!.has(doc.key)) index!.discard(doc.key);
  docs.set(doc.key, doc);
  if (!doc.failed) index!.add(doc);
  void set(doc.key, doc, store()).catch(() => {});
  useIndex.setState({ count: index!.documentCount });
}

function drop(key: string) {
  if (index!.has(key)) index!.discard(key);
  docs.delete(key);
  void del(key, store()).catch(() => {});
  useIndex.setState({ count: index!.documentCount });
}

/** Best matches for `query` in every indexed document. */
export async function searchAll(query: string): Promise<Hit[]> {
  if (Platform.OS !== 'web') return [];
  await load();
  return searchIndex(index!, docs, query);
}

/** Every indexed document (for the Documents screen's filters). */
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
    void set(key, stale, store()).catch(() => {});
  });
  schedule(1000);
}

/* --------------------------------------------------------------- walking ---- */

type Candidate = { key: string; place: Place; name: string; size: number; modified: number };

/** The places to index: with all files access, every document on the device; otherwise each picked folder. */
async function rootsToWalk(): Promise<FolderRoot[]> {
  if (!folders.supported) return [];
  const roots = await folders.roots(true).catch(() => [] as FolderRoot[]);
  const all = roots.find((r) => r.kind === 'all');
  return (all ? [all] : roots.filter((r) => r.kind !== 'device')).filter((r) => !r.locked);
}

async function walk(root: FolderRoot, dir: string | undefined, depth: number, out: Candidate[], conflicts: Conflict[]): Promise<void> {
  const entries = await folders.list(root.id, dir);
  for (const e of entries) {
    // Hidden folders (Syncthing's versions, Tessel's own .tessel and trash) and files Syncthing is still writing.
    if (syncTemporary(e.name)) continue;
    if (e.kind === 'dir') {
      if (depth < MAX_DEPTH) await walk(root, e.id, depth + 1, out, conflicts).catch(() => {});
    } else if (e.kind === 'pdf') {
      const conflict = parseConflict(e.name);
      if (conflict) conflicts.push({ root: root.id, rootName: root.name, dir, entry: e, name: conflict });
      else out.push({ key: `${root.id}:${e.id}`, place: { kind: 'folder', root: root.id, rootName: root.name, dir, entry: e }, name: e.name, size: e.size, modified: e.modified });
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
async function read(c: Candidate): Promise<IndexedDoc | null> {
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
    return { ...base, hash, share, title: real(m.title), sender: real(m.author), type: real(m.subject), tags: parseTags(m.keywords), date: m.date ?? '', pages };
  } finally {
    handle.close();
  }
}

/* ------------------------------------------------------------ scheduling ---- */

let paused = 0;
let waking: (() => void) | null = null;
/** A document is open: indexing waits (they share the PDF engine). Returns the function that lets it go on. */
export function pauseIndexing(): () => void {
  paused++;
  return () => {
    paused = Math.max(0, paused - 1);
    if (!paused) waking?.();
  };
}
const whileOpen = () => (paused ? new Promise<void>((r) => (waking = r)) : Promise.resolve());

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
  await load();
  lastWalk = Date.now();
  const { list, unlisted, conflicts } = await candidates();
  useIndex.setState({ conflicts });
  const seen = new Set(list.map((c) => c.key));
  for (const key of [...docs.keys()]) {
    const root = key.startsWith('lib:') ? null : key.slice(0, key.indexOf(':'));
    if (!seen.has(key) && !(root && unlisted.has(root))) drop(key);
  }
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
  useIndex.setState({ running: false, duplicates: duplicates([...docs.values()]).length });
}

/** Starts indexing a little after launch, and again when the app comes back after a while. */
export function startIndexing() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  schedule(4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastWalk > REWALK_MS) schedule(2000);
  });
}
