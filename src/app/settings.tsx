import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { version } from '../../package.json';

import { Icon } from '@/paper/components/Icon';
import { Button, T } from '@/paper/components/primitives';
import { SubFrame, useColumnWidth } from '@/paper/components/AppNav';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Toast } from '@/paper/components/Toast';
import { fonts, radius, space } from '@/core/design/tokens';
import { aiMessage, opError, t } from '@/core/i18n';
import { flatten, hasFolders } from '@/paper/archive/flatten';
import { APP_ROOT_ID } from '@/core/lib/nesting';
import { folders } from '@/core/lib/folders';
import { changeTessel, documentsHere, importFolder } from '@/paper/archive/tessel';
import { shell } from '@/core/lib/shell';
import { showActions } from '@/paper/state/actions';
import { forget, viewedCount } from '@/paper/state/viewed';
import { useLibrary } from '@/paper/state/library';
import { downloadDoc } from '@/core/lib/fileActions';
import { schedule } from '@/paper/archive/indexer';
import { AppearancePicker } from '@/paper/reader/AppearancePanel';
import { aiInsecure, aiReady, aiUrl, testAi, type AiApi } from '@/paper/scan/ai';
import { anySignal } from '@/core/lib/signals';
import { hasLightSensor } from '@/paper/state/ambient';
import { ask } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';


/** Settings: appearance, the Tessel folder and the sources Tessel reads, syncing, and AI reading. */
export default function Settings() {
  const p = usePalette();
  const column = useColumnWidth();
  const insets = useSafeAreaInsets();
  const archive = usePrefs((s) => s.archive);
  const scroller = useRef<ScrollView>(null);
  // Where each section starts, for the index at the top.
  const [at, setAt] = useState<Record<string, number>>({});
  const mark = (key: string) => ({ onLayout: (e: { nativeEvent: { layout: { y: number } } }) => {
    const y = e.nativeEvent.layout.y;
    setAt((all) => (all[key] === y ? all : { ...all, [key]: y }));
  } });
  const [error, setError] = useState<string | null>(null);
  // Documents viewed and not kept, whose place this device remembers.
  const [viewed, setViewed] = useState(0);
  useEffect(() => void viewedCount().then(setViewed), []);
  // EPUB books from before Tessel was PDFs only: saved, then removed.
  const books = useLibrary((s) => s.books);
  const saveBooks = async () => {
    try {
      for (const b of books) await downloadDoc(b);
      setError(t.booksSaved(books.length));
    } catch {
      setError(t.opFailed);
    }
  };
  const removeBooks = async () => {
    if ((await ask({ title: t.booksRemoveAsk(books.length), body: t.booksRemoveBody, confirm: t.remove, destructive: true })) === null) return;
    await useLibrary.getState().forgetBooks();
  };

  // Folders left in the Tessel folder from before it was flat: moved out once, from here.
  const [nested, setNested] = useState(false);
  const tesselRoot = archive ?? APP_ROOT_ID;
  useEffect(() => {
    let alive = true;
    if (folders.supported) void hasFolders(tesselRoot).then((x) => alive && setNested(x), () => {});
    return () => {
      alive = false;
    };
  }, [tesselRoot]);
  const flattenNow = async () => {
    if ((await ask({ title: t.flattenAsk, body: t.flattenNote, confirm: t.flattenGo })) === null) return;
    try {
      const done = await flatten(tesselRoot);
      setError(t.flattenDone(done.moved, done.renamed, done.kept));
      setNested(await hasFolders(tesselRoot));
      schedule(300);
    } catch (e) {
      setError(opError(e));
    }
  };

  // The Tessel folder: which it is, and whether Android or the browser wants an OK for it again.
  const [where, setWhere] = useState<{ name: string | null; locked: boolean } | null>(null);
  const refresh = useCallback(() => {
    folders
      .roots(false)
      .then((rs) => {
        const r = rs.find((x) => x.id === tesselRoot);
        setWhere({ name: r?.kind === 'folder' ? r.name : null, locked: !!r?.locked });
      })
      .catch(() => setError(t.opFailed));
  }, [tesselRoot]);
  useEffect(refresh, [refresh]);

  // Another folder (null: this device's own): with documents here, asked whether they go along.
  const changeTo = async (to: string | null) => {
    const go = async (move: boolean) => {
      try {
        const moved = await changeTessel(to, move);
        setError(move ? t.tesselMoved(moved) : t.tesselChanged);
      } catch (e) {
        setError(e instanceof Error && e.message === 'denied' ? t.writeDenied : opError(e));
      }
      // The row follows by itself (it reads the folder again when the Tessel folder changes).
    };
    const here = await documentsHere().catch(() => 0);
    if (!here) return go(false);
    showActions(t.tesselChangeTitle, [
      { key: 'tessel-move', icon: 'move', label: t.tesselMove(here), onPress: () => void go(true) },
      { key: 'tessel-leave', icon: 'close', label: t.tesselLeave(here), onPress: () => void go(false) },
    ]);
  };
  const choose = async () => {
    const r = await folders.add().catch(() => void setError(t.opFailed));
    if (r && r.id !== archive) await changeTo(r.id);
  };
  const unlock = async () => {
    await folders.unlock(tesselRoot, true).catch(() => false);
    refresh();
    schedule(300);
  };
  const importNow = async () => {
    const n = await importFolder((done, total) => setError(t.importingFolder(done, total))).catch((e: unknown) => (setError(opError(e)), null));
    if (n !== null) setError(t.importedFolder(n));
  };
  const sections: [string, string][] = [
    ['appearance', t.appearanceTitle],
    ...(folders.supported ? ([['folders', t.tesselFolderTitle]] as [string, string][]) : []),
    ...(folders.supported && archive ? ([['sync', t.syncTitle]] as [string, string][]) : []),
    ...(Platform.OS === 'web' ? ([['ai', t.aiTitle]] as [string, string][]) : []),
  ];
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
          {t.tesselFolderTitle}
        </T>
        {!folders.supported ? (
          <T color={p.muted}>{t.foldersUnsupported}</T>
        ) : (
          <>
            <View testID="tessel-folder" style={[styles.card, styles.row, { backgroundColor: p.surface, borderColor: p.hairline, paddingRight: space.lg }]}>
              <Icon name="folder" color={p.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="label" numberOfLines={1} style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>
                  {where?.name ?? (shell ? t.tesselAppFolder : t.tesselBrowser)}
                </T>
                <T v="caption" color={p.muted} numberOfLines={2}>
                  {where?.name ? t.tesselChosenNote : shell ? t.tesselAppFolderNote : t.tesselBrowserNote}
                </T>
              </View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
              {where?.locked && <Button testID="tessel-unlock" kind="quiet" label={t.allowAccess} onPress={() => void unlock()} />}
              {folders.canAdd && <Button testID="tessel-choose" kind="quiet" icon="folderAdd" label={archive ? t.tesselChange : t.tesselChoose} onPress={() => void choose()} />}
              {!!archive && <Button testID="tessel-device" kind="quiet" label={shell ? t.tesselUseAppFolder : t.tesselUseBrowser} onPress={() => void changeTo(null)} />}
            </View>
            <T v="caption" color={p.muted} style={styles.note}>
              {t.tesselNote}
            </T>
            {folders.canAdd && (
              <>
                <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
                  {t.importFolderTitle}
                </T>
                <View style={{ flexDirection: 'row' }}>
                  <Button testID="import-folder" kind="quiet" icon="plus" label={t.importFolder} onPress={() => void importNow()} />
                </View>
                <T v="caption" color={p.muted} style={styles.note}>
                  {t.importFolderNote}
                </T>
              </>
            )}
            {nested && (
              <>
                <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
                  {t.flattenTitle}
                </T>
                <T v="caption" color={p.muted} style={[styles.note, { marginTop: 0 }]}>
                  {t.flattenNote}
                </T>
                <View style={{ flexDirection: 'row', marginTop: space.md }}>
                  <Button testID="flatten" kind="quiet" icon="up" label={t.flattenGo} onPress={() => void flattenNow()} />
                </View>
              </>
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

        {books.length > 0 && (
          <>
            <T v="kicker" color={p.muted} style={[styles.kicker, { marginTop: space.xxl }]}>
              {t.booksTitle}
            </T>
            <T v="caption" color={p.muted} style={styles.note} testID="books-note">
              {t.booksNote(books.length)}
            </T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
              <Button testID="books-save" kind="quiet" icon="install" label={t.booksSave} onPress={() => void saveBooks()} />
              <Button testID="books-remove" kind="quiet" icon="trash" label={t.booksRemove} onPress={() => void removeBooks()} />
            </View>
          </>
        )}
        <T testID="app-version" v="caption" color={p.muted} style={{ marginTop: space.xxl }}>
          {t.appVersion(version)}
        </T>
      </View>
    </ScrollView>
    {/* Over the screen, not the scrolled content. */}
    <Toast message={error} onDismiss={() => setError(null)} />
    </SubFrame>
  );
}

/** With an archive: whether this device sorts its inbox. */
function SyncSection() {
  const p = usePalette();
  const inboxHere = usePrefs((s) => s.inboxHere);
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
        </>
      )}
    </>
  );
}

/** The AI model scans can be read with: API type, address, key, model, and a test. */
function AiSection() {
  const p = usePalette();
  const ai = usePrefs((s) => s.ai);
  const improveAdded = usePrefs((s) => s.improveAdded);
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
      {aiReady(ai) && (
        <>
          <Pressable
            testID="improve-added"
            accessibilityRole="switch"
            accessibilityLabel={t.improveAdded}
            aria-checked={improveAdded}
            onPress={() => setPrefs({ improveAdded: !improveAdded })}
            style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.card,
              styles.row,
              { backgroundColor: hovered ? p.raised : p.surface, borderColor: p.hairline, paddingRight: space.lg, marginTop: space.lg },
            ]}
          >
            <T v="label" style={{ flex: 1, fontFamily: fonts.sansMedium, fontSize: 15 }}>
              {t.improveAdded}
            </T>
            <View style={[styles.track, { backgroundColor: improveAdded ? p.accent : p.hairline }]}>
              <View style={[styles.knob, { backgroundColor: p.surface, transform: [{ translateX: improveAdded ? 18 : 0 }] }]} />
            </View>
          </Pressable>
          <T v="caption" color={p.muted} style={styles.note}>
            {t.improveAddedNote}
          </T>
        </>
      )}
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
