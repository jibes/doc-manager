import type { Details } from './pdfInfo';

/**
 * How the inbox sorts documents, kept with the archive (`.tessel/rules.json`) so every device has the same:
 * rules that fill in details from words in a document, and the path a filed document gets.
 */

/** When the text has `match` (alternatives separated by commas, each needing all its words), these details apply. */
export type Rule = { id: string; match: string; sender: string; type: string; tags: string[] };
export type Rules = { template: string; rules: Rule[] };

/** Year, then sender, then the date and title: "2026/Nordkorn/2026-09-28 Lieferschein.pdf". */
export const DEFAULT_TEMPLATE = '{date} {sender} {title}';
/** The default before the Tessel folder was flat. */
const OLD_DEFAULT = '{year}/{sender}/{date} {title}';
/** No folders in the Tessel folder: a template names the file only ("/" was a folder once; it is a space now). */
export const flatTemplate = (template: string) => {
  const t = template.trim();
  return !t || t === OLD_DEFAULT ? DEFAULT_TEMPLATE : t.replace(/\s*\/\s*/g, ' ').trim() || DEFAULT_TEMPLATE;
};
export const DEFAULT_RULES: Rules = { template: DEFAULT_TEMPLATE, rules: [] };
export const PLACEHOLDERS = ['year', 'month', 'day', 'date', 'sender', 'type', 'title'] as const;

/** Case, Unicode form and ß/SS don't matter ("Straße" is "STRASSE"). */
const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase().replace(/ß/g, 'ss');
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Shorter words than this must start a word ("AOK" isn't in "Kakaokekse"); longer ones may end one ("Stromrechnung"). */
const INFIX_MIN = 4;
const wordIn = (hay: string, w: string) => (w.length >= INFIX_MIN ? hay.includes(w) : new RegExp(`(?:^|[^\\p{L}\\p{N}])${escape(w)}`, 'u').test(hay));

/** Whether a rule applies: any comma-separated alternative whose words all occur in the text (ignoring case). */
export function ruleMatches(text: string, rule: Rule): boolean {
  const hay = fold(text);
  return rule.match
    .split(',')
    .map((alt) => fold(alt).split(/\s+/).filter(Boolean))
    .some((words) => words.length > 0 && words.every((w) => wordIn(hay, w)));
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

const iso = (y: number, m: number, d: number, now: Date) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1900) return '';
  // A document isn't dated more than a year ahead (a due date, maybe; not the date it was written).
  if (date.getTime() > now.getTime() + 366 * 86_400_000) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** "26" → 2026, "98" → 1998: the century that doesn't put it more than a year ahead. */
const fullYear = (yy: string, now: Date) => {
  if (yy.length === 4) return +yy;
  const y = 2000 + +yy;
  return y > now.getFullYear() + 1 ? y - 100 : y;
};

/** Dates that aren't the document's: someone's birthday. */
const BIRTH = /(?:geb\.?|geboren(?:\s+am)?|geburtsdatum:?|born(?:\s+on)?|date\s+of\s+birth:?|dob:?)\s*$/i;

/** A year written with two digits is taken as at most this many years back ("1.2.34" is no date from 1934). */
const SHORT_YEARS_BACK = 30;

/** The first date in a text, as YYYY-MM-DD: 02.10.2026, 2.10.26, 2026-10-02, 2. Oktober 2026, October 2, 2026. */
export function findDate(text: string, now = new Date()): string {
  const patterns: [RegExp, (m: RegExpExecArray) => string][] = [
    // ISO, also with one-digit parts or a time after it ("2026-10-3", "2026-10-03T00:00:00Z": as a model may write it).
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/, (m) => iso(+m[1], +m[2], +m[3], now)],
    // Spaces after the dots are allowed ("03. 10. 2026"); a slash is read day first ("03/10/2026"), as in Europe.
    [/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\b/, (m) => iso(+m[3], +m[2], +m[1], now)],
    [/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, (m) => iso(+m[3], +m[2], +m[1], now)],
    // Two-digit years: not inside a longer dotted number, nor after a version or number word ("Version 2.1.19").
    [
      /(?<![\d.])(?<!\b(?:version|vers|ver|v|rev|release|build|nr|no)\.?\s*)\b(\d{1,2})\.(\d{1,2})\.(\d{2})\b(?!\.\d)/i,
      (m) => {
        const y = fullYear(m[3], now);
        return y >= now.getFullYear() - SHORT_YEARS_BACK ? iso(y, +m[2], +m[1], now) : '';
      },
    ],
    // "3. Oktober 2026", also "3.Oktober 2026" and "3.Okt.2026".
    [/\b(\d{1,2})(?:\.\s*|\s+)([A-Za-zÄÖÜäöü]{3,9})\.?\s*(\d{4})\b/, (m) => (MONTHS[fold(m[2])] ? iso(+m[3], MONTHS[fold(m[2])], +m[1], now) : '')],
    [/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/, (m) => (MONTHS[fold(m[1])] ? iso(+m[3], MONTHS[fold(m[1])], +m[2], now) : '')],
  ];
  // The earliest valid date in the text wins (letters put theirs near the top).
  let best = { at: Infinity, date: '' };
  for (const [re, toDate] of patterns) {
    const global = new RegExp(re.source, `${re.flags}g`);
    for (let m = global.exec(text); m; m = global.exec(text)) {
      if (BIRTH.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
      const date = toDate(m);
      if (!date) continue;
      if (m.index < best.at) best = { at: m.index, date };
      break;
    }
  }
  return best.date;
}

/**
 * A date as typed into a details field, as YYYY-MM-DD: typed so already, or as it is written on paper
 * ("2.10.2026", "2. Oktober 2026"). '' for none typed; null when it isn't a date.
 */
export function typedDate(typed: string): string | null {
  const s = typed.trim();
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return findDate(s) || null;
}

/** A path part that is safe on every system Syncthing may sync to (no name ends in a dot or space, even cut short). */
const safe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .replace(/[. ]+$/, '');

/**
 * What a filed document is called, from the template: the file name (with ".pdf"), alone in a list. Missing details are
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
  // A missing value goes with what joined it to the rest: "{date}_{type}_{title}" → "2026-10-02_Rechnung",
  // "{title} - {sender}" → "Rechnung", "A - {type} - B" → "A - B".
  const GAP = '\u0000';
  const render = (part: string) =>
    safe(
      part
        .replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key as keyof typeof values] || GAP : all))
        .replace(/(\s*[-–·_]\s*)?\u0000(\s*[-–·_]\s*)?/g, (_all, before?: string, after?: string) => (before && after ? before : ' ')),
    );
  // When the name comes out empty, the title is.
  const name = render(flatTemplate(template)) || safe(fallback.title) || 'Document';
  return [`${name.replace(/\.pdf$/i, '')}.pdf`];
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
    return { template: flatTemplate(str(raw?.template)), rules };
  } catch {
    return DEFAULT_RULES;
  }
}

/** Two devices' rules (a sync conflict): `kept`'s template and rules, then the rules only `copy` has. */
export const mergeRules = (kept: Rules, copy: Rules): Rules => ({ ...kept, rules: [...kept.rules, ...copy.rules.filter((r) => !kept.rules.some((k) => k.id === r.id))] });

export const serializeRules = (r: Rules) => `${JSON.stringify({ version: 1, ...r }, null, 2)}\n`;
