import type { TidyAnswer } from '@/paper/scan/ai';
import type { Details } from './pdfInfo';
import type { IndexedDoc } from './search';
import { nameKey, vocabularyOf } from './vocabulary';

/**
 * Tidying the archive's tags and types, in three steps of growing reach, each including the ones before:
 * - spelling: the same word written differently ("Steuer", "steuern") becomes its most used spelling (no AI);
 * - same: names that mean the same (synonyms, translations: "Arzt", "Doctor") become one (AI);
 * - broader: tags become broader topics ("Zahnarzt", "Hausarzt" → "Gesundheit") (AI; types stay at "same").
 * Besides, a tag that only repeats the document's own type or sender goes (no AI). Nothing is written until the
 * groups, as reviewed, are applied.
 */
export type Level = 'spelling' | 'same' | 'broader';

export type Member = { name: string; count: number; on: boolean };
/** Names that become `to`. `on` per member: one can be left as it is. */
export type Group = { id: string; kind: 'tag' | 'type'; to: string; members: Member[] };

type Named = Pick<IndexedDoc, 'type' | 'tags' | 'sender'>;

/** Every spelling and how many documents use it. */
function spellings(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values.map((x) => x.trim()).filter(Boolean)) out.set(v, (out.get(v) ?? 0) + 1);
  return out;
}

/** As many use one as the other: the capitalised one ("Rechnung", not "rechnung"). */
const capital = (s: string) => (s[0] !== s[0].toLocaleLowerCase() ? 1 : 0);

/** The same word written in more than one way: each group goes to its most used spelling. */
function spellingGroups(kind: Group['kind'], values: string[]): Group[] {
  const byKey = new Map<string, [string, number][]>();
  for (const [name, count] of spellings(values)) byKey.set(nameKey(name), [...(byKey.get(nameKey(name)) ?? []), [name, count]]);
  return [...byKey.entries()]
    .filter(([, forms]) => forms.length > 1)
    .map(([key, forms]) => {
      const sorted = forms.sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]) || a[0].localeCompare(b[0]));
      return { id: `${kind}:${key}`, kind, to: sorted[0][0], members: sorted.map(([name, count]) => ({ name, count, on: true })) };
    });
}

/** Names grouped by where the model's answer takes them (names it left out, or answered with nothing, stay). */
function answerGroups(kind: Group['kind'], counted: [string, number][], target: (name: string) => string): Group[] {
  const known = new Map(counted.map(([n]) => [nameKey(n), n]));
  const byKey = new Map<string, { to: string; members: Member[] }>();
  for (const [name, count] of counted) {
    const raw = target(name).trim() || name;
    // A target that is a name in use is written as that name is.
    const to = known.get(nameKey(raw)) ?? raw;
    const g = byKey.get(nameKey(to)) ?? { to, members: [] };
    g.members.push({ name, count, on: true });
    byKey.set(nameKey(to), g);
  }
  return [...byKey.entries()]
    .filter(([key, g]) => g.members.some((m) => nameKey(m.name) !== key))
    .map(([key, g]) => ({ id: `${kind}:${key}`, kind, to: g.to, members: g.members.sort((a, b) => b.count - a.count) }));
}

/** The groups a level proposes for `docs` (the AI levels need the model's `answer`). */
export function groupsFor(docs: Named[], level: Level, answer: TidyAnswer | null): Group[] {
  if (level === 'spelling' || !answer) {
    return [...spellingGroups('type', docs.map((d) => d.type)), ...spellingGroups('tag', docs.flatMap((d) => d.tags))];
  }
  const v = vocabularyOf(docs);
  const lookup = <T extends { same: string }>(entries: T[], name: (e: T) => string) => {
    const m = new Map(entries.map((e) => [nameKey(name(e)), e]));
    return (n: string) => m.get(nameKey(n));
  };
  const tag = lookup(answer.tags, (e) => e.tag);
  const type = lookup(answer.types, (e) => e.type);
  const same = (n: string) => tag(n)?.same || n;
  const tagTarget = level === 'same' ? same : (n: string) => tag(same(n))?.broader || tag(n)?.broader || same(n);
  // A spelling variant counts with the name it is a spelling of (the vocabulary already put them together); names
  // the model leaves as they are still get their spellings made one.
  const ai = [...answerGroups('type', v.types, (n) => type(n)?.same || n), ...answerGroups('tag', v.tags, tagTarget)];
  const covered = new Set(ai.flatMap((g) => g.members.map((m) => `${g.kind}:${nameKey(m.name)}`)));
  return [...groupsFor(docs, 'spelling', null).filter((g) => !covered.has(g.id)), ...ai];
}

/** Tags that only repeat the document's own type or sender ("Rechnung" on an invoice): how many documents have one. */
export function repeatsCount(docs: Named[]): number {
  return docs.filter((d) => d.tags.some((x) => repeats(x, d))).length;
}

const repeats = (tag: string, d: Pick<Details, 'type' | 'sender'>) => !!tag.trim() && (nameKey(tag) === nameKey(d.type) || nameKey(tag) === nameKey(d.sender));

/**
 * The change to one document: its tags and type as the groups that are on take them, each tag once; with
 * `dropRepeats`, without tags that repeat its type or sender. Spelling variants of a member go with it.
 */
export function editFor(groups: Group[], dropRepeats: boolean): (d: Details) => Details {
  const maps = { tag: new Map<string, string>(), type: new Map<string, string>() };
  for (const g of groups) {
    const to = g.to.trim();
    if (!to) continue;
    for (const m of g.members) if (m.on) maps[g.kind].set(nameKey(m.name), to);
  }
  return (d) => {
    const type = maps.type.get(nameKey(d.type)) ?? d.type;
    const tags: string[] = [];
    for (const tag of d.tags) {
      if (dropRepeats && repeats(tag, { type, sender: d.sender })) continue;
      const to = maps.tag.get(nameKey(tag)) ?? tag;
      if (!tags.some((x) => nameKey(x) === nameKey(to))) tags.push(to);
    }
    return { ...d, type, tags };
  };
}

/** The documents the change would alter (the index's details, as the files have them). */
export function changedBy(docs: IndexedDoc[], edit: (d: Details) => Details): IndexedDoc[] {
  return docs.filter((doc) => {
    const now: Details = { title: doc.title, sender: doc.sender, type: doc.type, date: doc.date, tags: doc.tags };
    const next = edit(now);
    return next.type !== now.type || next.tags.join('\n') !== now.tags.join('\n');
  });
}
