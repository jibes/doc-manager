import { create } from 'zustand';

import { folders } from '@/core/lib/folders';
import { usePrefs } from '@/paper/state/prefs';
import { mergeViews, parseViews, serializeViews, type SavedView } from './facets';
import { schedule } from './indexer';
import { loadKinds, moveKindsTo } from './kinds';
import { readSettingsMerged } from './settingsFile';

/** Where saved views are kept in the archive folder: synced with the documents, so every device has them. */
const PATH = ['.tessel', 'views.json'];

export const useViews = create<{ views: SavedView[] }>(() => ({ views: usePrefs.getState().views }));

/** The views as stored (sync conflicts merged in); throws when the file is there but can't be read (see readSettings). */
async function read(archive: string): Promise<SavedView[]> {
  const text = await readSettingsMerged(archive, PATH, parseViews, mergeViews, serializeViews);
  return text ? parseViews(text) : [];
}

/** The views as stored now (another device may have changed them); those shown stay when it can't be read now. */
export async function loadViews(): Promise<void> {
  const { archive, views } = usePrefs.getState();
  if (!archive) return useViews.setState({ views });
  const stored = await read(archive).catch(() => null);
  if (stored) useViews.setState({ views: stored });
}

/** Reads, changes and writes back at once, so a view another device added in the meantime is kept. */
async function change(edit: (views: SavedView[]) => SavedView[]): Promise<void> {
  const { archive, views, set } = usePrefs.getState();
  if (!archive) {
    const next = edit(views);
    set({ views: next });
    useViews.setState({ views: next });
    return;
  }
  // Read access first (it may need the user's OK again), while the tap still counts.
  await folders.unlock(archive).catch(() => false);
  const next = edit(await read(archive));
  await folders.writeText(archive, PATH, serializeViews(next));
  useViews.setState({ views: next });
}

const withView = (views: SavedView[], view: SavedView) => [...views.filter((v) => v.id !== view.id), view];

export const saveView = (view: SavedView) => change((views) => withView(views, view));
export const removeView = (id: string) => change((views) => views.filter((v) => v.id !== id));

/** Chooses the archive folder; views saved on this device so far move there. */
export async function setArchive(archive: string | null): Promise<void> {
  const { views, archive: before, set } = usePrefs.getState();
  // Scans go to its inbox unless they were already going somewhere chosen.
  set({ archive });
  if (archive && views.length) {
    try {
      await change((stored) => views.reduce(withView, stored));
    } catch (e) {
      // Not writable: everything stays as it was.
      set({ archive: before });
      throw e;
    }
    set({ views: [] });
  }
  if (archive) await moveKindsTo(archive).catch(() => {});
  await loadViews();
  await loadKinds();
  // Which documents are the archive's changes: indexed again.
  if (archive !== before) schedule(1000);
}
