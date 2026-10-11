import { memo } from 'react';
import { View } from 'react-native';

import type { Palette } from '@/design/tokens';
import type { Size } from '@/engine/types';
import { useRaster } from './PageView';
import type { RasterCache } from './rasterCache';
import { RasterView } from './RasterView';

/** Small page preview; shares the document's raster cache with the reading surface. */
export const Thumb = memo(function Thumb({
  cache,
  page,
  size,
  width,
  palette,
}: {
  cache: RasterCache;
  page: number;
  size: Size;
  width: number;
  palette: Palette;
}) {
  const raster = useRaster(cache, page, width, true);
  return (
    <View
      style={{
        width,
        height: Math.round((width * size.height) / size.width),
        backgroundColor: palette.dark ? '#2B2B2B' : '#FFFFFF',
        borderRadius: 2,
        overflow: 'hidden',
        borderWidth: 0.5,
        borderColor: palette.hairline,
      }}
    >
      <RasterView raster={raster} filter={palette.page.cssFilter} blend={palette.page.blend} />
    </View>
  );
});
