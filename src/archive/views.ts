import { create } from 'zustand';

import { folders } from '@/lib/folders';
import { usePrefs } from '@/state/prefs';
import { parseViews, serializeViews, type SavedView } from './facets';

/** Where saved views are kept in the archive folder: synced with the documents, so every device has them. */
const PATH = ['.tessel', 'views.json'];

export const useViews = create<{ views: SavedView[] }>(() => ({ views: usePrefs.getState().views }));

async function read(archive: string): Promise<SavedView[]> {
  const text = await folders.readText(archive, PATH).catch(() => null);
  return text ? parseViews(text) : [];
}

/** The views as stored now (another device may have changed them). */
export async function loadViews(): Promise<void> {
  const { archive, views } = usePrefs.getState();
  useViews.setState({ views: archive ? await read(archive) : views });
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
  await loadViews();
}
