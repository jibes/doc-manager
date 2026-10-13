import { Platform, type TextStyle } from 'react-native';

export type ThemeName = 'light' | 'dark';

/** How rendered (white) PDF pages are shown: a GPU filter on web, a blend overlay on native, and the colour behind them while they load. */
export type PageLook = { cssFilter: string; blend?: { color: string; mode: 'multiply' | 'difference' }; base: string };

export type Palette = {
  name: ThemeName;
  dark: boolean;
  /** Behind pages / app background. */
  canvas: string;
  /** Panels, sheets, cards. */
  surface: string;
  /** Raised controls on surface. */
  raised: string;
  ink: string;
  inkSoft: string;
  muted: string;
  hairline: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  /** Search hit fill on pages. */
  mark: string;
  markActive: string;
  /** Outline on the current hit so it reads apart from the rest. */
  markRing: string;
  scrim: string;
  /** Chrome glass over the reading surface. */
  glass: string;
  /** Pages as printed: untouched in Light; in Dark slightly dimmed and warm, so a white page doesn't glare. */
  page: PageLook;
  /** Pages with "Invert colours" (per document): light text on a dark page. */
  inverted: PageLook;
  shadow: string;
};

export const palettes: Record<ThemeName, Palette> = {
  light: {
    name: 'light',
    dark: false,
    canvas: '#ECE8DF',
    surface: '#F7F5F0',
    raised: '#FFFFFF',
    ink: '#1B1A17',
    inkSoft: '#46433D',
    muted: '#857F73',
    hairline: 'rgba(27,26,23,0.10)',
    accent: '#2F4F86',
    accentInk: '#FFFFFF',
    accentSoft: 'rgba(47,79,134,0.11)',
    mark: 'rgba(255,190,40,0.32)',
    markActive: 'rgba(255,150,0,0.55)',
    markRing: '#D06A00',
    scrim: 'rgba(27,26,23,0.28)',
    glass: 'rgba(247,245,240,0.82)',
    page: { cssFilter: 'none', base: '#FFFFFF' },
    inverted: { cssFilter: 'invert(0.92) hue-rotate(180deg)', blend: { color: '#EBEBEB', mode: 'difference' }, base: '#151515' },
    shadow: 'rgba(60,48,30,0.16)',
  },
  dark: {
    name: 'dark',
    dark: true,
    canvas: '#18191C',
    surface: '#222327',
    raised: '#2B2C31',
    ink: '#ECE7DC',
    inkSoft: '#C9C3B7',
    muted: '#8D8980',
    hairline: 'rgba(236,231,220,0.10)',
    accent: '#9DB7E6',
    accentInk: '#14171D',
    accentSoft: 'rgba(157,183,230,0.14)',
    mark: 'rgba(255,200,80,0.26)',
    markActive: 'rgba(255,180,40,0.48)',
    markRing: '#FFB238',
    scrim: 'rgba(0,0,0,0.45)',
    glass: 'rgba(34,35,39,0.80)',
    // About 70 %: the page's white sits just below the app's light text, with a touch of warmth.
    page: { cssFilter: 'brightness(0.7) sepia(0.14)', blend: { color: '#B5AE9F', mode: 'multiply' }, base: '#B5AE9F' },
    inverted: { cssFilter: 'invert(0.86) hue-rotate(180deg) contrast(0.94)', blend: { color: '#DCDCDC', mode: 'difference' }, base: '#2B2B2B' },
    shadow: 'rgba(0,0,0,0.5)',
  },
};

export const fonts = {
  serif: 'Newsreader_500Medium',
  serifRegular: 'Newsreader_400Regular',
  serifItalic: 'Newsreader_400Regular_Italic',
  serifSemi: 'Newsreader_600SemiBold',
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemi: 'Inter_600SemiBold',
};

const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

export const type = {
  display: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 38, letterSpacing: -0.6 },
  title: { fontFamily: fonts.serif, fontSize: 24, lineHeight: 29, letterSpacing: -0.3 },
  headline: { fontFamily: fonts.sansSemi, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  label: { fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, ...tabular },
  kicker: { fontFamily: fonts.sansSemi, fontSize: 10.5, lineHeight: 14, letterSpacing: 1.2, textTransform: 'uppercase' },
  numeral: { fontFamily: fonts.sansMedium, fontSize: 12, lineHeight: 16, ...tabular },
} satisfies Record<string, TextStyle>;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
export const radius = { cover: 3, sm: 8, md: 12, lg: 18, pill: 999 } as const;

export const motion = {
  fast: 140,
  base: 220,
  slow: 380,
  /** Emphasized decelerate. */
  easing: [0.2, 0, 0, 1] as const,
};

/** Cross-platform soft elevation. */
export function elevation(color: string, level: 1 | 2 | 3) {
  const y = [0, 1, 6, 18][level];
  const blur = [0, 3, 18, 40][level];
  return Platform.select({
    web: { boxShadow: `0 ${y}px ${blur}px ${color}, 0 0 0 0.5px ${color}` } as object,
    default: { shadowColor: color, shadowOpacity: 1, shadowRadius: blur / 2, shadowOffset: { width: 0, height: y }, elevation: level * 3 },
  });
}
