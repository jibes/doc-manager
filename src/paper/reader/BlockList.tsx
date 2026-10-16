import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { FlatList, Platform, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type TextStyle } from 'react-native';

import { T } from '@/paper/components/primitives';
import { fonts, space, type Palette } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { blockAt, type Block } from '@/core/reflow/build';
import { usePrefs } from '@/paper/state/prefs';

export type BlockListApi = {
  scrollToPage: (page: number) => void;
  /** Scroll to the block holding a search hit at this page position. */
  showHit: (page: number, y: number) => void;
  scrollToBlock: (index: number) => void;
  /** Keyboard scrolling: by a distance in pixels. */
  scrollBy: (dy: number, animated?: boolean) => void;
};

export type FigureBox = { width: number; height: number; scroll: boolean };
/** How figures are sized and drawn: a crop of a PDF page, or a book's image file. */
export type FigureSource = {
  box: (b: Block, column: number) => FigureBox;
  render: (b: Block, box: FigureBox, column: number) => ReactNode;
};

export type BlockListProps = {
  blocks: Block[];
  palette: Palette;
  width: number;
  padTop: number;
  padBottom: number;
  /** Where to open: page + top fraction. */
  initial: { page: number; y: number };
  /** Active search query: matches are highlighted in the text. */
  query: string;
  /**
   * The block at the reading line. `atEnd`: scrolled to the very end by the reader (wheel, touch, keys);
   * jumps (contents, links, search hits) that land at the end don't count, so they don't finish a book.
   */
  onPosition: (page: number, y: number, atEnd: boolean) => void;
  onScrollY: (y: number) => void;
  apiRef: { current: BlockListApi | null };
  figures: FigureSource;
  /** Links inside the text (books): internal targets and web addresses. */
  onLink?: (href: string) => void;
  /** A tap on the text (not a drag, scroll or selection): shows or hides the reader's toolbars. */
  onTap?: () => void;
  footer?: ReactNode;
};

const LEADING = { compact: 1.38, normal: 1.58, relaxed: 1.8 } as const;
const MEASURE = { narrow: 30, medium: 36, wide: 44 } as const;
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text blocks in one comfortable column, typography from the reader's settings. Shared by the PDF text view and books. */
export function BlockList({
  blocks,
  palette: p,
  width,
  padTop,
  padBottom,
  initial,
  query,
  onPosition,
  onScrollY,
  apiRef,
  figures,
  onLink,
  onTap,
  footer,
}: BlockListProps) {
  const { textFont, textScale, textLeading, textWidth } = usePrefs();
  const list = useRef<FlatList<Block>>(null);
  const yRef = useRef(0);
  const size = Math.round((width < 600 ? 18 : 19) * textScale);
  const lineHeight = Math.round(size * LEADING[textLeading]);
  const column = Math.min(width - (width < 600 ? 40 : 96), size * MEASURE[textWidth]);
  const family = textFont === 'serif' ? fonts.serifRegular : fonts.sans;

  const headerH = padTop + space.xl;

  // Estimated block heights from text length and typography: lets the list jump straight to any
  // block (getItemLayout) instead of rendering everything above it first.
  const est = useMemo(() => {
    const charW = size * (textFont === 'serif' ? 0.47 : 0.52);
    const lines = (text: string, scale: number) =>
      text.split('\n').reduce((n, part) => n + Math.max(1, Math.ceil((part.length * charW * scale) / column)), 0);
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
        case 'figure':
          return mark + figures.box(b, column).height + space.lg * 2;
        case 'caption':
          return mark + lines(b.text, 0.85) * Math.round(size * 0.85 * 1.4) + space.lg;
        case 'rule':
          return mark + size * 1.5 + space.xl * 2;
        case 'code':
          return mark + b.text.split('\n').length * Math.round(size * 0.82 * 1.5) + space.lg * 2 + lineHeight * 0.75;
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
  }, [blocks, size, lineHeight, column, textFont, headerH, figures]);

  // Set once anything navigates; the deferred "open where the reader was" scroll must not override it.
  const navigatedRef = useRef(false);
  const jumpAtRef = useRef(0);
  const scrollToIndex = useCallback(
    // Land the block just below the top bar.
    (index: number) => {
      navigatedRef.current = true;
      jumpAtRef.current = Date.now();
      list.current?.scrollToIndex({ index, animated: false, viewOffset: padTop + space.md });
    },
    [padTop],
  );

  // Search matches: highlighted in place; a hit maps to the block on its page that holds the query,
  // nearest at or above the hit (blocks in column order aren't sorted by y).
  const marks = useMemo(() => (query.length >= 2 ? new RegExp(`(${escape(query)})`, 'gi') : null), [query]);
  useEffect(() => {
    const has = query.length >= 2 ? new RegExp(escape(query), 'i') : null;
    const showHit = (page: number, y: number) => {
      let best = blockAt(blocks, page, y);
      let bestD = Infinity;
      for (let i = blockAt(blocks, page, 0); has && i < blocks.length && blocks[i].page <= page; i++) {
        const b = blocks[i];
        if (!has.test(b.text)) continue;
        const top = b.page < page ? b.y - 1 : b.y;
        const d = top <= y + 0.005 ? y - top : 1 + top - y;
        if (d < bestD) [best, bestD] = [i, d];
      }
      scrollToIndex(best);
    };
    // A page jump lands on the first block starting on that page (a paragraph carried over from the
    // previous page would show the wrong page number); past the last block, the end of the text.
    const scrollToPage = (page: number) => {
      const i = blocks.findIndex((b) => b.page >= page);
      if (i < 0 || page >= blocks[blocks.length - 1].page + 1) {
        navigatedRef.current = true;
        jumpAtRef.current = Date.now();
        return list.current?.scrollToEnd({ animated: false });
      }
      scrollToIndex(i);
    };
    const scrollBy = (dy: number, animated = false) => list.current?.scrollToOffset({ offset: Math.max(0, yRef.current + dy), animated });
    apiRef.current = { scrollToPage, showHit, scrollToBlock: scrollToIndex, scrollBy };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, blocks, scrollToIndex, query]);

  // Open where the reader was.
  const start = useMemo(() => blockAt(blocks, initial.page, initial.y), [blocks, initial.page, initial.y]);
  // Only once, when it opens: later position changes come from this view itself.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (start > 0) requestAnimationFrame(() => !navigatedRef.current && scrollToIndex(start));
  }, [start, scrollToIndex]);

  // Position = the rendered block crossing a reading line just below the top bar, measured on screen
  // (estimates place the list; measurement keeps the reported position exact).
  const cellsRef = useRef(new Map<number, View>());
  const currentRef = useRef(start);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // At the very bottom the last blocks can't reach the reading line: the position is then the last block.
  // `atEnd` additionally needs the reader to have scrolled there (not a jump): only that finishes a book.
  const bottomRef = useRef(false);
  const atEndRef = useRef(false);
  // Whether the end was the last thing reported.
  const endRef = useRef(false);
  const locate = () => {
    const line = padTop + space.xl;
    const cells = [...cellsRef.current].sort((a, b) => a[0] - b[0]);
    Promise.all(cells.map(([i, v]) => new Promise<[number, number]>((res) => v.measureInWindow((_x, y) => res([i, y]))))).then((tops) => {
      let best = -1;
      for (const [i, y] of tops) if (y <= line) best = i;
      if (best < 0 && tops.length) best = tops[0][0];
      const atEnd = atEndRef.current;
      if (bottomRef.current) best = blocks.length - 1;
      // Also when the end is left again (on the same block): the reader then no longer shows 100 %.
      if (best >= 0 && (best !== currentRef.current || atEnd || endRef.current)) {
        currentRef.current = best;
        endRef.current = atEnd;
        onPosition(blocks[best].page, blocks[best].y, atEnd);
      }
    });
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    yRef.current = contentOffset.y;
    const bottom = contentOffset.y > 0 && contentOffset.y + layoutMeasurement.height >= contentSize.height - 8;
    bottomRef.current = bottom;
    atEndRef.current = bottom && Date.now() - jumpAtRef.current > 800;
    onScrollY(contentOffset.y);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(locate, 80);
  };
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const downRef = useRef<{ x: number; y: number; at: number; scroll: number } | null>(null);
  const onPointerDown = (e: { nativeEvent: { clientX?: number; clientY?: number; pageX?: number; pageY?: number } }) => {
    const n = e.nativeEvent;
    downRef.current = { x: n.clientX ?? n.pageX ?? 0, y: n.clientY ?? n.pageY ?? 0, at: Date.now(), scroll: yRef.current };
  };
  const onPointerUp = (e: { nativeEvent: { clientX?: number; clientY?: number; pageX?: number; pageY?: number } }) => {
    const d = downRef.current;
    downRef.current = null;
    if (!d || !onTap) return;
    const n = e.nativeEvent;
    const moved = Math.hypot((n.clientX ?? n.pageX ?? 0) - d.x, (n.clientY ?? n.pageY ?? 0) - d.y);
    if (moved > 8 || Date.now() - d.at > 350 || Math.abs(yRef.current - d.scroll) > 4) return;
    // Finishing a text selection is a click too.
    if (Platform.OS === 'web' && window.getSelection()?.toString()) return;
    onTap();
  };

  const heading = (scale: number, family: string) => ({ fontFamily: family, fontSize: Math.round(size * scale), lineHeight: Math.round(size * scale * 1.22), color: p.ink });

  return (
    <FlatList
      ref={list}
      testID="text-view"
      data={blocks}
      keyExtractor={(_, i) => String(i)}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      scrollEventThrottle={32}
      getItemLayout={(_, i) => ({ length: est.heights[i], offset: est.offsets[i], index: i })}
      initialScrollIndex={start}
      initialNumToRender={12}
      windowSize={9}
      ListHeaderComponent={<View style={{ height: headerH }} />}
      ListFooterComponent={footer ? <View style={{ width: column }}>{footer}</View> : null}
      contentContainerStyle={{ paddingBottom: padBottom + space.xxxl, alignItems: 'center' }}
      renderItem={({ item, index }) => {
        const newPage = index === 0 || blocks[index - 1].page !== item.page;
        const inline = (b: Block) => content(b, { marks, mark: { backgroundColor: p.mark }, link: { color: p.accent, textDecorationLine: 'underline' }, size, onLink });
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
                  {inline(item)}
                </T>
              </View>
            ) : item.kind === 'figure' ? (
              <View style={styles.figure}>{figures.render(item, figures.box(item, column), column)}</View>
            ) : item.kind === 'caption' ? (
              <T
                selectable
                style={[styles.caption, { fontFamily: fonts.sans, fontSize: Math.round(size * 0.85), lineHeight: Math.round(size * 0.85 * 1.4), color: p.inkSoft }]}
              >
                {inline(item)}
              </T>
            ) : item.kind === 'rule' ? (
              <T accessibilityLabel={t.sceneBreak} style={[styles.rule, { fontSize: size, color: p.muted }]}>
                ⁂
              </T>
            ) : item.kind === 'code' ? (
              <View style={[styles.code, { backgroundColor: p.hairline, marginBottom: lineHeight * 0.75 }]}>
                <T selectable style={{ fontFamily: MONO, fontSize: Math.round(size * 0.82), lineHeight: Math.round(size * 0.82 * 1.5), color: p.ink }}>
                  {inline(item)}
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
                {inline(item)}
              </T>
            )}
          </View>
        );
      }}
    />
  );
}

type InlineStyles = { marks: RegExp | null; mark: TextStyle; link: TextStyle; size: number; onLink?: (href: string) => void };

/** A block's text: its runs (emphasis, footnote marks, links) with search matches highlighted inside them. */
function content(b: Block, s: InlineStyles): ReactNode {
  if (!b.runs) return highlight(b.text, s.marks, s.mark);
  return b.runs.map((r, i) => {
    const style: TextStyle[] = [];
    if (r.em) style.push({ fontStyle: 'italic' });
    if (r.strong) style.push({ fontWeight: '700' });
    if (r.code) style.push({ fontFamily: MONO, fontSize: s.size * 0.88 });
    if (r.sup) style.push({ fontSize: s.size * 0.68, ...(Platform.OS === 'web' ? ({ verticalAlign: 'super', lineHeight: 0 } as object) : {}) });
    if (r.href) style.push(s.link);
    // Plain Text, not T: nested spans must inherit the block's font, size and colour.
    return (
      <Text key={i} style={style} onPress={r.href && s.onLink ? () => s.onLink!(r.href!) : undefined} accessibilityRole={r.href ? 'link' : undefined}>
        {highlight(r.text, s.marks, s.mark)}
      </Text>
    );
  });
}

function highlight(text: string, re: RegExp | null, style: TextStyle): ReactNode {
  if (!re) return text;
  const parts = text.split(re);
  if (parts.length === 1) return text;
  // split() with a capture group puts the matches at odd indices.
  return parts.map((part, i) =>
    i % 2 ? (
      <Text key={i} style={style}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  figure: { marginVertical: space.lg, alignItems: 'center' },
  caption: { marginTop: -space.sm, marginBottom: space.lg },
  h1: { marginTop: space.xl, marginBottom: space.lg, letterSpacing: -0.6 },
  h2: { marginTop: space.lg, marginBottom: space.md, letterSpacing: -0.3 },
  h3: { marginTop: space.md, marginBottom: space.sm },
  label: { fontFamily: fonts.sansSemi, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: space.xl, marginBottom: -space.sm },
  li: { flexDirection: 'row' },
  quote: { fontStyle: 'italic', borderLeftWidth: 2, paddingLeft: space.lg },
  rule: { textAlign: 'center', marginVertical: space.xl, letterSpacing: 4 },
  code: { borderRadius: 6, padding: space.md },
  pageMark: { alignSelf: 'flex-end', marginVertical: space.sm, opacity: 0.7 },
});
