import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePalette } from '@/state/prefs';
import { IconButton, T } from './primitives';

/** Back to where the user came from, or home when the screen was opened directly. */
export const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * Back button, title (with an optional line above it) and actions on the right. `up`: where Back goes when the
 * screen was opened directly (the screen it belongs to), instead of home.
 */
export function ScreenHeader({ title, over, up, children }: { title: string; over?: string; up?: () => void; children?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.bar}>
      <IconButton testID="screen-back" icon="back" label={t.back} onPress={() => (up && !router.canGoBack() ? up() : goBack())} style={{ marginLeft: -space.sm }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        {over ? (
          <T v="caption" color={p.muted} numberOfLines={1}>
            {over}
          </T>
        ) : null}
        <T accessibilityRole="header" v="headline" numberOfLines={2} style={{ fontSize: 17 }}>
          {title}
        </T>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52, marginBottom: space.lg },
});
