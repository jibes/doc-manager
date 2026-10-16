import type { FolderEntry } from './folderTypes';

/** Native builds have no folder browser (see folders.ts). */
export type Thumb = { uri: string; aspect: number } | null;
export const cachedThumb = async (_root: string, _e: FolderEntry): Promise<Thumb | undefined> => undefined;
export const thumb = async (_root: string, _e: FolderEntry, _read: () => Promise<Blob>): Promise<Thumb> => null;
export const cancelThumbs = () => {};
