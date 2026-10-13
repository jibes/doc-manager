import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { useInboxCount } from '@/archive/inbox';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders } from '@/lib/folders';
import { usePalette, usePrefs } from '@/state/prefs';
import { Icon, type IconName } from './Icon';
import { Mark } from './Mark';
import { IconButton, T } from './primitives';

/**
 * Two places and one action: Reading (what you are reading: time), Documents (finding and managing: content and
 * folders), and Scan (making new ones). Phones get them along the bottom edge; wider windows a sidebar.
 */
export type Tab = 'reading' | 'documents';

/** Phones get a bar at the bottom; wider windows a sidebar. */
export const WIDE = 760;
/** Height of the bottom bar above the safe area: screens keep this much free at the bottom. */
export const TAB_BAR_H = 64;
const SIDEBAR_W = 232;

/** Scanning runs in the web app (and the Android app, which is the web app). */
export const scanSupported = Platform.OS === 'web';

/** What Documents shows: everything by what it is, or the folders as they are. */
export type DocsView = 'all' | 'folders';
export const useDocsView = create<{ view: DocsView }>(() => ({ view: 'all' }));

/** Switching places never stacks screens: the place is brought back if it is open underneath. */
export function goTab(tab: Tab, view?: DocsView) {
  if (view) useDocsView.setState({ view });
  const href = tab === 'documents' ? '/documents' : '/';
  // Back to it when it is open underneath; else in place of the current screen (never one over the other).
  if (router.canDismiss()) router.dismissTo(href);
  else router.replace(href);
}

export const useWide = () => useWindowDimensions().width >= WIDE;

/** The width beside the sidebar (wide windows) or the window's (phones). */
export function useMainWidth(): number {
  const { width } = useWindowDimensions();
  return width >= WIDE ? width - SIDEBAR_W : width;
}

/** Whether this screen shows the bottom bar (phones). */
export function useTabBar(): boolean {
  return !useWide();
}

const tabIcon: Record<Tab, IconName> = { reading: 'pages', documents: 'documents' };
const tabLabel = (tab: Tab) => (tab === 'reading' ? t.readingTab : t.documentsTitle);

/** The inbox's count, when this device sorts it (else nothing to show). */
function useInboxBadge(): number {
  const shown = usePrefs((s) => !!s.archive && s.inboxHere);
  const count = useInboxCount((s) => s.count);
  return shown ? count : 0;
}

/** A place's title, with its actions (and, on phones, Settings) on the right. */
export function AppHeader({ tab, children }: { tab: Tab; children?: ReactNode }) {
  const wide = useWide();
  return (
    <View style={styles.masthead}>
      <View style={styles.brand}>
        {!wide && <Mark size={24} />}
        <T accessibilityRole="header" style={{ fontFamily: fonts.sansSemi, fontSize: 22, letterSpacing: -0.5 }}>
          {tabLabel(tab)}
        </T>
      </View>
      <View style={styles.actions}>
        {children}
        {!wide && <IconButton testID="home-settings" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />}
      </View>
    </View>
  );
}

/** A place's screen: with the sidebar beside it on wide windows, the bottom bar under it on phones. */
export function AppFrame({ tab, children }: { tab: Tab; children: ReactNode }) {
  const p = usePalette();
  const wide = useWide();
  if (!wide)
    return (
      <View style={{ flex: 1, backgroundColor: p.canvas }}>
        {children}
        <TabBar current={tab} />
      </View>
    );
  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: p.canvas }}>
      <Sidebar current={tab} />
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/** Phones: Reading · Scan · Documents along the bottom edge. */
function TabBar({ current }: { current: Tab }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const badge = useInboxBadge();
  return (
    <View role="tablist" style={[styles.bar, { paddingBottom: insets.bottom, backgroundColor: p.surface, borderColor: p.hairline }]}>
      <BarItem tab="reading" current={current} />
      {scanSupported && (
        <Pressable testID="scan" accessibilityRole="button" accessibilityLabel={t.scan} onPress={() => router.push('/scan')} style={styles.barItem}>
          <View style={[styles.scan, { backgroundColor: p.ink }]}>
            <Icon name="camera" size={22} color={p.canvas} />
          </View>
        </Pressable>
      )}
      <BarItem tab="documents" current={current} badge={badge} />
    </View>
  );
}

function BarItem({ tab, current, badge = 0 }: { tab: Tab; current: Tab; badge?: number }) {
  const p = usePalette();
  const on = tab === current;
  return (
    <Pressable testID={`tab-${tab}`} role="tab" aria-selected={on} aria-label={tabLabel(tab)} onPress={() => goTab(tab, tab === 'documents' && on ? 'all' : undefined)} style={styles.barItem}>
      <View>
        <Icon name={tabIcon[tab]} size={22} color={on ? p.accent : p.muted} strokeWidth={on ? 1.9 : 1.6} />
        {badge > 0 && <Badge n={badge} />}
      </View>
      <T v="caption" color={on ? p.accent : p.muted} style={{ fontFamily: on ? fonts.sansSemi : fonts.sans }}>
        {tabLabel(tab)}
      </T>
    </Pressable>
  );
}

function Badge({ n, inline }: { n: number; inline?: boolean }) {
  const p = usePalette();
  return (
    <View testID="inbox-badge" style={[styles.badge, inline ? null : styles.badgeOver, { backgroundColor: p.accent }]}>
      <T v="caption" color={p.canvas} style={{ fontFamily: fonts.sansSemi, fontSize: 11, lineHeight: 14 }}>
        {n > 99 ? '99+' : n}
      </T>
    </View>
  );
}

/** Wide windows: the places, Documents' parts under it, Scan and Settings. */
function Sidebar({ current }: { current: Tab }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const inboxShown = usePrefs((s) => !!s.archive && s.inboxHere);
  const badge = useInboxBadge();
  const view = useDocsView((s) => s.view);
  const docs = current === 'documents';
  return (
    <View style={[styles.sidebar, { paddingTop: insets.top + space.lg, borderColor: p.hairline, backgroundColor: p.surface }]}>
      <View style={[styles.brand, { paddingHorizontal: space.md, marginBottom: space.lg }]}>
        <Mark size={26} />
        <T style={{ fontFamily: fonts.sansSemi, fontSize: 21, letterSpacing: -0.5 }}>Tessel</T>
      </View>
      <View role="tablist" style={{ gap: 2 }}>
        <SideItem testID="tab-reading" role="tab" icon="pages" label={t.readingTab} on={current === 'reading'} onPress={() => goTab('reading')} />
        <SideItem testID="tab-documents" role="tab" icon="documents" label={t.documentsTitle} on={docs && view === 'all'} onPress={() => goTab('documents', 'all')} />
        {inboxShown && <SideItem testID="side-inbox" icon="inbox" label={t.inboxTitle} sub badge={badge} onPress={() => router.push('/inbox')} />}
        {folders.supported && <SideItem testID="side-folders" icon="folder" label={t.foldersView} sub on={docs && view === 'folders'} onPress={() => goTab('documents', 'folders')} />}
        {archive && <SideItem testID="side-trash" icon="trash" label={t.trashTitle} sub onPress={() => router.push('/trash')} />}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ gap: 2, paddingBottom: insets.bottom + space.lg }}>
        {scanSupported && <SideItem testID="scan" icon="camera" label={t.scan} strong onPress={() => router.push('/scan')} />}
        <SideItem testID="home-settings" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />
      </View>
    </View>
  );
}

function SideItem(props: { testID: string; role?: 'tab'; icon: IconName; label: string; on?: boolean; sub?: boolean; strong?: boolean; badge?: number; onPress: () => void }) {
  const p = usePalette();
  const { on, sub, strong } = props;
  return (
    <Pressable
      testID={props.testID}
      role={props.role}
      aria-selected={props.role ? !!on : undefined}
      accessibilityRole={props.role ? undefined : 'button'}
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.sideItem,
        sub && { paddingLeft: space.xl + space.sm },
        { backgroundColor: strong ? p.ink : on ? p.hairline : hovered ? p.raised : 'transparent' },
      ]}
    >
      <Icon name={props.icon} size={sub ? 18 : 20} color={strong ? p.canvas : on ? p.ink : p.muted} />
      <T v="label" color={strong ? p.canvas : on ? p.ink : p.inkSoft} style={{ flex: 1, fontFamily: on || strong ? fonts.sansSemi : fonts.sansMedium }}>
        {props.label}
      </T>
      {!!props.badge && <Badge n={props.badge} inline />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  masthead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, height: 52, marginBottom: space.lg },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, flexShrink: 0 },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center', flexShrink: 1, justifyContent: 'flex-end' },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth },
  barItem: { flex: 1, height: TAB_BAR_H, alignItems: 'center', justifyContent: 'center', gap: 2 },
  scan: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeOver: { position: 'absolute', top: -6, right: -12 },
  sidebar: { width: SIDEBAR_W, borderRightWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md },
  sideItem: { flexDirection: 'row', alignItems: 'center', gap: space.md, height: 40, paddingHorizontal: space.md, borderRadius: radius.md },
});
