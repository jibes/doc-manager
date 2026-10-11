import { useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

import { T, tick } from '@/components/primitives';
import { elevation, fonts, radius, space, type Palette } from '@/design/tokens';
import type { Size } from '@/engine/types';
import type { RasterCache } from './rasterCache';
import { Thumb } from './Thumb';

type Props = {
  page: number;
  pageCount: number;
  sizes: Size[];
  cache: RasterCache;
  palette: Palette;
  /** Chapter starts (0-based pages), drawn as notches on the spine. */
  chapters: { page: number; title: string }[];
  bookmarks: number[];
  expanded: boolean;
  onSeek: (page: number) => void;
};

const PREVIEW_W = 92;

/**
 * The spine: a hairline progress track that becomes a scrubbable timeline with
 * chapter notches, bookmark ticks and a live page preview under the finger.
 */
export function Scrubber({ page, pageCount, sizes, cache, palette: p, chapters, bookmarks, expanded, onSeek }: Props) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const last = useRef(-1);
  const geom = useRef({ x: 0, width: 0 });

  const max = Math.max(1, pageCount - 1);
  const pageFromX = (x: number, w: number) => Math.round(Math.min(1, Math.max(0, x / Math.max(1, w))) * max);

  // Responder props (not a memoized PanResponder) so handlers always see current props.
  const responder = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: (e: GestureResponderEvent) => {
      const { locationX, pageX } = e.nativeEvent;
      geom.current = { x: pageX - locationX, width: geom.current.width };
      const pg = pageFromX(locationX, geom.current.width);
      last.current = pg;
      setDrag(pg);
    },
    onResponderMove: (e: GestureResponderEvent) => {
      const pg = pageFromX(e.nativeEvent.pageX - geom.current.x, geom.current.width);
      if (pg !== last.current) {
        last.current = pg;
        tick();
        setDrag(pg);
      }
    },
    onResponderRelease: () => {
      if (last.current >= 0) onSeek(last.current);
      setDrag(null);
    },
    onResponderTerminate: () => setDrag(null),
  };

  const shown = drag ?? page;
  const frac = shown / max;
  const active = drag != null;
  const chapter = [...chapters].reverse().find((c) => c.page <= shown);
  const trackH = active ? 4 : expanded ? 3 : 2;

  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
    geom.current.width = e.nativeEvent.layout.width;
  };

  const previewX = Math.min(Math.max(0, frac * width - (PREVIEW_W + 24) / 2), Math.max(0, width - PREVIEW_W - 24));

  return (
    <View
      testID="scrubber"
      onLayout={onLayout}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Page"
      accessibilityValue={{ min: 1, max: pageCount, now: shown + 1, text: `Page ${shown + 1} of ${pageCount}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onSeek(Math.min(max, Math.max(0, page + (e.nativeEvent.actionName === 'increment' ? 1 : -1))))}
      style={[styles.hit, { cursor: 'pointer' } as object]}
      {...responder}
    >
      <View pointerEvents="none" style={[styles.track, { height: trackH, backgroundColor: p.hairline, opacity: expanded || active ? 1 : 0.7 }]}>
        <View style={{ width: `${frac * 100}%`, height: '100%', backgroundColor: p.accent }} />
      </View>
      {(expanded || active) && width > 0 && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          {chapters.map((c) => (
            <View key={`c${c.page}`} style={[styles.notch, { left: (c.page / max) * width, backgroundColor: p.muted }]} />
          ))}
          {bookmarks.map((b) => (
            <View key={`b${b}`} style={[styles.mark, { left: (b / max) * width - 1, backgroundColor: p.accent }]} />
          ))}
          <View
            style={[
              styles.knob,
              { left: frac * width - (active ? 9 : 6), marginTop: active ? -9 : -6, width: active ? 18 : 12, height: active ? 18 : 12, backgroundColor: p.accent, borderColor: p.surface },
            ]}
          />
        </View>
      )}
      {active && sizes[shown] && (
        <View pointerEvents="none" style={[styles.preview, { left: previewX, backgroundColor: p.surface, borderColor: p.hairline }, elevation(p.shadow, 3)]}>
          <Thumb cache={cache} page={shown} size={sizes[shown]} width={PREVIEW_W} palette={p} />
          <T v="numeral" style={{ marginTop: space.sm, fontFamily: fonts.sansSemi }}>
            {shown + 1} <T v="numeral" color={p.muted}>/ {pageCount}</T>
          </T>
          {chapter ? (
            <T v="caption" color={p.muted} numberOfLines={1} style={{ maxWidth: PREVIEW_W }}>
              {chapter.title}
            </T>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { height: 28, justifyContent: 'center' },
  track: { borderRadius: 2, overflow: 'hidden' },
  notch: { position: 'absolute', top: 9, width: 1, height: 10, opacity: 0.45 },
  mark: { position: 'absolute', top: 6, width: 2, height: 6, borderRadius: 1 },
  knob: { position: 'absolute', top: '50%', borderRadius: radius.pill, borderWidth: 2 },
  preview: { position: 'absolute', bottom: 34, padding: space.md, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'flex-start' },
});
