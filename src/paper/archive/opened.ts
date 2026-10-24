import { folders } from '@/core/lib/folders';
import { log } from '@/core/lib/log';
import { readStored, writeStored } from '@/core/lib/stored';
import { onOpened, remember, useCache } from '@/paper/state/cache';
import { usePrefs } from '@/paper/state/prefs';

/**
 * When each document was last opened, shared between devices through the Tessel folder: each device writes only
 * its own file (`.tessel/opened/<device>.json`, document key → time), so Syncthing never has two versions of
 * one; every device reads them all and takes the latest time. Where a document was left stays on each device.
 */

const DIR = ['.tessel', 'opened'];
/** Kept per device: the most recently opened. */
const KEEP = 500;
/** One write for a few documents opened in a row. */
const WRITE_MS = 10_000;

type OpenedFile = { v: 1; opened: Record<string, number> };

let device: string | null = null;
function deviceId(): string {
  if (device) return device;
  device = readStored('tessel-device');
  if (!device) {
    device = Math.random().toString(36).slice(2, 10);
    writeStored('tessel-device', device);
  }
  return device;
}

/** This device's opens, as its file has them (null until read). */
let mine: Map<string, number> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** The archive the times were read from: another one starts again. */
let readFrom: string | null = null;

export function parseOpened(text: string): Map<string, number> {
  try {
    const raw = JSON.parse(text) as Partial<OpenedFile>;
    const opened = raw && typeof raw.opened === 'object' && raw.opened ? raw.opened : {};
    return new Map(Object.entries(opened).filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1])));
  } catch {
    return new Map();
  }
}

/** The latest time for each document over every device's file. */
export function latest(files: Map<string, number>[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of files) for (const [k, at] of f) if (at > (out.get(k) ?? 0)) out.set(k, at);
  return out;
}

/** Brings another's times into `into` where later (another tab of this device writes the same file). */
export function mergeOpened(into: Map<string, number>, from: Map<string, number>): Map<string, number> {
  for (const [k, at] of from) if (at > (into.get(k) ?? 0)) into.set(k, at);
  return into;
}

/** The most recent `KEEP` of them, as written. */
export function serializeOpened(times: Map<string, number>): string {
  const kept = [...times].sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  return `${JSON.stringify({ v: 1, opened: Object.fromEntries(kept) } satisfies OpenedFile, null, 1)}\n`;
}

/**
 * Reads every device's file and brings the latest times into this device's cache (the Documents screen sorts by
 * it). Once per archive, this device's own times so far go into its file too.
 */
export async function syncOpened(): Promise<void> {
  const archive = usePrefs.getState().archive;
  if (!archive || !folders.supported) return;
  const names = (await folders.listNames(archive, DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  const files: Map<string, number>[] = [];
  for (const name of names) {
    const text = await folders.readText(archive, [...DIR, name]).catch(() => null);
    if (text) files.push(parseOpened(text));
  }
  const own = `${deviceId()}.json`;
  if (readFrom !== archive) {
    readFrom = archive;
    const ownFile = names.includes(own) ? await folders.readText(archive, [...DIR, own]).catch(() => null) : null;
    mine = ownFile ? parseOpened(ownFile) : new Map();
    // What this device opened before the times were shared: shared from now on.
    let added = false;
    for (const [key, c] of useCache.getState().docs)
      if (c.openedAt && c.openedAt > (mine.get(key) ?? 0)) {
        mine.set(key, c.openedAt);
        added = true;
      }
    if (added) schedule();
  }
  const cached = useCache.getState().docs;
  let newer = 0;
  for (const [key, at] of latest(files)) {
    if (at > (cached.get(key)?.openedAt ?? 0)) {
      remember(key, { openedAt: at }, false);
      newer++;
    }
  }
  if (newer) log.info('opened', `${newer} opened on other devices, from ${names.length} files`);
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void writeMine(), WRITE_MS);
}

async function writeMine() {
  const archive = usePrefs.getState().archive;
  if (!archive || !mine || readFrom !== archive) return;
  const path = [...DIR, `${deviceId()}.json`];
  // Another tab of this browser writes this file too: what it wrote since is kept.
  const text = await folders.readText(archive, path).catch(() => null);
  if (text) mergeOpened(mine, parseOpened(text));
  await folders.writeText(archive, path, serializeOpened(mine)).catch((e: unknown) => log.warn('opened', 'not written', e));
}

/** Written now (the app going to the background, the window closing). */
export function flushOpened() {
  if (!timer) return;
  clearTimeout(timer);
  timer = undefined;
  void writeMine();
}

// A document opened here (or its key changed with its file): shared with the other devices soon.
onOpened((key, at) => {
  if (!mine) return;
  if (at <= (mine.get(key) ?? 0)) return;
  mine.set(key, at);
  schedule();
});
