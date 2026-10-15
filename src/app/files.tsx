import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { columnWidth, goTab } from '@/components/AppNav';
import { Icon, type IconName } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Action, ActionBar, heldNow, justSelected, SelectBar, toggled } from '@/components/Selection';
import { DocItem, gridOf, LayoutToggle, useLayout } from '@/components/DocItems';
import { SelectChip, SortChip } from '@/components/SortChip';
import { showActions } from '@/state/actions';
import { Toast } from '@/components/Toast';
import { useNotice } from '@/components/useNotice';
import { elevation, fonts, radius, space } from '@/design/tokens';
import { errorText, opError, t } from '@/i18n';
import { folders, type FolderEntry, type FolderRoot, type Place } from '@/lib/folders';
import { PartlyDone } from '@/lib/folderTypes';
import { pickPdfs } from '@/lib/pick';
import { moveToTrash, restore, trashes } from '@/archive/trash';
import { setArchive } from '@/archive/views';
import { allDocs, renamed, schedule } from '@/archive/indexer';
import { sameOrRenamed } from '@/lib/names';
import { addToReading, filesAsDocs, readingAddedText } from '@/archive/batch';
import { cancelThumbs } from '@/lib/thumbs';
import { ask } from '@/state/ask';
import { clipCount, useClipboard } from '@/state/clipboard';
import { useLibrary } from '@/state/library';
import { usePalette, usePrefs } from '@/state/prefs';

/**
 * Folder IDs are URIs and paths ("…/tree/primary%3ADocs", "100% done"): route params are decoded on the
 * way, which would change them. They travel base64url-encoded instead.
 */
const pack = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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

/** A folder's PDFs and books as a grid of thumbnails, with file operations. (The places are Documents → Folders.) */
export default function Files() {
  const params = useLocalSearchParams<Params>();
  const root = unpack(params.r);
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const contentW = columnWidth(width);
  const load = useLibrary((s) => s.load);
  useEffect(() => {
    load();
  }, [load]);

  if (!root) return <Redirect href={{ pathname: '/documents', params: { view: 'folders' } }} />;
  return (
    <View style={{ flex: 1, backgroundColor: p.canvas, alignItems: 'center', paddingTop: insets.top + space.lg }}>
      <View style={{ width: contentW, flex: 1 }}>
        <FolderView root={root} rootName={unpack(params.rn) ?? ''} dir={unpack(params.d)} name={unpack(params.dn)} width={contentW} bottom={insets.bottom} />
      </View>
    </View>
  );
}

const rootIcon: Record<FolderRoot['kind'], IconName> = { folder: 'folder', device: 'device', all: 'documents', app: 'pages' };

/** The places to browse (the archive first), for Documents → Folders; adding a folder opens it. */
export function Roots({ bottom, onError: setError }: { bottom: number; onError: (message: string) => void }) {
  const p = usePalette();
  const showAll = usePrefs((s) => s.allFiles);
  const archive = usePrefs((s) => s.archive);
  const [roots, setRoots] = useState<FolderRoot[] | null>(null);

  const refresh = useCallback(() => {
    folders
      .roots(showAll)
      // The archive (synced) first.
      .then((list) => setRoots([...list.filter((r) => r.id === archive), ...list.filter((r) => r.id !== archive)]))
      .catch((e) => setError(opError(e)));
  }, [showAll, archive, setError]);
  useEffect(refresh, [refresh]);

  const add = async () => {
    const r = await folders.add().catch((e) => void setError(opError(e)));
    if (r) go(r.id, r.name);
    refresh();
    // What is in it is found and read.
    if (r) schedule(1000);
  };
  // A single file from anywhere the system picker reaches (cloud drives, mail attachments…).
  const importFiles = useLibrary((s) => s.importFiles);
  const openOther = async () => {
    const [doc] = await importFiles(await pickPdfs());
    if (doc) router.push({ pathname: '/read/[id]', params: { id: doc.id } });
  };
  // The archive is chosen once, from the folders added (not a button beside each one: names need the room).
  const candidates = (roots ?? []).filter((r) => r.kind === 'folder' && !r.locked);
  const chooseArchive = () => {
    const choose = (r: FolderRoot) => void setArchive(r.id).catch((e) => setError(opError(e)));
    if (candidates.length === 1) return choose(candidates[0]);
    showActions(
      t.chooseArchive,
      candidates.map((r, i) => ({ key: `archive-${i}`, icon: 'folder' as IconName, label: r.name, onPress: () => choose(r) })),
    );
  };
  const unlockAndOpen = async (r: FolderRoot) => {
    if (r.locked && !(await folders.unlock(r.id).catch(() => false))) return;
    go(r.id, r.name);
  };

  return (
    <>
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
              <View key={r.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }}>
                  <Pressable
                    testID="folder-root"
                    accessibilityRole="button"
                    accessibilityLabel={r.name}
                    onPress={() => unlockAndOpen(r)}
                    style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.rootRow, { flex: 1, backgroundColor: hovered ? p.raised : 'transparent' }]}
                  >
                    <Icon name={rootIcon[r.kind]} color={r.kind === 'folder' ? p.accent : p.ink} />
                    <View style={{ flex: 1, paddingVertical: space.sm }}>
                      <T v="label" numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15, lineHeight: 20 }}>
                        {r.name}
                      </T>
                      {r.id === archive && (
                        <T v="caption" color={p.accent} testID="archive-mark">
                          {/^(archive|archiv)$/i.test(r.name.trim()) ? t.syncedOnly : t.archiveSynced}
                        </T>
                      )}
                    </View>
                    {r.locked ? (
                      <T v="caption" color={p.accent}>
                        {t.allowAccess}
                      </T>
                    ) : (
                      <Icon name="chevronRight" size={18} color={p.muted} />
                    )}
                  </Pressable>
                </View>
                {r.id === archive && (
                  <Pressable
                    testID="folders-trash"
                    accessibilityRole="button"
                    onPress={() => router.push('/trash')}
                    style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                      styles.rootRow,
                      { paddingLeft: space.xl + space.lg, borderColor: p.hairline, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: hovered ? p.raised : 'transparent' },
                    ]}
                  >
                    <Icon name="trash" size={18} color={p.muted} />
                    <T v="label" color={p.inkSoft} style={{ flex: 1, paddingVertical: space.sm }}>
                      {t.trashTitle}
                    </T>
                    <Icon name="chevronRight" size={18} color={p.muted} />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            <Button testID="add-folder" kind="quiet" icon="folderAdd" label={t.addFolder} onPress={add} />
            <Button testID="open-other" kind="quiet" icon="documents" label={t.otherLocation} onPress={openOther} />
            {!archive && candidates.length > 0 && (
              <Button
                testID="use-archive"
                kind="quiet"
                icon="inbox"
                label={candidates.length === 1 ? t.useNamedAsArchive(candidates[0].name) : t.chooseArchive}
                onPress={chooseArchive}
              />
            )}
          </View>
          <Pressable accessibilityRole="link" onPress={() => router.push('/settings')} style={{ alignSelf: 'flex-start' }}>
            <T v="caption" color={p.muted} style={{ textDecorationLine: 'underline' }}>
              {t.moreInSettings}
            </T>
          </Pressable>
        </View>
      )}
    </>
  );
}


/** Folders first, then documents in the order chosen. */
type Sort = 'name' | 'date' | 'oldest' | 'size';
const SORTS: Sort[] = ['name', 'date', 'oldest', 'size'];
const sortName: Record<Sort, string> = { name: t.sortName, date: t.sortDate, oldest: t.sortOldest, size: t.sortSize };
const byOrder: Record<Sort, (a: FolderEntry, b: FolderEntry) => number> = {
  name: (a, b) => collator.compare(a.name, b.name),
  date: (a, b) => b.modified - a.modified || collator.compare(a.name, b.name),
  oldest: (a, b) => a.modified - b.modified || collator.compare(a.name, b.name),
  size: (a, b) => b.size - a.size || collator.compare(a.name, b.name),
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function FolderView({ root, rootName, dir, name, width, bottom }: { root: string; rootName: string; dir?: string; name?: string; width: number; bottom: number }) {
  const p = usePalette();
  const [entries, setEntries] = useState<FolderEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  // It can't be read because the browser wants the user's OK again (after a restart): it can be given here.
  const [locked, setLocked] = useState(false);
  const [sort, setSort] = useState<Sort>(root === 'all' ? 'date' : 'name');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  // What the last operation did, with Undo for a move to the trash.
  const { notice: message, say: setMessage, dismiss, action } = useNotice();
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
      .catch(() => {
        if (!live) return;
        setFailed(true);
        folders.roots(false).then((rs) => live && setLocked(!!rs.find((r) => r.id === root)?.locked), () => {});
      });
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
    const docs = list.filter((e) => e.kind !== 'dir').sort(byOrder[sort]);
    return [...dirs, ...docs];
  }, [entries, query, sort]);

  const layout = useLayout();
  const { cols, gap, tile } = gridOf(width);

  const picked = useMemo(() => (selected ? shown.filter((e) => selected.has(e.id)) : []), [selected, shown]);
  const toggle = (e: FolderEntry) => setSelected((s) => toggled(s, e.id));

  /** Runs a file operation; the folder (and any folder below it on the stack) lists itself again, Documents soon after. */
  const run = async (op: () => Promise<string | void>) => {
    try {
      const done = await op();
      if (done) setMessage(done);
      setSelected(null);
    } catch (e) {
      setMessage(opError(e));
    }
    changed();
    schedule(1000);
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
  // A document keeps its extension (without it, it wouldn't be one any more): only the name before it is edited.
  const rename = async () => {
    const e = picked[0];
    const ext = e.kind === 'dir' ? '' : (/\.(pdf|epub)$/i.exec(e.name)?.[0] ?? '');
    const typed = (await ask({ title: t.rename, input: ext ? e.name.slice(0, -ext.length) : e.name, placeholder: t.newName, confirm: t.rename }))?.trim();
    const n = typed && ext && !/\.(pdf|epub)$/i.test(typed) ? `${typed}${ext}` : typed;
    if (!n || n === e.name) return;
    await run(async () => {
      const to = await folders.rename(root, dir, e, n);
      // The file as it is now: library documents follow it (browsers: by its new handle), its record keeps its text.
      const now = (await folders.list(root, dir).catch(() => [] as FolderEntry[])).find((x) => (to ? x.uri === to : x.name === n));
      if (to && e.uri) await followFiles([{ from: e.uri, to }]);
      else if (now && e.handle) await useLibrary.getState().followEntry(e, now);
      const was = now && (await allDocs()).find((d) => d.key === `${root}:${e.id}`);
      if (was && now) renamed(was, now);
    });
  };
  const remove = async () => {
    const list = picked;
    // In the archive, deleting moves to its trash (undoable); elsewhere it is for good, so it asks first.
    if (trashes(root)) {
      await run(async () => {
        const items = await moveToTrash(root, dir, list);
        // The library forgets its documents of them once Undo is gone (Undo brings them back as they were).
        const uris = list.flatMap((e) => (e.uri ? [e.uri] : []));
        setMessage(t.trashedN(list.length), {
          undo: () => void restore(root, items).then(changed, (e) => setMessage(opError(e))),
          settle: () => void forgetFiles(uris).catch(() => {}),
        });
      });
      return;
    }
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
    setClip({ move, items: [{ from: here, entries: picked }] });
    setSelected(null);
  };

  const docs = entries?.filter((e) => e.kind !== 'dir').length ?? 0;
  // On a phone the filter, Select and Sort go on a line of their own when they don't fit beside the count.
  const header = (
    <View style={styles.listHead}>
      <T v="kicker" color={p.muted}>
        {entries ? t.folderSummary(docs, entries.length - docs) : ''}
      </T>
      <View style={styles.listTools}>
        {(entries?.length ?? 0) > 12 && (
          <View style={[styles.search, { backgroundColor: p.hairline }]}>
            <Icon name="search" size={15} color={p.muted} />
            <TextInput value={query} onChangeText={setQuery} placeholder={t.filter} accessibilityLabel={t.filter} placeholderTextColor={p.muted} style={[styles.searchInput, { color: p.ink }]} />
          </View>
        )}
        {(entries?.length ?? 0) > 0 && !selected && <SelectChip onPress={() => setSelected(new Set())} />}
        <SortChip
          label={sortName[sort]}
          onPress={() =>
            showActions(
              t.sortTitle,
              SORTS.map((o) => ({ key: `sort-${o}`, icon: o === sort ? 'check' : 'sort', label: sortName[o], onPress: () => setSort(o) })),
            )
          }
        />
      </View>
    </View>
  );

  return (
    <>
      {selected ? (
        <SelectBar count={picked.length} onCancel={() => setSelected(null)} onAll={() => setSelected(new Set(shown.map((e) => e.id)))} />
      ) : (
        <ScreenHeader title={name ?? rootName} over={name ? rootName : t.foldersView} up={() => goTab('documents', 'folders')}>
          {editable && <IconButton testID="new-folder" icon="folderAdd" label={t.newFolder} onPress={newFolder} />}
          <LayoutToggle />
        </ScreenHeader>
      )}
      {failed ? (
        locked ? (
          <View style={{ gap: space.md, alignItems: 'flex-start' }}>
            <T color={p.muted}>{t.folderLocked}</T>
            <Button testID="folder-unlock" label={t.allowAccess} onPress={() => void folders.unlock(root).then((ok) => ok && changed(), () => {})} />
          </View>
        ) : (
          <T color={p.muted}>{t.folderError}</T>
        )
      ) : !entries ? (
        <ActivityIndicator color={p.muted} />
      ) : (
        <FlatList
          key={layout === 'grid' ? cols : 'list'}
          testID="folder-grid"
          data={shown}
          numColumns={layout === 'grid' ? cols : 1}
          keyExtractor={(e) => e.id}
          ListHeaderComponent={header}
          ListEmptyComponent={<T color={p.muted}>{t.folderEmpty}</T>}
          columnWrapperStyle={layout === 'grid' ? { gap } : undefined}
          contentContainerStyle={{ gap: layout === 'grid' ? gap + space.xs : 0, paddingBottom: bottom + space.xxxl * 2 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={layout === 'grid' ? cols * 4 : 14}
          windowSize={5}
          renderItem={({ item, index }) => {
            const isDir = item.kind === 'dir';
            return (
              <DocItem
                layout={layout}
                width={tile}
                testID={isDir ? 'folder-dir' : 'folder-doc'}
                picture={isDir ? { kind: 'dir' } : { kind: 'file', root, entry: item }}
                title={isDir ? item.name : bareName(item.name)}
                label={item.name}
                meta={isDir ? undefined : root === 'all' && item.where ? item.where : t.fileMeta(item.size, item.modified)}
                busy={opening === item.id}
                first={index === 0}
                last={index === shown.length - 1}
                selected={selected ? selected.has(item.id) : undefined}
                onOpen={() => void open(item)}
                onToggle={() => !justSelected(item.id) && toggle(item)}
                onSelect={() => {
                  // A long press on a phone also fires a context menu (and the release a tap): one gesture, one change.
                  if (justSelected(item.id)) return;
                  heldNow(item.id);
                  if (selected) toggle(item);
                  else setSelected(new Set([item.id]));
                }}
              />
            );
          }}
        />
      )}
      {selected ? (
        <ActionBar bottom={bottom}>
          {folders.canShare && <Action testID="act-share" icon="share" label={t.share} disabled={!picked.length || picked.some((e) => e.kind === 'dir')} onPress={share} />}
          <Action
            testID="act-reading"
            icon="readingAdd"
            label={t.readingList}
            disabled={!picked.length || picked.some((e) => e.kind === 'dir')}
            onPress={() => void run(async () => readingAddedText(await addToReading(filesAsDocs(root, dir, picked))))}
          />
          <Action testID="act-copy" icon="copy" label={t.copy} disabled={!picked.length} onPress={() => clip(false)} />
          <Action testID="act-move" icon="move" label={t.move} disabled={!editable || !picked.length} onPress={() => clip(true)} />
          <Action testID="act-rename" icon="pencil" label={t.rename} disabled={!editable || picked.length !== 1} onPress={rename} />
          <Action testID="act-delete" icon="trash" label={t.delete} disabled={!editable || !picked.length} onPress={remove} />
        </ActionBar>
      ) : (
        <PasteBar here={editable ? here : null} bottom={bottom} onDone={() => {}} onError={setMessage} onMessage={setMessage} />
      )}
      <Toast
        message={message ?? error}
        onDismiss={() => (message ? dismiss() : clearError())}
        action={message ? action : undefined}
      />
    </>
  );
}

/** "Copy n items here" / "Move n items here" while items wait on the clipboard. */
export function PasteBar({ here, bottom, onDone, onError, onMessage }: { here: Place | null; bottom: number; onDone: () => void; onError: (msg: string) => void; onMessage?: (msg: string) => void }) {
  const p = usePalette();
  const clip = useClipboard((s) => s.clip);
  const setClip = useClipboard((s) => s.set);
  const changed = useClipboard((s) => s.changed);
  const followFiles = useLibrary((s) => s.followFiles);
  const [busy, setBusy] = useState(false);
  if (!clip) return null;
  const count = clipCount(clip);
  const same = here && clip.items.every(({ from }) => here.root === from.root && (here.dir ?? '') === (from.dir ?? ''));
  // Into itself or below itself: a folder can't be moved or copied inside itself.
  const inside =
    here && clip.items.some(({ from, entries }) => entries.some((e) => e.kind === 'dir' && here.root === from.root && here.dir != null && (here.dir === e.id || here.dir.startsWith(`${e.id}/`))));
  const canPaste = here && !inside && !(clip.move && same);

  const paste = async () => {
    if (!here) return;
    setBusy(true);
    try {
      for (const { from, entries } of clip.items) {
        // Already here: nothing to move.
        if (clip.move && from.root === here.root && (from.dir ?? '') === (here.dir ?? '')) continue;
        // Browsers tell moved files only by name: what was here before.
        const byHandle = clip.move && entries.some((e) => e.handle && e.kind !== 'dir');
        const before = byHandle ? new Set((await folders.list(here.root, here.dir).catch(() => [] as FolderEntry[])).map((e) => e.name)) : null;
        const moved = await folders.transfer(from, entries, here, clip.move).catch(async (e: unknown) => {
          // What did move is followed all the same (its library documents go with it).
          if (clip.move && e instanceof PartlyDone) await followFiles(e.done as { from: string; to: string }[]);
          throw e;
        });
        if (clip.move) await followFiles(moved);
        if (before) {
          const arrived = (await folders.list(here.root, here.dir).catch(() => [] as FolderEntry[])).filter((e) => !before.has(e.name));
          for (const e of entries.filter((x) => x.handle && x.kind !== 'dir')) {
            const now = arrived.find((a) => sameOrRenamed(a.name, e.name));
            if (now) await useLibrary.getState().followEntry(e, now);
          }
        }
      }
      schedule(1000);
      onMessage?.(clip.move ? t.movedN(count) : t.copiedN(count));
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
        {canPaste ? t.selectedCount(count) : t.pickTarget(clip.move)}
      </T>
      <View style={styles.pasteButtons}>
        <Button kind="quiet" label={t.cancel} onPress={() => setClip(null)} />
        {canPaste && <Button testID="paste" label={busy ? t.loading : t.pasteHere(clip.move)} onPress={busy ? undefined : paste} style={{ flexShrink: 1 }} />}
      </View>
    </View>
  );
}



/** The thumbnail already says it's a document: "Report.pdf" shows as "Report". */
const bareName = (name: string) => name.replace(/\.(pdf|epub)$/i, '');

const styles = StyleSheet.create({
  empty: { alignItems: 'center', gap: space.md, paddingTop: space.xxxl, paddingHorizontal: space.lg },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  rootRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingHorizontal: space.lg, minHeight: 56 },
  listHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: space.md, rowGap: space.xs, minHeight: 36, marginBottom: space.xs },
  listTools: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginLeft: 'auto', flexShrink: 1, maxWidth: '100%' },
  // Narrower where there is little room (a phone, in German).
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, paddingHorizontal: space.md, height: 32, flexShrink: 1, minWidth: 96 },
  searchInput: { fontFamily: fonts.sans, fontSize: 13, width: 120, minWidth: 0, flexShrink: 1, height: 32, outlineStyle: 'none' } as object,
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
  pasteBar: { flexDirection: 'column', alignItems: 'stretch', gap: space.sm, paddingLeft: space.sm },
  pasteButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
});
