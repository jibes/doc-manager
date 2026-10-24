import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { deleteAll, deletesForGood, undoDelete } from '@/paper/archive/batch';
import { checkVersions, duplicateGroups, type DuplicateGroup } from '@/paper/archive/duplicates';
import { placeOf } from '@/paper/archive/facets';
import { allDocs, refreshSoon, useIndex } from '@/paper/archive/indexer';
import { openDoc, whereIs } from '@/paper/archive/Results';
import { realTitle } from '@/paper/archive/pdfInfo';
import type { IndexedDoc } from '@/paper/archive/search';
import { goTab, SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { Button, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { useNotice } from '@/paper/components/useNotice';
import { folders } from '@/core/lib/folders';
import { repo } from '@/core/storage';
import { fonts, radius, space } from '@/core/design/tokens';
import { opError, t } from '@/core/i18n';
import { useThrottled } from '@/core/lib/useThrottled';
import { ask } from '@/paper/state/ask';
import { closePane, usePane } from '@/paper/state/pane';
import { usePalette, usePrefs } from '@/paper/state/prefs';

/** A document's bytes, for telling versions apart (null when it can't be read). */
async function bytesOf(d: IndexedDoc): Promise<ArrayBuffer | null> {
  if (d.place.kind === 'folder') return (await folders.read(d.place.root, d.place.entry)).arrayBuffer();
  const src = await repo.source(d.place.id);
  return src.kind === 'bytes' ? src.bytes : null;
}

const name = (d: IndexedDoc) => realTitle(d.title) || d.name.replace(/\.pdf$/i, '');
const where = (d: IndexedDoc) => (d.place.kind === 'folder' ? whereIs(d.place) : t.placeTessel);

/** Documents there more than once: the same file, or older versions of one; each group says what removing the others frees. */
export default function Duplicates() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const changed = useThrottled(useIndex((s) => s.changed), 1500);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  // Removed just now: Undo brings them back from the trash until the notice goes (then they are let go).
  const { notice, id: noticeId, say, dismiss, action } = useNotice();
  const setNotice = say;
  useEffect(() => refreshSoon(), []);
  useEffect(() => {
    let alive = true;
    // Older versions only where the newer file really starts with the older one's bytes (else two filled-in
    // copies of one form would pass for versions of each other).
    const inTessel = (d: IndexedDoc) => placeOf(d, archive) === 'tessel';
    void allDocs()
      .then(async (docs) => {
        const isVersion = await checkVersions(docs.filter(inTessel), bytesOf);
        if (alive) setGroups(duplicateGroups(docs, inTessel, isVersion));
      })
      .catch(() => alive && setGroups([]));
    return () => {
      alive = false;
    };
  }, [changed, archive]);

  const resolve = async (g: DuplicateGroup) => {
    // Files outside the Tessel folder's trash are deleted for good: asked first.
    if (deletesForGood(g.others) && (await ask({ title: t.deleteTitle(g.others.length), body: t.deleteBody(g.others.length, name(g.others[0])), confirm: t.delete, destructive: true })) === null) return;
    try {
      const { trashed, settle } = await deleteAll(g.others);
      // The one beside the list goes with it.
      if (g.others.some((d) => d.key === usePane.getState().doc?.key)) closePane();
      setGroups((gs) => gs?.filter((x) => x !== g) ?? null);
      const all = trashed.reduce((k, x) => k + x.items.length, 0) === g.others.length;
      if (all) say(t.duplicatesFreed(t.fileSize(g.freed)), { undo: () => void undoDelete(trashed).then(() => refreshSoon(), (e: unknown) => say(opError(e))), settle });
      else {
        settle();
        say(t.duplicatesFreed(t.fileSize(g.freed)));
      }
    } catch (e) {
      setNotice(opError(e));
    }
  };

  const total = (groups ?? []).reduce((n, g) => n + g.freed, 0);
  return (
    <SubFrame sub="duplicates">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column, gap: space.md }}>
          <ScreenHeader title={t.duplicatesTitle} up={() => goTab('documents')} />
          {groups && !groups.length && <T color={p.muted}>{t.duplicatesNone}</T>}
          {!!groups?.length && (
            <T v="caption" color={p.muted} testID="duplicates-total">
              {t.duplicatesTotal(groups.length, t.fileSize(total))}
            </T>
          )}
          {groups?.map((g) => (
            <View key={g.keep.key} testID="duplicate-group" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
              <View style={styles.head}>
                <T v="kicker" color={p.muted} style={{ flex: 1 }}>
                  {`${g.kind === 'identical' ? t.duplicatesIdentical : t.duplicatesVersions} · ${t.duplicatesFrees(t.fileSize(g.freed))}`}
                </T>
                <Button testID="duplicate-resolve" kind="quiet" label={t.duplicatesRemove(g.others.length)} onPress={() => void resolve(g)} />
              </View>
              {[g.keep, ...g.others].map((d, i) => (
                <Pressable
                  key={d.key}
                  testID={i ? 'duplicate-other' : 'duplicate-keep'}
                  accessibilityRole="button"
                  onPress={() => void openDoc(d, undefined, '').catch((e) => setNotice(opError(e)))}
                  style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.row, { borderColor: p.hairline, backgroundColor: hovered ? p.raised : 'transparent' }]}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>
                      {name(d)}
                    </T>
                    <T v="caption" color={p.muted} numberOfLines={1}>
                      {/* The file's name too: copies of one document have the same title. */}
                      {[d.name, where(d), t.fileSize(d.size), t.day(d.modified)].join(' · ')}
                    </T>
                  </View>
                  <T v="label" color={i ? p.muted : p.accent}>
                    {i ? t.duplicatesGoes : t.duplicatesStays}
                  </T>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      <Toast message={notice} id={noticeId} onDismiss={dismiss} action={action} />
    </SubFrame>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
});
