import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ascending, FACETS, facetCounts, matches, placeOf, SORTS, sortDocs, WHERES, type Facet, type Filter, type SavedView, type Sort, type Where } from '@/paper/archive/facets';
import { allDocs, refreshSoon, searchAll, snippetsFor, useIndex, warmSearch } from '@/paper/archive/indexer';
import { HitRow, importFromFolder } from '@/paper/archive/Results';
import { duplicateGroups } from '@/paper/archive/duplicates';
import { dropOldState } from '@/paper/archive/dirs';
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
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { fonts, radius, space } from '@/core/design/tokens';
import { opError, t } from '@/core/i18n';
import { useThrottled } from '@/core/lib/useThrottled';
import { showActions } from '@/paper/state/actions';
import { ask } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';
import { folders } from '@/core/lib/folders';
import { useLibrary, type ImportItem } from '@/paper/state/library';
import { EmptyLibrary } from '@/paper/components/EmptyLibrary';
import { pickPdfs, sampleItem } from '@/paper/state/pick';
import { useInstall } from '@/core/lib/install';
import { repo, type DocRecord } from '@/core/storage';
import { useCache } from '@/paper/state/cache';
import { refreshInboxCount, useInboxCount } from '@/paper/archive/inbox';

const newViewId = () => `v-${Date.now().toString(36)}`;

/** AGPL §13: offer the source to network users. */
const SOURCE_URL = 'https://github.com/jibes/doc-reader';

function openRecord(doc: DocRecord) {
  // A linked file may need the browser's OK again (after a restart); ask while the tap still counts as a gesture.
  const ready = doc.linked ? repo.requestAccess(doc.id).catch(() => false) : Promise.resolve(true);
  ready.then(() => router.push({ pathname: '/read/[id]', params: { id: doc.id } }));
}

/** Rows shown at first, and added each time the list is scrolled near its end. */
const PAGE = 100;
/** While indexing, the list and the search are read again at most this often. */
const REFRESH_MS = 1500;

const facetName: Record<Facet, string> = { tag: t.facetTag, sender: t.facetSender, type: t.facetType, year: t.facetYear };
const facetIcon: Record<Facet, IconName> = { tag: 'tag', sender: 'person', type: 'pages', year: 'calendar' };

const sortName: Record<Sort, string> = { opened: t.sortOpened, date: t.sortDate, name: t.sortName, size: t.sortSize };
/** How close to the end of the list (in points) the next rows are added. */
const AHEAD = 1500;

const asHit = (doc: IndexedDoc): Hit => ({ doc, score: 0, page: 0, snippet: null });
const isEmpty = (f: Filter) => FACETS.every((k) => !f[k]);
/** What the screen shows: the search, filters and place, and the order. */
type Showing = { query: string; filter: Filter; sort: Sort; reverse: boolean; place: Where; relevance: boolean };
/** Views from before the order was kept: a search by date was best matches first. */
const byRelevanceIn = (v: SavedView) => !!v.query && (v.relevance ?? v.sort === 'date');
const sameView = (v: SavedView, s: Showing) =>
  v.query === s.query &&
  (v.place ?? 'tessel') === s.place &&
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
  const syncIssues = useIndex((s) => s.conflicts.length + s.duplicates);
  const mainWidth = useMainWidth();
  // Tessel's own documents, or the sources it reads (one at a time: a scope, not a filter).
  const [place, setPlace] = useState<Where>('tessel');
  useEffect(() => void refreshInboxCount(), []);
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
      ...(scanSupported ? [{ key: 'add-camera', icon: 'camera' as IconName, label: t.addCamera, onPress: () => router.push('/scan') }] : []),
      { key: 'add-files', icon: 'documents' as IconName, label: t.addFiles, onPress: () => void addFiles(aiSet && ai) },
      ...(aiSet ? [{ key: 'add-ai', icon: (ai ? 'check' : 'textView') as IconName, label: ai ? t.addAiOn : t.addAiOff, onPress: () => addMenu(!ai) }] : []),
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
  const openedAt = useMemo(() => {
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

  const [all, setAll] = useState<IndexedDoc[]>([]);
  // Until the index has answered once, nothing is known (not "no documents").
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    allDocs().then((d) => {
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
    return hits.filter((h) => placeOf(h.doc, archive) === place);
  }, [searching, found, all, sort, reverse, bestFirst, place, archive, openedAt]);
  // A search says what the other side has (the scope isn't a place to forget).
  const elsewhere = useMemo(() => (searching && found ? found.hits.filter((h) => placeOf(h.doc, archive) !== place && matches(h.doc, filter)).length : 0), [searching, found, place, archive, filter]);
  const doubled = useMemo(() => {
    const inTessel = (d: IndexedDoc) => placeOf(d, archive) === 'tessel';
    return duplicateGroups(all, inTessel).length;
  }, [all, archive]);
  const hasSources = useMemo(() => place === 'sources' || all.some((d) => placeOf(d, archive) === 'sources'), [all, place, archive]);
  // Everything else, one step away: the inbox, the trash, sync issues, the rules, installing the app.
  const moreItems = [
      ...(archive && inboxHere ? [{ key: 'more-inbox', icon: 'inbox' as IconName, label: inboxCount ? t.inboxWaiting(inboxCount) : t.inboxTitle, onPress: () => router.push('/inbox') }] : []),
      ...(archive ? [{ key: 'more-trash', icon: 'trash' as IconName, label: t.trashTitle, onPress: () => router.push('/trash') }] : []),
      ...(doubled > 0 ? [{ key: 'more-duplicates', icon: 'copy' as IconName, label: t.duplicatesN(doubled), onPress: () => router.push('/duplicates') }] : []),
      ...(syncIssues > 0 ? [{ key: 'more-sync', icon: 'copy' as IconName, label: t.syncIssues(syncIssues), onPress: () => router.push('/sync') }] : []),
      ...(archive ? [{ key: 'more-rules', icon: 'tag' as IconName, label: t.rulesTitle, onPress: () => router.push('/rules') }] : []),
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
    setPlace(v.place ?? 'tessel');
    setBestFirst(byRelevanceIn(v));
    setLimit(PAGE);
  };
  const current = views.find((v) => sameView(v, { query: q, filter, sort, reverse, place, relevance: byRelevance }));
  const canSave = !current && (!!q || !isEmpty(filter) || place !== 'tessel');
  // Settings that couldn't be read say so; anything else, that it wasn't saved.
  const viewFailed = (e: unknown) => say(e instanceof Error && e.message === t.settingsUnreadable ? e.message : t.viewFailed);

  const save = async () => {
    const suggested = [place !== 'tessel' ? placeName(place) : '', ...FACETS.map((f) => filter[f]), q].filter(Boolean).join(' · ');
    const name = (await ask({ title: t.saveView, input: suggested, placeholder: t.viewName, confirm: t.saveView }))?.trim();
    if (!name) return;
    const view: SavedView = { id: newViewId(), name, query: q, filter, sort, ...(reverse ? { reverse } : {}), ...(place !== 'tessel' ? { place } : {}), ...(q ? { relevance: byRelevance } : {}) };
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
  const scopeTo = (pl: Where) => {
    setPlace(pl);
    setSelected(null);
    setLimit(PAGE);
  };
  // Room for the action bar while picking.
  // Nothing indexed yet (and not searching): what to do instead of an empty list with its filters.
  const nothing = ready && all.length === 0 && !searching;
  const layout = useLayout();
  const column = columnWidth(mainWidth);
  const grid = gridOf(column);
  // Room for the Add button (and the action bar while picking).
  const bottom = insets.bottom + space.xxxl + 56 + (selected ? 72 : 0);

  const picked = selected ? shown.filter((h) => selected.has(h.doc.key)).map((h) => h.doc) : [];
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
  // A source's documents kept: copied into the Tessel folder, as anything added is.
  const keep = () =>
    batch(async () => {
      const added = [];
      for (const d of picked) if (d.place.kind === 'folder') added.push(await importFromFolder(d.place, true));
      const kept = added.filter((x) => !!x);
      readAdded(kept);
      return t.keptN(kept.length);
    });
  const rename = async () => {
    const d = picked[0];
    // The list shows titles, the dialog the file's name: it says which one changes (a title is changed in Details).
    const titled = !!d.title && d.title !== d.name.replace(/\.pdf$/i, '');
    const name = (await ask({ title: t.renameFile, body: titled ? t.renameFileBody(d.title) : undefined, input: d.name.replace(/\.pdf$/i, ''), placeholder: t.newName, confirm: t.rename }))?.trim();
    if (!name) return;
    await batch(() => renameDoc(d, name));
  };
  // Documents only in this library leave it (as on Reading); files are deleted.
  const onlyHere = (list: IndexedDoc[]) => list.length > 0 && list.every((d) => d.place.kind === 'library');
  const remove = async () => {
    const list = picked;
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
      const { trashed, settle } = await deleteAll(list);
      dropShown(new Set(list.map((d) => d.key)));
      const n = trashed.reduce((k, g) => k + g.items.length, 0);
      if (n && n === list.length) {
        say(t.trashedN(n), { undo: () => void undoDelete(trashed).catch((e) => say(opError(e))), settle });
        return;
      }
      settle();
      return onlyHere(list) ? t.removedN(list.length) : t.deletedN(list.length);
    });
  };

  // More rows as the end of the list comes near (no button to press).
  const more = shown.length > limit;
  const onScroll = ({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (more && contentOffset.y + layoutMeasurement.height > contentSize.height - AHEAD) setLimit((l) => Math.max(l, visible.length + PAGE));
  };

  return (
    <AppFrame tab="documents">
      <ScrollView
        testID="docs-scroll"
        style={{ flex: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={100}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: bottom }}
      >
        <View style={{ width: column }}>
          {selected ? (
            <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(shown.map((h) => h.doc.key)))} />
          ) : (
            <AppHeader tab="documents">
              <IconButton testID="add" icon="documents" label={t.openFile} onPress={async () => void openFiles(await pickPdfs())} />
              <LayoutToggle />
              {onlyMore ? (
                <IconButton testID={onlyMore.key} icon={onlyMore.icon} label={onlyMore.label} onPress={onlyMore.onPress} />
              ) : (
                moreItems.length > 1 && <IconButton testID="docs-more" icon="more" label={t.more} onPress={() => showActions(t.more, moreItems)} />
              )}
            </AppHeader>
          )}

          {hasSources && (
            <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: p.hairline }]}>
              {WHERES.map((pl) => (
                <Pressable key={pl} testID={`scope-${pl}`} role="radio" aria-checked={place === pl} onPress={() => scopeTo(pl)} style={[styles.segment, place === pl && { backgroundColor: p.raised }]}>
                  <T v="label" color={place === pl ? p.ink : p.muted}>
                    {placeName(pl)}
                  </T>
                </Pressable>
              ))}
            </View>
          )}

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
          {archive && inboxHere && inboxCount > 0 && place === 'tessel' && (
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
          {/* One row: the filters (first: always in reach), sync issues, and the saved views. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexWrap: 'nowrap' }]} testID="views">
            <Chip testID="docs-filter" icon="tag" label={t.filter} count={active} onPress={openFilters} />
            {syncIssues > 0 && <Chip testID="sync-banner" icon="copy" label={t.syncIssues(syncIssues)} onPress={() => router.push('/sync')} />}
            {FACETS.filter((f) => filter[f]).map((f) => (
              <Chip key={f} testID={`facet-${f}`} label={filter[f]!} on onPress={() => choose(f)} />
            ))}
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
          </ScrollView>

          {/* The count, and the order beside it (a long press on a row picks documents). */}
          <View style={styles.countRow}>
            <T v="kicker" color={p.muted} testID="docs-count" numberOfLines={1}>
              {pending && !shown.length ? '' : t.documentsCount(shown.length)}
            </T>
            {elsewhere > 0 && (
              <Pressable testID="scope-other" accessibilityRole="button" onPress={() => scopeTo(place === 'tessel' ? 'sources' : 'tessel')} hitSlop={6}>
                <T v="caption" color={p.accent}>
                  {t.otherSide(elsewhere, placeName(place === 'tessel' ? 'sources' : 'tessel'))}
                </T>
              </Pressable>
            )}
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
            <T v="caption" color={p.muted}>
              {t.colophon}
            </T>
          </Pressable>
        </View>
      </ScrollView>
      {selected && (
        <ActionBar bottom={insets.bottom} side={space.xl - 4}>
          {/* A source's documents are opened, kept, shared or deleted; Tessel's are its own to rename. */}
          {place === 'sources' && <Action testID="act-keep" icon="inbox" label={t.keep} disabled={!picked.length} onPress={() => void keep()} />}
          {folders.canShare && <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length} onPress={() => void batch(() => shareAll(picked))} />}
          {place === 'tessel' && (
            <Action
              testID="act-rename"
              icon="pencil"
              label={t.rename}
              disabled={picked.length !== 1 || picked[0].place.kind !== 'folder' || !folders.canEdit(picked[0].place.root, picked[0].place.entry)}
              onPress={() => void rename()}
            />
          )}
          <Action testID="act-delete" icon="trash" label={onlyHere(picked) ? t.remove : t.delete} disabled={!picked.length || picked.some((d) => d.place.kind === 'folder' && !folders.canEdit(d.place.root, d.place.entry))} onPress={() => void remove()} />
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

/** A small pill: somewhere to go (the inbox, sync issues), the filter button, or a filter in use. */
function Chip({ testID, icon, label, count, on, onPress }: { testID: string; icon?: IconName; label: string; count?: number; on?: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.chip, { backgroundColor: on ? p.mark : 'transparent', borderColor: on ? p.markRing : p.hairline }]}
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
      {!icon && <Icon name="chevronDown" size={14} color={p.muted} />}
    </Pressable>
  );
}

const placeName = (pl: Where) => (pl === 'tessel' ? t.placeTessel : t.placeSources);

const styles = StyleSheet.create({
  fab: { position: 'absolute', width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  colophon: { alignSelf: 'center', marginTop: space.xxl, paddingVertical: space.sm },
  segments: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: radius.pill, gap: 2, marginBottom: space.lg },
  segment: { height: 34, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.pill },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, paddingLeft: space.md, minHeight: 44 },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 16, paddingVertical: space.sm, outlineStyle: 'none' } as object,
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36 },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xxxl, paddingHorizontal: space.lg },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 40, marginTop: space.md },
  countRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs, marginTop: space.lg, marginBottom: space.sm, minHeight: 32 },
  countTools: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto' },
});
