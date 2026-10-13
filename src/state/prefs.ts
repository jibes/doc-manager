import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import { palettes, type Palette } from '@/design/tokens';
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@/scan/types';
import { loadPrefs, savePrefs } from '@/storage/prefs';
import { useAmbient } from './ambient';

export type Appearance = 'light' | 'dark' | 'auto';
export type FitMode = 'width' | 'page';
export type TextFont = 'serif' | 'sans';
export type TextLeading = 'compact' | 'normal' | 'relaxed';
export type TextWidth = 'narrow' | 'medium' | 'wide';

type Prefs = {
  /** Auto: the light sensor where there is one (Android app), else the system's light or dark mode. */
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
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { appearance: 'auto', fit: 'width', textFont: 'serif', textScale: 1, textLeading: 'normal', textWidth: 'medium', allFiles: false, scan: DEFAULT_SCAN_SETTINGS, scanTo: null };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  // Settings added in later versions get their defaults.
  scan: { ...DEFAULT_SCAN_SETTINGS, ...loadPrefs<Prefs>()?.scan },
  appearance: loadPrefs<Prefs>().appearance ?? appearanceFrom(loadPrefs<{ theme?: string | null }>().theme),
  set(patch) {
    set(patch);
    const { appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo } = get();
    savePrefs<Prefs>({ appearance, fit, textFont, textScale, textLeading, textWidth, allFiles, scan, scanTo });
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
  // Until the sensor's first reading (or without one), Auto follows the system.
  const auto = sensed ?? (scheme === 'dark' ? 'dark' : 'light');
  return palettes[appearance === 'auto' ? auto : appearance];
}
