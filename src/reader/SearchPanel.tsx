import { useEffect, useRef } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { t } from '@/i18n';
import { Icon } from '@/components/Icon';
import { IconButton, T } from '@/components/primitives';
import { fonts, radius, space, type Palette } from '@/design/tokens';
import type { SearchHit } from '@/engine/types';

/** The search field at the top of Find: typing replaces the contents with matches. */
export function SearchField({
  palette: p,
  query,
  onQuery,
  hits,
  searching,
  autoFocus,
  onStep,
  onClose,
}: {
  palette: Palette;
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  searching: boolean;
  autoFocus: boolean;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => input.current?.focus(), Platform.OS === 'web' ? 0 : 320);
    return () => clearTimeout(t);
  }, [autoFocus]);
  const on = !!query.trim();
  return (
    <View style={styles.bar}>
      <View style={[styles.field, { backgroundColor: p.hairline }]}>
        <Icon name="search" size={17} color={p.muted} />
        <TextInput
          ref={input}
          testID="search-input"
          value={query}
          onChangeText={onQuery}
          placeholder={t.findPlaceholder}
          placeholderTextColor={p.muted}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          onSubmitEditing={() => onStep(1)}
          onKeyPress={(e) => {
            const ev = e.nativeEvent as { key: string; shiftKey?: boolean };
            if (Platform.OS !== 'web') return;
            if (ev.key === 'Enter' && ev.shiftKey) onStep(-1);
            // The input stops key events from bubbling, so Esc would never reach the reader.
            else if (ev.key === 'Escape') onClose();
          }}
          style={[styles.input, { color: p.ink }]}
        />
        {searching && <ActivityIndicator size="small" color={p.muted} />}
        {on && !searching && <IconButton icon="close" label={t.clearSearch} size={28} onPress={() => onQuery('')} testID="search-clear" />}
      </View>
      {on && (
        <>
          <IconButton icon="up" label={t.previousResult} size={36} disabled={!hits.length} onPress={() => onStep(-1)} />
          <IconButton icon="down" label={t.nextResult} size={36} disabled={!hits.length} onPress={() => onStep(1)} />
        </>
      )}
    </View>
  );
}

/** Matches for the query, in place of the contents while there is one. */
export function SearchResults({
  palette: p,
  query,
  hits,
  active,
  searching,
  onPick,
}: {
  palette: Palette;
  query: string;
  hits: SearchHit[];
  active: number;
  searching: boolean;
  onPick: (index: number) => void;
}) {
  const list = useRef<FlatList<SearchHit>>(null);

  useEffect(() => {
    if (active >= 0 && active < hits.length) list.current?.scrollToIndex({ index: active, viewPosition: 0.4, animated: true });
  }, [active, hits.length]);

  const more = hits.length >= 200 && !searching;
  const status =
    searching && !hits.length
      ? t.searching
      : hits.length
        ? active >= 0
          ? t.nOfResults(active + 1, hits.length, more)
          : t.results(hits.length, more)
        : t.noMatches;

  return (
    <View style={{ flex: 1 }} testID="search-results">
      <T v="caption" color={p.muted} style={styles.status} accessibilityLiveRegion="polite">
        {query.trim() ? status : ''}
      </T>
      <FlatList
        ref={list}
        data={hits}
        keyExtractor={(_, i) => String(i)}
        keyboardShouldPersistTaps="handled"
        onScrollToIndexFailed={() => {}}
        contentContainerStyle={{ paddingBottom: space.xl }}
        renderItem={({ item, index }) => {
          const on = index === active;
          const pre = item.snippet.slice(0, item.matchStart).replace(/^\S*\s/, '…');
          const match = item.snippet.slice(item.matchStart, item.matchStart + item.matchLength);
          const post = item.snippet.slice(item.matchStart + item.matchLength).replace(/\s\S*$/, '…');
          const newPage = index === 0 || hits[index - 1].page !== item.page;
          return (
            <Pressable
              onPress={() => onPick(index)}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.hit,
                { backgroundColor: on ? p.accentSoft : hovered ? p.hairline : 'transparent' },
              ]}
            >
              <T v="numeral" color={on ? p.accent : p.muted} style={{ width: 34, opacity: newPage || on ? 1 : 0 }}>
                {item.page + 1}
              </T>
              <T numberOfLines={2} style={{ flex: 1, fontFamily: fonts.serif, fontSize: 15, lineHeight: 21 }} color={p.inkSoft}>
                {pre}
                <T style={{ fontFamily: fonts.serifSemi, fontSize: 15, backgroundColor: p.mark, color: p.ink }}>{match}</T>
                {post}
              </T>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: space.xl - 4, paddingRight: space.sm, marginBottom: space.md, minHeight: 40 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 40, borderRadius: radius.md, paddingHorizontal: space.md },
  input: { flex: 1, height: 40, fontFamily: fonts.sans, fontSize: 15, outlineStyle: 'none' } as object,
  status: { paddingHorizontal: space.xl - 4, paddingTop: space.md, paddingBottom: space.sm },
  hit: { flexDirection: 'row', gap: space.sm, paddingVertical: space.md, paddingHorizontal: space.xl - 4 },
});
