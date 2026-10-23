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
  note: 'M5 4.5h14v9.5l-5.5 5.5H5v-15ZM13.5 19.5V14H19M8.5 9h7',
  bookmarkFill: 'M7 4.5h10v15l-5-3.6-5 3.6v-15Z',
  zoomIn: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM15.6 15.6 20 20M10.75 8v5.5M8 10.75h5.5',
  zoomOut: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM15.6 15.6 20 20M8 10.75h5.5',
  trash: 'M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7',
  pages: 'M5 4.5h5.5v6.5H5zM13.5 4.5H19v6.5h-5.5zM5 13.5h5.5V20H5zM13.5 13.5H19V20h-5.5z',
  viewList: 'M4 5h4.5v5.5H4zM11.5 6.5H20M11.5 9h5M4 13.5h4.5V19H4zM11.5 15H20M11.5 17.5h5',
  viewGrid: 'M4.5 4.5h4v4h-4zM10 4.5h4v4h-4zM15.5 4.5h4v4h-4zM4.5 10h4v4h-4zM10 10h4v4h-4zM15.5 10h4v4h-4zM4.5 15.5h4v4h-4zM10 15.5h4v4h-4zM15.5 15.5h4v4h-4z',
  install: 'M12 4.5v10M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13',
  textView: 'M5 6.5h14M5 10.5h14M5 14.5h14M5 18.5h8.5',
  pageView: 'M6.5 3.5h7.75L18 7.25V20.5H6.5zM14 3.5v4h4',
  share: 'M12 3.5v11M8 7.5l4-4 4 4M7 11H5.5v9h13v-9H17',
  print: 'M7 9V4h10v5M7 17H5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5 9h14a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 19 17h-2M7 14h10v6H7z',
  lock: 'M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M5.5 10.5h13v9.5h-13zM12 14.25v2.5',
  readingAdd: 'M6 5.5a1.5 1.5 0 0 1 1.5-1.5H18v13.5H7.75A1.75 1.75 0 0 0 6 19.25V5.5ZM6 19.25A1.75 1.75 0 0 0 7.75 21H18v-3.5M12 7.25v6M9 10.25h6',
  readingOn: 'M6 5.5a1.5 1.5 0 0 1 1.5-1.5H18v13.5H7.75A1.75 1.75 0 0 0 6 19.25V5.5ZM6 19.25A1.75 1.75 0 0 0 7.75 21H18v-3.5M9 10.5l2 2 3.75-4',
  chevronDown: 'M6.5 9.5 12 15l5.5-5.5',
  up: 'M6.5 14.5 12 9l5.5 5.5',
  down: 'M6.5 9.5 12 15l5.5-5.5',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  sparkles: 'M10 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5ZM17.5 14c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z',
  undo: 'M9 14.5 4.5 10 9 5.5M4.5 10h10a5 5 0 0 1 0 10H11',
  redo: 'M15 14.5 19.5 10 15 5.5M19.5 10h-10a5 5 0 0 0 0 10H13',
  check: 'M5.5 12.5 10 17l8.5-9.5',
  pencil: 'M4.5 19.5h4l10-10-4-4-10 10v4ZM13 7l4 4',
  tag: 'M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1l7.9 7.9a1.5 1.5 0 0 1 0 2.1l-6 6a1.5 1.5 0 0 1-2.1 0ZM8.25 8.25h.01',
  folder: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.25l2 2.25H19a1.5 1.5 0 0 1 1.5 1.5v8.25A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z',
  folderAdd: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.25l2 2.25H19a1.5 1.5 0 0 1 1.5 1.5v8.25A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5ZM12 10.5v5M9.5 13h5',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  sort: 'M7.5 5v14M4.5 16l3 3 3-3M13.5 7h6M13.5 12h4.5M13.5 17h3',
  sortUp: 'M7.5 19V5M4.5 8l3-3 3 3M13.5 7h3M13.5 12h4.5M13.5 17h6',
  device: 'M8 3.5h8A1.5 1.5 0 0 1 17.5 5v14a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5ZM11 17.5h2',
  documents: 'M8.5 3.5h6L18 7v11H8.5zM14.5 3.5V7H18M5.5 7v13.5H15',
  chevronRight: 'M9.5 6.5 15 12l-5.5 5.5',
  copy: 'M9 9h10.5v10.5H9zM15 9V4.5H4.5V15H9',
  move: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.25l2 2.25H19a1.5 1.5 0 0 1 1.5 1.5v8.25A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5ZM9.5 13.5h6M13 11l2.5 2.5L13 16',
  select: 'M5 5h14v14H5zM8.5 12l2.5 2.5 4.5-5',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.25L9.5 4.75h5L16.25 7h2.25A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5ZM12 16a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z',
  scan: 'M4.5 8.5V6A1.5 1.5 0 0 1 6 4.5h2.5M15.5 4.5H18A1.5 1.5 0 0 1 19.5 6v2.5M19.5 15.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.5M8.5 19.5H6A1.5 1.5 0 0 1 4.5 18v-2.5M4.5 12h15',
  flash: 'M13 3.5 6 13.5h5.5l-1 7 7.5-10.5h-5.5Z',
  flashOff: 'M13 3.5 6 13.5h5.5l-1 7 7.5-10.5h-5.5ZM4.5 4.5l15 15',
  image: 'M4.5 5.5h15v13h-15zM4.5 15.5 9 11l4 4 2.5-2.5 4 4M15 9h.01',
  rotate: 'M19 12a7 7 0 1 1-2.05-4.95M19.5 4.5v4h-4',
  crop: 'M7 3.5V17h13.5M3.5 7H17v13.5',
  inbox: 'M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20M4 13.5 6.5 5.5h11l2.5 8v5H4z',
  invert: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 3.5v17M12 7.5h3.5M12 12h5M12 16.5h3.5',
  person: 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM5 20a7 7 0 0 1 14 0',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
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
