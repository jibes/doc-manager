import { useIsFocused } from 'expo-router';
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

import { opError, t } from '@/core/i18n';
import { Button, IconButton, T } from '@/paper/components/primitives';
import { Toast } from '@/paper/components/Toast';
import { fonts, radius, space } from '@/core/design/tokens';
import type { Annotation, DocHandle, PageLink, SearchHit } from '@/core/engine/types';
import { canDownload, downloadDoc, printDoc, shareDoc } from '@/core/lib/fileActions';
import { onBack } from '@/core/lib/backGuard';
import { shortcut, withKey, withShortcut } from '@/core/lib/keys';
import { ask, useAsk } from '@/paper/state/ask';
import { libraryActions } from '@/paper/state/library';
import { usePalette, usePrefs } from '@/paper/state/prefs';
import { repo, type DocRecord } from '@/core/storage';
import { detailsOf, saveDetails } from '@/paper/archive/details';
import { editing, readAdded, readText, useIntake } from '@/paper/archive/intake';
import { allDocs, invalidate, pauseIndexing, schedule, useIndex } from '@/paper/archive/indexer';
import type { IndexedDoc } from '@/paper/archive/search';
import { useThrottled } from '@/core/lib/useThrottled';
import { inboxDir, refreshInboxCount } from '@/paper/archive/inbox';
import { docKey } from '@/paper/archive/docKey';
import { folders } from '@/core/lib/folders';
import { anyPageWithoutText, pagesWithoutText } from '@/paper/archive/searchable';
import { aiHost, aiReady } from '@/paper/scan/ai';
import type { Details } from '@/paper/archive/pdfInfo';
import { AppearancePanel } from './AppearancePanel';
import { DetailsPanel } from './DetailsPanel';
import { flattenOutline, type FlatOutline } from './ContentsPanel';
import { FindPanel } from './FindPanel';
import { FindBar } from './FindBar';
import { anchorAt, computeLayout, contentWidth, positionAt, readingPage, scrollForAnchor, scrollYFor, type PageLayout } from './layout';
import { PageView } from './PageView';
import { ReflowView, type ReflowApi } from './ReflowView';
import { NoteDialog, type NoteRequest } from './NoteDialog';
import { HIGHLIGHT_COLORS } from './selection';
import { SelectionBubble, type PageRects } from './SelectionBubble';
import { useEdits } from './useEdits';
import { discardDetails, useDrafts } from './drafts';
import { useMoving } from './useMoving';
import { MoreMenu, type MenuItem } from './MoreMenu';
import { isWide } from './Panel';
import type { RasterCache } from './rasterCache';
import { Scrubber } from './Scrubber';

/** Pages looked at for missing text (as many as the search index reads), and when the ones after the first are. */
const PAGES_LOOKED_AT = 200;
const LOOK_LATER_MS = 2000;

type PanelName = 'find' | 'appearance' | 'details' | null;

/** A message to show once the document has been reopened (after its details were written into the file). */
let afterReload: string | null = null;

const TOP_BAR = 56;
const BOTTOM_BAR = 64;
const clampZoom = (z: number) => Math.min(4, Math.max(0.5, z));
/** Text view's type size (as in Aa): ⌘+/⌘− and pinching change it there, not the page zoom it doesn't show. */
const clampText = (s: number) => Math.min(1.8, Math.max(0.75, Math.round(s * 20) / 20));
/** Scroll events this soon after a jump (contents, scrubber, a search hit) are the jump's, not reading. */
const JUMP_MS = 800;

/** Writes the details into the document's file (write access asked first); what went wrong, or null. */
async function detailsWritten(id: string, handle: DocHandle, details: Details): Promise<string | null> {
  try {
    // Write access first, while the tap still counts as a user gesture.
    if (!(await repo.requestAccess(id, true))) return t.detailsFailed;
    await saveDetails(id, handle, details);
    return null;
  } catch (e) {
    return e instanceof Error && /encrypted/.test(e.message) ? t.detailsEncrypted : t.detailsFailed;
  }
}

/** The document as a file in the archive's Inbox, which it then is: reading state, bookmarks and all stay with it. */
async function keptInArchive(doc: DocRecord, handle: DocHandle, archive: string) {
  const bytes = await handle.bytes();
  const type = 'application/pdf';
  const entry = await folders.create({ root: archive, dir: await inboxDir(archive) }, doc.fileName, new Blob([bytes], { type }));
  await libraryActions().linkTo(doc.id, { name: entry.name, size: bytes.byteLength, handle: entry.handle, link: entry.uri });
}

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
  const textScale = usePrefs((s) => s.textScale);
  const setPrefs = usePrefs((s) => s.set);
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  // The actions only (stable): the reader doesn't re-render when other documents (or its own position) change.
  const { savePosition, flushPositions, toggleInvert, markOpened, setView, updateFileInfo, setDetails } = libraryActions();
  // Where it was left: in the library at once when the reader closes.
  useEffect(() => () => flushPositions(true), [flushPositions]);
  // Page view shows the PDF as authored; text view reflows it (remembered per document).
  const view = doc.view ?? 'page';
  const textApiRef = useRef<ReflowApi | null>(null);
  // Only the reader in front takes keys and Back: another one opened over it (a file dropped) leaves this one mounted underneath.
  const focused = useIsFocused();
  const edits = useEdits(doc, handle, focused);
  // Text read in the background waits for unsaved changes (one would be written over the other).
  useEffect(() => {
    editing(doc.id, edits.dirty);
    return () => editing(doc.id, false);
  }, [doc.id, edits.dirty]);
  // A message from before the reopen, shown by this reader once (read while rendering, which may happen twice:
  // it is let go once the reader is up).
  const [reloaded, setReloaded] = useState(() => afterReload);
  useEffect(() => {
    afterReload = null;
  }, []);
  const [savingDetails, setSavingDetails] = useState(false);
  // Indexing shares the PDF engine: it waits while a document is open.
  useEffect(() => pauseIndexing(), []);
  const writeDetails = async (details: Details) => {
    // Saved into the file: a document only viewed is kept first.
    if (!(await libraryActions().ensureKept(doc.id))) return;
    setSavingDetails(true);
    const failed = await detailsWritten(doc.id, handle, details);
    setSavingDetails(false);
    if (failed) return setReloaded(failed);
    setDetails(doc.id, { title: details.title, author: details.sender });
    invalidate(doc.id);
    afterReload = t.detailsSaved;
    // Reopened from the file, so everything (and a later save of form edits) starts from the new details.
    if (onReload) onReload();
    else setReloaded(t.detailsSaved);
  };

  // A document not in the archive yet (only on this device, or in another folder) can be kept there.
  const archive = usePrefs((s) => s.archive);
  const indexed = useThrottled(useIndex((s) => s.changed), 1500);
  const [outside, setOutside] = useState(false);
  useEffect(() => {
    if (!archive || Platform.OS !== 'web') return;
    let alive = true;
    // After the first pages: it reads the whole file.
    const timer = setTimeout(() => {
      (async () => {
        const key = doc.shareKey ?? (await docKey(await handle.bytes()));
        const filed = (await allDocs()).filter((d) => d.place.kind === 'folder' && d.place.root === archive);
        // Its own file may be there with other bytes (its edits saved since): told by where the file is.
        const link = doc.linked ? await repo.linkOf(doc.id) : undefined;
        const own = doc.linked && !link ? await repo.handleOf(doc.id) : undefined;
        const isOwn = async (d: IndexedDoc) =>
          d.place.kind === 'folder' && ((!!link && d.place.entry.uri === link) || (!!own && !!d.place.entry.handle && d.name === doc.fileName && (await own.isSameEntry(d.place.entry.handle).catch(() => false))));
        let inside = filed.some((d) => d.share === key);
        for (const d of filed) if (!inside) inside = await isOwn(d);
        if (alive) setOutside(!inside);
      })().catch(() => {});
    }, 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [archive, doc.shareKey, doc.linked, doc.id, doc.fileName, handle, indexed]);
  // A document only viewed becomes the library's, from where it is (a file in place stays there).
  const keepViewed = async () => {
    if (!(await libraryActions().keep(doc.id))) return;
    setReloaded(t.keptInTessel);
    // As anything added: pages without text get theirs.
    const kept = libraryActions().docs.find((d) => d.id === doc.id);
    if (kept) readAdded([kept]);
  };
  const keepInArchive = async () => {
    if (!archive) return;
    const kept = await keptInArchive(doc, handle, archive).then(
      () => true,
      (e: unknown) => (setReloaded(opError(e)), false),
    );
    if (!kept) return;
    readAdded([doc]);
    schedule(1000);
    void refreshInboxCount();
    afterReload = t.keptInArchive;
    if (onReload) onReload();
    else setReloaded(t.keptInArchive);
  };

  // A PDF with pages without text (a scan, or scanned pages after typed ones) can get their text read and added.
  const [textless, setTextless] = useState(false);
  // Reading text, in the background (Make searchable, Improve text with AI, or as it was added): shown while it
  // waits or is read; the document opens again with its text once it is in the file.
  const ai = usePrefs((s) => s.ai);
  const canImprove = Platform.OS === 'web' && aiReady(ai);
  const intakeBusy = useIntake((s) => s.waiting.includes(doc.id));
  const reading = useIntake((s) => (s.reading?.id === doc.id ? s.reading : null));
  useEffect(
    () =>
      useIntake.subscribe((s, before) => {
        const f = s.finished;
        if (!f || f === before.finished || f.id !== doc.id) return;
        if (!f.changed) return f.said && setReloaded(f.said);
        invalidate(doc.id);
        afterReload = f.said;
        if (onReload) onReload();
        else if (f.said) setReloaded(f.said);
      }),
    [doc.id, onReload],
  );
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    let alive = true;
    // The first page at once; the others once the first pages are drawn.
    pagesWithoutText(handle, 1)
      .then((first) => first.length > 0 || new Promise<void>((r) => setTimeout(r, LOOK_LATER_MS)).then(() => anyPageWithoutText(handle, PAGES_LOOKED_AT, () => !alive)))
      .then((any) => alive && setTextless(any), () => {});
    return () => {
      alive = false;
    };
  }, [handle, doc.format]);
  const improveText = async () => {
    if (intakeBusy || !(await libraryActions().ensureKept(doc.id))) return;
    const yes = await ask({ title: t.improveAsk, body: t.improveAskBody(handle.pageCount, aiHost(ai)), confirm: t.improveGo });
    if (yes === null) return;
    const rec = libraryActions().docs.find((d) => d.id === doc.id);
    if (rec) readText(rec, true);
  };
  const addText = async () => {
    if (intakeBusy || !(await libraryActions().ensureKept(doc.id))) return;
    const rec = libraryActions().docs.find((d) => d.id === doc.id);
    if (rec) readText(rec, false);
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
  const jumpedAt = useRef(0);
  const { moving, moved } = useMoving(!isWide(winW));

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
    // A scroll put there, not read there: the browser's late scroll event after it isn't reading to the end.
    jumpedAt.current = Date.now();
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
      jumpedAt.current = Date.now();
      cache.setFocus(target);
      if (view === 'text') textApiRef.current?.scrollToPage(target);
      else scrollTo(layout.offsets[target] - layout.padTop, animated);
      setPage(target);
    },
    [layout, handle.pageCount, scrollTo, cache, view],
  );

  // Scrolling hides the page pills for a moment (they come back when it stops).
  const trackDirection = useCallback((_y: number) => moved(), [moved]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!layout || !vp || !restored.current) return;
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      scrollY.current = y;
      posRef.current = positionAt(layout, y);
      // The saved position is the top of the viewport, which never reaches a last page shorter than
      // the screen: the end counts as reached once scrolled to the bottom (by reading, not by a jump there).
      const bottom = y > 0 && y + layoutMeasurement.height >= contentSize.height - 8;
      const atEnd = bottom && Date.now() - jumpedAt.current > JUMP_MS;
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
  // Reading every page's annotations takes a while on long documents: only once the Notes tab is shown.
  const [notesShown, setNotesShown] = useState(false);
  const showNotes = useCallback(() => setNotesShown(true), []);
  // Read again only when they changed (not each time Find opens).
  const annotsRead = useRef(-1);
  useEffect(() => {
    if (panel !== 'find' || !notesShown || annotsRead.current === annotVersion) return;
    let alive = true;
    handle.annotations().then(
      (a) => {
        if (!alive) return;
        annotsRead.current = annotVersion;
        setAnnots(a);
      },
      () => alive && setAnnots([]),
    );
    return () => {
      alive = false;
    };
  }, [panel, notesShown, handle, annotVersion]);

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
  // A note on the page itself (what a bookmark was): in the corner, saved into the file like any note.
  const onPageNote = useCallback(
    async (pg: number) => {
      const contents = await askNote('', '');
      if (contents == null) return;
      await handle.addNote(pg, { x: 0.03, y: 0.02 }, HIGHLIGHT_COLORS[0].hex, contents.trim() || t.pageNoteDefault);
      annotated([pg]);
    },
    [askNote, handle, annotated],
  );
  // Notes are addressed by their place on the page: one change at a time, and the list kept right meanwhile.
  const noteBusy = useRef(false);
  const onEditNote = useCallback(
    async (a: Annotation) => {
      if (noteBusy.current) return;
      const contents = await askNote(a.contents, a.quote);
      if (contents == null || contents === a.contents || noteBusy.current) return;
      noteBusy.current = true;
      await handle
        .updateAnnotation(a.page, a.index, { contents })
        .then(() => {
          // By place, not by object: a list read meanwhile has new ones.
          setAnnots((list) => list && list.map((x) => (x.page === a.page && x.index === a.index ? { ...x, contents } : x)));
          annotated([a.page]);
        })
        .finally(() => {
          noteBusy.current = false;
        });
    },
    [askNote, handle, annotated],
  );
  const onDeleteNote = useCallback(
    async (a: Annotation) => {
      if (noteBusy.current) return;
      noteBusy.current = true;
      await handle
        .removeAnnotation(a.page, a.index)
        .then(() => {
          // Later annotations on that page move up one place (matched by place: a list read meanwhile has new objects).
          setAnnots((list) => list && list.filter((x) => x.page !== a.page || x.index !== a.index).map((x) => (x.page === a.page && x.index > a.index ? { ...x, index: x.index - 1 } : x)));
          annotated([a.page]);
        })
        .finally(() => {
          noteBusy.current = false;
        });
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
            if (!raf) raf = requestAnimationFrame(flush);
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
      jumpedAt.current = Date.now();
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

  // Back (Android's button, Esc): what is open closes first; unsaved edits are asked about before leaving.
  const closeSomething = useCallback(() => {
    if (noteRequest) return noteRequest.resolve(null), true;
    if (menu) return setMenu(false), true;
    // Details typed in and not saved are asked about first.
    if (panel === 'details' && useDrafts.getState().details) return void discardDetails().then((yes) => yes && setPanel(null)), true;
    if (panel) return setPanel(null), true;
    return false;
  }, [noteRequest, menu, panel]);
  useEffect(() => {
    if (!focused) return;
    return onBack(() => {
      if (closeSomething()) return true;
      if (!edits.unsaved) return false;
      edits.leave();
      return true;
    });
  }, [closeSomething, edits, focused]);

  // ---------- keyboard + wheel (web) ----------
  useEffect(() => {
    if (Platform.OS !== 'web' || !vp || !focused) return;
    const text = view === 'text';
    const sizeText = (f: number) => setPrefs({ textScale: clampText(f === 0 ? 1 : textScale * f) });
    // Shortcuts with ⌘/Ctrl (and F3) are taken before a text field sees them: a field would keep them from the
    // page (and the browser would find, save or print instead). Letters whatever Shift or Caps Lock say.
    const onShortcut = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (useAsk.getState().request || !(mod || key === 'F3')) return;
      if (mod && key === 'p') return e.preventDefault(), void printDoc(doc, edits.current).catch(() => {});
      // ⌘S saves edits when there are any; otherwise it downloads, as before.
      if (mod && key === 's') return e.preventDefault(), void (edits.dirty || useDrafts.getState().field ? edits.save() : downloadDoc(doc, edits.current).catch(() => {}));
      if (mod && key === 'f') {
        e.preventDefault();
        setChrome(true);
        return openFind(true);
      }
      if (mod && (key === '=' || key === '+')) return e.preventDefault(), text ? sizeText(1.1) : setZoom(zoom * 1.2);
      if (mod && key === '-') return e.preventDefault(), text ? sizeText(1 / 1.1) : setZoom(zoom / 1.2);
      if (mod && key === '0') return e.preventDefault(), text ? sizeText(0) : setZoom(1);
      if ((mod && key === 'g') || key === 'F3') return e.preventDefault(), stepHit(e.shiftKey ? -1 : 1);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      // Typing, or a form's checkbox or radio (Space ticks it).
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') || !!target?.closest?.('.fl');
      // A question being asked has the keys (Esc answers it itself).
      if (useAsk.getState().request || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (closeSomething()) return;
        // A selection (its Highlight bubble) goes before the document does.
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return sel.removeAllRanges();
        return searchActive ? onQuery('') : edits.leave();
      }
      if (typing || mod) return;
      const step = vp.h * 0.15;
      const pageStep = vp.h - TOP_BAR - BOTTOM_BAR;
      // Text view scrolls its own list; page view the pages.
      const by = (dy: number, animated: boolean) => (text ? textApiRef.current?.scrollBy(dy, animated) : scrollTo(scrollY.current + dy, animated));
      const keys: Record<string, () => void> = {
        ArrowDown: () => by(step, false),
        ArrowUp: () => by(-step, false),
        j: () => by(step, false),
        k: () => by(-step, false),
        ' ': () => by(e.shiftKey ? -pageStep : pageStep, true),
        PageDown: () => by(pageStep, true),
        PageUp: () => by(-pageStep, true),
        ArrowRight: () => goToPage(page + 1),
        ArrowLeft: () => goToPage(page - 1),
        Home: () => goToPage(0),
        // End means the end of the document, not the top of its last page; a jump there isn't reading to it.
        End: () => {
          jumpedAt.current = Date.now();
          if (view === 'text') goToPage(handle.pageCount - 1);
          else scrollTo(Number.MAX_SAFE_INTEGER, false);
        },
        b: () => void onPageNote(page),
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
          if (text) {
            // Type sizes go in steps: small pinches add up until they make one.
            const next = clampText(textScale * pending);
            if (next === textScale) return;
            setPrefs({ textScale: next });
          } else setZoom(zoom * pending, cursor);
          pending = 1;
        });
    };
    const onMove = (e: MouseEvent) => {
      if (e.clientY < TOP_BAR + 24 || e.clientY > window.innerHeight - BOTTOM_BAR - 24) setChrome(true);
    };
    window.addEventListener('keydown', onShortcut, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('keydown', onShortcut, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [vp, focused, zoom, panel, page, doc, handle.pageCount, goToPage, scrollTo, setZoom, onPageNote, stepHit, searchActive, onQuery, switchView, view, edits, closeSomething, textScale, setPrefs]);

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
  const chromeShown = chrome || panel != null;
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

  const togglePanel = (name: Exclude<PanelName, null>) => setPanel((x) => (x === name ? null : name));
  // Pages with notes: marked on the scrubber and among the pages.
  const noted = useMemo(() => [...new Set((annots ?? []).filter((a) => a.contents.trim()).map((a) => a.page))], [annots]);
  const chapters = useMemo(() => (outline ?? []).filter((o) => o.depth === 0 && o.page >= 0), [outline]);
  const wide = isWide(winW);
  const onPagePress = useCallback(() => {
    // Finishing a text selection is a click too; don't treat it as a tap on the page.
    if (Platform.OS === 'web' && window.getSelection()?.toString()) return;
    if (panel && !wide) setPanel(null);
  }, [panel, wide]);

  // Document actions; how it looks lives in Aa, how to find things in the bar.
  const menuItems: MenuItem[] = [
    // Most used first.
    ...(doc.viewed ? [{ key: 'keep', icon: 'inbox' as const, label: t.keepInTessel, onPress: () => void keepViewed() }] : []),
    { key: 'share', icon: 'share', label: t.share, onPress: () => void shareDoc(doc, edits.current).catch(() => {}) },
    { key: 'details', icon: 'tag', label: t.details, onPress: () => setPanel('details') },
    ...(outside && !doc.viewed && !edits.dirty ? [{ key: 'keep-archive', icon: 'inbox' as const, label: t.keepInArchive, onPress: () => void keepInArchive() }] : []),
    ...(textless && !edits.dirty && !intakeBusy ? [{ key: 'searchable', icon: 'search' as const, label: t.makeSearchable, onPress: () => void addText() }] : []),
    ...(canImprove && !edits.dirty && !intakeBusy ? [{ key: 'improve', icon: 'textView' as const, label: t.improveWithAi, onPress: () => void improveText() }] : []),
    ...(canDownload ? [{ key: 'download', icon: 'install' as const, label: t.download, hint: shortcut('S'), onPress: () => void downloadDoc(doc, edits.current).catch(() => {}) }] : []),
    { key: 'print', icon: 'print', label: t.print, hint: shortcut('P'), onPress: () => void printDoc(doc, edits.current).catch(() => {}) },
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
          // The end of the text clears the page and bookmark pills.
          padBottom={insets.bottom + BOTTOM_BAR + space.lg}
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
        <IconButton icon="back" label={t.back} onPress={edits.leave} testID="back" />
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
          <IconButton icon="search" label={withShortcut(t.findShortcut, 'F')} active={panel === 'find'} onPress={() => (panel === 'find' ? setPanel(null) : openFind(false))} testID="open-find" />
          <IconButton
            icon="textView"
            label={withKey(t.textView, 'V')}
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
                accessibilityLabel={`${t.pageOf(page + 1, handle.pageCount)}`}
                accessibilityHint={t.goToPage}
                onPress={() => setEditingPage(true)}
                testID="page-label"
              >
                <T v="numeral" style={{ fontSize: 13 }}>
                  {page + 1}
                  <T v="numeral" color={p.muted} style={{ fontSize: 13 }}>
                    {'  /  '}
                    {handle.pageCount}
                  </T>
                </T>
              </Pressable>
            )}
          </View>
          <View style={[styles.pill, styles.tools, { backgroundColor: p.glass, borderColor: p.hairline }]}>
            {wide && view === 'page' && (
              <>
                <IconButton icon="zoomOut" label={withShortcut(t.zoomOut, '−')} size={34} onPress={() => setZoom(zoom / 1.2)} />
                <Pressable accessibilityRole="button" onPress={() => setZoom(1)} accessibilityLabel={t.resetZoom}>
                  <T v="numeral" color={p.muted} style={{ minWidth: 40, textAlign: 'center' }}>
                    {Math.round(zoom * 100)}%
                  </T>
                </Pressable>
                <IconButton icon="zoomIn" label={withShortcut(t.zoomIn, '+')} size={34} onPress={() => setZoom(zoom * 1.2)} />
              </>
            )}
            {wide && view === 'text' && (
              <>
                <IconButton icon="zoomOut" label={withShortcut(t.smaller, '−')} size={34} onPress={() => setPrefs({ textScale: clampText(textScale - 0.1) })} />
                <Pressable accessibilityRole="button" onPress={() => setPrefs({ textScale: 1 })} accessibilityLabel={t.size}>
                  <T v="numeral" color={p.muted} style={{ minWidth: 40, textAlign: 'center' }}>
                    {Math.round(textScale * 100)}%
                  </T>
                </Pressable>
                <IconButton icon="zoomIn" label={withShortcut(t.larger, '+')} size={34} onPress={() => setPrefs({ textScale: clampText(textScale + 0.1) })} />
              </>
            )}
            <IconButton icon="note" label={withShortcut(t.pageNote, 'B')} size={34} onPress={() => void onPageNote(page)} testID="page-note" />
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
            bookmarks={noted}
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
          more={hits.some((h) => h.more)}
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
            bookmarks: noted,
            annotations: annots,
            onShowNotes: showNotes,
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
      {intakeBusy && (
        <View pointerEvents="none" testID="searchable-progress" style={[styles.reading, { top: insets.top + TOP_BAR + space.md, backgroundColor: p.glass, borderColor: p.hairline }]}>
          <T v="caption" color={p.ink}>
            {!reading
              ? t.readingWaiting
              : reading.ai
                ? reading.total
                  ? t.improveProgress(reading.done, reading.total)
                  : t.improveWithAi
                : reading.total
                  ? t.searchableProgress(reading.done, reading.total)
                  : t.makeSearchable}
          </T>
        </View>
      )}
      <Toast message={panel && !wide ? null : (edits.notice ?? reloaded)} onDismiss={() => (edits.clearNotice(), setReloaded(null))} />
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
