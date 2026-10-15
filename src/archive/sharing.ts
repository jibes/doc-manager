import { Platform } from 'react-native';
import { create } from 'zustand';

import { folders } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import { usePrefs } from '@/state/prefs';
import { repo } from '@/storage';
import { allDocs } from './indexer';
import { importFromFolder } from './Results';
import { changesFor, docKey, FIELDS, merge, parseState, record, serializeState, type DeviceState, type SharedDoc } from './shared';

/**
 * Keeps the reading list, positions and bookmarks the same on every device that syncs the archive: this
 * device's state goes to `.tessel/state/<device>.json`, the others' are read and the newest of each value is
 * taken (see shared.ts). A document on another device's reading list that is in the archive comes into this
 * library too. Runs a little after start, when the app comes back or goes away, every minute while in use,
 * and soon after a change.
 */

const STATE = ['.tessel', 'state'];
const EVERY_MS = 60_000;
const AFTER_CHANGE_MS = 15_000;

/** How many other devices share their reading here, as of the last pass. */
export const useSharing = create<{ devices: number; at: number }>(() => ({ devices: 0, at: 0 }));

function deviceId(): string {
  const { deviceId: id, set } = usePrefs.getState();
  if (id) return id;
  const made = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  set({ deviceId: made });
  return made;
}

async function readStates(archive: string): Promise<DeviceState[]> {
  const names = (await folders.listNames(archive, STATE).catch(() => [])).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  const states = await Promise.all(
    names.map(async (n) => {
      const text = await folders.readText(archive, [...STATE, n]).catch(() => null);
      return text ? parseState(text, n.slice(0, -'.json'.length)) : null;
    }),
  );
  return states.filter((s): s is DeviceState => !!s);
}

/** Library documents get their share key (once: it reads the file). */
async function withKeys() {
  const lib = useLibrary.getState();
  for (const d of lib.docs) {
    if (d.shareKey) continue;
    const src = await repo.source(d.id).catch(() => null);
    if (src?.kind === 'bytes') lib.patchDoc(d.id, { shareKey: await docKey(src.bytes) });
  }
  return useLibrary
    .getState()
    .docs.filter((d) => d.shareKey)
    .map((doc) => ({ key: doc.shareKey!, doc }));
}

async function pass(): Promise<void> {
  const { archive, shareReading, unshared } = usePrefs.getState();
  if (!archive || !shareReading || Platform.OS !== 'web') return;
  const device = deviceId();
  const docs = await withKeys();
  const states = await readStates(archive);
  const before = states.find((s) => s.device === device)?.docs ?? {};
  // What changed here since the last pass, stamped; then the newest over all devices.
  const own: Record<string, SharedDoc> = record(before, docs, Date.now());
  // Removed from this library while on the reading list (and not back since): off the list everywhere.
  for (const u of unshared) if (!docs.some((d) => d.key === u.key)) own[u.key] = { ...own[u.key], title: own[u.key]?.title ?? '', reading: { v: null, at: u.at } };
  const others = states.filter((s) => s.device !== device);
  const merged = merge([...others, { device, docs: own }]);
  const { patchDoc } = useLibrary.getState();

  for (const { key, doc } of docs) {
    const m = merged[key];
    const changes = m && changesFor(doc, m);
    if (!changes) continue;
    patchDoc(doc.id, changes);
    // Adopted as they were stamped, so the next pass doesn't take them for news from here.
    own[key] = { ...own[key], ...Object.fromEntries(FIELDS.filter((f) => f in changes && m[f]).map((f) => [f, m[f]])) };
  }

  // On another device's reading list and in the archive, but not in this library yet: brought in.
  const known = new Set(docs.map((d) => d.key));
  const wanted = Object.entries(merged).filter(([key, m]) => !known.has(key) && m.reading?.v && !m.reading.v.finishedAt);
  if (wanted.length) {
    const indexed = await allDocs();
    for (const [key, m] of wanted) {
      const found = indexed.find((d) => d.share === key && d.place.kind === 'folder');
      if (!found || found.place.kind !== 'folder') continue;
      const added = await importFromFolder(found.place).catch(() => undefined);
      if (!added) continue;
      patchDoc(added.id, { shareKey: key, ...changesFor(added, m) });
      own[key] = { ...m };
    }
  }

  useSharing.setState({ devices: others.length, at: Date.now() });
  if (serializeState({ device, docs: own }) !== serializeState({ device, docs: before })) {
    await folders.writeText(archive, [...STATE, `${device}.json`], serializeState({ device, docs: own }));
  }
  // Shared now: forgotten (those removed during this pass stay for the next).
  if (unshared.length) {
    const now = usePrefs.getState();
    now.set({ unshared: now.unshared.filter((u) => !unshared.includes(u)) });
  }
}

let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** A pass now (or right after the one running). */
export function shareNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = pass()
    .catch(() => {})
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void shareNow();
      }
    });
  return running;
}

let due = 0;
/** A pass in `ms`, or sooner if one is due sooner (reading changes the library all the time: never postponed). */
const soon = (ms: number) => {
  if (timer && due <= Date.now() + ms) return;
  clearTimeout(timer);
  due = Date.now() + ms;
  timer = setTimeout(() => {
    timer = undefined;
    void shareNow();
  }, ms);
};

export function startSharing() {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  soon(5000);
  setInterval(() => document.visibilityState === 'visible' && void shareNow(), EVERY_MS);
  document.addEventListener('visibilitychange', () => void shareNow());
  useLibrary.subscribe((s, prev) => {
    if (s.docs !== prev.docs) soon(AFTER_CHANGE_MS);
  });
}
