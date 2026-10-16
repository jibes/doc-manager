import { t } from '@/core/i18n';
import { folders, type FolderRoot } from '@/core/lib/folders';
import { usePrefs } from '@/paper/state/prefs';

/** A source just added inside another one, or holding one: where its files count (each file counts once). */
export async function nestingNote(r: FolderRoot): Promise<string | null> {
  const roots = await folders.roots(false).catch(() => []);
  const nestings = await folders.nestings(roots).catch(() => []);
  const { archive } = usePrefs.getState();
  const name = (id: string) => roots.find((x) => x.id === id)?.name ?? '';
  const notes = nestings.flatMap(({ outer, inner }) => {
    if (inner === r.id) return [outer === archive ? t.nestedInArchive(r.name) : t.nestedIn(r.name, name(outer))];
    return outer === r.id ? [t.nestedHolds(r.name, name(inner))] : [];
  });
  return notes.join(' ') || null;
}
