import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import { palettes, type Palette, type ThemeName } from '@/design/tokens';
import { loadPrefs, savePrefs } from '@/storage/prefs';

export type FitMode = 'width' | 'page';
export type TextFont = 'serif' | 'sans';
export type TextLeading = 'compact' | 'normal' | 'relaxed';
export type TextWidth = 'narrow' | 'medium' | 'wide';

type Prefs = {
  /** null = follow system (Paper / Dusk). */
  theme: ThemeName | null;
  fit: FitMode;
  /** Text view typography. */
  textFont: TextFont;
  textScale: number;
  textLeading: TextLeading;
  textWidth: TextWidth;
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { theme: null, fit: 'width', textFont: 'serif', textScale: 1, textLeading: 'normal', textWidth: 'medium' };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  set(patch) {
    set(patch);
    const { theme, fit, textFont, textScale, textLeading, textWidth } = get();
    savePrefs<Prefs>({ theme, fit, textFont, textScale, textLeading, textWidth });
  },
}));

export function usePalette(): Palette {
  const theme = usePrefs((s) => s.theme);
  const scheme = useColorScheme();
  return palettes[theme ?? (scheme === 'dark' ? 'dusk' : 'paper')];
}
