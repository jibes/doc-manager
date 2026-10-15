import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { closeActions, useActions } from '@/state/actions';
import { usePalette } from '@/state/prefs';
import { Icon } from './Icon';
import { T, tick } from './primitives';
import { useModal } from './useModal';

let backdropPressed = false;

/** The actions for one item: a sheet from the bottom on phones, a centred card on wider screens. Mounted once in the root layout. */
export function ActionSheet() {
  const sheet = useActions((s) => s.sheet);
  return sheet ? <Sheet key={sheet.title} sheet={sheet} /> : null;
}

function Sheet({ sheet }: { sheet: NonNullable<ReturnType<typeof useActions.getState>['sheet']> }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const ref = useModal(closeActions);
  const phone = width < 600;
  return (
    <Animated.View entering={FadeIn.duration(140)} style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim, justifyContent: phone ? 'flex-end' : 'center', alignItems: 'center' }]}>
      {/* Only a press that starts on the backdrop closes it (the opening long press may end there). */}
      <Pressable
        accessibilityLabel={t.cancel}
        style={StyleSheet.absoluteFill}
        onPressIn={() => (backdropPressed = true)}
        onPress={() => {
          if (backdropPressed) closeActions();
          backdropPressed = false;
        }}
      />
      <Animated.View
        entering={FadeInDown.duration(180)}
        accessibilityViewIsModal
        accessibilityRole="menu"
        testID="action-sheet"
        style={[
          styles.card,
          { backgroundColor: p.surface, borderColor: p.hairline },
          phone ? { width: '100%', borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingBottom: insets.bottom + space.md } : { width: 360, margin: space.lg },
          elevation(p.shadow, 3),
        ]}
      >
        <View ref={ref} role="dialog" aria-modal aria-label={sheet.title} tabIndex={-1} style={styles.inner}>
          {phone && <View style={[styles.grabber, { backgroundColor: p.hairline }]} />}
          <T v="label" color={p.muted} numberOfLines={2} style={styles.title}>
            {sheet.title}
          </T>
          {/* Long lists (a filter's values) scroll within the sheet. */}
          <ScrollView style={{ maxHeight: height * 0.6 }} bounces={false}>
            {sheet.actions.map((a) => (
              <Pressable
                key={a.key}
                testID={`action-${a.key}`}
                accessibilityRole="menuitem"
                onPress={() => {
                  tick();
                  closeActions();
                  a.onPress();
                }}
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.item, (pressed || hovered) && { backgroundColor: p.hairline }]}
              >
                <Icon name={a.icon} size={21} color={a.destructive ? p.markRing : p.ink} />
                <T color={a.destructive ? p.markRing : p.ink}>{a.label}</T>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { maxWidth: 560, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingVertical: space.sm },
  inner: { outlineStyle: 'none' } as object,
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: space.xs, marginBottom: space.xs },
  title: { paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.lg, minHeight: 52, paddingHorizontal: space.xl },
});
