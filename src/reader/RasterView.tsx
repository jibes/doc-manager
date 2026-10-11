import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';

import type { Palette } from '@/design/tokens';
import type { Raster } from '@/engine/types';

/** Native: rasters are files from PDFKit/PdfRenderer; tint via a blend-mode overlay. */
export function RasterView({ raster, blend }: { raster: Raster | undefined; filter: string; blend?: Palette['page']['blend'] }) {
  return (
    <>
      {raster?.kind === 'uri' && (
        <Image source={{ uri: raster.uri }} style={StyleSheet.absoluteFill} contentFit="fill" transition={0} cachePolicy="memory" />
      )}
      {blend && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: blend.color, mixBlendMode: blend.mode }]}
        />
      )}
    </>
  );
}
