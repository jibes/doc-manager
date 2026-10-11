const KEY = 'quire.prefs';

export function loadPrefs<T>(): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function savePrefs<T>(prefs: T) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: prefs stay in memory.
  }
}
