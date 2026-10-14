import type { IndexedDoc } from './search';

/** What the Documents screen narrows by: one value per kind (any for the others), and how it sorts. */
export type Filter = { tag?: string; sender?: string; type?: string; year?: string };
/** Newest or oldest by the document's date, by name, or largest first; search results also by how well they match. */
export type Sort = 'date' | 'oldest' | 'name' | 'size';
export const SORTS: Sort[] = ['date', 'oldest', 'name', 'size'];
export type Facet = keyof Filter;
export const FACETS: Facet[] = ['tag', 'sender', 'type', 'year'];

/** A document's own date (its details), else the file's: YYYY-MM-DD. */
export function docDate(d: IndexedDoc): string {
  if (d.date) return d.date;
  return d.modified > 0 ? new Date(d.modified).toISOString().slice(0, 10) : '';
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

/** Case-insensitive: "Rechnung" and "rechnung" are one value. */
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

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
      facet === 'year' ? b.value.localeCompare(a.value) : b.count - a.count || a.value.localeCompare(b.value),
    );
  }
  return out;
}

const titleOf = (d: IndexedDoc) => d.title || d.name.replace(/\.pdf$/i, '');

const byName = (a: IndexedDoc, b: IndexedDoc) => titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true });

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
        return docDate(a).localeCompare(docDate(b)) || byName(a, b);
      case 'date':
        return docDate(b).localeCompare(docDate(a)) || byName(a, b);
    }
  };
  return [...items].sort((a, b) => compare(docOf(a), docOf(b)));
}

/** A named filter, kept with the archive so every device has it. */
export type SavedView = { id: string; name: string; query: string; filter: Filter; sort: Sort };

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
      }));
  } catch {
    return [];
  }
}

export const serializeViews = (views: SavedView[]) => `${JSON.stringify({ version: 1, views }, null, 2)}\n`;
