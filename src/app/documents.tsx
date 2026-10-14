import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FACETS, facetCounts, matches, SORTS, sortDocs, type Facet, type Filter, type SavedView, type Sort } from '@/archive/facets';
import { allDocs, searchAll, useIndex, warmSearch } from '@/archive/indexer';
import { HitRow } from '@/archive/Results';
import type { Hit, IndexedDoc } from '@/archive/search';
import { loadViews, removeView, saveView, useViews } from '@/archive/views';
import { Icon, type IconName } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { AppFrame, AppHeader, TAB_BAR_H, useDocsView, useTabBar } from '@/components/AppNav';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { showActions } from '@/state/actions';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';
import { folders } from '@/lib/folders';
import { refreshInboxCount, useInboxCount } from '@/archive/inbox';
import { Roots } from './files';

const MAX_W = 820;
/** Rows shown at first, and added by "Show more". */
const PAGE = 100;

const facetName: Record<Facet, string> = { tag: t.facetTag, sender: t.facetSender, type: t.facetType, year: t.facetYear };
const facetIcon: Record<Facet, IconName> = { tag: 'tag', sender: 'documents', type: 'pages', year: 'sort' };

const sortName: Record<Sort, string> = { date: t.sortDate, oldest: t.sortOldest, name: t.sortName, size: t.sortSize };

const asHit = (doc: IndexedDoc): Hit => ({ doc, score: 0, page: 0, snippet: null });
const isEmpty = (f: Filter) => FACETS.every((k) => !f[k]);
const sameView = (v: SavedView, query: string, filter: Filter, sort: Sort) =>
  v.query === query.trim() && v.sort === sort && FACETS.every((k) => (v.filter[k] ?? '') === (filter[k] ?? ''));

/**
 * Every document in the library and the folders: searched, narrowed by tag, sender, type and year, sorted, and
 * kept as named views (in the archive folder, so the other devices have them too).
 */
export default function Documents() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; view?: string }>();
  const view = useDocsView((s) => s.view);
  const archive = usePrefs((s) => s.archive);
  const inboxHere = usePrefs((s) => s.inboxHere);
  const inboxCount = useInboxCount((s) => s.count);
  const syncIssues = useIndex((s) => s.conflicts.length + s.duplicates);
  const tabBar = useTabBar();
  const [place, setPlace] = useState<Place | undefined>(undefined);
  // Opened on Folders (from an old Files link), then counted and remembered as the place last used.
  useEffect(() => {
    if (params.view === 'folders') useDocsView.setState({ view: 'folders' });
    usePrefs.getState().set({ lastTab: 'documents' });
    void refreshInboxCount();
  }, [params.view]);
  const [query, setQuery] = useState(params.q ?? '');
  const [filter, setFilter] = useState<Filter>({});
  const [sort, setSort] = useState<Sort>('date');
  // Search results come best match first, until another order is chosen for them.
  const [bestFirst, setBestFirst] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const { count, done } = useIndex();
  const views = useViews((s) => s.views);

  const [all, setAll] = useState<IndexedDoc[]>([]);
  useEffect(() => {
    let alive = true;
    allDocs().then((d) => alive && setAll(d.filter((x) => !x.failed)));
    return () => {
      alive = false;
    };
    // Read again as indexing adds documents.
  }, [count, done]);

  useEffect(() => {
    loadViews().catch(() => {});
    // The search index is built ahead, so the first search answers at once.
    warmSearch();
  }, []);

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
  }, [q, done]);

  // With a query, best matches first; without, every document by date or name.
  const base = useMemo(() => {
    const answer = found?.query === q ? found.hits : [];
    const hits = searching ? (bestFirst ? answer : sortDocs(answer, sort, (h) => h.doc)) : sortDocs(all, sort).map(asHit);
    return place ? hits.filter((h) => placeOf(h.doc, archive) === place) : hits;
  }, [searching, found, q, all, sort, bestFirst, place, archive]);
  const counts = useMemo(() => facetCounts(base.map((h) => h.doc), filter), [base, filter]);
  const shown = useMemo(() => base.filter((h) => matches(h.doc, filter)), [base, filter]);

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
          setSort(s);
          setBestFirst(false);
        },
      })),
    ]);

  const apply = (v: SavedView) => {
    setQuery(v.query);
    setFilter(v.filter);
    setSort(v.sort);
    setBestFirst(!!v.query && v.sort === 'date');
    setLimit(PAGE);
  };
  const current = views.find((v) => sameView(v, query, filter, sort));
  const canSave = !current && (!!q || !isEmpty(filter));

  const save = async () => {
    const suggested = [...FACETS.map((f) => filter[f]).filter(Boolean), q].filter(Boolean).join(' · ');
    const name = (await ask({ title: t.saveView, input: suggested, placeholder: t.viewName, confirm: t.saveView }))?.trim();
    if (!name) return;
    const view: SavedView = { id: `v-${Date.now().toString(36)}`, name, query: q, filter, sort };
    saveView(view).then(
      () => setNotice(t.viewSaved(name)),
      () => setNotice(t.viewFailed),
    );
  };
  const viewActions = (v: SavedView) =>
    showActions(v.name, [
      { key: 'view-open', icon: 'check', label: t.viewOpen, onPress: () => apply(v) },
      { key: 'view-remove', icon: 'trash', label: t.viewRemove, destructive: true, onPress: () => void removeView(v.id).catch(() => setNotice(t.viewFailed)) },
    ]);

  const choosePlace = () =>
    showActions(t.placeFacet, [
      { key: 'place-any', icon: place ? 'close' : 'check', label: t.facetAny, onPress: () => setPlace(undefined) },
      ...PLACES.map((pl) => ({ key: `place-${pl}`, icon: (place === pl ? 'check' : placeIcon[pl]) as IconName, label: placeName(pl), onPress: () => setPlace(pl) })),
    ]);
  const bottom = insets.bottom + space.xxxl + (tabBar ? TAB_BAR_H : 0);

  return (
    <AppFrame tab="documents">
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: bottom }}
      >
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl - 4 }}>
          <AppHeader tab="documents" />

          {folders.supported && (
            <View accessibilityRole="tablist" style={[styles.segments, { backgroundColor: p.hairline }]}>
              {(['all', 'folders'] as const).map((v) => (
                <Pressable
                  key={v}
                  testID={`docs-${v}`}
                  role="tab"
                  aria-selected={view === v}
                  onPress={() => useDocsView.setState({ view: v })}
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
            <Roots bottom={0} />
          ) : (
          <>

          <View style={[styles.search, { backgroundColor: p.hairline }]}>
            <Icon name="search" size={16} color={p.muted} />
            <TextInput
              testID="docs-search"
              value={query}
              onChangeText={(text) => {
                if (!query.trim() && text.trim()) setBestFirst(true);
                setQuery(text);
                setLimit(PAGE);
              }}
              placeholder={t.documentsSearch}
              placeholderTextColor={p.muted}
              style={[styles.searchInput, { color: p.ink }]}
            />
            {!!query && <IconButton icon="close" size={32} label={t.cancel} onPress={() => setQuery('')} />}
          </View>

          {archive && inboxHere && (
            <Row testID="docs-inbox" icon="inbox" label={t.inboxTitle} count={inboxCount} onPress={() => router.push('/inbox')} />
          )}
          {syncIssues > 0 && <Row testID="sync-banner" icon="copy" label={t.syncBanner(syncIssues)} warn onPress={() => router.push('/sync')} />}

          {(views.length > 0 || canSave) && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexWrap: 'nowrap' }]} testID="views">
              {views.map((v) => {
                const on = v === current;
                return (
                  <Pressable
                    key={v.id}
                    testID="view-chip"
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
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
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { flexWrap: 'nowrap' }]}>
            <Pressable
              testID="facet-place"
              accessibilityRole="button"
              accessibilityLabel={place ? `${t.placeFacet}: ${placeName(place)}` : t.placeFacet}
              onPress={choosePlace}
              style={[styles.chip, { backgroundColor: place ? p.mark : 'transparent', borderColor: place ? p.markRing : p.hairline }]}
            >
              <T v="label" color={place ? p.ink : p.inkSoft}>
                {place ? placeName(place) : t.placeFacet}
              </T>
              <Icon name="chevronDown" size={14} color={p.muted} />
            </Pressable>
            {FACETS.map((f) => {
              const value = filter[f];
              return (
                <Pressable
                  key={f}
                  testID={`facet-${f}`}
                  accessibilityRole="button"
                  accessibilityLabel={value ? `${facetName[f]}: ${value}` : facetName[f]}
                  onPress={() => choose(f)}
                  style={[styles.chip, { backgroundColor: value ? p.mark : 'transparent', borderColor: value ? p.markRing : p.hairline }]}
                >
                  <T v="label" color={value ? p.ink : p.inkSoft} numberOfLines={1} style={{ maxWidth: 200 }}>
                    {value ?? facetName[f]}
                  </T>
                  <Icon name="chevronDown" size={14} color={p.muted} />
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.countRow}>
            <T v="kicker" color={p.muted} testID="docs-count" style={{ flex: 1 }}>
              {t.documentsCount(shown.length)}
            </T>
            <Pressable testID="docs-sort" accessibilityRole="button" accessibilityLabel={`${t.sortTitle}: ${byRelevance ? t.sortRelevance : sortName[sort]}`} onPress={chooseSort} hitSlop={8} style={styles.sort}>
              <Icon name="sort" size={15} color={p.inkSoft} />
              <T v="label" color={p.inkSoft}>
                {byRelevance ? t.sortRelevance : sortName[sort]}
              </T>
            </Pressable>
          </View>
          {shown.length > 0 ? (
            <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
              {shown.slice(0, limit).map((h, i) => (
                <HitRow key={h.doc.key} hit={h} query={searching ? q : ''} first={i === 0} size={!byRelevance && sort === 'size'} onError={setNotice} />
              ))}
            </View>
          ) : (
            <T color={p.muted}>{all.length || searching ? t.documentsEmpty : t.documentsNone}</T>
          )}
          {shown.length > limit && (
            <View style={{ flexDirection: 'row', marginTop: space.md }}>
              <Button testID="show-more" kind="quiet" label={t.showMore} onPress={() => setLimit(limit + PAGE)} />
            </View>
          )}
          </>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} above={tabBar ? TAB_BAR_H : 0} />
    </AppFrame>
  );
}

/** A row leading somewhere (the inbox, sync issues). */
function Row({ testID, icon, label, count, warn, onPress }: { testID: string; icon: IconName; label: string; count?: number; warn?: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.row,
        { backgroundColor: warn ? p.mark : hovered ? p.raised : p.surface, borderColor: warn ? p.markRing : p.hairline },
      ]}
    >
      <Icon name={icon} size={18} color={p.ink} />
      <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium }}>
        {label}
      </T>
      {!!count && (
        <T v="label" color={p.accent} style={{ fontFamily: fonts.sansSemi }}>
          {count}
        </T>
      )}
      <Icon name="chevronRight" size={18} color={p.muted} />
    </Pressable>
  );
}

type Place = 'archive' | 'folders' | 'device';
const PLACES: Place[] = ['archive', 'folders', 'device'];
const placeIcon: Record<Place, IconName> = { archive: 'folder', folders: 'folder', device: 'device' };
const placeName = (pl: Place) => (pl === 'archive' ? t.placeArchive : pl === 'folders' ? t.placeFolders : t.placeDevice);
/** Where a document is: the archive (synced), another folder, or only on this device. */
const placeOf = (d: IndexedDoc, archive: string | null): Place => (d.place.kind === 'library' ? 'device' : d.place.root === archive ? 'archive' : 'folders');

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: radius.pill, gap: 2, marginBottom: space.lg },
  segment: { height: 34, justifyContent: 'center', paddingHorizontal: space.lg, borderRadius: radius.pill },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, minHeight: 48, marginTop: space.md },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, paddingLeft: space.md, minHeight: 44 },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 16, paddingVertical: space.sm, outlineStyle: 'none' } as object,
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg, marginBottom: space.sm },
  sort: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 32 },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
