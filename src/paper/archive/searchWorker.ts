/// <reference lib="webworker" />
import { createStore, delMany, getMany, keys as allKeys, set, setMany, values } from 'idb-keyval';
import MiniSearch from 'minisearch';

import { createIndex, indexOptions, rank, snippetFor, type Indexable, type IndexedDoc } from './search';
import type { SearchRequest, SearchResponse } from './searchProtocol';

/**
 * The search index, away from the screen: documents' text is stored, indexed and searched here, so building
 * the index (seconds, for thousands of documents) never holds up the app. Built when first needed, and saved
 * (with the documents changed since, which are applied again on loading) so the next start only loads it.
 */

const metaStore = createStore('tessel-docs', 'meta');
const textStore = createStore('tessel-text', 'pages');
const savedStore = createStore('tessel-search', 'saved');
/** Saved this long after the last change. */
const SAVE_MS = 20_000;
/** Documents whose text is read at once when the index is built afresh. */
const BUILD_BATCH = 50;

let index: MiniSearch<Indexable> | null = null;
let building: Promise<MiniSearch<Indexable>> | null = null;
/** Changes while the index is being built: applied to it once it is. */
let pending: (Indexable | string)[] = [];

/** Bumped when what goes into the index changes: a saved one of another kind is built afresh. */
const INDEX_VERSION = 2;

/** A document PDFium can't open (protected, damaged) is still found by its name. */
function apply(to: MiniSearch<Indexable>, change: Indexable | string) {
  const key = typeof change === 'string' ? change : change.key;
  if (to.has(key)) to.discard(key);
  if (typeof change !== 'string') to.add(change);
}

/** The saved index with what changed since it was saved, or null (none, or unreadable). */
async function loadSaved(): Promise<MiniSearch<Indexable> | null> {
  const [json, stored, version] = await getMany<string | string[] | number | undefined>(['index', 'changed', 'version'], savedStore);
  if (typeof json !== 'string' || version !== INDEX_VERSION) return null;
  let made: MiniSearch<Indexable>;
  try {
    made = MiniSearch.loadJSON<Indexable>(json, indexOptions);
  } catch {
    return null;
  }
  // With those noted here and not written yet (a search right after a change).
  const keys = [...new Set([...(Array.isArray(stored) ? stored : []), ...changed])];
  const [metas, texts] = await Promise.all([getMany<IndexedDoc | undefined>(keys, metaStore), getMany<string[] | undefined>(keys, textStore)]);
  keys.forEach((key, i) => apply(made, metas[i] && texts[i] ? { ...metas[i], pages: texts[i] } : key));
  return made;
}

async function buildFresh(): Promise<MiniSearch<Indexable>> {
  const made = createIndex();
  const metas = new Map((await values<IndexedDoc>(metaStore)).map((d) => [d.key, d]));
  // The text a few documents at a time (each up to megabytes): never all of it in memory at once.
  const all = (await allKeys<string>(textStore)).filter((k) => metas.has(k));
  for (let i = 0; i < all.length; i += BUILD_BATCH) {
    const batch = all.slice(i, i + BUILD_BATCH);
    const texts = await getMany<string[] | undefined>(batch, textStore);
    batch.forEach((key, j) => texts[j] && made.add({ ...metas.get(key)!, pages: texts[j] }));
  }
  return made;
}

/** Documents changed since the index was saved (kept with it, so a change is never lost to an early exit). */
const changed = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let changedTimer: ReturnType<typeof setTimeout> | undefined;
/** How soon the list of changes is written after one (indexing a folder notes hundreds in a row). */
const CHANGED_MS = 400;
function noteChanged(keys: string[]) {
  for (const k of keys) changed.add(k);
  changedTimer ??= setTimeout(() => {
    changedTimer = undefined;
    void set('changed', [...changed], savedStore).catch(() => {});
  }, CHANGED_MS);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => enqueue({ id: 0, type: 'save' } as const), SAVE_MS);
}

async function save() {
  if (!index) return;
  if (index.dirtCount > 0) await index.vacuum();
  const json = JSON.stringify(index);
  changed.clear();
  await setMany([['index', json], ['changed', []], ['version', INDEX_VERSION]], savedStore);
}

function ready(): Promise<MiniSearch<Indexable>> {
  if (index) return Promise.resolve(index);
  building ??= (async () => {
    const saved = await loadSaved().catch(() => null);
    const made = saved ?? (await buildFresh());
    for (const change of pending) apply(made, change);
    pending = [];
    index = made;
    if (!saved) noteChanged([]);
    return made;
  })().finally(() => {
    building = null;
  });
  return building;
}

function change(c: Indexable | string) {
  if (index) apply(index, c);
  else if (building) pending.push(c);
}

/** Records from before details and text were kept apart: split once, then the old store goes. */
async function migrate(): Promise<void> {
  const old = await values<Indexable>(createStore('tessel-index', 'docs')).catch(() => [] as Indexable[]);
  if (old.length) {
    await setMany(old.map(({ pages: _, ...meta }) => [meta.key, meta]), metaStore);
    await setMany(old.map((d) => [d.key, d.pages]), textStore);
  }
  indexedDB.deleteDatabase('tessel-index');
}

async function handle(req: SearchRequest | { id: 0; type: 'save' }): Promise<unknown> {
  switch (req.type) {
    case 'save':
      return save();
    case 'migrate':
      return migrate();
    case 'warm':
      await ready();
      return;
    case 'put': {
      const { pages, ...meta } = req.doc;
      await Promise.all([set(meta.key, meta, metaStore), set(meta.key, pages, textStore)]);
      change(req.doc);
      noteChanged([meta.key]);
      return;
    }
    case 'meta':
      await set(req.doc.key, req.doc, metaStore);
      return;
    case 'rekey': {
      const [pages] = await getMany<string[] | undefined>([req.from], textStore);
      await Promise.all([delMany([req.from], metaStore), delMany([req.from], textStore)]);
      change(req.from);
      if (pages) {
        await Promise.all([set(req.doc.key, req.doc, metaStore), set(req.doc.key, pages, textStore)]);
        change({ ...req.doc, pages });
      }
      noteChanged([req.from, req.doc.key]);
      return Boolean(pages);
    }
    case 'drop':
      await Promise.all([delMany(req.keys, metaStore), delMany(req.keys, textStore)]);
      for (const key of req.keys) change(key);
      noteChanged(req.keys);
      return;
    case 'search': {
      // Every match (counts, filters and sorting need them all); the text is read only for the first few.
      const ranked = rank(await ready(), req.query);
      const n = Math.min(ranked.length, req.snippets ?? 40);
      const texts = await getMany<string[] | undefined>(ranked.slice(0, n).map((r) => r.key), textStore);
      return ranked.map((r, i) => ({ key: r.key, score: r.score, ...(i < n ? snippetFor(texts[i] ?? [], r.terms) : { page: 0 }) }));
    }
    case 'snippets': {
      const want = new Set(req.keys);
      const ranked = rank(await ready(), req.query).filter((r) => want.has(r.key));
      const texts = await getMany<string[] | undefined>(ranked.map((r) => r.key), textStore);
      return ranked.map((r, i) => ({ key: r.key, score: r.score, ...snippetFor(texts[i] ?? [], r.terms) }));
    }
  }
}

// One at a time, in order: a search after a change sees it.
let queue: Promise<unknown> = Promise.resolve();
function enqueue(req: SearchRequest | { id: 0; type: 'save' }) {
  queue = queue.then(() =>
    handle(req).then(
      (result) => req.id && self.postMessage({ id: req.id, ok: true, result } satisfies SearchResponse),
      (err: unknown) => req.id && self.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies SearchResponse),
    ),
  );
}
self.onmessage = (e: MessageEvent<SearchRequest>) => enqueue(e.data);
