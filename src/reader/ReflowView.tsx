import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, PixelRatio, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, T } from '@/components/primitives';
import { space, type Palette } from '@/design/tokens';
import type { DocHandle, Raster } from '@/engine/types';
import { t } from '@/i18n';
import type { Block } from '@/reflow/build';
import { recognizeText, useReflow, type OcrProgress } from '@/reflow/useReflow';
import { BlockList, type BlockListApi, type FigureBox, type FigureSource } from './BlockList';
import { RasterView } from './RasterView';

export type ReflowApi = BlockListApi;

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
  onPosition: (page: number, y: number, atEnd: boolean) => void;
  onScrollY: (y: number) => void;
  onExit: () => void;
  /** A tap on the text: toolbars on/off (reading list). */
  onTap?: () => void;
  apiRef: { current: ReflowApi | null };
};

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

  return <PdfBlocks blocks={reflow.blocks} handle={handle} palette={p} ocr={ocr} {...rest} />;
}

function PdfBlocks({
  blocks,
  handle,
  palette: p,
  ocr,
  onOpenPage,
  ...rest
}: Omit<Props, 'docId' | 'onExit'> & { blocks: Block[]; ocr?: OcrProgress }) {
  // Figures are crops of their page, rendered sharp for the column; a tap shows them on the page.
  const figures = useMemo<FigureSource>(
    () => ({
      box: (b, column) => figureBox(b, handle.pageSizes[b.page], column),
      render: (b, box, column) => <Figure handle={handle} block={b} box={box} column={column} palette={p} onOpen={onOpenPage} />,
    }),
    [handle, p, onOpenPage],
  );
  const footer = ocr ? (
    <View style={[styles.ocrNote, { borderColor: p.hairline }]}>
      {ocr.running && <ActivityIndicator color={p.muted} size="small" />}
      <T v="label" color={p.muted} style={{ flex: 1 }} testID={ocr.running ? 'ocr-progress' : undefined}>
        {ocr.running ? t.ocrProgress(ocr.done, ocr.total) : ocr.failed ? t.ocrFailed : t.ocrNote}
      </T>
      {ocr.failed && <Button label={t.ocrResume} kind="quiet" onPress={() => recognizeText(handle)} />}
    </View>
  ) : null;
  return <BlockList blocks={blocks} palette={p} figures={figures} footer={footer} {...rest} />;
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

/** Figure size in the column: natural size up to the column, tables wider than it scroll sideways at a readable scale. */
function figureBox(b: Block, pg: { width: number; height: number }, column: number): FigureBox {
  const r = b.rect!;
  const natural = r.w * pg.width;
  const aspect = (r.h * pg.height) / (r.w * pg.width);
  const readable = natural * 1.2;
  const width = Math.round(b.table && readable > column ? Math.min(readable, 1600) : Math.min(column, natural * 1.5));
  return { width, height: Math.round(width * aspect), scroll: width > column };
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
  box: FigureBox;
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
  return box.scroll ? (
    <ScrollView horizontal style={{ width: column }} showsHorizontalScrollIndicator>
      {image}
    </ScrollView>
  ) : (
    image
  );
}

const styles = StyleSheet.create({
  ocrNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
});
