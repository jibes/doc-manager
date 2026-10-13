import type { FileHandle } from './fsa';

/**
 * A place to browse: a folder the user picked, or (with all files access, Android app) internal storage
 * or every document on the device.
 */
export type FolderRoot = {
  id: string;
  name: string;
  kind: 'folder' | 'device' | 'all' | 'app';
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
  /**
   * Android app: Documents/Tessel, where documents that would otherwise be hidden copies inside the app (scans,
   * files opened from other apps) are kept as real files. Null where there is no such folder (browsers).
   */
  appFolder(): Promise<FolderRoot | null>;
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
  /** Writes a new file; a taken name gets " (2)" (or the system's own suffix). Returns the file as listed. */
  create(at: Place, name: string, data: Blob): Promise<FolderEntry>;
  /** Returns the item's new URI where it has one (Android app), for documents in the library. */
  rename(root: string, dir: string | undefined, e: FolderEntry, name: string): Promise<string | undefined>;
  delete(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<void>;
  /** Copies or moves items into a folder; returns old → new URIs (Android app). */
  transfer(from: Place, entries: FolderEntry[], to: Place, move: boolean): Promise<{ from: string; to: string }[]>;
  share(root: string, entries: FolderEntry[]): Promise<void>;
  /**
   * The folder at `path` below a place (hidden ones too, such as .tessel/trash), made where missing when
   * `create`: its ID as list() and create() take it (undefined: the place itself), or null when there is none.
   */
  dirAt(root: string, path: string[], create: boolean): Promise<string | undefined | null>;
  /** A small text file at `path` below a place (the archive's .tessel/ settings); null when there is none. */
  readText(root: string, path: string[]): Promise<string | null>;
  /** Writes it, making the folders on the way and replacing what was there. */
  writeText(root: string, path: string[], text: string): Promise<void>;
  /** Whether all files access is granted. */
  allFiles(): Promise<boolean>;
  /** Shows Android's screen for it; resolves with the outcome. */
  requestAllFiles(): Promise<boolean>;
};
