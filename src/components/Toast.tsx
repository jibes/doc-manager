import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { elevation, radius, space } from '@/design/tokens';
import { usePalette } from '@/state/prefs';
import { T } from './primitives';

/** `above`: room to leave at the bottom (a tab bar). */
export function Toast({ message, onDismiss, above = 0 }: { message: string | null; onDismiss: () => void; above?: number }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  if (!message) return null;
  return (
    <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(160)} style={[styles.wrap, { bottom: insets.bottom + space.xl + above }]}>
      <Pressable accessibilityRole="alert" onPress={onDismiss} style={[styles.toast, { backgroundColor: p.ink }, elevation(p.shadow, 3)]}>
        <T v="label" color={p.canvas}>{message}</T>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: space.lg },
  toast: { maxWidth: 520, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
