import type { Hit, Indexable, IndexedDoc } from './search';

/** Messages to the search worker (searchWorker.ts), each answered once with its id. */
export type SearchRequest = { id: number } & (
  | { type: 'migrate' }
  | { type: 'warm' }
  | { type: 'put'; doc: Indexable }
  /** Details changed, not the text (where it is): stored, not indexed again. */
  | { type: 'meta'; doc: IndexedDoc }
  /** A file moved or renamed (a new key): its text goes along under the new key, not read again. */
  | { type: 'rekey'; from: string; doc: IndexedDoc }
  | { type: 'drop'; keys: string[] }
  /** Every match, best first; the words around it for the first `snippets` only (the rest: `snippets` below). */
  | { type: 'search'; query: string; snippets?: number }
  /** The page to open and the words around the match, for these documents (rows about to be shown). */
  | { type: 'snippets'; query: string; keys: string[] }
);

/** A match: the document's key, with the page to open and the words around it (undefined: not read yet). */
export type Match = { key: string; score: number } & Pick<Hit, 'page' | 'snippet'>;

export type SearchResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
