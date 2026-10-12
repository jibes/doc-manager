import type { FoldersApi } from './folderTypes';

export type { FolderEntry, FolderRoot } from './folderTypes';

/** Native builds keep using the system picker; folder browsing lives in the web app (and the Android app). */
export const folders: FoldersApi = {
  supported: false,
  allFilesSupported: false,
  roots: async () => [],
  add: async () => null,
  remove: async () => {},
  unlock: async () => false,
  list: async () => [],
  read: async () => {
    throw new Error('Unsupported');
  },
  allFiles: async () => false,
  requestAllFiles: async () => false,
};
