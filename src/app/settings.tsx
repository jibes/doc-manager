import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders, type FolderRoot } from '@/lib/folders';
import { AppearancePicker } from '@/reader/AppearancePanel';
import { testAi, type AiApi } from '@/scan/ai';
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

        {Platform.OS === 'web' && <AiSection />}
      </View>
      <Toast message={error} onDismiss={() => setError(null)} />
    </ScrollView>
  );
}

/** The AI model scans can be read with: API type, address, key, model, and a test. */
function AiSection() {
  const p = usePalette();
  const ai = usePrefs((s) => s.ai);
  const setPrefs = usePrefs((s) => s.set);
  const [status, setStatus] = useState<string | null>(null);
  const set = (patch: Partial<typeof ai>) => {
    setStatus(null);
    setPrefs({ ai: { ...ai, ...patch } });
  };
  const test = async () => {
    setStatus(t.aiTesting);
    try {
      await testAi(ai);
      setStatus(t.aiTestOk);
    } catch (e) {
      setStatus(t.aiTestFailed(e instanceof Error ? e.message : String(e)));
    }
  };
  const field = (testID: string, label: string, value: string, onChange: (v: string) => void, placeholder?: string, secret?: boolean) => (
    <View style={{ gap: space.xs }}>
      <T v="caption" color={p.muted}>
        {label}
      </T>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: p.ink, borderColor: p.hairline, backgroundColor: p.canvas }]}
      />
    </View>
  );
  const apis: [AiApi, string][] = [
    ['anthropic', t.aiApiAnthropic],
    ['openai', t.aiApiOpenAi],
  ];
  return (
    <>
      <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
        {t.aiTitle}
      </T>
      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline, padding: space.lg, gap: space.lg }]}>
        <View style={{ gap: space.xs }}>
          <T v="caption" color={p.muted}>
            {t.aiApi}
          </T>
          <View accessibilityRole="radiogroup" style={[styles.segment, { backgroundColor: p.hairline }]}>
            {apis.map(([k, label]) => (
              <Pressable
                key={k}
                testID={`ai-api-${k}`}
                accessibilityRole="radio"
                aria-checked={ai.api === k}
                onPress={() => set({ api: k })}
                style={[styles.segBtn, ai.api === k && { backgroundColor: p.raised }]}
              >
                <T v="label" color={ai.api === k ? p.ink : p.muted}>
                  {label}
                </T>
              </Pressable>
            ))}
          </View>
        </View>
        {field('ai-url', t.aiUrl, ai.url, (url) => set({ url }), t.aiUrlHint(ai.api))}
        {field('ai-key', t.aiKey, ai.key, (key) => set({ key }), undefined, true)}
        {field('ai-model', t.aiModel, ai.model, (model) => set({ model }), t.aiModelHint(ai.api))}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Button testID="ai-test" kind="quiet" label={t.aiTest} onPress={() => void test()} />
          {status && (
            <T testID="ai-status" v="caption" color={p.inkSoft} style={{ flex: 1 }}>
              {status}
            </T>
          )}
        </View>
      </View>
      <T v="caption" color={p.muted} style={styles.note}>
        {t.aiNote}
      </T>
    </>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, height: 40, fontFamily: fonts.sans, fontSize: 15 },
  segment: { flexDirection: 'row', borderRadius: radius.sm + 2, padding: 3 },
  segBtn: { flex: 1, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  kicker: { marginBottom: space.md },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 56 },
  note: { marginTop: space.md, maxWidth: 560 },
  track: { width: 42, height: 24, borderRadius: 12, padding: 3 },
  knob: { width: 18, height: 18, borderRadius: 9, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
});
