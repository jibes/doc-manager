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
  /** Opened in place: the library points at the user's file instead of keeping a copy (web, Chromium). */
  linked?: boolean;
  /** Absent for PDFs. Books have virtual pages (`pageCount`), about a printed page each. */
  format?: 'epub';
};

/** Thrown by source() for linked files: the browser needs the user's OK again, or the file is gone. */
export const FILE_ACCESS = 'file-access-needed';
export const FILE_MOVED = 'file-moved';

/** Persistence port. Web: IndexedDB. Native: app documents directory. */
export interface LibraryRepo {
  list(): Promise<DocRecord[]>;
  put(rec: DocRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** A copy (Blob, native file URI) or, on web, a handle to the file in place. */
  saveFile(id: string, data: Blob | string | FileHandle): Promise<void>;
  source(id: string): Promise<DocSource>;
  /** Asks to read (or write) a linked file again; true for copies. Needs a user gesture to prompt. */
  requestAccess(id: string, write?: boolean): Promise<boolean>;
  /** Replaces the document's bytes: the original for linked files, the copy otherwise. */
  writeFile(id: string, bytes: ArrayBuffer): Promise<void>;
  saveCover(id: string, cover: Blob | string): Promise<void>;
  /** Displayable URI (object URL on web, file URI on native) or null. */
  coverUri(id: string): Promise<string | null>;
  /** Text recognized on-device for scanned PDFs, per page; undefined = not recognized yet. */
  loadOcr(id: string, pageCount: number): Promise<(TextLine[] | undefined)[]>;
  saveOcr(id: string, page: number, lines: TextLine[]): Promise<void>;
}
