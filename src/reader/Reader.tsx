import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Linking,
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
import { Button, IconButton, T } from '@/components/primitives';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import type { Annotation, DocHandle, PageLink, SearchHit } from '@/engine/types';
import { canDownload, downloadDoc, printDoc, shareDoc } from '@/lib/fileActions';
import { useLibrary } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';
import { repo, type DocRecord } from '@/storage';
import { detailsOf, saveDetails } from '@/archive/details';
import { invalidate, pauseIndexing } from '@/archive/indexer';
import { makeSearchable, pagesWithoutText } from '@/archive/searchable';
import type { Details } from '@/archive/pdfInfo';
import { AppearancePanel } from './AppearancePanel';
import { DetailsPanel } from './DetailsPanel';
import { flattenOutline, type FlatOutline } from './ContentsPanel';
import { FindPanel } from './FindPanel';
import { FindBar } from './FindBar';
import { anchorAt, computeLayout, contentWidth, positionAt, readingPage, scrollForAnchor, scrollYFor, type PageLayout } from './layout';
import { PageView } from './PageView';
import { ReflowView, type ReflowApi } from './ReflowView';
import { NoteDialog, type NoteRequest } from './NoteDialog';
import { SelectionBubble, type PageRects } from './SelectionBubble';
import { useEdits } from './useEdits';
import { MoreMenu, type MenuItem } from './MoreMenu';
import { isWide } from './Panel';
import type { RasterCache } from './rasterCache';
import { Scrubber } from './Scrubber';

type PanelName = 'find' | 'appearance' | 'details' | null;

/** A message to show once the document has been reopened (after its details were written into the file). */
let afterReload: string | null = null;

const TOP_BAR = 56;
const BOTTOM_BAR = 64;
const clampZoom = (z: number) => Math.min(4, Math.max(0.5, z));

export function Reader({
  doc,
  handle,
  cache,
  onReload,
  at,
}: {
  doc: DocRecord;
  handle: DocHandle;
  cache: RasterCache;
  onReload?: () => void;
  /** Open at this page, with this search (from a search across documents), instead of where it was left. */
  at?: { page: number; query?: string };
}) {
  const [start] = useState(() => (at ? { page: Math.max(0, Math.min(at.page, handle.pageCount - 1)), offset: 0 } : doc.position));
  const p = usePalette();
  // "Invert colours" (per document): the pages, their thumbnails and text view figures; the app keeps its own colours.
  const pageP = useMemo(() => (doc.invert ? { ...p, page: p.inverted } : p), [p, doc.invert]);
  const fit = usePrefs((s) => s.fit);
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const { savePosition, toggleBookmark, toggleReading, toggleInvert, markOpened, setView, updateFileInfo, setDetails } = useLibrary();
  // Page view shows the PDF as authored; text view reflows it (remembered per document).
  const view = doc.view ?? 'page';
  const textApiRef = useRef<ReflowApi | null>(null);
  // Reading-list documents get reading behaviour (immersive chrome, progress); everything else is a plain viewer.
  const readingMode = !!doc.reading;
  const edits = useEdits(doc, handle);
  const [reloaded, setReloaded] = useState(() => {
    const message = afterReload;
    afterReload = null;
    return message;
  });
  const [savingDetails, setSavingDetails] = useState(false);
  // Indexing shares the PDF engine: it waits while a document is open.
  useEffect(() => pauseIndexing(), []);
  const writeDetails = async (details: Details) => {
    setSavingDetails(true);
    try {
      // Write access first, while the tap still counts as a user gesture.
      if (!(await repo.requestAccess(doc.id, true))) throw new Error('denied');
      await saveDetails(doc.id, handle, details);
      setDetails(doc.id, { title: details.title, author: details.sender });
      invalidate(doc.id);
      afterReload = t.detailsSaved;
      // Reopened from the file, so everything (and a later save of form edits) starts from the new details.
      if (onReload) onReload();
      else setReloaded(t.detailsSaved);
    } catch (e) {
      setReloaded(e instanceof Error && /encrypted/.test(e.message) ? t.detailsEncrypted : t.detailsFailed);
    } finally {
      setSavingDetails(false);
    }
  };

  // An image-only PDF (no text on its first page) can get its text read and added.
  const [textless, setTextless] = useState(false);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || doc.format === 'epub') return;
    let alive = true;
    pagesWithoutText(handle, 1).then((pages) => alive && setTextless(pages.length > 0), () => {});
    return () => {
      alive = false;
    };
  }, [handle, doc.format]);
  const addText = async () => {
    if (reading) return;
    setReading({ done: 0, total: 0 });
    try {
      if (!(await repo.requestAccess(doc.id, true))) throw new Error('denied');
      const bytes = await makeSearchable(handle, (done, total) => setReading({ done, total }));
      if (typeof bytes === 'string') {
        setReloaded(bytes === 'has-text' ? t.searchableNothing : t.searchableNone);
        return;
      }
      await repo.writeFile(doc.id, bytes);
      invalidate(doc.id);
      afterReload = t.searchableDone;
      if (onReload) onReload();
      else setReloaded(t.searchableDone);
    } catch (e) {
      setReloaded(t.searchableFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setReading(null);
    }
  };

  const list = useRef<FlatList<number>>(null);
  const [vp, setVp] = useState<{ w: number; h: number } | null>(null);
  // The zoom, and the viewport point it was last changed about (null: the centre).
  const [zoomed, setZoomed] = useState<{ zoom: number; at: { x: number; y: number } | null }>({ zoom: 1, at: null });
  const zoom = zoomed.zoom;
  const [page, setPage] = useState(start?.page ?? 0);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<PanelName>(null);
  // Find opened to search (⌘F, the find bar) puts the keyboard in its field; opened for the contents it doesn't.
  const [findFocus, setFindFocus] = useState(false);
  const openFind = (focus: boolean) => {
    setFindFocus(focus);
    setPanel('find');
  };
  const [outline, setOutline] = useState<FlatOutline | null>(null);
  const [editingPage, setEditingPage] = useState(false);
  const [menu, setMenu] = useState(false);

  // Position bookkeeping lives in refs: scroll events must not re-render the tree.
  const posRef = useRef(start ?? { page: 0, offset: 0 });
  // Where text view opens: the saved position at mount, then wherever page view was when switching.
  const [textStart, setTextStart] = useState(() => ({ page: start?.page ?? 0, y: start?.offset ?? 0 }));
  const switchView = useCallback(
    (next: 'page' | 'text') => {
      // Open on the page the reader sees (the indicator), keeping the in-page offset when it's the same page.
      if (next === 'text') setTextStart({ page, y: posRef.current.page === page ? posRef.current.offset : 0 });
      setView(doc.id, next);
    },
    [doc.id, setView, page],
  );
  const scrollY = useRef(0);
  const scrollX = useRef(0);
  const across = useRef<ScrollView>(null);
  // The geometry and zoom the pages were last placed with: a zoom is anchored in the old geometry.
  const placed = useRef<{ layout: PageLayout; zoomed: typeof zoomed } | null>(null);
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
  const contentW = vp && layout ? contentWidth(layout, vp.w) : 0;

  useEffect(() => {
    markOpened(doc.id);
    // A linked file may have been edited elsewhere since the library last saw it.
    updateFileInfo(doc.id, { pageCount: handle.pageCount });
    handle.outline().then((o) => setOutline(flattenOutline(o)), () => setOutline([]));
  }, [doc.id, handle, markOpened, updateFileInfo]);

  // Re-anchor whenever geometry changes (first layout, zoom, fit, rotation): after a zoom, the document point
  // zoomed about stays where it was on screen; otherwise the saved position goes back to the top.
  useLayoutEffect(() => {
    if (!layout || !vp || view !== 'page') return;
    const before = placed.current;
    placed.current = { layout, zoomed };
    let to: { x: number; y: number } | null = null;
    if (before && before.zoomed !== zoomed && before.layout !== layout) {
      const at = zoomed.at ?? { x: vp.w / 2, y: vp.h / 2 };
      const anchor = anchorAt(before.layout, vp.w, { x: scrollX.current, y: scrollY.current }, at);
      to = scrollForAnchor(layout, { width: vp.w, height: vp.h }, anchor, at);
    }
    if (to) posRef.current = positionAt(layout, to.y);
    const y = to ? to.y : scrollYFor(layout, posRef.current.page, posRef.current.offset);
    const x = to ? to.x : Math.min(scrollX.current, contentWidth(layout, vp.w) - vp.w);
    cache.setFocus(posRef.current.page);
    const go = () => {
      list.current?.scrollToOffset({ offset: y, animated: false });
      across.current?.scrollTo({ x: Math.max(0, x), animated: false });
    };
    // Scroll events are ignored until then: the next zoom (a pinch is several) must start from here.
    scrollY.current = y;
    scrollX.current = Math.max(0, x);
    // Ignore scroll events emitted while content resizes; they'd corrupt the anchor.
    restored.current = false;
    go();
    // Again once the new size is laid out (across it can take a second frame).
    let raf = requestAnimationFrame(() => {
      go();
      raf = requestAnimationFrame(() => {
        go();
        restored.current = true;
      });
    });
    return () => cancelAnimationFrame(raf);
    // `zoomed` changes with `layout`; listed so a zoom's point is the one read.
  }, [layout, vp, cache, view, zoomed]);

  /** Zooms about a viewport point (the viewport's centre by default): what is under it stays under it. */
  const setZoom = useCallback(
    (next: number, at?: { x: number; y: number }) =>
      setZoomed((old) => {
        const z = clampZoom(next);
        return Math.abs(z - old.zoom) < 0.001 ? old : { zoom: z, at: at ?? null };
      }),
    [],
  );

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
      if (view === 'text') textApiRef.current?.scrollToPage(target);
      else scrollTo(layout.offsets[target] - layout.padTop, animated);
      setPage(target);
    },
    [layout, handle.pageCount, scrollTo, cache, view],
  );

  // Immersive (reading list only): hide chrome reading forward, reveal on a deliberate scroll back.
  const trackDirection = useCallback(
    (y: number) => {
      if (!readingMode) return;
      const d = lastDir.current;
      const delta = y - d.y;
      d.acc = Math.sign(delta) === Math.sign(d.acc) ? d.acc + delta : delta;
      d.y = y;
      if (d.acc > 48 && y > 120) setChrome(false);
      else if (d.acc < -64) setChrome(true);
    },
    [readingMode],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!layout || !vp || !restored.current) return;
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      scrollY.current = y;
      posRef.current = positionAt(layout, y);
      // The saved position is the top of the viewport, which never reaches a last page shorter than
      // the screen: the end counts as reached once scrolled to the bottom.
      const atEnd = y > 0 && y + layoutMeasurement.height >= contentSize.height - 8;
      savePosition(doc.id, posRef.current, atEnd);
      const rp = readingPage(layout, y, vp.h);
      cache.setFocus(rp);
      setPage((old) => (old === rp ? old : rp));
      trackDirection(y);
    },
    [layout, vp, doc.id, savePosition, cache, trackDirection],
  );

  // Text view reports the block at the top; it becomes the shared position.
  const onTextPosition = useCallback(
    (pg: number, y: number, atEnd: boolean) => {
      posRef.current = { page: pg, offset: y };
      savePosition(doc.id, posRef.current, atEnd);
      cache.setFocus(pg);
      setPage((old) => (old === pg ? old : pg));
    },
    [doc.id, savePosition, cache],
  );

  // A figure tapped in text view: show it on its page, where it can be zoomed.
  const openPageAt = useCallback(
    (pg: number, y: number) => {
      posRef.current = { page: pg, offset: Math.max(0, y - 0.05) };
      setPage(pg);
      setView(doc.id, 'page');
    },
    [doc.id, setView],
  );

  // ---------- highlights and notes ----------
  const [annots, setAnnots] = useState<Annotation[] | null>(null);
  const [annotVersion, setAnnotVersion] = useState(0);
  const [noteRequest, setNoteRequest] = useState<NoteRequest | null>(null);
  useEffect(() => {
    if (panel !== 'find') return;
    let alive = true;
    handle.annotations().then((a) => alive && setAnnots(a), () => alive && setAnnots([]));
    return () => {
      alive = false;
    };
  }, [panel, handle, annotVersion]);

  const askNote = useCallback(
    (initial: string, quote: string) =>
      new Promise<string | null>((resolve) =>
        setNoteRequest({
          initial,
          quote,
          resolve: (text) => {
            setNoteRequest(null);
            resolve(text);
          },
        }),
      ),
    [],
  );
  const annotated = useCallback(
    (pages: number[]) => {
      pages.forEach((pg) => cache.invalidate(pg));
      edits.markDirty();
      setAnnotVersion((v) => v + 1);
    },
    [cache, edits],
  );
  const onHighlight = useCallback(
    async (groups: PageRects[], color: string, note: boolean, quote: string) => {
      const contents = note ? await askNote('', quote) : undefined;
      if (note && contents == null) return;
      for (const g of groups) await handle.addHighlight(g.page, g.rects, color, contents || undefined);
      annotated(groups.map((g) => g.page));
    },
    [askNote, handle, annotated],
  );
  const onEditNote = useCallback(
    async (a: Annotation) => {
      const contents = await askNote(a.contents, a.quote);
      if (contents == null || contents === a.contents) return;
      await handle.updateAnnotation(a.page, a.index, { contents });
      annotated([a.page]);
    },
    [askNote, handle, annotated],
  );
  const onDeleteNote = useCallback(
    async (a: Annotation) => {
      await handle.removeAnnotation(a.page, a.index);
      annotated([a.page]);
    },
    [handle, annotated],
  );

  // ---------- search ----------
  const [query, setQuery] = useState(at?.query ?? '');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  // Per-page hits, updated incrementally: only pages in a new batch get new arrays, so other PageViews skip re-rendering.
  const [hitsByPage, setHitsByPage] = useState(() => new Map<number, SearchHit[]>());

  const onQuery = useCallback((q: string) => {
    setQuery(q);
    setHits([]);
    setHitsByPage(new Map());
    setActive(-1);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const ctrl = new AbortController();
    // Results stream in per 8 pages; coalesce them into one state update per frame.
    let pending: SearchHit[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      const batch = pending;
      pending = [];
      if (ctrl.signal.aborted || !batch.length) return;
      setHits((h) => [...h, ...batch]);
      setHitsByPage((prev) => {
        const m = new Map(prev);
        for (const h of batch) m.set(h.page, [...(m.get(h.page) ?? []), h]);
        return m;
      });
    };
    const t = setTimeout(() => {
      setSearching(true);
      handle
        .search(
          q,
          (batch) => {
            pending.push(...batch);
            raf ||= requestAnimationFrame(flush);
          },
          ctrl.signal,
        )
        .catch(() => {})
        .finally(() => !ctrl.signal.aborted && setSearching(false));
    }, 200);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
      ctrl.abort();
      setSearching(false);
    };
  }, [query, handle]);

  // Highlights persist while a query is active, panel open or not — like find-in-page elsewhere.
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

  const goToHit = useCallback(
    (i: number) => {
      const h = hits[i];
      if (view !== 'text') return showHit(i);
      if (!h) return;
      // Text view highlights matches itself: scroll to the block holding this one.
      setActive(i);
      textApiRef.current?.showHit(h.page, h.rects[0]?.y ?? 0);
    },
    [view, hits, showHit],
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

  // ---------- keyboard + wheel (web) ----------
  useEffect(() => {
    if (Platform.OS !== 'web' || !vp) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if (mod && e.key === 'p') return e.preventDefault(), void printDoc(doc, edits.current).catch(() => {});
      // ⌘S saves edits when there are any; otherwise it downloads, as before.
      if (mod && e.key === 's') return e.preventDefault(), void (edits.dirty ? edits.save() : downloadDoc(doc).catch(() => {}));
      if (mod && e.key === 'f') {
        e.preventDefault();
        setChrome(true);
        return openFind(true);
      }
      if (mod && (e.key === '=' || e.key === '+')) return e.preventDefault(), setZoom(zoom * 1.2);
      if (mod && e.key === '-') return e.preventDefault(), setZoom(zoom / 1.2);
      if (mod && e.key === '0') return e.preventDefault(), setZoom(1);
      if ((mod && e.key === 'g') || e.key === 'F3') return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') return menu ? setMenu(false) : panel ? setPanel(null) : searchActive ? onQuery('') : edits.leave();
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
        // End means the end of the document, not the top of its last page.
        End: () => (view === 'text' ? goToPage(handle.pageCount - 1) : scrollTo(Number.MAX_SAFE_INTEGER, false)),
        b: () => toggleBookmark(doc.id, page),
        v: () => switchView(view === 'page' ? 'text' : 'page'),
        t: () => (panel === 'find' ? setPanel(null) : openFind(false)),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    let pending = 1;
    let raf = 0;
    let cursor = { x: 0, y: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // trackpad pinch arrives as ctrl+wheel
      pending *= Math.exp(-e.deltaY * 0.01);
      cursor = { x: e.clientX, y: e.clientY };
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setZoom(zoom * pending, cursor);
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
  }, [vp, zoom, panel, page, doc, handle.pageCount, goToPage, scrollTo, setZoom, toggleBookmark, stepHit, searchActive, onQuery, switchView, view, edits, menu]);

  // ---------- pinch (native) ----------
  // The pages scale about where the fingers started; on release the zoom keeps that point there.
  const pinchScale = useSharedValue(1);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onStart((e) => {
          focalX.set(e.focalX);
          focalY.set(e.focalY);
        })
        .onUpdate((e) => {
          pinchScale.set(Math.min(4 / zoom, Math.max(0.5 / zoom, e.scale)));
        })
        .onEnd(() => {
          const scale = pinchScale.get();
          pinchScale.set(1);
          setZoom(zoom * scale, { x: focalX.get(), y: focalY.get() });
        }),
    [zoom, pinchScale, focalX, focalY, setZoom],
  );
  const pinchStyle = useAnimatedStyle(() => {
    if (!vp) return {};
    // Scaling about the focal point: move it to the centre, scale, move it back.
    const dx = focalX.value - vp.w / 2;
    const dy = focalY.value - vp.h / 2;
    return { transform: [{ translateX: dx }, { translateY: dy }, { scale: pinchScale.value }, { translateX: -dx }, { translateY: -dy }] };
  });

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
    // Finishing a text selection is a click too; don't treat it as a tap on the page.
    if (Platform.OS === 'web' && window.getSelection()?.toString()) return;
    if (panel && !wide) return setPanel(null);
    if (readingMode) setChrome((c) => !c);
  }, [panel, wide, readingMode]);

  const mac = Platform.OS === 'web' && /Mac|iPhone|iPad/.test(navigator.platform);
  const key = (k: string) => (Platform.OS === 'web' ? `${mac ? '⌘' : 'Ctrl+'}${k}` : undefined);
  const readingItem: MenuItem = {
    key: 'reading',
    icon: readingMode ? 'readingOn' : 'readingAdd',
    label: readingMode ? t.removeFromReadingList : t.addToReadingList,
    onPress: () => toggleReading(doc.id),
  };
  // Document actions; how it looks lives in Aa, how to find things in the bar.
  const menuItems: MenuItem[] = [
    { key: 'details', icon: 'tag', label: t.details, onPress: () => setPanel('details') },
    ...(textless && !edits.dirty ? [{ key: 'searchable', icon: 'search' as const, label: t.makeSearchable, onPress: () => void addText() }] : []),
    readingItem,
    { key: 'share', icon: 'share', label: t.share, onPress: () => void shareDoc(doc, edits.current).catch(() => {}) },
    ...(canDownload ? [{ key: 'download', icon: 'install' as const, label: t.download, hint: key('S'), onPress: () => void downloadDoc(doc, edits.current).catch(() => {}) }] : []),
    { key: 'print', icon: 'print', label: t.print, hint: key('P'), onPress: () => void printDoc(doc, edits.current).catch(() => {}) },
  ];

  const onLink = useCallback(
    (l: PageLink) => {
      if (l.kind === 'page') goToPage(l.page);
      else Linking.openURL(l.url).catch(() => {});
    },
    [goToPage],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setVp((v) => (v && Math.abs(v.w - width) < 1 && Math.abs(v.h - height) < 1 ? v : { w: width, h: height }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }} onLayout={onLayout} testID="reader">
      {vp && view === 'text' && (
        <ReflowView
          handle={handle}
          palette={pageP}
          width={vp.w}
          padTop={insets.top + TOP_BAR}
          padBottom={insets.bottom + BOTTOM_BAR}
          initial={textStart}
          onPosition={onTextPosition}
          onScrollY={trackDirection}
          onExit={() => switchView('page')}
          onTap={onPagePress}
          onOpenPage={openPageAt}
          apiRef={textApiRef}
          docId={doc.id}
          query={searchActive ? query.trim() : ''}
        />
      )}
      {layout && vp && view === 'page' && (
        <GestureDetector gesture={pinch}>
          <Animated.View style={[{ flex: 1 }, pinchStyle]}>
            <ScrollView
              ref={across}
              horizontal
              scrollEnabled={contentW > vp.w}
              onScroll={(e) => {
                // As down the pages: not while content resizes (clamped offsets would move the next zoom's anchor).
                if (restored.current) scrollX.current = e.nativeEvent.contentOffset.x;
              }}
              scrollEventThrottle={16}
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
                      palette={pageP}
                      hits={hitsByPage.get(item)}
                      activeHit={hits[active]}
                      onPress={onPagePress}
                      onLink={onLink}
                      onEdited={edits.markDirty}
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
        <IconButton icon="back" label={t.library} onPress={edits.leave} testID="back" />
        <View style={styles.titleWrap}>
          <T numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 15, letterSpacing: -0.2 }}>
            {doc.title}
          </T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {edits.dirty && (
            <Button label={t.save} icon="check" onPress={() => void edits.save()} testID="save" style={{ marginRight: space.sm }} />
          )}
          {/* One button per kind: find your way, the form you read in, how it looks, the file itself. */}
          <IconButton icon="search" label={t.findShortcut} active={panel === 'find'} onPress={() => (panel === 'find' ? setPanel(null) : openFind(false))} testID="open-find" />
          <IconButton
            icon="textView"
            label={`${t.textView} (V)`}
            active={view === 'text'}
            onPress={() => switchView(view === 'page' ? 'text' : 'page')}
            testID="view-toggle"
          />
          <IconButton icon="type" label={t.appearance} active={panel === 'appearance'} onPress={() => togglePanel('appearance')} testID="open-appearance" />
          <IconButton icon="more" label={t.more} active={menu} onPress={() => setMenu((m) => !m)} testID="open-more" />
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
                    {readingMode ? `  ·  ${t.percentRead(Math.round((page / Math.max(1, handle.pageCount - 1)) * 100))}` : ''}
                  </T>
                </T>
              </Pressable>
            )}
          </View>
          <View style={[styles.pill, styles.tools, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            {wide && (
              <>
                <IconButton icon="zoomOut" label={`${t.zoomOut} (⌘−)`} size={34} onPress={() => setZoom(zoom / 1.2)} />
                <Pressable accessibilityRole="button" onPress={() => setZoom(1)} accessibilityLabel={t.resetZoom}>
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

      {searchActive && panel !== 'find' && (
        <FindBar
          palette={p}
          query={query.trim()}
          count={hits.length}
          active={active}
          searching={searching}
          // Fixed below the top bar: moving with the chrome would shift it out from under a pointer.
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
            palette: pageP,
            outline,
            page,
            sizes: handle.pageSizes,
            cache,
            bookmarks: doc.bookmarks,
            annotations: annots,
            onEditNote,
            onDeleteNote,
            onGo: (n) => {
              goToPage(n);
              if (!wide) setPanel(null);
            },
          }}
          query={query}
          onQuery={onQuery}
          hits={hits}
          active={active}
          searching={searching}
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
      {panel === 'appearance' && (
        <AppearancePanel
          palette={p}
          view={view}
          invert={!!doc.invert}
          onInvert={() => toggleInvert(doc.id)}
          zoom={zoom}
          onZoom={setZoom}
          onClose={() => setPanel(null)}
        />
      )}
      {view === 'page' && <SelectionBubble palette={p} onHighlight={onHighlight} />}
      <NoteDialog request={noteRequest} palette={p} />
      {panel === 'details' && (
        <DetailsPanel palette={p} initial={detailsOf(handle, doc.title)} busy={savingDetails} onSave={(d) => void writeDetails(d)} onClose={() => setPanel(null)} />
      )}
      {reading && (
        <View pointerEvents="none" testID="searchable-progress" style={[styles.reading, { top: insets.top + TOP_BAR + space.md, backgroundColor: p.glass, borderColor: p.hairline }]}>
          <T v="caption" color={p.ink}>
            {reading.total ? t.searchableProgress(reading.done, reading.total) : t.makeSearchable}
          </T>
        </View>
      )}
      <Toast message={edits.notice ?? reloaded} onDismiss={() => (edits.clearNotice(), setReloaded(null))} />
    </View>
  );
}

const styles = StyleSheet.create({
  reading: { position: 'absolute', alignSelf: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
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
