import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';

import { t } from '@/i18n';
import { Icon } from '@/components/Icon';
import { T } from '@/components/primitives';
import { fonts, radius, space, type Palette } from '@/design/tokens';
import type { OutlineItem, Size } from '@/engine/types';
import { Panel } from './Panel';
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

type Tab = 'contents' | 'pages' | 'bookmarks';

type Props = {
  palette: Palette;
  outline: FlatOutline | null;
  page: number;
  sizes: Size[];
  cache: RasterCache;
  bookmarks: number[];
  onGo: (page: number) => void;
  onClose: () => void;
};

export function ContentsPanel({ palette: p, outline, page, sizes, cache, bookmarks, onGo, onClose }: Props) {
  const [picked, setTab] = useState<Tab>('contents');
  // No outline → open on Pages instead of an empty Contents tab.
  const tab = picked === 'contents' && outline?.length === 0 ? 'pages' : picked;

  const currentIdx = useMemo(() => {
    if (!outline) return -1;
    let idx = -1;
    outline.forEach((o, i) => o.page >= 0 && o.page <= page && (idx = i));
    return idx;
  }, [outline, page]);

  const tabs: [Tab, string][] = [
    ['contents', t.contents],
    ['pages', t.pagesTab],
    ['bookmarks', `${t.bookmarks}${bookmarks.length ? ` ${bookmarks.length}` : ''}`],
  ];

  return (
    <Panel title={t.navigate} onClose={onClose} testID="contents-panel">
      <View style={[styles.segment, { backgroundColor: p.hairline }]}>
        {tabs.map(([k, label]) => (
          <Pressable
            key={k}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === k }}
            onPress={() => setTab(k)}
            style={[styles.segBtn, tab === k && [{ backgroundColor: p.raised }, styles.segActive]]}
          >
            <T v="label" color={tab === k ? p.ink : p.muted} style={{ fontFamily: fonts.sansMedium }}>
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
                <Pressable
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

      {tab === 'pages' && (
        <PagesGrid p={p} sizes={sizes} cache={cache} page={page} onGo={onGo} bookmarks={bookmarks} />
      )}

      {tab === 'bookmarks' &&
        (bookmarks.length === 0 ? (
          <Empty p={p} text={t.noBookmarks} />
        ) : (
          <FlatList
            data={bookmarks}
            keyExtractor={(b) => String(b)}
            contentContainerStyle={{ paddingBottom: space.xl }}
            renderItem={({ item }) => {
              const chapter = outline ? [...outline].reverse().find((o) => o.page >= 0 && o.page <= item) : undefined;
              return (
                <Pressable
                  onPress={() => onGo(item)}
                  style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.bmRow, { backgroundColor: hovered ? p.hairline : 'transparent' }]}
                >
                  <Thumb cache={cache} page={item} size={sizes[item]} width={44} palette={p} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T v="headline">{t.pageN(item + 1)}</T>
                    {chapter && (
                      <T v="caption" color={p.muted} numberOfLines={1}>
                        {chapter.title}
                      </T>
                    )}
                  </View>
                  <Icon name="bookmarkFill" size={16} color={p.accent} />
                </Pressable>
              );
            }}
          />
        ))}
    </Panel>
  );
}

function PagesGrid({ p, sizes, cache, page, onGo, bookmarks }: { p: Palette; sizes: Size[]; cache: RasterCache; page: number; onGo: (n: number) => void; bookmarks: number[] }) {
  const cols = 3;
  const [w, setW] = useState(0);
  const cellW = w ? Math.floor((w - space.xl * 2 - space.md * (cols - 1)) / cols) : 0;
  const rowH = cellW * 1.414 + 28;
  const pages = useMemo(() => sizes.map((_, i) => i), [sizes]);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {cellW > 0 && (
        <FlatList
          data={pages}
          numColumns={cols}
          keyExtractor={(i) => String(i)}
          initialScrollIndex={Math.floor(page / cols) * cols}
          getItemLayout={(_, i) => ({ length: rowH, offset: rowH * Math.floor(i / cols), index: i })}
          windowSize={5}
          columnWrapperStyle={{ gap: space.md, paddingHorizontal: space.xl }}
          renderItem={({ item }) => (
            <Pressable onPress={() => onGo(item)} style={{ width: cellW, height: rowH, alignItems: 'center', paddingTop: 4 }}>
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
  segment: { flexDirection: 'row', marginHorizontal: space.xl - 4, marginBottom: space.md, borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  segActive: { boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } as object,
  tocRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingRight: space.xl - 4, paddingVertical: 10, minHeight: 44 },
  tocBar: { position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  bmRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xl - 4, paddingVertical: space.sm },
});
