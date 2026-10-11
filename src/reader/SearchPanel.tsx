import { useEffect, useRef } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { t } from '@/i18n';
import { Icon } from '@/components/Icon';
import { IconButton, T } from '@/components/primitives';
import { fonts, radius, space, type Palette } from '@/design/tokens';
import type { SearchHit } from '@/engine/types';
import { Panel } from './Panel';

type Props = {
  palette: Palette;
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  active: number;
  searching: boolean;
  onPick: (index: number) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
};

export function SearchPanel({ palette: p, query, onQuery, hits, active, searching, onPick, onStep, onClose }: Props) {
  const list = useRef<FlatList<SearchHit>>(null);
  const input = useRef<TextInput>(null);

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), Platform.OS === 'web' ? 0 : 320);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (active >= 0 && active < hits.length) list.current?.scrollToIndex({ index: active, viewPosition: 0.4, animated: true });
  }, [active, hits.length]);

  const more = hits.length >= 200 && !searching;
  const status = !query.trim()
    ? t.searchIntro
    : searching && !hits.length
      ? t.searching
      : hits.length
        ? active >= 0
          ? t.nOfResults(active + 1, hits.length, more)
          : t.results(hits.length, more)
        : t.noMatches;

  return (
    <Panel title={t.search} onClose={onClose} testID="search-panel">
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
              if (Platform.OS === 'web' && ev.key === 'Enter' && ev.shiftKey) onStep(-1);
            }}
            style={[styles.input, { color: p.ink }]}
          />
          {searching && <ActivityIndicator size="small" color={p.muted} />}
        </View>
        <IconButton icon="up" label={t.previousResult} size={36} disabled={!hits.length} onPress={() => onStep(-1)} />
        <IconButton icon="down" label={t.nextResult} size={36} disabled={!hits.length} onPress={() => onStep(1)} />
      </View>
      <T v="caption" color={p.muted} style={styles.status} accessibilityLiveRegion="polite">
        {status}
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
    </Panel>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: space.xl - 4, paddingRight: space.sm },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 40, borderRadius: radius.md, paddingHorizontal: space.md },
  input: { flex: 1, height: 40, fontFamily: fonts.sans, fontSize: 15, outlineStyle: 'none' } as object,
  status: { paddingHorizontal: space.xl - 4, paddingTop: space.md, paddingBottom: space.sm },
  hit: { flexDirection: 'row', gap: space.sm, paddingVertical: space.md, paddingHorizontal: space.xl - 4 },
});
