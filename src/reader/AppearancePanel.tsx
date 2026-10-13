import { Pressable, StyleSheet, View } from 'react-native';

import { t } from '@/i18n';
import { IconButton, T, tick } from '@/components/primitives';
import { fonts, palettes, radius, space, type Palette, type ThemeName } from '@/design/tokens';
import { usePalette, usePrefs, type Appearance, type FitMode, type TextFont, type TextLeading, type TextWidth } from '@/state/prefs';
import { hasLightSensor } from '@/state/ambient';
import { Panel } from './Panel';

type Choice = Appearance;
const LABEL: Record<Choice, () => string> = { light: () => t.appearanceLight, dark: () => t.appearanceDark, auto: () => t.appearanceAuto };
/** Ink on the preview page: printed black, dimmed with the page in Dark. */
const PAGE_INK: Record<ThemeName, string> = { light: '#1B1A17', dark: '#26231F' };

function Swatch({ name, selected, onPress }: { name: Choice; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  // Auto shows both halves: what it switches between.
  const halves: ThemeName[] = name === 'auto' ? ['light', 'dark'] : [name];
  return (
    <Pressable
      testID={`appearance-${name}`}
      accessibilityRole="radio"
      aria-checked={selected}
      accessibilityLabel={name === 'auto' ? (hasLightSensor ? t.appearanceAutoSensorA11y : t.appearanceAutoA11y) : LABEL[name]()}
      onPress={() => {
        tick();
        onPress();
      }}
      style={{ flex: 1, maxWidth: 88, alignItems: 'center', gap: 6 }}
    >
      <View style={[styles.swatch, { borderColor: selected ? p.accent : p.hairline, borderWidth: selected ? 2 : 1 }]}>
        <View style={{ flex: 1, flexDirection: 'row', borderRadius: radius.sm - 2, overflow: 'hidden' }}>
          {halves.map((h) => (
            <View key={h} style={{ flex: 1, backgroundColor: palettes[h].canvas, alignItems: 'center', justifyContent: 'center' }}>
              <View style={[styles.mini, { backgroundColor: palettes[h].page.base }]}>
                <T style={{ fontFamily: fonts.serif, fontSize: 15, color: PAGE_INK[h] }}>Aa</T>
              </View>
            </View>
          ))}
        </View>
      </View>
      <T v="caption" color={selected ? p.ink : p.muted} style={{ fontFamily: fonts.sansMedium }}>
        {LABEL[name]()}
      </T>
    </Pressable>
  );
}

/** Light, Dark or Auto (the system's mode, or the light sensor where there is one). */
export function AppearancePicker() {
  const { appearance, set } = usePrefs();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup">
      {(['light', 'dark', 'auto'] as const).map((n) => (
        <Swatch key={n} name={n} selected={appearance === n} onPress={() => set({ appearance: n })} />
      ))}
    </View>
  );
}

/** Segmented control used by the layout and text settings. */
function Segment<K extends string>({
  p,
  value,
  options,
  onChange,
}: {
  p: Palette;
  value: K;
  options: [K, string][];
  onChange: (k: K) => void;
}) {
  return (
    <View style={[styles.segment, { backgroundColor: p.hairline }]}>
      {options.map(([k, label]) => (
        <Pressable
          key={k}
          accessibilityRole="radio"
          aria-checked={value === k}
          onPress={() => onChange(k)}
          style={[styles.segBtn, value === k && { backgroundColor: p.raised }]}
        >
          <T v="label" color={value === k ? p.ink : p.muted}>
            {label}
          </T>
        </Pressable>
      ))}
    </View>
  );
}

function TextSettings({ p }: { p: Palette }) {
  const { textFont, textScale, textLeading, textWidth, set } = usePrefs();
  const scale = (d: number) => set({ textScale: Math.min(1.8, Math.max(0.75, Math.round((textScale + d) * 100) / 100)) });
  return (
    <>
      <View style={{ gap: space.sm }}>
        <T v="kicker" color={p.muted}>
          {t.font}
        </T>
        <Segment<TextFont>
          p={p}
          value={textFont}
          options={[
            ['serif', t.serif],
            ['sans', t.sans],
          ]}
          onChange={(k) => set({ textFont: k })}
        />
      </View>
      <View style={{ gap: space.sm }}>
        <T v="kicker" color={p.muted}>
          {t.size}
        </T>
        <View style={styles.zoom}>
          <IconButton icon="zoomOut" label={t.smaller} onPress={() => scale(-0.1)} disabled={textScale <= 0.75} testID="text-smaller" />
          <Pressable onPress={() => set({ textScale: 1 })} accessibilityLabel={t.size} style={styles.zoomVal}>
            <T v="numeral" style={{ fontSize: 15 }}>
              {Math.round(textScale * 100)}%
            </T>
          </Pressable>
          <IconButton icon="zoomIn" label={t.larger} onPress={() => scale(0.1)} disabled={textScale >= 1.8} testID="text-larger" />
        </View>
      </View>
      <View style={{ gap: space.sm }}>
        <T v="kicker" color={p.muted}>
          {t.lineSpacing}
        </T>
        <Segment<TextLeading>
          p={p}
          value={textLeading}
          options={(['compact', 'normal', 'relaxed'] as const).map((k) => [k, t.leading[k]])}
          onChange={(k) => set({ textLeading: k })}
        />
      </View>
      <View style={{ gap: space.sm }}>
        <T v="kicker" color={p.muted}>
          {t.width}
        </T>
        <Segment<TextWidth>
          p={p}
          value={textWidth}
          options={(['narrow', 'medium', 'wide'] as const).map((k) => [k, t.widths[k]])}
          onChange={(k) => set({ textWidth: k })}
        />
      </View>
    </>
  );
}

export function AppearancePanel({
  palette: p,
  view,
  zoom,
  onZoom,
  onClose,
}: {
  palette: Palette;
  view: 'page' | 'text';
  zoom: number;
  onZoom: (z: number) => void;
  onClose: () => void;
}) {
  const { fit, set } = usePrefs();
  const fits: [FitMode, string][] = [
    ['width', t.fitWidth],
    ['page', t.fitPage],
  ];
  return (
    <Panel title={t.appearance} onClose={onClose} compact testID="appearance-panel">
      <View style={{ paddingHorizontal: space.xl - 4, paddingBottom: space.xl, gap: space.xl }}>
        <AppearancePicker />

        {view === 'text' ? (
          <TextSettings p={p} />
        ) : (
          <>
            <View style={{ gap: space.sm }}>
              <T v="kicker" color={p.muted}>
                {t.layout}
              </T>
              <Segment<FitMode>
                p={p}
                value={fit}
                options={fits}
                onChange={(k) => {
                  set({ fit: k });
                  onZoom(1);
                }}
              />
            </View>

            <View style={{ gap: space.sm }}>
              <T v="kicker" color={p.muted}>
                {t.zoom}
              </T>
              <View style={styles.zoom}>
                <IconButton icon="zoomOut" label={t.zoomOut} onPress={() => onZoom(zoom / 1.2)} disabled={zoom <= 0.5} />
                <Pressable onPress={() => onZoom(1)} accessibilityLabel={t.resetZoom} style={styles.zoomVal}>
                  <T v="numeral" style={{ fontSize: 15 }}>
                    {Math.round(zoom * 100)}%
                  </T>
                </Pressable>
                <IconButton icon="zoomIn" label={t.zoomIn} onPress={() => onZoom(zoom * 1.2)} disabled={zoom >= 4} />
              </View>
            </View>
          </>
        )}
      </View>
    </Panel>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', justifyContent: 'space-between', gap: space.xs },
  swatch: { width: '100%', height: 72, borderRadius: radius.sm, padding: 3 },
  mini: { width: '78%', maxWidth: 24, height: 32, borderRadius: 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  segment: { flexDirection: 'row', borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  zoom: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  zoomVal: { minWidth: 64, alignItems: 'center' },
});
