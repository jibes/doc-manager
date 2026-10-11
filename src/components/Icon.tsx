import Svg, { Path } from 'react-native-svg';

/** 24-grid, 1.6 stroke, round caps. Drawn for this app, one visual voice. */
const paths = {
  back: 'M14.5 5.5 8 12l6.5 6.5',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  plus: 'M12 5v14M5 12h14',
  search: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM15.6 15.6 20 20',
  contents: 'M4 6.5h.01M8 6.5h12M4 12h.01M8 12h12M4 17.5h.01M8 17.5h8',
  type: 'M3.5 18.5 8 6.5l4.5 12M5.2 14h5.6M15 18.5V13a2.75 2.75 0 0 1 5.5 0v5.5M15 15.25h5.5',
  bookmark: 'M7 4.5h10v15l-5-3.6-5 3.6v-15Z',
  bookmarkFill: 'M7 4.5h10v15l-5-3.6-5 3.6v-15Z',
  zoomIn: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM15.6 15.6 20 20M10.75 8v5.5M8 10.75h5.5',
  zoomOut: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM15.6 15.6 20 20M8 10.75h5.5',
  trash: 'M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7',
  pages: 'M5 4.5h5.5v6.5H5zM13.5 4.5H19v6.5h-5.5zM5 13.5h5.5V20H5zM13.5 13.5H19V20h-5.5z',
  install: 'M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13',
  readingAdd: 'M6 5.5a1.5 1.5 0 0 1 1.5-1.5H18v13.5H7.75A1.75 1.75 0 0 0 6 19.25V5.5ZM6 19.25A1.75 1.75 0 0 0 7.75 21H18v-3.5M12 7.25v6M9 10.25h6',
  readingOn: 'M6 5.5a1.5 1.5 0 0 1 1.5-1.5H18v13.5H7.75A1.75 1.75 0 0 0 6 19.25V5.5ZM6 19.25A1.75 1.75 0 0 0 7.75 21H18v-3.5M9 10.5l2 2 3.75-4',
  chevronDown: 'M6.5 9.5 12 15l5.5-5.5',
  up: 'M6.5 14.5 12 9l5.5 5.5',
  down: 'M6.5 9.5 12 15l5.5-5.5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  check: 'M5.5 12.5 10 17l8.5-9.5',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 22, color, strokeWidth = 1.6 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  const filled = name === 'bookmarkFill';
  const dots = name === 'more' || name === 'contents';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" pointerEvents="none">
      <Path
        d={paths[name]}
        stroke={color}
        fill={filled ? color : 'none'}
        strokeWidth={dots && name === 'more' ? 2.6 : strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
