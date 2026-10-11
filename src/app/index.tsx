import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cover } from '@/components/Cover';
import { DropZone } from '@/components/DropZone';
import { EmptyLibrary } from '@/components/EmptyLibrary';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { useInstall } from '@/lib/install';
import { pickPdfs, sampleItem } from '@/lib/pick';
import { useLibrary, type ImportItem } from '@/state/library';
import { usePalette } from '@/state/prefs';
import type { DocRecord } from '@/storage';

const MAX_W = 1120;
/** AGPL §13: offer the source to network users. */
const SOURCE_URL = 'https://github.com/jibes/doc-reader';

const progressOf = (d: DocRecord) => (d.position && d.pageCount > 1 ? (d.position.page + d.position.offset) / d.pageCount : 0);

function open(doc: DocRecord) {
  router.push({ pathname: '/read/[id]', params: { id: doc.id } });
}

function confirmRemove(doc: DocRecord, remove: (id: string) => void) {
  const msg = `Remove “${doc.title}” from this device?`;
  if (Platform.OS === 'web') {
    if (window.confirm(msg)) remove(doc.id);
  } else {
    Alert.alert('Remove document', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => remove(doc.id) },
    ]);
  }
}

export default function Library() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { docs, covers, loaded, importing, error, load, importFiles, remove, clearError } = useLibrary();
  const [query, setQuery] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const { kind: installKind, install } = useInstall();

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
  const gap = wide ? space.xxl : space.xl;
  const minCol = wide ? 168 : 132;
  const cols = Math.max(2, Math.floor((contentW + gap) / (minCol + gap)));
  const colW = Math.floor((contentW - gap * (cols - 1)) / cols);

  const current = docs.find((d) => d.openedAt);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.author?.toLowerCase().includes(q)) : docs;
  }, [docs, query]);

  if (!loaded) return <View style={{ flex: 1, backgroundColor: p.canvas }} />;

  return (
    <DropZone onFiles={add}>
      <ScrollView
        style={{ flex: 1, backgroundColor: p.canvas }}
        contentContainerStyle={{ paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl, alignItems: 'center', flexGrow: 1 }}
      >
        <View style={{ width: contentW, flexGrow: 1 }}>
          {/* Masthead */}
          <View style={styles.masthead}>
            <T style={{ fontFamily: fonts.serifSemi, fontSize: 24, letterSpacing: -0.4 }}>Quire</T>
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
              {installKind && (
                <Button
                  testID="install"
                  kind="quiet"
                  icon="install"
                  label="Install"
                  onPress={() =>
                    installKind === 'prompt' ? install() : setHint('To install: tap Share, then “Add to Home Screen”.')
                  }
                />
              )}
              {docs.length > 0 && <Button testID="add" label={wide ? 'Add PDF' : 'Add'} icon="plus" onPress={async () => add(await pickPdfs())} />}
            </View>
          </View>

          {docs.length === 0 ? (
            <EmptyLibrary onAdd={async () => add(await pickPdfs())} onSample={async () => add([await sampleItem()])} />
          ) : (
            <>
              {current && !query && (
                <ContinueCard doc={current} cover={covers[current.id]} wide={wide} onPress={() => open(current)} />
              )}

              <View style={[styles.sectionHead, { borderColor: p.hairline }]}>
                <T v="kicker" color={p.muted}>
                  {query ? `${filtered.length} found` : `Library · ${docs.length}`}
                </T>
                {docs.length > 5 && (
                  <View style={[styles.search, { backgroundColor: p.hairline }]}>
                    <Icon name="search" size={15} color={p.muted} />
                    <TextInput
                      value={query}
                      onChangeText={setQuery}
                      placeholder="Filter"
                      placeholderTextColor={p.muted}
                      style={[styles.searchInput, { color: p.ink }]}
                    />
                  </View>
                )}
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap: gap + space.lg }}>
                {filtered.map((d) => (
                  <Tile key={d.id} doc={d} cover={covers[d.id]} width={colW} onRemove={() => confirmRemove(d, remove)} />
                ))}
                {importing.map((name) => (
                  <View key={name} style={{ width: colW }}>
                    <View style={[styles.placeholder, { height: colW * 1.38, borderColor: p.hairline }]}>
                      <T v="caption" color={p.muted}>Adding…</T>
                    </View>
                  </View>
                ))}
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
            Quire is free software · Source (AGPL-3.0)
          </T>
        </Pressable>
      </ScrollView>
      <Toast message={error ?? hint} onDismiss={() => (error ? clearError() : setHint(null))} />
    </DropZone>
  );
}

function ContinueCard({ doc, cover, wide, onPress }: { doc: DocRecord; cover?: string | null; wide: boolean; onPress: () => void }) {
  const p = usePalette();
  const page = (doc.position?.page ?? 0) + 1;
  const pct = Math.round(progressOf(doc) * 100);
  const coverW = wide ? 132 : 92;
  return (
    <Pressable
      testID="continue"
      accessibilityRole="button"
      accessibilityLabel={`Continue reading ${doc.title}, page ${page}`}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.continue,
        { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, opacity: pressed ? 0.9 : 1 },
        { padding: wide ? space.xl : space.lg, gap: wide ? space.xl + 4 : space.lg },
      ]}
    >
      <Cover uri={cover} aspect={doc.coverAspect} width={coverW} />
      <View style={{ flex: 1, justifyContent: 'center', gap: space.sm }}>
        <T v="kicker" color={p.accent}>Continue reading</T>
        <T numberOfLines={2} style={{ fontFamily: fonts.serif, fontSize: wide ? 30 : 22, lineHeight: wide ? 34 : 26, letterSpacing: -0.5 }}>
          {doc.title}
        </T>
        {doc.author ? <T v="label" color={p.muted} numberOfLines={1}>{doc.author}</T> : null}
        <View style={{ marginTop: space.sm, gap: space.sm, maxWidth: 360 }}>
          <View style={[styles.bar, { backgroundColor: p.hairline }]}>
            <View style={{ width: `${Math.max(pct, 1)}%`, height: '100%', backgroundColor: p.accent, borderRadius: 2 }} />
          </View>
          <T v="numeral" color={p.muted}>
            Page {page} of {doc.pageCount} · {pct}%
          </T>
        </View>
      </View>
    </Pressable>
  );
}

function Tile({ doc, cover, width, onRemove }: { doc: DocRecord; cover?: string | null; width: number; onRemove: () => void }) {
  const p = usePalette();
  const [hover, setHover] = useState(false);
  const pct = progressOf(doc);
  return (
    <View style={{ width }}>
      <Pressable
        testID="tile"
        accessibilityRole="button"
        accessibilityLabel={doc.title}
        onPress={() => open(doc)}
        onLongPress={onRemove}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        style={({ pressed }) => [{ width, transform: [{ translateY: hover ? -3 : 0 }, { scale: pressed ? 0.98 : 1 }] }, styles.tile]}
      >
        <Cover uri={cover} aspect={doc.coverAspect} width={width} progress={pct} />
        <View style={{ marginTop: space.md + 6, gap: 2 }}>
          <T v="label" numberOfLines={2} style={{ fontFamily: fonts.sansMedium, color: p.ink }}>
            {doc.title}
          </T>
          <T v="caption" color={p.muted} numberOfLines={1}>
            {pct > 0 ? `${Math.round(pct * 100)}% · ` : ''}
            {doc.pageCount} pages
          </T>
        </View>
      </Pressable>
      {Platform.OS === 'web' && (
        // Sibling, not child: buttons can't nest in the DOM.
        <IconButton
          icon="trash"
          label="Remove"
          size={32}
          onPress={onRemove}
          onHoverIn={() => setHover(true)}
          onHoverOut={() => setHover(false)}
          style={[styles.remove, { backgroundColor: p.glass, opacity: hover ? 1 : 0 }]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  masthead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 52, marginBottom: space.xl },
  continue: { flexDirection: 'row', borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, marginBottom: space.xxl + 8 },
  bar: { height: 3, borderRadius: 2, overflow: 'hidden' },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    marginBottom: space.xl,
  },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 140, height: 32, outlineStyle: 'none' } as object,
  tile: { transitionDuration: '220ms', transitionProperty: 'transform' } as object,
  placeholder: { borderRadius: radius.cover, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  remove: { position: 'absolute', top: space.sm, right: space.sm },
  colophon: { marginTop: space.xxxl, paddingVertical: space.sm },
});
