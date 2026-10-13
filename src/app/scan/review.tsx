import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Button, IconButton, T } from '@/components/primitives';
import { ScreenHeader } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { elevation, fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders, type FolderRoot } from '@/lib/folders';
import { shell } from '@/lib/shell';
import type { FilterId } from '@/scan/engine/imaging/filters';
import { isBlurred } from '@/scan/engine/imaging/sharpness';
import { defaultTitle } from '@/scan/export';
import { prefetchExports } from '@/scan/exportCache';
import { saveScan, type SaveProgress } from '@/scan/save';
import { aiHost, aiReady } from '@/scan/ai';
import { useScan } from '@/scan/session';
import { FilterChips } from '@/scan/ui/FilterChips';
import { PageImage } from '@/scan/ui/PageImage';
import { Unsupported } from '@/scan/ui/Unsupported';
import { useTileDrag } from '@/scan/ui/useTileDrag';
import { ask } from '@/state/ask';
import { usePalette, usePrefs } from '@/state/prefs';

const MAX_W = 960;
const TILE_MIN = 140;

/** The document being scanned: its pages, title, filter and where it is saved. */
export default function ScanReview() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { pages, title, loaded, restore, setTitle, applyToAll, clear, moveTo, moveMany, removeMany, updateMany } = useScan();
  const scan = usePrefs((s) => s.scan);
  const scanTo = usePrefs((s) => s.scanTo);
  const ai = usePrefs((s) => s.ai);
  // AI reading is offered once set up in Settings, and works on the text recognised on the device.
  const aiOffered = aiReady(ai) && scan.ocr;
  const setPrefs = usePrefs((s) => s.set);
  const [roots, setRoots] = useState<FolderRoot[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  // Select mode: the pages picked for a bulk action (null: not selecting).
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const saving = useRef<AbortController | null>(null);
  const grid = useRef<View>(null);
  const placeholder = useMemo(() => defaultTitle(), []);
  const dismiss = useCallback(() => {
    setMessage(null);
    setUndo(null);
  }, []);
  const notify = (text: string, back?: () => void) => {
    setMessage(text);
    setUndo(() => back ?? null);
  };
  const ids = useMemo(() => pages.map((pg) => pg.id), [pages]);
  const drag = useTileDrag(grid, ids, moveTo, !selected && pages.length > 1);
  const byId = useMemo(() => new Map(pages.map((pg) => [pg.id, pg])), [pages]);
  const shown = drag ? drag.order.map((id) => byId.get(id)!).filter(Boolean) : pages;
  const picked = selected ? pages.filter((pg) => selected.has(pg.id)) : [];

  useEffect(() => void restore(), [restore]);
  useEffect(() => {
    // The app's own folder is the default ("null") choice, listed first.
    folders.roots(false).then((r) => setRoots(r.filter((x) => x.kind !== 'app')), () => setRoots([]));
  }, []);
  // Render (and read) the pages in the background while the user looks them over, so saving is quick.
  useEffect(() => {
    if (pages.length) prefetchExports(pages, scan);
  }, [pages, scan]);

  const target = roots.find((r) => r.id === scanTo) ?? null;
  // The chips show (and set) the filter of the selected pages while selecting, else of all pages.
  const scope = selected ? picked : pages;
  const common = scope.length && scope.every((pg) => pg.spec.filter === scope[0].spec.filter) ? scope[0].spec.filter : selected ? null : scan.defaultFilter;
  const columns = Math.max(2, Math.floor((Math.min(width, MAX_W) - space.xl * 2 + space.md) / (TILE_MIN + space.md)));
  const tile = (Math.min(width, MAX_W) - space.xl * 2 - space.md * (columns - 1)) / columns;

  const setFilter = (filter: FilterId) => {
    if (selected) {
      if (!picked.length) return;
      notify(t.scanFilteredN(picked.length), updateMany([...selected], () => ({ filter })));
      return;
    }
    applyToAll(filter);
    setPrefs({ scan: { ...scan, defaultFilter: filter } });
  };

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const bulk = {
    rotate: () => notify(t.scanRotatedN(picked.length), updateMany([...selected!], (spec) => ({ rotation: (spec.rotation + 1) % 4 }))),
    start: () => notify(t.scanMovedN(picked.length), moveMany([...selected!], 'start')),
    end: () => notify(t.scanMovedN(picked.length), moveMany([...selected!], 'end')),
    remove: () => {
      const n = picked.length;
      const back = removeMany([...selected!]);
      setSelected(null);
      notify(t.scanDeletedN(n), back);
    },
  };

  const save = async () => {
    if (saving.current || !pages.length) return;
    const controller = new AbortController();
    saving.current = controller;
    setProgress({ phase: 'render', done: 0, total: pages.length });
    try {
      const { doc, aiError } = await saveScan(pages, scan, title, placeholder, target, setProgress, controller.signal, aiOffered && ai.read ? ai : undefined);
      clear();
      if (aiError) await ask({ title: t.scanAiFailedTitle, body: t.scanAiFailed(aiError), confirm: t.done });
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
    setRoots((await folders.roots(false).catch(() => [root])).filter((x) => x.kind !== 'app'));
    setPrefs({ scanTo: root.id });
    setChoosing(false);
  };

  if (Platform.OS !== 'web') return <Unsupported />;

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + 120 }}>
        <View style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl }}>
          <ScreenHeader title={t.scan} over={pages.length ? t.scanPages(pages.length) : undefined}>
            {pages.length > 1 && !progress && (
              <Button
                testID="scan-select"
                kind="quiet"
                label={selected ? t.done : t.select}
                onPress={() => setSelected((cur) => (cur ? null : new Set()))}
              />
            )}
          </ScreenHeader>

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
            <View ref={grid} style={styles.grid}>
              {shown.map((page, i) => {
                const lifted = drag?.id === page.id;
                const on = !!selected?.has(page.id);
                return (
                <Pressable
                  key={page.id}
                  testID="scan-tile"
                  accessibilityRole={selected ? 'checkbox' : 'button'}
                  accessibilityState={selected ? { checked: on } : undefined}
                  accessibilityLabel={t.scanPageN(i + 1)}
                  onPress={() => (selected ? toggle(page.id) : router.push({ pathname: '/scan/page', params: { id: page.id } }))}
                  style={({ pressed }) => [
                    { width: tile, opacity: pressed && !drag ? 0.75 : 1 },
                    lifted && { zIndex: 10, transform: [{ translateX: drag.dx }, { translateY: drag.dy }, { scale: 1.05 }], cursor: 'grabbing' } as object,
                  ]}
                >
                  <View
                    style={[
                      styles.sheet,
                      { height: tile * 1.32, backgroundColor: p.surface },
                      elevation(p.shadow, lifted ? 3 : 1),
                      on && { outlineWidth: 3, outlineStyle: 'solid', outlineColor: p.accent } as object,
                    ]}
                  >
                    <PageImage page={page} longEdge={520} channel={`tile-${page.id}`} />
                    {selected && (
                      <View style={[styles.check, { backgroundColor: on ? p.accent : 'rgba(0,0,0,0.35)', borderColor: '#fff' }]}>
                        {on && <Icon name="check" size={14} color="#fff" />}
                      </View>
                    )}
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
                );
              })}
              {!selected && (
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
              )}
            </View>
          )}
          {pages.length > 1 && !selected && (
            <T v="caption" color={p.muted} style={{ marginTop: space.md }}>
              {t.scanReorderHint}
            </T>
          )}

          {pages.length > 0 && (
            <>
              <T v="kicker" color={p.muted} style={styles.kicker}>
                {t.scanFilter}
              </T>
              <FilterChips value={common} onChange={setFilter} />

              {!selected && (
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
                {aiOffered && (
                  <>
                    <View style={{ height: 1, backgroundColor: p.hairline }} />
                    <Pressable testID="scan-ai" accessibilityRole="switch" accessibilityState={{ checked: ai.read }} aria-checked={ai.read} onPress={() => setPrefs({ ai: { ...ai, read: !ai.read } })} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <T>{t.scanAi}</T>
                        <T v="caption" color={p.muted}>
                          {t.scanAiNote(aiHost(ai))}
                        </T>
                      </View>
                      <Switch value={ai.read} onValueChange={(read) => setPrefs({ ai: { ...ai, read } })} trackColor={{ true: p.accent }} />
                    </Pressable>
                  </>
                )}
                <View style={{ height: 1, backgroundColor: p.hairline }} />
                <Pressable testID="scan-destination" accessibilityRole="button" onPress={() => setChoosing(true)} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <T>{t.scanSaveTo}</T>
                    <T v="caption" color={p.muted} numberOfLines={1}>
                      {target ? target.name : shell ? t.scanAppFolder : t.scanLibraryOnly}
                    </T>
                  </View>
                  <Icon name="chevronRight" color={p.muted} size={20} />
                </Pressable>
              </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {pages.length > 0 && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + space.lg, backgroundColor: p.glass, borderColor: p.hairline }]}>
          <View style={{ width: '100%', maxWidth: MAX_W, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.xl }}>
            {selected ? (
              <View style={{ flex: 1, gap: space.xs }}>
                <T testID="scan-selected" v="label" color={p.inkSoft} numberOfLines={1}>
                  {t.scanSelectedN(picked.length)}
                </T>
                {/* Greyed out until a page is picked. */}
                <View style={[styles.bulk, !picked.length && { opacity: 0.4 }]} pointerEvents={picked.length ? 'auto' : 'none'}>
                  <IconButton testID="bulk-rotate" icon="rotate" label={t.scanRotate} onPress={bulk.rotate} />
                  <Button testID="bulk-start" kind="quiet" label={t.scanToStart} onPress={bulk.start} />
                  <Button testID="bulk-end" kind="quiet" label={t.scanToEnd} onPress={bulk.end} />
                  <IconButton testID="bulk-delete" icon="trash" label={t.delete} onPress={bulk.remove} />
                </View>
              </View>
            ) : progress ? (
              <>
                <T testID="scan-progress" v="label" color={p.inkSoft} style={{ flex: 1 }}>
                  {progress.phase === 'ai'
                    ? t.scanAiReading(progress.total)
                    : progress.phase === 'read'
                      ? t.scanReading(progress.done + 1, progress.total)
                      : t.scanPreparing(Math.min(progress.done + 1, progress.total), progress.total)}
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
            <Choice icon="pages" label={shell ? t.scanAppFolder : t.scanLibraryOnly} note={shell ? t.scanAppFolderNote : t.scanLibraryNote} on={!target} onPress={() => (setPrefs({ scanTo: null }), setChoosing(false))} />
            {roots.map((r) => (
              <Choice key={r.id} icon="folder" label={r.name} on={target?.id === r.id} onPress={() => (setPrefs({ scanTo: r.id }), setChoosing(false))} />
            ))}
            {folders.supported && <Choice icon="folderAdd" label={t.scanOtherFolder} onPress={() => void addFolder()} />}
          </Pressable>
        </Pressable>
      )}
      <Toast message={message} onDismiss={dismiss} above={selected ? 110 : 64} action={undo ? { label: t.undo, onPress: undo } : undefined} />
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
  bulk: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  check: { position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'flex-start', gap: space.lg, paddingVertical: space.xl },
  kicker: { marginTop: space.xxl, marginBottom: space.sm },
  card: { borderWidth: 1, borderRadius: radius.md, marginTop: space.xl, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: space.md, borderTopWidth: 1 },
  scrim: { justifyContent: 'flex-end', alignItems: 'center', padding: space.lg },
  sheetCard: { width: '100%', maxWidth: 480, borderRadius: radius.lg, padding: space.lg, gap: space.xs },
  choice: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.sm, borderRadius: radius.sm },
});
