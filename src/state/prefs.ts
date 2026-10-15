import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import type { SavedView } from '@/archive/facets';
import { palettes, type Palette } from '@/design/tokens';
import { DEFAULT_AI, type AiSettings } from '@/scan/ai';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@/scan/types';
import { loadPrefs, savePrefs } from '@/storage/prefs';
import { useAmbient } from './ambient';

/** `scanTo` for the archive's Inbox folder. */
export const INBOX_TARGET = 'inbox';

export type Appearance = 'light' | 'dark' | 'auto';
export type FitMode = 'width' | 'page';
export type TextFont = 'serif' | 'sans';
export type TextLeading = 'compact' | 'normal' | 'relaxed';
export type TextWidth = 'narrow' | 'medium' | 'wide';

type Prefs = {
  /** Auto: the system's dark mode, and in its light mode the light sensor where there is one (Android app). */
  appearance: Appearance;
  fit: FitMode;
  /** Text view typography. */
  textFont: TextFont;
  textScale: number;
  textLeading: TextLeading;
  textWidth: TextWidth;
  /** Android app: browse the whole device (needs all files access). */
  allFiles: boolean;
  /** Scanner: filter, auto-capture, resolution, text recognition. */
  scan: ScanSettings;
  /** Where scans are saved: a folder's id, the archive's inbox (INBOX_TARGET), or null for the library. */
  scanTo: string | null;
  /** Reading scans with an AI model at an address the user gives (off until set up). */
  ai: AiSettings;
  /** The folder documents are kept in (synced to the other devices): saved views live in its .tessel folder. */
  archive: string | null;
  /** Saved views while there is no archive folder (this device only). */
  views: SavedView[];
  /** This device sorts the archive's inbox (one device should, so two never file the same document). */
  inboxHere: boolean;
  /** Share the reading list, positions and bookmarks with the other devices through the archive. */
  shareReading: boolean;
  /** This device's name for that ("<random>.json" in .tessel/state). */
  deviceId: string;
  /** Documents (by share key) removed from this library while on the reading list, and when: not yet shared. */
  unshared: { key: string; at: number }[];
  /** The place last used: the app opens there. */
  lastTab: 'reading' | 'documents';
  /** How every list of documents shows them: small pictures beside the text, or big ones above it. */
  layout: 'list' | 'grid';
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { appearance: 'auto', fit: 'width', textFont: 'serif', textScale: 1, textLeading: 'normal', textWidth: 'medium', allFiles: false, scan: DEFAULT_SCAN_SETTINGS, scanTo: null, ai: DEFAULT_AI, archive: null, views: [], inboxHere: false, shareReading: true, deviceId: '', unshared: [], lastTab: 'reading', layout: 'list' };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  // Settings added in later versions get their defaults.
  scan: { ...DEFAULT_SCAN_SETTINGS, ...loadPrefs<Prefs>()?.scan },
  ai: { ...DEFAULT_AI, ...loadPrefs<Prefs>()?.ai },
  appearance: loadPrefs<Prefs>().appearance ?? appearanceFrom(loadPrefs<{ theme?: string | null }>().theme),
  set(patch) {
    set(patch);
    const { appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo, ai, archive, views, inboxHere, shareReading, deviceId, unshared, lastTab, layout } = get();
    savePrefs<Prefs>({ appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo, ai, archive, views, inboxHere, shareReading, deviceId, unshared, lastTab, layout });
  },
}));

/** The appearance chosen before 1.4 (six themes) as one of Light, Dark and Auto. */
export function appearanceFrom(theme: string | null | undefined): Appearance {
  if (theme === 'paper' || theme === 'sepia') return 'light';
  if (theme === 'dusk' || theme === 'night') return 'dark';
  return 'auto';
}

export function usePalette(): Palette {
  const appearance = usePrefs((s) => s.appearance);
  const sensed = useAmbient((s) => s.theme);
  const scheme = useColorScheme();
  // The system's dark mode always wins; in its light mode the sensor (where there is one) turns Dark in a dim room.
  const auto = scheme === 'dark' ? 'dark' : (sensed ?? 'light');
  return palettes[appearance === 'auto' ? auto : appearance];
}
