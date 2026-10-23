import type { DocHandle } from '@/core/engine/types';
import { fingerprint } from '@/core/lib/bytes';
import { repo } from '@/core/storage';

/**
 * Whether the document's file changed since `handle` was opened from it (or last written from it): another
 * device's version synced in, another app or a job here wrote it. Unknown (a file that can't be read) counts as not.
 */
export async function changedElsewhere(id: string, handle: DocHandle): Promise<boolean> {
  if (!handle.origin) return false;
  const src = await repo.source(id).catch(() => null);
  return src?.kind === 'bytes' && fingerprint(src.bytes) !== handle.origin;
}

/** Writes `bytes` as the document's file; `handle` (it came from) knows them as its file from now on. */
export async function writeFrom(id: string, handle: DocHandle, bytes: ArrayBuffer): Promise<void> {
  const mark = fingerprint(bytes);
  await repo.writeFile(id, bytes);
  handle.origin = mark;
}
