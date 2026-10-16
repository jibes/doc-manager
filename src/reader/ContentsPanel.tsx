import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { t } from '@/i18n';
import { IconButton, T } from '@/components/primitives';
import { fonts, radius, space, type Palette } from '@/design/tokens';
import type { Annotation, OutlineItem, Size } from '@/engine/types';
import type { RasterCache } from './rasterCache';
import { Thumb } from './Thumb';

export type FlatOutline = { title: string; page: number; depth: number }[];

export function flattenOutline(items: OutlineItem[], depth = 0, out: FlatOutline = []): FlatOutline {
  for (const it of items) {
    out.push({ title: it.title || t.untitled, page: it.page, depth });
    flattenOutline(it.children, depth + 1, out);
  }
  return out;
}

export type ContentsTab = 'contents' | 'pages' | 'notes';
type Tab = ContentsTab;

type Props = {
  palette: Palette;
  outline: FlatOutline | null;
  page: number;
  /** Page thumbnails (PDFs); without them there is no Pages tab. */
  sizes?: Size[];
  cache?: RasterCache;
  bookmarks: number[];
  /** Tabs to offer (default: all that have data). */
  tabs?: ContentsTab[];
  /** Highlights and notes in the PDF (null while loading); editable when the callbacks are given. */
  annotations: Annotation[] | null;
  /** The Notes tab is shown: time to read the annotations. */
  onShowNotes?: () => void;
  onEditNote?: (a: Annotation) => void;
  onDeleteNote?: (a: Annotation) => void;
  onGo: (page: number) => void;
};

/** Contents, pages and notes: the lower part of Find while nothing is searched. */
export function ContentsBody({ palette: p, outline, page, sizes, cache, bookmarks, tabs: only, annotations, onShowNotes, onEditNote, onDeleteNote, onGo }: Props) {
  const [picked, setTab] = useState<Tab>('contents');
  // No outline → open on Pages instead of an empty Contents tab.
  const offered = only ?? (['contents', 'pages', 'notes'] as Tab[]).filter((k) => k !== 'pages' || (cache && sizes));
  const tab = picked === 'contents' && outline?.length === 0 && offered.includes('pages') ? 'pages' : picked;
  useEffect(() => {
    if (tab === 'notes') onShowNotes?.();
  }, [tab, onShowNotes]);

  const currentIdx = useMemo(() => {
    if (!outline) return -1;
    let idx = -1;
    outline.forEach((o, i) => o.page >= 0 && o.page <= page && (idx = i));
    return idx;
  }, [outline, page]);

  const allTabs: [Tab, string][] = [
    ['contents', t.contents],
    ['pages', t.pagesTab],
    ['notes', t.notesTab],
  ];
  const tabs = allTabs.filter(([k]) => offered.includes(k));

  return (
    <View style={{ flex: 1 }} testID="contents-body">
      <View style={[styles.segment, { backgroundColor: p.hairline }]}>
        {tabs.map(([k, label]) => (
          <Pressable
            key={k}
            accessibilityRole="tab"
            aria-selected={tab === k}
            testID={`tab-${k}`}
            onPress={() => setTab(k)}
            style={[styles.segBtn, tab === k && [{ backgroundColor: p.raised }, styles.segActive]]}
          >
            <T v="label" numberOfLines={1} color={tab === k ? p.ink : p.muted} style={{ fontFamily: fonts.sansMedium, fontSize: 13 }}>
              {label}
            </T>
          </Pressable>
        ))}
      </View>

      {tab === 'contents' &&
        (outline == null ? null : outline.length === 0 ? (
          <Empty p={p} text={t.noOutline} />
        ) : (
          <FlatList
            data={outline}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={{ paddingBottom: space.xl }}
            renderItem={({ item, index }) => {
              const current = index === currentIdx;
              return (
                <Pressable accessibilityRole="button"
                  disabled={item.page < 0}
                  onPress={() => onGo(item.page)}
                  style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                    styles.tocRow,
                    { paddingLeft: space.xl - 4 + item.depth * 16, backgroundColor: current ? p.accentSoft : hovered ? p.hairline : 'transparent' },
                  ]}
                >
                  {current && <View style={[styles.tocBar, { backgroundColor: p.accent }]} />}
                  <T
                    numberOfLines={2}
                    style={[
                      { flex: 1 },
                      item.depth === 0
                        ? { fontFamily: fonts.sansSemi, fontSize: 15, lineHeight: 20 }
                        : { fontFamily: fonts.sans, fontSize: 14, lineHeight: 19 },
                    ]}
                    color={current ? p.accent : item.depth === 0 ? p.ink : p.inkSoft}
                  >
                    {item.title}
                  </T>
                  {item.page >= 0 && (
                    <T v="numeral" color={current ? p.accent : p.muted}>
                      {item.page + 1}
                    </T>
                  )}
                </Pressable>
              );
            }}
          />
        ))}

      {tab === 'pages' && cache && sizes && (
        <PagesGrid p={p} sizes={sizes} cache={cache} page={page} onGo={onGo} bookmarks={bookmarks} />
      )}

      {tab === 'notes' &&
        (annotations == null ? null : annotations.length === 0 ? (
          <Empty p={p} text={t.noNotes} />
        ) : (
          <FlatList
            data={annotations}
            keyExtractor={(a) => `${a.page}:${a.index}`}
            contentContainerStyle={{ paddingBottom: space.xl }}
            renderItem={({ item: a }) => (
              <View style={[styles.noteRow, { borderColor: p.hairline }]} testID="note-row">
                <Pressable accessibilityRole="button" onPress={() => onGo(a.page)} style={{ flex: 1, gap: 4 }}>
                  <View style={styles.noteHead}>
                    <View style={[styles.swatch, { backgroundColor: a.color ?? p.accent }]} />
                    <T v="caption" color={p.muted}>
                      {t.annotationKinds[a.kind]} · {t.pageN(a.page + 1)}
                      {a.author ? ` · ${a.author}` : ''}
                    </T>
                  </View>
                  {!!a.quote && (
                    <T v="body" numberOfLines={4} color={p.inkSoft} style={{ fontSize: 14, lineHeight: 20 }}>
                      {a.quote}
                    </T>
                  )}
                  {!!a.contents && (
                    <T v="body" style={{ fontSize: 14, lineHeight: 20, fontFamily: fonts.sansMedium }}>
                      {a.contents}
                    </T>
                  )}
                </Pressable>
                {onEditNote && (
                  <View style={styles.noteActions}>
                    <IconButton icon="pencil" label={t.editNote} size={32} onPress={() => onEditNote(a)} testID="note-edit" />
                    <IconButton icon="trash" label={t.deleteNote} size={32} onPress={() => onDeleteNote?.(a)} testID="note-delete" />
                  </View>
                )}
              </View>
            )}
          />
        ))}
    </View>
  );
}

function PagesGrid({ p, sizes, cache, page, onGo, bookmarks }: { p: Palette; sizes: Size[]; cache: RasterCache; page: number; onGo: (n: number) => void; bookmarks: number[] }) {
  const cols = 3;
  const [w, setW] = useState(0);
  const cellW = w ? Math.floor((w - space.xl * 2 - space.md * (cols - 1)) / cols) : 0;
  const rowH = cellW * 1.414 + 28;
  const pages = useMemo(() => sizes.map((_, i) => i), [sizes]);
  const listRef = useRef<FlatList<number>>(null);
  // Scroll to the current page after the first render. (initialScrollIndex renders only from that row on,
  // and when the grid fits on screen nothing ever scrolls to fill in the rows above it.)
  // Only once, when the grid first gets its size: later page changes come from taps in the grid itself.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!cellW || scrolled.current) return;
    const raf = requestAnimationFrame(() => {
      scrolled.current = true;
      listRef.current?.scrollToIndex({ index: Math.floor(page / cols), animated: false, viewPosition: 0.3 });
    });
    return () => cancelAnimationFrame(raf);
  }, [cellW, page]);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {cellW > 0 && (
        <FlatList
          ref={listRef}
          data={pages}
          numColumns={cols}
          keyExtractor={(i) => String(i)}
          // With numColumns, FlatList indexes rows, not items.
          getItemLayout={(_, row) => ({ length: rowH, offset: rowH * row, index: row })}
          windowSize={5}
          columnWrapperStyle={{ gap: space.md, paddingHorizontal: space.xl }}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => onGo(item)} style={{ width: cellW, height: rowH, alignItems: 'center', paddingTop: 4 }}>
              <View style={[{ borderRadius: 4, padding: 2, borderWidth: 2, borderColor: item === page ? p.accent : 'transparent' }]}>
                <Thumb cache={cache} page={item} size={sizes[item]} width={cellW - 8} palette={p} />
              </View>
              <T v="numeral" color={item === page ? p.accent : p.muted} style={{ marginTop: 4 }}>
                {bookmarks.includes(item) ? '◆ ' : ''}
                {item + 1}
              </T>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function Empty({ p, text }: { p: Palette; text: string }) {
  return (
    <View style={{ padding: space.xxl, alignItems: 'center' }}>
      <T v="body" color={p.muted} style={{ textAlign: 'center' }}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  noteRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.xl - 4, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  noteHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  noteActions: { gap: 2 },
  segment: { flexDirection: 'row', marginHorizontal: space.xl - 4, marginBottom: space.md, borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  segActive: { boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } as object,
  tocRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingRight: space.xl - 4, paddingVertical: 10, minHeight: 44 },
  tocBar: { position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
});
