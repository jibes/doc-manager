import type { DocSource } from '@/engine/types';

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
};

/** Persistence port. Web: IndexedDB. Native: app documents directory. */
export interface LibraryRepo {
  list(): Promise<DocRecord[]>;
  put(rec: DocRecord): Promise<void>;
  remove(id: string): Promise<void>;
  saveFile(id: string, data: Blob | string): Promise<void>;
  source(id: string): Promise<DocSource>;
  saveCover(id: string, cover: Blob | string): Promise<void>;
  /** Displayable URI (object URL on web, file URI on native) or null. */
  coverUri(id: string): Promise<string | null>;
}
