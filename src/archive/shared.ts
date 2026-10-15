import type { DocRecord, ReadingPosition } from '@/storage/types';

/**
 * Reading shared between devices: each device writes what it knows (reading list, positions, bookmarks) to its
 * own file in the archive, `.tessel/state/<device>.json`, so two devices never write the same file; every device
 * reads them all and takes, for each document and each of these, the newest.
 */

/** A value and when it was set. */
export type Stamped<T> = { v: T; at: number };
export type Reading = DocRecord['reading'] | null;
export type SharedDoc = { title: string; position?: Stamped<ReadingPosition>; reading?: Stamped<Reading>; bookmarks?: Stamped<number[]> };
export type DeviceState = { device: string; docs: Record<string, SharedDoc> };
export const FIELDS = ['position', 'reading', 'bookmarks'] as const;
type Field = (typeof FIELDS)[number];

/** The same document on every device: its bytes up to the end of the first "%%EOF" (what later edits append to keep), at most 64 KiB. */
export async function docKey(bytes: ArrayBuffer): Promise<string> {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65536));
  let end = head.length;
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x25 && head[i + 2] === 0x45 && head[i + 3] === 0x4f && head[i + 4] === 0x46) {
      end = i + 5;
      break;
    }
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', head.slice(0, end)));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

const value = (d: DocRecord, f: Field): unknown => (f === 'reading' ? (d.reading ?? null) : f === 'position' ? d.position : d.bookmarks);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const isDefault = (f: Field, v: unknown) =>
  v == null || (f === 'bookmarks' && (v as number[]).length === 0) || (f === 'position' && (v as ReadingPosition).page === 0 && !(v as ReadingPosition).offset);

/** When this device last did something to a document, for values first shared (so an old state doesn't win over news). */
function since(d: DocRecord, f: Field): number {
  if (f === 'reading') return Math.max(d.reading?.since ?? 0, d.reading?.finishedAt ?? 0, d.addedAt);
  return d.openedAt ?? d.addedAt;
}

/**
 * This device's state brought up to date with its library: a value that changed since is stamped `now`. One
 * document may be in the library more than once (the same file in two places): of its records, the one that
 * changed most recently tells.
 */
export function record(own: Record<string, SharedDoc>, docs: { key: string; doc: DocRecord }[], now: number): Record<string, SharedDoc> {
  const out: Record<string, SharedDoc> = { ...own };
  const byKey = new Map<string, DocRecord[]>();
  for (const { key, doc } of docs) byKey.set(key, [...(byKey.get(key) ?? []), doc]);
  for (const [key, list] of byKey) {
    const prev = own[key];
    const newest = (f: Field) => [...list].sort((a, b) => since(b, f) - since(a, f));
    const next: SharedDoc = { ...prev, title: newest('position')[0].title };
    for (const f of FIELDS) {
      const known = prev?.[f];
      const doc = newest(f).find((d) => {
        const v = value(d, f);
        // A default (not on the list, no bookmarks, at the start) is no news until it replaces something.
        return known ? !same(known.v, v) : !isDefault(f, v);
      });
      if (doc) (next as Record<Field, Stamped<unknown>>)[f] = { v: value(doc, f), at: known ? now : since(doc, f) };
    }
    out[key] = next;
  }
  return out;
}

/** The newest of each value for each document, over all devices' states. */
export function merge(states: DeviceState[]): Record<string, SharedDoc> {
  const out: Record<string, SharedDoc> = {};
  for (const s of states) {
    for (const [key, doc] of Object.entries(s.docs)) {
      const cur = (out[key] ??= { title: doc.title });
      for (const f of FIELDS) {
        const v = doc[f];
        if (v && (!cur[f] || v.at > cur[f]!.at)) {
          (cur as Record<Field, Stamped<unknown>>)[f] = v;
          cur.title = doc.title || cur.title;
        }
      }
    }
  }
  return out;
}

/** What to change in a document of this library to match the merged state (null: nothing). */
export function changesFor(doc: DocRecord, shared: SharedDoc): Partial<Pick<DocRecord, 'position' | 'reading' | 'bookmarks'>> | null {
  const out: Partial<Pick<DocRecord, 'position' | 'reading' | 'bookmarks'>> = {};
  if (shared.position && !same(shared.position.v, doc.position)) out.position = shared.position.v;
  if (shared.reading && !same(shared.reading.v, doc.reading ?? null)) out.reading = shared.reading.v ?? undefined;
  if (shared.bookmarks && !same(shared.bookmarks.v, doc.bookmarks)) out.bookmarks = shared.bookmarks.v;
  return Object.keys(out).length ? out : null;
}

export function parseState(json: string, device: string): DeviceState | null {
  try {
    const raw = JSON.parse(json) as { docs?: unknown };
    if (!raw || typeof raw.docs !== 'object' || !raw.docs) return null;
    const docs: Record<string, SharedDoc> = {};
    for (const [key, d] of Object.entries(raw.docs as Record<string, SharedDoc>)) {
      if (!d || typeof d !== 'object') continue;
      const ok = (s: unknown): s is Stamped<unknown> => !!s && typeof s === 'object' && typeof (s as Stamped<unknown>).at === 'number' && 'v' in (s as object);
      docs[key] = {
        title: typeof d.title === 'string' ? d.title : '',
        ...(ok(d.position) && typeof (d.position.v as ReadingPosition)?.page === 'number' ? { position: d.position } : {}),
        ...(ok(d.reading) ? { reading: d.reading } : {}),
        ...(ok(d.bookmarks) && Array.isArray(d.bookmarks.v) ? { bookmarks: { v: d.bookmarks.v.filter((n) => Number.isInteger(n)), at: d.bookmarks.at } } : {}),
      };
    }
    return { device, docs };
  } catch {
    return null;
  }
}

export const serializeState = (s: DeviceState) => `${JSON.stringify({ version: 1, device: s.device, docs: s.docs })}\n`;
