import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '@/i18n';
import { IconButton, T } from '@/components/primitives';
import { fonts, radius, space } from '@/design/tokens';
import type { DocHandle, SearchHit } from '@/engine/types';
import { goBack } from '@/lib/nav';
import { useLibrary } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';
import type { DocRecord } from '@/storage';
import { AppearancePanel } from './AppearancePanel';
import { ContentsPanel, flattenOutline, type FlatOutline } from './ContentsPanel';
import { FindBar } from './FindBar';
import { computeLayout, positionAt, readingPage, scrollYFor } from './layout';
import { PageView } from './PageView';
import { isWide } from './Panel';
import type { RasterCache } from './rasterCache';
import { Scrubber } from './Scrubber';
import { SearchPanel } from './SearchPanel';

type PanelName = 'contents' | 'search' | 'appearance' | null;

const TOP_BAR = 56;
const BOTTOM_BAR = 64;
const clampZoom = (z: number) => Math.min(4, Math.max(0.5, z));

export function Reader({ doc, handle, cache }: { doc: DocRecord; handle: DocHandle; cache: RasterCache }) {
  const p = usePalette();
  const fit = usePrefs((s) => s.fit);
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const { savePosition, toggleBookmark, toggleReading, markOpened } = useLibrary();
  // Reading-list documents get reading behaviour (immersive chrome, progress); everything else is a plain viewer.
  const readingMode = !!doc.reading;

  const list = useRef<FlatList<number>>(null);
  const [vp, setVp] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoomRaw] = useState(1);
  const [page, setPage] = useState(doc.position?.page ?? 0);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<PanelName>(null);
  const [outline, setOutline] = useState<FlatOutline | null>(null);
  const [editingPage, setEditingPage] = useState(false);

  // Position bookkeeping lives in refs: scroll events must not re-render the tree.
  const pos = useRef(doc.position ?? { page: 0, offset: 0 });
  const scrollY = useRef(0);
  const restored = useRef(false);
  const lastDir = useRef({ y: 0, acc: 0 });

  const layout = useMemo(
    () =>
      vp &&
      computeLayout(
        handle.pageSizes,
        { width: vp.w, height: vp.h, padTop: insets.top + TOP_BAR, padBottom: insets.bottom + BOTTOM_BAR + space.lg },
        fit,
        zoom,
      ),
    [vp, handle.pageSizes, insets.top, insets.bottom, fit, zoom],
  );
  const pages = useMemo(() => handle.pageSizes.map((_, i) => i), [handle.pageSizes]);
  const contentW = vp && layout ? Math.max(vp.w, layout.maxWidth + layout.gutter * 2) : 0;

  useEffect(() => {
    markOpened(doc.id);
    handle.outline().then((o) => setOutline(flattenOutline(o)), () => setOutline([]));
  }, [doc.id, handle, markOpened]);

  // Re-anchor to the saved position whenever geometry changes (first layout, zoom, fit, rotation).
  useLayoutEffect(() => {
    if (!layout) return;
    const y = scrollYFor(layout, pos.current.page, pos.current.offset);
    cache.setFocus(pos.current.page);
    const go = () => list.current?.scrollToOffset({ offset: y, animated: false });
    // Ignore scroll events emitted while content resizes; they'd corrupt the anchor.
    restored.current = false;
    go();
    const raf = requestAnimationFrame(() => {
      go();
      restored.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [layout, cache]);

  const setZoom = useCallback((z: number) => setZoomRaw((old) => (Math.abs(clampZoom(z) - old) < 0.001 ? old : clampZoom(z))), []);

  // Long animated jumps mount every page in between and delay the target's render; jump instantly instead.
  const scrollTo = useCallback(
    (y: number, animated = true) => {
      const near = vp ? Math.abs(y - scrollY.current) < vp.h * 1.5 : false;
      list.current?.scrollToOffset({ offset: Math.max(0, y), animated: animated && near });
    },
    [vp],
  );

  const goToPage = useCallback(
    (n: number, animated = false) => {
      if (!layout) return;
      const target = Math.min(Math.max(0, n), handle.pageCount - 1);
      cache.setFocus(target);
      scrollTo(layout.offsets[target] - layout.padTop, animated);
      setPage(target);
    },
    [layout, handle.pageCount, scrollTo, cache],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!layout || !vp || !restored.current) return;
      const y = e.nativeEvent.contentOffset.y;
      scrollY.current = y;
      pos.current = positionAt(layout, y);
      savePosition(doc.id, pos.current);
      const rp = readingPage(layout, y, vp.h);
      cache.setFocus(rp);
      setPage((old) => (old === rp ? old : rp));
      // Immersive (reading list only): hide chrome reading forward, reveal on a deliberate scroll back.
      if (!readingMode) return;
      const d = lastDir.current;
      const delta = y - d.y;
      d.acc = Math.sign(delta) === Math.sign(d.acc) ? d.acc + delta : delta;
      d.y = y;
      if (d.acc > 48 && y > 120) setChrome(false);
      else if (d.acc < -64) setChrome(true);
    },
    [layout, vp, doc.id, savePosition, cache, readingMode],
  );

  // ---------- search ----------
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);

  const onQuery = useCallback((q: string) => {
    setQuery(q);
    setHits([]);
    setActive(-1);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setSearching(true);
      handle
        .search(q, (batch) => !ctrl.signal.aborted && setHits((h) => [...h, ...batch]), ctrl.signal)
        .catch(() => {})
        .finally(() => !ctrl.signal.aborted && setSearching(false));
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      setSearching(false);
    };
  }, [query, handle]);

  // Highlights persist while a query is active, panel open or not — like find-in-page elsewhere.
  const hitsByPage = useMemo(() => {
    const m = new Map<number, SearchHit[]>();
    for (const h of hits) m.set(h.page, [...(m.get(h.page) ?? []), h]);
    return m;
  }, [hits]);
  const searchActive = query.trim().length >= 2;

  const showHit = useCallback(
    (i: number) => {
      const h = hits[i];
      if (!h || !layout || !vp) return;
      setActive(i);
      cache.setFocus(h.page);
      const r = h.rects[0];
      const y = layout.offsets[h.page] + (r ? r.y * layout.heights[h.page] : 0) - vp.h * 0.35;
      scrollTo(y, true);
    },
    [hits, layout, vp, scrollTo, cache],
  );

  const stepHit = useCallback(
    (dir: 1 | -1) => {
      if (!hits.length) return;
      if (active < 0) {
        const first = hits.findIndex((h) => h.page >= page);
        return showHit(dir === 1 ? Math.max(0, first) : (first <= 0 ? hits.length : first) - 1);
      }
      showHit((active + dir + hits.length) % hits.length);
    },
    [hits, active, page, showHit],
  );

  // ---------- keyboard + wheel (web) ----------
  useEffect(() => {
    if (Platform.OS !== 'web' || !vp) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (mod && e.key === 'f') {
        e.preventDefault();
        setChrome(true);
        return setPanel('search');
      }
      if (mod && (e.key === '=' || e.key === '+')) return e.preventDefault(), setZoom(zoom * 1.2);
      if (mod && e.key === '-') return e.preventDefault(), setZoom(zoom / 1.2);
      if (mod && e.key === '0') return e.preventDefault(), setZoom(1);
      if ((mod && e.key === 'g') || e.key === 'F3') return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') return panel ? setPanel(null) : searchActive ? onQuery('') : goBack();
      if (typing || mod) return;
      const step = vp.h * 0.15;
      const pageStep = vp.h - TOP_BAR - BOTTOM_BAR;
      const keys: Record<string, () => void> = {
        ArrowDown: () => scrollTo(scrollY.current + step, false),
        ArrowUp: () => scrollTo(scrollY.current - step, false),
        j: () => scrollTo(scrollY.current + step, false),
        k: () => scrollTo(scrollY.current - step, false),
        ' ': () => scrollTo(scrollY.current + (e.shiftKey ? -pageStep : pageStep), true),
        PageDown: () => scrollTo(scrollY.current + pageStep, true),
        PageUp: () => scrollTo(scrollY.current - pageStep, true),
        ArrowRight: () => goToPage(page + 1),
        ArrowLeft: () => goToPage(page - 1),
        Home: () => goToPage(0),
        End: () => goToPage(handle.pageCount - 1),
        b: () => toggleBookmark(doc.id, page),
        t: () => setPanel((x) => (x === 'contents' ? null : 'contents')),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    let pending = 1;
    let raf = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // trackpad pinch arrives as ctrl+wheel
      pending *= Math.exp(-e.deltaY * 0.01);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setZoomRaw((z) => clampZoom(z * pending));
          pending = 1;
        });
    };
    const onMove = (e: MouseEvent) => {
      if (e.clientY < TOP_BAR + 24 || e.clientY > window.innerHeight - BOTTOM_BAR - 24) setChrome(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [vp, zoom, panel, page, doc.id, handle.pageCount, goToPage, scrollTo, setZoom, toggleBookmark, stepHit, searchActive, onQuery]);

  // ---------- pinch (native) ----------
  const pinchScale = useSharedValue(1);
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onUpdate((e) => {
          pinchScale.set(Math.min(4 / zoom, Math.max(0.5 / zoom, e.scale)));
        })
        .onEnd((e) => {
          pinchScale.set(1);
          setZoom(zoom * e.scale);
        }),
    [zoom, pinchScale, setZoom],
  );
  const pinchStyle = useAnimatedStyle(() => ({ transform: [{ scale: pinchScale.value }] }));

  // ---------- chrome animation ----------
  const chromeShown = chrome || panel != null || !readingMode;
  const chromeV = useSharedValue(1);
  useEffect(() => {
    chromeV.set(withTiming(chromeShown ? 1 : 0, { duration: 240 }));
  }, [chromeShown, chromeV]);
  const topStyle = useAnimatedStyle(() => ({ opacity: chromeV.value, transform: [{ translateY: (1 - chromeV.value) * -12 }] }));
  const bottomStyle = useAnimatedStyle(() => ({ opacity: chromeV.value, transform: [{ translateY: (1 - chromeV.value) * 10 }] }));

  const togglePanel = (name: Exclude<PanelName, null>) => setPanel((x) => (x === name ? null : name));
  const bookmarked = doc.bookmarks.includes(page);
  const chapters = useMemo(() => (outline ?? []).filter((o) => o.depth === 0 && o.page >= 0), [outline]);
  const wide = isWide(winW);
  const onPagePress = useCallback(() => {
    if (panel && !wide) return setPanel(null);
    if (readingMode) setChrome((c) => !c);
  }, [panel, wide, readingMode]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setVp((v) => (v && Math.abs(v.w - width) < 1 && Math.abs(v.h - height) < 1 ? v : { w: width, h: height }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }} onLayout={onLayout} testID="reader">
      {layout && vp && (
        <GestureDetector gesture={pinch}>
          <Animated.View style={[{ flex: 1 }, pinchStyle]}>
            <ScrollView
              horizontal
              scrollEnabled={contentW > vp.w}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ width: contentW }}
            >
              <FlatList
                ref={list}
                testID="pages"
                style={{ width: contentW, height: vp.h }}
                data={pages}
                keyExtractor={(i) => String(i)}
                getItemLayout={(_, i) => ({ length: layout.heights[i] + layout.gap, offset: (layout.offsets[i] ?? 0) - layout.gap, index: i })}
                ListHeaderComponent={<View style={{ height: layout.padTop }} />}
                ListFooterComponent={<View style={{ height: insets.bottom + BOTTOM_BAR + space.lg }} />}
                renderItem={({ item }) => (
                  <View style={{ paddingTop: layout.gap, height: layout.heights[item] + layout.gap }}>
                    <PageView
                      page={item}
                      width={layout.widths[item]}
                      height={layout.heights[item]}
                      cache={cache}
                      palette={p}
                      hits={hitsByPage.get(item)}
                      activeHit={hits[active]}
                      onPress={onPagePress}
                    />
                  </View>
                )}
                onScroll={onScroll}
                scrollEventThrottle={16}
                initialNumToRender={3}
                maxToRenderPerBatch={3}
                windowSize={5}
                removeClippedSubviews={Platform.OS === 'android'}
                showsVerticalScrollIndicator={Platform.OS === 'web'}
                extraData={`${hitsByPage.size}:${active}:${p.name}`}
              />
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      )}

      {/* Top bar */}
      <Animated.View
        pointerEvents={chromeShown ? 'box-none' : 'none'}
        style={[styles.top, { paddingTop: insets.top, height: insets.top + TOP_BAR, backgroundColor: p.glass, borderColor: p.hairline }, topStyle]}
      >
        <IconButton icon="back" label={t.library} onPress={goBack} testID="back" />
        <View style={styles.titleWrap}>
          <T numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 15, letterSpacing: -0.2 }}>
            {doc.title}
          </T>
        </View>
        <View style={{ flexDirection: 'row' }}>
          <IconButton
            icon={readingMode ? 'readingOn' : 'readingAdd'}
            label={readingMode ? t.removeFromReadingList : t.addToReadingList}
            active={readingMode}
            onPress={() => toggleReading(doc.id)}
            testID="reading-toggle"
          />
          <IconButton icon="search" label={t.searchShortcut} active={panel === 'search'} onPress={() => togglePanel('search')} testID="open-search" />
          <IconButton icon="contents" label={t.contentsShortcut} active={panel === 'contents'} onPress={() => togglePanel('contents')} testID="open-contents" />
          <IconButton icon="type" label={t.appearance} active={panel === 'appearance'} onPress={() => togglePanel('appearance')} testID="open-appearance" />
        </View>
      </Animated.View>

      {/* Bottom bar + spine */}
      <View pointerEvents="box-none" style={[styles.bottomWrap, { paddingBottom: insets.bottom }]}>
        <Animated.View pointerEvents={chromeShown ? 'box-none' : 'none'} style={[styles.bottomRow, bottomStyle]}>
          <View style={[styles.pill, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            {editingPage ? (
              <TextInput
                autoFocus
                testID="page-input"
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
              <Pressable accessibilityRole="button" accessibilityLabel={t.goToPage} onPress={() => setEditingPage(true)} testID="page-label">
                <T v="numeral" style={{ fontSize: 13 }}>
                  {page + 1}
                  <T v="numeral" color={p.muted} style={{ fontSize: 13 }}>
                    {'  /  '}
                    {handle.pageCount}
                    {readingMode ? `  ·  ${t.percentRead(Math.round(((page + 1) / handle.pageCount) * 100))}` : ''}
                  </T>
                </T>
              </Pressable>
            )}
          </View>
          <View style={[styles.pill, styles.tools, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            {wide && (
              <>
                <IconButton icon="zoomOut" label={`${t.zoomOut} (⌘−)`} size={34} onPress={() => setZoom(zoom / 1.2)} />
                <Pressable onPress={() => setZoom(1)} accessibilityLabel={t.resetZoom}>
                  <T v="numeral" color={p.muted} style={{ minWidth: 40, textAlign: 'center' }}>
                    {Math.round(zoom * 100)}%
                  </T>
                </Pressable>
                <IconButton icon="zoomIn" label={`${t.zoomIn} (⌘+)`} size={34} onPress={() => setZoom(zoom * 1.2)} />
              </>
            )}
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
          <Scrubber
            page={page}
            pageCount={handle.pageCount}
            sizes={handle.pageSizes}
            cache={cache}
            palette={p}
            chapters={chapters}
            bookmarks={doc.bookmarks}
            expanded={chromeShown}
            onSeek={goToPage}
          />
        </View>
      </View>

      {searchActive && panel !== 'search' && (
        <FindBar
          palette={p}
          query={query.trim()}
          count={hits.length}
          active={active}
          searching={searching}
          // Fixed below the top bar: moving with the chrome would shift it out from under a pointer.
          top={insets.top + TOP_BAR + space.sm}
          onOpen={() => setPanel('search')}
          onStep={stepHit}
          onClear={() => onQuery('')}
        />
      )}

      {panel === 'contents' && (
        <ContentsPanel
          palette={p}
          outline={outline}
          page={page}
          sizes={handle.pageSizes}
          cache={cache}
          bookmarks={doc.bookmarks}
          onGo={(n) => {
            goToPage(n);
            if (!wide) setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'search' && (
        <SearchPanel
          palette={p}
          query={query}
          onQuery={onQuery}
          hits={hits}
          active={active}
          searching={searching}
          onPick={(i) => {
            showHit(i);
            if (!wide) setPanel(null);
          }}
          onStep={stepHit}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'appearance' && <AppearancePanel palette={p} zoom={zoom} onZoom={setZoom} onClose={() => setPanel(null)} />}
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
