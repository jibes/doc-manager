import { Pressable, StyleSheet } from 'react-native';

import { space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePalette } from '@/state/prefs';
import { Icon } from './Icon';
import { T } from './primitives';

/** The order a list is in, beside its count; a tap offers the others. */
export function SortChip({ label, onPress, testID = 'sort' }: { label: string; onPress: () => void; testID?: string }) {
  const p = usePalette();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${t.sortTitle}: ${label}`} onPress={onPress} hitSlop={8} style={styles.sort}>
      <Icon name="sort" size={15} color={p.inkSoft} />
      <T v="label" color={p.inkSoft}>
        {label}
      </T>
    </Pressable>
  );
}

/** Starts picking documents from the list (a long press does too). */
export function SelectChip({ onPress }: { onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable testID="select" accessibilityRole="button" onPress={onPress} hitSlop={8} style={styles.sort}>
      <Icon name="select" size={15} color={p.inkSoft} />
      <T v="label" color={p.inkSoft}>
        {t.select}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sort: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32 },
});
