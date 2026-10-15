import { StyleSheet, View } from 'react-native';

import { elevation } from '@/design/tokens';
import { usePalette } from '@/state/prefs';

/**
 * How a switch looks, in the app's colours, for a row that is the switch as a whole (role "switch" on the row:
 * one control and one tap target, its text included). The platform's own switch shows no track when off on the
 * web, and a teal knob.
 */
export function Knob({ on, disabled }: { on: boolean; disabled?: boolean }) {
  const p = usePalette();
  return (
    <View aria-hidden importantForAccessibility="no-hide-descendants" style={[styles.track, { backgroundColor: on ? p.accent : p.muted, opacity: disabled ? 0.45 : 1 }]}>
      <View style={[styles.thumb, { transform: [{ translateX: on ? TRAVEL : 0 }] }, elevation(p.shadow, 1)]} />
    </View>
  );
}

const TRAVEL = 18;

const styles = StyleSheet.create({
  track: { width: 42, height: 24, borderRadius: 12, padding: 3, justifyContent: 'center' },
  thumb: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF', transitionDuration: '120ms' } as object,
});
