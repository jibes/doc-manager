import type { IndexedDoc } from './search';

/**
 * The types and tags the archive already uses, most used first: what the AI model is asked to choose from, and
 * what its answers are matched onto, so one thing keeps one name ("Rechnung", not also "Rechnungen", "rechnung").
 */
export type Vocabulary = { types: [string, number][]; tags: [string, number][] };

/** Tags sent to the model at most: the most used (a long tail of one-offs says little and costs tokens). */
export const MAX_TAGS_SENT = 80;

/**
 * A name as compared: case, accents, ß and a plural or inflection ending don't make another name
 * ("Ärzte" = "Arzt", "Rechnungen" = "Rechnung", "Steuern" = "Steuer", "Invoices" = "invoice").
 */
export function nameKey(s: string): string {
  const k = s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[\s_-]+/g, ' ')
    .trim();
  return k.length > 4 ? k.replace(/(?:en|es|e|n|s)$/, '') : k;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length];
}

/**
 * `value` as the archive already writes it: the known name that is the same word (see nameKey) or a typo of it
 * (one letter off in a word of 6 or more, two in one of 10 or more); else `value` itself, a new name.
 */
export function snapName(value: string, known: readonly string[]): string {
  const v = value.trim();
  if (!v) return v;
  const key = nameKey(v);
  const same = known.find((k) => nameKey(k) === key);
  if (same) return same;
  const reach = key.length >= 10 ? 2 : key.length >= 6 ? 1 : 0;
  if (!reach) return v;
  let best: string | null = null;
  let bestD = reach + 1;
  for (const k of known) {
    const d = editDistance(nameKey(k), key);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best ?? v;
}

/** Tags matched onto the known ones, each once, at most `max`. */
export function snapTags(tags: readonly string[], known: readonly string[], max = 3): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const s = snapName(tag, known);
    if (s && !out.some((x) => nameKey(x) === nameKey(s))) out.push(s);
  }
  return out.slice(0, max);
}

/** Counts by name, the most used spelling of a name standing for it. */
function counted(values: string[]): [string, number][] {
  const byKey = new Map<string, Map<string, number>>();
  for (const v of values) {
    const s = v.trim();
    if (!s) continue;
    const spellings = byKey.get(nameKey(s)) ?? new Map<string, number>();
    spellings.set(s, (spellings.get(s) ?? 0) + 1);
    byKey.set(nameKey(s), spellings);
  }
  return [...byKey.values()]
    .map((spellings): [string, number] => {
      // The most used spelling; as many of each, the capitalised one.
      const [name] = [...spellings].sort((a, b) => b[1] - a[1] || Number(b[0][0] !== b[0][0].toLocaleLowerCase()) - Number(a[0][0] !== a[0][0].toLocaleLowerCase()))[0];
      return [name, [...spellings.values()].reduce((a, b) => a + b, 0)];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function vocabularyOf(docs: Pick<IndexedDoc, 'type' | 'tags'>[]): Vocabulary {
  return { types: counted(docs.map((d) => d.type)), tags: counted(docs.flatMap((d) => d.tags)) };
}

/** The archive's vocabulary now (empty where there is no index, as in tests). */
export async function vocabulary(): Promise<Vocabulary> {
  const docs = await import('./indexer').then((m) => m.allDocs()).catch(() => []);
  return vocabularyOf(docs);
}
