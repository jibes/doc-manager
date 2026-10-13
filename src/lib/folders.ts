import type { FoldersApi } from './folderTypes';

export type { FolderEntry, FolderRoot, Place } from './folderTypes';

/** Native builds keep using the system picker; folder browsing lives in the web app (and the Android app). */
export const folders: FoldersApi = {
  supported: false,
  allFilesSupported: false,
  roots: async () => [],
  appFolder: async () => null,
  add: async () => null,
  forget: async () => {},
  canEdit: () => false,
  canShare: false,
  mkdir: async () => {},
  create: async () => {
    throw new Error('Unsupported');
  },
  rename: async () => undefined,
  delete: async () => {},
  transfer: async () => [],
  share: async () => {},
  unlock: async () => false,
  list: async () => [],
  read: async () => {
    throw new Error('Unsupported');
  },
  readText: async () => null,
  writeText: async () => {
    throw new Error('Unsupported');
  },
  allFiles: async () => false,
  requestAllFiles: async () => false,
};
