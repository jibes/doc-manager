import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Button, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { elevation, fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders, type FolderRoot } from '@/lib/folders';
import type { FilterId } from '@/scan/engine/imaging/filters';
import { isBlurred } from '@/scan/engine/imaging/sharpness';
import { defaultTitle } from '@/scan/export';
import { prefetchExports } from '@/scan/exportCache';
import { saveScan, type SaveProgress } from '@/scan/save';
import { useScan } from '@/scan/session';
import { FilterChips } from '@/scan/ui/FilterChips';
import { PageImage } from '@/scan/ui/PageImage';
import { Unsupported } from '@/scan/ui/Unsupported';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 960;
const TILE_MIN = 140;

/** The document being scanned: its pages, title, filter and where it is saved. */
export default function ScanReview() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { pages, title, loaded, restore, setTitle, applyToAll, clear } = useScan();
  const scan = usePrefs((s) => s.scan);
  const scanTo = usePrefs((s) => s.scanTo);
  const setPrefs = usePrefs((s) => s.set);
  const [roots, setRoots] = useState<FolderRoot[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const saving = useRef<AbortController | null>(null);
  const placeholder = useMemo(() => defaultTitle(), []);
  const dismiss = useCallback(() => setMessage(null), []);

  useEffect(() => void restore(), [restore]);
  useEffect(() => {
    folders.roots(false).then(setRoots, () => setRoots([]));
  }, []);
  // Render (and read) the pages in the background while the user looks them over, so saving is quick.
  useEffect(() => {
    if (pages.length) prefetchExports(pages, scan);
  }, [pages, scan]);

  const target = roots.find((r) => r.id === scanTo) ?? null;
  const common = pages.every((pg) => pg.spec.filter === pages[0]?.spec.filter) ? (pages[0]?.spec.filter ?? scan.defaultFilter) : null;
  const columns = Math.max(2, Math.floor((Math.min(width, MAX_W) - space.xl * 2 + space.md) / (TILE_MIN + space.md)));
  const tile = (Math.min(width, MAX_W) - space.xl * 2 - space.md * (columns - 1)) / columns;

  const setFilter = (filter: FilterId) => {
    applyToAll(filter);
    setPrefs({ scan: { ...scan, defaultFilter: filter } });
  };

  const save = async () => {
    if (saving.current || !pages.length) return;
    const controller = new AbortController();
    saving.current = controller;
    setProgress({ phase: 'render', done: 0, total: pages.length });
    try {
      const doc = await saveScan(pages, scan, title.trim() || placeholder, target, setProgress, controller.signal);
      clear();
      if (doc) router.replace({ pathname: '/read/[id]', params: { id: doc.id } });
      else router.replace('/');
    } catch (e) {
      if (!controller.signal.aborted) setMessage(t.scanSaveFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      saving.current = null;
      setProgress(null);
    }
  };

  const discard = async () => {
    const answer = await ask({ title: t.scanDiscardTitle, body: t.scanDiscardBody(pages.length), confirm: t.scanDiscard, destructive: true });
    if (answer === null) return;
    clear();
    router.replace('/');
  };

  const addFolder = async () => {
    const root = await folders.add().catch(() => null);
    if (!root) return;
    setRoots(await folders.roots(false).catch(() => [root]));
    setPrefs({ scanTo: root.id });
    setChoosing(false);
  };

  if (Platform.OS !== 'web') return <Unsupported />;

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + 120 }}>
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl }}>
          <ScreenHeader title={t.scan} over={pages.length ? t.scanPages(pages.length) : undefined} />

          <TextInput
            testID="scan-title"
            value={title}
            onChangeText={setTitle}
            placeholder={placeholder}
            placeholderTextColor={p.muted}
            accessibilityLabel={t.scanTitle}
            style={[styles.title, { color: p.ink, borderColor: p.hairline, backgroundColor: p.surface }]}
          />

          {loaded && !pages.length ? (
            <View style={styles.empty}>
              <T color={p.muted}>{t.scanEmpty}</T>
              <Button label={t.scanOpenCamera} icon="camera" onPress={() => router.replace('/scan')} />
            </View>
          ) : (
            <View style={styles.grid}>
              {pages.map((page, i) => (
                <Pressable
                  key={page.id}
                  testID="scan-tile"
                  accessibilityRole="button"
                  accessibilityLabel={t.scanPageN(i + 1)}
                  onPress={() => router.push({ pathname: '/scan/page', params: { id: page.id } })}
                  style={({ pressed }) => [{ width: tile, opacity: pressed ? 0.75 : 1 }]}
                >
                  <View style={[styles.sheet, { height: tile * 1.32, backgroundColor: p.surface }, elevation(p.shadow, 1)]}>
                    <PageImage page={page} longEdge={520} channel={`tile-${page.id}`} />
                  </View>
                  <View style={styles.caption}>
                    <T v="numeral" color={p.muted}>
                      {i + 1}
                    </T>
                    {isBlurred(page) && (
                      <T v="caption" color={p.markRing}>
                        {t.scanBlurredShort}
                      </T>
                    )}
                  </View>
                </Pressable>
              ))}
              <Pressable
                testID="scan-add"
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/scan', params: { from: 'review' } })}
                style={({ pressed }) => [styles.add, { width: tile, height: tile * 1.32, borderColor: p.hairline, opacity: pressed ? 0.6 : 1 }]}
              >
                <Icon name="camera" color={p.inkSoft} size={26} />
                <T v="label" color={p.inkSoft}>
                  {t.scanAddPage}
                </T>
              </Pressable>
            </View>
          )}

          {pages.length > 0 && (
            <>
              <T v="kicker" color={p.muted} style={styles.kicker}>
                {t.scanFilter}
              </T>
              <FilterChips value={common} onChange={setFilter} />

              <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                <Pressable accessibilityRole="switch" accessibilityState={{ checked: scan.ocr }} onPress={() => setPrefs({ scan: { ...scan, ocr: !scan.ocr } })} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <T>{t.scanRecognise}</T>
                    <T v="caption" color={p.muted}>
                      {t.scanRecogniseNote}
                    </T>
                  </View>
                  <Switch value={scan.ocr} onValueChange={(ocr) => setPrefs({ scan: { ...scan, ocr } })} trackColor={{ true: p.accent }} />
                </Pressable>
                <View style={{ height: 1, backgroundColor: p.hairline }} />
                <Pressable testID="scan-destination" accessibilityRole="button" onPress={() => setChoosing(true)} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <T>{t.scanSaveTo}</T>
                    <T v="caption" color={p.muted} numberOfLines={1}>
                      {target ? target.name : t.scanLibraryOnly}
                    </T>
                  </View>
                  <Icon name="chevronRight" color={p.muted} size={20} />
                </Pressable>
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {pages.length > 0 && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + space.lg, backgroundColor: p.glass, borderColor: p.hairline }]}>
          <View style={{ width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xl }}>
            {progress ? (
              <>
                <T testID="scan-progress" v="label" color={p.inkSoft} style={{ flex: 1 }}>
                  {progress.phase === 'read' ? t.scanReading(progress.done + 1, progress.total) : t.scanPreparing(Math.min(progress.done + 1, progress.total), progress.total)}
                </T>
                <Button kind="quiet" label={t.cancel} onPress={() => saving.current?.abort()} />
              </>
            ) : (
              <>
                <Button kind="quiet" label={t.scanDiscard} onPress={() => void discard()} />
                <View style={{ flex: 1 }} />
                <Button testID="scan-save" label={t.scanSave} icon="check" onPress={() => void save()} />
              </>
            )}
          </View>
        </View>
      )}

      {choosing && (
        <Pressable accessibilityRole="button" accessibilityLabel={t.cancel} onPress={() => setChoosing(false)} style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: p.scrim }]}>
          <Pressable onPress={() => {}} style={[styles.sheetCard, { backgroundColor: p.surface, marginBottom: insets.bottom + space.lg }, elevation(p.shadow, 3)]}>
            <T v="headline" style={{ marginBottom: space.sm }}>
              {t.scanSaveTo}
            </T>
            <Choice icon="pages" label={t.scanLibraryOnly} note={t.scanLibraryNote} on={!target} onPress={() => (setPrefs({ scanTo: null }), setChoosing(false))} />
            {roots.map((r) => (
              <Choice key={r.id} icon="folder" label={r.name} on={target?.id === r.id} onPress={() => (setPrefs({ scanTo: r.id }), setChoosing(false))} />
            ))}
            {folders.supported && <Choice icon="folderAdd" label={t.scanOtherFolder} onPress={() => void addFolder()} />}
          </Pressable>
        </Pressable>
      )}
      <Toast message={message} onDismiss={dismiss} />
    </View>
  );
}

function Choice({ icon, label, note, on, onPress }: { icon: 'pages' | 'folder' | 'folderAdd'; label: string; note?: string; on?: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: !!on }} onPress={onPress} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.choice, pressed && { opacity: 0.7 }, hovered && { backgroundColor: p.hairline }]}>
      <Icon name={icon} color={on ? p.accent : p.inkSoft} size={20} />
      <View style={{ flex: 1 }}>
        <T color={on ? p.accent : p.ink} numberOfLines={1}>
          {label}
        </T>
        {note ? (
          <T v="caption" color={p.muted}>
            {note}
          </T>
        ) : null}
      </View>
      {on && <Icon name="check" color={p.accent} size={18} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.serif, fontSize: 20, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, marginBottom: space.xl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  sheet: { borderRadius: radius.sm, overflow: 'hidden', padding: 4 },
  caption: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: space.xs, paddingHorizontal: 2 },
  add: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', gap: space.sm },
  empty: { alignItems: 'flex-start', gap: space.lg, paddingVertical: space.xl },
  kicker: { marginTop: space.xxl, marginBottom: space.sm },
  card: { borderWidth: 1, borderRadius: radius.md, marginTop: space.xl, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: space.md, borderTopWidth: 1 },
  scrim: { justifyContent: 'flex-end', alignItems: 'center', padding: space.lg },
  sheetCard: { width: '100%', maxWidth: 480, borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.sm, borderRadius: radius.sm },
});
