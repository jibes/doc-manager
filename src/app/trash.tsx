import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KEEP_DAYS } from '@/archive/sync';
import { deleteForever, purge, restore, useTrash, type TrashItem } from '@/archive/trash';
import { goTab, SubFrame, useColumnWidth } from '@/components/AppNav';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { opError, t } from '@/i18n';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';


/** The archive's trash: restore what was deleted, or delete it for good (it goes by itself after 30 days). */
export default function Trash() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const items = useTrash((s) => s.items);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Days left are counted from when the screen opened.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    if (!archive) return;
    purge(archive).then(
      () => setLoaded(true),
      (e) => (setLoaded(true), setNotice(opError(e))),
    );
  }, [archive]);

  const run = (op: () => Promise<void>) => op().catch((e) => setNotice(opError(e)));
  const emptyAll = async () => {
    if (!archive || (await ask({ title: t.trashEmptyAsk(items.length), confirm: t.trashEmptyAll, destructive: true })) === null) return;
    await run(() => deleteForever(archive, items.map((i) => i.name)));
  };
  const deleteOne = async (item: TrashItem) => {
    if (!archive || (await ask({ title: t.trashEmptyAsk(1), body: item.original, confirm: t.trashDeleteForever, destructive: true })) === null) return;
    await run(() => deleteForever(archive, [item.name]));
  };

  return (
    <SubFrame sub="trash">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: column, gap: space.md }}>
          <ScreenHeader title={t.trashTitle} up={() => goTab('documents', 'folders')}>
            {items.length > 0 && <Button testID="trash-empty" kind="quiet" label={t.trashEmptyAll} onPress={() => void emptyAll()} />}
          </ScreenHeader>
          {!archive ? (
            <T color={p.muted}>{t.trashNoArchive}</T>
          ) : (
            <>
              {loaded && !items.length && <T color={p.muted}>{t.trashEmpty}</T>}
              {items.length > 0 && (
                <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                  {items.map((item, i) => {
                    const name = item.title || item.original;
                    const left = KEEP_DAYS - Math.floor((now - item.deletedAt) / 86_400_000);
                    return (
                      <View key={item.name} testID="trash-item" style={[styles.row, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
                        <View style={styles.what}>
                          <Icon name={item.entry.kind === 'dir' ? 'folder' : 'documents'} size={20} color={p.muted} />
                          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                            <T numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>
                              {name}
                            </T>
                            {/* What it was, where it was, and how long it stays. */}
                            {!!(item.title || item.path?.length) && (
                              <T v="caption" color={p.inkSoft} numberOfLines={2}>
                                {[item.title ? item.original : '', item.path?.length ? t.trashFrom(item.path.join(' / ')) : ''].filter(Boolean).join(' · ')}
                              </T>
                            )}
                            <T v="caption" color={p.muted}>
                              {`${t.trashDeletedAt(t.day(item.deletedAt))} · ${t.trashDaysLeft(left)}`}
                            </T>
                          </View>
                        </View>
                        <View style={styles.actions}>
                          <Button testID="trash-restore" kind="quiet" label={t.trashRestore} a11yLabel={`${t.trashRestore}: ${name}`} onPress={() => void run(() => restore(archive, [item]))} />
                          <IconButton testID="trash-delete" icon="trash" size={36} label={`${t.trashDeleteForever}: ${name}`} onPress={() => void deleteOne(item)} />
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
              <T v="caption" color={p.muted}>
                {t.trashNote}
              </T>
            </>
          )}
        </View>
      </ScrollView>
      <Toast message={notice} onDismiss={() => setNotice(null)} />
    </SubFrame>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  // Wide enough, the actions sit beside what they act on; on a phone (German: "Wiederherstellen"), under it.
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space.md, rowGap: space.xs, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  what: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginLeft: 'auto' },
});
