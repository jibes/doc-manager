import { create } from 'zustand';

import { lang } from '@/core/i18n';
import { folders } from '@/core/lib/folders';
import { usePrefs } from '@/paper/state/prefs';
import { defaultKinds, parseKinds, serializeKinds, type Kinds } from './kindList';
import { readSettings } from './settingsFile';

/** Where the types and tags are kept in the archive folder: synced with the documents, so every device has them. */
const PATH = ['.tessel', 'kinds.json'];

const local = () => usePrefs.getState().kinds ?? defaultKinds(lang);

export const useKinds = create<{ kinds: Kinds; loaded: boolean }>(() => ({ kinds: local(), loaded: false }));

/** As stored; the defaults where nothing is; throws when the file is there but can't be read (see readSettings). */
async function read(archive: string): Promise<Kinds> {
  const text = await readSettings(archive, PATH);
  return text ? parseKinds(text, lang) : defaultKinds(lang);
}

/** The lists as stored now (another device may have changed them); those shown stay when it can't be read now. */
export async function loadKinds(): Promise<Kinds> {
  const { archive } = usePrefs.getState();
  const kinds = archive ? await read(archive).catch(() => null) : local();
  if (kinds) useKinds.setState({ kinds, loaded: true });
  return useKinds.getState().kinds;
}

/** The lists, read once (for the model's requests). */
export const currentKinds = () => (useKinds.getState().loaded ? Promise.resolve(useKinds.getState().kinds) : loadKinds());

export async function saveKinds(kinds: Kinds): Promise<void> {
  const { archive, set } = usePrefs.getState();
  if (archive) {
    await folders.unlock(archive).catch(() => false);
    await folders.writeText(archive, PATH, serializeKinds(kinds));
  } else set({ kinds });
  useKinds.setState({ kinds: parseKinds(serializeKinds(kinds), lang), loaded: true });
}

/** A new archive folder: lists changed on this device so far go there, unless it has its own. */
export async function moveKindsTo(archive: string): Promise<void> {
  const { kinds, set } = usePrefs.getState();
  if (kinds && (await readSettings(archive, PATH).catch(() => '')) === null) await folders.writeText(archive, PATH, serializeKinds(kinds));
  if (kinds) set({ kinds: null });
}
