import { APP_ROOT_ID } from '@/core/lib/nesting';
import type { IndexedDoc } from './search';

/** What the Documents screen narrows by: one value per kind (any for the others), and how it sorts. */
export type Filter = { tag?: string; sender?: string; type?: string; year?: string };
/**
 * What a list is sorted by: when this device last opened it (never opened ones after, newest first), the document's
 * date, its name, its size; search results also by how well they match. Each has its usual way round (names A–Z,
 * the rest newest or largest first), which `reverse` turns.
 */
export type Sort = 'opened' | 'date' | 'name' | 'size';
export const SORTS: Sort[] = ['opened', 'date', 'name', 'size'];
/** Whether a list sorted so runs from small to large (A–Z, oldest first, smallest first). */
export const ascending = (sort: Sort, reverse: boolean) => (sort === 'name') !== reverse;
/** When this device last opened a document (Tessel records it; files don't say). */
export type OpenedAt = (d: IndexedDoc) => number | undefined;
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

export function sortDocs<T>(items: T[], sort: Sort, docOf: (item: T) => IndexedDoc, opened?: OpenedAt, reverse?: boolean): T[];
export function sortDocs(items: IndexedDoc[], sort: Sort, docOf?: undefined, opened?: OpenedAt, reverse?: boolean): IndexedDoc[];
export function sortDocs<T>(items: T[], sort: Sort, docOf: (item: T) => IndexedDoc = (x) => x as unknown as IndexedDoc, opened?: OpenedAt, reverse = false): T[] {
  const compare = (a: IndexedDoc, b: IndexedDoc): number => {
    switch (sort) {
      case 'opened':
        return (opened?.(b) ?? 0) - (opened?.(a) ?? 0) || cmp(docDate(b), docDate(a));
      case 'name':
        return byName(a, b);
      case 'size':
        return b.size - a.size;
      case 'date':
        return cmp(docDate(b), docDate(a));
    }
  };
  // Turned the other way round; equals stay A–Z.
  return [...items].sort((x, y) => {
    const [a, b] = [docOf(x), docOf(y)];
    return (reverse ? compare(b, a) : compare(a, b)) || byName(a, b);
  });
}

/** Where a document is: in the Tessel folder (what Tessel keeps), or in a source (a folder Tessel reads). */
export type Where = 'tessel' | 'sources';
export const WHERES: Where[] = ['tessel', 'sources'];
/**
 * The Tessel folder is everything Tessel keeps: the folder chosen for it (synced, often), else this device's own
 * (Documents/Tessel on Android, the browser's own storage). Anything else (what the folder before it left, being
 * forgotten) isn't listed.
 */
export const placeOf = (d: IndexedDoc, tessel: string | null): Where => (d.place.kind === 'library' || d.place.root === (tessel ?? APP_ROOT_ID) ? 'tessel' : 'sources');
/** Saved views from before the two places: the archive and this device were Tessel's, other folders sources. */
const OLD_PLACES: Record<string, Where> = { archive: 'tessel', device: 'tessel', folders: 'sources' };

/**
 * A named filter, kept with the archive so every device has it. `place`: only documents there; `relevance`: a
 * search's best matches first (else in `sort` order, turned with `reverse`).
 */
export type SavedView = { id: string; name: string; query: string; filter: Filter; sort: Sort; reverse?: boolean; place?: Where; relevance?: boolean };

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
        // "Oldest first" was an order of its own: by date, turned.
        sort: SORTS.includes(v.sort) ? v.sort : 'date',
        ...(v.reverse === true || (v.sort as string) === 'oldest' ? { reverse: true } : {}),
        ...(WHERES.includes(v.place!) ? { place: v.place } : OLD_PLACES[v.place as string] ? { place: OLD_PLACES[v.place as string] } : {}),
        ...(typeof v.relevance === 'boolean' ? { relevance: v.relevance } : {}),
      }));
  } catch {
    return [];
  }
}

export const serializeViews = (views: SavedView[]) => `${JSON.stringify({ version: 1, views }, null, 2)}\n`;
