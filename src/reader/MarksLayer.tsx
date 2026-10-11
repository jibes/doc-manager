import { memo } from 'react';
import { View } from 'react-native';

import type { Palette } from '@/design/tokens';
import type { SearchHit } from '@/engine/types';

type Props = { hits: SearchHit[]; active: SearchHit | null | undefined; width: number; height: number; palette: Palette };

/** Search highlights as views (native). The web version draws them into a single canvas. */
export const MarksLayer = memo(function MarksLayer({ hits, active, width, height, palette }: Props) {
  return (
    <>
      {hits.map((h, i) =>
        h.rects.map((r, j) => {
          const on = h === active;
          return (
            <View
              key={`${i}-${j}`}
              testID={on ? 'hit-active' : 'hit'}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: r.x * width - 1.5,
                top: r.y * height - 1,
                width: r.w * width + 3,
                height: r.h * height + 2,
                borderRadius: 2,
                backgroundColor: on ? palette.markActive : palette.mark,
                mixBlendMode: palette.dark ? 'screen' : 'multiply',
                borderWidth: on ? 1.5 : 0,
                borderColor: palette.markRing,
              }}
            />
          );
        }),
      )}
    </>
  );
});
