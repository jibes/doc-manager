import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { allDocs, forget, useIndex, type Conflict } from '@/archive/indexer';
import { openDoc, whereIs } from '@/archive/Results';
import type { IndexedDoc } from '@/archive/search';
import { duplicates } from '@/archive/sync';
import { discard, trashes } from '@/archive/trash';
import { goTab } from '@/components/AppNav';
import { Icon } from '@/components/Icon';
import { Button, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { opError, t } from '@/i18n';
import { folders } from '@/lib/folders';
import type { FolderEntry } from '@/lib/folderTypes';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 820;
/** Groups shown at first, and added by "Show more". */
const PAGE = 20;

/** A conflict copy with the file it conflicts with (null when that one is gone). */
type Pair = { conflict: Conflict; original: FolderEntry | null };

/** Opens a file of a folder (through the library, as search hits do). */
const open = (root: string, rootName: string, entry: FolderEntry) =>
  openDoc(
    { key: entry.id, place: { kind: 'folder', root, rootName, entry }, name: entry.name, size: entry.size, modified: entry.modified, title: '', sender: '', type: '', tags: [], date: '' },
    0,
    '',
  );

/** Sync issues: documents changed on two devices at once (Syncthing's conflict copies), and documents filed twice. */
export default function Sync() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const conflicts = useIndex((s) => s.conflicts);
  const done = useIndex((s) => s.done);
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [groups, setGroups] = useState<IndexedDoc[][]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const archive = usePrefs((s) => s.archive);

  useEffect(() => {
    let alive = true;
    Promise.all(
      conflicts.map(async (c) => {
        const here = await folders.list(c.root, c.dir).catch(() => [] as FolderEntry[]);
        return { conflict: c, original: here.find((e) => e.name === c.name.original) ?? null };
      }),
    ).then((list) => alive && setPairs(list));
    allDocs().then((docs) => alive && setGroups(duplicates(docs, archive)));
    return () => {
      alive = false;
    };
  }, [conflicts, done, round, archive]);

  // Resolved files leave the lists (and the index) at once; the next pass reads the folders again.
  const act = async (op: () => Promise<string>, after: () => void) => {
    try {
      const done = await op();
      after();
      setNotice(done);
    } catch (e) {
      setNotice(opError(e));
    }
    setRound((r) => r + 1);
  };
  /** Whether `name` in `root` may go: to the trash in the archive; elsewhere for good, once that is confirmed. */
  const mayDelete = async (root: string, name: string) =>
    trashes(root) || (await ask({ title: t.syncDeleteAsk, body: t.syncDeleteBody(name), confirm: t.delete, destructive: true })) !== null;
  const kept = (root: string) => (trashes(root) ? t.syncKept : t.syncKeptDeleted);
  /** `replaced`: the original went to the trash (the copy took its name): read again on the next pass. */
  const dropPair = (pair: Pair, replaced = false) => {
    const { root, entry } = pair.conflict;
    forget(replaced && pair.original ? [`${root}:${pair.original.id}`] : [], [pair.conflict]);
    setPairs((ps) => ps?.filter((p) => p.conflict.entry.id !== entry.id) ?? null);
  };

  const keepOriginal = async (pair: Pair) => {
    const { root, dir, entry } = pair.conflict;
    if (!(await mayDelete(root, entry.name))) return;
    await act(async () => (await discard(root, dir, [entry]), kept(root)), () => dropPair(pair));
  };
  const keepCopy = async (pair: Pair) => {
    const { root, dir, entry, name } = pair.conflict;
    if (pair.original && !(await mayDelete(root, pair.original.name))) return;
    await act(async () => {
      if (pair.original) await discard(root, dir, [pair.original]);
      await folders.rename(root, dir, entry, name.original);
      return pair.original ? kept(root) : t.syncKeptDeleted;
    }, () => dropPair(pair, true));
  };
  const keepBoth = (pair: Pair) =>
    act(async () => {
      const { root, dir, entry, name } = pair.conflict;
      const dot = name.original.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.original.slice(0, dot), name.original.slice(dot)] : [name.original, ''];
      const both = `${stem} (${name.device})${ext}`;
      await folders.rename(root, dir, entry, both);
      return t.syncKeptBoth(both);
    }, () => dropPair(pair));
  const keepOne = (group: IndexedDoc[], keep: IndexedDoc) =>
    act(async () => {
      for (const d of group) if (d !== keep && d.place.kind === 'folder') await discard(d.place.root, d.place.dir, [d.place.entry]);
      return t.syncKept;
    }, () => {
      forget(group.filter((d) => d !== keep).map((d) => d.key));
      setGroups((gs) => gs.filter((g) => g !== group));
    });

  const shownPairs = pairs ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl - 4, gap: space.lg }}>
          <ScreenHeader title={t.syncTitle} up={() => goTab('documents')} />
          {pairs && !shownPairs.length && !groups.length && <T color={p.muted}>{t.syncNothing}</T>}

          {shownPairs.length > 0 && (
            <View style={{ gap: space.sm }}>
              <T v="kicker" color={p.muted}>
                {t.syncConflicts(shownPairs.length)}
              </T>
              <T v="caption" color={p.muted}>
                {t.syncConflictsNote}
              </T>
              {shownPairs.map((pair) => (
                <View key={pair.conflict.entry.id} testID="sync-conflict" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                  <T style={styles.title}>{pair.conflict.name.original}</T>
                  {pair.original ? (
                    <Version
                      label={t.syncThisVersion}
                      entry={pair.original}
                      onOpen={() => void open(pair.conflict.root, pair.conflict.rootName, pair.original!).catch((e) => setNotice(opError(e)))}
                      onKeep={() => void keepOriginal(pair)}
                      testID="sync-keep-original"
                    />
                  ) : (
                    <T v="caption" color={p.muted}>
                      {t.syncMissing}
                    </T>
                  )}
                  <Version
                    label={t.syncOtherVersion(pair.conflict.name.device, pair.conflict.name.at)}
                    entry={pair.conflict.entry}
                    onOpen={() => void open(pair.conflict.root, pair.conflict.rootName, pair.conflict.entry).catch((e) => setNotice(opError(e)))}
                    onKeep={() => void keepCopy(pair)}
                    testID="sync-keep-copy"
                  />
                  {pair.original && (
                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Button testID="sync-keep-both" kind="quiet" label={t.syncKeepBoth} onPress={() => void keepBoth(pair)} />
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          {groups.length > 0 && (
            <View style={{ gap: space.sm }}>
              <T v="kicker" color={p.muted}>
                {t.syncDuplicates(groups.length)}
              </T>
              <T v="caption" color={p.muted}>
                {t.syncDuplicatesNote}
              </T>
              {groups.slice(0, limit).map((group) => (
                <View key={group[0].hash} testID="sync-duplicate" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                  <T style={styles.title}>{group[0].title || group[0].name}</T>
                  {group.map((d) =>
                    d.place.kind === 'folder' ? (
                      <Version
                        key={d.key}
                        label={d.name}
                        where={whereIs(d.place)}
                        entry={d.place.entry}
                        onOpen={() => void openDoc(d, 0, '').catch((e) => setNotice(opError(e)))}
                        onKeep={() => void keepOne(group, d)}
                        testID="sync-keep-one"
                      />
                    ) : null,
                  )}
                </View>
              ))}
              {groups.length > limit && (
                <View style={{ flexDirection: 'row' }}>
                  <Button kind="quiet" label={t.showMore} onPress={() => setLimit(limit + PAGE)} />
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} />
    </View>
  );
}

/** One copy: what and where it is, when it changed and how big it is, then what can be done with it. */
function Version({ label, where, entry, onOpen, onKeep, testID }: { label: string; where?: string; entry: FolderEntry; onOpen: () => void; onKeep: () => void; testID: string }) {
  const p = usePalette();
  return (
    <View style={[styles.version, { borderColor: p.hairline }]}>
      <View style={styles.what}>
        <Icon name={where ? 'folder' : 'documents'} size={18} color={p.muted} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          {!!where && (
            <T v="label" style={{ fontFamily: fonts.sansMedium }}>
              {where}
            </T>
          )}
          <T v={where ? 'caption' : 'label'} color={where ? p.inkSoft : p.ink} numberOfLines={2}>
            {label}
          </T>
          <T v="caption" color={p.muted}>
            {[entry.modified ? t.dayTime(entry.modified) : '', entry.size ? t.fileSize(entry.size) : ''].filter(Boolean).join(' · ')}
          </T>
        </View>
      </View>
      <View style={styles.actions}>
        <Button kind="quiet" label={t.inboxOpen} onPress={onOpen} />
        <Button testID={testID} label={t.syncKeep} onPress={onKeep} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md },
  title: { fontFamily: fonts.sansMedium, fontSize: 15 },
  // Wide enough, the actions sit beside what they act on; on a phone, under it.
  version: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  what: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, flexGrow: 1, flexBasis: 280, minWidth: 0 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: space.sm, flexGrow: 1 },
});
