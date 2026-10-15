import MiniSearch, { type Options, type SearchResult } from 'minisearch';

import type { FolderEntry } from '@/lib/folderTypes';

/**
 * Search across every document Tessel can see: an index kept on this device (never synced; each device builds its
 * own from the files). One record per document: where it is, how it was when read, its details and its text.
 */

/**
 * Where a document is: in the library, or a file in a folder (`dir`: its parent folder's ID, undefined at the top;
 * `inbox`: in the archive's Inbox, not filed yet).
 */
export type Place = { kind: 'library'; id: string } | { kind: 'folder'; root: string; rootName: string; dir?: string; entry: FolderEntry; inbox?: boolean };

export type IndexedDoc = {
  /** "lib:<id>" or "<root>:<entry id>". */
  key: string;
  place: Place;
  name: string;
  size: number;
  modified: number;
  title: string;
  sender: string;
  type: string;
  tags: string[];
  date: string;
  /** Could not be read (damaged, protected): kept so it isn't tried again until it changes. */
  failed?: boolean;
  /** Content hash (SHA-256, hex), to find the same document filed twice. */
  hash?: string;
  /** The document across edits and devices (shared.ts docKey), to share reading state. */
  share?: string;
};

/** A document with its text (per page, capped): what the index is built from. Kept apart from the details. */
export type Indexable = IndexedDoc & { pages: string[] };

/** `snippet`: null when the text has none; undefined until asked for (only rows shown get theirs). */
export type Hit = { doc: IndexedDoc; score: number; page: number; snippet?: { before: string; match: string; after: string } | null };

/** Letters, digits and dots inside numbers stay together ("02.10.2026", "NKL4471902"). */
const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? [];

/** How documents are indexed (the same when a saved index is loaded again). */
export const indexOptions: Options<Indexable> = {
  idField: 'key',
  fields: ['title', 'sender', 'type', 'tags', 'name', 'text'],
  storeFields: [],
  extractField: (doc, field) => {
    if (field === 'tags') return doc.tags.join(' ');
    if (field === 'text') return doc.pages.join('\n');
    return (doc as unknown as Record<string, string>)[field] ?? '';
  },
  tokenize,
  // Cleaning up after removals runs in the background and can trip over documents added meanwhile: the search
  // worker cleans up itself, before it saves the index.
  autoVacuum: false,
  searchOptions: {
    boost: { title: 3, sender: 2, tags: 2, type: 1.5, name: 1.5 },
    prefix: (term) => term.length > 2,
    fuzzy: (term) => (term.length > 4 ? 0.2 : false),
    combineWith: 'AND',
  },
};

export const createIndex = (): MiniSearch<Indexable> => new MiniSearch<Indexable>(indexOptions);

const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
/** Where `term` first starts a word in `lower` (as the index matched it: "bahn" in "Deutsche Bahn", not "Autobahn"). */
function wordAt(lower: string, term: string): number {
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + 1)) if (!wordChar(lower[i - 1])) return i;
  return -1;
}

/** The page where a query's terms first appear, with the words around the first of them. */
export function snippetFor(pages: string[], terms: string[]): Pick<Hit, 'page' | 'snippet'> {
  const lowered = terms.map((t) => t.toLowerCase()).filter(Boolean);
  for (let page = 0; page < pages.length; page++) {
    const text = pages[page];
    const lower = text.toLowerCase();
    let at = -1;
    let len = 0;
    for (const term of lowered) {
      const i = wordAt(lower, term);
      if (i >= 0 && (at < 0 || i < at)) [at, len] = [i, term.length];
    }
    if (at < 0) continue;
    // The whole word the term starts (a prefix match finds "rechnung" for "rech").
    while (at + len < text.length && /[\p{L}\p{N}]/u.test(text[at + len])) len++;
    const from = Math.max(0, text.lastIndexOf(' ', Math.max(0, at - 60)) + 1);
    const to = text.indexOf(' ', Math.min(text.length, at + len + 60));
    const end = to < 0 ? text.length : to;
    return {
      page,
      snippet: {
        before: (from > 0 ? '…' : '') + text.slice(from, at).replace(/\s+/g, ' '),
        match: text.slice(at, at + len),
        after: text.slice(at + len, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : ''),
      },
    };
  }
  return { page: 0, snippet: null };
}

/** Best matches first (all of them unless `limit`): keys with the terms they matched. */
export function rank(index: MiniSearch<Indexable>, query: string, limit = Infinity): { key: string; score: number; terms: string[] }[] {
  const q = query.trim();
  if (q.length < 2) return [];
  return index
    .search(q)
    .slice(0, limit)
    .map((r: SearchResult) => ({ key: String(r.id), score: r.score, terms: r.terms }));
}
