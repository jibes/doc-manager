import { getLocales } from 'expo-localization';
import { Platform } from 'react-native';

import { de } from './de';
import { en, type Strings } from './en';

const catalogs = { en, de } satisfies Record<string, Strings>;
export type Lang = keyof typeof catalogs;

/** First OS/browser language we have a catalogue for; English otherwise. Read once at startup. */
function detect(): Lang {
  try {
    for (const l of getLocales()) {
      const code = l.languageCode?.toLowerCase();
      if (code && code in catalogs) return code as Lang;
    }
  } catch {
    // Locale APIs unavailable: fall through.
  }
  return 'en';
}

export const lang: Lang = detect();
export const t: Strings = catalogs[lang];

if (Platform.OS === 'web' && typeof document !== 'undefined') document.documentElement.lang = lang;

/** Engine/storage errors are English plumbing; show the reader a localized sentence. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === t.passwordCancelled) return m;
  if (/password/i.test(m)) return t.passwordProtected;
  if (/missing from storage/i.test(m)) return t.fileMissing;
  if (/^epub:/.test(m)) return t.bookFailed;
  return t.openFailed;
}

/** What went wrong with a file operation (rename, move, save, keep), in the user's language where we know it. */
export function opError(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const taken = /^exists:(.*)$/.exec(m);
  if (taken) return `${t.opFailed} ${t.nameTaken(taken[1])}`;
  if (m === 'denied' || m === t.writeDenied) return `${t.opFailed} ${t.writeDenied}`;
  return m === t.fileGone ? `${t.opFailed} ${m}` : t.opFailed;
}
