import { View } from 'react-native';

import { T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePalette } from '@/state/prefs';

/** Native builds: scanning lives in the web app (and the Android app). */
export function Unsupported() {
  const p = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: p.canvas, padding: space.xl }}>
      <ScreenHeader title={t.scan} />
      <T color={p.muted}>{t.scanUnsupported}</T>
    </View>
  );
}
