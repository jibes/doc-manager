import { create } from 'zustand';

import type { FolderEntry, Place } from '@/lib/folderTypes';

/** Items picked for "Copy" or "Move", waiting for the user to open the folder they go to. */
export type Clip = { move: boolean; from: Place; entries: FolderEntry[] };

/** Also counts changes made in the file browser, so every open folder lists itself again. */
export const useClipboard = create<{ clip: Clip | null; version: number; set(clip: Clip | null): void; changed(): void }>((set) => ({
  clip: null,
  version: 0,
  set: (clip) => set({ clip }),
  changed: () => set((s) => ({ version: s.version + 1 })),
}));
