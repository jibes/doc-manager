import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { Button, T } from '@/components/primitives';
import { fonts, space, type Palette } from '@/design/tokens';
import type { DocHandle } from '@/engine/types';
import { t } from '@/i18n';
import { blockAt, type Block } from '@/reflow/build';
import { useReflow } from '@/reflow/useReflow';
import { usePrefs } from '@/state/prefs';

export type ReflowApi = { scrollToPage: (page: number) => void };

type Props = {
  handle: DocHandle;
  palette: Palette;
  width: number;
  padTop: number;
  padBottom: number;
  /** Where to open: page + top fraction, shared with page view. */
  initial: { page: number; y: number };
  onPosition: (page: number, y: number) => void;
  onScrollY: (y: number) => void;
  onExit: () => void;
  apiRef: { current: ReflowApi | null };
};

const LEADING = { compact: 1.38, normal: 1.58, relaxed: 1.8 } as const;
const MEASURE = { narrow: 30, medium: 36, wide: 44 } as const;

/** The document as reflowed text: one comfortable column, typography from the reader's settings. */
export function ReflowView({ handle, palette: p, width, padTop, padBottom, initial, onPosition, onScrollY, onExit, apiRef }: Props) {
  const state = useReflow(handle);

  if (state.status === 'loading')
    return (
      <Centered>
        <ActivityIndicator color={p.muted} />
        <T v="label" color={p.muted}>
          {t.preparingText(Math.round(state.progress * 100))}
        </T>
      </Centered>
    );
  if (state.status !== 'ready' || state.reflow.status === 'no-text')
    return (
      <Centered>
        <T v="body" color={p.inkSoft} style={{ textAlign: 'center', maxWidth: 420 }}>
          {state.status === 'unsupported' ? t.textViewUnsupported : state.status === 'error' ? t.openFailed : t.noTextLayer}
        </T>
        <Button label={t.backToPageView} kind="quiet" icon="pageView" onPress={onExit} />
      </Centered>
    );

  return (
    <Blocks
      blocks={state.reflow.blocks}
      palette={p}
      width={width}
      padTop={padTop}
      padBottom={padBottom}
      initial={initial}
      onPosition={onPosition}
      onScrollY={onScrollY}
      apiRef={apiRef}
    />
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

function Blocks({
  blocks,
  palette: p,
  width,
  padTop,
  padBottom,
  initial,
  onPosition,
  onScrollY,
  apiRef,
}: Omit<Props, 'handle' | 'onExit'> & { blocks: Block[] }) {
  const { textFont, textScale, textLeading, textWidth } = usePrefs();
  const list = useRef<FlatList<Block>>(null);
  const size = Math.round((width < 600 ? 18 : 19) * textScale);
  const lineHeight = Math.round(size * LEADING[textLeading]);
  const column = Math.min(width - (width < 600 ? 40 : 96), size * MEASURE[textWidth]);
  const family = textFont === 'serif' ? fonts.serifRegular : fonts.sans;

  const headerH = padTop + space.xl;

  // Estimated block heights from text length and typography: lets the list jump straight to any
  // block (getItemLayout) instead of rendering everything above it first.
  const est = useMemo(() => {
    const charW = size * (textFont === 'serif' ? 0.47 : 0.52);
    const lines = (text: string, scale: number) => Math.max(1, Math.ceil((text.length * charW * scale) / column));
    const heights = blocks.map((b, i) => {
      const mark = i > 0 && blocks[i - 1].page !== b.page ? size * 0.75 + space.lg : 0;
      const h = (scale: number, margin: number) => lines(b.text, scale) * Math.round(size * scale * 1.22) + margin;
      switch (b.kind) {
        case 'h1':
          return mark + h(1.7, space.xl + space.lg);
        case 'h2':
          return mark + h(1.35, space.lg + space.md);
        case 'h3':
          return mark + h(1.08, space.md + space.sm);
        case 'label':
          return mark + size + space.xl - space.sm;
        default:
          return mark + lines(b.text, b.kind === 'li' ? 1.08 : 1) * lineHeight + lineHeight * (b.kind === 'li' ? 0.35 : 0.75);
      }
    });
    const offsets: number[] = [];
    let y = headerH;
    for (const h of heights) {
      offsets.push(y);
      y += h;
    }
    return { heights, offsets };
  }, [blocks, size, lineHeight, column, textFont, headerH]);

  const scrollToIndex = useCallback(
    // Land the block just below the top bar.
    (index: number) => list.current?.scrollToIndex({ index, animated: false, viewOffset: padTop + space.md }),
    [padTop],
  );

  useEffect(() => {
    apiRef.current = { scrollToPage: (page) => scrollToIndex(blockAt(blocks, page, 0)) };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, blocks, scrollToIndex]);

  // Open where the page view was.
  const start = useMemo(() => blockAt(blocks, initial.page, initial.y), [blocks, initial.page, initial.y]);
  useEffect(() => {
    if (start > 0) requestAnimationFrame(() => scrollToIndex(start));
    // Only on mount: later position changes come from this view itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position = the rendered block crossing a reading line just below the top bar, measured on screen
  // (estimates place the list; measurement keeps the reported position exact).
  const cellsRef = useRef(new Map<number, View>());
  const currentRef = useRef(start);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const locate = () => {
    const line = padTop + space.xl;
    const cells = [...cellsRef.current].sort((a, b) => a[0] - b[0]);
    Promise.all(cells.map(([i, v]) => new Promise<[number, number]>((res) => v.measureInWindow((_x, y) => res([i, y]))))).then((tops) => {
      let best = -1;
      for (const [i, y] of tops) if (y <= line) best = i;
      if (best < 0 && tops.length) best = tops[0][0];
      if (best >= 0 && best !== currentRef.current) {
        currentRef.current = best;
        onPosition(blocks[best].page, blocks[best].y);
      }
    });
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollY(e.nativeEvent.contentOffset.y);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(locate, 80);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const heading = (scale: number, family: string) => ({ fontFamily: family, fontSize: Math.round(size * scale), lineHeight: Math.round(size * scale * 1.22), color: p.ink });

  return (
    <FlatList
      ref={list}
      testID="text-view"
      data={blocks}
      keyExtractor={(_, i) => String(i)}
      onScroll={onScroll}
      scrollEventThrottle={32}
      getItemLayout={(_, i) => ({ length: est.heights[i], offset: est.offsets[i], index: i })}
      initialScrollIndex={start}
      initialNumToRender={12}
      windowSize={9}
      ListHeaderComponent={<View style={{ height: headerH }} />}
      contentContainerStyle={{ paddingBottom: padBottom + space.xxxl, alignItems: 'center' }}
      renderItem={({ item, index }) => {
        const newPage = index === 0 || blocks[index - 1].page !== item.page;
        const style =
          item.kind === 'h1'
            ? [heading(1.7, fonts.sansSemi), styles.h1]
            : item.kind === 'h2'
              ? [heading(1.35, fonts.sansSemi), styles.h2]
              : item.kind === 'h3'
                ? [heading(1.08, fonts.sansSemi), styles.h3]
                : item.kind === 'label'
                  ? [styles.label, { fontSize: Math.round(size * 0.68), color: p.accent }]
                  : { fontFamily: family, fontSize: size, lineHeight, color: p.ink };
        return (
          <View
            style={{ width: column }}
            ref={(v) => {
              if (v) cellsRef.current.set(index, v);
              else cellsRef.current.delete(index);
            }}
          >
            {newPage && index > 0 && (
              <T v="numeral" color={p.muted} style={styles.pageMark} accessibilityLabel={t.pageN(item.page + 1)}>
                {item.page + 1}
              </T>
            )}
            {item.kind === 'li' ? (
              <View style={[styles.li, { marginBottom: lineHeight * 0.35 }]}>
                <T selectable style={{ fontFamily: family, fontSize: size, lineHeight, color: p.muted, minWidth: size * 1.4 }}>
                  {item.marker ?? '•'}
                </T>
                <T selectable style={{ flex: 1, fontFamily: family, fontSize: size, lineHeight, color: p.ink }}>
                  {item.text}
                </T>
              </View>
            ) : (
              <T
                selectable
                style={[
                  style,
                  item.kind === 'p' && { marginBottom: lineHeight * 0.75 },
                  item.kind === 'quote' && [styles.quote, { borderColor: p.hairline, marginBottom: lineHeight * 0.75 }],
                ]}
              >
                {item.text}
              </T>
            )}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  h1: { marginTop: space.xl, marginBottom: space.lg, letterSpacing: -0.6 },
  h2: { marginTop: space.lg, marginBottom: space.md, letterSpacing: -0.3 },
  h3: { marginTop: space.md, marginBottom: space.sm },
  label: { fontFamily: fonts.sansSemi, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: space.xl, marginBottom: -space.sm },
  li: { flexDirection: 'row' },
  quote: { fontStyle: 'italic', borderLeftWidth: 2, paddingLeft: space.lg },
  pageMark: { alignSelf: 'flex-end', marginVertical: space.sm, opacity: 0.7 },
});
