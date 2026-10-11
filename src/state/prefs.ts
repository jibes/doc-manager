import { useColorScheme } from 'react-native';
import { create } from 'zustand';

import { palettes, type Palette, type ThemeName } from '@/design/tokens';
import { loadPrefs, savePrefs } from '@/storage/prefs';

export type FitMode = 'width' | 'page';

type Prefs = {
  /** null = follow system (Paper / Dusk). */
  theme: ThemeName | null;
  fit: FitMode;
};

type PrefsState = Prefs & {
  set(patch: Partial<Prefs>): void;
};

const defaults: Prefs = { theme: null, fit: 'width' };

export const usePrefs = create<PrefsState>((set, get) => ({
  ...defaults,
  ...loadPrefs<Prefs>(),
  set(patch) {
    set(patch);
    const { theme, fit } = get();
    savePrefs<Prefs>({ theme, fit });
  },
}));

export function usePalette(): Palette {
  const theme = usePrefs((s) => s.theme);
  const scheme = useColorScheme();
  return palettes[theme ?? (scheme === 'dark' ? 'dusk' : 'paper')];
}
