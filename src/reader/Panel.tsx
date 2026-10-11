import type { ReactNode } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideInRight, SlideOutDown, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, T } from '@/components/primitives';
import { elevation, radius, space } from '@/design/tokens';
import { usePalette } from '@/state/prefs';

export const isWide = (w: number) => w >= 900;

/** Side sheet on wide screens, bottom sheet on phones. One panel at a time. */
export function Panel({ title, onClose, children, compact, testID }: { title: string; onClose: () => void; children: ReactNode; compact?: boolean; testID?: string }) {
  const p = usePalette();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = isWide(width);

  const header = (
    <View style={styles.header}>
      <T v="headline">{title}</T>
      <IconButton icon="close" label="Close" size={34} onPress={onClose} />
    </View>
  );

  if (wide) {
    return (
      <Animated.View
        testID={testID}
        entering={SlideInRight.duration(260)}
        exiting={SlideOutRight.duration(180)}
        style={[
          styles.side,
          { top: insets.top + 64, bottom: insets.bottom + 56, backgroundColor: p.surface, borderColor: p.hairline },
          compact && { bottom: undefined, maxHeight: height - insets.top - 120 },
          elevation(p.shadow, 3),
        ]}
      >
        {header}
        {children}
      </Animated.View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]} onPress={onClose} />
      </Animated.View>
      <Animated.View
        testID={testID}
        entering={SlideInDown.duration(300)}
        exiting={SlideOutDown.duration(200)}
        style={[
          styles.bottom,
          { backgroundColor: p.surface, paddingBottom: insets.bottom, maxHeight: height * 0.82 },
          !compact && { height: height * 0.78 },
          elevation(p.shadow, 3),
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: p.hairline }]} />
        {header}
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  side: {
    position: 'absolute',
    right: space.lg,
    width: 360,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    overflow: 'hidden',
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.xl - 4,
    paddingRight: space.md,
    height: 52,
  },
});
