import type { FileHandle } from './fsa';

/**
 * A place to browse: a folder the user picked, or (with all files access, Android app) internal storage
 * or every document on the device.
 */
export type FolderRoot = {
  id: string;
  name: string;
  kind: 'folder' | 'device' | 'all';
  /** The browser needs the user's OK again before it can be read (Chromium, after a restart). */
  locked?: boolean;
};

export type FolderEntry = {
  /** Unique within its root: a document ID, a path, or a path relative to the picked folder. */
  id: string;
  name: string;
  kind: 'dir' | 'pdf' | 'epub';
  size: number;
  /** Milliseconds since the epoch; 0 if unknown. */
  modified: number;
  /** For "All documents": the folder the file is in. */
  where?: string;
  /** Android app: the file's URI (served by the app). */
  uri?: string;
  /** Chromium: the file's handle. */
  handle?: FileHandle;
};

export type FoldersApi = {
  /** Folders can be browsed on this platform. */
  supported: boolean;
  /** "All files access" exists here (Android app). */
  allFilesSupported: boolean;
  roots(showAll: boolean): Promise<FolderRoot[]>;
  /** Asks the user for a folder; null when cancelled. */
  add(): Promise<FolderRoot | null>;
  remove(id: string): Promise<void>;
  /** Asks for access to a locked folder again (needs a user gesture). */
  unlock(id: string): Promise<boolean>;
  list(root: string, dir?: string): Promise<FolderEntry[]>;
  /** The file's bytes. */
  read(root: string, e: FolderEntry): Promise<Blob>;
  /** Whether all files access is granted. */
  allFiles(): Promise<boolean>;
  /** Shows Android's screen for it; resolves with the outcome. */
  requestAllFiles(): Promise<boolean>;
};
