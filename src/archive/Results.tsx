import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { T } from '@/components/primitives';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import type { Hit, IndexedDoc, Place } from './search';

/** A file of a folder in the library (opened in place where it can be). */
export async function importFromFolder(place: Extract<Place, { kind: 'folder' }>) {
  const file = await folders.read(place.root, place.entry);
  const [added] = await useLibrary.getState().importFiles([{ name: place.entry.name, size: place.entry.size || file.size, file, handle: place.entry.handle, link: place.entry.uri }]);
  return added;
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
export function HitRow({ hit: h, query, first, onError }: { hit: Hit; query: string; first: boolean; onError: (message: string) => void }) {
  const p = usePalette();
  const meta = [h.doc.sender, h.doc.date, h.doc.place.kind === 'folder' ? h.doc.place.rootName : t.placeDevice].filter(Boolean).join(' · ');
  return (
    <Pressable
      testID="archive-hit"
      accessibilityRole="button"
      onPress={() => openDoc(h.doc, h.page, query).catch((e) => onError(e instanceof Error ? e.message : String(e)))}
      style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.row,
        { borderColor: p.hairline, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: hovered ? p.hairline : 'transparent' },
      ]}
    >
      <Icon name="documents" size={20} color={p.muted} />
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
