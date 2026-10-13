import { create } from 'zustand';

import { engine } from '@/engine';
import { folders } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import type { PageWords } from '@/engine/types';
import { describeWithAi, type AiSettings } from '@/scan/ai';
import { usePrefs } from '@/state/prefs';
import { schedule } from './indexer';
import { infoFor, parseTags, readTrailer, real, withInfo, type Details } from './pdfInfo';
import { makeSearchable, pagesWithoutText, readPages, textOf } from './searchable';
import { applyRules, DEFAULT_RULES, findDate, parseRules, pathFor, serializeRules, type Rules } from './rules';

/**
 * The inbox: `Inbox/` in the archive folder, where new documents land (scans, downloads, other devices). One
 * device sorts it: each document gets its details (its own, a date found in it, the rules, optionally AI),
 * is written with them, and is moved to where the name template puts it.
 */

export const INBOX = 'Inbox';
const RULES_PATH = ['.tessel', 'rules.json'];
/** Text read for rules and dates: the first pages say what a document is. */
const TEXT_PAGES = 3;

/* ------------------------------------------------------------- folders ---- */

/** The ID of the folder `name` in `dir` (the root when undefined), or null. */
async function childDir(root: string, dir: string | undefined, name: string): Promise<string | null> {
  const found = (await folders.list(root, dir)).find((e) => e.kind === 'dir' && e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  return found ? found.id : null;
}

/** The folder at `names` below the root, made where missing; its ID (undefined: the root itself). */
export async function ensureDir(root: string, names: string[]): Promise<string | undefined> {
  let dir: string | undefined;
  for (const name of names) {
    let id = await childDir(root, dir, name);
    if (!id) {
      await folders.mkdir(root, dir, name);
      id = await childDir(root, dir, name);
      if (!id) throw new Error(`Can't make the folder ${name}`);
    }
    dir = id;
  }
  return dir;
}

/** The inbox folder of the archive, made when missing. */
export const inboxDir = (archive: string) => ensureDir(archive, [INBOX]);

export async function inboxFiles(archive: string): Promise<{ dir: string | undefined; files: FolderEntry[] }> {
  const dir = await inboxDir(archive);
  const files = (await folders.list(archive, dir)).filter((e) => e.kind === 'pdf' && !e.name.startsWith('.'));
  return { dir, files: files.sort((a, b) => a.modified - b.modified || a.name.localeCompare(b.name)) };
}

/* --------------------------------------------------------------- rules ---- */

export const useRules = create<Rules>(() => DEFAULT_RULES);

export async function loadRules(archive: string): Promise<Rules> {
  const text = await folders.readText(archive, RULES_PATH).catch(() => null);
  const rules = text ? parseRules(text) : DEFAULT_RULES;
  useRules.setState(rules, true);
  return rules;
}

/** Reads, changes and writes back at once, so a rule another device added meanwhile is kept. */
export async function changeRules(archive: string, edit: (r: Rules) => Rules): Promise<void> {
  const next = edit(await loadRules(archive));
  await folders.writeText(archive, RULES_PATH, serializeRules(next));
  useRules.setState(next, true);
}

/* ------------------------------------------------------------- sorting ---- */

/**
 * A document in the inbox, read: its text, the details it has (with a date found in it), and those proposed.
 * `read`: an image-only document's first page as recognised on the device (it gets a text layer when filed).
 */
export type Proposal = { entry: FolderEntry; text: string; own: Details; details: Details; read?: PageWords[] };

/** The proposal again with (changed) rules. */
export const withRules = (p: Proposal, rules: Rules): Proposal => ({ ...p, details: applyRules(`${p.text}\n${p.entry.name}`, p.own, rules.rules) });

const stem = (name: string) => name.replace(/\.pdf$/i, '');


export async function propose(archive: string, entry: FolderEntry, rules: Rules): Promise<Proposal> {
  const bytes = await (await folders.read(archive, entry)).arrayBuffer();
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
      title: real(m.title) || stem(entry.name),
      sender: real(m.author),
      type: real(m.subject),
      tags: parseTags(m.keywords),
      date: m.date || findDate(text),
    };
    return withRules({ entry, text, own, details: own, read }, rules);
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
  const fileDate = new Date(entry.modified || Date.now()).toISOString().slice(0, 10);
  return pathFor(rules.template, details, { title: stem(entry.name), date: fileDate, sender: unknownSender });
}

/**
 * Files a document: its details written into it (left as they are in a protected PDF), saved where the
 * template says (a free name if one is taken), then removed from the inbox. Returns the filed file.
 */
export async function fileDocument(
  archive: string,
  inbox: string | undefined,
  p: Proposal,
  details: Details,
  path: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<FolderEntry> {
  let bytes = new Uint8Array(await (await folders.read(archive, p.entry)).arrayBuffer());
  if (!readTrailer(bytes).encrypted) {
    const handle = await engine.open({ kind: 'bytes', bytes: bytes.slice().buffer });
    try {
      // Pages without text get it (read on the device), so the filed document can be searched.
      const searchable = await makeSearchable(handle, onProgress, undefined, p.read);
      if (typeof searchable !== 'string') bytes = new Uint8Array(searchable);
      bytes = withInfo(bytes, infoFor(details, handle.metadata.other));
    } finally {
      handle.close();
    }
  }
  const out: Uint8Array<ArrayBuffer> = bytes;
  const dir = await ensureDir(archive, path.slice(0, -1));
  const filed = await folders.create({ root: archive, dir }, path[path.length - 1], new Blob([out], { type: 'application/pdf' }));
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
