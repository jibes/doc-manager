import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { T } from '@/components/primitives';
import { radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePalette } from '@/state/prefs';
import type { FilterId } from '../engine/imaging/filters';

export const FILTERS: FilterId[] = ['document', 'bw', 'gray', 'color', 'original'];

/** The page filters as a row of choices. `value` null: the pages differ. `disabled`: nothing to apply them to. */
export function FilterChips({ value, onChange, dark, disabled }: { value: FilterId | null; onChange: (f: FilterId) => void; dark?: boolean; disabled?: boolean }) {
  const p = usePalette();
  const ink = dark ? '#fff' : p.ink;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel={t.scanFilter} contentContainerStyle={styles.row}>
      {FILTERS.map((f) => {
        const on = value === f;
        return (
          <Pressable
            key={f}
            testID={`scan-filter-${f}`}
            role="radio"
            aria-checked={on}
            disabled={disabled}
            // @ts-expect-error web-only tooltip
            title={t.scanFilterHints[f]}
            onPress={() => onChange(f)}
            style={[styles.chip, { borderColor: on ? ink : dark ? 'rgba(255,255,255,0.3)' : p.hairline, backgroundColor: on ? ink : 'transparent', opacity: disabled ? 0.4 : 1 }]}
          >
            <T v="label" color={on ? (dark ? '#111' : p.canvas) : ink}>
              {t.scanFilters[f]}
            </T>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: space.sm, paddingVertical: space.xs },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.lg - 2, paddingVertical: space.sm },
});
