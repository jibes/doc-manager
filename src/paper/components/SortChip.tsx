import { Pressable, StyleSheet, View } from 'react-native';

import { space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { usePalette } from '@/paper/state/prefs';
import { Icon } from './Icon';
import { T } from './primitives';

/**
 * The order a list is in, beside its count: the arrow turns it round (up: A–Z, oldest, smallest first), the name
 * offers the others. Without `up` (best matches first) there is no way round to turn.
 */
export function SortChip({ label, up, onPress, onTurn, testID = 'sort' }: { label: string; up?: boolean; onPress: () => void; onTurn?: () => void; testID?: string }) {
  const p = usePalette();
  return (
    <View style={styles.sort}>
      {up !== undefined && onTurn && (
        <Pressable testID={`${testID}-turn`} accessibilityRole="button" accessibilityLabel={up ? t.sortUp : t.sortDown} onPress={onTurn} hitSlop={8} style={styles.turn}>
          <Icon name={up ? 'sortUp' : 'sort'} size={17} color={p.inkSoft} />
        </Pressable>
      )}
      <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${t.sortTitle}: ${label}`} onPress={onPress} hitSlop={8} style={styles.label}>
        {(up === undefined || !onTurn) && <Icon name="sort" size={15} color={p.inkSoft} />}
        <T v="label" color={p.inkSoft}>
          {label}
        </T>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sort: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  turn: { minHeight: 32, minWidth: 28, alignItems: 'center', justifyContent: 'center' },
  label: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32 },
});
