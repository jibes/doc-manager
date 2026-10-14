import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { elevation, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { usePalette } from '@/state/prefs';
import { Icon, type IconName } from './Icon';
import { IconButton, T } from './primitives';

/**
 * Picking several items to act on them at once, the same in the file browser, Documents and Reading: a long
 * press (or a right click) starts it, taps add and remove, the bar at the top counts them, the one at the
 * bottom acts on them.
 */

/** The item a long press selected, and when: its follow-up events (context menu, release) don't toggle it back. */
let holdAt = { id: '', at: 0 };
export const justSelected = (id: string) => holdAt.id === id && Date.now() - holdAt.at < 800;
export const heldNow = (id: string) => {
  holdAt = { id, at: Date.now() };
};

/** A set with `id` added or taken out. */
export function toggled(set: Set<string> | null, id: string): Set<string> {
  const next = new Set(set ?? []);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Picking: which ids are picked (null: not picking), and the gestures that change it. */
export function usePicking() {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  return {
    selected,
    setSelected,
    /** Picked, or undefined when not picking (as items take it). */
    of: (id: string) => (selected ? selected.has(id) : undefined),
    /** A long press or right click: starts picking, or picks one more. */
    hold: (id: string) => {
      if (justSelected(id)) return;
      heldNow(id);
      setSelected((s) => (s ? toggled(s, id) : new Set([id])));
    },
    /** A tap while picking (not the release of the long press that started it). */
    tap: (id: string) => {
      if (!justSelected(id)) setSelected((s) => toggled(s, id));
    },
  };
}

/** Instead of the screen's header while selecting: Cancel, how many, Select all. */
export function SelectBar({ count, onCancel, onAll }: { count: number; onCancel: () => void; onAll: () => void }) {
  return (
    <View style={styles.selectBar}>
      <IconButton testID="select-cancel" icon="close" label={t.cancel} onPress={onCancel} style={{ marginLeft: -space.sm }} />
      <T v="headline" style={{ flex: 1, fontSize: 17 }}>
        {t.selectedCount(count)}
      </T>
      <IconButton testID="select-all" icon="select" label={t.selectAll} onPress={onAll} />
    </View>
  );
}

/** The actions for what is selected, floating over the bottom of the screen. */
/** `side`: its distance from the screen's edges where it isn't inside the screen's own margins. */
export function ActionBar({ bottom, side = 0, children }: { bottom: number; side?: number; children: ReactNode }) {
  const p = usePalette();
  return (
    <View
      testID="action-bar"
      style={[styles.bar, { bottom: bottom + space.lg, left: side, right: side, backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}
    >
      {children}
    </View>
  );
}

export function Action({ icon, label, disabled, onPress, testID }: { icon: IconName; label: string; disabled?: boolean; onPress: () => void; testID: string }) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.action,
        { opacity: disabled ? 0.35 : pressed ? 0.6 : 1, backgroundColor: hovered && !disabled ? p.hairline : 'transparent' },
      ]}
    >
      <Icon name={icon} size={22} color={p.ink} />
      <T v="caption" numberOfLines={1} style={{ fontSize: 11 }}>
        {label}
      </T>
    </Pressable>
  );
}

/** The round mark on a selectable item: empty, or ticked. */
export function Check({ on, style }: { on: boolean; style?: object }) {
  const p = usePalette();
  return (
    <View pointerEvents="none" style={[styles.check, { backgroundColor: on ? p.accent : p.surface, borderColor: on ? p.accent : p.muted }, elevation(p.shadow, 1), style]}>
      {on && <Icon name="check" size={16} color={p.surface} strokeWidth={2.4} />}
    </View>
  );
}

const styles = StyleSheet.create({
  selectBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52, marginBottom: space.lg },
  bar: {
    position: 'absolute',
    // Centred on wide screens.
    maxWidth: 560,
    marginHorizontal: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.sm,
    paddingHorizontal: space.xs,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  action: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: space.xs, paddingHorizontal: 2, borderRadius: radius.md },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});
