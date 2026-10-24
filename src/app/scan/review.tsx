import { router, useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/paper/components/Icon';
import { Button, IconButton, T } from '@/paper/components/primitives';
import { ScreenHeader } from '@/paper/components/ScreenHeader';
import { Knob } from '@/paper/components/Toggle';
import { Toast } from '@/paper/components/Toast';
import { elevation, fonts, radius, space } from '@/core/design/tokens';
import { scanError, t } from '@/core/i18n';
import { folders } from '@/core/lib/folders';
import type { FilterId } from '@/paper/scan/engine/imaging/filters';
import { isBlurred } from '@/paper/scan/engine/imaging/sharpness';
import { defaultTitle } from '@/paper/scan/export';
import { prefetchExports } from '@/paper/scan/exportCache';
import { readAdded } from '@/paper/archive/intake';
import { saveScan, type SaveProgress } from '@/paper/scan/save';
import { saveAgain } from '@/paper/scan/again';
import { repo } from '@/core/storage';
import { aiHost, aiReady } from '@/paper/scan/ai';
import { sayScan, useScan, useScanMessage, useScanSaving } from '@/paper/scan/session';
import { holdBrowserBack, onBack } from '@/core/lib/backGuard';
import { FilterChips } from '@/paper/scan/ui/FilterChips';
import { PageImage } from '@/paper/scan/ui/PageImage';
import { Unsupported } from '@/paper/scan/ui/Unsupported';
import { useTileDrag } from '@/paper/scan/ui/useTileDrag';
import { ask } from '@/paper/state/ask';
import { usePalette, usePrefs } from '@/paper/state/prefs';

const MAX_W = 960;
const TILE_MIN = 140;

/** The document being scanned: its pages, title, filter and where it is saved. */
export default function ScanReview() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { pages, title, replaces, loaded, aiRead, unsaved, restore, setTitle, setAiRead, applyToAll, clear, seal, moveTo, moveMany, removeMany, updateMany } = useScan();
  const focused = useIsFocused();
  const scan = usePrefs((s) => s.scan);
  const ai = usePrefs((s) => s.ai);
  // AI reading is offered once set up in Settings, and works on the text recognised on the device.
  const aiOffered = aiReady(ai) && scan.ocr;
  const setPrefs = usePrefs((s) => s.set);
  // A save under way (started here or on another review of this scan): the document waits for it.
  const progress = useScanSaving((s) => s.progress);
  const saving = useScanSaving((s) => s.controller);
  // The scanner's messages (the camera's too: it may have closed since), with Undo for what they report.
  const { text: message, undo, id: messageId } = useScanMessage();
  // Select mode: the pages picked for a bulk action (null: not selecting).
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const grid = useRef<View>(null);
  // Whether this screen is still the one in front when its save ends (else it doesn't take the user anywhere).
  const here = useRef(true);
  useEffect(() => {
    here.current = focused;
  }, [focused]);
  useEffect(
    () => () => {
      here.current = false;
    },
    [],
  );
  // Back waits for the save (Cancel stops it): leaving would start another document over the one being saved.
  useEffect(() => {
    if (!saving) return;
    const off = onBack(() => true);
    const unhold = holdBrowserBack(() => {});
    return () => {
      off();
      unhold();
    };
  }, [saving]);
  const placeholder = useMemo(() => defaultTitle(), []);
  const dismiss = () => sayScan(null);
  const notify = (text: string, back?: () => void) => sayScan(text, back);
  const ids = useMemo(() => pages.map((pg) => pg.id), [pages]);
  // While saving, the document stays as it is being saved.
  const drag = useTileDrag(grid, ids, moveTo, !selected && !progress && pages.length > 1);
  const byId = useMemo(() => new Map(pages.map((pg) => [pg.id, pg])), [pages]);
  const shown = drag ? drag.order.map((id) => byId.get(id)!).filter(Boolean) : pages;
  const picked = selected ? pages.filter((pg) => selected.has(pg.id)) : [];

  useEffect(() => void restore(), [restore]);
  // Render (and read) the pages in the background while the user looks them over (not while the camera is on top), so saving is quick.
  useEffect(() => {
    if (pages.length && focused) prefetchExports(pages, scan);
  }, [pages, scan, focused]);

  // Saved as anything added is: into the Tessel folder (its Inbox, where there is one).
  const archive = usePrefs((s) => s.archive);
  // The chips show (and set) the filter of the selected pages while selecting, else of all pages; none when they
  // differ, or while selecting with nothing picked (then they do nothing, and say so).
  const scope = selected ? picked : pages;
  const nonePicked = !!selected && !picked.length;
  const common = nonePicked ? null : scope.length && scope.every((pg) => pg.spec.filter === scope[0].spec.filter) ? scope[0].spec.filter : scope.length ? null : scan.defaultFilter;
  const columns = Math.max(2, Math.floor((Math.min(width, MAX_W) - space.xl * 2 + space.md) / (TILE_MIN + space.md)));
  const tile = (Math.min(width, MAX_W) - space.xl * 2 - space.md * (columns - 1)) / columns;

  const setFilter = (filter: FilterId) => {
    if (selected) {
      if (!picked.length) return;
      notify(t.scanFilteredN(picked.length), updateMany([...selected], () => ({ filter })));
      return;
    }
    // Pages with filters of their own lose them: that can be undone.
    const back = applyToAll(filter);
    if (common === null) notify(t.scanAppliedToAll(pages.length), back);
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
    if (useScanSaving.getState().controller || !pages.length) return;
    // Write access to the folder is asked for now, while the tap still counts (after the pages are rendered and
    // read it no longer would, and saving would fail at the very end).
    // Pages scanned again go back into their document's file; a new scan into the Tessel folder.
    if (replaces ? !(await repo.requestAccess(replaces.id, true).catch(() => false)) : archive && !(await folders.unlock(archive, true).catch(() => false))) {
      return notify(t.scanSaveFailed(t.writeDenied));
    }
    const controller = new AbortController();
    // Saved as it is now: an Undo offered before (a page deleted) can't change what is being written.
    sayScan(null);
    seal();
    const setProgress = (next: SaveProgress) => useScanSaving.setState({ progress: next });
    useScanSaving.setState({ controller, progress: { phase: 'render', done: 0, total: pages.length } });
    // The pages being saved: only they leave the scan when it is saved.
    const saved = pages.map((pg) => pg.id);
    const run = async () => {
      const { doc, unread } = replaces
        ? await saveAgain(replaces, title, pages, scan, setProgress, controller.signal)
        : await saveScan(pages, scan, title, placeholder, null, setProgress, controller.signal);
      clear(saved);
      // The model reads it in the background (the document opens meanwhile, and says so); untitled, it names it.
      if (doc && aiOffered && aiRead) readAdded([doc], true, { name: !replaces && !title.trim() });
      // Moved on meanwhile (the camera, say): the document is in the library; nothing takes the user away.
      if (!here.current) return;
      if (unread) await ask({ title: t.scanUnreadTitle(unread), body: t.ocrFailed, confirm: t.done });
      // Back to the document scanned again where it is open (it opens again with the new pages).
      if (doc && replaces && router.canGoBack()) router.back();
      else if (doc) router.replace({ pathname: '/read/[id]', params: { id: doc.id } });
      else router.replace('/');
    };
    await run().catch((e: unknown) => {
      if (!controller.signal.aborted) notify(t.scanSaveFailed(scanError(e)));
    });
    useScanSaving.setState({ controller: null, progress: null });
  };

  const discard = async () => {
    // Pages of a document being cleaned up: only the pictures go; the document stays, and is where this goes back to.
    const was = replaces;
    const answer = await ask(
      was
        ? { title: t.againStopTitle, body: t.againStopBody(was.title), confirm: t.scanDiscard }
        : { title: t.scanDiscardTitle, body: t.scanDiscardBody(pages.length), confirm: t.scanDiscard, destructive: true },
    );
    if (answer === null) return;
    clear();
    if (was) router.replace({ pathname: '/read/[id]', params: { id: was.id } });
    else router.replace('/');
  };

  if (Platform.OS !== 'web') return <Unsupported />;

  return (
    <View style={{ flex: 1, backgroundColor: p.canvas }}>
      <ScrollView contentContainerStyle={{ alignItems: 'center', paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + 120 }}>
        <View pointerEvents={progress ? 'none' : 'auto'} style={{ width: '100%', maxWidth: MAX_W, paddingHorizontal: space.xl, opacity: progress ? 0.6 : 1 }}>
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

          {replaces && (
            <T v="caption" color={p.muted} testID="scan-again" style={{ marginBottom: space.md }}>
              {t.againNote(replaces.title)}
            </T>
          )}
          {unsaved && (
            <T v="caption" color={p.markRing} testID="scan-unsaved" style={{ marginBottom: space.md }}>
              {t.scanUnsaved}
            </T>
          )}
          <TextInput
            testID="scan-title"
            editable={!progress}
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
                  aria-checked={selected ? on : undefined}
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
              <FilterChips value={common} onChange={setFilter} disabled={nonePicked} />

              {!selected && (
              <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.hairline }]}>
                <Pressable accessibilityRole="switch" aria-checked={scan.ocr} onPress={() => setPrefs({ scan: { ...scan, ocr: !scan.ocr } })} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <T>{t.scanRecognise}</T>
                    <T v="caption" color={p.muted}>
                      {t.scanRecogniseNote}
                    </T>
                  </View>
                  <Knob on={scan.ocr} />
                </Pressable>
                {aiOffered && (
                  <>
                    <View style={{ height: 1, backgroundColor: p.hairline }} />
                    <Pressable testID="scan-ai" accessibilityRole="switch" aria-checked={aiRead} onPress={() => setAiRead(!aiRead)} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <T>{t.scanAi}</T>
                        <T v="caption" color={p.muted}>
                          {t.scanAiNote(aiHost(ai))}
                        </T>
                      </View>
                      <Knob on={aiRead} />
                    </Pressable>
                  </>
                )}
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
                  {progress.phase === 'read' ? t.scanReading(progress.done + 1, progress.total) : t.scanPreparing(Math.min(progress.done + 1, progress.total), progress.total)}
                </T>
                <Button kind="quiet" label={t.cancel} onPress={() => saving?.abort()} />
              </>
            ) : (
              <>
                <Button kind="quiet" label={t.scanDiscard} onPress={() => void discard()} />
                <View style={{ flex: 1 }} />
                <Button testID="scan-save" label={replaces ? t.againSave : t.scanSave} icon="check" onPress={() => void save()} />
              </>
            )}
          </View>
        </View>
      )}

      {focused && <Toast message={message} id={messageId} onDismiss={dismiss} above={selected ? 110 : 64} action={undo ? { label: t.undo, onPress: undo } : undefined} />}
    </View>
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
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingTop: space.md, borderTopWidth: 1, zIndex: 10 },
});
