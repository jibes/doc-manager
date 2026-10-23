import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

import { fonts, radius, space } from '@/core/design/tokens';
import { t } from '@/core/i18n';
import { folders, type FolderEntry } from '@/core/lib/folders';
import { cachedThumb, thumb, type Thumb } from '@/core/lib/thumbs';
import { showActions, type Action } from '@/paper/state/actions';
import { usePalette, usePrefs } from '@/paper/state/prefs';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { IconButton, T } from './primitives';
import { Check } from './Selection';

/**
 * Every list of documents shows them the same way, as the user chose (one choice for all of them): small
 * pictures beside the text, or big ones above it. A tap opens, a long press (or right click) picks.
 */
export type Layout = 'list' | 'grid';

export const useLayout = () => usePrefs((s) => s.layout);

/** The button that switches every list between the two. */
export function LayoutToggle() {
  const layout = useLayout();
  const grid = layout === 'grid';
  return (
    <IconButton
      testID="layout-toggle"
      icon={grid ? 'viewList' : 'viewGrid'}
      label={grid ? t.showAsList : t.showAsGrid}
      onPress={() => usePrefs.getState().set({ layout: grid ? 'list' : 'grid' })}
    />
  );
}

/** Tiles per row and their width for a grid `width` wide. */
export function gridOf(width: number) {
  const gap = width < 600 ? space.md : space.lg;
  const cols = Math.max(3, Math.floor((width + gap) / ((width < 600 ? 104 : 150) + gap)));
  return { cols, gap, tile: Math.floor((width - gap * (cols - 1)) / cols) };
}

/** What a document is shown with: its cover in the library, a file's first page, or a folder. */
export type Picture = { kind: 'cover'; uri: string | null | undefined; aspect: number } | { kind: 'file'; root: string; entry: FolderEntry } | { kind: 'dir' };

/** The picture, once there is one (undefined while it is made; null when there is none to make). */
function usePicture(picture: Picture): Thumb | undefined {
  const [made, setMade] = useState<{ key: string; thumb: Thumb } | null>(null);
  const key = picture.kind === 'file' ? `${picture.root}|${picture.entry.id}|${picture.entry.modified}` : '';
  // The entry object is new on every listing; its key says whether it is the same file (read when the key changes).
  const latest = useRef(picture);
  useEffect(() => {
    latest.current = picture;
  });
  useEffect(() => {
    const now = latest.current;
    if (now.kind !== 'file') return;
    let live = true;
    const { root, entry } = now;
    cachedThumb(root, entry)
      .then((hit) => (hit !== undefined ? hit : thumb(root, entry, () => folders.read(root, entry))))
      .then((th) => live && setMade({ key, thumb: th }))
      .catch(() => live && setMade({ key, thumb: null }));
    return () => {
      live = false;
    };
  }, [key]);
  if (picture.kind === 'cover') return picture.uri ? { uri: picture.uri, aspect: picture.aspect } : null;
  if (picture.kind === 'dir') return null;
  return made?.key === key ? made.thumb : undefined;
}

export type DocItemProps = {
  layout: Layout;
  /** Tile width (grid). */
  width: number;
  testID: string;
  picture: Picture;
  title: string;
  /** What assistive technology says (and tests find it by); the title if not given. */
  label?: string;
  /** One line under the title: details, place, size. */
  meta?: string;
  /** More under it (list only): the words around a search match. */
  extra?: ReactNode;
  /** At the end of the row (list only): the page of a match. */
  badge?: string;
  /** Reading progress, under the picture. */
  progress?: number;
  busy?: boolean;
  /** The first and last rows (list): the list's rounded edges. */
  first?: boolean;
  last?: boolean;
  /** Open beside the list. */
  current?: boolean;
  /** Undefined: not picking. */
  selected?: boolean;
  onOpen: () => void;
  /** A long press or right click: starts picking, or picks one more. */
  onSelect: () => void;
  /** A tap while picking. */
  onToggle: () => void;
  /** What else can be done with it (its ⋯ button). */
  actions?: Action[];
  /** A right click with a mouse: its menu, where the pointer is (a long press still picks). */
  onMenu?: (at: { x: number; y: number }) => void;
  /** Dragged (web): the documents it carries, and the file for other apps when there is one. */
  drag?: Drag;
};

export type Drag = { keys: () => string[]; type: string; file: () => { name: string; url: string } | undefined; prepare: () => void };

/** Lets a row or tile be dragged: into other apps as a file, onto a tag in Tessel as documents (a ref for it). */
function useDrag(drag: Drag | undefined) {
  const latest = useRef(drag);
  useEffect(() => {
    latest.current = drag;
  });
  const detach = useRef<() => void>(() => {});
  // Whenever its element is there (it may be made again): the listeners on it.
  return useCallback((view: View | null) => {
    detach.current();
    detach.current = () => {};
    const node = view as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !node || !latest.current) return;
    node.draggable = true;
    const start = (e: DragEvent) => {
      const d = latest.current;
      if (!d || !e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(d.type, JSON.stringify(d.keys()));
      const file = d.file();
      if (file) e.dataTransfer.setData('DownloadURL', `application/pdf:${file.name}:${file.url}`);
    };
    const enter = () => latest.current?.prepare();
    node.addEventListener('dragstart', start);
    node.addEventListener('pointerenter', enter);
    detach.current = () => {
      node.removeEventListener('dragstart', start);
      node.removeEventListener('pointerenter', enter);
    };
  }, []);
}

type MenuEvent = { preventDefault(): void; nativeEvent?: { pointerType?: string; clientX?: number; clientY?: number } };

/** A right click (web) does what a long press does; with a mouse, and a menu given, it opens that instead. */
export const rightClick = (fn: () => void, menu?: (at: { x: number; y: number }) => void) =>
  Platform.OS === 'web'
    ? {
        onContextMenu: (ev: MenuEvent) => {
          ev.preventDefault();
          const ne = ev.nativeEvent;
          if (menu && ne?.pointerType === 'mouse') menu({ x: ne.clientX ?? 0, y: ne.clientY ?? 0 });
          else fn();
        },
      }
    : {};

export function DocItem(props: DocItemProps) {
  return props.layout === 'grid' ? <Tile {...props} /> : <Row {...props} />;
}

function Row({ testID, picture, title, label, meta, extra, badge, progress, busy, first, last, current, selected, onOpen, onSelect, onToggle, actions, onMenu, drag }: DocItemProps) {
  const p = usePalette();
  const dragRef = useDrag(drag);
  const image = usePicture(picture);
  const picking = selected !== undefined;
  return (
    // Each row draws its part of the list's frame, so a scrolling list (that has no frame to draw) looks the same.
    <View
      style={[
        styles.row,
        { backgroundColor: current ? p.mark : p.surface, borderColor: p.hairline },
        first && { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
        last && { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <Pressable
        ref={dragRef}
        testID={testID}
        accessibilityRole={picking ? 'checkbox' : 'button'}
        aria-checked={picking ? selected : undefined}
        accessibilityLabel={label ?? title}
        aria-current={current || undefined}
        onPress={picking ? onToggle : onOpen}
        onLongPress={onSelect}
        delayLongPress={350}
        {...rightClick(onSelect, picking ? undefined : onMenu)}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
          styles.rowMain,
          { backgroundColor: selected ? p.hairline : hovered ? p.raised : 'transparent', opacity: pressed || busy ? 0.7 : 1 },
        ]}
      >
        {picking && <Check on={!!selected} />}
        <View style={styles.rowPicture}>
          {picture.kind === 'dir' ? (
            <View style={[styles.rowDir, { backgroundColor: p.surface, borderColor: p.hairline }]}>
              <Icon name="folder" size={20} color={p.accent} />
            </View>
          ) : image ? (
            <Cover uri={image.uri} aspect={image.aspect} width={36} progress={progress} />
          ) : (
            <Plain testID={image === null ? 'thumb-none' : 'thumb-pending'} width={36} label="PDF" small />
          )}
          {busy && <ActivityIndicator style={StyleSheet.absoluteFill} color={p.accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15, lineHeight: 20 }}>
            {title}
          </T>
          {!!meta && (
            <T v="caption" color={p.muted} numberOfLines={1}>
              {meta}
            </T>
          )}
          {extra}
        </View>
        {!!badge && (
          <T v="numeral" color={p.muted}>
            {badge}
          </T>
        )}
      </Pressable>
      {/* A sibling, not a child: buttons can't nest in the DOM. */}
      {!picking && actions?.length ? (
        <IconButton testID="row-more" icon="more" label={t.moreFor(title)} size={36} color={p.muted} onPress={() => showActions(title, actions)} style={{ marginRight: space.xs }} />
      ) : null}
    </View>
  );
}

function Tile({ width, testID, picture, title, label, meta, progress, busy, current, selected, onOpen, onSelect, onToggle, onMenu, drag }: DocItemProps) {
  const p = usePalette();
  const dragRef = useDrag(drag);
  const image = usePicture(picture);
  const picking = selected !== undefined;
  const isDir = picture.kind === 'dir';
  const boxH = Math.round(width * 1.32);
  // The check sits on the picture itself (folders and covers are shorter than the box).
  const coverW = image ? Math.min(width, Math.round(boxH / image.aspect)) : width;
  const shownH = isDir ? Math.round(width * 0.8) : image ? Math.round(coverW * Math.min(Math.max(image.aspect, 0.5), 1.8)) : Math.round(width * 1.3);
  const checkAt = { top: boxH - shownH + 6, right: Math.round((width - (isDir ? width : coverW)) / 2) + 6 };
  return (
    <Pressable
      ref={dragRef}
      testID={testID}
      accessibilityRole={picking ? 'checkbox' : 'button'}
      aria-checked={picking ? selected : undefined}
      accessibilityLabel={label ?? title}
      aria-current={current || undefined}
      onPress={picking ? onToggle : onOpen}
      onLongPress={onSelect}
      delayLongPress={350}
      {...rightClick(onSelect, picking ? undefined : onMenu)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        { width, opacity: pressed || busy ? 0.6 : hovered ? 0.92 : 1 },
        current && { backgroundColor: p.mark, borderRadius: radius.md },
      ]}
    >
      <View style={{ height: boxH, justifyContent: 'flex-end', alignItems: 'center' }}>
        {isDir ? (
          <View style={[styles.dirBox, { width, height: Math.round(width * 0.8), backgroundColor: p.surface, borderColor: p.hairline }]}>
            <Icon name="folder" size={Math.round(width * 0.36)} color={p.accent} strokeWidth={1.2} />
          </View>
        ) : image ? (
          <Cover uri={image.uri} aspect={image.aspect} width={coverW} progress={progress} />
        ) : (
          <Plain testID={image === null ? 'thumb-none' : 'thumb-pending'} width={width} label="PDF" />
        )}
        {busy && <ActivityIndicator style={StyleSheet.absoluteFill} color={p.accent} />}
        {picking && <Check on={!!selected} style={[styles.check, checkAt]} />}
      </View>
      <T v="caption" numberOfLines={isDir ? 3 : 2} style={[styles.tileName, hyphenate]}>
        {title}
      </T>
      {!!meta && (
        <T v="caption" color={p.muted} numberOfLines={1} style={{ fontSize: 11 }}>
          {meta}
        </T>
      )}
    </Pressable>
  );
}

/** A document's picture on its own, `width` wide. */
export function Thumbnail({ picture, width }: { picture: Picture; width: number }) {
  const image = usePicture(picture);
  if (image) return <Cover uri={image.uri} aspect={image.aspect} width={width} />;
  return <Plain testID={image === null ? 'thumb-none' : 'thumb-pending'} width={width} label="PDF" small={width < 48} />;
}

/** A document without a picture (yet, or at all). */
function Plain({ testID, width, label, small }: { testID: string; width: number; label: string; small?: boolean }) {
  const p = usePalette();
  return (
    <View testID={testID} style={[styles.plain, { width, height: Math.round(width * 1.3), backgroundColor: p.surface, borderColor: p.hairline }]}>
      {!small && (
        <T v="kicker" color={p.muted}>
          {label}
        </T>
      )}
    </View>
  );
}

/** Rows one under the other, or tiles in a grid. */
export function DocList({ layout, gap, children, testID }: { layout: Layout; gap: number; children: ReactNode; testID?: string }) {
  if (layout === 'grid') return <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap: gap + space.xs }}>{children}</View>;
  return <View testID={testID}>{children}</View>;
}

/** Long words in narrow tiles break at syllables (in the page's language), not mid-letter. */
const hyphenate = (Platform.OS === 'web' ? { hyphens: 'auto', overflowWrap: 'anywhere' } : {}) as object;

const styles = StyleSheet.create({
  // The row's own background (picked, hovered) reaches its right edge: the ⋯ button keeps its own margin.
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 68 },
  rowPicture: { width: 36, alignItems: 'center', justifyContent: 'center' },
  rowDir: { width: 36, height: 36, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  tileName: { marginTop: space.sm, fontFamily: fonts.sansMedium, fontSize: 12.5, lineHeight: 16 },
  dirBox: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  plain: { borderRadius: radius.cover, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  check: { position: 'absolute' },
});
