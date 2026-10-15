import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { deleteForever, purge, restore, useTrash, type TrashItem } from '@/archive/trash';
import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { opError, t } from '@/i18n';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 820;

/** The archive's trash: restore what was deleted, or delete it for good (it goes by itself after 30 days). */
export default function Trash() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const items = useTrash((s) => s.items);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}>
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl - 4, gap: space.md }}>
          <ScreenHeader title={t.trashTitle}>
            {items.length > 0 && <Button testID="trash-empty" kind="quiet" label={t.trashEmptyAll} onPress={() => void emptyAll()} />}
          </ScreenHeader>
          {!archive ? (
            <T color={p.muted}>{t.inboxNoArchive}</T>
          ) : (
            <>
              {loaded && !items.length && <T color={p.muted}>{t.trashEmpty}</T>}
              {items.length > 0 && (
                <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                  {items.map((item, i) => (
                    <View key={item.name} testID="trash-item" style={[styles.row, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
                      <Icon name={item.entry.kind === 'dir' ? 'folder' : 'documents'} size={20} color={p.muted} />
                      <View style={{ flex: 1, gap: 2 }}>
                        <T numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>
                          {item.original}
                        </T>
                        <T v="caption" color={p.muted}>
                          {t.trashDeletedAt(t.day(item.deletedAt))}
                        </T>
                      </View>
                      <Button testID="trash-restore" kind="quiet" label={t.trashRestore} onPress={() => void run(() => restore(archive, [item]))} />
                      <IconButton testID="trash-delete" icon="trash" size={36} label={t.trashDeleteForever} onPress={() => void deleteOne(item)} />
                    </View>
                  ))}
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
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
});
