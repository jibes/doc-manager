import { View } from 'react-native';

import { T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { usePalette } from '@/paper/state/prefs';

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
