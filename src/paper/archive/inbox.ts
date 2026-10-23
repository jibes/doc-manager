import { create } from 'zustand';

import { engine } from '@/core/engine';
import { folders } from '@/core/lib/folders';
import { startsWith } from '@/core/lib/bytes';
import type { FolderEntry } from '@/core/lib/folderTypes';
import type { PageWords } from '@/core/engine/types';
import { describeWithAi, type AiSettings } from '@/paper/scan/ai';
import { usePrefs } from '@/paper/state/prefs';
import { localDate } from './facets';
import { allDocs, contentHash, schedule } from './indexer';
import { readSettings } from './settingsFile';
import { docKey } from './docKey';
import type { IndexedDoc } from './search';
import { infoFor, parseTags, readTrailer, real, realTitle, withInfo, type Details } from './pdfInfo';
import { makeSearchable, pagesWithoutText, readPages, textOf } from './searchable';
import { childDir, ensureDir, inboxDir, INBOX } from './dirs';
import { applyRules, DEFAULT_RULES, findDate, parseRules, pathFor, serializeRules, type Rules } from './rules';

/**
 * The inbox: `Inbox/` in the archive folder, where new documents land (scans, downloads, other devices). One
 * device sorts it: each document gets its details (its own, a date found in it, the rules, optionally AI),
 * is written with them, and is moved to where the name template puts it.
 */

export { INBOX } from './dirs';
const RULES_PATH = ['.tessel', 'rules.json'];
/** Text read for rules and dates: the first pages say what a document is. */
const TEXT_PAGES = 3;

/* ------------------------------------------------------------- folders ---- */

export { ensureDir, inboxDir } from './dirs';

export async function inboxFiles(archive: string): Promise<{ dir: string | undefined; files: FolderEntry[] }> {
  const dir = await inboxDir(archive);
  const files = (await folders.list(archive, dir)).filter((e) => e.kind === 'pdf' && !e.name.startsWith('.'));
  return { dir, files: files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)) };
}

/** How many documents wait in the inbox (for the badge on Documents). */
export const useInboxCount = create<{ count: number }>(() => ({ count: 0 }));

/** Counts the inbox again (this device sorts it): on start, when the app comes back, after filing. */
export async function refreshInboxCount(): Promise<void> {
  const { archive, inboxHere } = usePrefs.getState();
  if (!archive || !inboxHere) return useInboxCount.setState({ count: 0 });
  // Found as filing finds it ("inbox" counts too); not made just to be counted.
  const dir = await childDir(archive, undefined, INBOX).catch(() => null);
  const files = dir === null ? [] : await folders.list(archive, dir).catch(() => []);
  useInboxCount.setState({ count: files.filter((e) => e.kind === 'pdf' && !e.name.startsWith('.')).length });
}

/* --------------------------------------------------------------- rules ---- */

export const useRules = create<Rules>(() => DEFAULT_RULES);
/** The rules file is there but can't be read now (no access yet, or broken): nothing is filed until it can be. */
export const useRulesUnreadable = create<{ unreadable: boolean }>(() => ({ unreadable: false }));

/** The rules as stored; those last read when the file can't be read now (no access yet), so nothing is lost. */
export async function loadRules(archive: string): Promise<Rules> {
  const text = await readSettings(archive, RULES_PATH).catch(() => undefined);
  useRulesUnreadable.setState({ unreadable: text === undefined });
  if (text === undefined) return useRules.getState();
  const rules = text ? parseRules(text) : DEFAULT_RULES;
  useRules.setState(rules, true);
  return rules;
}

/**
 * Reads, changes and writes back at once, so a rule another device added meanwhile is kept. A file that is
 * there but can't be read stops it (writing would replace every device's rules with these few).
 */
export async function changeRules(archive: string, edit: (r: Rules) => Rules): Promise<void> {
  await folders.unlock(archive).catch(() => false);
  const text = await readSettings(archive, RULES_PATH);
  const next = edit(text ? parseRules(text) : DEFAULT_RULES);
  await folders.writeText(archive, RULES_PATH, serializeRules(next));
  useRules.setState(next, true);
}

/* ------------------------------------------------------------- sorting ---- */

/**
 * A document in the inbox, read: its text, the details it has (with a date found in it), and those proposed.
 * `read`: an image-only document's first page as recognised on the device (it gets a text layer when filed).
 */
export type Proposal = { entry: FolderEntry; text: string; own: Details; details: Details; read?: PageWords[]; duplicateOf?: IndexedDoc };

/** The proposal again with (changed) rules. */
export const withRules = (p: Proposal, rules: Rules): Proposal => ({ ...p, details: applyRules(`${p.text}\n${p.entry.name}`, p.own, rules.rules) });

const stem = (name: string) => name.replace(/\.pdf$/i, '');


export async function propose(archive: string, entry: FolderEntry, rules: Rules): Promise<Proposal> {
  const bytes = await (await folders.read(archive, entry)).arrayBuffer();
  // The same document already filed (outside the inbox): the same bytes, or the same document with the details
  // filing added to it (its key stays through them). Looked at, not taken from the index: that may still list a
  // file that has moved (into the inbox, say), and a later revision of it (signed) is not filed yet.
  const [hash, share] = await Promise.all([contentHash(bytes), docKey(bytes)]);
  const candidates = (await allDocs()).filter(
    (d) => (d.hash === hash || d.share === share) && d.place.kind === 'folder' && d.place.root === archive && !d.place.inbox && d.key !== `${archive}:${entry.id}`,
  );
  let duplicateOf: IndexedDoc | undefined;
  for (const d of candidates) {
    if (d.place.kind !== 'folder') continue;
    const filed = await folders
      .read(d.place.root, d.place.entry)
      .then((b) => b.arrayBuffer())
      .catch(() => null);
    if (filed && startsWith(filed, bytes)) {
      duplicateOf = d;
      break;
    }
  }
  const handle = await engine.open({ kind: 'bytes', bytes });
  try {
    const m = handle.metadata;
    const pages: string[] = [];
    for (let p = 0; p < Math.min(handle.pageCount, TEXT_PAGES); p++) {
      const runs = await handle.pageText(p).catch(() => []);
      pages.push(runs.map((r) => r.text + (r.eol ? '\n' : ' ')).join(''));
    }
    let text = pages.join('\n');
    // No text of its own: its first page is read on the device, for the rules and the date.
    let read: PageWords[] | undefined;
    if ((await pagesWithoutText(handle, 1)).length) {
      read = await readPages(handle, [0]).catch(() => []);
      text = textOf(read);
    }
    const own: Details = {
      title: realTitle(m.title) || stem(entry.name),
      sender: real(m.author),
      type: real(m.subject),
      tags: parseTags(m.keywords),
      date: m.date || findDate(text),
    };
    return withRules({ entry, text, own, details: own, read, duplicateOf }, rules);
  } finally {
    handle.close();
  }
}

/** Details from the AI model set up in Settings, filling in only what the document doesn't have yet. */
export async function suggest(p: Proposal, ai: AiSettings, signal?: AbortSignal): Promise<Details> {
  const d = await describeWithAi(ai, `${p.entry.name}\n\n${p.text}`, signal);
  const titled = p.details.title && p.details.title !== stem(p.entry.name);
  return {
    title: titled ? p.details.title : d.title || p.details.title,
    sender: p.details.sender || d.sender,
    type: p.details.type || d.type,
    date: p.details.date || d.date,
    tags: p.details.tags.length ? p.details.tags : d.keywords,
  };
}

/** Where a document would be filed, as folders and a file name. */
export function destination(details: Details, entry: FolderEntry, rules: Rules, unknownSender: string): string[] {
  const fileDate = localDate(entry.modified || Date.now());
  return pathFor(rules.template, details, { title: stem(entry.name), date: fileDate, sender: unknownSender });
}

/**
 * Files a document: its details written into it (left as they are in a protected PDF), saved where the
 * template says (a free name if one is taken), then removed from the inbox. Returns the filed file.
 * `follow`: documents in the library that are the inbox file (a scan saved there) become the filed one.
 */
export async function fileDocument(
  archive: string,
  inbox: string | undefined,
  p: Proposal,
  details: Details,
  path: string[],
  onProgress?: (done: number, total: number) => void,
  follow?: (from: FolderEntry, to: FolderEntry) => Promise<void>,
): Promise<FolderEntry> {
  let bytes = new Uint8Array(await (await folders.read(archive, p.entry)).arrayBuffer());
  if (!readTrailer(bytes).encrypted) {
    const handle = await engine.open({ kind: 'bytes', bytes: bytes.slice().buffer });
    try {
      // Pages without text get it (read on the device), so the filed document can be searched.
      // Not a signed one's (its signature would show the pages as changed).
      const searchable = handle.signed ? 'signed' : await makeSearchable(handle, onProgress, undefined, p.read);
      if (typeof searchable !== 'string') bytes = new Uint8Array(searchable);
      bytes = withInfo(bytes, infoFor(details, handle.metadata.other));
    } finally {
      handle.close();
    }
  }
  const out: Uint8Array<ArrayBuffer> = bytes;
  const dir = await ensureDir(archive, path.slice(0, -1));
  const filed = await folders.create({ root: archive, dir }, path[path.length - 1], new Blob([out], { type: 'application/pdf' }));
  await follow?.(p.entry, filed).catch(() => {});
  // Only once the copy is safely written.
  await folders.delete(archive, inbox, [p.entry]);
  schedule(1000);
  return filed;
}

/** Whether this device sorts the inbox (one device does, so two never file the same document). */
export const sortsInbox = () => {
  const { archive, inboxHere } = usePrefs.getState();
  return !!archive && inboxHere;
};
