import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, radius, space } from '@/core/design/tokens';
import { usePalette } from '@/paper/state/prefs';
import { T } from './primitives';

/**
 * `above`: room to leave at the bottom (a tab bar). `action`: one button, such as Undo. `id`: a message said
 * again (the same words) shows for its own five seconds. `top`: at the top of the screen (what any screen may say).
 */
export function Toast({
  message,
  onDismiss,
  above = 0,
  action,
  id,
  top,
}: {
  message: string | null;
  onDismiss: () => void;
  above?: number;
  action?: { label: string; onPress: () => void };
  id?: number;
  top?: boolean;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [message, id, onDismiss]);
  if (!message) return null;
  return (
    // Only the toast takes taps: what is beside it (a row of actions) stays usable.
    <Animated.View
      key={id}
      pointerEvents="box-none"
      entering={(top ? FadeInUp : FadeInDown).duration(220)}
      exiting={(top ? FadeOutUp : FadeOutDown).duration(160)}
      style={[styles.wrap, top ? { top: insets.top + space.md } : { bottom: insets.bottom + space.xl + above }]}
    >
      <Pressable accessibilityRole="alert" onPress={onDismiss} style={[styles.toast, { backgroundColor: p.ink }, elevation(p.shadow, 3)]}>
        <T v="label" color={p.canvas} style={{ flexShrink: 1 }}>
          {message}
        </T>
        {action && (
          <Pressable
            testID="toast-action"
            accessibilityRole="button"
            onPress={() => {
              action.onPress();
              onDismiss();
            }}
            hitSlop={8}
          >
            <T v="label" color={p.canvas} style={{ fontWeight: '700', textDecorationLine: 'underline' }}>
              {action.label}
            </T>
          </Pressable>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: space.lg },
  toast: { maxWidth: 520, flexDirection: 'row', alignItems: 'center', gap: space.lg, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
