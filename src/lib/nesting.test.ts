import { describe, expect, it } from 'vitest';

import type { FolderRoot } from './folderTypes';
import type { DirHandle } from './fsa';
import { APP_ROOT_ID, handleNestings, shellNestings, storagePath } from './nesting';

const tree = (docId: string) => `content://com.android.externalstorage.documents/tree/${encodeURIComponent(docId)}`;
const folder = (id: string, name = id): FolderRoot => ({ id, name, kind: 'folder' });
const app: FolderRoot = { id: APP_ROOT_ID, name: 'Tessel', kind: 'app' };

describe('storagePath', () => {
  it('places picked folders, document IDs, device paths and the Tessel folder', () => {
    expect(storagePath(tree('primary:Documents/Archive'))).toBe('primary:Documents/Archive');
    expect(storagePath('primary:Documents/Archive/2024')).toBe('primary:Documents/Archive/2024');
    expect(storagePath('/storage/emulated/0/Documents/Tessel/Scans')).toBe('primary:Documents/Tessel/Scans');
    expect(storagePath('/storage/1A2B-3C4D/Books')).toBe('1A2B-3C4D:Books');
    expect(storagePath(APP_ROOT_ID)).toBe('primary:Documents/Tessel');
  });

  it("can't place other providers' folders", () => {
    expect(storagePath('content://com.google.android.apps.docs.storage/tree/abc')).toBeNull();
    expect(storagePath('dir-1234')).toBeNull();
  });
});

describe('shellNestings', () => {
  it('finds folders inside others, with the ID a listing of the outer one gives', () => {
    const docs = folder(tree('primary:Documents'), 'Documents');
    const archive = folder(tree('primary:Documents/Sync/Archive'), 'Archive');
    const other = folder(tree('primary:Download'), 'Download');
    const found = shellNestings([app, docs, archive, other]);
    expect(found).toEqual([
      { outer: docs.id, inner: APP_ROOT_ID, dir: 'primary:Documents/Tessel' },
      { outer: docs.id, inner: archive.id, dir: 'primary:Documents/Sync/Archive' },
    ]);
  });

  it('gives a file path for a folder inside the Tessel folder', () => {
    const scans = folder(tree('primary:Documents/Tessel/Scans'), 'Scans');
    expect(shellNestings([app, scans])).toEqual([{ outer: APP_ROOT_ID, inner: scans.id, dir: '/storage/emulated/0/Documents/Tessel/Scans' }]);
  });

  it('treats a whole volume as holding everything on it, and a name prefix as no nesting', () => {
    const card = folder(tree('1A2B-3C4D:'), 'SD card');
    const books = folder(tree('1A2B-3C4D:Books'), 'Books');
    const booksOld = folder(tree('1A2B-3C4D:Books old'), 'Books old');
    expect(shellNestings([card, books, booksOld]).map((n) => [n.outer, n.inner])).toEqual([
      [card.id, books.id],
      [card.id, booksOld.id],
    ]);
  });

  it('leaves out the special places and folders it can\'t place', () => {
    const all: FolderRoot = { id: 'all', name: 'All', kind: 'all' };
    const cloud = folder('content://com.google.android.apps.docs.storage/tree/abc');
    expect(shellNestings([all, app, cloud])).toEqual([]);
  });
});

describe('handleNestings', () => {
  // A picked folder's handle that knows where other folders are below it.
  const handle = (paths: Record<string, string[]>) => ({ resolve: async (other: { name: string }) => paths[other.name] ?? null, name: '' }) as unknown as DirHandle;
  it('asks each handle where the others are', async () => {
    const outer = { ...handle({ archive: ['Sync', 'Archive'] }), name: 'docs' } as unknown as DirHandle;
    const inner = { ...handle({}), name: 'archive' } as unknown as DirHandle;
    expect(await handleNestings([{ id: 'dir-a', handle: outer }, { id: 'dir-b', handle: inner }])).toEqual([{ outer: 'dir-a', inner: 'dir-b', dir: 'Sync/Archive' }]);
  });
});
