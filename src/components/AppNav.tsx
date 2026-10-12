import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders } from '@/lib/folders';
import { usePalette } from '@/state/prefs';
import { Icon, type IconName } from './Icon';
import { Mark } from './Mark';
import { Button, IconButton, T } from './primitives';

export type Tab = 'library' | 'files';

/** Phones get a bar at the bottom; wider windows get tabs in the header. */
export const WIDE = 760;
/** Height of the bottom bar above the safe area: screens keep this much free at the bottom. */
export const TAB_BAR_H = 64;

/** Scanning runs in the web app (and the Android app, which is the web app). */
export const scanSupported = Platform.OS === 'web';

/** Library | Files: only worth tabs when there are folders to browse. */
const hasFilesTab = () => folders.supported;

/** The tabs live side by side: the library is the hub, Files is opened over it. */
export function goTab(tab: Tab) {
  if (tab === 'files') return router.push('/files');
  if (router.canDismiss()) router.dismissTo('/');
  else router.replace('/');
}

/** Whether this screen shows the bottom bar (phones, and something to switch to). */
export function useTabBar(): boolean {
  const { width } = useWindowDimensions();
  return width < WIDE && (hasFilesTab() || scanSupported);
}

/** Brand, the tabs (wide windows), and the screen's actions on the right. */
export function AppHeader({ tab, children }: { tab: Tab; children?: ReactNode }) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  return (
    <View style={styles.masthead}>
      <View style={styles.brand}>
        <Mark size={26} />
        <T style={{ fontFamily: fonts.sansSemi, fontSize: 21, letterSpacing: -0.5 }}>Tessel</T>
      </View>
      {wide && hasFilesTab() && (
        <View accessibilityRole="tablist" style={[styles.segments, { backgroundColor: p.hairline }]}>
          <Segment tab="library" current={tab} />
          <Segment tab="files" current={tab} />
        </View>
      )}
      <View style={styles.actions}>
        <IconButton testID="home-settings" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />
        {wide && scanSupported && <Button testID="scan" kind="quiet" icon="camera" label={t.scan} onPress={() => router.push('/scan')} />}
        {children}
      </View>
    </View>
  );
}

const tabIcon: Record<Tab, IconName> = { library: 'pages', files: 'folder' };
const tabLabel = (tab: Tab) => (tab === 'library' ? t.library : t.files);

function Segment({ tab, current }: { tab: Tab; current: Tab }) {
  const p = usePalette();
  const on = tab === current;
  return (
    <Pressable
      testID={`tab-${tab}`}
      role="tab"
      aria-selected={on}
      onPress={() => !on && goTab(tab)}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.segment, on ? { backgroundColor: p.raised } : hovered && { backgroundColor: p.hairline }]}
    >
      <Icon name={tabIcon[tab]} size={16} color={on ? p.ink : p.muted} />
      <T v="label" color={on ? p.ink : p.muted}>
        {tabLabel(tab)}
      </T>
    </Pressable>
  );
}

/** Phones: Library · Scan · Files along the bottom edge. */
export function TabBar({ current }: { current: Tab }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <View role="tablist" style={[styles.bar, { paddingBottom: insets.bottom, backgroundColor: p.glass, borderColor: p.hairline }]}>
      <BarItem tab="library" current={current} />
      {scanSupported && (
        <Pressable testID="scan" accessibilityRole="button" accessibilityLabel={t.scan} onPress={() => router.push('/scan')} style={styles.barItem}>
          <View style={[styles.scan, { backgroundColor: p.ink }]}>
            <Icon name="camera" size={22} color={p.canvas} />
          </View>
        </Pressable>
      )}
      {hasFilesTab() && <BarItem tab="files" current={current} />}
    </View>
  );
}

function BarItem({ tab, current }: { tab: Tab; current: Tab }) {
  const p = usePalette();
  const on = tab === current;
  return (
    <Pressable testID={`tab-${tab}`} role="tab" aria-selected={on} aria-label={tabLabel(tab)} onPress={() => !on && goTab(tab)} style={styles.barItem}>
      <Icon name={tabIcon[tab]} size={22} color={on ? p.accent : p.muted} strokeWidth={on ? 1.9 : 1.6} />
      <T v="caption" color={on ? p.accent : p.muted} style={{ fontFamily: on ? fonts.sansSemi : fonts.sans }}>
        {tabLabel(tab)}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  masthead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, height: 52, marginBottom: space.xl },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, flexShrink: 0 },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexShrink: 1, justifyContent: 'flex-end' },
  segments: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, gap: 2 },
  segment: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, height: 34, paddingHorizontal: space.lg, borderRadius: radius.pill },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  barItem: { flex: 1, height: TAB_BAR_H, alignItems: 'center', justifyContent: 'center', gap: 2 },
  scan: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
