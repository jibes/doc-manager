import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/primitives';
import { elevation, type Palette } from '@/design/tokens';
import type { DocHandle, PageLink, Raster, SearchHit, TextRun } from '@/engine/types';
import { t } from '@/i18n';
import { LinkLayer } from './LinkLayer';
import { MarksLayer } from './MarksLayer';
import { deviceWidth, type RasterCache } from './rasterCache';
import { RasterView } from './RasterView';
import { TextLayer } from './TextLayer';

/** What an untinted white page looks like under each theme, shown before the raster lands. */
const PAGE_BASE: Record<Palette['name'], string> = { paper: '#FFFFFF', sepia: '#F3E6CC', dusk: '#2B2B2B', night: '#151515' };

type Props = {
  page: number;
  width: number;
  height: number;
  cache: RasterCache;
  palette: Palette;
  hits?: SearchHit[];
  activeHit?: SearchHit | null;
  onPress?: () => void;
  onLink?: (link: PageLink) => void;
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

export function useRaster(cache: RasterCache, page: number, cssWidth: number, urgent = false): Raster | undefined {
  const target = deviceWidth(cssWidth);
  const [fetched, setFetched] = useState<{ page: number; raster: Raster } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    cache.get(page, target, ctrl.signal, urgent).then(
      (raster) => !ctrl.signal.aborted && setFetched({ page, raster }),
      () => {},
    );
    return () => ctrl.abort();
  }, [cache, page, target, urgent]);

  // Until the target-resolution raster lands, show whatever this page already has (e.g. pre-zoom).
  return (fetched?.page === page ? fetched.raster : undefined) ?? cache.best(page);
}

export const PageView = memo(function PageView({ page, width, height, cache, palette, hits, activeHit, onPress, onLink }: Props) {
  const raster = useRaster(cache, page, width);
  const extras = usePageExtras(cache.handle, page);
  return (
    <Pressable
      onPress={onPress}
      role="group"
      aria-label={t.pageN(page + 1)}
      style={[
        styles.page,
        { width, height, backgroundColor: PAGE_BASE[palette.name] },
        palette.name !== 'night' && elevation(palette.shadow, 1),
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
      {extras && <TextLayer runs={extras.text} width={width} height={height} />}
      {hits && hits.length > 0 && <MarksLayer hits={hits} active={activeHit} width={width} height={height} palette={palette} />}
      {extras && onLink && <LinkLayer links={extras.links} width={width} height={height} onLink={onLink} />}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  page: { borderRadius: 2, overflow: 'hidden', alignSelf: 'center' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
