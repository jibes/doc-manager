import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { SubFrame, useColumnWidth } from '@/components/AppNav';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { fonts, radius, space } from '@/design/tokens';
import { aiMessage, t } from '@/i18n';
import { folders, type FolderRoot } from '@/lib/folders';
import { nestingNote } from './files';
import { forget, viewedCount } from '@/state/viewed';
import { shareNow, useSharing } from '@/archive/sharing';
import { schedule } from '@/archive/indexer';
import { setArchive } from '@/archive/views';
import { AppearancePicker } from '@/reader/AppearancePanel';
import { aiInsecure, aiUrl, testAi, type AiApi } from '@/scan/ai';
import { anySignal } from '@/lib/signals';
import { hasLightSensor } from '@/state/ambient';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';


/** Settings: the folders Tessel may browse and, in the Android app, optional access to all files. */
export default function Settings() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const allFiles = usePrefs((s) => s.allFiles);
  const archive = usePrefs((s) => s.archive);
  const scroller = useRef<ScrollView>(null);
  // Where each section starts, for the index at the top.
  const [at, setAt] = useState<Record<string, number>>({});
  const mark = (key: string) => ({ onLayout: (e: { nativeEvent: { layout: { y: number } } }) => {
    const y = e.nativeEvent.layout.y;
    setAt((all) => (all[key] === y ? all : { ...all, [key]: y }));
  } });
  const setPrefs = usePrefs((s) => s.set);
  const [picked, setPicked] = useState<FolderRoot[] | null>(null);
  const [granted, setGranted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Documents viewed and not kept, whose place this device remembers.
  const [viewed, setViewed] = useState(0);
  useEffect(() => void viewedCount().then(setViewed), []);

  const refresh = useCallback(() => {
    folders
      .roots(false)
      .then(setPicked)
      .catch(() => setError(t.opFailed));
    if (folders.allFilesSupported) folders.allFiles().then(setGranted, () => setGranted(false));
  }, []);
  useEffect(refresh, [refresh]);

  const add = async () => {
    const r = await folders.add().catch(() => void setError(t.opFailed));
    const note = r && (await nestingNote(r));
    if (note) setError(note);
    refresh();
    schedule(1000);
  };
  // The archive folder: asked first, and it stops being the archive.
  const remove = async (f: FolderRoot) => {
    if (f.id === archive) {
      if ((await ask({ title: t.removeArchiveAsk(f.name), body: t.removeArchiveBody, confirm: t.remove, destructive: true })) === null) return;
      await setArchive(null).catch(() => {});
    }
    await folders.forget(f.id).catch(() => setError(t.opFailed));
    refresh();
    schedule(1000);
  };
  const chooseArchive = (id: string | null) => setArchive(id).catch(() => setError(t.viewFailed));
  const allOn = allFiles && granted === true;
  const sections: [string, string][] = [
    ['appearance', t.appearanceTitle],
    ...(folders.supported ? ([['folders', t.foldersTitle]] as [string, string][]) : []),
    ...(folders.supported && archive ? ([['sync', t.syncTitle]] as [string, string][]) : []),
    ...(Platform.OS === 'web' ? ([['ai', t.aiTitle]] as [string, string][]) : []),
  ];
  // The index follows at once: the device's other documents are read, or leave Documents.
  const toggleAll = async (on: boolean) => {
    if (!on) {
      setPrefs({ allFiles: false });
      return schedule(300);
    }
    const ok = await folders.requestAllFiles().catch(() => false);
    setGranted(ok);
    if (ok) {
      setPrefs({ allFiles: true });
      schedule(300);
    }
  };

  return (
    <SubFrame sub="settings">
    <ScrollView
      ref={scroller}
      style={{ flex: 1, backgroundColor: p.canvas }}
      contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl }}
    >
      <View style={{ width: column }}>
        <ScreenHeader title={t.settings} />

        <View testID="settings-index" style={styles.index}>
          {sections.map(([key, label]) => (
            <Pressable
              key={key}
              testID={`settings-go-${key}`}
              accessibilityRole="link"
              onPress={() => at[key] !== undefined && scroller.current?.scrollTo({ y: at[key] + insets.top, animated: true })}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.indexItem, { borderColor: p.hairline, backgroundColor: hovered ? p.raised : 'transparent' }]}
            >
              <T v="label" color={p.inkSoft}>
                {label}
              </T>
            </Pressable>
          ))}
        </View>

        <T v="kicker" color={p.muted} style={styles.kicker} {...mark('appearance')}>
          {t.appearanceTitle}
        </T>
        <View testID="settings-theme" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline, padding: space.lg }]}>
          <AppearancePicker />
        </View>
        <T v="caption" color={p.muted} style={styles.note}>
          {hasLightSensor ? t.appearanceNoteSensor : t.appearanceNoteSystem} {t.appearanceNote}
        </T>

        <View style={{ height: space.xxl }} />

        <T v="kicker" color={p.muted} style={styles.kicker} {...mark('folders')}>
          {t.foldersTitle}
        </T>
        {!folders.supported ? (
          <T color={p.muted}>{t.foldersUnsupported}</T>
        ) : (
          <>
            {picked && picked.length > 0 && (
              <View testID="settings-folders" style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                {picked.map((f, i) => {
                  const isArchive = f.id === archive;
                  return (
                    <View key={f.id} style={[styles.row, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0 }]}>
                      <Icon name="folder" color={p.accent} />
                      <T v="label" numberOfLines={1} style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
                        {f.name}
                      </T>
                      {(f.kind === 'folder' || f.kind === 'app') && (
                        // The archive is a mark on one of the folders: a tap sets it, another takes it off.
                        <Pressable
                          testID="archive-root"
                          accessibilityRole="switch"
                          accessibilityLabel={t.archiveUse(f.name)}
                          aria-checked={isArchive}
                          onPress={() => chooseArchive(isArchive ? null : f.id)}
                          hitSlop={6}
                          style={[styles.archiveMark, { borderColor: isArchive ? p.markRing : p.hairline, backgroundColor: isArchive ? p.mark : 'transparent' }]}
                        >
                          <Icon name={isArchive ? 'check' : 'inbox'} size={14} color={isArchive ? p.ink : p.muted} />
                          <T v="label" color={isArchive ? p.ink : p.muted}>
                            {t.archiveMark}
                          </T>
                        </Pressable>
                      )}
                      <IconButton testID="remove-folder" icon="close" size={36} label={t.removeFolder(f.name)} onPress={() => void remove(f)} />
                    </View>
                  );
                })}
              </View>
            )}
            <View style={{ flexDirection: 'row', marginTop: space.md }}>
              <Button testID="settings-add-folder" kind="quiet" icon="folderAdd" label={t.addFolder} onPress={add} />
            </View>
            <T v="caption" color={p.muted} style={styles.note}>
              {t.foldersNote} {picked?.length ? t.archiveFolderNote : ''}
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

        {folders.supported && !!archive && (
          <View {...mark('sync')}>
            <SyncSection />
          </View>
        )}

        {Platform.OS === 'web' && (
          <View {...mark('ai')}>
            <AiSection />
          </View>
        )}

        {viewed > 0 && (
          <>
            <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
              {t.viewedHistory}
            </T>
            <T v="caption" color={p.muted} style={styles.note}>
              {t.viewedHistoryNote(viewed)}
            </T>
            <View style={{ flexDirection: 'row', marginTop: space.md }}>
              <Button testID="viewed-forget" kind="quiet" label={t.viewedClear} onPress={() => void forget().then(() => (setViewed(0), setError(t.viewedCleared)))} />
            </View>
          </>
        )}
      </View>
    </ScrollView>
    {/* Over the screen, not the scrolled content. */}
    <Toast message={error} onDismiss={() => setError(null)} />
    </SubFrame>
  );
}

/** With an archive: whether this device sorts its inbox, and whether reading is shared through it. */
function SyncSection() {
  const p = usePalette();
  const inboxHere = usePrefs((s) => s.inboxHere);
  const shareReading = usePrefs((s) => s.shareReading);
  const sharedWith = useSharing((s) => s.devices);
  const setPrefs = usePrefs((s) => s.set);
  return (
    <>
      <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
        {t.syncTitle}
      </T>
      {(
        <>
          <Pressable
            testID="inbox-here-switch"
            accessibilityRole="switch"
            accessibilityLabel={t.inboxHere}
            aria-checked={inboxHere}
            onPress={() => setPrefs({ inboxHere: !inboxHere })}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.card,
              styles.row,
              { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, paddingRight: space.lg },
            ]}
          >
            <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
              {t.inboxHere}
            </T>
            <View style={[styles.track, { backgroundColor: inboxHere ? p.accent : p.hairline }]}>
              <View style={[styles.knob, { backgroundColor: p.surface, transform: [{ translateX: inboxHere ? 18 : 0 }] }]} />
            </View>
          </Pressable>
          <T v="caption" color={p.muted} style={styles.note}>
            {t.inboxHereNote} {t.inboxOtherDevice}
          </T>
          <Pressable
            testID="share-reading-switch"
            accessibilityRole="switch"
            accessibilityLabel={t.shareReading}
            aria-checked={shareReading}
            onPress={() => {
              setPrefs({ shareReading: !shareReading });
              if (!shareReading) void shareNow();
            }}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.card,
              styles.row,
              { marginTop: space.lg, backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, paddingRight: space.lg },
            ]}
          >
            <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
              {t.shareReading}
            </T>
            <View style={[styles.track, { backgroundColor: shareReading ? p.accent : p.hairline }]}>
              <View style={[styles.knob, { backgroundColor: p.surface, transform: [{ translateX: shareReading ? 18 : 0 }] }]} />
            </View>
          </Pressable>
          <T v="caption" color={p.muted} style={styles.note} testID="share-reading-note">
            {t.shareReadingNote} {shareReading && sharedWith > 0 ? t.shareReadingWith(sharedWith) : ''}
          </T>
        </>
      )}
    </>
  );
}

/** The AI model scans can be read with: API type, address, key, model, and a test. */
function AiSection() {
  const p = usePalette();
  const ai = usePrefs((s) => s.ai);
  const setPrefs = usePrefs((s) => s.set);
  const [status, setStatus] = useState<string | null>(null);
  // The test under way: a change to the settings stops it (its answer would be about the old ones).
  const [running, setRunning] = useState<AbortController | null>(null);
  const testing = running !== null;
  const set = (patch: Partial<typeof ai>) => {
    running?.abort();
    setRunning(null);
    setStatus(null);
    setPrefs({ ai: { ...ai, ...patch } });
  };
  const test = async () => {
    const ctrl = new AbortController();
    setRunning(ctrl);
    setStatus(t.aiTesting);
    await testAi(ai, anySignal([ctrl.signal, AbortSignal.timeout(60_000)])).then(
      () => !ctrl.signal.aborted && setStatus(t.aiTestOk),
      (e: unknown) => !ctrl.signal.aborted && setStatus(t.aiTestFailed(aiMessage(e))),
    );
    setRunning((cur) => (cur === ctrl ? null : cur));
  };
  const insecure = aiInsecure(ai);
  const badUrl = !!ai.url.trim() && !aiUrl(ai) && !insecure;
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
        accessibilityLabel={label}
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
        {(badUrl || insecure) && (
          <T v="caption" color={p.markRing} testID="ai-url-bad" style={{ marginTop: -space.sm }}>
            {insecure ? t.aiUrlInsecure : t.aiUrlBad}
          </T>
        )}
        {field('ai-key', t.aiKey, ai.key, (key) => set({ key }), undefined, true)}
        {field('ai-model', t.aiModel, ai.model, (model) => set({ model }), t.aiModelHint(ai.api))}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <Button testID="ai-test" kind="quiet" label={t.aiTest} disabled={testing || badUrl || insecure || !ai.url.trim()} onPress={() => void test()} />
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
  index: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.xl },
  indexItem: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 32, justifyContent: 'center' },
  archiveMark: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 30 },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 56 },
  note: { marginTop: space.md, maxWidth: 560 },
  track: { width: 42, height: 24, borderRadius: 12, padding: 3 },
  knob: { width: 18, height: 18, borderRadius: 9, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
});
