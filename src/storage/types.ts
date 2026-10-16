import type { DocSource, TextLine } from '@/engine/types';
import type { FileHandle } from '@/lib/fsa';

export type ReadingPosition = {
  /** 0-based page index. */
  page: number;
  /** Scroll offset within the page, 0..1 of its height. */
  offset: number;
};

export type DocRecord = {
  id: string;
  title: string;
  author?: string;
  fileName: string;
  bytes: number;
  pageCount: number;
  /** Aspect ratio (h / w) of page 1, for cover layout before the image loads. */
  coverAspect: number;
  addedAt: number;
  openedAt?: number;
  position?: ReadingPosition;
  bookmarks: number[];
  /** Present when the document is on the reading list; it then opens with reading behaviour. */
  reading?: { since: number; finishedAt?: number };
  /** Last view used for this document: original pages or reflowed text. */
  view?: 'page' | 'text';
  /** Pages shown with inverted colours (dark slides, night reading). */
  invert?: boolean;
  /** Opened in place: the library points at the user's file instead of keeping a copy (Chromium, Android app folders). */
  linked?: boolean;
  /** Absent for PDFs. Books have virtual pages (`pageCount`), about a printed page each. */
  format?: 'epub';
  /** The same document on every device (archive/shared.ts docKey), for sharing reading between them. */
  shareKey?: string;
  /**
   * Opened from elsewhere to look at, not kept: the record lives in memory only (its place in the viewed history
   * is remembered), its file is held by the repo for as long as it is open. Saving anything keeps it first.
   */
  viewed?: true;
};

/** A document in one of the user's folders, reached through the Android app (content:// or file:// URI). */
export type ShellLink = { kind: 'shell'; uri: string };
export const isShellLink = (v: unknown): v is ShellLink => typeof v === 'object' && v !== null && (v as ShellLink).kind === 'shell';

/** Thrown by source() for linked files: the browser needs the user's OK again, or the file is gone. */
export const FILE_ACCESS = 'file-access-needed';
export const FILE_MOVED = 'file-moved';

/** Persistence port. Web: IndexedDB. Native: app documents directory. */
export interface LibraryRepo {
  list(): Promise<DocRecord[]>;
  put(rec: DocRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** A copy (Blob, native file URI) or, on web, a handle or shell link to the file in place. */
  saveFile(id: string, data: Blob | string | FileHandle | ShellLink): Promise<void>;
  source(id: string): Promise<DocSource>;
  /** Asks to read (or write) a linked file again; true for copies. Needs a user gesture to prompt. */
  requestAccess(id: string, write?: boolean): Promise<boolean>;
  /** Replaces the document's bytes: the original for linked files, the copy otherwise. */
  writeFile(id: string, bytes: ArrayBuffer): Promise<void>;
  saveCover(id: string, cover: Blob | string): Promise<void>;
  /** Library documents linked to these files, or to files inside these folders (Android app), by their own URI. */
  linkedTo(uris: string[]): Promise<Map<string, string[]>>;
  /** Library documents linked to this file (browsers, by its handle). */
  linkedToHandle(handle: FileHandle): Promise<string[]>;
  /** Points documents linked to a file at its new place (renamed or moved in the file browser). */
  relink(id: string, uri: string): Promise<void>;
  /** Android app: the URI of the file a document is linked to (to hand it to other apps); undefined for a copy. */
  linkOf(id: string): Promise<string | undefined>;
  /** Chromium: the handle of the file a document is linked to; undefined for a copy. */
  handleOf(id: string): Promise<FileHandle | undefined>;
  /** Displayable URI (object URL on web, file URI on native) or null. */
  coverUri(id: string): Promise<string | null>;
  /** Text recognized on-device for scanned PDFs, per page; undefined = not recognized yet. */
  loadOcr(id: string, pageCount: number): Promise<(TextLine[] | undefined)[]>;
  saveOcr(id: string, page: number, lines: TextLine[]): Promise<void>;
  /** A viewed document's file, held in memory while it is open: read like any other, never written. */
  hold(id: string, data: Blob | FileHandle): void;
  /** What `hold` keeps (to keep the document: it is saved then). */
  held(id: string): Blob | FileHandle | undefined;
  /** The viewed document is closed (or kept): its file and recognised text leave memory. */
  release(id: string): void;
}

/** Writing to a document that is only viewed: it must be kept first. */
export const NOT_KEPT = 'not-kept';
