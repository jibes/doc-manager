import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Icon, type IconName } from '@/paper/components/Icon';
import { useModal } from '@/paper/components/useModal';
import { T, tick } from '@/paper/components/primitives';
import { elevation, radius, space, type Palette } from '@/core/design/tokens';
import { t } from '@/core/i18n';

export type MenuItem = { key: string; icon: IconName; label: string; hint?: string; onPress: () => void };

/** Small popover anchored under the top bar's ⋯ button, or (`at`) where the pointer was right-clicked. */
export function MoreMenu({ palette: p, top = 0, at, items, onClose }: { palette: Palette; top?: number; at?: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  // Kept in the window: it opens to the left or upwards where there is no room.
  // Escape closes it (before the screen under it reacts), the focus goes into it, and ↑ ↓ go through its items.
  const ref = useModal(onClose);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const el = ref.current as unknown as HTMLElement | null;
      const items = [...(el?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      if (!items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
  // At a point: in the window's coordinates, wherever the menu's screen is (the reader beside the list starts
  // part way across).
  const place = at
    ? {
        left: Math.max(space.sm, Math.min(at.x, width - MENU_W - space.sm)),
        top: Math.max(space.sm, Math.min(at.y, height - items.length * ITEM_H - space.lg)),
        right: 'auto' as const,
        ...(Platform.OS === 'web' ? { position: 'fixed' as 'absolute' } : {}),
      }
    : { top };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable accessibilityLabel={t.close} style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(100)}
        ref={ref}
        tabIndex={-1}
        testID="more-menu"
        accessibilityRole="menu"
        style={[styles.menu, place, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
      >
        {items.map((it) => (
          <Pressable
            key={it.key}
            testID={`menu-${it.key}`}
            accessibilityRole="menuitem"
            onPress={() => {
              tick();
              onClose();
              it.onPress();
            }}
            style={({ hovered, pressed }: { pressed: boolean; hovered?: boolean }) => [styles.item, (hovered || pressed) && { backgroundColor: p.hairline }]}
          >
            <Icon name={it.icon} size={19} color={p.ink} />
            <T v="label" style={{ flex: 1 }}>
              {it.label}
            </T>
            {it.hint ? (
              <T v="caption" color={p.muted}>
                {it.hint}
              </T>
            ) : null}
          </Pressable>
        ))}
      </Animated.View>
    </View>
  );
}

const MENU_W = 240;
const ITEM_H = 40;

const styles = StyleSheet.create({
  menu: { position: 'absolute', right: space.sm, minWidth: 200, padding: space.xs, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, height: 40, paddingHorizontal: space.md, borderRadius: radius.sm },
});
