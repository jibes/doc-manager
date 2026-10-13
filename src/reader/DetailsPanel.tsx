import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Button, T } from '@/components/primitives';
import { fonts, radius, space, type Palette } from '@/design/tokens';
import { t } from '@/i18n';
import type { Details } from '@/archive/pdfInfo';
import { Panel } from './Panel';

/** A document's details as kept in the PDF: title, sender, type, date and tags. */
export function DetailsPanel({ palette: p, initial, busy, onSave, onClose }: { palette: Palette; initial: Details; busy: boolean; onSave: (d: Details) => void; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [tag, setTag] = useState('');
  const [bad, setBad] = useState(false);
  const set = (patch: Partial<Details>) => setD((x) => ({ ...x, ...patch }));
  const addTag = (raw: string) => {
    const words = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (words.length) set({ tags: [...new Set([...d.tags, ...words])] });
    setTag('');
  };
  const save = () => {
    const date = d.date.trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return setBad(true);
    // A tag still being typed counts.
    const tags = tag.trim() ? [...new Set([...d.tags, ...tag.split(',').map((s) => s.trim()).filter(Boolean)])] : d.tags;
    onSave({ ...d, date, tags });
  };
  const field = (testID: string, label: string, value: string, onChange: (v: string) => void, placeholder?: string) => (
    <View style={{ gap: space.xs }}>
      <T v="caption" color={p.muted}>
        {label}
      </T>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.canvas }]}
      />
    </View>
  );

  return (
    <Panel title={t.details} onClose={onClose} testID="details-panel">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl - 4, paddingBottom: space.xl, gap: space.lg }}>
        {field('detail-title', t.detailTitle, d.title, (title) => set({ title }))}
        {field('detail-sender', t.detailSender, d.sender, (sender) => set({ sender }))}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>{field('detail-type', t.detailType, d.type, (type) => set({ type }), t.detailTypeHint)}</View>
          <View style={{ width: 140 }}>
            {field('detail-date', t.detailDate, d.date, (date) => (setBad(false), set({ date })), t.detailDateHint)}
          </View>
        </View>
        {bad && (
          <T v="caption" color={p.markRing}>
            {t.detailsBadDate}
          </T>
        )}
        <View style={{ gap: space.xs }}>
          <T v="caption" color={p.muted}>
            {t.detailTags}
          </T>
          <View style={[styles.tags, { borderColor: p.hairline, backgroundColor: p.canvas }]}>
            {d.tags.map((x) => (
              <Pressable key={x} testID="detail-tag" accessibilityRole="button" accessibilityLabel={t.removeTag(x)} onPress={() => set({ tags: d.tags.filter((y) => y !== x) })} style={[styles.chip, { backgroundColor: p.accentSoft }]}>
                <T v="label" color={p.accent}>
                  {x}
                </T>
                <Icon name="close" size={14} color={p.accent} />
              </Pressable>
            ))}
            <TextInput
              testID="detail-tag-input"
              value={tag}
              onChangeText={(v) => (v.endsWith(',') ? addTag(v) : setTag(v))}
              onSubmitEditing={() => addTag(tag)}
              blurOnSubmit={false}
              placeholder={t.detailAddTag}
              placeholderTextColor={p.muted}
              style={[styles.tagInput, { color: p.ink }]}
            />
          </View>
        </View>
        <T v="caption" color={p.muted}>
          {t.detailsNote}
        </T>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Button testID="details-save" label={t.save} icon="check" onPress={busy ? undefined : save} />
        </View>
      </ScrollView>
    </Panel>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, height: 40, fontFamily: fonts.sans, fontSize: 15 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.sm, padding: space.xs, minHeight: 40 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 4 },
  tagInput: { flexGrow: 1, minWidth: 120, height: 30, fontFamily: fonts.sans, fontSize: 15, outlineStyle: 'none' } as object,
});
