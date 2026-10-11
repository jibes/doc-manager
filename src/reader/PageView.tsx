import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { T } from '@/components/primitives';
import { elevation, type Palette } from '@/design/tokens';
import type { Raster, SearchHit } from '@/engine/types';
import { deviceWidth, type RasterCache } from './rasterCache';
import { RasterView } from './RasterView';

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
};

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

export const PageView = memo(function PageView({ page, width, height, cache, palette, hits, activeHit, onPress }: Props) {
  const raster = useRaster(cache, page, width);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="image"
      accessibilityLabel={`Page ${page + 1}`}
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
      {hits?.map((h, i) =>
        h.rects.map((r, j) => {
          const active = h === activeHit;
          return (
            <View
              key={`${i}-${j}`}
              testID={active ? 'hit-active' : 'hit'}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: r.x * width - 1.5,
                top: r.y * height - 1,
                width: r.w * width + 3,
                height: r.h * height + 2,
                borderRadius: 2,
                backgroundColor: active ? palette.markActive : palette.mark,
                mixBlendMode: palette.dark ? 'screen' : 'multiply',
                borderWidth: active ? 1.5 : 0,
                borderColor: palette.markRing,
              }}
            />
          );
        }),
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  page: { borderRadius: 2, overflow: 'hidden', alignSelf: 'center' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
