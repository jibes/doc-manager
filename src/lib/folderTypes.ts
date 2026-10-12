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

/** A folder: a root, and a folder inside it (undefined for the root itself). */
export type Place = { root: string; dir?: string };

export type FoldersApi = {
  /** Folders can be browsed on this platform. */
  supported: boolean;
  /** "All files access" exists here (Android app). */
  allFilesSupported: boolean;
  roots(showAll: boolean): Promise<FolderRoot[]>;
  /** Asks the user for a folder; null when cancelled. */
  add(): Promise<FolderRoot | null>;
  /** Stops browsing a folder (the folder itself stays). */
  forget(id: string): Promise<void>;
  /** Asks for access to a locked folder again (needs a user gesture). */
  unlock(id: string): Promise<boolean>;
  list(root: string, dir?: string): Promise<FolderEntry[]>;
  /** The file's bytes. */
  read(root: string, e: FolderEntry): Promise<Blob>;
  /** File operations: available for picked folders and internal storage, not in "All documents" (no folder to work in). */
  canEdit(root: string): boolean;
  /** Can send documents to other apps. */
  canShare: boolean;
  mkdir(root: string, dir: string | undefined, name: string): Promise<void>;
  /** Returns the item's new URI where it has one (Android app), for documents in the library. */
  rename(root: string, dir: string | undefined, e: FolderEntry, name: string): Promise<string | undefined>;
  delete(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<void>;
  /** Copies or moves items into a folder; returns old → new URIs (Android app). */
  transfer(from: Place, entries: FolderEntry[], to: Place, move: boolean): Promise<{ from: string; to: string }[]>;
  share(root: string, entries: FolderEntry[]): Promise<void>;
  /** Whether all files access is granted. */
  allFiles(): Promise<boolean>;
  /** Shows Android's screen for it; resolves with the outcome. */
  requestAllFiles(): Promise<boolean>;
};
