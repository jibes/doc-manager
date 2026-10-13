import type { Details } from './pdfInfo';

/**
 * How the inbox sorts documents, kept with the archive (`.tessel/rules.json`) so every device has the same:
 * rules that fill in details from words in a document, and the path a filed document gets.
 */

/** When the text has `match` (alternatives separated by commas, each needing all its words), these details apply. */
export type Rule = { id: string; match: string; sender: string; type: string; tags: string[] };
export type Rules = { template: string; rules: Rule[] };

/** Year, then sender, then the date and title: "2026/KoRo/2026-09-28 Lieferschein.pdf". */
export const DEFAULT_TEMPLATE = '{year}/{sender}/{date} {title}';
export const DEFAULT_RULES: Rules = { template: DEFAULT_TEMPLATE, rules: [] };
export const PLACEHOLDERS = ['year', 'month', 'day', 'date', 'sender', 'type', 'title'] as const;

const fold = (s: string) => s.toLocaleLowerCase().normalize('NFC');

/** Whether a rule applies: any comma-separated alternative whose words all occur in the text (ignoring case). */
export function ruleMatches(text: string, rule: Rule): boolean {
  const hay = fold(text);
  return rule.match
    .split(',')
    .map((alt) => fold(alt).split(/\s+/).filter(Boolean))
    .some((words) => words.length > 0 && words.every((w) => hay.includes(w)));
}

/** Details with the matching rules applied: what the document already has stays; tags are added. */
export function applyRules(text: string, details: Details, rules: Rule[]): Details {
  const out = { ...details, tags: [...details.tags] };
  for (const rule of rules) {
    if (!ruleMatches(text, rule)) continue;
    if (!out.sender && rule.sender) out.sender = rule.sender;
    if (!out.type && rule.type) out.type = rule.type;
    for (const tag of rule.tags) if (!out.tags.some((x) => fold(x) === fold(tag))) out.tags.push(tag);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, jänner: 1,
  feb: 2, februar: 2, february: 2,
  mär: 3, märz: 3, mar: 3, march: 3, maerz: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

const iso = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1900 || y > 2100) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** The first date in a text, as YYYY-MM-DD: 02.10.2026, 2.10.26, 2026-10-02, 2. Oktober 2026, October 2, 2026. */
export function findDate(text: string): string {
  const patterns: [RegExp, (m: RegExpExecArray) => string][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => iso(+m[1], +m[2], +m[3])],
    [/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\b/, (m) => iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1])],
    [/\b(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,9})\.?\s+(\d{4})\b/, (m) => (MONTHS[fold(m[2])] ? iso(+m[3], MONTHS[fold(m[2])], +m[1]) : '')],
    [/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/, (m) => (MONTHS[fold(m[1])] ? iso(+m[3], MONTHS[fold(m[1])], +m[2]) : '')],
  ];
  // The earliest valid date in the text wins (letters put theirs near the top).
  let best = { at: Infinity, date: '' };
  for (const [re, toDate] of patterns) {
    const global = new RegExp(re.source, 'g');
    for (let m = global.exec(text); m; m = global.exec(text)) {
      const date = toDate(m);
      if (date && m.index < best.at) best = { at: m.index, date };
      if (date) break;
    }
  }
  return best.date;
}

/** A path part that is safe on every system Syncthing may sync to. */
const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 120);

/**
 * Where a filed document goes, from the template: folders and the file name (with ".pdf"). Missing details are
 * left out with what joined them; a document without a date uses `fallbackDate`, one without a title `fallbackTitle`.
 */
export function pathFor(template: string, d: Details, fallback: { title: string; date: string; sender: string }): string[] {
  const date = d.date || fallback.date;
  const values: Record<(typeof PLACEHOLDERS)[number], string> = {
    year: date.slice(0, 4),
    month: date.slice(5, 7),
    day: date.slice(8, 10),
    date,
    sender: d.sender || fallback.sender,
    type: d.type,
    title: d.title || fallback.title,
  };
  const parts = (template.trim() || DEFAULT_TEMPLATE)
    .split('/')
    .map((part) =>
      safe(
        part
          .replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key as keyof typeof values] : all))
          // A missing value leaves no stray separators: "2026-10-02  – " → "2026-10-02".
          .replace(/\s*[-–·_]\s*$/, '')
          .replace(/^\s*[-–·_]\s*/, ''),
      ),
    )
    .filter(Boolean);
  const name = parts.pop() || safe(fallback.title) || 'Document';
  return [...parts, `${name.replace(/\.pdf$/i, '')}.pdf`];
}

/** Rules as stored: anything malformed is dropped. */
export function parseRules(json: string): Rules {
  try {
    const raw = JSON.parse(json) as { template?: unknown; rules?: unknown };
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const rules = (Array.isArray(raw?.rules) ? raw.rules : [])
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Rule).id === 'string' && !!str((r as Rule).match))
      .map((r) => ({
        id: r.id as string,
        match: str(r.match),
        sender: str(r.sender),
        type: str(r.type),
        tags: Array.isArray(r.tags) ? r.tags.map(str).filter(Boolean) : [],
      }));
    return { template: str(raw?.template) || DEFAULT_TEMPLATE, rules };
  } catch {
    return DEFAULT_RULES;
  }
}

export const serializeRules = (r: Rules) => `${JSON.stringify({ version: 1, ...r }, null, 2)}\n`;
