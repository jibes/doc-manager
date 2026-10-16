import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ascending, FACETS, facetCounts, matches, SORTS, sortDocs, WHERES, type Facet, type Filter, type SavedView, type Sort, type Where } from '@/archive/facets';
import { allDocs, refreshSoon, searchAll, snippetsFor, useIndex, warmSearch } from '@/archive/indexer';
import { HitRow } from '@/archive/Results';
import type { Hit, IndexedDoc } from '@/archive/search';
import { loadViews, removeView, saveView, useViews } from '@/archive/views';
import { Icon, type IconName } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { AppFrame, AppHeader, columnWidth, TAB_BAR_H, useDocsView, useMainWidth, useTabBar, useWide } from '@/components/AppNav';
import { DocList, gridOf, LayoutToggle, useLayout } from '@/components/DocItems';
import { SortChip } from '@/components/SortChip';
import { Action, ActionBar, BAR_ROOM, heldNow, justSelected, SelectBar, toggled, useEndPicking } from '@/components/Selection';
import { addToReading, allInFolders, byFolder, deleteAll, deletesForGood, readingAddedText, renameDoc, shareAll, undoDelete } from '@/archive/batch';
import { useClipboard } from '@/state/clipboard';
import { Toast } from '@/components/Toast';
import { useNotice } from '@/components/useNotice';
import { fonts, radius, space } from '@/design/tokens';
import { opError, t } from '@/i18n';
import { useThrottled } from '@/lib/useThrottled';
import { showActions } from '@/state/actions';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';
import { folders } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import { APP_ROOT_ID } from '@/lib/nesting';
import { refreshInboxCount, useInboxCount } from '@/archive/inbox';
import { addFolder, PasteBar, Roots } from './files';

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
type Showing = { query: string; filter: Filter; sort: Sort; reverse: boolean; place?: Where; relevance: boolean };
/** Views from before the order was kept: a search by date was best matches first. */
const byRelevanceIn = (v: SavedView) => !!v.query && (v.relevance ?? v.sort === 'date');
const sameView = (v: SavedView, s: Showing) =>
  v.query === s.query &&
  (v.place ?? null) === (s.place ?? null) &&
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
  const view = useDocsView((s) => s.view);
  const archive = usePrefs((s) => s.archive);
  const inboxHere = usePrefs((s) => s.inboxHere);
  const inboxCount = useInboxCount((s) => s.count);
  const syncIssues = useIndex((s) => s.conflicts.length + s.duplicates);
  const tabBar = useTabBar();
  const wide = useWide();
  const mainWidth = useMainWidth();
  const pasting = useClipboard((s) => !!s.clip);
  const [place, setPlace] = useState<Where | undefined>(undefined);
  // Opened on Folders (from an old Files link), then counted and remembered as the place last used.
  useEffect(() => {
    if (params.view === 'folders') useDocsView.setState({ view: 'folders' });
    usePrefs.getState().set({ lastTab: 'documents' });
    void refreshInboxCount();
  }, [params.view]);
  const [query, setQuery] = useState(params.q ?? '');
  const [filter, setFilter] = useState<Filter>({});
  // Phones open on what was opened lately (what Reading's recent list was); wide windows on the newest.
  const [sort, setSort] = useState<Sort>(() => (SORTS.includes(params.sort as Sort) ? (params.sort as Sort) : wide ? 'date' : 'opened'));
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
    return (d: IndexedDoc) => byKey.get(d.key) ?? (d.share ? byKey.get(`share:${d.share}`) : undefined) ?? byKey.get(`file:${d.name}|${d.size}`);
  }, [library]);
  // Search results come best match first, until another order is chosen for them.
  const [bestFirst, setBestFirst] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const { notice, id: noticeId, say, dismiss, action } = useNotice();
  // Picked documents (by key), while picking: Esc, Back and switching to Folders (here or in the sidebar) end it.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEndPicking(!!selected, setSelected);
  useEffect(() => useDocsView.subscribe((s, was) => s.view !== was.view && setSelected(null)), []);
  const setClip = useClipboard((s) => s.set);
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
    return place ? hits.filter((h) => placeOf(h.doc, archive) === place) : hits;
  }, [searching, found, all, sort, reverse, bestFirst, place, archive, openedAt]);
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
    setPlace(v.place);
    setBestFirst(byRelevanceIn(v));
    setLimit(PAGE);
  };
  const current = views.find((v) => sameView(v, { query: q, filter, sort, reverse, place, relevance: byRelevance }));
  const canSave = !current && (!!q || !isEmpty(filter) || !!place);
  // Settings that couldn't be read say so; anything else, that it wasn't saved.
  const viewFailed = (e: unknown) => say(e instanceof Error && e.message === t.settingsUnreadable ? e.message : t.viewFailed);

  const save = async () => {
    const suggested = [place ? placeName(place) : '', ...FACETS.map((f) => filter[f]), q].filter(Boolean).join(' · ');
    const name = (await ask({ title: t.saveView, input: suggested, placeholder: t.viewName, confirm: t.saveView }))?.trim();
    if (!name) return;
    const view: SavedView = { id: `v-${Date.now().toString(36)}`, name, query: q, filter, sort, ...(reverse ? { reverse } : {}), ...(place ? { place } : {}), ...(q ? { relevance: byRelevance } : {}) };
    saveView(view).then(() => say(t.viewSaved(name)), viewFailed);
  };
  const viewActions = (v: SavedView) =>
    showActions(v.name, [
      { key: 'view-open', icon: 'check', label: t.viewOpen, onPress: () => apply(v) },
      { key: 'view-remove', icon: 'trash', label: t.viewRemove, destructive: true, onPress: () => void removeView(v.id).catch(viewFailed) },
    ]);

  // The filters in use, and all of them in one sheet (those without values in these documents left out).
  const active = (place ? 1 : 0) + FACETS.filter((f) => filter[f]).length;
  const openFilters = () =>
    showActions(t.filter, [
      { key: 'facet-place', icon: 'folder' as IconName, label: `${t.placeFacet}: ${place ? placeName(place) : t.facetAny}`, onPress: choosePlace },
      ...FACETS.filter((f) => counts[f].length > 0 || filter[f]).map((f) => ({
        key: `facet-${f}`,
        icon: facetIcon[f],
        label: `${facetName[f]}: ${filter[f] ?? t.facetAny}`,
        onPress: () => choose(f),
      })),
      ...(active ? [{ key: 'facet-clear', icon: 'close' as IconName, label: t.clearFilters, onPress: () => (setFilter({}), setPlace(undefined)) }] : []),
    ]);
  const choosePlace = () =>
    showActions(t.placeFacet, [
      { key: 'place-any', icon: place ? 'close' : 'check', label: t.facetAny, onPress: () => setPlace(undefined) },
      ...WHERES.map((pl) => ({ key: `place-${pl}`, icon: (place === pl ? 'check' : placeIcon[pl]) as IconName, label: placeName(pl), onPress: () => setPlace(pl) })),
    ]);
  // Room for the action bar while picking.
  // Nothing indexed yet (and not searching): what to do instead of an empty list with its filters.
  const nothing = ready && all.length === 0 && !searching;
  const layout = useLayout();
  const column = columnWidth(mainWidth);
  const grid = gridOf(column);
  const bottom = insets.bottom + space.xxxl + (tabBar ? TAB_BAR_H : 0) + (selected ? 72 : 0);

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
  const clip = (move: boolean) => {
    setClip({ move, items: byFolder(picked) });
    setSelected(null);
    // On to the folders, to open the one they go to.
    useDocsView.setState({ view: 'folders' });
  };
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
  const more = view === 'all' && shown.length > limit;
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
          {selected && view === 'all' ? (
            <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(shown.map((h) => h.doc.key)))} />
          ) : (
            <AppHeader tab="documents">
              <LayoutToggle />
            </AppHeader>
          )}

          {folders.supported && (
            <View accessibilityRole="tablist" style={[styles.segments, { backgroundColor: p.hairline }]}>
              {(['all', 'folders'] as const).map((v) => (
                <Pressable
                  key={v}
                  testID={`docs-${v}`}
                  role="tab"
                  aria-selected={view === v}
                  onPress={() => {
                    setSelected(null);
                    useDocsView.setState({ view: v });
                  }}
                  style={[styles.segment, view === v && { backgroundColor: p.raised }]}
                >
                  <T v="label" color={view === v ? p.ink : p.muted}>
                    {v === 'all' ? t.allView : t.foldersView}
                  </T>
                </Pressable>
              ))}
            </View>
          )}

          {view === 'folders' ? (
            <Roots bottom={0} onError={say} />
          ) : (
          <>

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
            <Empty reading={running ? t.readingDocs(done, total) : null} onAdd={folders.supported ? () => void addFolder(say) : undefined} />
          ) : !ready && !searching ? (
            <ActivityIndicator color={p.muted} style={{ marginTop: space.xl }} />
          ) : (
          <>
          {/* One row: the filters (first: always in reach), what is waiting (the inbox, on phones; sync issues), and the saved views. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexWrap: 'nowrap' }]} testID="views">
            <Chip testID="docs-filter" icon="tag" label={t.filter} count={active} onPress={openFilters} />
            {archive && inboxHere && !wide && <Chip testID="docs-inbox" icon="inbox" label={t.inboxTitle} count={inboxCount} onPress={() => router.push('/inbox')} />}
            {syncIssues > 0 && <Chip testID="sync-banner" icon="copy" label={t.syncIssues(syncIssues)} onPress={() => router.push('/sync')} />}
            {place && <Chip testID="facet-place" label={placeName(place)} on onPress={choosePlace} />}
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
          {more && <ActivityIndicator testID="docs-more" color={p.muted} style={{ marginTop: space.md }} />}
          </>
          )}
          </>
          )}
        </View>
      </ScrollView>
      {selected && view === 'all' && (
        <ActionBar bottom={insets.bottom + (tabBar ? TAB_BAR_H : 0)} side={space.xl - 4}>
          {folders.canShare && <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length} onPress={() => void batch(() => shareAll(picked))} />}
          <Action
            testID="act-reading"
            icon="readingAdd"
            label={t.readingList}
            disabled={!picked.length}
            onPress={() =>
              void batch(async () => {
                return readingAddedText(await addToReading(picked));
              })
            }
          />
          <Action testID="act-copy" icon="copy" label={t.copy} disabled={!allInFolders(picked)} onPress={() => clip(false)} />
          <Action testID="act-move" icon="move" label={t.move} disabled={!allInFolders(picked) || picked.some((d) => d.place.kind === 'folder' && !folders.canEdit(d.place.root, d.place.entry))} onPress={() => clip(true)} />
          <Action
            testID="act-rename"
            icon="pencil"
            label={t.rename}
            disabled={picked.length !== 1 || picked[0].place.kind !== 'folder' || !folders.canEdit(picked[0].place.root, picked[0].place.entry)}
            onPress={() => void rename()}
          />
          <Action testID="act-delete" icon="trash" label={onlyHere(picked) ? t.remove : t.delete} disabled={!picked.length || picked.some((d) => d.place.kind === 'folder' && !folders.canEdit(d.place.root, d.place.entry))} onPress={() => void remove()} />
        </ActionBar>
      )}
      {view === 'folders' && <PasteBar here={null} bottom={insets.bottom + (tabBar ? TAB_BAR_H : 0)} side={space.xl - 4} onDone={() => {}} onError={say} />}
      <Toast message={notice} id={noticeId} onDismiss={dismiss} action={action} above={(tabBar ? TAB_BAR_H : 0) + ((pasting && view === 'folders') || selected ? BAR_ROOM : 0)} />
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

const placeIcon: Record<Where, IconName> = { tessel: 'inbox', sources: 'folder' };
const placeName = (pl: Where) => (pl === 'tessel' ? t.placeTessel : t.placeSources);
/**
 * The Tessel folder is everything Tessel keeps: the folder chosen for it (synced, often), Documents/Tessel on
 * Android, the browser's own storage. Sources are the folders it reads: those added, and the whole device.
 */
const placeOf = (d: IndexedDoc, tessel: string | null): Where =>
  d.place.kind === 'library' || d.place.root === APP_ROOT_ID || d.place.root === tessel ? 'tessel' : 'sources';

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: radius.pill, gap: 2, marginBottom: space.lg },
  segment: { height: 34, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.pill },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, paddingLeft: space.md, minHeight: 44 },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 16, paddingVertical: space.sm, outlineStyle: 'none' } as object,
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36 },
  empty: { alignItems: 'center', gap: space.md, paddingVertical: space.xxxl, paddingHorizontal: space.lg },
  countRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs, marginTop: space.lg, marginBottom: space.sm, minHeight: 32 },
  countTools: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto' },
});
