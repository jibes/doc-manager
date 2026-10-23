import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { Icon, type IconName } from '@/paper/components/Icon';
import { T, tick } from '@/paper/components/primitives';
import { elevation, radius, space, type Palette } from '@/core/design/tokens';
import { t } from '@/core/i18n';

export type MenuItem = { key: string; icon: IconName; label: string; hint?: string; onPress: () => void };

/** Small popover anchored under the top bar's ⋯ button, or (`at`) where the pointer was right-clicked. */
export function MoreMenu({ palette: p, top = 0, at, items, onClose }: { palette: Palette; top?: number; at?: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  // Kept in the window: it opens to the left or upwards where there is no room.
  const place = at ? { left: Math.max(space.sm, Math.min(at.x, width - MENU_W - space.sm)), top: Math.max(space.sm, Math.min(at.y, height - items.length * ITEM_H - space.lg)), right: 'auto' as const } : { top };
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable accessibilityLabel={t.close} style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(100)}
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
