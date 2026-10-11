const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Human file size with a locale decimal separator. */
export const size = (bytes: number, dot: string) =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1).replace('.', dot)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

export type AgoWords = { now: string; min: (n: number) => string; h: (n: number) => string; d: (n: number) => string; locale: string };
const AGO_EN: AgoWords = { now: 'just now', min: (n) => `${n} min ago`, h: (n) => `${n} h ago`, d: (n) => (n === 1 ? 'yesterday' : `${n} days ago`), locale: 'en' };

/** Coarse relative time; older than a week shows the date. */
export function ago(ts: number, w: AgoWords): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return w.now;
  if (s < 3600) return w.min(Math.floor(s / 60));
  if (s < 86400) return w.h(Math.floor(s / 3600));
  if (s < 7 * 86400) return w.d(Math.floor(s / 86400));
  return new Date(ts).toLocaleDateString(w.locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const en = {
  // Library
  add: 'Open',
  addPdf: 'Open PDF',
  tagline: 'PDF Viewer',
  install: 'Install',
  installHintIos: 'To install: tap Share, then “Add to Home Screen”.',
  continueReading: 'Continue reading',
  continueReadingA11y: (title: string, page: number) => `Continue reading ${title}, page ${page}`,
  pageOf: (page: number, total: number) => `Page ${page} of ${total}`,
  recentCount: (n: number) => `Recent · ${n}`,
  readingList: 'Reading list',
  readingListCount: (n: number) => `Reading list · ${n}`,
  finishedCount: (n: number) => `Finished · ${n}`,
  addToReadingList: 'Add to reading list',
  removeFromReadingList: 'Remove from reading list',
  percentRead: (n: number) => `${n}%`,
  docMeta: (pages: number, bytes: number, openedAt?: number) =>
    [plural(pages, 'page', 'pages'), bytes ? size(bytes, '.') : '', openedAt ? ago(openedAt, AGO_EN) : ''].filter(Boolean).join(' · '),
  found: (n: number) => `${n} found`,
  filter: 'Filter',
  adding: 'Adding…',
  pages: (n: number) => plural(n, 'page', 'pages'),
  remove: 'Remove',
  removeTitle: 'Remove document',
  removeConfirm: (title: string) => `Remove “${title}” from Tessel? The original file stays where it is.`,
  cancel: 'Cancel',
  colophon: 'Tessel is free software · No ads · Source (AGPL-3.0)',
  importFailed: (name: string) => `Couldn’t add “${name}”.`,
  untitled: 'Untitled',
  // Empty state + drop
  emptyTitle: 'Every document,\nin its place.',
  emptyBody: 'Open a PDF to start. Files stay on this device — no ads, no account.',
  emptyBodyWeb: 'Open a PDF to start, or drop one anywhere. Files stay on this device — no ads, no account.',
  openSample: 'Open sample',
  dropTitle: 'Drop to add',
  dropBody: 'Files stay on this device',
  // Opening
  opening: (title: string) => `Opening ${title}…`,
  cantOpen: 'Can’t open this document',
  missing: 'This document is no longer in your library.',
  fileMissing: 'This document’s file is missing from storage.',
  passwordProtected: 'This PDF is password protected.',
  openFailed: 'This file couldn’t be read as a PDF.',
  backToLibrary: 'Back to library',
  // Reader chrome
  library: 'Library',
  searchShortcut: 'Search (⌘F)',
  contentsShortcut: 'Contents (T)',
  appearance: 'Appearance',
  goToPage: 'Go to page',
  page: 'Page',
  pageN: (n: number) => `Page ${n}`,
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetZoom: 'Reset zoom',
  bookmarkPage: 'Bookmark page (B)',
  removeBookmark: 'Remove bookmark (B)',
  close: 'Close',
  // Navigate panel
  navigate: 'Navigate',
  contents: 'Contents',
  pagesTab: 'Pages',
  bookmarks: 'Bookmarks',
  noOutline: 'This document has no table of contents.',
  noBookmarks: 'No bookmarks yet. Tap the ribbon while reading to keep a page.',
  // Search
  search: 'Search',
  findPlaceholder: 'Find in document',
  searchIntro: 'Search the full text of this document.',
  searching: 'Searching…',
  noMatches: 'No matches',
  results: (n: number, more: boolean) => `${n}${more ? '+' : ''} ${n === 1 ? 'result' : 'results'}`,
  nOfResults: (i: number, n: number, more: boolean) => `${i} of ${n}${more ? '+' : ''} ${n === 1 ? 'result' : 'results'}`,
  nOf: (i: number | string, n: number, more: boolean) => `${i} of ${n}${more ? '+' : ''}`,
  previousResult: 'Previous result',
  nextResult: 'Next result',
  editSearch: 'Edit search',
  clearSearch: 'Clear search',
  // Appearance
  themeAuto: 'Auto',
  themeAutoA11y: 'Automatic',
  themes: { paper: 'Light', sepia: 'Sepia', dusk: 'Dark', night: 'Black' },
  layout: 'Layout',
  fitWidth: 'Fit width',
  fitPage: 'Fit page',
  zoom: 'Zoom',
};

export type Strings = typeof en;
