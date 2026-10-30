import type { Details } from './pdfInfo';
import type { IndexedDoc } from './search';
import { nameKey, vocabularyOf } from './vocabulary';

/**
 * Tidying the archive's tags (or types) into a few categories, in three parts that don't overlap:
 * 1. Clean-up, without asking: one spelling per word ("steuern" → "Steuer"); tags that only repeat the
 *    document's type or sender go; tags that are names of companies or people go to the sender field (where it
 *    is empty) and leave the tags.
 * 2. Categories: the names the user keeps, chosen from all in use (sorted by use, generality or the model's
 *    suggestion), new ones allowed.
 * 3. Sorting in, one of two ways: by name, every other name gets one destination (a category, itself, or removed);
 *    or by content, each document gets the categories the model finds for its text, in place of what it had.
 * Nothing is written until the result is applied.
 */
export type Kind = 'tag' | 'type';

/** A name in use: how many documents have it, and what the model made of it (when asked). */
export type NameInfo = { name: string; count: number; generality: number | null; company: boolean };

/** Where a name that isn't a category goes. */
export type Destination = { to: 'category'; category: string } | { to: 'keep' } | { to: 'remove' };

export type Plan = {
  kind: Kind;
  /** The clean-up of part 1. */
  cleanup: boolean;
  categories: string[];
  /** By nameKey; a name without one is kept. */
  destinations: Map<string, Destination>;
  /** By nameKey: names of companies or people (tags only). */
  companies: Set<string>;
  /** By document key: the categories found in its content, in place of its tags (or type). Others (and those
   * for which none fits) go by name. */
  assigned?: Map<string, string[]>;
  /** By document key: documents left as they are. */
  skip?: Set<string>;
  /** By content: a document without a category from it also loses its tags (or type) outside the categories. */
  dropOthers?: boolean;
};

/** A document's change: `key` picks its assignment (by content) and whether it is skipped. */
export type Edit = (d: Details, key?: string) => Details;

type Named = Pick<IndexedDoc, 'type' | 'tags' | 'sender'>;

/** The names in use, most used first (spellings of one name counted together, the most used standing for it). */
export function namesOf(docs: Named[], kind: Kind): NameInfo[] {
  const v = vocabularyOf(docs);
  return (kind === 'tag' ? v.tags : v.types).map(([name, count]) => ({ name, count, generality: null, company: false }));
}

/** How many names are written more than one way (part 1 makes each one). */
export function spellingFixes(docs: Named[], kind: Kind): number {
  const forms = new Map<string, Set<string>>();
  for (const v of kind === 'tag' ? docs.flatMap((d) => d.tags) : docs.map((d) => d.type)) {
    const s = v.trim();
    if (s) forms.set(nameKey(s), (forms.get(nameKey(s)) ?? new Set()).add(s));
  }
  return [...forms.values()].filter((f) => f.size > 1).length;
}

const repeats = (tag: string, d: Pick<Details, 'type' | 'sender'>) => !!tag.trim() && (nameKey(tag) === nameKey(d.type) || nameKey(tag) === nameKey(d.sender));

/** Documents with a tag that only repeats their type or sender. */
export function repeatsCount(docs: Named[]): number {
  return docs.filter((d) => d.tags.some((x) => repeats(x, d))).length;
}

/**
 * Categories to start from: the model's suggestion where there is one; else the most used names until about
 * `size` of them, or fewer where those already cover nearly every document that has any.
 */
export function suggestedCategories(docs: Named[], names: NameInfo[], kind: Kind, suggested: string[] | null, size = 12): string[] {
  if (suggested?.length) return suggested.slice(0, 15);
  const withAny = docs.filter((d) => (kind === 'tag' ? d.tags.length : d.type)).length;
  const out: string[] = [];
  for (const n of names.filter((x) => !x.company)) {
    if (out.length >= size || (withAny && directCoverage(docs, out, kind) / withAny >= 0.9)) break;
    out.push(n.name);
  }
  return out;
}

/** Documents that have one of `categories` as it is (before anything is sorted in). */
export function directCoverage(docs: Named[], categories: string[], kind: Kind): number {
  const keys = new Set(categories.map(nameKey));
  return docs.filter((d) => (kind === 'tag' ? d.tags.some((x) => keys.has(nameKey(x))) : keys.has(nameKey(d.type)))).length;
}

/** The change to one document as the plan says (written only where it changes something). */
export function editFor(plan: Plan, names: NameInfo[]): Edit {
  const byName = editByName(plan, names);
  return (d, key) => {
    if (key && plan.skip?.has(key)) return d;
    const found = key ? plan.assigned?.get(key) : undefined;
    if (!found?.length) {
      const named = byName(d);
      if (!plan.assigned || !plan.dropOthers) return named;
      const kept = new Set(plan.categories.map(nameKey));
      return plan.kind === 'type' ? { ...named, type: kept.has(nameKey(named.type)) ? named.type : '' } : { ...named, tags: named.tags.filter((x) => kept.has(nameKey(x))) };
    }
    if (plan.kind === 'type') return { ...d, type: found[0] ?? d.type };
    // The company names still go to the sender; the tags are what the content says.
    const moved = byName({ ...d, tags: d.tags.filter((x) => plan.companies.has(nameKey(x))) });
    return { ...d, sender: moved.sender, tags: found.filter((x, i) => found.findIndex((y) => nameKey(y) === nameKey(x)) === i) };
  };
}

function editByName(plan: Plan, names: NameInfo[]): (d: Details) => Details {
  // One spelling per name: the one standing for it.
  const spelled = new Map(names.map((n) => [nameKey(n.name), n.name]));
  const categories = new Map(plan.categories.map((c) => [nameKey(c), c]));
  const target = (value: string): string | null => {
    const k = nameKey(value);
    const own = plan.cleanup ? (spelled.get(k) ?? value) : value;
    if (categories.has(k)) return categories.get(k)!;
    const dest = plan.destinations.get(k);
    if (dest?.to === 'remove') return null;
    if (dest?.to === 'category') return categories.get(nameKey(dest.category)) ?? dest.category;
    return own;
  };
  if (plan.kind === 'type') return (d) => ({ ...d, type: d.type.trim() ? (target(d.type) ?? '') : d.type });
  return (d) => {
    let sender = d.sender;
    const tags: string[] = [];
    for (const tag of d.tags) {
      if (plan.cleanup && repeats(tag, d)) continue;
      if (plan.companies.has(nameKey(tag))) {
        // A company's or person's name: the sender, where none is given yet.
        if (!sender.trim()) sender = spelled.get(nameKey(tag)) ?? tag;
        continue;
      }
      const to = target(tag);
      if (to && !tags.some((x) => nameKey(x) === nameKey(to))) tags.push(to);
    }
    return { ...d, sender, tags };
  };
}

/** The documents the plan would change (the index's details, as the files have them). */
export function changedBy(docs: IndexedDoc[], edit: Edit): IndexedDoc[] {
  return docs.filter((doc) => {
    const now = detailsIn(doc);
    const next = edit(now, doc.key);
    return next.type !== now.type || next.sender !== now.sender || next.tags.join('\n') !== now.tags.join('\n');
  });
}

/** After the plan: each category (and each name kept as it is) with how many documents have it. */
export function resultCounts(docs: IndexedDoc[], edit: Edit, kind: Kind): [string, number][] {
  const after = docs.map((doc) => edit(detailsIn(doc), doc.key));
  return namesOf(after.map((d) => ({ ...d, sender: d.sender })), kind).map((n) => [n.name, n.count]);
}

export const detailsIn = (doc: IndexedDoc): Details => ({ title: doc.title, sender: doc.sender, type: doc.type, date: doc.date, tags: doc.tags });

/** Documents sent to the model at once to be sorted in by content, and how much of each one's text. */
export const CONTENT_BATCH = 5;
export const CONTENT_CHARS = 2000;

/** The documents tidied: those chosen in the list (by key), or all (null). Set before the screen opens. */
let scope: Set<string> | null = null;
export const tidyOnly = (keys: string[] | null) => {
  scope = keys ? new Set(keys) : null;
};
export const tidyScope = () => scope;
