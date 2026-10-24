import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { T } from '@/paper/components/primitives';
import { elevation, type Palette } from '@/core/design/tokens';
import type { DocHandle, FormField, FormValue, PageLink, Raster, SearchHit, TextRun } from '@/core/engine/types';
import { t } from '@/core/i18n';
import { FormLayer } from './FormLayer';
import { LinkLayer } from './LinkLayer';
import { MarksLayer } from './MarksLayer';
import { deviceWidth, type RasterCache } from './rasterCache';
import { RasterView } from './RasterView';
import { TextLayer } from './TextLayer';

/** What an untinted white page looks like under each theme, shown before the raster lands. */

type Props = {
  page: number;
  width: number;
  height: number;
  cache: RasterCache;
  palette: Palette;
  hits?: SearchHit[];
  activeHit?: SearchHit | null;
  /** A click or tap on the page: where on it (0..1 across and down), and where on the screen. */
  onPress?: (page: number, at: { x: number; y: number } | null, client: { x: number; y: number } | null) => void;
  onLink?: (link: PageLink) => void;
  /** A form field on this page was changed. */
  /** Before a field changes (undo comes back to here). */
  beforeEdit?: () => void;
  onEdited?: () => void;
};

/** Text runs and links for a page, fetched shortly after mount so they never compete with the first paint. */
function usePageExtras(handle: DocHandle, page: number) {
  const [extras, setExtras] = useState<{ page: number; text: TextRun[]; links: PageLink[] } | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      Promise.all([handle.pageText(page), handle.links(page)]).then(
        ([text, links]) => alive && setExtras({ page, text, links }),
        () => {},
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [handle, page]);
  return extras?.page === page ? extras : null;
}

/** Fillable fields of a page (forms only), and a setter that re-renders the page with the new value. */
function useFields(cache: RasterCache, page: number, beforeEdit?: () => void, onEdited?: () => void) {
  const { handle } = cache;
  const [fields, setFields] = useState<{ page: number; list: FormField[] } | null>(null);
  // Read again whenever the page changes (a note deleted shifts the places fields are addressed by).
  const version = useSyncExternalStore(cache.subscribe, () => cache.version(page));
  useEffect(() => {
    if (!handle.hasForm) return;
    let alive = true;
    handle.fields(page).then((list) => alive && setFields({ page, list }), () => {});
    return () => {
      alive = false;
    };
  }, [handle, page, version]);
  const change = useCallback(
    (index: number, value: FormValue) => (
      beforeEdit?.(),
      handle.setField(page, index, value).then((list) => {
        setFields({ page, list });
        cache.invalidate(page);
        onEdited?.();
      })
    ),
    [handle, cache, page, beforeEdit, onEdited],
  );
  return { fields: fields?.page === page ? fields.list : null, change };
}

export function useRaster(cache: RasterCache, page: number, cssWidth: number, urgent = false): Raster | undefined {
  const target = deviceWidth(cssWidth);
  const [fetched, setFetched] = useState<{ page: number; raster: Raster } | null>(null);
  // Edits bump the page's version: fetch it again, keeping the old raster on screen meanwhile.
  const version = useSyncExternalStore(cache.subscribe, () => cache.version(page));

  useEffect(() => {
    const ctrl = new AbortController();
    cache.get(page, target, ctrl.signal, urgent).then(
      (raster) => !ctrl.signal.aborted && setFetched({ page, raster }),
      () => {},
    );
    return () => ctrl.abort();
  }, [cache, page, target, urgent, version]);

  // Until the target-resolution raster lands, show whatever this page already has (e.g. pre-zoom).
  return (fetched?.page === page ? fetched.raster : undefined) ?? cache.best(page);
}

export const PageView = memo(function PageView({ page, width, height, cache, palette, hits, activeHit, onPress, onLink, beforeEdit, onEdited }: Props) {
  const raster = useRaster(cache, page, width);
  const extras = usePageExtras(cache.handle, page);
  const form = useFields(cache, page, beforeEdit, onEdited);
  const press = (e: GestureResponderEvent) => {
    if (!onPress) return;
    const ev = e.nativeEvent as unknown as { clientX?: number; clientY?: number; pageX?: number; pageY?: number };
    const x = ev.clientX ?? ev.pageX;
    const y = ev.clientY ?? ev.pageY;
    const box = Platform.OS === 'web' ? (e.currentTarget as unknown as HTMLElement | null)?.getBoundingClientRect?.() : undefined;
    if (x === undefined || y === undefined || !box?.width) return onPress(page, null, null);
    onPress(page, { x: (x - box.left) / box.width, y: (y - box.top) / box.height }, { x, y });
  };
  return (
    <Pressable
      onPress={press}
      role="group"
      aria-label={t.pageN(page + 1)}
      style={[
        styles.page,
        { width, height, backgroundColor: palette.page.base },
        elevation(palette.shadow, 1),
      ]}
    >
      {!raster && (
        <View style={styles.center}>
          <T v="numeral" color={palette.muted} style={{ opacity: 0.6 }}>
            {page + 1}
          </T>
        </View>
      )}
      <RasterView raster={raster} filter={palette.page.cssFilter} blend={palette.page.blend} />
      {extras && <TextLayer page={page} runs={extras.text} width={width} height={height} />}
      {hits && hits.length > 0 && <MarksLayer hits={hits} active={activeHit} width={width} height={height} palette={palette} />}
      {extras && onLink && <LinkLayer links={extras.links} width={width} height={height} onLink={onLink} />}
      {form.fields && form.fields.length > 0 && (
        <FormLayer
          fields={form.fields}
          width={width}
          height={height}
          scale={width / cache.handle.pageSizes[page].width}
          filter={palette.page.cssFilter}
          onChange={form.change}
        />
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  page: { borderRadius: 2, overflow: 'hidden', alignSelf: 'center' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
