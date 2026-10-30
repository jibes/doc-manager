import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { allDocs, refreshSoon, useIndex } from '@/paper/archive/indexer';
import { writeDetailsEach } from '@/paper/archive/manyDetails';
import type { IndexedDoc } from '@/paper/archive/search';
import { changedBy, editFor, groupsFor, repeatsCount, type Group, type Level } from '@/paper/archive/tidy';
import { vocabularyOf } from '@/paper/archive/vocabulary';
import { goTab, SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Button, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { fonts, radius, space } from '@/core/design/tokens';
import { aiMessage, t } from '@/core/i18n';
import { useThrottled } from '@/core/lib/useThrottled';
import { aiReady, tidyWithAi, type TidyAnswer } from '@/paper/scan/ai';
import { ask } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';

/**
 * Tidying up tags and types (tidy.ts): a step chosen (spellings; the same meaning; broader topics), the groups it
 * proposes shown for review (a name tapped stays as it is, a group's new name can be typed over), and only then
 * written into the documents that change.
 */
export default function Tidy() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const ai = usePrefs((s) => s.ai);
  const changed = useThrottled(useIndex((s) => s.changed), 1500);
  const [docs, setDocs] = useState<IndexedDoc[] | null>(null);
  const [level, setLevel] = useState<Level>('spelling');
  const [answer, setAnswer] = useState<TidyAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  // The groups as reviewed, per level (switching levels doesn't lose what was switched off or renamed).
  const [edited, setEdited] = useState<Partial<Record<Level, Group[]>>>({});
  const [dropRepeats, setDropRepeats] = useState(true);
  const [writing, setWriting] = useState<{ done: number; total: number } | null>(null);
  const { notice, id: noticeId, say, dismiss } = useNotice();

  useEffect(() => refreshSoon(), []);
  useEffect(() => {
    let alive = true;
    void allDocs().then(
      (all) => alive && setDocs(all),
      () => alive && setDocs([]),
    );
    return () => {
      alive = false;
    };
  }, [changed]);

  const proposed = useMemo(() => (docs ? groupsFor(docs, level, level === 'spelling' ? null : answer) : []), [docs, level, answer]);
  const groups = edited[level] ?? proposed;
  const setGroups = (next: Group[]) => setEdited((e) => ({ ...e, [level]: next }));
  const edit = useMemo(() => editFor(groups, dropRepeats), [groups, dropRepeats]);
  const toChange = useMemo(() => (docs ? changedBy(docs, edit) : []), [docs, edit]);
  const repeats = docs ? repeatsCount(docs) : 0;
  const vocab = useMemo(() => vocabularyOf(docs ?? []), [docs]);

  const choose = async (next: Level) => {
    setLevel(next);
    if (next === 'spelling' || answer || asking) return;
    setAsking(true);
    try {
      setAnswer(await tidyWithAi(ai, vocab.tags, vocab.types));
    } catch (e) {
      say(aiMessage(e));
      setLevel('spelling');
    } finally {
      setAsking(false);
    }
  };

  const apply = async () => {
    if (!toChange.length) return;
    if ((await ask({ title: t.tidyConfirmTitle(toChange.length), body: t.tidyConfirmBody, confirm: t.tidyApply(toChange.length) })) === null) return;
    setWriting({ done: 0, total: toChange.length });
    const { failed, changed: done } = await writeDetailsEach(toChange, edit, (d, total) => setWriting({ done: d, total }));
    setWriting(null);
    setEdited({});
    setAnswer(null);
    setLevel('spelling');
    refreshSoon();
    say(failed ? t.tidyDoneFailed(done, failed) : t.tidyDone(done));
  };

  const toggle = (g: Group, name: string) => setGroups(groups.map((x) => (x.id === g.id ? { ...x, members: x.members.map((m) => (m.name === name ? { ...m, on: !m.on } : m)) } : x)));
  const rename = (g: Group, to: string) => setGroups(groups.map((x) => (x.id === g.id ? { ...x, to } : x)));
  const levels: [Level, string][] = [
    ['spelling', t.tidyLevelSpelling],
    ['same', t.tidyLevelSame],
    ['broader', t.tidyLevelBroader],
  ];
  const canAsk = aiReady(ai);

  return (
    <SubFrame sub="tidy">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column, gap: space.md }}>
          <ScreenHeader title={t.tidyTitle} up={() => goTab('documents')} />
          <T color={p.muted}>{t.tidyIntro(vocab.tags.length, vocab.types.length)}</T>
          <View accessibilityRole="radiogroup" style={[styles.segment, { backgroundColor: p.hairline }]}>
            {levels.map(([k, label]) => {
              const off = k !== 'spelling' && !canAsk;
              return (
                <Pressable
                  key={k}
                  testID={`tidy-level-${k}`}
                  accessibilityRole="radio"
                  aria-checked={level === k}
                  disabled={off || asking || !!writing}
                  onPress={() => void choose(k)}
                  style={[styles.segBtn, level === k && { backgroundColor: p.raised }, off && { opacity: 0.4 }]}
                >
                  <T v="label" color={level === k ? p.ink : p.muted} numberOfLines={1}>
                    {label}
                  </T>
                </Pressable>
              );
            })}
          </View>
          {!canAsk && (
            <T v="caption" color={p.muted}>
              {t.tidyNeedsAi}
            </T>
          )}
          {asking && (
            <T v="caption" color={p.muted} testID="tidy-asking">
              {t.tidyAsking(vocab.tags.length + vocab.types.length)}
            </T>
          )}
          {repeats > 0 && (
            <View style={[styles.card, styles.switchRow, { backgroundColor: p.surface, borderColor: p.hairline }]}>
              <T style={{ flex: 1 }}>{t.tidyRepeats(repeats)}</T>
              <Switch testID="tidy-repeats" value={dropRepeats} onValueChange={setDropRepeats} />
            </View>
          )}
          {docs && !asking && !groups.length && (
            <T color={p.muted} testID="tidy-nothing">
              {t.tidyNothing}
            </T>
          )}
          {groups.length > 0 && !asking && (
            <T v="caption" color={p.muted}>
              {t.tidyMemberHint}
            </T>
          )}
          {!asking &&
            groups.map((g) => (
              <View key={g.id} testID="tidy-group" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline, padding: space.lg, gap: space.sm }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <T v="kicker" color={p.muted}>
                    {g.kind === 'tag' ? t.detailTags : t.detailType}
                  </T>
                  <TextInput
                    testID="tidy-to"
                    value={g.to}
                    onChangeText={(to) => rename(g, to)}
                    accessibilityLabel={t.tidyTo}
                    style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.canvas }]}
                  />
                </View>
                <View style={styles.members}>
                  {g.members.map((m) => (
                    <Pressable
                      key={m.name}
                      testID="tidy-member"
                      accessibilityRole="checkbox"
                      aria-checked={m.on}
                      onPress={() => toggle(g, m.name)}
                      style={[styles.chip, { backgroundColor: m.on ? p.accentSoft : 'transparent', borderColor: m.on ? 'transparent' : p.hairline }]}
                    >
                      <T v="label" color={m.on ? p.accent : p.muted} style={!m.on && { textDecorationLine: 'line-through' }}>
                        {`${m.name} · ${m.count}`}
                      </T>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          {docs && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.sm }}>
              <Button testID="tidy-apply" label={t.tidyApply(toChange.length)} disabled={!toChange.length || asking || !!writing} onPress={() => void apply()} />
              {writing && (
                <T v="caption" color={p.muted}>
                  {t.tidyProgress(writing.done + 1, writing.total)}
                </T>
              )}
            </View>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} id={noticeId} onDismiss={dismiss} />
    </SubFrame>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.sm },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  members: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: space.md, paddingVertical: space.xs },
  input: { flex: 1, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, fontFamily: fonts.sansMedium, fontSize: 15 },
});
