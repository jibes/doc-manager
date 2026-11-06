import { create } from 'zustand';

import { lang, t } from '@/core/i18n';
import { folders } from '@/core/lib/folders';
import { usePrefs } from '@/paper/state/prefs';
import { defaultKinds, mergeKinds, parseKinds, serializeKinds, type Kinds } from './kindList';
import { readSettings, readSettingsMerged } from './settingsFile';

/** Where the types and tags are kept in the archive folder: synced with the documents, so every device has them. */
const PATH = ['.tessel', 'kinds.json'];

const local = () => usePrefs.getState().kinds ?? defaultKinds(lang);

/** `loaded`: the archive's file was read (or there is no archive); `unreadable`: it is there but can't be read now. */
export const useKinds = create<{ kinds: Kinds; loaded: boolean; unreadable: boolean }>(() => ({ kinds: local(), loaded: false, unreadable: false }));

/** As stored; the defaults where nothing is; throws when the file is there but can't be read (see readSettings). */
async function read(archive: string): Promise<Kinds> {
  const text = await readSettingsMerged(archive, PATH, (t) => parseKinds(t, lang), mergeKinds, serializeKinds);
  return text ? parseKinds(text, lang) : defaultKinds(lang);
}

/** The lists as stored now (another device may have changed them); those shown stay when it can't be read now. */
export async function loadKinds(): Promise<Kinds> {
  const { archive } = usePrefs.getState();
  const kinds = archive ? await read(archive).catch(() => null) : local();
  // Not readable now (no access yet after a browser restart): the lists shown are not the archive's, and must
  // not be saved over it (kinds.tsx waits for `loaded`).
  useKinds.setState(kinds ? { kinds, loaded: true, unreadable: false } : { unreadable: true });
  return useKinds.getState().kinds;
}

/** The lists, read once (for the model's requests). */
export const currentKinds = () => (useKinds.getState().loaded ? Promise.resolve(useKinds.getState().kinds) : loadKinds());

export async function saveKinds(kinds: Kinds): Promise<void> {
  const { archive, set } = usePrefs.getState();
  if (archive) {
    await folders.unlock(archive).catch(() => false);
    // The lists edited must be the archive's own (read once access was there), never this device's defaults.
    if (!useKinds.getState().loaded && !(await loadKinds().then(() => useKinds.getState().loaded))) throw new Error(t.settingsUnreadable);
    await folders.writeText(archive, PATH, serializeKinds(kinds));
  } else set({ kinds });
  useKinds.setState({ kinds: parseKinds(serializeKinds(kinds), lang), loaded: true, unreadable: false });
}

/** A new archive folder: lists changed on this device so far go there, unless it has its own. */
export async function moveKindsTo(archive: string): Promise<void> {
  const { kinds, set } = usePrefs.getState();
  if (!kinds) return;
  // Not readable now: the device's lists stay until the next time (not dropped for a file that may be theirs).
  const stored = await readSettings(archive, PATH);
  if (stored === null) await folders.writeText(archive, PATH, serializeKinds(kinds));
  set({ kinds: null });
}
