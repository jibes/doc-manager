import type { IndexedDoc } from './search';

/** What the Documents screen narrows by: one value per kind (any for the others), and how it sorts. */
export type Filter = { tag?: string; sender?: string; type?: string; year?: string };
/** Newest or oldest by the document's date, by name, or largest first; search results also by how well they match. */
export type Sort = 'date' | 'oldest' | 'name' | 'size';
export const SORTS: Sort[] = ['date', 'oldest', 'name', 'size'];
export type Facet = keyof Filter;
export const FACETS: Facet[] = ['tag', 'sender', 'type', 'year'];

/** A moment as the local date, YYYY-MM-DD (a file saved at 00:30 in Berlin is of that day, not the day before). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A document's own date (its details), else the file's: YYYY-MM-DD. */
export function docDate(d: IndexedDoc): string {
  if (d.date) return d.date;
  return d.modified > 0 ? localDate(d.modified) : '';
}

/** The values a document has for a facet (a document can have several tags). */
export function valuesOf(d: IndexedDoc, facet: Facet): string[] {
  switch (facet) {
    case 'tag':
      return d.tags;
    case 'sender':
      return d.sender ? [d.sender] : [];
    case 'type':
      return d.type ? [d.type] : [];
    case 'year': {
      const y = docDate(d).slice(0, 4);
      return y ? [y] : [];
    }
  }
}

// Made once: thousands of documents are compared on every change (a collator per comparison was the slow part).
const accent = new Intl.Collator(undefined, { sensitivity: 'accent' });
const plain = new Intl.Collator();
const natural = new Intl.Collator(undefined, { numeric: true });

/** Case-insensitive: "Rechnung" and "rechnung" are one value. */
const same = (a: string, b: string) => accent.compare(a, b) === 0;

export function matches(d: IndexedDoc, filter: Filter): boolean {
  return FACETS.every((f) => !filter[f] || valuesOf(d, f).some((v) => same(v, filter[f]!)));
}

/**
 * For each facet, its values among the documents that match the other facets' choices (so every count leads
 * somewhere), most common first, then alphabetically; years newest first.
 */
export function facetCounts(docs: IndexedDoc[], filter: Filter): Record<Facet, { value: string; count: number }[]> {
  const out = {} as Record<Facet, { value: string; count: number }[]>;
  for (const facet of FACETS) {
    const others = { ...filter, [facet]: undefined };
    const counts = new Map<string, { value: string; count: number }>();
    for (const d of docs) {
      if (!matches(d, others)) continue;
      for (const v of new Set(valuesOf(d, facet))) {
        const key = v.toLocaleLowerCase();
        const c = counts.get(key) ?? { value: v, count: 0 };
        c.count++;
        counts.set(key, c);
      }
    }
    out[facet] = [...counts.values()].sort((a, b) =>
      facet === 'year' ? (b.value < a.value ? -1 : b.value > a.value ? 1 : 0) : b.count - a.count || plain.compare(a.value, b.value),
    );
  }
  return out;
}

const titleOf = (d: IndexedDoc) => d.title || d.name.replace(/\.pdf$/i, '');

const byName = (a: IndexedDoc, b: IndexedDoc) => natural.compare(titleOf(a), titleOf(b));

/** Dates are YYYY-MM-DD: compared as they are. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortDocs<T>(items: T[], sort: Sort, docOf: (item: T) => IndexedDoc): T[];
export function sortDocs(items: IndexedDoc[], sort: Sort): IndexedDoc[];
export function sortDocs<T>(items: T[], sort: Sort, docOf: (item: T) => IndexedDoc = (x) => x as unknown as IndexedDoc): T[] {
  const compare = (a: IndexedDoc, b: IndexedDoc): number => {
    switch (sort) {
      case 'name':
        return byName(a, b);
      case 'size':
        return b.size - a.size || byName(a, b);
      case 'oldest':
        return cmp(docDate(a), docDate(b)) || byName(a, b);
      case 'date':
        return cmp(docDate(b), docDate(a)) || byName(a, b);
    }
  };
  return [...items].sort((a, b) => compare(docOf(a), docOf(b)));
}

/** Where a document is: the archive (synced), another folder, or only on this device. */
export type Where = 'archive' | 'folders' | 'device';
export const WHERES: Where[] = ['archive', 'folders', 'device'];

/**
 * A named filter, kept with the archive so every device has it. `place`: only documents there; `relevance`: a
 * search's best matches first (else in `sort` order).
 */
export type SavedView = { id: string; name: string; query: string; filter: Filter; sort: Sort; place?: Where; relevance?: boolean };

/** Views as stored: anything malformed is dropped rather than breaking the screen. */
export function parseViews(json: string): SavedView[] {
  try {
    const raw = JSON.parse(json) as { views?: unknown };
    const list = Array.isArray(raw?.views) ? raw.views : [];
    return list
      .filter((v): v is SavedView => !!v && typeof v === 'object' && typeof (v as SavedView).id === 'string' && typeof (v as SavedView).name === 'string')
      .map((v) => ({
        id: v.id,
        name: v.name,
        query: typeof v.query === 'string' ? v.query : '',
        filter: Object.fromEntries(FACETS.filter((f) => typeof v.filter?.[f] === 'string').map((f) => [f, v.filter[f]])) as Filter,
        sort: SORTS.includes(v.sort) ? v.sort : 'date',
        ...(WHERES.includes(v.place!) ? { place: v.place } : {}),
        ...(typeof v.relevance === 'boolean' ? { relevance: v.relevance } : {}),
      }));
  } catch {
    return [];
  }
}

export const serializeViews = (views: SavedView[]) => `${JSON.stringify({ version: 1, views }, null, 2)}\n`;
