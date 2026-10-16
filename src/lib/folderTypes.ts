import type { FileHandle } from './fsa';
import type { Nesting } from './nesting';

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
  kind: 'dir' | 'pdf';
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

/** Some of several items were done before one failed (its message): `done` says which, to follow or forget them. */
export class PartlyDone<T> extends Error {
  constructor(
    message: string,
    readonly done: T,
  ) {
    super(message);
  }
}

export type FoldersApi = {
  /** Folders can be browsed on this platform. */
  supported: boolean;
  /** Folders can be added (picked); without, there is only the Tessel folder (browsers other than desktop Chromium). */
  canAdd: boolean;
  /** "All files access" exists here (Android app). */
  allFilesSupported: boolean;
  roots(showAll: boolean): Promise<FolderRoot[]>;
  /** Asks the user for a folder; null when cancelled. */
  add(): Promise<FolderRoot | null>;
  /** Stops browsing a folder (the folder itself stays). */
  forget(id: string): Promise<void>;
  /** Which of these folders lie inside others (so their files are listed once). */
  nestings(roots: FolderRoot[]): Promise<Nesting[]>;
  /**
   * Android app: Documents/Tessel, where documents that would otherwise be hidden copies inside the app (scans,
   * files opened from other apps) are kept as real files. Null where there is no such folder (browsers).
   */
  appFolder(): Promise<FolderRoot | null>;
  /** Asks for access to a locked folder again (needs a user gesture). */
  /** Asks for access to the folder again (`write`: to change it too); needs a user gesture to prompt. */
  unlock(id: string, write?: boolean): Promise<boolean>;
  list(root: string, dir?: string): Promise<FolderEntry[]>;
  /** The file's bytes. */
  read(root: string, e: FolderEntry): Promise<Blob>;
  /**
   * File operations on what is in `root`: picked folders and internal storage. "All documents" is no folder to
   * make folders or paste in; its files (`entry`) can be renamed, moved and deleted where the app has their path.
   */
  canEdit(root: string, entry?: FolderEntry): boolean;
  /** Can send documents to other apps. */
  canShare: boolean;
  mkdir(root: string, dir: string | undefined, name: string): Promise<void>;
  /** Writes a new file; a taken name gets " (2)" (or the system's own suffix). Returns the file as listed. */
  create(at: Place, name: string, data: Blob): Promise<FolderEntry>;
  /** Returns the item's new URI where it has one (Android app), for documents in the library. */
  rename(root: string, dir: string | undefined, e: FolderEntry, name: string): Promise<string | undefined>;
  /** Throws PartlyDone (with the URIs that went, Android app) when some could not be deleted. */
  delete(root: string, dir: string | undefined, entries: FolderEntry[]): Promise<void>;
  /** Copies or moves items into a folder; returns old → new URIs (Android app). Throws PartlyDone with those when one fails. */
  transfer(from: Place, entries: FolderEntry[], to: Place, move: boolean): Promise<{ from: string; to: string }[]>;
  share(root: string, entries: FolderEntry[]): Promise<void>;
  /**
   * The folder at `path` below a place (hidden ones too, such as .tessel/trash), made where missing when
   * `create`: its ID as list() and create() take it (undefined: the place itself), or null when there is none.
   */
  dirAt(root: string, path: string[], create: boolean): Promise<string | undefined | null>;
  /** The names of the files in the folder at `path` below a place (any kind, hidden ones too); [] when there is none. */
  listNames(root: string, path: string[]): Promise<string[]>;
  /** A small text file at `path` below a place (the archive's .tessel/ settings); null when there is none. */
  readText(root: string, path: string[]): Promise<string | null>;
  /** Writes it, making the folders on the way and replacing what was there. */
  writeText(root: string, path: string[], text: string): Promise<void>;
  /** Whether all files access is granted. */
  allFiles(): Promise<boolean>;
  /** Shows Android's screen for it; resolves with the outcome. */
  requestAllFiles(): Promise<boolean>;
};
