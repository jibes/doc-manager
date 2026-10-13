import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders, type FolderRoot } from '@/lib/folders';
import { AppearancePicker } from '@/reader/AppearancePanel';
import { hasLightSensor } from '@/state/ambient';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 720;

/** Settings: the folders Tessel may browse and, in the Android app, optional access to all files. */
export default function Settings() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const allFiles = usePrefs((s) => s.allFiles);
  const setPrefs = usePrefs((s) => s.set);
  const [picked, setPicked] = useState<FolderRoot[] | null>(null);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    folders
      .roots(false)
      .then(setPicked)
      .catch(() => setError(t.opFailed));
    if (folders.allFilesSupported) folders.allFiles().then(setGranted, () => setGranted(false));
  }, []);
  useEffect(refresh, [refresh]);

  const add = async () => {
    await folders.add().catch(() => setError(t.opFailed));
    refresh();
  };
  const remove = async (id: string) => {
    await folders.forget(id).catch(() => setError(t.opFailed));
    refresh();
  };
  const allOn = allFiles && granted === true;
  const toggleAll = async (on: boolean) => {
    if (!on) return setPrefs({ allFiles: false });
    const ok = await folders.requestAllFiles().catch(() => false);
    setGranted(ok);
    if (ok) setPrefs({ allFiles: true });
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.canvas }}
      contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}
    >
      <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl - 4 }}>
        <ScreenHeader title={t.settings} />

        <T v="kicker" color={p.muted} style={styles.kicker}>
          {t.appearanceTitle}
        </T>
        <View testID="settings-theme" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline, padding: space.lg }]}>
          <AppearancePicker />
        </View>
        <T v="caption" color={p.muted} style={styles.note}>
          {hasLightSensor ? t.appearanceNoteSensor : t.appearanceNoteSystem} {t.appearanceNote}
        </T>

        <View style={{ height: space.xxl }} />

        <T v="kicker" color={p.muted} style={styles.kicker}>
          {t.foldersTitle}
        </T>
        {!folders.supported ? (
          <T color={p.muted}>{t.foldersUnsupported}</T>
        ) : (
          <>
            {picked && picked.length > 0 && (
              <View testID="settings-folders" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                {picked.map((f, i) => (
                  <View key={f.id} style={[styles.row, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
                    <Icon name="folder" color={p.accent} />
                    <T v="label" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
                      {f.name}
                    </T>
                    <IconButton testID="remove-folder" icon="close" size={36} label={t.removeFolder(f.name)} onPress={() => remove(f.id)} />
                  </View>
                ))}
              </View>
            )}
            <View style={{ flexDirection: 'row', marginTop: space.md }}>
              <Button testID="settings-add-folder" kind="quiet" icon="folderAdd" label={t.addFolder} onPress={add} />
            </View>
            <T v="caption" color={p.muted} style={styles.note}>
              {t.foldersNote}
            </T>
          </>
        )}

        {folders.allFilesSupported && (
          <>
            <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
              {t.allFilesTitle}
            </T>
            {/* The whole row is the switch: easier to hit than the knob alone. */}
            <Pressable
              testID="all-files"
              accessibilityRole="switch"
              accessibilityLabel={t.allFilesSwitch}
              accessibilityState={{ checked: allOn }}
              aria-checked={allOn}
              onPress={() => toggleAll(!allOn)}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                styles.card,
                styles.row,
                { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, paddingRight: space.lg },
              ]}
            >
              <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
                {t.allFilesSwitch}
              </T>
              <View style={[styles.track, { backgroundColor: allOn ? p.accent : p.hairline }]}>
                <View style={[styles.knob, { backgroundColor: p.surface, transform: [{ translateX: allOn ? 18 : 0 }] }]} />
              </View>
            </Pressable>
            <T v="caption" color={p.muted} style={styles.note}>
              {t.allFilesNote}
            </T>
            {allFiles && granted === false && (
              <View style={{ gap: space.sm, marginTop: space.md, alignItems: 'flex-start' }}>
                <T v="caption" color={p.accent}>
                  {t.allFilesDenied}
                </T>
                <Button kind="quiet" label={t.allowAccess} onPress={() => toggleAll(true)} />
              </View>
            )}
            {!allFiles && granted === true && (
              <T v="caption" color={p.muted} style={styles.note}>
                {t.allFilesOffNote}
              </T>
            )}
          </>
        )}
      </View>
      <Toast message={error} onDismiss={() => setError(null)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  kicker: { marginBottom: space.md },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 56 },
  note: { marginTop: space.md, maxWidth: 560 },
  track: { width: 42, height: 24, borderRadius: 12, padding: 3 },
  knob: { width: 18, height: 18, borderRadius: 9, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
});
