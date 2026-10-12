import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, TAB_BAR_H, TabBar, useTabBar } from '@/components/AppNav';
import { Cover } from '@/components/Cover';
import { Icon, type IconName } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { elevation, fonts, radius, space } from '@/design/tokens';
import { errorText, t } from '@/i18n';
import { folders, type FolderEntry, type FolderRoot, type Place } from '@/lib/folders';
import { pickPdfs } from '@/lib/pick';
import { cachedThumb, cancelThumbs, thumb, type Thumb } from '@/lib/thumbs';
import { ask } from '@/state/ask';
import { useClipboard } from '@/state/clipboard';
import { useLibrary } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 1120;

/**
 * Folder IDs are URIs and paths ("…/tree/primary%3ADocs", "100% done"): route params are decoded on the
 * way, which would change them. They travel base64url-encoded instead.
 */
const pack = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unpack(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

type Params = { r?: string; rn?: string; d?: string; dn?: string };
const go = (root: string, rootName: string, dir?: string, name?: string) =>
  router.push({ pathname: '/files', params: { r: pack(root), rn: pack(rootName), ...(dir ? { d: pack(dir), dn: pack(name ?? '') } : {}) } });

/** Files: the user's folders, then a folder's PDFs and books as a grid of thumbnails, with file operations. */
export default function Files() {
  const params = useLocalSearchParams<Params>();
  const root = unpack(params.r);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const gutter = width < 600 ? space.xl - 4 : space.xxxl;
  const contentW = Math.min(width, MAX_W) - gutter * 2;
  const load = useLibrary((s) => s.load);
  const tabBar = useTabBar();
  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas, alignItems: 'center', paddingTop: insets.top + space.lg }}>
      <View style={{ width: contentW, flex: 1 }}>
        {root ? (
          <FolderView root={root} rootName={unpack(params.rn) ?? ''} dir={unpack(params.d)} name={unpack(params.dn)} width={contentW} bottom={insets.bottom} />
        ) : (
          <Roots bottom={insets.bottom + (tabBar ? TAB_BAR_H : 0)} />
        )}
      </View>
      {!root && tabBar && <TabBar current="files" />}
    </View>
  );
}

const rootIcon: Record<FolderRoot['kind'], IconName> = { folder: 'folder', device: 'device', all: 'documents' };

/** The places to browse; adding a folder opens it. */
function Roots({ bottom }: { bottom: number }) {
  const p = usePalette();
  const showAll = usePrefs((s) => s.allFiles);
  const tabBar = useTabBar();
  const [roots, setRoots] = useState<FolderRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    folders
      .roots(showAll)
      .then(setRoots)
      .catch((e) => setError(opError(e)));
  }, [showAll]);
  useEffect(refresh, [refresh]);

  const add = async () => {
    const r = await folders.add().catch((e) => void setError(opError(e)));
    if (r) go(r.id, r.name);
    refresh();
  };
  // A single file from anywhere the system picker reaches (cloud drives, mail attachments…).
  const importFiles = useLibrary((s) => s.importFiles);
  const openOther = async () => {
    const [doc] = await importFiles(await pickPdfs());
    if (doc) router.push({ pathname: '/read/[id]', params: { id: doc.id } });
  };
  const unlockAndOpen = async (r: FolderRoot) => {
    if (r.locked && !(await folders.unlock(r.id).catch(() => false))) return;
    go(r.id, r.name);
  };

  return (
    <>
      <AppHeader tab="files" />
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
          <Button testID="open-other" kind="quiet" icon="documents" label={t.otherLocation} onPress={openOther} />
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
            <Button testID="open-other" kind="quiet" icon="documents" label={t.otherLocation} onPress={openOther} />
          </View>
          <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} style={{ alignSelf: 'flex-start' }}>
            <T v="caption" color={p.muted} style={{ textDecorationLine: 'underline' }}>
              {t.moreInSettings}
            </T>
          </Pressable>
        </View>
      )}
      <PasteBar here={null} bottom={bottom} onDone={refresh} onError={setError} />
      <Toast message={error} onDismiss={() => setError(null)} above={tabBar ? TAB_BAR_H : 0} />
    </>
  );
}

/** What went wrong with a file operation, in the user's language where we know it. */
function opError(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  const taken = /^exists:(.*)$/.exec(m);
  if (taken) return `${t.opFailed} ${t.nameTaken(taken[1])}`;
  return m === t.writeDenied || m === t.fileGone ? `${t.opFailed} ${m}` : t.opFailed;
}

/** The item a long press selected, and when: its follow-up events (context menu, release) don't toggle it back. */
let holdAt = { id: '', at: 0 };
const justSelected = (id: string) => holdAt.id === id && Date.now() - holdAt.at < 800;

type Sort = 'name' | 'date';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function FolderView({ root, rootName, dir, name, width, bottom }: { root: string; rootName: string; dir?: string; name?: string; width: number; bottom: number }) {
  const p = usePalette();
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<Sort>(root === 'all' ? 'date' : 'name');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { importFiles, error, clearError, followFiles, forgetFiles } = useLibrary();
  const version = useClipboard((s) => s.version);
  const setClip = useClipboard((s) => s.set);
  const changed = useClipboard((s) => s.changed);
  const here: Place = useMemo(() => ({ root, dir }), [root, dir]);
  const editable = folders.canEdit(root);

  useEffect(() => {
    let live = true;
    folders
      .list(root, dir)
      .then((list) => {
        if (!live) return;
        setEntries(list);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      cancelThumbs();
    };
  }, [root, dir, version]);

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

  const picked = useMemo(() => (selected ? shown.filter((e) => selected.has(e.id)) : []), [selected, shown]);
  const toggle = (e: FolderEntry) =>
    setSelected((s) => {
      const next = new Set(s ?? []);
      if (next.has(e.id)) next.delete(e.id);
      else next.add(e.id);
      return next;
    });

  /** Runs a file operation; the folder (and any folder below it on the stack) lists itself again. */
  const run = async (op: () => Promise<string | void>) => {
    try {
      const done = await op();
      if (done) setMessage(done);
      setSelected(null);
    } catch (e) {
      setMessage(opError(e));
    }
    changed();
  };

  const open = async (e: FolderEntry) => {
    if (selected) return justSelected(e.id) ? undefined : toggle(e);
    if (e.kind === 'dir') return go(root, rootName, e.id, e.name);
    if (opening) return;
    setOpening(e.id);
    try {
      const file = await folders.read(root, e);
      const [doc] = await importFiles([{ name: e.name, size: e.size || file.size, file, handle: e.handle, link: e.uri }]);
      if (doc) router.push({ pathname: '/read/[id]', params: { id: doc.id } });
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setOpening(null);
    }
  };

  const newFolder = async () => {
    const n = await ask({ title: t.newFolder, input: '', placeholder: t.folderName, confirm: t.newFolder });
    if (n) await run(() => folders.mkdir(root, dir, n));
  };
  const rename = async () => {
    const e = picked[0];
    const n = await ask({ title: t.rename, input: e.name, placeholder: t.newName, confirm: t.rename });
    if (!n || n === e.name) return;
    await run(async () => {
      const to = await folders.rename(root, dir, e, n);
      if (to && e.uri) await followFiles([{ from: e.uri, to }]);
    });
  };
  const remove = async () => {
    const list = picked;
    const yes = await ask({ title: t.deleteTitle(list.length), body: t.deleteBody(list.length, list[0].name), confirm: t.delete, destructive: true });
    if (yes == null) return;
    await run(async () => {
      await folders.delete(root, dir, list);
      await forgetFiles(list.flatMap((e) => (e.uri ? [e.uri] : [])));
      return t.deletedN(list.length);
    });
  };
  const share = () => run(() => folders.share(root, picked));
  const clip = (move: boolean) => {
    setClip({ move, from: here, entries: picked });
    setSelected(null);
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
      {selected ? (
        <View style={styles.selectBar}>
          <IconButton testID="select-cancel" icon="close" label={t.cancel} onPress={() => setSelected(null)} style={{ marginLeft: -space.sm }} />
          <T v="headline" style={{ flex: 1, fontSize: 17 }}>
            {t.selectedCount(selected.size)}
          </T>
          <IconButton testID="select-all" icon="select" label={t.selectAll} onPress={() => setSelected(new Set(shown.map((e) => e.id)))} />
        </View>
      ) : (
        <ScreenHeader title={name ?? rootName} over={name ? rootName : t.files}>
          {editable && <IconButton testID="new-folder" icon="folderAdd" label={t.newFolder} onPress={newFolder} />}
          {entries && entries.length > 0 && <IconButton testID="select" icon="select" label={t.select} onPress={() => setSelected(new Set())} />}
        </ScreenHeader>
      )}
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
          contentContainerStyle={{ gap: gap + space.xs, paddingBottom: bottom + space.xxxl * 2 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={cols * 4}
          windowSize={5}
          renderItem={({ item }) => (
            <Tile
              root={root}
              entry={item}
              width={tileW}
              where={root === 'all'}
              busy={opening === item.id}
              selected={selected ? selected.has(item.id) : undefined}
              onPress={() => open(item)}
              onSelect={() => {
                // A long press on a phone also fires a context menu (and the release a tap): one gesture, one change.
                if (justSelected(item.id)) return;
                holdAt = { id: item.id, at: Date.now() };
                if (selected) toggle(item);
                else setSelected(new Set([item.id]));
              }}
            />
          )}
        />
      )}
      {selected ? (
        <ActionBar bottom={bottom}>
          {folders.canShare && <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length || picked.some((e) => e.kind === 'dir')} onPress={share} />}
          <Action testID="act-copy" icon="copy" label={t.copy} disabled={!picked.length} onPress={() => clip(false)} />
          <Action testID="act-move" icon="move" label={t.move} disabled={!picked.length} onPress={() => clip(true)} />
          <Action testID="act-rename" icon="pencil" label={t.rename} disabled={picked.length !== 1} onPress={rename} />
          <Action testID="act-delete" icon="trash" label={t.delete} disabled={!picked.length} onPress={remove} />
        </ActionBar>
      ) : (
        <PasteBar here={editable ? here : null} bottom={bottom} onDone={() => {}} onError={setMessage} onMessage={setMessage} />
      )}
      <Toast message={message ?? error} onDismiss={() => (message ? setMessage(null) : clearError())} />
    </>
  );
}

/** "Copy n items here" / "Move n items here" while items wait on the clipboard. */
function PasteBar({
  here,
  bottom,
  onDone,
  onError,
  onMessage,
}: {
  here: Place | null;
  bottom: number;
  onDone: () => void;
  onError: (msg: string) => void;
  onMessage?: (msg: string) => void;
}) {
  const p = usePalette();
  const clip = useClipboard((s) => s.clip);
  const setClip = useClipboard((s) => s.set);
  const changed = useClipboard((s) => s.changed);
  const followFiles = useLibrary((s) => s.followFiles);
  const [busy, setBusy] = useState(false);
  if (!clip) return null;
  const same = here && here.root === clip.from.root && (here.dir ?? '') === (clip.from.dir ?? '');
  // Into itself or below itself: a folder can't be moved or copied inside itself.
  const inside = here && clip.entries.some((e) => e.kind === 'dir' && here.root === clip.from.root && here.dir != null && (here.dir === e.id || here.dir.startsWith(`${e.id}/`)));
  const canPaste = here && !inside && !(clip.move && same);

  const paste = async () => {
    if (!here) return;
    setBusy(true);
    try {
      const moved = await folders.transfer(clip.from, clip.entries, here, clip.move);
      if (clip.move) await followFiles(moved);
      onMessage?.(clip.move ? t.movedN(clip.entries.length) : t.copiedN(clip.entries.length));
      setClip(null);
    } catch (e) {
      onError(opError(e));
    } finally {
      setBusy(false);
      changed();
      onDone();
    }
  };

  return (
    <View testID="paste-bar" style={[styles.bar, styles.pasteBar, { bottom: bottom + space.lg, backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}>
      <T v="label" color={p.inkSoft} numberOfLines={2} style={{ paddingHorizontal: space.sm }}>
        {canPaste ? t.selectedCount(clip.entries.length) : t.pickTarget(clip.move)}
      </T>
      <View style={styles.pasteButtons}>
        <Button kind="quiet" label={t.cancel} onPress={() => setClip(null)} />
        {canPaste && <Button testID="paste" label={busy ? t.loading : t.pasteHere(clip.move)} onPress={busy ? undefined : paste} style={{ flexShrink: 1 }} />}
      </View>
    </View>
  );
}

function ActionBar({ bottom, children }: { bottom: number; children: ReactNode }) {
  const p = usePalette();
  return (
    <View testID="action-bar" style={[styles.bar, styles.actions, { bottom: bottom + space.lg, backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}>
      {children}
    </View>
  );
}

function Action({ icon, label, disabled, onPress, testID }: { icon: IconName; label: string; disabled?: boolean; onPress: () => void; testID: string }) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.action,
        { opacity: disabled ? 0.35 : pressed ? 0.6 : 1, backgroundColor: hovered && !disabled ? p.hairline : 'transparent' },
      ]}
    >
      <Icon name={icon} size={22} color={p.ink} />
      <T v="caption" numberOfLines={1} style={{ fontSize: 11 }}>
        {label}
      </T>
    </Pressable>
  );
}

function Tile({
  root,
  entry,
  width,
  where,
  busy,
  selected,
  onPress,
  onSelect,
}: {
  root: string;
  entry: FolderEntry;
  width: number;
  where: boolean;
  busy: boolean;
  /** undefined: not selecting. */
  selected?: boolean;
  onPress: () => void;
  onSelect: () => void;
}) {
  const p = usePalette();
  const [image, setImage] = useState<Thumb | undefined>(undefined);
  const isDir = entry.kind === 'dir';
  const boxH = Math.round(width * 1.32);
  // The check sits on the picture itself (folders and covers are shorter than the box).
  const coverW = image ? Math.min(width, Math.round(boxH / image.aspect)) : width;
  const shownH = isDir ? Math.round(width * 0.8) : image ? Math.round(coverW * Math.min(Math.max(image.aspect, 0.5), 1.8)) : Math.round(width * 1.3);
  const checkAt = { top: boxH - shownH + 6, right: Math.round((width - (isDir ? width : coverW)) / 2) + 6 };

  useEffect(() => {
    if (isDir) return;
    let live = true;
    cachedThumb(root, entry)
      .then((hit) => (hit !== undefined ? hit : thumb(root, entry, () => folders.read(root, entry))))
      .then((th) => live && setImage(th));
    return () => {
      live = false;
    };
  }, [root, entry, isDir]);

  return (
    <Pressable
      testID={isDir ? 'folder-dir' : 'folder-doc'}
      accessibilityRole={selected === undefined ? 'button' : 'checkbox'}
      accessibilityState={selected === undefined ? undefined : { checked: selected }}
      accessibilityLabel={entry.name}
      onPress={onPress}
      onLongPress={onSelect}
      delayLongPress={350}
      // Right-click selects on a computer, like a long press on a phone.
      {...(Platform.OS === 'web'
        ? {
            onContextMenu: (ev: { preventDefault(): void }) => {
              ev.preventDefault();
              onSelect();
            },
          }
        : {})}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [{ width, opacity: pressed || busy ? 0.6 : hovered ? 0.92 : 1 }]}
    >
      <View style={{ height: boxH, justifyContent: 'flex-end', alignItems: 'center' }}>
        {isDir ? (
          <View style={[styles.dirBox, { width, height: Math.round(width * 0.8), backgroundColor: p.surface, borderColor: p.hairline }]}>
            <Icon name="folder" size={Math.round(width * 0.36)} color={p.accent} strokeWidth={1.2} />
          </View>
        ) : image ? (
          <Cover uri={image.uri} aspect={image.aspect} width={coverW} />
        ) : (
          <View testID={image === null ? 'thumb-none' : 'thumb-pending'} style={[styles.plain, { width, height: Math.round(width * 1.3), backgroundColor: p.surface, borderColor: p.hairline }]}>
            <T v="kicker" color={p.muted}>
              {entry.kind === 'epub' ? 'EPUB' : 'PDF'}
            </T>
          </View>
        )}
        {busy && <ActivityIndicator style={StyleSheet.absoluteFill} color={p.accent} />}
        {selected !== undefined && (
          <View
            pointerEvents="none"
            style={[styles.check, checkAt, { backgroundColor: selected ? p.accent : p.surface, borderColor: selected ? p.accent : p.muted }, elevation(p.shadow, 1)]}
          >
            {selected && <Icon name="check" size={16} color={p.surface} strokeWidth={2.4} />}
          </View>
        )}
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
  check: { position: 'absolute', width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  selectBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 52, marginBottom: space.lg },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    paddingLeft: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actions: { gap: 0, paddingHorizontal: space.xs, paddingLeft: space.xs },
  action: { flex: 1, minWidth: 0, alignItems: 'center', gap: 2, paddingVertical: space.xs, paddingHorizontal: 2, borderRadius: radius.md },
  pasteBar: { flexDirection: 'column', alignItems: 'stretch', gap: space.sm, paddingLeft: space.sm },
  pasteButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
});
