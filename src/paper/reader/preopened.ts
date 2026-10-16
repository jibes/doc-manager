import type { DocHandle } from '@/core/engine';

/**
 * Documents opened before their reader is there (a file from another app, opened from the bytes in hand while
 * the library records it): the reader takes the open document instead of reading and opening the file again.
 */
const opened = new Map<string, DocHandle>();

export const preopen = (id: string, handle: DocHandle) => {
  opened.get(id)?.close();
  opened.set(id, handle);
};

/** The document opened ahead for `id`, once (the reader owns it from then on). */
export function takePreopened(id: string): DocHandle | undefined {
  const handle = opened.get(id);
  opened.delete(id);
  return handle;
}
