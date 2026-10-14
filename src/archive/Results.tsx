import { router } from 'expo-router';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { T } from '@/components/primitives';
import { Check } from '@/components/Selection';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { docDate } from './facets';
import type { Hit, IndexedDoc, Place } from './search';

/** A file of a folder in the library (opened in place where it can be). */
export async function importFromFolder(place: Extract<Place, { kind: 'folder' }>) {
  const file = await folders.read(place.root, place.entry);
  const [added] = await useLibrary.getState().importFiles([{ name: place.entry.name, size: place.entry.size || file.size, file, handle: place.entry.handle, link: place.entry.uri }]);
  return added;
}

/** The folders a file is in, for people: "Archive / 2024 / Arzt" (just the place where its folders can't be told). */
export function whereIs(place: Extract<Place, { kind: 'folder' }>): string {
  if (place.entry.where) return place.entry.where === '/' ? place.rootName : place.entry.where.split('/').join(' / ');
  let dir = place.dir ?? '';
  // Android folders: IDs such as "primary:Sync/Archive/2024" below the picked "primary:Sync/Archive".
  const tree = /\/tree\/([^/]+)/.exec(place.root);
  const top = tree ? decodeURIComponent(tree[1]) : '';
  if (top && dir.startsWith(`${top}/`)) dir = dir.slice(top.length + 1);
  else if (dir.startsWith('/')) {
    // A path on the device: what is below the place's own folder.
    const at = dir.lastIndexOf(`/${place.rootName}/`);
    dir = at >= 0 ? dir.slice(at + place.rootName.length + 2) : '';
  } else if (dir.includes(':')) dir = '';
  return [place.rootName, ...dir.split('/').filter(Boolean)].join(' / ');
}

/** Opens a document at a page, with the query highlighted: a library document directly, a folder file via the library. */
export async function openDoc(doc: IndexedDoc, page: number, query: string) {
  const params = { page: String(page), q: query.trim() };
  const { place } = doc;
  if (place.kind === 'library') return router.push({ pathname: '/read/[id]', params: { id: place.id, ...params } });
  const added = await importFromFolder(place);
  if (added) router.push({ pathname: '/read/[id]', params: { id: added.id, ...params } });
}

/** One document found: title, sender, date and place, and the words around the match with its page. */
export function HitRow({
  hit: h,
  query,
  first,
  size,
  selected,
  onSelect,
  onToggle,
  onError,
}: {
  hit: Hit;
  query: string;
  first: boolean;
  size?: boolean;
  /** Undefined: not selecting. */
  selected?: boolean;
  /** A long press (or a right click): starts selecting, or picks one more. */
  onSelect?: () => void;
  /** A tap while selecting. */
  onToggle?: () => void;
  onError: (message: string) => void;
}) {
  const p = usePalette();
  const where = h.doc.place.kind === 'folder' ? whereIs(h.doc.place) : t.placeDevice;
  const bytes = size && h.doc.size ? `${(h.doc.size / 1_048_576).toFixed(h.doc.size < 10_485_760 ? 1 : 0)} MB` : '';
  const meta = [h.doc.sender, docDate(h.doc), bytes, where].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID="archive-hit"
      accessibilityRole={selected === undefined ? 'button' : 'checkbox'}
      accessibilityState={selected === undefined ? undefined : { checked: selected }}
      onPress={() => (selected !== undefined && onToggle ? onToggle() : openDoc(h.doc, h.page, query).catch((e) => onError(e instanceof Error ? e.message : String(e))))}
      onLongPress={onSelect}
      delayLongPress={350}
      // Right-click selects on a computer, like a long press on a phone.
      {...(Platform.OS === 'web' && onSelect
        ? {
            onContextMenu: (ev: { preventDefault(): void }) => {
              ev.preventDefault();
              onSelect();
            },
          }
        : {})}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.row,
        { borderColor: p.hairline, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: hovered ? p.hairline : 'transparent' },
      ]}
    >
      {selected === undefined ? <Icon name="documents" size={20} color={p.muted} /> : <Check on={selected} style={{ marginLeft: -2 }} />}
      <View style={{ flex: 1, gap: 2 }}>
        <T numberOfLines={2} style={{ fontFamily: fonts.sansMedium, fontSize: 15 }}>
          {h.doc.title || h.doc.name.replace(/\.pdf$/i, '')}
        </T>
        {!!meta && (
          <T v="caption" color={p.muted} numberOfLines={1}>
            {meta}
          </T>
        )}
        {h.snippet && (
          <T v="caption" color={p.inkSoft} numberOfLines={2}>
            {h.snippet.before}
            <T v="caption" style={{ backgroundColor: p.mark, color: p.ink, fontFamily: fonts.sansSemi }}>
              {h.snippet.match}
            </T>
            {h.snippet.after}
          </T>
        )}
      </View>
      {h.snippet && (
        <T v="numeral" color={p.muted}>
          {t.pageShort(h.page + 1)}
        </T>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xxl, gap: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
