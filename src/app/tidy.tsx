import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { allDocs, refreshSoon, useIndex } from '@/paper/archive/indexer';
import { writeDetailsEach } from '@/paper/archive/manyDetails';
import type { IndexedDoc } from '@/paper/archive/search';
import { changedBy, directCoverage, editFor, namesOf, repeatsCount, resultCounts, spellingFixes, suggestedCategories, type Destination, type Kind, type NameInfo } from '@/paper/archive/tidy';
import { nameKey } from '@/paper/archive/vocabulary';
import { goTab, SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Icon } from '@/paper/components/Icon';
import { Button, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { fonts, radius, space, type Palette } from '@/core/design/tokens';
import { aiMessage, t } from '@/core/i18n';
import { useThrottled } from '@/core/lib/useThrottled';
import { aiReady, rateNames, sortInNames, type NameRating } from '@/paper/scan/ai';
import { showActions } from '@/paper/state/actions';
import { ask } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';

type Step = 1 | 2 | 3;
type Sort = 'count' | 'generality';
/** What the model said about one kind's names: how general each is, which are companies, the categories it suggests. */
type Rated = { ratings: Map<string, NameRating>; suggested: string[] };
type PerKind<T> = Partial<Record<Kind, T>>;

/**
 * Tidying tags (or types) into a few categories (tidy.ts), in three steps: 1. choose the categories, 2. sort the
 * other names in (the model proposes, a tap changes), 3. check and change the documents. Spellings, repeats and
 * company names are cleaned up along the way, unless switched off.
 */
export default function Tidy() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const ai = usePrefs((s) => s.ai);
  const canAsk = aiReady(ai);
  const changed = useThrottled(useIndex((s) => s.changed), 1500);
  const [docs, setDocs] = useState<IndexedDoc[] | null>(null);
  const [kind, setKind] = useState<Kind>('tag');
  const [step, setStep] = useState<Step>(1);
  const [sort, setSort] = useState<Sort>('count');
  const [cleanup, setCleanup] = useState(true);
  const [rated, setRated] = useState<PerKind<Rated>>({});
  const [chosen, setChosen] = useState<PerKind<string[]>>({});
  const [destinations, setDestinations] = useState<PerKind<Map<string, Destination>>>({});
  const [sorting, setSorting] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
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

  const rating = rated[kind];
  // The names in use, with what the model said about them.
  const names = useMemo<NameInfo[]>(
    () =>
      namesOf(docs ?? [], kind).map((n) => {
        const r = rating?.ratings.get(nameKey(n.name));
        return { ...n, generality: r?.generality ?? null, company: kind === 'tag' && !!r?.company };
      }),
    [docs, kind, rating],
  );
  const companies = useMemo(() => new Set(names.filter((n) => n.company).map((n) => nameKey(n.name))), [names]);
  const categories = useMemo(() => chosen[kind] ?? suggestedCategories(docs ?? [], names, kind, rating?.suggested ?? null), [chosen, kind, docs, names, rating]);
  const catKeys = useMemo(() => new Set(categories.map(nameKey)), [categories]);
  const rest = useMemo(() => names.filter((n) => !catKeys.has(nameKey(n.name)) && !n.company), [names, catKeys]);
  const dests = useMemo(() => destinations[kind] ?? new Map<string, Destination>(), [destinations, kind]);
  const plan = useMemo(() => ({ kind, cleanup, categories, destinations: step === 1 ? new Map<string, Destination>() : dests, companies: cleanup ? companies : new Set<string>() }), [kind, cleanup, categories, step, dests, companies]);
  const edit = useMemo(() => editFor(plan, names), [plan, names]);
  const toChange = useMemo(() => (docs ? changedBy(docs, edit) : []), [docs, edit]);
  const withAny = (docs ?? []).filter((d) => (kind === 'tag' ? d.tags.length : d.type)).length;
  const covered = docs ? directCoverage(docs, categories, kind) : 0;

  // The model's view of the names, once per kind (when it is set up): asked for while it is missing.
  const toRate = canAsk && !rated[kind] ? names.length : 0;
  const asked = useRef(new Set<Kind>());
  useEffect(() => {
    if (!toRate || !docs || asked.current.has(kind)) return;
    asked.current.add(kind);
    const list = namesOf(docs, kind).map((n): [string, number] => [n.name, n.count]);
    rateNames(ai, kind, list).then(
      (r) => setRated((x) => ({ ...x, [kind]: { ratings: new Map(r.ratings.map((y) => [nameKey(y.name), y])), suggested: r.suggested } })),
      (e: unknown) => {
        // Without it: no generality, the most used as categories.
        setRated((x) => ({ ...x, [kind]: { ratings: new Map(), suggested: [] } }));
        say(aiMessage(e));
      },
    );
  }, [toRate, docs, kind, ai, say]);
  const asking = toRate ? t.tidyRating(toRate) : sorting;

  const setCategories = (next: string[]) => {
    setChosen((x) => ({ ...x, [kind]: next }));
    // Other categories: the names sorted in before are sorted in again.
    setDestinations((x) => ({ ...x, [kind]: undefined }));
  };
  const toggleCategory = (name: string) => setCategories(catKeys.has(nameKey(name)) ? categories.filter((c) => nameKey(c) !== nameKey(name)) : [...categories, name]);
  const addCategory = () => {
    const name = adding.trim();
    if (name && !catKeys.has(nameKey(name))) setCategories([...categories, name]);
    setAdding('');
  };

  const toStep2 = async () => {
    setStep(2);
    if (destinations[kind] || !rest.length) return;
    const fallback = new Map<string, Destination>();
    if (!canAsk) return setDestinations((x) => ({ ...x, [kind]: fallback }));
    setSorting(t.tidySorting(rest.length));
    try {
      const answer = await sortInNames(
        ai,
        kind,
        categories,
        rest.map((n) => [n.name, n.count]),
      );
      const map = new Map<string, Destination>();
      for (const a of answer) {
        const cat = categories.find((c) => nameKey(c) === nameKey(a.category));
        if (cat && rest.some((n) => nameKey(n.name) === nameKey(a.name))) map.set(nameKey(a.name), { to: 'category', category: cat });
      }
      setDestinations((x) => ({ ...x, [kind]: map }));
    } catch (e) {
      say(aiMessage(e));
      setDestinations((x) => ({ ...x, [kind]: fallback }));
    } finally {
      setSorting(null);
    }
  };

  const choose = (n: NameInfo) =>
    showActions(n.name, [
      ...categories.map((c) => ({ key: `to-${c}`, icon: 'tag' as const, label: c, onPress: () => setDest(n, { to: 'category', category: c }) })),
      { key: 'keep', icon: 'check' as const, label: kind === 'tag' ? t.tidyKeepTag : t.tidyKeepType, onPress: () => setDest(n, { to: 'keep' }) },
      { key: 'remove', icon: 'trash' as const, label: t.tidyRemove, destructive: true, onPress: () => setDest(n, { to: 'remove' }) },
    ]);
  const setDest = (n: NameInfo, d: Destination) => setDestinations((x) => ({ ...x, [kind]: new Map(dests).set(nameKey(n.name), d) }));

  const apply = async () => {
    if (!toChange.length) return;
    if ((await ask({ title: t.tidyConfirmTitle(toChange.length), body: t.tidyConfirmBody, confirm: t.tidyApply(toChange.length) })) === null) return;
    setWriting({ done: 0, total: toChange.length });
    const { failed, changed: done } = await writeDetailsEach(toChange, edit, (d, total) => setWriting({ done: d, total }));
    setWriting(null);
    setChosen({});
    setDestinations({});
    setRated({});
    asked.current.clear();
    setStep(1);
    refreshSoon();
    say(failed ? t.tidyDoneFailed(done, failed) : t.tidyDone(done));
  };

  const switchKind = (k: Kind) => {
    setKind(k);
    setStep(1);
  };
  const busy = !!asking || !!writing;
  const sorted = [...names.filter((n) => !n.company)].sort((a, b) => (sort === 'generality' ? (b.generality ?? 0) - (a.generality ?? 0) : 0) || b.count - a.count);
  const fixes = docs ? spellingFixes(docs, kind) : 0;
  const repeated = docs && kind === 'tag' ? repeatsCount(docs) : 0;

  return (
    <SubFrame sub="tidy">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column, gap: space.md }}>
          <ScreenHeader title={t.tidyTitle} up={() => goTab('documents')} />
          <Segments
            palette={p}
            testID="tidy-kind"
            value={kind}
            disabled={busy}
            items={[
              ['tag', t.detailTags],
              ['type', t.tidyTypes],
            ]}
            onChange={switchKind}
          />
          <View testID="tidy-steps" style={styles.steps}>
            {([1, 2, 3] as Step[]).map((s) => (
              <T key={s} v="label" color={s === step ? p.ink : p.muted} style={s === step && { fontFamily: fonts.sansSemi }} numberOfLines={1}>
                {`${s}. ${[t.tidyStep1, t.tidyStep2, t.tidyStep3][s - 1]}`}
              </T>
            ))}
          </View>

          {(fixes > 0 || repeated > 0 || companies.size > 0) && (
            <View style={[styles.card, styles.row, { backgroundColor: p.surface, borderColor: p.hairline }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: fonts.sansMedium }}>{t.tidyCleanup}</T>
                {fixes > 0 && (
                  <T v="caption" color={p.muted}>
                    {t.tidyCleanupSpellings(fixes)}
                  </T>
                )}
                {repeated > 0 && (
                  <T v="caption" color={p.muted}>
                    {t.tidyCleanupRepeats(repeated)}
                  </T>
                )}
                {companies.size > 0 && (
                  <T v="caption" color={p.muted}>
                    {t.tidyCleanupCompanies(names.filter((n) => n.company).map((n) => n.name))}
                  </T>
                )}
              </View>
              <Switch testID="tidy-cleanup" value={cleanup} onValueChange={setCleanup} />
            </View>
          )}

          {asking && (
            <T color={p.muted} testID="tidy-asking">
              {asking}
            </T>
          )}
          {!canAsk && step < 3 && (
            <T v="caption" color={p.muted}>
              {t.tidyNeedsAi}
            </T>
          )}

          {step === 1 && !asking && (
            <>
              <T color={p.muted}>{kind === 'tag' ? t.tidyChooseTags : t.tidyChooseTypes}</T>
              <T testID="tidy-coverage" style={{ fontFamily: fonts.sansMedium }}>
                {t.tidyCoverage(categories.length, withAny ? Math.round((100 * covered) / withAny) : 0)}
              </T>
              {canAsk && (
                <Segments
                  palette={p}
                  testID="tidy-sort"
                  value={sort}
                  items={[
                    ['count', t.tidySortCount],
                    ['generality', t.tidySortGenerality],
                  ]}
                  onChange={setSort}
                />
              )}
              <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                {categories
                  .filter((c) => !names.some((n) => nameKey(n.name) === nameKey(c)))
                  .map((c) => (
                    <NameRow key={c} palette={p} name={c} detail={t.tidyNewCategory} on onPress={() => toggleCategory(c)} />
                  ))}
                {sorted.map((n) => (
                  <NameRow key={n.name} palette={p} name={n.name} detail={detail(n)} on={catKeys.has(nameKey(n.name))} onPress={() => toggleCategory(n.name)} />
                ))}
                <View style={[styles.row, styles.rowLine, { borderColor: p.hairline }]}>
                  <TextInput
                    testID="tidy-add"
                    value={adding}
                    onChangeText={setAdding}
                    onSubmitEditing={addCategory}
                    placeholder={t.tidyAddCategory}
                    placeholderTextColor={p.muted}
                    style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.canvas }]}
                  />
                  <Button kind="quiet" icon="plus" label={t.tidyAdd} disabled={!adding.trim()} onPress={addCategory} />
                </View>
              </View>
              <View style={styles.actions}>
                <Button testID="tidy-next" label={t.tidyNext(rest.length)} disabled={!categories.length || busy} onPress={() => void toStep2()} />
              </View>
            </>
          )}

          {step === 2 && !asking && (
            <>
              <T color={p.muted}>{t.tidySortHint}</T>
              {[...categories.map((c): [string, Destination] => [c, { to: 'category', category: c }]), [t.tidyKept, { to: 'keep' }] as [string, Destination], [t.tidyRemoved, { to: 'remove' }] as [string, Destination]].map(([title, d]) => {
                const here = rest.filter((n) => sameDest(dests.get(nameKey(n.name)) ?? { to: 'keep' }, d));
                if (!here.length) return null;
                return (
                  <View key={title} testID="tidy-section" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                    <T v="kicker" color={d.to === 'remove' ? p.markRing : p.muted} style={styles.section}>
                      {title}
                    </T>
                    {here.map((n) => (
                      <Pressable
                        key={n.name}
                        testID="tidy-rest"
                        accessibilityRole="button"
                        accessibilityHint={t.tidyChangeHint}
                        onPress={() => choose(n)}
                        style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.row, styles.rowLine, { borderColor: p.hairline, backgroundColor: hovered ? p.raised : 'transparent' }]}
                      >
                        <T style={{ flex: 1 }} numberOfLines={1}>
                          {n.name}
                        </T>
                        <T v="caption" color={p.muted}>
                          {t.tidyDocs(n.count)}
                        </T>
                        <Icon name="chevronRight" size={16} color={p.muted} />
                      </Pressable>
                    ))}
                  </View>
                );
              })}
              <View style={styles.actions}>
                <Button kind="quiet" label={t.back} disabled={busy} onPress={() => setStep(1)} />
                <Button testID="tidy-review" label={t.tidyStep3} disabled={busy} onPress={() => setStep(3)} />
              </View>
            </>
          )}

          {step === 3 && (
            <>
              <T color={p.muted}>{t.tidyResult}</T>
              <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                {(docs ? resultCounts(docs, edit, kind) : []).map(([name, count]) => (
                  <View key={name} testID="tidy-result" style={[styles.row, styles.rowLine, { borderColor: p.hairline }]}>
                    <T style={{ flex: 1, fontFamily: catKeys.has(nameKey(name)) ? fonts.sansMedium : undefined }} numberOfLines={1}>
                      {name}
                    </T>
                    <T v="caption" color={p.muted}>
                      {t.tidyDocs(count)}
                    </T>
                  </View>
                ))}
              </View>
              <View style={styles.actions}>
                <Button kind="quiet" label={t.back} disabled={busy} onPress={() => setStep(2)} />
                <Button testID="tidy-apply" label={t.tidyApply(toChange.length)} disabled={!toChange.length || busy} onPress={() => void apply()} />
              </View>
              {writing && (
                <T v="caption" color={p.muted}>
                  {t.tidyProgress(writing.done + 1, writing.total)}
                </T>
              )}
            </>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} id={noticeId} onDismiss={dismiss} />
    </SubFrame>
  );
}

const sameDest = (a: Destination, b: Destination) => a.to === b.to && (a.to !== 'category' || (b.to === 'category' && nameKey(a.category) === nameKey(b.category)));

/** How many documents, and how general (the model's 1–5, as dots). */
const detail = (n: NameInfo) => `${t.tidyDocs(n.count)}${n.generality ? ` · ${'●'.repeat(n.generality)}${'○'.repeat(5 - n.generality)}` : ''}`;

function NameRow({ palette: p, name, detail: sub, on, onPress }: { palette: Palette; name: string; detail: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      testID="tidy-name"
      accessibilityRole="checkbox"
      aria-checked={on}
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.row, styles.rowLine, { borderColor: p.hairline, backgroundColor: hovered ? p.raised : 'transparent' }]}
    >
      <View style={[styles.box, { borderColor: on ? p.accent : p.hairline, backgroundColor: on ? p.accent : 'transparent' }]}>{on && <Icon name="check" size={14} color={p.accentInk} />}</View>
      <T style={{ flex: 1, fontFamily: on ? fonts.sansMedium : undefined }} numberOfLines={1}>
        {name}
      </T>
      <T v="caption" color={p.muted}>
        {sub}
      </T>
    </Pressable>
  );
}

function Segments<K extends string>({ palette: p, testID, value, items, disabled, onChange }: { palette: Palette; testID: string; value: K; items: [K, string][]; disabled?: boolean; onChange: (k: K) => void }) {
  return (
    <View testID={testID} accessibilityRole="radiogroup" style={[styles.segment, { backgroundColor: p.hairline }]}>
      {items.map(([k, label]) => (
        <Pressable
          key={k}
          testID={`${testID}-${k}`}
          accessibilityRole="radio"
          aria-checked={value === k}
          disabled={disabled}
          onPress={() => onChange(k)}
          style={[styles.segBtn, value === k && { backgroundColor: p.raised }]}
        >
          <T v="label" color={value === k ? p.ink : p.muted} numberOfLines={1}>
            {label}
          </T>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { flexDirection: 'row', borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, alignItems: 'center', paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
  steps: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  section: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm + 2 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm, marginTop: space.xs },
  input: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, fontFamily: fonts.sans, fontSize: 15 },
});
