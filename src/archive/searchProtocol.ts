import type { Hit, Indexable } from './search';

/** Messages to the search worker (searchWorker.ts), each answered once with its id. */
export type SearchRequest = { id: number } & (
  | { type: 'migrate' }
  | { type: 'warm' }
  | { type: 'put'; doc: Indexable }
  | { type: 'drop'; keys: string[] }
  | { type: 'search'; query: string; limit?: number }
);

/** A match: the document's key, with the page to open and the words around it. */
export type Match = { key: string; score: number } & Pick<Hit, 'page' | 'snippet'>;

export type SearchResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
