import { File, Paths } from 'expo-file-system';

const file = new File(Paths.document, 'prefs.json');

export function loadPrefs<T>(): Partial<T> {
  try {
    return file.exists ? JSON.parse(file.textSync()) : {};
  } catch {
    return {};
  }
}

export function savePrefs<T>(prefs: T) {
  try {
    file.write(JSON.stringify(prefs));
  } catch {
    // Non-fatal: prefs stay in memory.
  }
}
