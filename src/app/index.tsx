import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppFrame, AppHeader, columnWidth, TAB_BAR_H, useMainWidth, useTabBar } from '@/components/AppNav';
import { Cover } from '@/components/Cover';
import { DocItem, DocList, gridOf, LayoutToggle, rightClick, useLayout, type Layout } from '@/components/DocItems';
import { Action, ActionBar, Check, heldNow, justSelected, SelectBar, toggled, useEndPicking } from '@/components/Selection';
import { shareDocs } from '@/lib/fileActions';
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

/** Opened as an app (the Android app, an installed web app): it opens where it was. A browser tab follows its URL. */
const launchedAsApp = () => !!shell || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
/** Set once the app has opened its first place (later visits here don't jump away). */
let launched = false;
/** Without a reading list: the documents opened last, Continue included (the rest are Documents, sorted so). */
const RECENT = 3;
/** AGPL §13: offer the source to network users. */
const SOURCE_URL = 'https://github.com/jibes/doc-reader';

const progressOf = (d: DocRecord) => (d.position?.end ? 1 : d.position && d.pageCount > 1 ? (d.position.page + d.position.offset) / d.pageCount : 0);
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
  const { docs: all, covers, loaded, importing, load, importFiles, view, remove, toggleReading } = useLibrary();
  // Viewed documents (not kept) aren't the library's: they aren't listed.
  const docs = useMemo(() => all.filter((d) => !d.viewed), [all]);
  const [hint, setHint] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  // Picked documents (by id), while picking (Esc and Back end it).
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEndPicking(!!selected, setSelected);
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

  // One file is opened to look at (kept when something about it is saved); several, and the guide, are kept.
  const add = async (items: ImportItem[]) => {
    const one = items.length === 1 && !items[0].bundled ? await view(items[0]) : null;
    if (one) return open(one);
    const added = items.length === 1 && !items[0].bundled ? [] : await importFiles(items);
    if (added.length === 1) open(added[0]);
  };

  const contentW = columnWidth(width);
  const layout = useLayout();
  const grid = gridOf(contentW);
  const wide = width >= 760;

  const reading = useMemo(() => docs.filter((d) => d.reading && !d.reading.finishedAt), [docs]);
  const finished = useMemo(() => docs.filter((d) => d.reading?.finishedAt), [docs]);
  // Docs are sorted by last opened, so the first unfinished one is the one to continue.
  const [current, ...shelf] = reading;
  // Nothing on the reading list: the document opened last is the one to continue.
  const lastRead = reading.length ? undefined : docs.find((d) => d.openedAt && !d.reading);
  // Reading is the reading list. Without one, the last few opened or added (Continue first); all in Documents.
  const recent = useMemo(
    () => (reading.length ? [] : docs.filter((d) => !d.reading && d !== lastRead).slice(0, lastRead ? RECENT - 1 : RECENT)),
    [docs, reading.length, lastRead],
  );

  if (!loaded) return <View style={{ flex: 1, backgroundColor: p.canvas }} />;

  const removeDoc = (d: DocRecord) => void confirmRemove(d, remove);

  const picked = selected ? docs.filter((d) => selected.has(d.id)) : [];
  // Everything on the screen, each once: for Select all.
  const shown = [...(lastRead ? [lastRead] : []), ...reading, ...(showFinished ? finished : []), ...recent];
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
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.canvas }}
        contentContainerStyle={{ paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl + (tabBar ? TAB_BAR_H : 0) + (selected ? 72 : 0), alignItems: 'center', flexGrow: 1 }}
      >
        <View style={{ width: contentW, flexGrow: 1 }}>
          {selected ? (
            <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(shown.map((d) => d.id)))} />
          ) : (
            <AppHeader tab="reading">
              <LayoutToggle />
              {/* On a narrow phone the header has room for its icon only. */}
              {installKind &&
                (width < 420 ? (
                  <IconButton testID="install" icon="install" label={t.install} onPress={() => (installKind === 'prompt' ? install() : setHint(t.installHintIos))} />
                ) : (
                  <Button testID="install" kind="quiet" icon="install" label={t.install} onPress={() => (installKind === 'prompt' ? install() : setHint(t.installHintIos))} />
                ))}
            </AppHeader>
          )}
          {docs.length === 0 ? (
            <EmptyLibrary onAdd={async () => add(await pickPdfs())} onSample={async () => add([await sampleItem()])} />
          ) : (
            <>
              {lastRead && (
                <View style={styles.section} testID="last-read">
                  <ContinueCard doc={lastRead} cover={covers[lastRead.id]} wide={wide} {...selection(lastRead)} />
                  <View style={{ alignItems: 'flex-start', marginTop: space.sm }}>
                    <Button testID="continue-add" kind="quiet" icon="readingAdd" label={t.addToReadingList} onPress={() => toggleReading(lastRead.id)} />
                  </View>
                </View>
              )}
              {(reading.length > 0 || finished.length > 0) && (
                <View style={styles.section} testID="reading-list">
                  <T v="kicker" color={p.muted} style={styles.kicker}>
                    {reading.length ? t.readingListCount(reading.length) : t.readingList}
                  </T>
                  {current && <ContinueCard doc={current} cover={covers[current.id]} wide={wide} {...selection(current)} />}
                  {shelf.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.lg, paddingTop: space.lg }}>
                      {shelf.map((d) => (
                        <ShelfItem key={d.id} doc={d} cover={covers[d.id]} {...selection(d)} />
                      ))}
                    </ScrollView>
                  )}
                  {finished.length > 0 && (
                    <View style={{ marginTop: space.lg }}>
                      <Pressable
                        accessibilityRole="button"
                        testID="finished-toggle"
                        aria-expanded={showFinished}
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
                  {recent.length > 0 && (
                    <T v="kicker" color={p.muted}>
                      {t.recentTitle}
                    </T>
                  )}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto' }}>
                    <Button testID="add" kind="quiet" icon="plus" label={t.openFile} onPress={async () => add(await pickPdfs())} />
                  </View>
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
      <Toast message={hint ?? notice} onDismiss={() => (hint ? setHint(null) : setNotice(null))} above={tabBar ? TAB_BAR_H : 0} />
    </View>
    </AppFrame>
  );
}

/** Picking documents on this screen: undefined `selected` is not picking (as in every list). */
type Picking = { selected?: boolean; onSelect: () => void; onToggle: () => void };

/** A long press or right click picks it, a tap while picking picks one more (as rows do). */
const pickable = (doc: DocRecord, { selected, onSelect, onToggle }: Picking) => ({
  accessibilityRole: selected === undefined ? ('button' as const) : ('checkbox' as const),
  'aria-checked': selected,
  onPress: selected === undefined ? () => open(doc) : onToggle,
  onLongPress: onSelect,
  delayLongPress: 350,
  ...rightClick(onSelect),
});

function ContinueCard({ doc, cover, wide, ...picking }: { doc: DocRecord; cover?: string | null; wide: boolean } & Picking) {
  const p = usePalette();
  // Read to the end: the last page (the top of the screen may still have been on the one before).
  const page = doc.position?.end ? doc.pageCount : (doc.position?.page ?? 0) + 1;
  const pct = pctOf(doc);
  return (
    <Pressable
      testID="continue"
      accessibilityLabel={t.continueReadingA11y(doc.title, page)}
      {...pickable(doc, picking)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.continue,
        { backgroundColor: picking.selected ? p.hairline : hovered ? p.raised : p.surface, borderColor: p.hairline, opacity: pressed ? 0.9 : 1 },
        { padding: wide ? space.xl : space.lg, gap: wide ? space.xl + 4 : space.lg },
      ]}
    >
      {picking.selected !== undefined && <Check on={picking.selected} style={styles.cardCheck} />}
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

function ShelfItem({ doc, cover, ...picking }: { doc: DocRecord; cover?: string | null } & Picking) {
  const p = usePalette();
  return (
    <Pressable testID="shelf-item" accessibilityLabel={doc.title} {...pickable(doc, picking)} style={{ width: 96 }}>
      <View>
        <Cover uri={cover} aspect={doc.coverAspect} width={96} progress={progressOf(doc) || 0.001} />
        {picking.selected !== undefined && <Check on={picking.selected} style={styles.shelfCheck} />}
      </View>
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
  cardCheck: { position: 'absolute', top: space.md, right: space.md },
  shelfCheck: { position: 'absolute', top: 6, right: 6 },
  bar: { height: 3, borderRadius: 2, overflow: 'hidden' },
  finishedHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.xs },
  // The heading and its actions side by side, the actions under it where both don't fit (German, phones).
  sectionHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: space.md, rowGap: space.xs, minHeight: 36, marginBottom: space.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 140, height: 32, outlineStyle: 'none' } as object,
  colophon: { marginTop: space.xxxl, paddingVertical: space.sm },
});
