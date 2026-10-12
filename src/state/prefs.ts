import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import { palettes, type Palette, type ThemeName } from '@/design/tokens';
import { loadPrefs, savePrefs } from '@/storage/prefs';
import { useAmbient } from './ambient';

export type FitMode = 'width' | 'page';
export type TextFont = 'serif' | 'sans';
export type TextLeading = 'compact' | 'normal' | 'relaxed';
export type TextWidth = 'narrow' | 'medium' | 'wide';

type Prefs = {
  /** null = follow system (Paper / Dusk); 'ambient' = follow the light sensor. */
  theme: ThemeName | 'ambient' | null;
  fit: FitMode;
  /** Text view typography. */
  textFont: TextFont;
  textScale: number;
  textLeading: TextLeading;
  textWidth: TextWidth;
  /** Android app: browse the whole device (needs all files access). */
  allFiles: boolean;
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { theme: null, fit: 'width', textFont: 'serif', textScale: 1, textLeading: 'normal', textWidth: 'medium', allFiles: false };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  set(patch) {
    set(patch);
    const { theme, fit, textFont, textScale, textLeading, textWidth, allFiles } = get();
    savePrefs<Prefs>({ theme, fit, textFont, textScale, textLeading, textWidth, allFiles });
  },
}));

export function usePalette(): Palette {
  const theme = usePrefs((s) => s.theme);
  const ambient = useAmbient((s) => s.theme);
  const scheme = useColorScheme();
  const system = scheme === 'dark' ? 'dusk' : 'paper';
  // Until the sensor's first reading, the light sensor theme follows the system.
  return palettes[theme === 'ambient' ? (ambient ?? system) : (theme ?? system)];
}
