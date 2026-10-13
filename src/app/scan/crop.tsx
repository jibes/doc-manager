import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { T } from '@/components/primitives';
import { goBack } from '@/components/ScreenHeader';
import { radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import type { Quad } from '@/scan/engine/imaging/image';
import { fullQuad, isConvex } from '@/scan/engine/imaging/quad';
import { useScan } from '@/scan/session';
import { CropEditor } from '@/scan/ui/CropEditor';
import { Unsupported } from '@/scan/ui/Unsupported';

/** Drag the page's corners into place. */
export default function ScanCrop() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { pages, loaded, restore, update } = useScan();
  const page = pages.find((p) => p.id === id);
  const [quad, setQuad] = useState<Quad | null>(null);
  useEffect(() => void restore(), [restore]);
  useEffect(() => {
    if (loaded && !page) goBack();
  }, [loaded, page]);

  if (Platform.OS !== 'web') return <Unsupported />;
  if (!page) return <View style={styles.screen} />;
  const shown = quad ?? page.spec.quad;
  const valid = isConvex(shown);

  return (
    <View style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <Pressable accessibilityRole="button" onPress={goBack} style={styles.text}>
          <T v="label" color="#fff">
            {t.cancel}
          </T>
        </Pressable>
        <T v="headline" color="#fff">
          {t.scanCrop}
        </T>
        <Pressable
          testID="scan-crop-done"
          accessibilityRole="button"
          disabled={!valid}
          onPress={() => {
            update(page.id, { quad: shown });
            goBack();
          }}
          style={[styles.done, { opacity: valid ? 1 : 0.4 }]}
        >
          <T v="label" color="#111">
            {t.done}
          </T>
        </Pressable>
      </View>
      <CropEditor page={page} quad={shown} onChange={setQuad} />
      <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
        <Pressable accessibilityRole="button" disabled={!page.detected} onPress={() => page.detected && setQuad(page.detected)} style={[styles.tool, { opacity: page.detected ? 1 : 0.4 }]}>
          <Icon name="scan" color="#fff" size={20} />
          <T v="label" color="#fff">
            {t.scanDetected}
          </T>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setQuad(fullQuad(page.width, page.height))} style={styles.tool}>
          <Icon name="crop" color="#fff" size={20} />
          <T v="label" color="#fff">
            {t.scanFullPhoto}
          </T>
        </Pressable>
        <T v="caption" color="#FF8A7A" accessibilityLiveRegion="polite" style={{ flex: 1, textAlign: 'right' }}>
          {valid ? '' : t.scanCornersCross}
        </T>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000', userSelect: 'none' } as object,
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.sm },
  text: { paddingVertical: space.sm, paddingRight: space.md },
  done: { backgroundColor: '#fff', borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.lg, paddingTop: space.md },
  tool: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
});
