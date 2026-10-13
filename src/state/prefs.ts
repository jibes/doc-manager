import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import { palettes, type Palette } from '@/design/tokens';
import { DEFAULT_AI, type AiSettings } from '@/scan/ai';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@/scan/types';
import { loadPrefs, savePrefs } from '@/storage/prefs';
import { useAmbient } from './ambient';

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
  /** Where scans are saved: a folder's id, or null for the library. */
  scanTo: string | null;
  /** Reading scans with an AI model at an address the user gives (off until set up). */
  ai: AiSettings;
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { appearance: 'auto', fit: 'width', textFont: 'serif', textScale: 1, textLeading: 'normal', textWidth: 'medium', allFiles: false, scan: DEFAULT_SCAN_SETTINGS, scanTo: null, ai: DEFAULT_AI };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  // Settings added in later versions get their defaults.
  scan: { ...DEFAULT_SCAN_SETTINGS, ...loadPrefs<Prefs>()?.scan },
  ai: { ...DEFAULT_AI, ...loadPrefs<Prefs>()?.ai },
  appearance: loadPrefs<Prefs>().appearance ?? appearanceFrom(loadPrefs<{ theme?: string | null }>().theme),
  set(patch) {
    set(patch);
    const { appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo, ai } = get();
    savePrefs<Prefs>({ appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo, ai });
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
