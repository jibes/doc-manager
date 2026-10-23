import { createContext, useContext, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideInRight, SlideOutDown, SlideOutRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/core/i18n';
import { IconButton, T } from '@/paper/components/primitives';
import { elevation, radius, space } from '@/core/design/tokens';
import { usePalette } from '@/paper/state/prefs';

export const isWide = (w: number) => w >= 900;
/** Desktop windows this wide keep Find and Details open in a column beside the pages. */
export const isDocked = (w: number) => Platform.OS === 'web' && w >= 1300;
/** Inside that column: a panel is a section of it. */
export const Docked = createContext(false);

/** Room the reader's top bar and bottom pills (page, zoom, bookmark) take: a side panel stays between them. */
const TOP_ROOM = 64;
const BOTTOM_ROOM = 80;

/** Side sheet on wide screens, bottom sheet on phones. One panel at a time. */
export function Panel({ title, onClose, children, compact, testID }: { title: string; onClose: () => void; children: ReactNode; compact?: boolean; testID?: string }) {
  const p = usePalette();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = isWide(width);
  const docked = useContext(Docked);

  const header = (
    <View style={styles.header}>
      <T v="headline">{title}</T>
      <IconButton icon="close" label={t.close} size={34} onPress={onClose} />
    </View>
  );

  if (docked) {
    return (
      <View testID={testID} style={[styles.docked, { borderColor: p.hairline }]}>
        {header}
        {children}
      </View>
    );
  }

  if (wide) {
    return (
      <Animated.View
        testID={testID}
        entering={SlideInRight.duration(260)}
        exiting={SlideOutRight.duration(180)}
        style={[
          styles.side,
          { top: insets.top + TOP_ROOM, bottom: insets.bottom + BOTTOM_ROOM, backgroundColor: p.surface, borderColor: p.hairline },
          compact && { bottom: undefined, maxHeight: height - insets.top - TOP_ROOM - insets.bottom - BOTTOM_ROOM },
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
        <Pressable accessibilityLabel={t.close} style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]} onPress={onClose} />
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
  docked: { flex: 1, minHeight: 0, borderBottomWidth: StyleSheet.hairlineWidth },
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
