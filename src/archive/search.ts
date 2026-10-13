import MiniSearch, { type SearchResult } from 'minisearch';

import type { FolderEntry } from '@/lib/folderTypes';

/**
 * Search across every document Tessel can see: an index kept on this device (never synced; each device builds its
 * own from the files). One record per document: where it is, how it was when read, its details and its text.
 */

/** Where a document is: in the library (a copy, or linked), or a file in one of the user's folders. */
export type Place = { kind: 'library'; id: string } | { kind: 'folder'; root: string; rootName: string; entry: FolderEntry };

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
  /** Text per page (capped). */
  pages: string[];
  /** Could not be read (damaged, protected): kept so it isn't tried again until it changes. */
  failed?: boolean;
};

export type Hit = { doc: IndexedDoc; score: number; page: number; snippet: { before: string; match: string; after: string } | null };

/** Letters, digits and dots inside numbers stay together ("02.10.2026", "VAH7663219"). */
const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? [];

export function createIndex(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>({
    idField: 'key',
    fields: ['title', 'sender', 'type', 'tags', 'name', 'text'],
    storeFields: [],
    extractField: (doc, field) => {
      if (field === 'tags') return doc.tags.join(' ');
      if (field === 'text') return doc.pages.join('\n');
      return (doc as unknown as Record<string, string>)[field] ?? '';
    },
    tokenize,
    searchOptions: {
      boost: { title: 3, sender: 2, tags: 2, type: 1.5, name: 1.5 },
      prefix: (term) => term.length > 2,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
      combineWith: 'AND',
    },
  });
}

/** The page where a query's terms first appear, with the words around the first of them. */
export function snippetFor(doc: IndexedDoc, terms: string[]): Pick<Hit, 'page' | 'snippet'> {
  const lowered = terms.map((t) => t.toLowerCase()).filter(Boolean);
  for (let page = 0; page < doc.pages.length; page++) {
    const text = doc.pages[page];
    const lower = text.toLowerCase();
    let at = -1;
    let len = 0;
    for (const term of lowered) {
      const i = lower.indexOf(term);
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

/** Best matches first, each with the page to open and a snippet. */
export function searchIndex(index: MiniSearch<IndexedDoc>, docs: Map<string, IndexedDoc>, query: string, limit = 50): Hit[] {
  const q = query.trim();
  if (q.length < 2) return [];
  return index
    .search(q)
    .slice(0, limit)
    .map((r: SearchResult) => {
      const doc = docs.get(String(r.id))!;
      return { doc, score: r.score, ...snippetFor(doc, r.terms) };
    })
    .filter((h) => h.doc);
}
