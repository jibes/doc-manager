import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ArchiveResults } from '@/archive/Results';
import { useIndex } from '@/archive/indexer';
import { AppHeader, TAB_BAR_H, TabBar, useTabBar } from '@/components/AppNav';
import { Cover } from '@/components/Cover';
import { DropZone } from '@/components/DropZone';
import { EmptyLibrary } from '@/components/EmptyLibrary';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { useInstall } from '@/lib/install';
import { pickPdfs, sampleItem } from '@/lib/pick';
import { showActions } from '@/state/actions';
import { ask } from '@/state/ask';
import { useLibrary, type ImportItem } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { repo, type DocRecord } from '@/storage';

const MAX_W = 1120;
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
  const { width } = useWindowDimensions();
  const { docs, covers, loaded, importing, error, load, importFiles, remove, toggleReading, clearError } = useLibrary();
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const { kind: installKind, install } = useInstall();
  const tabBar = useTabBar();
  // Documents indexed for search across the library and folders.
  const indexed = useIndex((s) => s.count);

  useEffect(() => {
    load();
  }, [load]);

  const add = async (items: ImportItem[]) => {
    const added = await importFiles(items);
    if (added.length === 1) open(added[0]);
  };

  const gutter = width < 600 ? space.xl - 4 : space.xxxl;
  const contentW = Math.min(width, MAX_W) - gutter * 2;
  const wide = width >= 760;

  const reading = useMemo(() => docs.filter((d) => d.reading && !d.reading.finishedAt), [docs]);
  const finished = useMemo(() => docs.filter((d) => d.reading?.finishedAt), [docs]);
  // Docs are sorted by last opened, so the first unfinished one is the one to continue.
  const [current, ...shelf] = reading;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.author?.toLowerCase().includes(q)) : docs;
  }, [docs, query]);

  if (!loaded) return <View style={{ flex: 1, backgroundColor: p.canvas }} />;

  const removeDoc = (d: DocRecord) => void confirmRemove(d, remove);

  return (
    <DropZone onFiles={add}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.canvas }}
        contentContainerStyle={{ paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl + (tabBar ? TAB_BAR_H : 0), alignItems: 'center', flexGrow: 1 }}
      >
        <View style={{ width: contentW, flexGrow: 1 }}>
          <AppHeader tab="library">
            {installKind && (
              <Button
                testID="install"
                kind="quiet"
                icon="install"
                label={t.install}
                onPress={() => (installKind === 'prompt' ? install() : setHint(t.installHintIos))}
              />
            )}
            {/* Quiet: Files is where documents are found ("Other location…" there opens the system picker too). */}
            {docs.length > 0 && <IconButton testID="add" icon="plus" label={t.addPdf} onPress={async () => add(await pickPdfs())} />}
          </AppHeader>

          {docs.length === 0 ? (
            <EmptyLibrary onAdd={async () => add(await pickPdfs())} onSample={async () => add([await sampleItem()])} />
          ) : (
            <>
              {(reading.length > 0 || finished.length > 0) && !query && (
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
                        <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline, marginTop: space.sm }]}>
                          {finished.map((d, i) => (
                            <Row key={d.id} doc={d} cover={covers[d.id]} first={i === 0} onReading={() => toggleReading(d.id)} onRemove={() => removeDoc(d)} />
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>
              )}

              <View style={styles.section}>
                <View style={styles.sectionHead}>
                  <T v="kicker" color={p.muted}>
                    {query ? t.found(filtered.length) : t.recentCount(docs.length)}
                  </T>
                  {(docs.length > 5 || indexed > 0) && (
                    <View style={[styles.search, { backgroundColor: p.hairline }]}>
                      <Icon name="search" size={15} color={p.muted} />
                      <TextInput
                        testID="library-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={indexed > 0 ? t.searchAll : t.filter}
                        placeholderTextColor={p.muted}
                        style={[styles.searchInput, { color: p.ink }]}
                      />
                    </View>
                  )}
                </View>
                {/* Searching with no match in the library: nothing to frame (matches in all documents follow). */}
                {(filtered.length > 0 || importing.length > 0 || !query) && (
                <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                  {importing.map((name) => (
                    <View key={name} style={[styles.row, { borderColor: p.hairline }]}>
                      <View style={[styles.thumbPlaceholder, { borderColor: p.hairline }]} />
                      <T v="label" color={p.muted}>
                        {t.adding}
                      </T>
                    </View>
                  ))}
                  {filtered.map((d, i) => (
                    <Row
                      key={d.id}
                      doc={d}
                      cover={covers[d.id]}
                      first={i === 0 && importing.length === 0}
                      onReading={() => toggleReading(d.id)}
                      onRemove={() => removeDoc(d)}
                    />
                  ))}
                </View>
                )}
              </View>
              <ArchiveResults query={query} skip={new Set(filtered.map((d) => d.id))} />
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
      <Toast message={error ?? hint} onDismiss={() => (error ? clearError() : setHint(null))} above={tabBar ? TAB_BAR_H : 0} />
      {tabBar && <TabBar current="library" />}
    </DropZone>
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

function Row({
  doc,
  cover,
  first,
  onReading,
  onRemove,
}: {
  doc: DocRecord;
  cover?: string | null;
  first?: boolean;
  onReading: () => void;
  onRemove: () => void;
}) {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  const onList = !!doc.reading;
  // One place for what can be done with a document: its ⋯ button, or a long press.
  const actions = () =>
    showActions(doc.title, [
      { key: 'reading', icon: onList ? 'readingOn' : 'readingAdd', label: onList ? t.removeFromReadingList : t.addToReadingList, onPress: onReading },
      { key: 'remove', icon: 'trash', label: t.removeFromLibrary, destructive: true, onPress: onRemove },
    ]);
  return (
    <View
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={[
        styles.row,
        { borderColor: p.hairline, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: hover ? p.raised : 'transparent' },
      ]}
    >
      <Pressable
        testID="recent-row"
        accessibilityRole="button"
        accessibilityLabel={doc.title}
        accessibilityHint={t.rowHint}
        onPress={() => open(doc)}
        onLongPress={actions}
        style={styles.rowMain}
      >
        <Cover uri={cover} aspect={doc.coverAspect} width={36} />
        <View style={{ flex: 1, gap: 2 }}>
          <T v="label" numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15, lineHeight: 20 }}>
            {doc.title}
          </T>
          <T v="caption" color={p.muted} numberOfLines={1}>
            {onList ? `${t.readingList} · ` : ''}
            {t.docMeta(doc.pageCount, doc.bytes, doc.openedAt)}
            {doc.format === 'epub' ? ' · EPUB' : ''}
            {doc.linked ? ` · ${t.inPlace}` : ''}
          </T>
        </View>
      </Pressable>
      {/* A sibling, not a child: buttons can't nest in the DOM. */}
      <IconButton testID="row-more" icon="more" label={t.moreFor(doc.title)} size={36} onPress={actions} color={hover ? p.ink : p.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: space.xxl },
  kicker: { marginBottom: space.md },
  continue: { flexDirection: 'row', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  bar: { height: 3, borderRadius: 2, overflow: 'hidden' },
  finishedHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.xs },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, marginBottom: space.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 140, height: 32, outlineStyle: 'none' } as object,
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: space.sm, minHeight: 68 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingVertical: space.md, paddingLeft: space.lg },
  thumbPlaceholder: { width: 36, height: 48, marginLeft: space.lg, marginRight: space.lg, borderRadius: radius.cover, borderWidth: 1, borderStyle: 'dashed' },
  colophon: { marginTop: space.xxxl, paddingVertical: space.sm },
});
