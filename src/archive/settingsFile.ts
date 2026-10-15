import { t } from '@/i18n';
import { folders } from '@/lib/folders';

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
