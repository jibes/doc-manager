import { router, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ascending, FACETS, facetCounts, matches, placeOf, SORTS, sortDocs, type Facet, type Filter, type SavedView, type Sort } from '@/paper/archive/facets';
import { allDocs, refreshSoon, searchAll, snippetsFor, useIndex, warmSearch } from '@/paper/archive/indexer';
import { HitRow, openDoc, openInWindow } from '@/paper/archive/Results';
import { ManyDetails } from '@/paper/archive/ManyDetails';
import { writeDetailsMany } from '@/paper/archive/manyDetails';
import { DOCS_TYPE, dragFile, prepareDrag } from '@/paper/archive/dragOut';
import { MoreMenu, type MenuItem } from '@/paper/reader/MoreMenu';
import { QuickLook } from '@/paper/archive/QuickLook';
import { Palette, type PaletteItem } from '@/paper/components/Palette';
import { duplicateGroups } from '@/paper/archive/duplicates';
import { dropOldState } from '@/paper/archive/dirs';
import { dropSources } from '@/paper/archive/tessel';
import type { Hit, IndexedDoc } from '@/paper/archive/search';
import { loadViews, removeView, saveView, useViews } from '@/paper/archive/views';
import { Icon, type IconName } from '@/paper/components/Icon';
import { Button, IconButton, T } from '@/paper/components/primitives';
import { AppFrame, AppHeader, columnWidth, scanSupported, useMainWidth } from '@/paper/components/AppNav';
import { DocList, gridOf, LayoutToggle, useLayout } from '@/paper/components/DocItems';
import { SortChip } from '@/paper/components/SortChip';
import { Action, ActionBar, BAR_ROOM, heldNow, justSelected, SelectBar, toggled, useEndPicking } from '@/paper/components/Selection';
import { deleteAll, deletesForGood, renameDoc, shareAll, undoDelete } from '@/paper/archive/batch';
import { readAdded, useIntake } from '@/paper/archive/intake';
import { aiReady } from '@/paper/scan/ai';
import { startScan } from '@/paper/scan/start';
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { fonts, radius, space } from '@/core/design/tokens';
import { errorText, opError, t } from '@/core/i18n';
import { shortcut } from '@/core/lib/keys';
import { realTitle } from '@/paper/archive/pdfInfo';
import { useThrottled } from '@/core/lib/useThrottled';
import { showActions, useActions } from '@/paper/state/actions';
import { ask, useAsk } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';
import { folders } from '@/core/lib/folders';
import { useLibrary, type ImportItem } from '@/paper/state/library';
import { EmptyLibrary } from '@/paper/components/EmptyLibrary';
import { pickPdfs, sampleItem } from '@/paper/state/pick';
import { useInstall } from '@/core/lib/install';
import { repo, type DocRecord } from '@/core/storage';
import { useCache } from '@/paper/state/cache';
import { refreshInboxCount, useInboxCount } from '@/paper/archive/inbox';
import { closePane, showInPane, usePane } from '@/paper/state/pane';
import { ReadView } from '@/paper/reader/ReadView';

const newViewId = () => `v-${Date.now().toString(36)}`;

/** AGPL §13: offer the source to network users. */
const SOURCE_URL = 'https://github.com/jibes/doc-manager';

function openRecord(doc: DocRecord) {
  // A linked file may need the browser's OK again (after a restart); ask while the tap still counts as a gesture.
  const ready = doc.linked ? repo.requestAccess(doc.id).catch(() => false) : Promise.resolve(true);
  ready.then(async () => (await showInPane({ id: doc.id })) || router.push({ pathname: '/read/[id]', params: { id: doc.id } }));
}

/** Rows shown at first, and added each time the list is scrolled near its end. */
const PAGE = 100;
/** While indexing, the list and the search are read again at most this often. */
const REFRESH_MS = 1500;
const finePointer = () => Platform.OS === 'web' && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
/** The index's documents as last read here (null: not yet). */
let lastRead: IndexedDoc[] | null = null;

const facetName: Record<Facet, string> = { tag: t.facetTag, sender: t.facetSender, type: t.facetType, year: t.facetYear };
const facetIcon: Record<Facet, IconName> = { tag: 'tag', sender: 'person', type: 'pages', year: 'calendar' };

const sortName: Record<Sort, string> = { opened: t.sortOpened, date: t.sortDate, name: t.sortName, size: t.sortSize };
/** How close to the end of the list (in points) the next rows are added. */
const AHEAD = 1500;

const asHit = (doc: IndexedDoc): Hit => ({ doc, score: 0, page: 0, snippet: null });
/** List column width from which every filter has its own chip. */
const ROOMY = 640;
/** Window width from which a document opens beside the list, and the list's width then. */
const SPLIT_MIN = 1300;
/** Window width from which the ⋯ menu's items are buttons of their own. */
const EXPAND_MORE = 900;
const LIST_W = 500;
const isEmpty = (f: Filter) => FACETS.every((k) => !f[k]);
/** What the screen shows: the search, filters and the order. */
type Showing = { query: string; filter: Filter; sort: Sort; reverse: boolean; relevance: boolean };
/** Views from before the order was kept: a search by date was best matches first. */
const byRelevanceIn = (v: SavedView) => !!v.query && (v.relevance ?? v.sort === 'date');
const sameView = (v: SavedView, s: Showing) =>
  v.query === s.query &&
  FACETS.every((k) => (v.filter[k] ?? '') === (s.filter[k] ?? '')) &&
  byRelevanceIn(v) === s.relevance &&
  (s.relevance || (v.sort === s.sort && !!v.reverse === s.reverse));

/**
 * Every document in the library and the folders: searched, narrowed by tag, sender, type and year, sorted, and
 * kept as named views (in the archive folder, so the other devices have them too).
 */
export default function Documents() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; view?: string; sort?: string }>();
  const archive = usePrefs((s) => s.archive);
  const inboxHere = usePrefs((s) => s.inboxHere);
  const inboxCount = useInboxCount((s) => s.count);
  // Conflict copies only: files there twice are under Duplicates.
  const syncIssues = useIndex((s) => s.conflicts.length);
  const winWidth = useMainWidth();
  const pane = usePane((s) => s.doc);
  // Changes not saved yet in the document beside the list: it stays (the window made narrower doesn't drop them).
  const paneEdited = useIntake((s) => !!pane && s.editing.includes(pane.id));
  // A wide desktop window: the list, and beside it the document opened from it.
  const split = Platform.OS === 'web' && (winWidth >= SPLIT_MIN || paneEdited);
  const mainWidth = split ? LIST_W : winWidth;
  const focused = useIsFocused();
  // Too narrow for it (the window made narrower, or saved changes no longer keep it): the document beside the
  // list goes on as a screen of its own, where it was (its place is kept as it is read).
  useEffect(() => {
    if (split) return;
    const open = usePane.getState().doc;
    closePane();
    if (open && focused) router.push({ pathname: '/read/[id]', params: { id: open.id } });
  }, [split, focused]);
  // Only while the list is the screen shown: a document opened from Inbox or Duplicates on top opens as a screen.
  useEffect(() => {
    usePane.setState({ split: split && focused });
    return () => usePane.setState({ split: false });
  }, [split, focused]);
  // Folders read as sources before 3.2: let go of, once.
  useEffect(() => {
    void refreshInboxCount();
    void dropSources().catch(() => {});
  }, []);
  const aiSet = usePrefs((s) => aiReady(s.ai));
  const improveAdded = usePrefs((s) => s.improveAdded);
  const intake = useIntake((s) => s.reading);
  const intakeSaid = useIntake((s) => s.said);
  const { view: viewFile, importFiles } = useLibrary();
  const { kind: installKind, install } = useInstall();
  // Open file: one file is opened to look at (kept when something about it is saved); several, and the guide, are kept.
  const openFiles = async (items: ImportItem[]) => {
    const one = items.length === 1 && !items[0].bundled ? await viewFile(items[0]) : null;
    if (one) return openRecord(one);
    const added = items.length === 1 && !items[0].bundled ? [] : await importFiles(items);
    readAdded(added);
    if (added.length === 1) openRecord(added[0]);
  };
  // Add → Files: kept in the Tessel folder (its Inbox, where there is one); pages without text get theirs.
  const addFiles = async (ai: boolean) => {
    const added = await importFiles(await pickPdfs());
    readAdded(added, ai);
    if (added.length === 1) openRecord(added[0]);
    else if (added.length) say(t.filesAddedN(added.length));
  };
  // The model reading the text is asked for on each add (from the default in Settings), where one is set up.
  const addMenu = (ai = improveAdded) =>
    showActions(t.addTitle, [
      ...(scanSupported ? [{ key: 'add-camera', icon: 'camera' as IconName, label: t.addCamera, onPress: () => void startScan() }] : []),
      { key: 'add-files', icon: 'documents' as IconName, label: t.addFiles, onPress: () => void addFiles(aiSet && ai) },
      // A file only to look at (kept when something is saved into it).
      { key: 'add-open', icon: 'pageView' as IconName, label: t.addOpen, onPress: async () => void openFiles(await pickPdfs()) },
      ...(aiSet ? [{ key: 'add-ai', icon: (ai ? 'check' : 'sparkles') as IconName, label: ai ? t.addAiOn : t.addAiOff, onPress: () => addMenu(!ai) }] : []),
    ]);
  const [query, setQuery] = useState(params.q ?? '');
  const [filter, setFilter] = useState<Filter>({});
  // Opens on what was opened lately: where you were, first.
  const [sort, setSort] = useState<Sort>(() => (SORTS.includes(params.sort as Sort) ? (params.sort as Sort) : 'opened'));
  // Asked for from Reading ("All recently opened") while the screen was already open.
  // Each order its usual way round (names A–Z, the rest newest or largest first) unless turned.
  const [reverse, setReverse] = useState(false);
  const [askedSort, setAskedSort] = useState(params.sort);
  if (askedSort !== params.sort) {
    setAskedSort(params.sort);
    if (SORTS.includes(params.sort as Sort)) {
      setSort(params.sort as Sort);
      setReverse(false);
    }
  }
  // When this device last opened (or added) each document: the library knows (files don't say), by document or file.
  const library = useLibrary((s) => s.docs);
  const cached = useCache((s) => s.docs);
  const liveOpenedAt = useMemo(() => {
    const byKey = new Map<string, number>();
    for (const d of library) {
      if (d.viewed) continue;
      // Added (a scan just saved, a file just opened from elsewhere) counts as opened.
      const at = d.openedAt ?? d.addedAt;
      byKey.set(`lib:${d.id}`, at);
      if (d.shareKey) byKey.set(`share:${d.shareKey}`, Math.max(at, byKey.get(`share:${d.shareKey}`) ?? 0));
      byKey.set(`file:${d.fileName}|${d.bytes}`, Math.max(at, byKey.get(`file:${d.fileName}|${d.bytes}`) ?? 0));
    }
    // This device's cache first (by content, wherever the file is); then the library's records.
    return (d: IndexedDoc) => (d.share ? cached.get(d.share)?.openedAt : undefined) ?? byKey.get(d.key) ?? (d.share ? byKey.get(`share:${d.share}`) : undefined) ?? byKey.get(`file:${d.name}|${d.size}`);
  }, [library, cached]);
  // Beside a document, the order stays as it was when the first was opened (opening one would move it to the top,
  // from under the cursor).
  const [held, setHeld] = useState<{ at: typeof liveOpenedAt } | null>(null);
  const holding = split && !!pane;
  if (holding && !held) setHeld({ at: liveOpenedAt });
  if (!holding && held) setHeld(null);
  const openedAt = held?.at ?? liveOpenedAt;
  // Search results come best match first, until another order is chosen for them.
  const [bestFirst, setBestFirst] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const { notice, id: noticeId, say, dismiss, action } = useNotice();
  // Picked documents (by key), while picking: Esc, Back and switching to Folders (here or in the sidebar) end it.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEndPicking(!!selected, setSelected);
  const { done, running, total } = useIndex();
  // Read again as indexing adds, moves and drops documents (not with each one).
  const indexed = useIndex((s) => s.changed);
  const changed = useThrottled(indexed, REFRESH_MS);
  const views = useViews((s) => s.views);

  // The list as last read: the screen mounting again (a document opened beside it) shows it at once, not empty.
  const [all, setAll] = useState<IndexedDoc[]>(() => lastRead ?? []);
  // Until the index has answered once, nothing is known (not "no documents").
  const [ready, setReady] = useState(() => lastRead !== null);
  useEffect(() => {
    let alive = true;
    allDocs().then((d) => {
      lastRead = d;
      if (!alive) return;
      // Documents that can't be opened here (protected, damaged) are listed too, by their name.
      setAll(d);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [changed]);

  // The search index is built ahead, so the first search answers at once.
  useEffect(() => warmSearch(), []);
  // Views as stored now, each time the screen comes back (another device may have changed them).
  // The index looks again if its last look is a while ago (what Syncthing brought meanwhile).
  useFocusEffect(
    useCallback(() => {
      loadViews().catch(() => {});
      // Left by versions before 3.0 (shared reading): removed once.
      const tessel = usePrefs.getState().archive;
      if (tessel) void dropOldState(tessel).catch(() => {});
      refreshSoon();
    }, []),
  );

  // Search results, kept with the query they answer (so an older answer never shows for a newer query).
  const [found, setFound] = useState<{ query: string; hits: Hit[] } | null>(null);
  const q = query.trim();
  const searching = q.length >= 2;
  useEffect(() => {
    if (q.length < 2) return;
    let alive = true;
    const timer = setTimeout(() => {
      searchAll(q).then((hits) => alive && setFound({ query: q, hits }), () => alive && setFound({ query: q, hits: [] }));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, changed]);

  // The answer to an earlier query stays while the new one is on its way (no "0 documents" in between).
  const pending = searching && found?.query !== q;
  // With a query, best matches first; without, every document by date or name.
  const base = useMemo(() => {
    const answer = found?.hits ?? [];
    const hits = searching ? (bestFirst ? answer : sortDocs(answer, sort, (h) => h.doc, openedAt, reverse)) : sortDocs(all, sort, undefined, openedAt, reverse).map(asHit);
    // The Tessel folder's (what an earlier version read elsewhere leaves with the next indexing).
    return hits.filter((h) => placeOf(h.doc, archive) === 'tessel');
  }, [searching, found, all, sort, reverse, bestFirst, archive, openedAt]);
  const doubled = useMemo(() => {
    const inTessel = (d: IndexedDoc) => placeOf(d, archive) === 'tessel';
    // Possible older versions counted too (the Duplicates screen reads the files to tell): it is the way there.
    return duplicateGroups(all, inTessel, () => true).length;
  }, [all, archive]);
  // Everything else, one step away: the inbox, the trash, sync issues, the rules, installing the app.
  const moreItems = [
      ...(archive && inboxHere ? [{ key: 'more-inbox', icon: 'inbox' as IconName, label: inboxCount ? t.inboxWaiting(inboxCount) : t.inboxTitle, onPress: () => router.push('/inbox') }] : []),
      ...(archive ? [{ key: 'more-trash', icon: 'trash' as IconName, label: t.trashTitle, onPress: () => router.push('/trash') }] : []),
      ...(doubled > 0 ? [{ key: 'more-duplicates', icon: 'copy' as IconName, label: t.duplicatesN(doubled), onPress: () => router.push('/duplicates') }] : []),
      ...(syncIssues > 0 ? [{ key: 'more-sync', icon: 'sync' as IconName, label: t.syncIssues(syncIssues), onPress: () => router.push('/sync') }] : []),
      ...(archive ? [{ key: 'more-rules', icon: 'rules' as IconName, label: t.rulesTitle, onPress: () => router.push('/rules') }] : []),
      ...(installKind ? [{ key: 'more-install', icon: 'install' as IconName, label: t.install, onPress: () => (installKind === 'prompt' ? void install() : say(t.installHintIos)) }] : []),
  ];
  // ⋯ only for two or more; one is a button of its own, none is nothing.
  const onlyMore = moreItems.length === 1 ? moreItems[0] : null;
  const counts = useMemo(() => facetCounts(base.map((h) => h.doc), filter), [base, filter]);
  const shown = useMemo(() => base.filter((h) => matches(h.doc, filter)), [base, filter]);

  // The words around the match, for rows shown that came without them (the search has them for its best few).
  const [around, setAround] = useState<{ query: string; of: Map<string, Pick<Hit, 'page' | 'snippet'>> }>({ query: '', of: new Map() });
  const visible = useMemo(() => {
    const rows = shown.slice(0, limit);
    return around.query === q ? rows.map((h) => (h.snippet === undefined && around.of.has(h.doc.key) ? { ...h, ...around.of.get(h.doc.key) } : h)) : rows;
  }, [shown, limit, around, q]);
  const missing = useMemo(() => (searching ? visible.filter((h) => h.snippet === undefined).map((h) => h.doc.key) : []), [visible, searching]);
  useEffect(() => {
    if (!missing.length) return;
    let alive = true;
    snippetsFor(q, missing).then(
      (of) => {
        if (!alive) return;
        // Asked once: those without an answer show none.
        for (const key of missing) if (!of.has(key)) of.set(key, { page: 0, snippet: null });
        setAround((a) => ({ query: q, of: new Map([...(a.query === q ? a.of : []), ...of]) }));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [missing, q]);

  const choose = (facet: Facet) => {
    const chosen = filter[facet];
    showActions(facetName[facet], [
      { key: 'any', icon: chosen ? 'close' : 'check', label: t.facetAny, onPress: () => setFilter({ ...filter, [facet]: undefined }) },
      ...counts[facet].map((c, i) => ({
        key: `value-${i}`,
        icon: (chosen?.toLocaleLowerCase() === c.value.toLocaleLowerCase() ? 'check' : facetIcon[facet]) as IconName,
        label: t.facetCount(c.value, c.count),
        onPress: () => {
          setFilter({ ...filter, [facet]: c.value });
          setLimit(PAGE);
        },
      })),
    ]);
  };

  const byRelevance = searching && bestFirst;
  const chooseSort = () =>
    showActions(t.sortTitle, [
      ...(searching ? [{ key: 'sort-relevance', icon: (byRelevance ? 'check' : 'search') as IconName, label: t.sortRelevance, onPress: () => setBestFirst(true) }] : []),
      ...SORTS.map((s) => ({
        key: `sort-${s}`,
        icon: (!byRelevance && sort === s ? 'check' : 'sort') as IconName,
        label: sortName[s],
        onPress: () => {
          if (s !== sort || byRelevance) setReverse(false);
          setSort(s);
          setBestFirst(false);
        },
      })),
    ]);

  const apply = (v: SavedView) => {
    setQuery(v.query);
    setFilter(v.filter);
    setSort(v.sort);
    setReverse(!!v.reverse);
    setBestFirst(byRelevanceIn(v));
    setLimit(PAGE);
  };
  const current = views.find((v) => sameView(v, { query: q, filter, sort, reverse, relevance: byRelevance }));
  const canSave = !current && (!!q || !isEmpty(filter));
  // Settings that couldn't be read say so; anything else, that it wasn't saved.
  const viewFailed = (e: unknown) => say(e instanceof Error && e.message === t.settingsUnreadable ? e.message : t.viewFailed);

  const save = async () => {
    const suggested = [...FACETS.map((f) => filter[f]), q].filter(Boolean).join(' · ');
    const name = (await ask({ title: t.saveView, input: suggested, placeholder: t.viewName, confirm: t.saveView }))?.trim();
    if (!name) return;
    const view: SavedView = { id: newViewId(), name, query: q, filter, sort, ...(reverse ? { reverse } : {}), ...(q ? { relevance: byRelevance } : {}) };
    saveView(view).then(() => say(t.viewSaved(name)), viewFailed);
  };
  const viewActions = (v: SavedView) =>
    showActions(v.name, [
      { key: 'view-open', icon: 'check', label: t.viewOpen, onPress: () => apply(v) },
      { key: 'view-remove', icon: 'trash', label: t.viewRemove, destructive: true, onPress: () => void removeView(v.id).catch(viewFailed) },
    ]);

  // The filters in use, and all of them in one sheet (those without values in these documents left out).
  const active = FACETS.filter((f) => filter[f]).length;
  const openFilters = () =>
    showActions(t.filter, [
      ...FACETS.filter((f) => counts[f].length > 0 || filter[f]).map((f) => ({
        key: `facet-${f}`,
        icon: facetIcon[f],
        label: `${facetName[f]}: ${filter[f] ?? t.facetAny}`,
        onPress: () => choose(f),
      })),
      ...(active ? [{ key: 'facet-clear', icon: 'close' as IconName, label: t.clearFilters, onPress: () => setFilter({}) }] : []),
    ]);
  // Room for the action bar while picking.
  // Nothing indexed yet (and not searching): what to do instead of an empty list with its filters.
  const nothing = ready && all.length === 0 && !searching;
  const layout = useLayout();
  const column = columnWidth(mainWidth);
  // A wide list shows every filter, not one button for them.
  const roomy = split || column >= ROOMY;
  const grid = gridOf(column);
  // Room for the Add button (and the action bar while picking).
  const bottom = insets.bottom + space.xxxl + 56 + (selected ? 72 : 0);

  const picked = selected ? shown.filter((h) => selected.has(h.doc.key)).map((h) => h.doc) : [];
  const deletable = (docs: IndexedDoc[]) => docs.length > 0 && !docs.some((d) => d.place.kind === 'folder' && !folders.canEdit(d.place.root, d.place.entry));
  // A long press (or right click) starts picking; taps then add and remove.
  const hold = (key: string) => {
    if (justSelected(key)) return;
    heldNow(key);
    setSelected((s) => (s ? toggled(s, key) : new Set([key])));
  };
  const tap = (key: string) => !justSelected(key) && setSelected((s) => toggled(s, key));
  const batch = async (op: () => Promise<string | void>) => {
    try {
      const done = await op();
      if (done) say(done);
      setSelected(null);
    } catch (e) {
      say(opError(e));
    }
  };
  // Deleted documents leave the list at once (the index follows).
  const dropShown = (keys: Set<string>) => {
    setAll((a) => a.filter((d) => !keys.has(d.key)));
    setFound((f) => f && { ...f, hits: f.hits.filter((h) => !keys.has(h.doc.key)) });
  };
  const rename = async (d = picked[0]) => {
    // The list shows titles, the dialog the file's name: it says which one changes (a title is changed in Details).
    const titled = !!d.title && d.title !== d.name.replace(/\.pdf$/i, '');
    const name = (await ask({ title: t.renameFile, body: titled ? t.renameFileBody(d.title) : undefined, input: d.name.replace(/\.pdf$/i, ''), placeholder: t.newName, confirm: t.rename }))?.trim();
    if (!name) return;
    await batch(() => renameDoc(d, name));
  };
  // Documents only in this library leave it (as on Reading); files are deleted.
  const onlyHere = (list: IndexedDoc[]) => list.length > 0 && list.every((d) => d.place.kind === 'library');
  const remove = async (list = picked) => {
    if (onlyHere(list)) {
      const one = list.length === 1;
      const yes = await ask({
        title: one ? t.removeTitle : t.removeManyTitle(list.length),
        body: one ? t.removeConfirm(list[0].title || list[0].name) : t.removeManyBody,
        confirm: t.remove,
        destructive: true,
      });
      if (yes == null) return;
    } else if (deletesForGood(list)) {
      const yes = await ask({ title: t.deleteTitle(list.length), body: t.deleteBody(list.length, list[0].title || list[0].name), confirm: t.delete, destructive: true });
      if (yes == null) return;
    }
    await batch(async () => {
      const gone = new Set(list.map((d) => d.key));
      // The cursor goes to the next row left (or the one before), not to the list's ends.
      const { cursor: at, doc: shown } = usePane.getState();
      const i = visible.findIndex((h) => h.doc.key === at);
      if (i >= 0 && gone.has(visible[i].doc.key)) {
        const next = visible.slice(i + 1).find((h) => !gone.has(h.doc.key)) ?? visible.slice(0, i).reverse().find((h) => !gone.has(h.doc.key));
        usePane.setState({ cursor: next?.doc.key ?? null });
      }
      const { trashed, settle } = await deleteAll(list);
      dropShown(gone);
      // The one beside the list goes with it (opened from its row, or from Add: by its library record).
      const rec = shown && useLibrary.getState().docs.find((x) => x.id === shown.id);
      const isShown = (d: IndexedDoc) =>
        d.key === shown?.key || (d.place.kind === 'library' && d.place.id === shown?.id) || (!!rec && ((!!rec.shareKey && rec.shareKey === d.share) || (rec.fileName === d.name && rec.bytes === d.size)));
      if (shown && list.some(isShown)) closePane();
      const n = trashed.reduce((k, g) => k + g.items.length, 0);
      if (n && n === list.length) {
        say(t.trashedN(n), { undo: () => void undoDelete(trashed).catch((e) => say(opError(e))), settle });
        return;
      }
      settle();
      return onlyHere(list) ? t.removedN(list.length) : t.deletedN(list.length);
    });
  };

  // ---------- keyboard (web) ----------
  // ↑ ↓ go through the list (beside a document: open each), Enter opens, Space looks without opening, ⌘⌫ deletes,
  // ⌘K goes anywhere, ⌘N scans.
  const cursor = usePane((s) => s.cursor);
  // Several documents' details at once (picked, or one from its menu), and a right click's menu.
  const [many, setMany] = useState<IndexedDoc[] | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; hit: Hit } | null>(null);
  const [look, setLook] = useState<IndexedDoc | null>(null);
  const [palette, setPalette] = useState(false);
  const fail = (e: unknown) => say(errorText(e));
  const step = (dir: 1 | -1, from = cursor) => {
    if (!visible.length) return null;
    const at = visible.findIndex((h) => h.doc.key === from);
    const next = visible[at < 0 ? (dir > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, at + dir))];
    usePane.setState({ cursor: next.doc.key });
    if (split) void openDoc(next.doc, undefined, '').catch(fail);
    // A row with the keyboard's focus: the focus goes along (Space or Enter press the focused row, not one before).
    if (Platform.OS === 'web') {
      const index = visible.indexOf(next);
      requestAnimationFrame(() => {
        if (!(document.activeElement as HTMLElement | null)?.closest?.('[data-testid="archive-hit"]')) return;
        const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="archive-hit"]')].filter((r) => r.offsetParent);
        rows[index]?.focus({ preventScroll: true });
      });
    }
    return next;
  };
  const keys = useRef({ step, look, palette, cursor, visible, remove, deletable, split, selected, picked, menu: false, many: false });
  useEffect(() => {
    keys.current = { step, look, palette, cursor, visible, remove, deletable, split, selected, picked, menu: !!menu, many: !!many };
  });
  useEffect(() => {
    if (Platform.OS !== 'web' || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      // Not behind a dialog, sheet or menu (they have their own keys).
      if (useAsk.getState().request || e.defaultPrevented || k.look || k.palette || k.menu || k.many || useActions.getState().sheet) return;
      if (document.querySelector('[aria-modal="true"], [data-testid="more-menu"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mod && key === 'k') return e.preventDefault(), setPalette(true);
      if (mod && key === 'n' && scanSupported) return e.preventDefault(), void startScan();
      if (mod && key === 'o') return e.preventDefault(), void pickPdfs().then((items) => void (items.length && openFiles(items)));
      const target = e.target as HTMLElement | null;
      // The document beside the list has its own keys.
      if (target?.closest?.('[data-testid="doc-pane"]')) return;
      const inSearch = target?.getAttribute?.('data-testid') === 'docs-search';
      if (inSearch ? key !== 'ArrowDown' : /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') || target?.isContentEditable) return;
      if (inSearch) target?.blur();
      const hit = k.visible.find((h) => h.doc.key === k.cursor);
      if (key === 'ArrowDown' || key === 'ArrowUp') return e.preventDefault(), void k.step(key === 'ArrowDown' ? 1 : -1);
      // A focused button's own Enter presses it (not the cursor's row as well); while picking, Enter opens nothing.
      if (key === 'Enter' && target?.closest?.('button, [role="button"], [role="checkbox"], a')) return;
      if (key === 'Enter' && hit && !k.split && !k.selected) return e.preventDefault(), void openDoc(hit.doc, undefined, '').catch(fail);
      if (key === ' ' && hit && !k.split) return e.preventDefault(), setLook(hit.doc);
      const gone = k.selected ? k.picked : hit ? [hit.doc] : [];
      if (((mod && key === 'Backspace') || key === 'Delete') && k.deletable(gone)) return e.preventDefault(), void k.remove(gone);
    };
    // The search field keeps its keys from bubbling (react-native-web's TextInput): its own are taken on the way in.
    const onSearchKey = (e: KeyboardEvent) => (e.target as HTMLElement | null)?.getAttribute?.('data-testid') === 'docs-search' && onKey(e);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSearchKey, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSearchKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `say` is the screen's notice (stable enough); the rest is read from `keys`.
  }, [focused]);
  // The row with the cursor stays in sight.
  useEffect(() => {
    if (Platform.OS !== 'web' || !cursor) return;
    document.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor]);

  const byKey = (keys: string[]) => keys.map((k) => all.find((d) => d.key === k)).filter((d): d is IndexedDoc => !!d);
  const menuItems = (h: Hit): MenuItem[] => {
    const d = h.doc;
    const editable = d.place.kind === 'folder' && folders.canEdit(d.place.root, d.place.entry);
    return [
      { key: 'ctx-open', icon: 'documents', label: t.ctxOpen, onPress: () => void openDoc(d, undefined, '').catch(fail) },
      // Windows and keys where there is a mouse (not on a phone or tablet).
      ...(finePointer() ? [{ key: 'ctx-window', icon: 'copy' as IconName, label: t.ctxWindow, onPress: () => void openInWindow(d).catch(fail) }] : []),
      ...(!split ? [{ key: 'ctx-look', icon: 'search' as IconName, label: t.ctxLook, hint: finePointer() ? t.keySpace : undefined, onPress: () => setLook(d) }] : []),
      { key: 'ctx-details', icon: 'tag', label: t.ctxDetails, onPress: () => setMany([d]) },
      ...(folders.canShare ? [{ key: 'ctx-share', icon: 'share' as IconName, label: t.share, onPress: () => void batch(() => shareAll([d])) }] : []),
      ...(editable ? [{ key: 'ctx-rename', icon: 'pencil' as IconName, label: t.rename, onPress: () => void rename(d) }] : []),
      // Not a long press: picked as it says, whatever was pressed just before.
      { key: 'ctx-select', icon: 'select', label: t.ctxSelect, onPress: () => setSelected((sel) => new Set([...(sel ?? []), d.key])) },
      ...(deletable([d]) ? [{ key: 'ctx-delete', icon: 'trash' as IconName, label: onlyHere([d]) ? t.remove : t.delete, hint: shortcut('⌫'), onPress: () => void remove([d]) }] : []),
    ];
  };
  // Documents dropped on the Tag chip: the tag chosen there (else asked for) added to each.
  const tagDropped = async (keys: string[]) => {
    const docs = byKey(keys);
    if (!docs.length) return;
    // Asked each time (the tag filtered by, to start with): those shown have that one already.
    const tag = (await ask({ title: t.tagDocs(docs.length), input: filter.tag ?? '', placeholder: t.tagName, confirm: t.save }))?.trim();
    if (!tag) return;
    const { failed, changed } = await writeDetailsMany(docs, { add: [tag] });
    say(failed ? t.detailsManyFailed(failed) : changed ? t.detailsManySaved(changed) : t.detailsManyNone);
  };

  // ⌘K: documents by title, what to filter by, and every action of the screen.
  const paletteItems = (): PaletteItem[] => [
    ...(scanSupported ? [{ key: 'act-scan', icon: 'camera' as IconName, label: t.addCamera, hint: shortcut('N'), run: () => void startScan() }] : []),
    { key: 'act-files', icon: 'plus' as IconName, label: t.addFiles, run: () => void addFiles(improveAdded) },
    { key: 'act-settings', icon: 'settings' as IconName, label: t.settings, run: () => router.push('/settings') },
    ...moreItems.map((a) => ({ key: `act-${a.key}`, icon: a.icon, label: a.label, run: a.onPress })),
    ...FACETS.flatMap((f) =>
      counts[f].map((c) => ({ key: `facet-${f}-${c.value}`, icon: facetIcon[f], label: c.value, hint: `${facetName[f]} · ${c.count}`, run: () => setFilter({ ...filter, [f]: c.value }) })),
    ),
    ...base.map((h) => ({
      key: `doc-${h.doc.key}`,
      icon: 'documents' as IconName,
      label: realTitle(h.doc.title) || h.doc.name.replace(/\.pdf$/i, ''),
      hint: h.doc.sender || undefined,
      run: () => {
        usePane.setState({ cursor: h.doc.key });
        void openDoc(h.doc, undefined, '').catch(fail);
      },
    })),
  ];

  // More rows as the end of the list comes near (no button to press).
  const more = shown.length > limit;
  const onScroll = ({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (more && contentOffset.y + layoutMeasurement.height > contentSize.height - AHEAD) setLimit((l) => Math.max(l, visible.length + PAGE));
  };

  return (
    <AppFrame tab="documents">
      <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={split ? [styles.list, { borderColor: p.hairline }] : { flex: 1 }}>
      <ScrollView
        testID="docs-scroll"
        style={{ flex: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: bottom }}
      >
        <View style={{ width: column }}>
          {/* While picking, the bar with the count stays over the top (below); the header stays in its place under it. */}
          <AppHeader tab="documents">
            <LayoutToggle />
            {onlyMore || (!split && winWidth >= EXPAND_MORE) ? (
              // A wide window has room for each of them: one click, no ⋯ menu.
              moreItems.map((it) => <IconButton key={it.key} testID={it.key} icon={it.icon} label={it.label} onPress={it.onPress} />)
            ) : (
              moreItems.length > 1 && <IconButton testID="docs-more" icon="more" label={t.more} onPress={() => showActions(t.more, moreItems)} />
            )}
          </AppHeader>

          <View style={[styles.search, { backgroundColor: p.hairline }]}>
            <Icon name="search" size={16} color={p.muted} />
            <TextInput
              testID="docs-search"
              value={query}
              onChangeText={(text) => {
                if (!query.trim() && text.trim()) setBestFirst(true);
                // A new search starts afresh (an answer from long ago isn't shown while it runs).
                if (text.trim().length < 2) setFound(null);
                setQuery(text);
                setLimit(PAGE);
              }}
              placeholder={t.documentsSearch}
              accessibilityLabel={t.documentsSearch}
              placeholderTextColor={p.muted}
              style={[styles.searchInput, { color: p.ink }]}
            />
            {!!query && (
              <IconButton
                icon="close"
                size={32}
                label={t.clearSearch}
                onPress={() => {
                  setQuery('');
                  setFound(null);
                }}
              />
            )}
          </View>

          {nothing ? (
            running ? (
              <Empty reading={t.readingDocs(done, total)} />
            ) : (
              <View style={{ gap: space.lg, alignItems: 'center' }}>
                <EmptyLibrary onAdd={async () => void openFiles(await pickPdfs())} onSample={async () => void openFiles([await sampleItem()])} />
              </View>
            )
          ) : !ready && !searching ? (
            <ActivityIndicator color={p.muted} style={{ marginTop: space.xl }} />
          ) : (
          <>
          {/* What waits for a look: the inbox, and documents being read. */}
          {archive && inboxHere && inboxCount > 0 && (
            <Pressable testID="inbox-review" accessibilityRole="link" onPress={() => router.push('/inbox')} style={[styles.waiting, { backgroundColor: p.mark, borderColor: p.markRing }]}>
              <Icon name="inbox" size={16} color={p.ink} />
              <T v="label" style={{ flex: 1 }}>
                {t.toReview(inboxCount)}
              </T>
              <Icon name="chevronRight" size={16} color={p.muted} />
            </Pressable>
          )}
          {(intake || intakeSaid) && (
            <View testID="intake" style={[styles.waiting, { borderColor: p.hairline }]}>
              {intake ? <ActivityIndicator size="small" color={p.muted} /> : <Icon name="check" size={16} color={p.muted} />}
              <T v="caption" color={p.muted} numberOfLines={1} style={{ flex: 1 }}>
                {intake ? t.intakeReading(intake.name, intake.done, intake.total) : intakeSaid}
              </T>
              {!intake && <IconButton icon="close" size={28} label={t.dismiss} onPress={() => useIntake.setState({ said: null })} />}
            </View>
          )}

          {/* One row (several beside a document: the list is narrow there): the filters (first: always in reach), sync issues, and the saved views. */}
          <ChipRow wrap={split}>
            {roomy ? (
              // Room for every filter: each one click away (those without values in these documents left out).
              <>
                {FACETS.filter((f) => counts[f].length > 0 || filter[f]).map((f) => (
                  <Chip
                    key={f}
                    testID={`facet-${f}`}
                    icon={facetIcon[f]}
                    label={filter[f] ?? facetName[f]}
                    on={!!filter[f]}
                    more
                    onPress={() => choose(f)}
                    onDropDocs={f === 'tag' ? (keys) => void tagDropped(keys) : undefined}
                  />
                ))}
                {active > 0 && <Chip testID="facet-clear" icon="close" label={t.clearFilters} onPress={() => setFilter({})} />}
              </>
            ) : (
              <Chip testID="docs-filter" icon="tag" label={t.filter} count={active} onPress={openFilters} />
            )}
            {syncIssues > 0 && <Chip testID="sync-banner" icon="sync" label={t.syncIssues(syncIssues)} onPress={() => router.push('/sync')} />}
            {!roomy &&
              FACETS.filter((f) => filter[f]).map((f) => <Chip key={f} testID={`facet-${f}`} label={filter[f]!} on onPress={() => choose(f)} />)}
            {views.map((v) => {
              const on = v === current;
              return (
                <Pressable
                  key={v.id}
                  testID="view-chip"
                  accessibilityRole="button"
                  aria-pressed={on}
                  onPress={() => (on ? viewActions(v) : apply(v))}
                  onLongPress={() => viewActions(v)}
                  style={[styles.chip, { backgroundColor: on ? p.ink : p.surface, borderColor: on ? p.ink : p.hairline }]}
                >
                  <T v="label" color={on ? p.canvas : p.ink}>
                    {v.name}
                  </T>
                </Pressable>
              );
            })}
            {canSave && (
              <Pressable testID="save-view" accessibilityRole="button" onPress={save} style={[styles.chip, { borderColor: p.hairline, borderStyle: 'dashed' }]}>
                <Icon name="plus" size={15} color={p.accent} />
                <T v="label" color={p.accent}>
                  {t.saveView}
                </T>
              </Pressable>
            )}
          </ChipRow>

          {/* The count, and the order beside it (a long press on a row picks documents). */}
          <View style={styles.countRow}>
            <T v="kicker" color={p.muted} testID="docs-count" numberOfLines={1}>
              {pending && !shown.length ? '' : t.documentsCount(shown.length)}
            </T>
            <View style={styles.countTools}>
              <SortChip testID="docs-sort" label={byRelevance ? t.sortRelevance : sortName[sort]} up={byRelevance ? undefined : ascending(sort, reverse)} onPress={chooseSort} onTurn={() => setReverse((r) => !r)} />
            </View>
          </View>
          {shown.length > 0 ? (
            <DocList layout={layout} gap={grid.gap}>
              {visible.map((h, i) => (
                <HitRow
                  key={h.doc.key}
                  hit={h}
                  query={searching ? q : ''}
                  layout={layout}
                  width={grid.tile}
                  first={i === 0}
                  last={i === visible.length - 1}
                  size={!byRelevance && sort === 'size'}
                  selected={selected ? selected.has(h.doc.key) : undefined}
                  onSelect={() => hold(h.doc.key)}
                  onToggle={() => tap(h.doc.key)}
                  onError={say}
                  onMenu={(at) => setMenu({ at, hit: h })}
                  drag={{
                    type: DOCS_TYPE,
                    // A row picked carries all the picked ones.
                    keys: () => (selected?.has(h.doc.key) ? picked.map((d) => d.key) : [h.doc.key]),
                    file: () => dragFile(h.doc.key),
                    prepare: () => prepareDrag(h.doc),
                  }}
                />
              ))}
            </DocList>
          ) : pending ? (
            <ActivityIndicator color={p.muted} />
          ) : (
            <T color={p.muted}>{t.documentsEmpty}</T>
          )}
          {more && <ActivityIndicator testID="docs-loading" color={p.muted} style={{ marginTop: space.md }} />}
          </>
          )}
          {/* AGPL §13: where the source is. */}
          <Pressable
            accessibilityRole="link"
            onPress={() => Linking.openURL(SOURCE_URL)}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.colophon, { opacity: hovered ? 1 : 0.7 }]}
          >
            <T v="caption" color={p.muted} style={{ textAlign: 'center' }}>
              {t.colophon}
            </T>
          </Pressable>
        </View>
      </ScrollView>
      {selected && (
        <View style={[styles.stickyBar, { paddingTop: insets.top + space.lg, backgroundColor: p.canvas, borderColor: p.hairline }]}>
          <View style={{ width: column }}>
            <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(shown.map((h) => h.doc.key)))} />
          </View>
        </View>
      )}
      {selected && (
        <ActionBar bottom={insets.bottom} side={space.xl - 4}>
          {folders.canShare && <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length} onPress={() => void batch(() => shareAll(picked))} />}
          <Action
            testID="act-rename"
            icon="pencil"
            label={t.rename}
            disabled={picked.length !== 1 || picked[0].place.kind !== 'folder' || !folders.canEdit(picked[0].place.root, picked[0].place.entry)}
            onPress={() => void rename()}
          />
 <Action testID="act-details" icon="tag" label={t.details} disabled={!picked.length} onPress={() => setMany(picked)} />
          <Action testID="act-delete" icon="trash" label={onlyHere(picked) ? t.remove : t.delete} disabled={!deletable(picked)} onPress={() => void remove()} />
        </ActionBar>
      )}
      {/* Add: the camera or files, into the Tessel folder. */}
      {!selected && (
        <Pressable
          testID="add-menu"
          accessibilityRole="button"
          accessibilityLabel={t.addTitle}
          onPress={() => addMenu()}
          style={[styles.fab, { backgroundColor: p.accent, bottom: insets.bottom + space.xl, right: space.xl }]}
        >
          <Icon name="plus" size={26} color={p.canvas} />
        </Pressable>
      )}
      <Toast message={notice} id={noticeId} onDismiss={dismiss} action={action} above={selected ? BAR_ROOM : 0} />
      </View>
      {split && (
        <View style={{ flex: 1 }} testID="doc-pane">
          {pane ? (
            <ReadView key={pane.id} id={pane.id} page={pane.page} q={pane.q} onClose={closePane} />
          ) : (
            <View style={styles.paneEmpty}>
              <Icon name="documents" size={36} color={p.hairline} />
              <T v="label" color={p.muted}>
                {t.paneEmpty}
              </T>
            </View>
          )}
        </View>
      )}
      {look && (
        <QuickLook
          doc={look}
          onClose={() => setLook(null)}
          onStep={(dir) => {
            const next = step(dir, look.key);
            if (next) setLook(next.doc);
          }}
          onOpen={() => {
            setLook(null);
            void openDoc(look, undefined, '').catch(fail);
          }}
        />
      )}
      {palette && <Palette items={paletteItems()} onClose={() => setPalette(false)} />}
      {menu && <MoreMenu palette={p} at={menu.at} items={menuItems(menu.hit)} onClose={() => setMenu(null)} />}
      {many && (
        <ManyDetails
          key={many.map((d) => d.key).join()}
          docs={many}
          onClose={() => setMany(null)}
          onDone={(message) => {
            setMany(null);
            setSelected(null);
            say(message);
          }}
        />
      )}
      </View>
    </AppFrame>
  );
}

/** No documents yet: where they come from, or how far reading them has got. */
function Empty({ reading, onAdd }: { reading: string | null; onAdd?: () => void }) {
  const p = usePalette();
  return (
    <View testID="docs-empty" style={styles.empty}>
      <T style={{ fontFamily: fonts.sansSemi, fontSize: 18 }}>{reading ? t.readingDocsTitle : t.documentsNoneTitle}</T>
      <T color={p.muted} style={{ textAlign: 'center', maxWidth: 420 }}>
        {reading ?? t.documentsNone}
      </T>
      {!reading && onAdd && <Button testID="docs-add-folder" icon="folderAdd" label={t.addFolder} onPress={onAdd} />}
    </View>
  );
}

/** The chips in one line that scrolls sideways, or (`wrap`) in as many lines as they need. */
function ChipRow({ wrap, children }: { wrap: boolean; children: ReactNode }) {
  if (wrap) return <View style={styles.chips} testID="views">{children}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexWrap: 'nowrap' }]} testID="views">
      {children}
    </ScrollView>
  );
}

/** A small pill: somewhere to go (the inbox, sync issues), the filter button, or a filter in use. */
function Chip({
  testID,
  icon,
  label,
  count,
  on,
  more,
  onPress,
  onDropDocs,
}: {
  testID: string;
  icon?: IconName;
  label: string;
  count?: number;
  on?: boolean;
  more?: boolean;
  onPress: () => void;
  /** Documents dragged from the list and dropped here (web). */
  onDropDocs?: (keys: string[]) => void;
}) {
  const p = usePalette();
  const ref = useRef<View>(null);
  const [over, setOver] = useState(false);
  const dropped = useRef(onDropDocs);
  useEffect(() => {
    dropped.current = onDropDocs;
  });
  const target = !!onDropDocs;
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !target || !node) return;
    const ours = (e: DragEvent) => !!e.dataTransfer?.types.includes(DOCS_TYPE);
    const enter = (e: DragEvent) => ours(e) && (e.preventDefault(), setOver(true));
    const leave = () => setOver(false);
    const drop = (e: DragEvent) => {
      setOver(false);
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const keys = JSON.parse(e.dataTransfer!.getData(DOCS_TYPE) || '[]') as string[];
      if (keys.length) dropped.current?.(keys);
    };
    node.addEventListener('dragenter', enter);
    node.addEventListener('dragover', enter);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    return () => {
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragover', enter);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    };
  }, [target]);
  return (
    <Pressable
      ref={ref}
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.chip, { backgroundColor: on || over ? p.mark : 'transparent', borderColor: on || over ? p.markRing : p.hairline }]}
    >
      {icon && <Icon name={icon} size={15} color={p.ink} />}
      <T v="label" color={p.ink} numberOfLines={1} style={{ maxWidth: 200 }}>
        {label}
      </T>
      {!!count && (
        <T v="label" color={p.accent} style={{ fontFamily: fonts.sansSemi }}>
          {count}
        </T>
      )}
      {(!icon || more) && <Icon name="chevronDown" size={14} color={p.muted} />}
    </Pressable>
  );
}


const styles = StyleSheet.create({
  // The select bar over the top of the list while picking, wherever it is scrolled to.
  list: { width: LIST_W, borderRightWidth: StyleSheet.hairlineWidth },
  paneEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  stickyBar: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  fab: { position: 'absolute', width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  // Clear of + on either side, wherever the list ends.
  colophon: { alignSelf: 'center', marginTop: space.xxl, marginHorizontal: 56 + space.lg, paddingVertical: space.sm },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, paddingLeft: space.md, minHeight: 44 },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 16, paddingVertical: space.sm, outlineStyle: 'none' } as object,
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36 },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xxxl, paddingHorizontal: space.lg },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 40, marginTop: space.md },
  countRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs, marginTop: space.lg, marginBottom: space.sm, minHeight: 32 },
  countTools: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto' },
});
