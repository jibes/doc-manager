import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { lang, opError, t } from '@/core/i18n';
import { fonts, radius, space, type Palette } from '@/core/design/tokens';
import { defaultKinds, type Kinds, type Named } from '@/paper/archive/kindList';
import { loadKinds, saveKinds, useKinds } from '@/paper/archive/kinds';
import { SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Icon } from '@/paper/components/Icon';
import { Button, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { usePalette, usePrefs } from '@/paper/state/prefs';

/**
 * The types and tags the model may give (kindList.ts): each a name and a description of where its line runs.
 * Types are a fixed list (the last one for what fits none); tags are preferred, or, switched on, the only ones.
 */
export default function KindsScreen() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const stored = useKinds((s) => s.kinds);
  const [draft, setDraft] = useState<Kinds | null>(null);
  const [saving, setSaving] = useState(false);
  const { notice, id: noticeId, say, dismiss } = useNotice();
  useEffect(() => void loadKinds().catch(() => {}), []);
  const kinds = draft ?? stored;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(stored);
  const edit = (patch: Partial<Kinds>) => setDraft({ ...kinds, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      await saveKinds(kinds);
      setDraft(null);
      say(t.kindsSaved);
    } catch (e) {
      say(opError(e));
    } finally {
      setSaving(false);
    }
  };
  const up = () => (router.canGoBack() ? router.back() : router.replace('/settings'));

  return (
    <SubFrame sub="kinds">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column, gap: space.md }}>
          <ScreenHeader over={t.settings} title={t.kindsTitle} up={up} />
          <T v="caption" color={p.muted}>
            {t.kindsWhere(!!archive)}
          </T>

          <T v="kicker" color={p.muted} style={{ marginTop: space.lg }}>
            {t.kindsTypes}
          </T>
          <T color={p.muted}>{t.kindsTypesNote}</T>
          <List palette={p} testID="kind-type" list={kinds.types} onChange={(types) => edit({ types })} />
          <View style={styles.actions}>
            <Button testID="kinds-reset" kind="quiet" label={t.kindsReset} onPress={() => edit({ types: defaultKinds(lang).types })} />
            <Button testID="kinds-add-type" kind="quiet" icon="plus" label={t.kindsAddType} onPress={() => edit({ types: [...kinds.types, { name: '', about: '' }] })} />
          </View>

          <T v="kicker" color={p.muted} style={{ marginTop: space.xl }}>
            {t.kindsTags}
          </T>
          <T color={p.muted}>{t.kindsTagsNote}</T>
          {kinds.tags.length > 0 && <List palette={p} testID="kind-tag" list={kinds.tags} onChange={(tags) => edit({ tags, onlyTags: kinds.onlyTags && tags.length > 0 })} />}
          <View style={styles.actions}>
            <Button testID="kinds-add-tag" kind="quiet" icon="plus" label={t.kindsAddTag} onPress={() => edit({ tags: [...kinds.tags, { name: '', about: '' }] })} />
          </View>
          <Pressable
            testID="kinds-only-tags"
            accessibilityRole="switch"
            accessibilityLabel={t.kindsOnlyTags}
            aria-checked={kinds.onlyTags}
            disabled={!kinds.tags.some((x) => x.name.trim())}
            onPress={() => edit({ onlyTags: !kinds.onlyTags })}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.card, styles.row, { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline }]}
          >
            <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
              {t.kindsOnlyTags}
            </T>
            <View style={[styles.track, { backgroundColor: kinds.onlyTags ? p.accent : p.muted }]}>
              <View style={[styles.knob, { backgroundColor: p.surface, transform: [{ translateX: kinds.onlyTags ? 18 : 0 }] }]} />
            </View>
          </Pressable>

          <View style={[styles.actions, { marginTop: space.lg }]}>
            {dirty && <Button kind="quiet" label={t.cancel} disabled={saving} onPress={() => setDraft(null)} />}
            <Button testID="kinds-save" label={t.kindsSave} disabled={!dirty || saving || !kinds.types.some((x) => x.name.trim())} onPress={() => void save()} />
          </View>
        </View>
      </ScrollView>
      <Toast message={notice} id={noticeId} onDismiss={dismiss} />
    </SubFrame>
  );
}

/** Rows of a name and its description, each editable and removable. */
function List({ palette: p, testID, list, onChange }: { palette: Palette; testID: string; list: Named[]; onChange: (next: Named[]) => void }) {
  const set = (i: number, patch: Partial<Named>) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
      {list.map((x, i) => (
        <View key={i} testID={testID} style={[styles.item, i > 0 && styles.line, { borderColor: p.hairline }]}>
          <View style={{ flex: 1, gap: space.xs }}>
            <TextInput
              testID={`${testID}-name`}
              value={x.name}
              onChangeText={(name) => set(i, { name })}
              placeholder={t.kindsName}
              placeholderTextColor={p.muted}
              style={[styles.input, { color: p.ink, fontFamily: fonts.sansMedium }]}
            />
            <TextInput
              testID={`${testID}-about`}
              value={x.about}
              onChangeText={(about) => set(i, { about })}
              placeholder={t.kindsAbout}
              placeholderTextColor={p.muted}
              multiline
              style={[styles.input, { color: p.muted, fontSize: 13 }]}
            />
          </View>
          <Pressable testID={`${testID}-remove`} accessibilityRole="button" accessibilityLabel={t.kindsRemove} hitSlop={8} onPress={() => onChange(list.filter((_, j) => j !== i))} style={styles.remove}>
            <Icon name="close" size={16} color={p.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm },
  line: { borderTopWidth: StyleSheet.hairlineWidth },
  input: { fontFamily: fonts.sans, fontSize: 15, paddingVertical: 2 },
  remove: { padding: space.xs, marginTop: 2 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, flexWrap: 'wrap' },
  track: { width: 40, height: 22, borderRadius: 11, padding: 2 },
  knob: { width: 18, height: 18, borderRadius: 9 },
});
