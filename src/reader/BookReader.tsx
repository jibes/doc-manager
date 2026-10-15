import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, TextInput, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { linkTarget, type Book } from '@/book';
import { IconButton, T } from '@/components/primitives';
import { fonts, radius, space } from '@/design/tokens';
import type { SearchHit } from '@/engine/types';
import { t } from '@/i18n';
import { canDownload, downloadDoc, shareDoc } from '@/lib/fileActions';
import { onBack } from '@/lib/backGuard';
import { shortcut, withShortcut } from '@/lib/keys';
import { goBack } from '@/lib/nav';
import { useAsk } from '@/state/ask';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import type { DocRecord } from '@/storage';
import { AppearancePanel } from './AppearancePanel';
import { BlockList, type BlockListApi, type FigureSource } from './BlockList';
import { FindPanel } from './FindPanel';
import { FindBar } from './FindBar';
import { MoreMenu, type MenuItem } from './MoreMenu';
import { useMoving } from './useMoving';
import { isWide } from './Panel';
import { Scrubber } from './Scrubber';

type PanelName = 'find' | 'appearance' | null;

const TOP_BAR = 56;
const BOTTOM_BAR = 64;
const MAX_HITS = 1000;

/** Every occurrence of the query in the book's text, as search hits (page + block position). */
function searchBook(book: Book, query: string): SearchHit[] {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const b of book.blocks) {
    const text = b.text.toLowerCase();
    for (let i = text.indexOf(q); i >= 0 && hits.length < MAX_HITS; i = text.indexOf(q, i + q.length)) {
      const from = Math.max(0, i - 40);
      const snippet = (from > 0 ? '…' : '') + b.text.slice(from, i + q.length + 60).replace(/\s+/g, ' ');
      hits.push({ page: b.page, rects: [{ x: 0, y: b.y, w: 0, h: 0 }], snippet, matchStart: i - from + (from > 0 ? 1 : 0), matchLength: q.length });
    }
  }
  if (hits.length >= MAX_HITS) hits[hits.length - 1].more = true;
  return hits;
}

/**
 * A book (EPUB): the reflowed text is the only view. Pages are virtual (about a printed page),
 * so progress, bookmarks, contents and the scrubber work as they do for PDFs.
 */
export function BookReader({ doc, book, image }: { doc: DocRecord; book: Book; image: (path: string) => string | undefined }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  // The actions only (stable): the reader doesn't re-render when other documents (or its own position) change.
  const { savePosition, flushPositions, toggleBookmark, toggleReading, markOpened, updateFileInfo } = useLibrary.getState();
  useEffect(() => () => flushPositions(true), [flushPositions]);
  const readingMode = !!doc.reading;
  const apiRef = useRef<BlockListApi | null>(null);

  const [vp, setVp] = useState<{ w: number; h: number } | null>(null);
  const [page, setPage] = useState(doc.position?.page ?? 0);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<PanelName>(null);
  // Find opened to search (⌘F, the find bar) puts the keyboard in its field; opened for the contents it doesn't.
  const [findFocus, setFindFocus] = useState(false);
  const openFind = (focus: boolean) => {
    setFindFocus(focus);
    setPanel('find');
  };
  const [menu, setMenu] = useState(false);
  const [editingPage, setEditingPage] = useState(false);
  const [initial] = useState(() => ({ page: doc.position?.page ?? 0, y: doc.position?.offset ?? 0 }));
  const lastDir = useRef({ y: 0, acc: 0 });
  const { moving, moved } = useMoving(!isWide(winW));

  useEffect(() => {
    markOpened(doc.id);
    updateFileInfo(doc.id, { pageCount: book.pageCount });
  }, [doc.id, book.pageCount, markOpened, updateFileInfo]);

  // A book finishes when read to the end (BlockList's atEnd), not when a jump lands there.
  const onPosition = useCallback(
    (pg: number, y: number, atEnd: boolean) => {
      savePosition(doc.id, { page: pg, offset: y }, atEnd);
      setPage((old) => (old === pg ? old : pg));
    },
    [doc.id, savePosition],
  );

  // Immersive (reading list): hide chrome reading forward, reveal on a deliberate scroll back.
  const onScrollY = useCallback(
    (y: number) => {
      moved();
      if (!readingMode) return;
      const d = lastDir.current;
      const delta = y - d.y;
      d.acc = Math.sign(delta) === Math.sign(d.acc) ? d.acc + delta : delta;
      d.y = y;
      if (d.acc > 48 && y > 120) setChrome(false);
      else if (d.acc < -64) setChrome(true);
    },
    [readingMode, moved],
  );

  const goToPage = useCallback(
    (n: number) => {
      const target = Math.min(Math.max(0, n), book.pageCount - 1);
      apiRef.current?.scrollToPage(target);
      setPage(target);
    },
    [book.pageCount],
  );

  const onLink = useCallback(
    (href: string) => {
      const i = linkTarget(book, href);
      if (i != null) apiRef.current?.scrollToBlock(i);
      else if (/^(https?:|mailto:)/i.test(href)) Linking.openURL(href).catch(() => {});
    },
    [book],
  );

  // Images at their natural size up to the column; the rest of the column stays calm white space.
  const figures = useMemo<FigureSource>(
    () => ({
      box: (b, column) => {
        const w = Math.min(column, b.imgW ?? column);
        return { width: Math.round(w), height: Math.round(w * (b.imgW && b.imgH ? b.imgH / b.imgW : 0.66)), scroll: false };
      },
      render: (b, box) => (
        <Image
          source={{ uri: image(b.src!) }}
          style={{ width: box.width, height: box.height, borderRadius: 2, opacity: p.dark ? 0.9 : 1 }}
          contentFit="contain"
          accessibilityLabel={b.text || t.figure}
          accessible
          testID="figure"
        />
      ),
    }),
    [image, p.dark],
  );

  // ---------- search ----------
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const q = query.trim();
  const searchActive = q.length >= 2;
  const hits = useMemo(() => (searchActive ? searchBook(book, q) : []), [book, q, searchActive]);
  const onQuery = useCallback((s: string) => {
    setQuery(s);
    setActive(-1);
  }, []);
  const goToHit = useCallback(
    (i: number) => {
      const h = hits[i];
      if (!h) return;
      setActive(i);
      apiRef.current?.showHit(h.page, h.rects[0].y);
    },
    [hits],
  );
  const stepHit = useCallback(
    (dir: 1 | -1) => {
      if (!hits.length) return;
      if (active < 0) {
        const first = hits.findIndex((h) => h.page >= page);
        return goToHit(dir === 1 ? Math.max(0, first) : (first <= 0 ? hits.length : first) - 1);
      }
      goToHit((active + dir + hits.length) % hits.length);
    },
    [hits, active, page, goToHit],
  );

  // ---------- keyboard (web) ----------
  useEffect(() => {
    if (Platform.OS !== 'web' || !vp) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if (mod && e.key === 's' && canDownload) return e.preventDefault(), void downloadDoc(doc).catch(() => {});
      if (mod && e.key === 'f') {
        e.preventDefault();
        setChrome(true);
        return openFind(true);
      }
      if ((mod && e.key === 'g') || e.key === 'F3') return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') {
        // A question being asked answers Esc itself; a selection goes before the book does.
        if (useAsk.getState().request) return;
        if (menu) return setMenu(false);
        if (panel) return setPanel(null);
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return sel.removeAllRanges();
        return searchActive ? onQuery('') : goBack();
      }
      if (typing || mod) return;
      const step = vp.h * 0.15;
      const pageStep = vp.h - TOP_BAR - BOTTOM_BAR;
      const keys: Record<string, () => void> = {
        ArrowDown: () => apiRef.current?.scrollBy(step),
        ArrowUp: () => apiRef.current?.scrollBy(-step),
        j: () => apiRef.current?.scrollBy(step),
        k: () => apiRef.current?.scrollBy(-step),
        ' ': () => apiRef.current?.scrollBy(e.shiftKey ? -pageStep : pageStep, true),
        PageDown: () => apiRef.current?.scrollBy(pageStep, true),
        PageUp: () => apiRef.current?.scrollBy(-pageStep, true),
        ArrowRight: () => goToPage(page + 1),
        ArrowLeft: () => goToPage(page - 1),
        Home: () => goToPage(0),
        End: () => goToPage(book.pageCount),
        b: () => toggleBookmark(doc.id, page),
        t: () => (panel === 'find' ? setPanel(null) : openFind(false)),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vp, menu, panel, searchActive, onQuery, stepHit, goToPage, page, book.pageCount, toggleBookmark, doc]);

  // Android's back button closes what is open first.
  useEffect(
    () =>
      onBack(() => {
        if (menu) return setMenu(false), true;
        if (panel) return setPanel(null), true;
        return false;
      }),
    [menu, panel],
  );

  // ---------- chrome ----------
  const chromeShown = chrome || panel != null || menu || !readingMode;
  const chromeV = useSharedValue(1);
  useEffect(() => {
    chromeV.set(withTiming(chromeShown ? 1 : 0, { duration: 240 }));
  }, [chromeShown, chromeV]);
  const topStyle = useAnimatedStyle(() => ({ opacity: chromeV.value, transform: [{ translateY: (1 - chromeV.value) * -12 }] }));
  const pillsShown = chromeShown && !moving;
  const pillsV = useSharedValue(1);
  useEffect(() => {
    pillsV.set(withTiming(pillsShown ? 1 : 0, { duration: pillsShown ? 240 : 160 }));
  }, [pillsShown, pillsV]);
  const bottomStyle = useAnimatedStyle(() => ({ opacity: pillsV.value, transform: [{ translateY: (1 - pillsV.value) * 10 }] }));

  const wide = isWide(winW);
  const togglePanel = (name: Exclude<PanelName, null>) => setPanel((x) => (x === name ? null : name));
  const bookmarked = doc.bookmarks.includes(page);
  const outline = useMemo(() => book.toc.map((e) => ({ title: e.title, page: e.page, depth: e.depth })), [book.toc]);
  const chapters = useMemo(() => outline.filter((o) => o.depth === 0), [outline]);
  // 0% on the first page, 100% on the last (a one-page book is read once it is open).
  const pct = book.pageCount <= 1 ? 100 : Math.round((page / (book.pageCount - 1)) * 100);

  const menuItems: MenuItem[] = [
    { key: 'reading', icon: readingMode ? 'readingOn' : 'readingAdd', label: readingMode ? t.removeFromReadingList : t.addToReadingList, onPress: () => toggleReading(doc.id) },
    { key: 'share', icon: 'share', label: t.share, onPress: () => void shareDoc(doc).catch(() => {}) },
    ...(canDownload ? [{ key: 'download', icon: 'install' as const, label: t.download, hint: shortcut('S'), onPress: () => void downloadDoc(doc).catch(() => {}) }] : []),
  ];

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setVp((v) => (v && Math.abs(v.w - width) < 1 && Math.abs(v.h - height) < 1 ? v : { w: width, h: height }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }} onLayout={onLayout} testID="reader">
      {vp && (
        <BlockList
          blocks={book.blocks}
          palette={p}
          width={vp.w}
          padTop={insets.top + TOP_BAR}
          padBottom={insets.bottom + BOTTOM_BAR}
          initial={initial}
          query={searchActive ? q : ''}
          onPosition={onPosition}
          onScrollY={onScrollY}
          apiRef={apiRef}
          figures={figures}
          onLink={onLink}
          onTap={() => (panel && !wide ? setPanel(null) : readingMode && setChrome((c) => !c))}
        />
      )}

      {/* Top bar */}
      <Animated.View
        pointerEvents={chromeShown ? 'box-none' : 'none'}
        style={[styles.top, { paddingTop: insets.top, height: insets.top + TOP_BAR, backgroundColor: p.glass, borderColor: p.hairline }, topStyle]}
      >
        <IconButton icon="back" label={t.back} onPress={goBack} testID="back" />
        <View style={styles.titleWrap}>
          <T numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 15, letterSpacing: -0.2 }}>
            {doc.title}
          </T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <IconButton icon="search" label={withShortcut(t.findShortcut, 'F')} active={panel === 'find'} onPress={() => (panel === 'find' ? setPanel(null) : openFind(false))} testID="open-find" />
          <IconButton icon="type" label={t.appearance} active={panel === 'appearance'} onPress={() => togglePanel('appearance')} testID="open-appearance" />
          <IconButton icon="more" label={t.more} active={menu} onPress={() => setMenu((m) => !m)} testID="open-more" />
        </View>
      </Animated.View>

      {/* Bottom bar + spine */}
      <View pointerEvents="box-none" style={[styles.bottomWrap, { paddingBottom: insets.bottom }]}>
        <Animated.View pointerEvents={pillsShown ? 'box-none' : 'none'} style={[styles.bottomRow, bottomStyle]}>
          <View style={[styles.pill, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            {editingPage ? (
              <TextInput
                autoFocus
                testID="page-input"
                accessibilityLabel={t.goToPage}
                keyboardType="number-pad"
                defaultValue={String(page + 1)}
                selectTextOnFocus
                onBlur={() => setEditingPage(false)}
                onSubmitEditing={(e) => {
                  const n = parseInt(e.nativeEvent.text, 10);
                  if (!Number.isNaN(n)) goToPage(n - 1);
                  setEditingPage(false);
                }}
                style={[styles.pageInput, { color: p.ink }]}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t.pageOf(page + 1, book.pageCount)}${readingMode ? ` · ${t.percentRead(pct)}` : ''}`}
                accessibilityHint={t.goToPage}
                onPress={() => setEditingPage(true)}
                testID="page-label"
              >
                <T v="numeral" style={{ fontSize: 13 }}>
                  {page + 1}
                  <T v="numeral" color={p.muted} style={{ fontSize: 13 }}>
                    {'  /  '}
                    {book.pageCount}
                    {readingMode ? `  ·  ${t.percentRead(pct)}` : ''}
                  </T>
                </T>
              </Pressable>
            )}
          </View>
          <View style={[styles.pill, styles.tools, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            <IconButton
              icon={bookmarked ? 'bookmarkFill' : 'bookmark'}
              label={bookmarked ? t.removeBookmark : t.bookmarkPage}
              size={34}
              active={bookmarked}
              onPress={() => toggleBookmark(doc.id, page)}
              testID="bookmark"
            />
          </View>
        </Animated.View>
        <View style={{ paddingHorizontal: wide ? space.xxl : space.lg }}>
          <Scrubber page={page} pageCount={book.pageCount} palette={p} chapters={chapters} bookmarks={doc.bookmarks} expanded={chromeShown} onSeek={goToPage} />
        </View>
      </View>

      {searchActive && panel !== 'find' && (
        <FindBar
          palette={p}
          query={q}
          count={hits.length}
          more={hits.some((h) => h.more)}
          active={active}
          searching={false}
          top={insets.top + TOP_BAR + space.sm}
          onOpen={() => openFind(true)}
          onStep={stepHit}
          onClear={() => onQuery('')}
        />
      )}
      {panel === 'find' && (
        <FindPanel
          palette={p}
          contents={{
            palette: p,
            outline,
            page,
            bookmarks: doc.bookmarks,
            tabs: ['contents', 'bookmarks'],
            annotations: null,
            onGo: (n) => {
              goToPage(n);
              if (!wide) setPanel(null);
            },
          }}
          query={query}
          onQuery={onQuery}
          hits={hits}
          active={active}
          searching={false}
          focus={findFocus}
          onPick={(i) => {
            goToHit(i);
            if (!wide) setPanel(null);
          }}
          onStep={stepHit}
          onClose={() => setPanel(null)}
        />
      )}
      {menu && <MoreMenu palette={p} top={insets.top + TOP_BAR - 4} items={menuItems} onClose={() => setMenu(false)} />}
      {panel === 'appearance' && <AppearancePanel palette={p} view="text" zoom={1} onZoom={() => {}} onClose={() => setPanel(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backdropFilter: 'blur(18px) saturate(1.4)',
  } as object,
  titleWrap: { flex: 1, alignItems: 'center', paddingHorizontal: space.md },
  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.lg, marginBottom: 2 },
  pill: {
    height: 38,
    minWidth: 38,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    backdropFilter: 'blur(18px) saturate(1.4)',
  } as object,
  tools: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2 },
  pageInput: { width: 64, height: 32, fontFamily: fonts.sansMedium, fontSize: 13, textAlign: 'center', outlineStyle: 'none' } as object,
});
