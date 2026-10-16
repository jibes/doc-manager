import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { usePalette } from '@/paper/state/prefs';
import { IconButton, T } from './primitives';

/** Back to where the user came from, or home when the screen was opened directly. */
export const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * Back button, title (with an optional line above it) and actions on the right; actions too wide to leave the
 * title its room go under it (German labels on a phone). `up`: where Back goes when the screen was opened
 * directly (the screen it belongs to), instead of home.
 */
export function ScreenHeader({ title, over, up, children }: { title: string; over?: string; up?: () => void; children?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={styles.bar}>
      <IconButton testID="screen-back" icon="back" label={t.back} onPress={() => (up && !router.canGoBack() ? up() : goBack())} style={{ marginLeft: -space.sm }} />
      <View style={styles.title}>
        {over ? (
          <T v="caption" color={p.muted} numberOfLines={1}>
            {over}
          </T>
        ) : null}
        <T accessibilityRole="header" v="headline" numberOfLines={2} style={{ fontSize: 17 }}>
          {title}
        </T>
      </View>
      {children ? <View style={styles.actions}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.sm, rowGap: space.xs, minHeight: 52, marginBottom: space.lg },
  // Room for a short title ("Eingang") before the actions move under it.
  title: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 140 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm, marginLeft: 'auto' },
});
