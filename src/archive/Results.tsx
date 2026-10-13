import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { T } from '@/components/primitives';
import { fonts, radius, space } from '@/design/tokens';
import { t } from '@/i18n';
import { folders } from '@/lib/folders';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { searchAll, useIndex } from './indexer';
import type { Hit } from './search';

/** Opens a hit at its page, with the query highlighted: a library document directly, a folder file via the library. */
async function openHit(hit: Hit, query: string) {
  const params = { page: String(hit.page), q: query.trim() };
  const { place } = hit.doc;
  if (place.kind === 'library') return router.push({ pathname: '/read/[id]', params: { id: place.id, ...params } });
  const file = await folders.read(place.root, place.entry);
  const [doc] = await useLibrary.getState().importFiles([{ name: place.entry.name, size: place.entry.size || file.size, file, handle: place.entry.handle, link: place.entry.uri }]);
  if (doc) router.push({ pathname: '/read/[id]', params: { id: doc.id, ...params } });
}

/** "In all documents": matches in every indexed document's text and details. `skip`: library documents already listed. */
export function ArchiveResults({ query, skip }: { query: string; skip: Set<string> }) {
  const p = usePalette();
  const { running, done, total } = useIndex();
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      searchAll(query).then((h) => alive && setHits(h), () => alive && setHits([]));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // Searched again as indexing adds documents.
  }, [query, done]);

  if (query.trim().length < 2) return null;
  const shown = (hits ?? []).filter((h) => !(h.doc.place.kind === 'library' && skip.has(h.doc.place.id)));

  return (
    <View style={styles.section} testID="archive-results">
      <T v="kicker" color={p.muted}>
        {t.inAllDocuments(shown.length)}
      </T>
      {running && (
        <T v="caption" color={p.muted} testID="indexing">
          {t.indexing(done, total)}
        </T>
      )}
      {failed && (
        <T v="caption" color={p.markRing}>
          {failed}
        </T>
      )}
      {shown.length > 0 && (
        <View style={[styles.list, { backgroundColor: p.surface, borderColor: p.hairline }]}>
          {shown.map((h, i) => {
            const meta = [h.doc.sender, h.doc.date, h.doc.place.kind === 'folder' ? h.doc.place.rootName : t.library].filter(Boolean).join(' · ');
            return (
              <Pressable
                key={h.doc.key}
                testID="archive-hit"
                accessibilityRole="button"
                onPress={() => openHit(h, query).catch((e) => setFailed(e instanceof Error ? e.message : String(e)))}
                style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [styles.row, { borderColor: p.hairline, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, backgroundColor: hovered ? p.hairline : 'transparent' }]}
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
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: space.xxl, gap: space.sm },
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
