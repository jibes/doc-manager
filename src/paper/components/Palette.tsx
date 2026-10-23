import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { elevation, fonts, radius, space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { usePalette } from '@/paper/state/prefs';
import { Icon, type IconName } from './Icon';
import { T } from './primitives';

export type PaletteItem = { key: string; icon: IconName; label: string; hint?: string; run: () => void };

/** What is shown at most: the best matches first (in the order given). */
const SHOWN = 12;

/**
 * ⌘K: one field to go anywhere: a document by its title, a tag, sender or type to filter by, or an action.
 * ↑ ↓ pick, Enter goes, Esc closes.
 */
export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const found = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items.slice(0, SHOWN);
    // Words in any order; a label starting with the query first.
    const words = q.split(/\s+/);
    const hits = items.filter((it) => words.every((w) => `${it.label} ${it.hint ?? ''}`.toLocaleLowerCase().includes(w)));
    return [...hits.filter((it) => it.label.toLocaleLowerCase().startsWith(q)), ...hits.filter((it) => !it.label.toLocaleLowerCase().startsWith(q))].slice(0, SHOWN);
  }, [items, query]);
  const at = Math.min(active, Math.max(0, found.length - 1));
  const go = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <View style={StyleSheet.absoluteFill} testID="palette">
      <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel={t.close} style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]} onPress={onClose} />
      </Animated.View>
      <View style={[styles.box, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]} accessibilityRole="search" accessibilityLabel={t.palette}>
        <View style={[styles.field, { borderColor: p.hairline }]}>
          <Icon name="search" size={18} color={p.muted} />
          <TextInput
            testID="palette-input"
            autoFocus
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setActive(0);
            }}
            placeholder={t.palettePlaceholder}
            placeholderTextColor={p.muted}
            accessibilityLabel={t.palette}
            onSubmitEditing={() => go(found[at])}
            onKeyPress={(e) => {
              if (Platform.OS !== 'web') return;
              const key = (e.nativeEvent as { key: string }).key;
              if (key === 'ArrowDown' || key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (Math.min(a, found.length - 1) + (key === 'ArrowDown' ? 1 : -1) + found.length) % Math.max(1, found.length));
              } else if (key === 'Escape') onClose();
            }}
            style={[styles.input, { color: p.ink }]}
          />
        </View>
        <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled">
          {found.length ? (
            found.map((it, i) => (
              <Pressable
                key={it.key}
                testID={`palette-${it.key}`}
                accessibilityRole="button"
                aria-selected={i === at}
                onPress={() => go(it)}
                onHoverIn={() => setActive(i)}
                style={[styles.item, i === at && { backgroundColor: p.hairline }]}
              >
                <Icon name={it.icon} size={18} color={p.ink} />
                <T v="label" numberOfLines={1} style={{ flex: 1 }}>
                  {it.label}
                </T>
                {it.hint ? (
                  <T v="caption" color={p.muted} numberOfLines={1} style={{ maxWidth: 200 }}>
                    {it.hint}
                  </T>
                ) : null}
              </Pressable>
            ))
          ) : (
            <T v="caption" color={p.muted} style={{ padding: space.lg }}>
              {t.paletteNone}
            </T>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { position: 'absolute', top: '12%', alignSelf: 'center', width: 560, maxWidth: '92%', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  field: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, height: 54, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minWidth: 0, height: 54, fontFamily: fonts.sans, fontSize: 16, outlineStyle: 'none' } as object,
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, height: 42, paddingHorizontal: space.lg },
});
