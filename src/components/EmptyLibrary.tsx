import { Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

import { t } from '@/i18n';
import { elevation, fonts, space } from '@/design/tokens';
import { usePalette } from '@/state/prefs';
import { Button, T } from './primitives';

/** Six pages settled into a grid — order out of a pile — one marked where you left off. */
function Grid() {
  const p = usePalette();
  const page = p.dark ? '#E9E5DC' : '#FFFFFF';
  return (
    <View style={styles.grid}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Animated.View
          key={i}
          entering={FadeIn.delay(60 * i).duration(420)}
          style={[styles.page, { backgroundColor: page }, elevation(p.shadow, 1), p.dark && { opacity: 0.9 }]}
        >
          {[0.85, 1, 0.7, 0, 0.95, 0.6].map((w, j) => (
            <View key={j} style={{ height: 2.5, width: `${w * 100}%`, borderRadius: 2, backgroundColor: w ? 'rgba(27,26,23,0.12)' : 'transparent' }} />
          ))}
          {i === 4 && <View style={[styles.ribbon, { backgroundColor: p.accent }]} />}
        </Animated.View>
      ))}
    </View>
  );
}

export function EmptyLibrary({ onAdd, onSample }: { onAdd: () => void; onSample: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.wrap}>
      <Grid />
      <Animated.View entering={FadeInUp.delay(120).duration(500)} style={{ alignItems: 'center', gap: space.md, maxWidth: 420 }}>
        <T style={{ fontFamily: fonts.sansSemi, fontSize: 34, lineHeight: 40, letterSpacing: -1, textAlign: 'center' }}>
          {t.emptyTitle}
        </T>
        <T v="body" color={p.muted} style={{ textAlign: 'center' }}>
          {Platform.OS === 'web' ? t.emptyBodyWeb : t.emptyBody}
        </T>
      </Animated.View>
      <Animated.View entering={FadeInUp.delay(220).duration(500)} style={styles.actions}>
        <Button testID="add" label={t.addPdf} icon="plus" onPress={onAdd} />
        <Button testID="sample" label={t.openSample} kind="quiet" onPress={onSample} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.xl, paddingVertical: space.xxxl, minHeight: 520 },
  grid: { width: 3 * 52 + 2 * 12, flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: space.lg },
  page: { width: 52, height: 68, borderRadius: 3, padding: 8, gap: 5 },
  ribbon: { position: 'absolute', top: 0, right: 8, width: 7, height: 16, borderBottomLeftRadius: 1.5, borderBottomRightRadius: 1.5 },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm, flexWrap: 'wrap', justifyContent: 'center' },
});
