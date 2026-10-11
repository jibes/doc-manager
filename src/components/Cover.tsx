import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import { elevation, radius } from '@/design/tokens';
import { usePalette } from '@/state/prefs';

/**
 * Page-1 cover rendered as a physical object: soft lift, hairline edge,
 * and a faint binding shadow on the left so a flat PDF reads as a held thing.
 */
export function Cover({ uri, aspect, width, progress }: { uri: string | null | undefined; aspect: number; width: number; progress?: number }) {
  const p = usePalette();
  const height = Math.round(width * Math.min(Math.max(aspect, 0.5), 1.8));
  return (
    <View style={{ width, height }}>
      <View
        style={[
          { width, height, borderRadius: radius.cover, backgroundColor: '#FFFFFF', overflow: 'hidden' },
          elevation(p.shadow, 2),
        ]}
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={[StyleSheet.absoluteFill, p.dark && { opacity: 0.88 }]}
            contentFit="cover"
            transition={180}
            recyclingKey={uri}
          />
        ) : null}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.binding]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.cover, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.12)' }]} />
      </View>
      {progress != null && progress > 0 ? (
        <View style={[styles.track, { backgroundColor: p.hairline }]}>
          <View style={{ width: `${Math.round(Math.min(1, progress) * 100)}%`, height: '100%', backgroundColor: p.accent, borderRadius: 2 }} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  binding: {
    experimental_backgroundImage:
      'linear-gradient(90deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.02) 4%, rgba(255,255,255,0.08) 6%, rgba(0,0,0,0) 12%)',
  },
  track: { position: 'absolute', left: 0, right: 0, bottom: -9, height: 2, borderRadius: 2, overflow: 'hidden' },
});
