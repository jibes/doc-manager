import { Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

import { t } from '@/i18n';
import { elevation, fonts, space } from '@/design/tokens';
import { usePalette } from '@/state/prefs';
import { Button, T } from './primitives';

/** A small still life of fanned sheets — the product's promise before there's content. */
function Sheets() {
  const p = usePalette();
  const sheet = (rotate: string, x: number, y: number, z: number) => (
    <View
      style={[
        styles.sheet,
        { backgroundColor: p.dark ? '#E9E5DC' : '#FFFFFF', transform: [{ translateX: x }, { translateY: y }, { rotate }], zIndex: z },
        elevation(p.shadow, 2),
        p.dark && { opacity: 0.92 },
      ]}
    >
      {z === 3 && (
        <View style={{ padding: 16, gap: 7 }}>
          <T style={{ fontFamily: fonts.serifSemi, fontSize: 30, lineHeight: 30, color: '#1B1A17' }}>Q</T>
          {[0.9, 1, 0.95, 1, 0.6, 0, 1, 0.92, 0.75].map((w, i) => (
            <View key={i} style={{ height: w ? 3 : 2, width: `${w * 100}%`, borderRadius: 2, backgroundColor: w ? 'rgba(27,26,23,0.13)' : 'transparent' }} />
          ))}
        </View>
      )}
    </View>
  );
  return (
    <View style={styles.stage}>
      {sheet('-9deg', -26, 8, 1)}
      {sheet('6deg', 24, 4, 2)}
      {sheet('-1deg', 0, 0, 3)}
    </View>
  );
}

export function EmptyLibrary({ onAdd, onSample }: { onAdd: () => void; onSample: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.wrap}>
      <Animated.View entering={FadeIn.duration(600)}>
        <Sheets />
      </Animated.View>
      <Animated.View entering={FadeInUp.delay(120).duration(500)} style={{ alignItems: 'center', gap: space.md, maxWidth: 420 }}>
        <T style={{ fontFamily: fonts.serif, fontSize: 38, lineHeight: 42, letterSpacing: -0.8, textAlign: 'center' }}>
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
  stage: { width: 200, height: 210, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  sheet: { position: 'absolute', width: 132, height: 176, borderRadius: 3 },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm, flexWrap: 'wrap', justifyContent: 'center' },
});
