import Svg, { Path, Rect } from 'react-native-svg';

import { usePalette } from '@/state/prefs';

// Geometry mirrors scripts/make-icons.mjs: a portrait page in four tiles; the accent tile carries the fold.
const W = 7.95;
const H = 10.35;
const X = [3.4, 12.65];
const Y = [1, 12.65];
const FOLD = `M${X[1]} ${Y[0]}h${W * 0.62}l${W * 0.38} ${H * 0.3}V${Y[0] + H}H${X[1]}Z`;

/** Tessel mark: the accent tile is "where you left off". */
export function Mark({ size = 24 }: { size?: number }) {
  const p = usePalette();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={X[0]} y={Y[0]} width={W} height={H} rx={1.1} fill={p.ink} />
      <Path d={FOLD} fill={p.accent} />
      <Rect x={X[0]} y={Y[1]} width={W} height={H} rx={1.1} fill={p.ink} />
      <Rect x={X[1]} y={Y[1]} width={W} height={H} rx={1.1} fill={p.ink} opacity={0.35} />
    </Svg>
  );
}
