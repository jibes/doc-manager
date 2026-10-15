import { router } from 'expo-router';
import { DocItem, type Layout } from '@/components/DocItems';
import { T } from '@/components/primitives';
import { fonts } from '@/design/tokens';
import { errorText, t } from '@/i18n';
import { folders } from '@/lib/folders';
import { APP_ROOT_ID } from '@/lib/nesting';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { docDate } from './facets';
import { realTitle } from './pdfInfo';
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
  // The Tessel folder is this device's own storage, as library copies are.
  const name = place.root === APP_ROOT_ID ? t.placeDevice : place.rootName;
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
  return [name, ...dir.split('/').filter(Boolean)].join(' / ');
}

/** Opens a document at a page, with the query highlighted: a library document directly, a folder file via the library. */
export async function openDoc(doc: IndexedDoc, page: number, query: string) {
  const params = { page: String(page), q: query.trim() };
  const { place } = doc;
  if (place.kind === 'library') return router.push({ pathname: '/read/[id]', params: { id: place.id, ...params } });
  const added = await importFromFolder(place);
  if (added) router.push({ pathname: '/read/[id]', params: { id: added.id, ...params } });
}

/** One document found, as every list shows documents: its picture, title, details and place, the words around the match and its page. */
export function HitRow({
  hit: h,
  query,
  layout,
  width,
  first,
  last,
  size,
  selected,
  onSelect,
  onToggle,
  onError,
}: {
  hit: Hit;
  query: string;
  layout: Layout;
  width: number;
  first: boolean;
  last: boolean;
  size?: boolean;
  /** Undefined: not picking. */
  selected?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onError: (message: string) => void;
}) {
  const p = usePalette();
  const { place } = h.doc;
  const cover = useLibrary((s) => (place.kind === 'library' ? s.covers[place.id] : undefined));
  const aspect = useLibrary((s) => (place.kind === 'library' ? s.docs.find((d) => d.id === place.id)?.coverAspect : undefined));
  const where = place.kind === 'folder' ? whereIs(place) : t.placeDevice;
  const bytes = size && h.doc.size ? t.fileSize(h.doc.size) : '';
  return (
    <DocItem
      layout={layout}
      width={width}
      testID="archive-hit"
      picture={place.kind === 'folder' ? { kind: 'file', root: place.root, entry: place.entry } : { kind: 'cover', uri: cover, aspect: aspect ?? 1.414 }}
      title={realTitle(h.doc.title) || h.doc.name.replace(/\.(pdf|epub)$/i, '')}
      meta={[h.doc.sender, t.docDay(docDate(h.doc)), bytes, where].filter(Boolean).join(' · ')}
      extra={
        h.snippet && (
          <T v="caption" color={p.inkSoft} numberOfLines={2}>
            {h.snippet.before}
            <T v="caption" style={{ backgroundColor: p.mark, color: p.ink, fontFamily: fonts.sansSemi }}>
              {h.snippet.match}
            </T>
            {h.snippet.after}
          </T>
        )
      }
      badge={h.snippet ? t.pageShort(h.page + 1) : undefined}
      first={first}
      last={last}
      selected={selected}
      onOpen={() => void openDoc(h.doc, h.page, query).catch((e) => onError(errorText(e)))}
      onSelect={onSelect}
      onToggle={onToggle}
    />
  );
}
