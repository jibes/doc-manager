import { Platform, type TextStyle } from 'react-native';

export type ThemeName = 'paper' | 'sepia' | 'dusk' | 'night';

export type Palette = {
  name: ThemeName;
  label: string;
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
  /** How rendered (white) pages are tinted for this theme. */
  page: { cssFilter: string; blend?: { color: string; mode: 'multiply' | 'difference' } };
  shadow: string;
};

export const palettes: Record<ThemeName, Palette> = {
  paper: {
    name: 'paper',
    label: 'Paper',
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
    page: { cssFilter: 'none' },
    shadow: 'rgba(60,48,30,0.16)',
  },
  sepia: {
    name: 'sepia',
    label: 'Sepia',
    dark: false,
    canvas: '#E6DAC3',
    surface: '#F2E8D6',
    raised: '#F8F1E4',
    ink: '#3A2E20',
    inkSoft: '#5A4934',
    muted: '#927E62',
    hairline: 'rgba(58,46,32,0.12)',
    accent: '#8A4B24',
    accentInk: '#FFF8EE',
    accentSoft: 'rgba(138,75,36,0.12)',
    mark: 'rgba(214,140,40,0.30)',
    markActive: 'rgba(200,100,20,0.50)',
    markRing: '#B4570E',
    scrim: 'rgba(58,46,32,0.30)',
    glass: 'rgba(242,232,214,0.84)',
    page: { cssFilter: 'sepia(0.32) saturate(0.92) brightness(0.97)', blend: { color: '#F1E2C4', mode: 'multiply' } },
    shadow: 'rgba(90,60,20,0.18)',
  },
  dusk: {
    name: 'dusk',
    label: 'Dusk',
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
    page: { cssFilter: 'invert(0.86) hue-rotate(180deg) contrast(0.94)', blend: { color: '#DCDCDC', mode: 'difference' } },
    shadow: 'rgba(0,0,0,0.5)',
  },
  night: {
    name: 'night',
    label: 'Night',
    dark: true,
    canvas: '#000000',
    surface: '#0E0E0F',
    raised: '#1A1A1C',
    ink: '#DAD5CA',
    inkSoft: '#B5B0A6',
    muted: '#77736C',
    hairline: 'rgba(218,213,202,0.10)',
    accent: '#A9BEE3',
    accentInk: '#0A0C10',
    accentSoft: 'rgba(169,190,227,0.13)',
    mark: 'rgba(255,200,80,0.24)',
    markActive: 'rgba(255,180,40,0.44)',
    markRing: '#FFAA30',
    scrim: 'rgba(0,0,0,0.6)',
    glass: 'rgba(14,14,15,0.80)',
    page: { cssFilter: 'invert(1) hue-rotate(180deg) brightness(0.84) contrast(0.96)', blend: { color: '#D2D2D2', mode: 'difference' } },
    shadow: 'rgba(0,0,0,0)',
  },
};

export const fonts = {
  serif: 'Newsreader_500Medium',
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
