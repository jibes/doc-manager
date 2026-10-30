import { t } from '@/core/i18n';
import { folders } from '@/core/lib/folders';
import { parseConflict } from './sync';

/**
 * The text of a settings file in the archive (`.tessel/…`): null when there is none. When it is there but can't
 * be read (no access yet after a browser restart, half synced, broken JSON) this throws instead: what is changed
 * and written back must start from what other devices wrote, not from nothing.
 */
export async function readSettings(root: string, path: string[]): Promise<string | null> {
  let text: string | null;
  try {
    text = await folders.readText(root, path);
  } catch {
    throw new Error(t.settingsUnreadable);
  }
  if (text === null) return null;
  try {
    JSON.parse(text);
  } catch {
    throw new Error(t.settingsUnreadable);
  }
  return text;
}

/**
 * Like readSettings, with the conflict copies Syncthing made of the file (two devices changed it before they
 * synced) taken in: `merge(kept, copy)` adds what only the copy has (the file itself is the newer one and wins
 * where both have something). The result is written back and the copies removed, so it happens once; where it
 * can't be written now, the merged text is still what is read.
 */
export async function readSettingsMerged<T>(root: string, path: string[], parse: (text: string) => T, merge: (kept: T, copy: T) => T, serialize: (value: T) => string): Promise<string | null> {
  const text = await readSettings(root, path);
  const dir = path.slice(0, -1);
  const copies = (await folders.listNames(root, dir).catch(() => [] as string[])).filter((n) => parseConflict(n)?.original === path.at(-1)).sort();
  if (!copies.length) return text;
  let merged = text === null ? null : parse(text);
  const taken: string[] = [];
  for (const name of copies) {
    const copy = await readSettings(root, [...dir, name]).catch(() => null);
    if (copy === null) continue;
    merged = merged === null ? parse(copy) : merge(merged, parse(copy));
    taken.push(name);
  }
  if (merged === null) return text;
  const out = serialize(merged);
  try {
    await folders.writeText(root, path, out);
    for (const name of taken) await folders.removeText(root, [...dir, name]);
  } catch {
    // Not writable now (no access yet): merged again next time.
  }
  return out;
}
