import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FolderEntry } from './folderTypes';

// The thumbnail cache in memory, counting how often every key is listed.
const db = new Map<string, unknown>();
const listed = vi.fn();
vi.mock('idb-keyval', () => ({
  createStore: () => null,
  get: async (k: string) => db.get(k),
  set: async (k: string, v: unknown) => void db.set(k, v),
  keys: async () => (listed(), [...db.keys()]),
  delMany: async (ks: string[]) => ks.forEach((k) => db.delete(k)),
}));
vi.mock('@/core/engine', () => ({
  engine: { renderCover: async () => ({ cover: new Blob(['png']), handle: { pageSizes: [{ width: 1, height: 2 }], close: () => {} } }) },
}));

const { thumb } = await import('./thumbs.web');

const entry = (id: string, size: number, modified = 1): FolderEntry => ({ id, name: id, kind: 'pdf', size, modified });
const read = async () => new Blob(['%PDF']);

describe('thumbs', () => {
  beforeEach(() => db.clear());

  it('drops a file’s older thumbnail, listing the cache only once', async () => {
    db.set('r/a.pdf|1|1', { none: true });
    db.set('r/b.pdf|1|1', { none: true });
    await thumb('r', entry('a.pdf', 2), read);
    await thumb('r', entry('c.pdf', 1), read);
    await thumb('r', entry('a.pdf', 3), read);
    expect([...db.keys()].sort()).toEqual(['r/a.pdf|3|1', 'r/b.pdf|1|1', 'r/c.pdf|1|1']);
    expect(listed).toHaveBeenCalledTimes(1);
  });
});
