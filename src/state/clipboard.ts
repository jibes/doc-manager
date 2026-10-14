import { create } from 'zustand';

import type { FolderEntry, Place } from '@/lib/folderTypes';

/**
 * Items picked for "Copy" or "Move", waiting for the user to open the folder they go to: from one folder (the
 * file browser) or several (documents picked in Documents), each with its own.
 */
export type Clip = { move: boolean; items: { from: Place; entries: FolderEntry[] }[] };

export const clipCount = (clip: Clip) => clip.items.reduce((n, i) => n + i.entries.length, 0);

/** Also counts changes made in the file browser, so every open folder lists itself again. */
export const useClipboard = create<{ clip: Clip | null; version: number; set(clip: Clip | null): void; changed(): void }>((set) => ({
  clip: null,
  version: 0,
  set: (clip) => set({ clip }),
  changed: () => set((s) => ({ version: s.version + 1 })),
}));
