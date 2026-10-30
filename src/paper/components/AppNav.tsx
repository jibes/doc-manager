import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { fonts, space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { usePalette } from '@/paper/state/prefs';
import { Mark } from './Mark';
import { IconButton, T } from './primitives';

/**
 * One place: Documents, with Add (camera or files) on it and everything else (inbox, trash, sync issues, rules,
 * settings) one step away. No tab bar and no sidebar: wide windows show the same screen, wider.
 */
export type Tab = 'documents';

export const WIDE = 760;
/** Kept for the screens' bottom room; there is no bar along the bottom any more. */
export const TAB_BAR_H = 0;

/** Scanning runs in the web app (and the Android app, which is the web app). */
export const scanSupported = Platform.OS === 'web';

/** Back to Documents: brought back if it is open underneath, never stacked. */
export function goTab(_tab: Tab, from?: Tab) {
  if (from) return;
  if (router.canDismiss()) router.dismissTo('/');
  else router.replace('/');
}

export const useWide = () => useWindowDimensions().width >= WIDE;

/** Widest column of content (lists, settings) on any screen. */
const COLUMN_W = 780;
/**
 * A screen's column of content in `avail`: the same on every screen. Its margins grow with the room (20 → 48),
 * never so fast that a wider window gives a narrower column.
 */
export const columnWidth = (avail: number) => {
  const margin = Math.min(space.xxxl, Math.max(space.xl - 4, space.xl - 4 + ((avail - 560) * 28) / 200));
  return Math.min(avail - 2 * margin, COLUMN_W);
};

/** This screen's column of content. */
export const useColumnWidth = () => columnWidth(useMainWidth());

/** The window's width (there is no sidebar beside the screens). */
export function useMainWidth(): number {
  return useWindowDimensions().width;
}

/** No bar along the bottom any more. */
export function useTabBar(): boolean {
  return false;
}

/** The screen's title, with its actions and Settings on the right. */
export function AppHeader({ children }: { tab?: Tab; children?: ReactNode }) {
  return (
    <View style={styles.masthead}>
      <View style={styles.brand}>
        <Mark size={24} />
        <T accessibilityRole="header" style={{ fontFamily: fonts.sansSemi, fontSize: 22, letterSpacing: -0.5 }}>
          {t.documentsTitle}
        </T>
      </View>
      <View style={styles.actions}>
        {children}
        <IconButton testID="home-settings" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />
      </View>
    </View>
  );
}

/** A screen opened from Documents (Inbox, Trash, Settings, a folder…). */
export type Sub = 'inbox' | 'trash' | 'settings' | 'sync' | 'rules' | 'duplicates' | 'tidy';

export function SubFrame({ children }: { sub: Sub; children: ReactNode }) {
  const p = usePalette();
  return <View style={{ flex: 1, backgroundColor: p.canvas }}>{children}</View>;
}

/** Documents' frame. */
export function AppFrame({ children }: { tab: Tab; children: ReactNode }) {
  const p = usePalette();
  return <View style={{ flex: 1, backgroundColor: p.canvas }}>{children}</View>;
}

const styles = StyleSheet.create({
  masthead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, height: 52, marginBottom: space.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, flexShrink: 0 },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexShrink: 1, justifyContent: 'flex-end' },
});
