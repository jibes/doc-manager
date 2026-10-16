import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';

import { t } from '@/core/i18n';
import { Icon } from '@/paper/components/Icon';
import { IconButton, T } from '@/paper/components/primitives';
import { elevation, fonts, radius, space, type Palette } from '@/core/design/tokens';

type Props = {
  palette: Palette;
  query: string;
  count: number;
  active: number;
  searching: boolean;
  top: number;
  onOpen: () => void;
  onStep: (dir: 1 | -1) => void;
  onClear: () => void;
  /** Some page has more matches than are listed. */
  more?: boolean;
};

/** Compact find-in-page bar that keeps a search alive (and highlighted) after the panel closes. */
export function FindBar({ palette: p, query, count, more, active, searching, top, onOpen, onStep, onClear }: Props) {
  const status = count ? t.nOf(active >= 0 ? active + 1 : '–', count, !!more && !searching) : searching ? t.searching : t.noMatches;
  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOutUp.duration(160)}
      pointerEvents="box-none"
      style={[styles.wrap, { top }]}
    >
      <View
        testID="find-bar"
        style={[styles.bar, { backgroundColor: p.glass, borderColor: p.hairline }, elevation(p.shadow, 2)]}
      >
        <Pressable accessibilityRole="button" accessibilityLabel={t.editSearch} onPress={onOpen} style={styles.label}>
          <Icon name="search" size={15} color={p.muted} />
          <T numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 14, maxWidth: 140 }}>
            {query}
          </T>
          <T v="numeral" color={count ? p.muted : p.accent} accessibilityLiveRegion="polite">
            {status}
          </T>
        </Pressable>
        <IconButton icon="up" label={t.previousResult} size={32} disabled={!count} onPress={() => onStep(-1)} />
        <IconButton icon="down" label={t.nextResult} size={32} disabled={!count} onPress={() => onStep(1)} testID="find-next" />
        <IconButton icon="close" label={t.clearSearch} size={32} onPress={onClear} testID="find-clear" />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: space.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 42,
    paddingLeft: space.lg,
    paddingRight: 4,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backdropFilter: 'blur(18px) saturate(1.4)',
  } as object,
  label: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingRight: space.sm, flexShrink: 1 },
});
