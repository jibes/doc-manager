import { Pressable, StyleSheet, View } from 'react-native';

import { IconButton, T, tick } from '@/components/primitives';
import { fonts, palettes, radius, space, type Palette, type ThemeName } from '@/design/tokens';
import { usePalette, usePrefs, type FitMode } from '@/state/prefs';
import { Panel } from './Panel';

const PAGE_TINT: Record<ThemeName, string> = { paper: '#FFFFFF', sepia: '#F3E6CC', dusk: '#3A3A3C', night: '#1A1A1A' };
const PAGE_INK: Record<ThemeName, string> = { paper: '#1B1A17', sepia: '#3A2E20', dusk: '#E2DED5', night: '#CFCAC0' };

function Swatch({ name, selected, onPress }: { name: ThemeName | null; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  const halves: ThemeName[] = name ? [name] : ['paper', 'dusk'];
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={name ? palettes[name].label : 'Automatic'}
      onPress={() => {
        tick();
        onPress();
      }}
      style={{ alignItems: 'center', gap: 6 }}
    >
      <View style={[styles.swatch, { borderColor: selected ? p.accent : p.hairline, borderWidth: selected ? 2 : 1 }]}>
        <View style={{ flex: 1, flexDirection: 'row', borderRadius: radius.sm - 2, overflow: 'hidden' }}>
          {halves.map((h) => (
            <View key={h} style={{ flex: 1, backgroundColor: palettes[h].canvas, alignItems: 'center', justifyContent: 'center' }}>
              <View style={[styles.mini, { backgroundColor: PAGE_TINT[h] }]}>
                <T style={{ fontFamily: fonts.serif, fontSize: 15, color: PAGE_INK[h] }}>Aa</T>
              </View>
            </View>
          ))}
        </View>
      </View>
      <T v="caption" color={selected ? p.ink : p.muted} style={{ fontFamily: fonts.sansMedium }}>
        {name ? palettes[name].label : 'Auto'}
      </T>
    </Pressable>
  );
}

export function AppearancePanel({ palette: p, zoom, onZoom, onClose }: { palette: Palette; zoom: number; onZoom: (z: number) => void; onClose: () => void }) {
  const { theme, fit, set } = usePrefs();
  const fits: [FitMode, string][] = [
    ['width', 'Fit width'],
    ['page', 'Fit page'],
  ];
  return (
    <Panel title="Appearance" onClose={onClose} compact testID="appearance-panel">
      <View style={{ paddingHorizontal: space.xl - 4, paddingBottom: space.xl, gap: space.xl }}>
        <View style={styles.swatches} accessibilityRole="radiogroup">
          {([null, 'paper', 'sepia', 'dusk', 'night'] as (ThemeName | null)[]).map((n) => (
            <Swatch key={n ?? 'auto'} name={n} selected={theme === n} onPress={() => set({ theme: n })} />
          ))}
        </View>

        <View style={{ gap: space.sm }}>
          <T v="kicker" color={p.muted}>Layout</T>
          <View style={[styles.segment, { backgroundColor: p.hairline }]}>
            {fits.map(([k, label]) => (
              <Pressable
                key={k}
                accessibilityRole="radio"
                accessibilityState={{ selected: fit === k }}
                onPress={() => {
                  set({ fit: k });
                  onZoom(1);
                }}
                style={[styles.segBtn, fit === k && { backgroundColor: p.raised }]}
              >
                <T v="label" color={fit === k ? p.ink : p.muted}>{label}</T>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ gap: space.sm }}>
          <T v="kicker" color={p.muted}>Zoom</T>
          <View style={styles.zoom}>
            <IconButton icon="zoomOut" label="Zoom out" onPress={() => onZoom(zoom / 1.2)} disabled={zoom <= 0.5} />
            <Pressable onPress={() => onZoom(1)} accessibilityLabel="Reset zoom" style={styles.zoomVal}>
              <T v="numeral" style={{ fontSize: 15 }}>{Math.round(zoom * 100)}%</T>
            </Pressable>
            <IconButton icon="zoomIn" label="Zoom in" onPress={() => onZoom(zoom * 1.2)} disabled={zoom >= 4} />
          </View>
        </View>
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', justifyContent: 'space-between' },
  swatch: { width: 58, height: 72, borderRadius: radius.sm, padding: 3 },
  mini: { width: 24, height: 32, borderRadius: 2, alignItems: 'center', justifyContent: 'center' },
  segment: { flexDirection: 'row', borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  zoom: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  zoomVal: { minWidth: 64, alignItems: 'center' },
});
