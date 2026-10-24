import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { fonts, radius, space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { Icon } from '@/paper/components/Icon';
import { Button, T } from '@/paper/components/primitives';
import { discardDetails } from '@/paper/reader/drafts';
import { Panel } from '@/paper/reader/Panel';
import { usePalette } from '@/paper/state/prefs';
import { sharedDetails, writeDetailsMany, type DetailsChange } from './manyDetails';
import type { IndexedDoc } from './search';

/**
 * Details of several documents at once: what they share is shown (a field that differs says so); only what is
 * changed here is written into each of them.
 */
export function ManyDetails({ docs, onClose, onDone }: { docs: IndexedDoc[]; onClose: () => void; onDone: (message: string) => void }) {
  const p = usePalette();
  const shared = useMemo(() => sharedDetails(docs), [docs]);
  const [sender, setSender] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [tags, setTags] = useState(shared.tags);
  const [tag, setTag] = useState('');
  const [bad, setBad] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Closed with changes not saved: asked first, as the details of one document are.
  const changed = sender !== null || type !== null || date !== null || tag.trim() !== '' || tags.join('\n') !== shared.tags.join('\n');
  const asking = useRef(false);
  const close = async () => {
    if (asking.current) return;
    asking.current = true;
    const go = !changed || (await discardDetails());
    asking.current = false;
    if (go) onClose();
  };
  // Escape closes it (before the list under it reacts); not while it asks.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || asking.current) return;
      e.preventDefault();
      e.stopPropagation();
      void close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const addTag = (raw: string) => {
    const words = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (words.length) setTags((x) => [...new Set([...x, ...words])]);
    setTag('');
  };
  const save = async () => {
    const day = date?.trim();
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return setBad(true);
    const all = tag.trim() ? [...new Set([...tags, ...tag.split(',').map((s) => s.trim()).filter(Boolean)])] : tags;
    const change: DetailsChange = {
      ...(sender !== null ? { sender: sender.trim() } : {}),
      ...(type !== null ? { type: type.trim() } : {}),
      ...(date !== null ? { date: day } : {}),
      add: all.filter((x) => !shared.tags.includes(x)),
      remove: shared.tags.filter((x) => !all.includes(x)),
    };
    setProgress({ done: 0, total: docs.length });
    const { failed, changed } = await writeDetailsMany(docs, change, (done, total) => setProgress({ done, total }));
    setProgress(null);
    onDone(failed ? t.detailsManyFailed(failed) : changed ? t.detailsManySaved(changed) : t.detailsManyNone);
  };

  const field = (testID: string, label: string, value: string | null, own: string | null, onChange: (v: string | null) => void, hint?: string) => (
    <View style={{ gap: space.xs, flex: 1 }}>
      <T v="caption" color={p.muted}>
        {label}
      </T>
      <TextInput
        testID={testID}
        value={own ?? value ?? ''}
        // Emptied where each document has its own: left as each has it again (not cleared in all of them).
        onChangeText={(v) => onChange(v === '' && value === null ? null : v)}
        placeholder={value === null ? t.detailsMixed : hint}
        accessibilityLabel={label}
        placeholderTextColor={p.muted}
        style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.canvas }]}
      />
    </View>
  );

  return (
    <Panel title={t.detailsMany(docs.length)} onClose={() => void close()} testID="many-details">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.xl - 4, paddingBottom: space.xl, gap: space.lg }}>
        {field('many-sender', t.detailSender, shared.sender, sender, setSender)}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          {field('many-type', t.detailType, shared.type, type, setType, t.detailTypeHint)}
          <View style={{ width: 140 }}>{field('many-date', t.detailDate, shared.date, date, (v) => (setBad(false), setDate(v)), t.detailDateHint)}</View>
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
            {tags.map((x) => (
              <Pressable key={x} testID="many-tag" accessibilityRole="button" accessibilityLabel={t.removeTag(x)} onPress={() => setTags((all) => all.filter((y) => y !== x))} style={[styles.chip, { backgroundColor: p.accentSoft }]}>
                <T v="label" color={p.accent}>
                  {x}
                </T>
                <Icon name="close" size={14} color={p.accent} />
              </Pressable>
            ))}
            <TextInput
              testID="many-tag-input"
              value={tag}
              onChangeText={(v) => (v.endsWith(',') ? addTag(v) : setTag(v))}
              onSubmitEditing={() => addTag(tag)}
              blurOnSubmit={false}
              placeholder={t.detailAddTag}
              accessibilityLabel={t.detailAddTag}
              placeholderTextColor={p.muted}
              style={[styles.tagInput, { color: p.ink }]}
            />
          </View>
        </View>
        <T v="caption" color={p.muted}>
          {t.detailsManyNote}
        </T>
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space.md }}>
          {progress && (
            <T v="caption" color={p.muted} testID="many-progress">
              {t.detailsManySaving(progress.done + 1, progress.total)}
            </T>
          )}
          <Button testID="many-save" label={t.save} icon="check" onPress={progress ? undefined : () => void save()} />
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
