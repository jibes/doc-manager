import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { elevation, radius, space } from '@/core/design/tokens';
import { engine } from '@/core/engine';
import type { DocSource, Raster } from '@/core/engine/types';
import { errorText, t } from '@/core/i18n';
import { folders } from '@/core/lib/folders';
import { repo } from '@/core/storage';
import { Button, T } from '@/paper/components/primitives';
import { RasterView } from '@/paper/reader/RasterView';
import { usePalette } from '@/paper/state/prefs';
import { realTitle } from './pdfInfo';
import type { IndexedDoc } from './search';

/** The file of a document in a list, to look at without opening it. */
async function sourceOf(doc: IndexedDoc): Promise<DocSource> {
  const { place } = doc;
  if (place.kind === 'library') return repo.source(place.id);
  return { kind: 'bytes', bytes: await (await folders.read(place.root, place.entry)).arrayBuffer() };
}

/**
 * A look at a document's first page without opening it (Space in the list, as in the Finder): Space or Esc
 * closes it, ↑ ↓ look at the next one, Enter opens it.
 */
export function QuickLook({ doc, onClose, onStep, onOpen }: { doc: IndexedDoc; onClose: () => void; onStep: (dir: 1 | -1) => void; onOpen: () => void }) {
  const p = usePalette();
  const { width, height } = useWindowDimensions();
  const [shown, setShown] = useState<{ key: string; raster: Raster | null; pages: number; error?: string } | null>(null);
  // The page as big as the window allows (a portrait page: its height).
  const boxH = Math.round(height * 0.78);
  const boxW = Math.round(Math.min(width * 0.8, boxH / 1.414));

  useEffect(() => {
    let alive = true;
    (async () => {
      const handle = await engine.open(await sourceOf(doc));
      try {
        const size = handle.pageSizes[0];
        const w = Math.min(boxW, (boxH * size.width) / size.height);
        const raster = await handle.renderPage(0, { width: Math.round(w * (globalThis.devicePixelRatio || 1)) });
        if (alive) setShown({ key: doc.key, raster, pages: handle.pageCount });
      } finally {
        handle.close();
      }
    })().catch((e: unknown) => alive && setShown({ key: doc.key, raster: null, pages: 0, error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [doc, boxW, boxH]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = { ' ': onClose, Escape: onClose, Enter: onOpen, ArrowDown: () => onStep(1), ArrowUp: () => onStep(-1), ArrowRight: () => onStep(1), ArrowLeft: () => onStep(-1) };
      const fn = keys[e.key];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    // Before the list's own keys.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onOpen, onStep]);

  const now = shown?.key === doc.key ? shown : null;
  const raster = now?.raster;
  const pageW = raster ? Math.round(raster.width / (globalThis.devicePixelRatio || 1)) : boxW;
  const pageH = raster ? Math.round(raster.height / (globalThis.devicePixelRatio || 1)) : boxH;
  return (
    <View style={StyleSheet.absoluteFill} testID="quick-look">
      <Animated.View entering={FadeIn.duration(140)} exiting={FadeOut.duration(100)} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel={t.close} style={[StyleSheet.absoluteFill, { backgroundColor: p.scrim }]} onPress={onClose} />
      </Animated.View>
      <View pointerEvents="box-none" style={styles.center}>
        <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}>
          <View style={[styles.page, { width: pageW, height: pageH, backgroundColor: p.page.base }]}>
            {raster ? (
              <RasterView raster={raster} filter={p.page.cssFilter} />
            ) : now?.error ? (
              <T v="caption" color={p.muted} style={{ padding: space.lg, textAlign: 'center' }}>
                {now.error}
              </T>
            ) : (
              <ActivityIndicator color={p.muted} />
            )}
          </View>
          <View style={styles.foot}>
            <View style={{ flex: 1 }}>
              <T v="label" numberOfLines={1}>
                {realTitle(doc.title) || doc.name.replace(/\.pdf$/i, '')}
              </T>
              {!!now?.pages && (
                <T v="caption" color={p.muted}>
                  {t.scanPages(now.pages)}
                </T>
              )}
            </View>
            <Button testID="quick-look-open" label={t.open} onPress={onOpen} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.md, gap: space.md },
  page: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: radius.sm },
  foot: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xs },
});
