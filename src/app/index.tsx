import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppFrame, AppHeader, TAB_BAR_H, useMainWidth, useTabBar } from '@/components/AppNav';
import { Cover } from '@/components/Cover';
import { DocItem, DocList, gridOf, LayoutToggle, useLayout, type Layout } from '@/components/DocItems';
import { Action, ActionBar, heldNow, justSelected, SelectBar, toggled } from '@/components/Selection';
import { shareDocs } from '@/lib/fileActions';
import { DropZone } from '@/components/DropZone';
import { EmptyLibrary } from '@/components/EmptyLibrary';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { useInstall } from '@/lib/install';
import { pickPdfs, sampleItem } from '@/lib/pick';
import { openedWithFiles, shell } from '@/lib/shell';
import { ask } from '@/state/ask';
import { useLibrary, type ImportItem } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';
import { repo, type DocRecord } from '@/storage';

const MAX_W = 1120;
/** Opened as an app (the Android app, an installed web app): it opens where it was. A browser tab follows its URL. */
const launchedAsApp = () => !!shell || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
/** Set once the app has opened its first place (later visits here don't jump away). */
let launched = false;
/** Recently opened documents listed here; all of them are in Documents. */
const RECENT = 20;
/** AGPL §13: offer the source to network users. */
const SOURCE_URL = 'https://github.com/jibes/doc-reader';

const progressOf = (d: DocRecord) => (d.position && d.pageCount > 1 ? (d.position.page + d.position.offset) / d.pageCount : 0);
const pctOf = (d: DocRecord) => Math.round(progressOf(d) * 100);

function open(doc: DocRecord) {
  // A linked file may need the browser's OK again (after a restart); ask while the tap still counts as a gesture.
  const ready = doc.linked ? repo.requestAccess(doc.id).catch(() => false) : Promise.resolve(true);
  ready.then(() => router.push({ pathname: '/read/[id]', params: { id: doc.id } }));
}

/** Asks in the app's own dialog (not the browser's, which shows the page address). */
async function confirmRemove(doc: DocRecord, remove: (id: string) => void) {
  const answer = await ask({ title: t.removeTitle, body: t.removeConfirm(doc.title), confirm: t.remove, destructive: true });
  if (answer !== null) remove(doc.id);
}

export default function Home() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const width = useMainWidth();
  const { docs, covers, loaded, importing, error, load, importFiles, remove, toggleReading, clearError } = useLibrary();
  const [hint, setHint] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  // Picked documents (by id), while picking.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { kind: installKind, install } = useInstall();
  const tabBar = useTabBar();

  // The app opens where it was last used (unless it was opened with a document); from then on this is the place last used.
  useEffect(() => {
    const { lastTab, set } = usePrefs.getState();
    if (!launched && !openedWithFiles && lastTab === 'documents' && launchedAsApp()) router.replace('/documents');
    else set({ lastTab: 'reading' });
    launched = true;
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (items: ImportItem[]) => {
    const added = await importFiles(items);
    if (added.length === 1) open(added[0]);
  };

  const gutter = width < 600 ? space.xl - 4 : space.xxxl;
  const contentW = Math.min(width, MAX_W) - gutter * 2;
  const layout = useLayout();
  const grid = gridOf(contentW);
  const wide = width >= 760;

  const reading = useMemo(() => docs.filter((d) => d.reading && !d.reading.finishedAt), [docs]);
  const finished = useMemo(() => docs.filter((d) => d.reading?.finishedAt), [docs]);
  // Docs are sorted by last opened, so the first unfinished one is the one to continue.
  const [current, ...shelf] = reading;
  // Recently opened: the last few (every document is in Documents).
  const recent = useMemo(() => docs.slice(0, RECENT), [docs]);

  if (!loaded) return <View style={{ flex: 1, backgroundColor: p.canvas }} />;

  const removeDoc = (d: DocRecord) => void confirmRemove(d, remove);

  const picked = selected ? docs.filter((d) => selected.has(d.id)) : [];
  const hold = (id: string) => {
    if (justSelected(id)) return;
    heldNow(id);
    setSelected((s) => (s ? toggled(s, id) : new Set([id])));
  };
  const tap = (id: string) => !justSelected(id) && setSelected((s) => toggled(s, id));
  const selection = (d: DocRecord) => ({ selected: selected ? selected.has(d.id) : undefined, onSelect: () => hold(d.id), onToggle: () => tap(d.id) });
  // All on the reading list already: they come off it; else the others go on.
  const allReading = picked.length > 0 && picked.every((d) => d.reading);
  const readingAll = () => {
    const change = picked.filter((d) => !!d.reading === allReading);
    for (const d of change) toggleReading(d.id);
    setNotice(allReading ? t.readingRemovedN(change.length) : t.readingAddedN(change.length));
    setSelected(null);
  };
  const removeAll = async () => {
    const list = picked;
    const yes = await ask(
      list.length === 1
        ? { title: t.removeTitle, body: t.removeConfirm(list[0].title), confirm: t.remove, destructive: true }
        : { title: t.removeManyTitle(list.length), body: t.removeManyBody, confirm: t.remove, destructive: true },
    );
    if (yes === null) return;
    for (const d of list) await remove(d.id);
    setNotice(t.removedN(list.length));
    setSelected(null);
  };

  return (
    <AppFrame tab="reading">
    <DropZone onFiles={add}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.canvas }}
        contentContainerStyle={{ paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl + (tabBar ? TAB_BAR_H : 0) + (selected ? 72 : 0), alignItems: 'center', flexGrow: 1 }}
      >
        <View style={{ width: contentW, flexGrow: 1 }}>
          {selected ? (
            <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(recent.map((d) => d.id)))} />
          ) : (
            <AppHeader tab="reading">
              <LayoutToggle />
              {recent.length > 0 && <IconButton testID="select" icon="select" label={t.select} onPress={() => setSelected(new Set())} />}
              {installKind && (
                <Button
                  testID="install"
                  kind="quiet"
                  icon="install"
                  label={t.install}
                  onPress={() => (installKind === 'prompt' ? install() : setHint(t.installHintIos))}
                />
              )}
            </AppHeader>
          )}
          {docs.length === 0 ? (
            <EmptyLibrary onAdd={async () => add(await pickPdfs())} onSample={async () => add([await sampleItem()])} />
          ) : (
            <>
              {(reading.length > 0 || finished.length > 0) && (
                <View style={styles.section} testID="reading-list">
                  <T v="kicker" color={p.muted} style={styles.kicker}>
                    {reading.length ? t.readingListCount(reading.length) : t.readingList}
                  </T>
                  {current && <ContinueCard doc={current} cover={covers[current.id]} wide={wide} />}
                  {shelf.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.lg, paddingTop: space.lg }}>
                      {shelf.map((d) => (
                        <ShelfItem key={d.id} doc={d} cover={covers[d.id]} />
                      ))}
                    </ScrollView>
                  )}
                  {finished.length > 0 && (
                    <View style={{ marginTop: space.lg }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: showFinished }}
                        onPress={() => setShowFinished((v) => !v)}
                        style={styles.finishedHead}
                      >
                        <T v="label" color={p.muted}>
                          {t.finishedCount(finished.length)}
                        </T>
                        <View style={{ transform: [{ rotate: showFinished ? '180deg' : '0deg' }] }}>
                          <Icon name="chevronDown" size={16} color={p.muted} />
                        </View>
                      </Pressable>
                      {showFinished && (
                        <View style={{ marginTop: space.sm }}>
                          <DocList layout={layout} gap={grid.gap}>
                            {finished.map((d, i) => (
                              <Row key={d.id} doc={d} cover={covers[d.id]} layout={layout} width={grid.tile} first={i === 0} last={i === finished.length - 1} {...selection(d)} onReading={() => toggleReading(d.id)} onRemove={() => removeDoc(d)} />
                            ))}
                          </DocList>
                        </View>
                      )}
                    </View>
                  )}
                </View>
              )}

              <View style={styles.section}>
                <View style={styles.sectionHead}>
                  <T v="kicker" color={p.muted}>
                    {t.recentTitle}
                  </T>
                  <Button testID="add" kind="quiet" icon="plus" label={t.openFile} onPress={async () => add(await pickPdfs())} />
                </View>
                {importing.length > 0 && (
                  <T v="label" color={p.muted} style={{ marginBottom: space.sm }}>
                    {t.adding}
                  </T>
                )}
                <DocList layout={layout} gap={grid.gap}>
                  {recent.map((d, i) => (
                    <Row
                      key={d.id}
                      doc={d}
                      cover={covers[d.id]}
                      layout={layout}
                      width={grid.tile}
                      first={i === 0}
                      last={i === recent.length - 1}
                      {...selection(d)}
                      onReading={() => toggleReading(d.id)}
                      onRemove={() => removeDoc(d)}
                    />
                  ))}
                </DocList>
              </View>
            </>
          )}
        </View>
        <Pressable
          accessibilityRole="link"
          onPress={() => Linking.openURL(SOURCE_URL)}
          style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.colophon, { opacity: hovered ? 1 : 0.7 }]}
        >
          <T v="caption" color={p.muted}>
            {t.colophon}
          </T>
        </Pressable>
      </ScrollView>
      {selected && (
        <ActionBar bottom={insets.bottom + (tabBar ? TAB_BAR_H : 0)} side={space.xl - 4}>
          <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length} onPress={() => void shareDocs(picked).catch(() => {})} />
          <Action
            testID="act-reading"
            icon={allReading ? 'readingOn' : 'readingAdd'}
            label={allReading ? t.removeFromReadingList : t.readingList}
            disabled={!picked.length}
            onPress={readingAll}
          />
          <Action testID="act-remove" icon="trash" label={t.remove} disabled={!picked.length} onPress={() => void removeAll()} />
        </ActionBar>
      )}
      <Toast message={error ?? hint ?? notice} onDismiss={() => (error ? clearError() : hint ? setHint(null) : setNotice(null))} above={tabBar ? TAB_BAR_H : 0} />
    </DropZone>
    </AppFrame>
  );
}

function ContinueCard({ doc, cover, wide }: { doc: DocRecord; cover?: string | null; wide: boolean }) {
  const p = usePalette();
  const page = (doc.position?.page ?? 0) + 1;
  const pct = pctOf(doc);
  return (
    <Pressable
      testID="continue"
      accessibilityRole="button"
      accessibilityLabel={t.continueReadingA11y(doc.title, page)}
      onPress={() => open(doc)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.continue,
        { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, opacity: pressed ? 0.9 : 1 },
        { padding: wide ? space.xl : space.lg, gap: wide ? space.xl + 4 : space.lg },
      ]}
    >
      <Cover uri={cover} aspect={doc.coverAspect} width={wide ? 112 : 84} />
      <View style={{ flex: 1, justifyContent: 'center', gap: space.sm }}>
        <T v="kicker" color={p.accent}>
          {t.continueReading}
        </T>
        {/* Serif is reserved for reading: it sets this section apart from the viewer. */}
        <T numberOfLines={2} style={{ fontFamily: fonts.serif, fontSize: wide ? 28 : 21, lineHeight: wide ? 32 : 25, letterSpacing: -0.4 }}>
          {doc.title}
        </T>
        {doc.author ? (
          <T v="label" color={p.muted} numberOfLines={1}>
            {doc.author}
          </T>
        ) : null}
        <View style={{ marginTop: space.xs, gap: space.sm, maxWidth: 360 }}>
          <View style={[styles.bar, { backgroundColor: p.hairline }]}>
            <View style={{ width: `${Math.max(pct, 1)}%`, height: '100%', backgroundColor: p.accent, borderRadius: 2 }} />
          </View>
          <T v="numeral" color={p.muted}>
            {t.pageOf(page, doc.pageCount)} · {t.percentRead(pct)}
          </T>
        </View>
      </View>
    </Pressable>
  );
}

function ShelfItem({ doc, cover }: { doc: DocRecord; cover?: string | null }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={doc.title} onPress={() => open(doc)} style={{ width: 96 }}>
      <Cover uri={cover} aspect={doc.coverAspect} width={96} progress={progressOf(doc) || 0.001} />
      <T v="caption" numberOfLines={2} style={{ marginTop: space.md + 4, fontFamily: fonts.sansMedium }}>
        {doc.title}
      </T>
      <T v="caption" color={p.muted}>
        {t.percentRead(pctOf(doc))}
      </T>
    </Pressable>
  );
}

/** A library document, as every list shows documents; its ⋯ offers the reading list and removing it. */
function Row({
  doc,
  cover,
  layout,
  width,
  first,
  last,
  selected,
  onSelect,
  onToggle,
  onReading,
  onRemove,
}: {
  doc: DocRecord;
  cover?: string | null;
  layout: Layout;
  width: number;
  first: boolean;
  last: boolean;
  /** Undefined: not picking. */
  selected?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onReading: () => void;
  onRemove: () => void;
}) {
  const onList = !!doc.reading;
  return (
    <DocItem
      layout={layout}
      width={width}
      testID="recent-row"
      picture={{ kind: 'cover', uri: cover, aspect: doc.coverAspect }}
      title={doc.title}
      meta={[onList ? t.readingList : '', t.docMeta(doc.pageCount, doc.bytes, doc.openedAt), doc.format === 'epub' ? 'EPUB' : '', doc.linked ? t.inPlace : ''].filter(Boolean).join(' · ')}
      progress={onList ? progressOf(doc) : undefined}
      first={first}
      last={last}
      selected={selected}
      onOpen={() => open(doc)}
      onSelect={onSelect}
      onToggle={onToggle}
      actions={[
        { key: 'reading', icon: onList ? 'readingOn' : 'readingAdd', label: onList ? t.removeFromReadingList : t.addToReadingList, onPress: onReading },
        { key: 'remove', icon: 'trash', label: t.removeFromLibrary, destructive: true, onPress: onRemove },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, marginBottom: space.lg },
  section: { marginBottom: space.xxl },
  kicker: { marginBottom: space.md },
  continue: { flexDirection: 'row', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  bar: { height: 3, borderRadius: 2, overflow: 'hidden' },
  finishedHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, marginBottom: space.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 140, height: 32, outlineStyle: 'none' } as object,
  colophon: { marginTop: space.xxxl, paddingVertical: space.sm },
});
