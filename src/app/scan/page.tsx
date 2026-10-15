import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { IconButton, T } from '@/components/primitives';
import { goBack } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { isBlurred } from '@/scan/engine/imaging/sharpness';
import { sayScan, useScan, useScanMessage } from '@/scan/session';
import { FilterChips } from '@/scan/ui/FilterChips';
import { HoldButton } from '@/scan/ui/HoldButton';
import { PageImage } from '@/scan/ui/PageImage';
import { Unsupported } from '@/scan/ui/Unsupported';

const PREVIEW_EDGE = 1600;

/** One scanned page: filter, turn, crop, retake or delete it; step through the others. */
export default function ScanPage() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { pages, loaded, restore, update, remove, applyToAll } = useScan();
  const [comparing, setComparing] = useState(false);
  const [rendering, setRendering] = useState(false);
  const { text: message, undo, id: messageId } = useScanMessage();
  // Messages go above the filters and actions (Undo where Retake is would be a trap).
  const [panelH, setPanelH] = useState(0);
  const focused = useIsFocused();
  const dismiss = useCallback(() => sayScan(null), []);
  useEffect(() => void restore(), [restore]);

  const index = pages.findIndex((p) => p.id === id);
  const page = pages[index];
  const open = useCallback((to: string) => router.setParams({ id: to }), []);

  useEffect(() => {
    if (loaded && !page) goBack();
  }, [loaded, page]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.('input, textarea')) return;
      const all = useScan.getState().pages;
      const i = all.findIndex((p) => p.id === id);
      if (e.key === 'ArrowLeft' && i > 0) open(all[i - 1].id);
      if (e.key === 'ArrowRight' && i >= 0 && i < all.length - 1) open(all[i + 1].id);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [id, open]);

  if (Platform.OS !== 'web') return <Unsupported />;
  if (!page) return <View style={styles.screen} />;

  // Deleted at once, with Undo (shown here, or on the document when it was the last page: the screen goes back
  // there by itself once its page is gone).
  const del = () => {
    const next = pages[index + 1] ?? pages[index - 1];
    sayScan(t.scanDeletedN(1), remove(page.id));
    if (next) open(next.id);
  };
  const others = pages.filter((p) => p.spec.filter !== page.spec.filter).length;

  return (
    <View style={styles.screen}>
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <IconButton testID="screen-back" icon="back" label={t.back} color="#fff" onPress={goBack} />
        <T v="headline" color="#fff" style={{ flex: 1 }}>
          {t.scanPageOf(index + 1, pages.length)}
        </T>
        <IconButton icon="back" label={t.scanPrevious} color="#fff" disabled={index <= 0} style={{ opacity: index <= 0 ? 0.35 : 1 }} onPress={() => open(pages[index - 1].id)} />
        <IconButton
          icon="chevronRight"
          label={t.scanNext}
          color="#fff"
          disabled={index >= pages.length - 1}
          style={{ opacity: index >= pages.length - 1 ? 0.35 : 1 }}
          onPress={() => open(pages[index + 1].id)}
        />
      </View>

      {isBlurred(page) && (
        <View accessibilityLiveRegion="polite" style={styles.banner}>
          <T v="label" color="#fff" style={{ flex: 1 }}>
            {t.scanBlurredBanner}
          </T>
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/scan', params: { retake: page.id } })}>
            <T v="label" color="#FFD27A">
              {t.scanRetake}
            </T>
          </Pressable>
        </View>
      )}

      <View style={styles.preview}>
        <View style={{ flex: 1, display: comparing ? 'none' : 'flex' }}>
          <PageImage key={page.id} page={page} longEdge={PREVIEW_EDGE} channel="page-preview" onRendering={setRendering} />
        </View>
        {comparing && <PageImage page={page} longEdge={PREVIEW_EDGE} channel="page-original" unfiltered />}
        {rendering && (
          <View pointerEvents="none" style={styles.working}>
            <T v="caption" color="rgba(255,255,255,0.8)">
              {t.scanRendering}
            </T>
          </View>
        )}
        <HoldButton testID="scan-compare" label={t.scanCompare} onHold={setComparing} style={styles.compare}>
          <T v="label" color="#fff">
            {t.scanCompareShort}
          </T>
        </HoldButton>
      </View>

      <View onLayout={(e) => setPanelH(e.nativeEvent.layout.height)} style={[styles.panel, { paddingBottom: insets.bottom + space.lg }]}>
        <FilterChips dark value={page.spec.filter} onChange={(filter) => update(page.id, { filter })} />
        {others > 0 && (
          <Pressable
            accessibilityRole="button"
            onPress={() => sayScan(t.scanAppliedToAll(pages.length), applyToAll(page.spec.filter))}
            style={{ alignSelf: 'flex-start', paddingVertical: space.xs }}
          >
            <T v="label" color="#9DB8FF">
              {t.scanApplyToAll}
            </T>
          </Pressable>
        )}
        <View style={styles.actions}>
          <Action testID="scan-rotate" icon="rotate" label={t.scanRotate} onPress={() => update(page.id, { rotation: (page.spec.rotation + 1) % 4 })} />
          <Action testID="scan-crop" icon="crop" label={t.scanCrop} onPress={() => router.push({ pathname: '/scan/crop', params: { id: page.id } })} />
          <Action icon="camera" label={t.scanRetake} onPress={() => router.push({ pathname: '/scan', params: { retake: page.id } })} />
          <Action testID="scan-delete" icon="trash" label={t.delete} onPress={del} />
        </View>
      </View>
      {focused && <Toast message={message} id={messageId} onDismiss={dismiss} above={Math.max(0, panelH + space.sm - insets.bottom - space.xl)} action={undo ? { label: t.undo, onPress: undo } : undefined} />}
    </View>
  );
}

function Action({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}>
      <Icon name={icon} color="#fff" size={22} />
      <T v="caption" color="rgba(255,255,255,0.85)" numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // A photo editor: nothing on it is text to select, and a long press anywhere must not start a selection.
  screen: { flex: 1, backgroundColor: '#111', userSelect: 'none' } as object,
  top: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.md, paddingBottom: space.sm },
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginHorizontal: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: 'rgba(200,120,20,0.35)' },
  preview: { flex: 1, margin: space.lg },
  working: { position: 'absolute', top: space.sm, left: 0, right: 0, alignItems: 'center' },
  compare: { position: 'absolute', right: 0, bottom: 0, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: 'rgba(0,0,0,0.55)' },
  panel: { paddingHorizontal: space.lg, gap: space.sm, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, backgroundColor: '#1C1C1C', paddingTop: space.md },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: space.sm },
  action: { alignItems: 'center', gap: space.xs, minWidth: 64, paddingVertical: space.xs },
});
