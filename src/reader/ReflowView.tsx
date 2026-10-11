import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  PixelRatio,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
} from 'react-native';

import { Button, T } from '@/components/primitives';
import { fonts, space, type Palette } from '@/design/tokens';
import type { DocHandle, Raster, Size } from '@/engine/types';
import { t } from '@/i18n';
import { blockAt, type Block } from '@/reflow/build';
import { recognizeText, useReflow, type OcrProgress } from '@/reflow/useReflow';
import { usePrefs } from '@/state/prefs';
import { RasterView } from './RasterView';

export type ReflowApi = {
  scrollToPage: (page: number) => void;
  /** Scroll to the block holding a search hit at this page position. */
  showHit: (page: number, y: number) => void;
};

type Props = {
  handle: DocHandle;
  docId: string;
  /** Active search query: matches are highlighted in the text. */
  query: string;
  /** Tap on a figure: show it on its page (where it can be zoomed). */
  onOpenPage: (page: number, y: number) => void;
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
export function ReflowView({ handle, docId, palette: p, onExit, ...rest }: Props) {
  const state = useReflow(handle, docId);

  if (state.status === 'loading')
    return (
      <Centered>
        <ActivityIndicator color={p.muted} />
        <T v="label" color={p.muted}>
          {t.preparingText(Math.round(state.progress * 100))}
        </T>
      </Centered>
    );
  const back = <Button label={t.backToPageView} kind="quiet" icon="pageView" onPress={onExit} />;
  if (state.status !== 'ready')
    return (
      <Centered>
        <Message palette={p}>{state.status === 'unsupported' ? t.textViewUnsupported : t.openFailed}</Message>
        {back}
      </Centered>
    );

  const { reflow, ocr, canOcr } = state;
  if (reflow.status === 'no-text') {
    if (ocr?.running)
      return (
        <Centered>
          <ActivityIndicator color={p.muted} />
          <T v="label" color={p.muted} testID="ocr-progress">
            {t.ocrProgress(ocr.done, ocr.total)}
          </T>
        </Centered>
      );
    const message = ocr?.failed ? t.ocrFailed : ocr ? t.ocrNone : canOcr ? t.ocrOffer : t.noTextLayer;
    return (
      <Centered>
        <Message palette={p}>{message}</Message>
        {canOcr && (!ocr || ocr.failed) && (
          <Button label={ocr ? t.ocrResume : t.ocrStart} icon="textView" onPress={() => recognizeText(handle)} testID="ocr-start" />
        )}
        {back}
      </Centered>
    );
  }

  return <Blocks blocks={reflow.blocks} handle={handle} palette={p} ocr={ocr} {...rest} />;
}

function Message({ palette: p, children }: { palette: Palette; children: string }) {
  return (
    <T v="body" color={p.inkSoft} style={{ textAlign: 'center', maxWidth: 420 }}>
      {children}
    </T>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Figure size in the column: natural size up to the column, tables wider than it scroll sideways at a readable scale. */
function figureBox(b: Block, sizes: Size[], column: number) {
  const pg = sizes[b.page];
  const r = b.rect!;
  const natural = r.w * pg.width;
  const aspect = (r.h * pg.height) / (r.w * pg.width);
  const readable = natural * 1.2;
  const width = Math.round(b.table && readable > column ? Math.min(readable, 1600) : Math.min(column, natural * 1.5));
  return { width, height: Math.round(width * aspect), scroll: width > column };
}

function Blocks({
  blocks,
  handle,
  palette: p,
  width,
  padTop,
  padBottom,
  initial,
  query,
  ocr,
  onPosition,
  onScrollY,
  onOpenPage,
  apiRef,
}: Omit<Props, 'docId' | 'onExit'> & { blocks: Block[]; ocr?: OcrProgress }) {
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
        case 'figure':
          return mark + figureBox(b, handle.pageSizes, column).height + space.lg * 2;
        case 'caption':
          return mark + lines(b.text, 0.85) * Math.round(size * 0.85 * 1.4) + space.lg;
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
  }, [blocks, size, lineHeight, column, textFont, headerH, handle.pageSizes]);

  const scrollToIndex = useCallback(
    // Land the block just below the top bar.
    (index: number) => list.current?.scrollToIndex({ index, animated: false, viewOffset: padTop + space.md }),
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
      if (i < 0 || page >= blocks[blocks.length - 1].page + 1) return list.current?.scrollToEnd({ animated: false });
      scrollToIndex(i);
    };
    apiRef.current = { scrollToPage, showHit };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, blocks, scrollToIndex, query]);

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
  // At the very bottom the last blocks can't reach the reading line: the position is then the last block.
  const atEndRef = useRef(false);
  const locate = () => {
    const line = padTop + space.xl;
    const cells = [...cellsRef.current].sort((a, b) => a[0] - b[0]);
    Promise.all(cells.map(([i, v]) => new Promise<[number, number]>((res) => v.measureInWindow((_x, y) => res([i, y]))))).then((tops) => {
      let best = -1;
      for (const [i, y] of tops) if (y <= line) best = i;
      if (best < 0 && tops.length) best = tops[0][0];
      if (atEndRef.current) best = blocks.length - 1;
      if (best >= 0 && best !== currentRef.current) {
        currentRef.current = best;
        onPosition(blocks[best].page, blocks[best].y);
      }
    });
  };
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atEndRef.current = contentOffset.y > 0 && contentOffset.y + layoutMeasurement.height >= contentSize.height - 8;
    onScrollY(contentOffset.y);
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
      ListFooterComponent={
        ocr ? (
          <View style={[styles.ocrNote, { width: column, borderColor: p.hairline }]}>
            {ocr.running && <ActivityIndicator color={p.muted} size="small" />}
            <T v="label" color={p.muted} style={{ flex: 1 }} testID={ocr.running ? 'ocr-progress' : undefined}>
              {ocr.running ? t.ocrProgress(ocr.done, ocr.total) : ocr.failed ? t.ocrFailed : t.ocrNote}
            </T>
            {ocr.failed && <Button label={t.ocrResume} kind="quiet" onPress={() => recognizeText(handle)} />}
          </View>
        ) : null
      }
      contentContainerStyle={{ paddingBottom: padBottom + space.xxxl, alignItems: 'center' }}
      renderItem={({ item, index }) => {
        const newPage = index === 0 || blocks[index - 1].page !== item.page;
        const mark: TextStyle = { backgroundColor: p.mark };
        const text = (s: string) => highlight(s, marks, mark);
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
                  {text(item.text)}
                </T>
              </View>
            ) : item.kind === 'figure' ? (
              <Figure handle={handle} block={item} box={figureBox(item, handle.pageSizes, column)} column={column} palette={p} onOpen={onOpenPage} />
            ) : item.kind === 'caption' ? (
              <T
                selectable
                style={[styles.caption, { fontFamily: fonts.sans, fontSize: Math.round(size * 0.85), lineHeight: Math.round(size * 0.85 * 1.4), color: p.inkSoft }]}
              >
                {text(item.text)}
              </T>
            ) : (
              <T
                selectable
                style={[
                  style,
                  item.kind === 'p' && { marginBottom: lineHeight * 0.75 },
                  item.kind === 'quote' && [styles.quote, { borderColor: p.hairline, marginBottom: lineHeight * 0.75 }],
                ]}
              >
                {text(item.text)}
              </T>
            )}
          </View>
        );
      }}
    />
  );
}

function highlight(s: string, re: RegExp | null, style: TextStyle): ReactNode {
  if (!re) return s;
  const parts = s.split(re);
  if (parts.length === 1) return s;
  // split() with a capture group puts the matches at odd indices.
  return parts.map((part, i) =>
    i % 2 ? (
      <T key={i} style={style}>
        {part}
      </T>
    ) : (
      part
    ),
  );
}

/** A figure or table: that region of the page, rendered sharp for this width, tinted like pages. */
function Figure({
  handle,
  block,
  box,
  column,
  palette: p,
  onOpen,
}: {
  handle: DocHandle;
  block: Block;
  box: { width: number; height: number; scroll: boolean };
  column: number;
  palette: Palette;
  onOpen: (page: number, y: number) => void;
}) {
  const [raster, setRaster] = useState<Raster | undefined>(undefined);
  useEffect(() => {
    const ctrl = new AbortController();
    handle.renderPage(block.page, { width: Math.round(box.width * PixelRatio.get()), clip: block.rect, signal: ctrl.signal }).then(setRaster, () => {});
    return () => ctrl.abort();
  }, [handle, block, box.width]);
  // The canvas keeps its pixels; the bitmap can go once replaced or unmounted.
  useEffect(() => () => void (raster?.kind === 'bitmap' && raster.bitmap.close()), [raster]);

  const label = block.text ? `${block.table ? t.table : t.figure}: ${block.text}` : block.table ? t.table : t.figure;
  const image = (
    <Pressable
      onPress={() => onOpen(block.page, block.y)}
      accessibilityRole="image"
      accessibilityLabel={label}
      accessibilityHint={t.showOnPage(block.page + 1)}
      testID="figure"
      style={{ width: box.width, height: box.height, backgroundColor: '#fff', borderRadius: 2, overflow: 'hidden' }}
    >
      <RasterView raster={raster} filter={p.page.cssFilter} blend={p.page.blend} />
    </Pressable>
  );
  return (
    <View style={styles.figure}>
      {box.scroll ? (
        <ScrollView horizontal style={{ width: column }} showsHorizontalScrollIndicator>
          {image}
        </ScrollView>
      ) : (
        image
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  figure: { marginVertical: space.lg, alignItems: 'center' },
  caption: { marginTop: -space.sm, marginBottom: space.lg },
  ocrNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  h1: { marginTop: space.xl, marginBottom: space.lg, letterSpacing: -0.6 },
  h2: { marginTop: space.lg, marginBottom: space.md, letterSpacing: -0.3 },
  h3: { marginTop: space.md, marginBottom: space.sm },
  label: { fontFamily: fonts.sansSemi, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: space.xl, marginBottom: -space.sm },
  li: { flexDirection: 'row' },
  quote: { fontStyle: 'italic', borderLeftWidth: 2, paddingLeft: space.lg },
  pageMark: { alignSelf: 'flex-end', marginVertical: space.sm, opacity: 0.7 },
});
