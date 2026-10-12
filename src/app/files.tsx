import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cover } from '@/components/Cover';
import { Icon, type IconName } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { errorText, t } from '@/i18n';
import { folders, type FolderEntry, type FolderRoot } from '@/lib/folders';
import { cachedThumb, cancelThumbs, thumb, type Thumb } from '@/lib/thumbs';
import { useLibrary } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 1120;

type Params = { root?: string; rootName?: string; dir?: string; name?: string };

/** Files: the user's folders, then a folder's PDFs and books as a grid of thumbnails. */
export default function Files() {
  const { root, rootName, dir, name } = useLocalSearchParams<Params>();
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const gutter = width < 600 ? space.xl - 4 : space.xxxl;
  const contentW = Math.min(width, MAX_W) - gutter * 2;
  const load = useLibrary((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas, alignItems: 'center', paddingTop: insets.top + space.lg }}>
      <View style={{ width: contentW, flex: 1 }}>
        {root ? (
          <FolderView root={root} rootName={rootName ?? ''} dir={dir} name={name} width={contentW} bottom={insets.bottom} />
        ) : (
          <Roots bottom={insets.bottom} />
        )}
      </View>
    </View>
  );
}

const rootIcon: Record<FolderRoot['kind'], IconName> = { folder: 'folder', device: 'device', all: 'documents' };

const openRoot = (r: FolderRoot) => router.push({ pathname: '/files', params: { root: r.id, rootName: r.name } });

/** The places to browse; adding a folder opens it. */
function Roots({ bottom }: { bottom: number }) {
  const p = usePalette();
  const showAll = usePrefs((s) => s.allFiles);
  const [roots, setRoots] = useState<FolderRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    folders
      .roots(showAll)
      .then(setRoots)
      .catch((e) => setError(errorText(e)));
  }, [showAll]);
  useEffect(refresh, [refresh]);

  const add = async () => {
    const r = await folders.add().catch((e) => void setError(errorText(e)));
    if (r) openRoot(r);
    refresh();
  };
  const unlockAndOpen = async (r: FolderRoot) => {
    if (r.locked && !(await folders.unlock(r.id).catch(() => false))) return;
    openRoot(r);
  };

  return (
    <>
      <ScreenHeader title={t.files}>
        {folders.supported && <IconButton testID="open-settings" icon="settings" label={t.settings} onPress={() => router.push('/settings')} />}
      </ScreenHeader>
      {!folders.supported ? (
        <T color={p.muted}>{t.foldersUnsupported}</T>
      ) : roots == null ? (
        <ActivityIndicator color={p.muted} />
      ) : roots.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="folder" size={40} color={p.muted} strokeWidth={1.3} />
          <T v="title" style={{ textAlign: 'center' }}>
            {t.foldersEmptyTitle}
          </T>
          <T color={p.muted} style={{ textAlign: 'center', maxWidth: 420 }}>
            {t.foldersEmptyBody}
          </T>
          <Button testID="add-folder" icon="folderAdd" label={t.addFolder} onPress={add} style={{ marginTop: space.md }} />
        </View>
      ) : (
        <View style={{ gap: space.lg, paddingBottom: bottom + space.xl }}>
          <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
            {roots.map((r, i) => (
              <Pressable
                key={r.id}
                testID="folder-root"
                accessibilityRole="button"
                accessibilityLabel={r.name}
                onPress={() => unlockAndOpen(r)}
                style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                  styles.rootRow,
                  { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, backgroundColor: hovered ? p.raised : 'transparent' },
                ]}
              >
                <Icon name={rootIcon[r.kind]} color={r.kind === 'folder' ? p.accent : p.ink} />
                <T v="label" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
                  {r.name}
                </T>
                {r.locked ? (
                  <T v="caption" color={p.accent}>
                    {t.allowAccess}
                  </T>
                ) : (
                  <Icon name="chevronRight" size={18} color={p.muted} />
                )}
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button testID="add-folder" kind="quiet" icon="folderAdd" label={t.addFolder} onPress={add} />
          </View>
          <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} style={{ alignSelf: 'flex-start' }}>
            <T v="caption" color={p.muted} style={{ textDecorationLine: 'underline' }}>
              {t.moreInSettings}
            </T>
          </Pressable>
        </View>
      )}
      <Toast message={error} onDismiss={() => setError(null)} />
    </>
  );
}

type Sort = 'name' | 'date';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function FolderView({ root, rootName, dir, name, width, bottom }: { root: string; rootName: string; dir?: string; name?: string; width: number; bottom: number }) {
  const p = usePalette();
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<Sort>(root === 'all' ? 'date' : 'name');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const { importFiles, error, clearError } = useLibrary();
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    folders
      .list(root, dir)
      .then((list) => live && setEntries(list))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      cancelThumbs();
    };
  }, [root, dir]);

  const shown = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
    const dirs = list.filter((e) => e.kind === 'dir').sort((a, b) => collator.compare(a.name, b.name));
    const docs = list.filter((e) => e.kind !== 'dir').sort((a, b) => (sort === 'date' ? b.modified - a.modified : collator.compare(a.name, b.name)));
    return [...dirs, ...docs];
  }, [entries, query, sort]);

  const gap = width < 600 ? space.md : space.lg;
  const cols = Math.max(3, Math.floor((width + gap) / ((width < 600 ? 104 : 150) + gap)));
  const tileW = Math.floor((width - gap * (cols - 1)) / cols);

  const open = async (e: FolderEntry) => {
    if (e.kind === 'dir') {
      router.push({ pathname: '/files', params: { root, rootName, dir: e.id, name: e.name } });
      return;
    }
    if (opening) return;
    setOpening(e.id);
    try {
      const file = await folders.read(root, e);
      const [doc] = await importFiles([{ name: e.name, size: e.size || file.size, file, handle: e.handle, link: e.uri }]);
      if (doc) router.push({ pathname: '/read/[id]', params: { id: doc.id } });
    } catch (err) {
      setOpenError(errorText(err));
    } finally {
      setOpening(null);
    }
  };

  const docs = entries?.filter((e) => e.kind !== 'dir').length ?? 0;
  const header = (
    <View style={styles.listHead}>
      <T v="kicker" color={p.muted}>
        {entries ? t.folderSummary(docs, entries.length - docs) : ''}
      </T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
        {(entries?.length ?? 0) > 12 && (
          <View style={[styles.search, { backgroundColor: p.hairline }]}>
            <Icon name="search" size={15} color={p.muted} />
            <TextInput value={query} onChangeText={setQuery} placeholder={t.filter} placeholderTextColor={p.muted} style={[styles.searchInput, { color: p.ink }]} />
          </View>
        )}
        <IconButton
          testID="sort"
          icon="sort"
          size={36}
          label={sort === 'name' ? t.sortByDate : t.sortByName}
          onPress={() => setSort((s) => (s === 'name' ? 'date' : 'name'))}
        />
      </View>
    </View>
  );

  return (
    <>
      <ScreenHeader title={name ?? rootName} over={name ? rootName : t.files} />
      {failed ? (
        <T color={p.muted}>{t.folderError}</T>
      ) : !entries ? (
        <ActivityIndicator color={p.muted} />
      ) : (
        <FlatList
          key={cols}
          testID="folder-grid"
          data={shown}
          numColumns={cols}
          keyExtractor={(e) => e.id}
          ListHeaderComponent={header}
          ListEmptyComponent={<T color={p.muted}>{t.folderEmpty}</T>}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ gap: gap + space.xs, paddingBottom: bottom + space.xxl }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={cols * 4}
          windowSize={5}
          renderItem={({ item }) => (
            <Tile root={root} entry={item} width={tileW} where={root === 'all'} busy={opening === item.id} onPress={() => open(item)} />
          )}
        />
      )}
      <Toast message={openError ?? error} onDismiss={() => (openError ? setOpenError(null) : clearError())} />
    </>
  );
}

function Tile({ root, entry, width, where, busy, onPress }: { root: string; entry: FolderEntry; width: number; where: boolean; busy: boolean; onPress: () => void }) {
  const p = usePalette();
  const [image, setImage] = useState<Thumb | undefined>(undefined);
  const isDir = entry.kind === 'dir';
  const boxH = Math.round(width * 1.32);

  useEffect(() => {
    if (isDir) return;
    let live = true;
    cachedThumb(root, entry)
      .then((hit) => hit !== undefined ? hit : thumb(root, entry, () => folders.read(root, entry)))
      .then((th) => live && setImage(th));
    return () => {
      live = false;
    };
  }, [root, entry, isDir]);

  return (
    <Pressable
      testID={isDir ? 'folder-dir' : 'folder-doc'}
      accessibilityRole="button"
      accessibilityLabel={entry.name}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [{ width, opacity: pressed || busy ? 0.6 : hovered ? 0.92 : 1 }]}
    >
      <View style={{ height: boxH, justifyContent: 'flex-end', alignItems: 'center' }}>
        {isDir ? (
          <View style={[styles.dirBox, { width, height: Math.round(width * 0.8), backgroundColor: p.surface, borderColor: p.hairline }]}>
            <Icon name="folder" size={Math.round(width * 0.36)} color={p.accent} strokeWidth={1.2} />
          </View>
        ) : image ? (
          <Cover uri={image.uri} aspect={image.aspect} width={Math.min(width, Math.round(boxH / image.aspect))} />
        ) : (
          <View testID={image === null ? 'thumb-none' : 'thumb-pending'} style={[styles.plain, { width, height: Math.round(width * 1.3), backgroundColor: p.surface, borderColor: p.hairline }]}>
            <T v="kicker" color={p.muted}>
              {entry.kind === 'epub' ? 'EPUB' : 'PDF'}
            </T>
          </View>
        )}
        {busy && <ActivityIndicator style={StyleSheet.absoluteFill} color={p.accent} />}
      </View>
      <T v="caption" numberOfLines={2} style={{ marginTop: space.sm, fontFamily: fonts.sansMedium, fontSize: 12.5, lineHeight: 16 }}>
        {entry.name}
      </T>
      {!isDir && (
        <T v="caption" color={p.muted} numberOfLines={1} style={{ fontSize: 11 }}>
          {where && entry.where ? entry.where : t.fileMeta(entry.size, entry.modified)}
        </T>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: space.md, paddingTop: space.xxxl, paddingHorizontal: space.lg },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  rootRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.lg, minHeight: 56 },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, marginBottom: space.xs },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 120, height: 32, outlineStyle: 'none' } as object,
  dirBox: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  plain: { borderRadius: radius.cover, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
